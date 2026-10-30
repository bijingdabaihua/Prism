/**
 * 相机 IR：场景作者指定的机位。
 *
 * 构图是场景的一部分 —— 同一个场景换一套参数就是另一张图，所以它跟着
 * Scene 走（`Scene.camera`），由场景构建器给出。引擎侧的 Camera 把这份
 * 描述变成轨道参数和 112 B uniform；之后鼠标怎么转，是观察者的事。
 */
export interface CameraView {
    target: { x: number; y: number; z: number };
    /** 相机到 target 的距离（米，轨道半径） */
    distance: number;
    /** 水平角，π/2 表示从 +z 方向看过来 */
    theta: number;
    /** 俯仰角，π/2 是水平视线，越小相机越高 */
    phi: number;
    /**
     * 垂直视野角，弧度。水平视野 = 2·atan(tan(fovY/2) · 宽高比)，
     * 所以它只管上下开口，左右跟着窗口走。
     */
    fovY: number;
    /**
     * 入射光瞳半径（米）。省略或 0 = 针孔相机，没有景深。
     *
     * 这是镜头的物理尺寸，不是「虚化强度」：薄透镜只有两个自由度，光圈多大、
     * 对焦在多远。f 值要自己按焦距换算（50 mm 镜头开 f/2.8，光瞳直径
     * 17.9 mm，半径 8.9 mm）。
     */
    apertureRadius?: number;
    /**
     * 对焦距离（米，沿视线从相机量起）。需要和 `apertureRadius` 一起给才生效。
     *
     * 对焦是镜头的状态，不跟着鼠标轨道转 —— 观察者绕着场景转时，合焦面停在
     * 场景作者定的那层深度上。
     */
    focusDistance?: number;
}

/**
 * 轨迹上的一个机位。字段取舍同 CameraView —— 视频里 fovY 和镜头不逐帧变，
 * 换焦段是另一台相机，不是一条轨迹。
 */
export interface CameraKeyframe {
    /** 归一化时间，0 = 起幅、1 = 落幅。数组按 t 递增。 */
    t: number;
    target: { x: number; y: number; z: number };
    distance: number;
    theta: number;
    phi: number;
}

/**
 * 相机轨迹：导出视频时逐帧取样的机位序列。
 *
 * 它是场景的一部分（`Scene.cameraPath`）：一段运镜和构图一样，是场景作者的东西，
 * 不是渲染器的东西。没有轨迹的场景就只导出静止画面。
 */
export interface CameraPath {
    keyframes: CameraKeyframe[];
    /** 建议时长（秒），导出面板拿它当默认值。 */
    duration: number;
}

/**
 * 在轨迹上取 t ∈ [0,1] 处的机位。
 *
 * 每个分量各走一条三次 Hermite 曲线（切线用相邻关键帧的差商），所以加速度连续，
 * 不会在关键帧上看出折角。首尾用单侧切线。
 *
 * theta 单独处理：它是个角度，相机从 -3.1 转到 +3.1 应该只走 0.08 弧度，
 * 而不是倒着转 6.2 弧度。取样前先把它「展平」成单调序列。
 */
export function sampleCameraPath(path: CameraPath, t: number): CameraKeyframe {
    const keys = path.keyframes;
    if (keys.length === 0) throw new Error('CameraPath 至少要有一个关键帧');
    if (keys.length === 1) return keys[0]!;

    const clamped = Math.min(1, Math.max(0, t));
    const theta = unwrapTheta(keys);

    let i = 0;
    while (i < keys.length - 2 && clamped > keys[i + 1]!.t) i++;
    const k0 = keys[i]!;
    const k1 = keys[i + 1]!;
    const span = Math.max(k1.t - k0.t, 1e-6);
    const u = Math.min(1, Math.max(0, (clamped - k0.t) / span));

    const h = (pick: (k: CameraKeyframe, thetaIdx: number) => number) => {
        const prev = keys[Math.max(0, i - 1)]!;
        const next = keys[Math.min(keys.length - 1, i + 2)]!;
        const p0 = pick(k0, i);
        const p1 = pick(k1, i + 1);
        // 切线：相邻帧差商 × 本段长度，首尾退化成弦
        const m0 = i === 0 ? p1 - p0 : ((p1 - pick(prev, i - 1)) / Math.max(k1.t - prev.t, 1e-6)) * span;
        const m1 =
            i + 2 >= keys.length
                ? p1 - p0
                : ((pick(next, i + 2) - p0) / Math.max(next.t - k0.t, 1e-6)) * span;
        const u2 = u * u;
        const u3 = u2 * u;
        return (
            (2 * u3 - 3 * u2 + 1) * p0 +
            (u3 - 2 * u2 + u) * m0 +
            (-2 * u3 + 3 * u2) * p1 +
            (u3 - u2) * m1
        );
    };

    return {
        t: clamped,
        target: {
            x: h((k) => k.target.x),
            y: h((k) => k.target.y),
            z: h((k) => k.target.z),
        },
        distance: h((k) => k.distance),
        theta: h((_k, ti) => theta[ti]!),
        phi: h((k) => k.phi),
    };
}

/** theta 的展平序列：相邻差值折到 (-π, π]，再累加。 */
function unwrapTheta(keys: CameraKeyframe[]): number[] {
    const out = [keys[0]!.theta];
    for (let i = 1; i < keys.length; i++) {
        const d = keys[i]!.theta - keys[i - 1]!.theta;
        out.push(out[i - 1]! + Math.atan2(Math.sin(d), Math.cos(d)));
    }
    return out;
}
