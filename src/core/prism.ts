/**
 * 对外唯一入口 —— 接口草案，暂未接入任何实现。
 *
 * 业务层只认识这一个类：场景按 key 交给 core 内部构建，业务层不碰 IR、
 * 不碰 GPU。一个实例一个场景，换场景销毁重建。
 *
 * 当前只定形状，所有方法体都是占位。确认接口之后再接 engine / config。
 */
export class Prism {
    /** 异步工厂：GPU 初始化与场景装载都在这里完成。 */
    public static async create(options: PrismOptions): Promise<Prism> {
        throw new Error('Prism.create is not implemented yet');
    }

    /** 观察者：机位控制。 */
    public declare readonly camera: CameraHandle;
    /** 环境光照：目前只暴露就绪状态。 */
    public declare readonly background: BackgroundHandle;
    /** 场景几何：已编译的模型。 */
    public declare readonly model: ModelHandle;

    private constructor() {}

    /** 开始出帧。重复调用无副作用。 */
    public start(): void {
        throw new Error('Prism.start is not implemented yet');
    }

    /** 停止出帧，保留资源。 */
    public stop(): void {
        throw new Error('Prism.stop is not implemented yet');
    }

    /** 清空累积，从第 1 轮重新采样。 */
    public reset(): void {
        throw new Error('Prism.reset is not implemented yet');
    }

    /** 最近一帧的统计；未出过帧时返回零值。 */
    public stats(): RenderStats {
        throw new Error('Prism.stats is not implemented yet');
    }

    public onStats(cb: (stats: RenderStats) => void): () => void {
        throw new Error('Prism.onStats is not implemented yet');
    }

    public onError(cb: (err: Error) => void): () => void {
        throw new Error('Prism.onError is not implemented yet');
    }

    /** WebGPU 设备丢失（驱动重置、显存耗尽、页面被回收）。 */
    public onDeviceLost(cb: () => void): () => void {
        throw new Error('Prism.onDeviceLost is not implemented yet');
    }

    /** 把画布当前画面存成图片。 */
    public exportImage(options?: ImageExportOptions): Promise<Blob> {
        throw new Error('Prism.exportImage is not implemented yet');
    }

    /** 释放 device 与全部 GPU 资源。重复调用无副作用。 */
    public destroy(): void {
        throw new Error('Prism.destroy is not implemented yet');
    }
}

/** 业务层的场景标识，来自 config 里的 SCENES 清单。 */
export type SceneKey = string;

export interface PrismOptions {
    /** 渲染目标。目前只支持主线程的 canvas。 */
    canvas: HTMLCanvasElement;
    /** 场景 key。 */
    scene: SceneKey;
    /** 覆盖场景自带的机位；不传则用场景作者定的构图。 */
    camera?: CameraSpec;
    /** 运行期错误的回调。 */
    onError?: (err: Error) => void;
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
}

export interface BackgroundHandle {
    /** 环境图是否已经装好 —— 也是「场景就绪」的信号。 */
    ready(): boolean;
}

export interface ModelHandle {
    /** 几何是否已经编译好（BVH / buffer 上传完成）。 */
    ready(): boolean;
    /** 场景里的实例数。 */
    instances(): number;
    /** 三角形总数。 */
    triangles(): number;
}

export interface RenderStats {
    fps: number;
    /** 已完成的整轮采样数。 */
    spp: number;
    /** 本帧调度的像素数。 */
    pixels: number;
    /** 本帧 GPU 总耗时（毫秒）。 */
    gpuMs: number;
    /** 其中采样部分的耗时（毫秒）。 */
    samplingMs: number;
    width: number;
    height: number;
}

export interface ImageExportOptions {
    type?: 'image/png' | 'image/jpeg' | 'image/webp';
    /** 有损格式的质量，0~1。 */
    quality?: number;
}
