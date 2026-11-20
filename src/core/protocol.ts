/**
 * 主线程 ↔ Worker 的消息协议。
 *
 * 消息都是纯数据（结构化克隆），不带方法 —— 方法住在两端的类里。
 * 一个 Worker 只服务一个 Prism 实例，所以消息里不需要实例 id。
 *
 * 两类消息：
 *   - 写操作（机位命令）：发完不管，没有 id；
 *   - 有返回值的调用：带自增 id，Worker 用 result / failure 回执。
 *     「这台机器跑不了 WebGPU」单独一种回执，主线程据此转成 PrismUnsupportedError。
 *
 * 和门面之间的类型是纯类型依赖（`import type`），编译后擦除，没有运行时环。
 */
/** 业务层的场景标识，来自 app/scenes/manifest.ts 的 SCENES 清单。 */
export type SceneKey = string;

/** 渲染视口尺寸（物理像素 = CSS 尺寸 × devicePixelRatio）。 */
export interface ViewportSize {
    width: number;
    height: number;
}

/**
 * 观察模型：绕 target 的轨道相机。
 *
 * 这是本渲染器的机位语义，不是 ir/CameraView 的拷贝 —— 结构一样只是巧合，
 * 业务契约不跟着 IR 变。
 */
export interface CameraSpec {
    target: { x: number; y: number; z: number };
    /** 相机到 target 的距离（米，轨道半径）。 */
    distance: number;
    /** 水平角，π/2 表示从 +z 方向看过来。 */
    theta: number;
    /** 俯仰角，π/2 是水平视线，越小相机越高。 */
    phi: number;
    /** 垂直视野角，弧度。 */
    fovY: number;
    /** 入射光瞳半径（米）。省略或 0 = 针孔。 */
    apertureRadius?: number;
    /** 对焦距离（米）。需要和 apertureRadius 一起给才生效。 */
    focusDistance?: number;
}

/** 机位命令：全部是「照做」的写操作，没有返回值。 */
export type CameraCommand =
    | { type: 'set'; spec: CameraSpec }
    | { type: 'reset' }
    | { type: 'resize'; size: ViewportSize }
    | { type: 'orbit'; deltaTheta: number; deltaPhi: number }
    | { type: 'zoom'; factor: number }
    | { type: 'pan'; deltaX: number; deltaY: number };

/** 主线程 → Worker。 */
export type WorkerRequest =
    | { type: 'init'; id: number }
    | { type: 'camera'; command: CameraCommand }
    /** 开始按间隔把画面推回主线程。 */
    | { type: 'listen/start'; intervalMs: number }
    | { type: 'listen/stop' }
    | { type: 'background/setImage'; id: number; url: string }
    | { type: 'background/setRotation'; id: number; rotation: number }
    /** 装载场景：读清单 → 造 Scene IR → 编译几何 / 材质。 */
    | { type: 'model/setScene'; id: number; key: SceneKey };

/** Worker → 主线程。 */
export type WorkerResponse =
    /** 成功了：value 是这次调用的返回值（void 调用不带）。 */
    | { type: 'result'; id: number; value?: unknown }
    /** 这次调用失败了。 */
    | { type: 'failure'; id: number; message: string }
    /** 这台机器跑不了 WebGPU。 */
    | { type: 'unsupported'; id: number; message: string }
    /** 一帧画面（listen 的推送，没有 id）。 */
    | { type: 'frame'; bitmap: ImageBitmap };
