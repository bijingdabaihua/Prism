/**
 * 对外唯一入口 —— 接口草案，暂未接入任何实现。
 *
 * 实际渲染跑在 Worker 里，主线程拿到的只是 RPC 句柄；渲染器本身不需要
 * canvas，结果从 Worker 里出来。
 *
 * 业务层只认识这一个类，实例对外只暴露 camera / background / model
 * 三个只读句柄。
 *
 * 当前只定形状，create 只做了主线程那一眼检查，其余是占位。
 * 确认接口之后再接 engine / config。
 */
export class Prism {
    /**
     * 异步工厂：一次调用 = 一个 Worker = 一个独立 GPUDevice。
     *
     * 主线程先看一眼 navigator.gpu —— 没有就连 Worker 都不起，直接拒绝。
     * 这一眼只说明「浏览器有这个 API」，不保证真能跑：requestAdapter() 在
     * Worker 里仍可能返回 null（驱动进黑名单、虚拟机、关了硬件加速），
     * 那种情况同样以 PrismUnsupportedError 拒绝。
     */
    public static async create(): Promise<Prism> {
        if (!navigator.gpu) {
            throw new PrismUnsupportedError('WebGPU is not available. Try Chrome 113+.');
        }
        throw new Error('Prism.create is not implemented yet');
    }

    /** 观察者：机位控制。 */
    public declare readonly camera: CameraHandle;
    /** 环境光照：目前只暴露就绪状态。 */
    public declare readonly background: BackgroundHandle;
    /** 场景几何：已编译的模型。 */
    public declare readonly model: ModelHandle;

    /**
     * 释放这个实例的 Worker 和 GPU 设备。
     *
     * 实例独占一个 Worker 和一个 GPUDevice，dispose 之后所有句柄失效；
     * 重复调用无副作用。不 dispose 就等于一直占着一个 Worker 和一份显存。
     */
    public dispose(): void {
        throw new Error('Prism.dispose is not implemented yet');
    }

    private constructor() {}
}

/** 这台机器跑不了 WebGPU —— 调用方据此走降级页，而不是错误态。 */
export class PrismUnsupportedError extends Error {
    constructor(message = 'WebGPU is not available in this browser') {
        super(message);
        this.name = 'PrismUnsupportedError';
    }
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

export interface CameraHandle {
    /** 直接指定机位。 */
    set(spec: CameraSpec): void;
    /** 回到场景自带的机位。 */
    reset(): void;
    /** 绕 target 旋转。 */
    orbit(deltaTheta: number, deltaPhi: number): void;
    /** 推拉：>1 拉远，<1 推近。 */
    zoom(factor: number): void;
    /** 平移 target（屏幕空间像素）。 */
    pan(deltaX: number, deltaY: number): void;
    /** 按当前机位渲染一张图，返回最终结果。 */
    takePhoto(options?: PhotoOptions): Promise<Blob>;
}

export interface PhotoOptions {
    /** 输出格式，默认 image/png。 */
    type?: 'image/png' | 'image/jpeg' | 'image/webp';
    /** 有损格式的质量，0~1。 */
    quality?: number;
}

/** 业务层的场景标识，来自 config 里的 SCENES 清单。 */
export type SceneKey = string;

export interface BackgroundHandle {
    /** 设置环境图（URL）。重复调用即换背景。 */
    setImage(url: string): Promise<void>;
    /** 环境图是否已经装好 —— 也是「场景就绪」的信号。 */
    ready(): Promise<boolean>;
}

export interface ModelHandle {
    /** 装载场景（按 key）。重复调用即换场景。 */
    setScene(scene: SceneKey): Promise<void>;
    /** 几何是否已经编译好（BVH / buffer 上传完成）。 */
    ready(): Promise<boolean>;
    /** 场景里的实例数。 */
    instances(): Promise<number>;
    /** 三角形总数。 */
    triangles(): Promise<number>;
}
