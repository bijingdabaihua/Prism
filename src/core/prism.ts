import { SCENES } from '../config/config';
import { Engine } from '../engine/engine';
import type { FrameStats } from '../engine/frame/frame';

/**
 * 对外唯一入口：业务层只认识这一个类。
 *
 * 它站在 config/ 和 engine/ 之上 —— 场景按 key 从 config 构建成 IR，IR 再交给
 * engine 编译。业务层既不需要碰 IR，也不需要碰 GPU。
 *
 * 一个实例只装一个场景：换场景请 destroy 之后重建。创建完成后不自动渲染，
 * 显式 start() 才开始出帧。
 */
export class Prism {
    public static async create(options: PrismOptions): Promise<Prism> {
        const entry = SCENES[options.scene];
        if (!entry) {
            throw new Error(
                `Unknown scene "${options.scene}". Available: ${Object.keys(SCENES).join(', ')}`,
            );
        }

        const engine = await Engine.create(options.canvas);
        try {
            // Engine 构造时 RenderLoop 会自动起跑；对外要求显式 start()。
            engine.loop.stop();

            const scene = await entry.scene.load();
            engine.setScene(scene);

            const prism = new Prism(engine, options.canvas, scene.camera);
            if (options.camera) engine.camera.applyView(options.camera);
            if (options.onError) prism.errorListeners.add(options.onError);
            prism.watchDeviceLoss();
            return prism;
        } catch (err) {
            engine.destroy();
            throw err;
        }
    }

    public readonly camera: CameraHandle;
    public readonly background: BackgroundHandle;
    private started = false;
    private destroyed = false;
    private lastStats: RenderStats | null = null;
    private readonly engine: Engine;
    private readonly canvas: HTMLCanvasElement;
    private readonly initialView: CameraSpec;
    private readonly statsListeners = new Set<(stats: RenderStats) => void>();
    private readonly errorListeners = new Set<(err: Error) => void>();
    private readonly deviceLostListeners = new Set<() => void>();

    private constructor(engine: Engine, canvas: HTMLCanvasElement, initialView: CameraSpec) {
        this.engine = engine;
        this.canvas = canvas;
        this.initialView = initialView;

        this.camera = {
            set: (spec: CameraSpec): void => {
                this.assertAlive();
                this.engine.camera.applyView(spec);
            },
            reset: (): void => {
                this.assertAlive();
                this.engine.camera.applyView(this.initialView);
            },
            orbit: (deltaTheta: number, deltaPhi: number): void => {
                this.assertAlive();
                this.engine.camera.orbitTheta(deltaTheta);
                this.engine.camera.orbitPhi(deltaPhi);
            },
            zoom: (factor: number): void => {
                this.assertAlive();
                this.engine.camera.zoom(factor);
            },
            pan: (deltaX: number, deltaY: number): void => {
                this.assertAlive();
                this.engine.camera.pan(deltaX, deltaY);
            },
        };

        this.background = {
            ready: (): boolean => this.engine.background.hasEnvironment(),
        };

        this.engine.loop.setOnFrame((stats) => this.handleFrame(stats));
    }

    /** 开始出帧。重复调用无副作用。 */
    public start(): void {
        this.assertAlive();
        if (this.started) return;
        this.started = true;
        this.engine.loop.boot();
    }

    /** 停止出帧，保留所有资源；start() 可以恢复。 */
    public stop(): void {
        if (this.destroyed) return;
        this.started = false;
        this.engine.loop.stop();
    }

    /** 清空累积，从第 1 轮重新采样。 */
    public reset(): void {
        this.assertAlive();
        this.engine.frame.requestReset();
    }

    /** 最近一帧的统计；还没出过帧时返回零值。 */
    public stats(): RenderStats {
        if (this.lastStats) return this.lastStats;
        return {
            fps: 0,
            spp: 0,
            pixels: 0,
            gpuMs: 0,
            samplingMs: 0,
            width: this.engine.context.width(),
            height: this.engine.context.height(),
        };
    }

    public onStats(cb: (stats: RenderStats) => void): () => void {
        this.statsListeners.add(cb);
        if (this.lastStats) cb(this.lastStats);
        return (): void => {
            this.statsListeners.delete(cb);
        };
    }

    public onError(cb: (err: Error) => void): () => void {
        this.errorListeners.add(cb);
        return (): void => {
            this.errorListeners.delete(cb);
        };
    }

    /** WebGPU 设备丢失（驱动重置、显存耗尽、页面被回收）。 */
    public onDeviceLost(cb: () => void): () => void {
        this.deviceLostListeners.add(cb);
        return (): void => {
            this.deviceLostListeners.delete(cb);
        };
    }

    /**
     * 把画布当前的画面存成图片。
     *
     * 走的是 canvas 快照 —— 对可见标签页够用，但和视频导出的离屏读回不是一条路：
     * 后台标签页或交换链未呈现时可能拿不到最新一帧。
     */
    public async exportImage(options: ImageExportOptions = {}): Promise<Blob> {
        this.assertAlive();
        const type = options.type ?? 'image/png';
        return new Promise<Blob>((resolve, reject) => {
            this.canvas.toBlob(
                (blob) => {
                    if (blob) resolve(blob);
                    else reject(new Error('canvas.toBlob returned null'));
                },
                type,
                options.quality,
            );
        });
    }

    /** 释放 device 与全部 GPU 资源。重复调用无副作用。 */
    public destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.engine.loop.setOnFrame(undefined);
        this.statsListeners.clear();
        this.errorListeners.clear();
        this.deviceLostListeners.clear();
        this.engine.destroy();
    }

    private handleFrame(frame: FrameStats): void {
        this.lastStats = {
            fps: frame.fps,
            spp: frame.samples,
            pixels: frame.pixels,
            gpuMs: frame.gpuMs,
            samplingMs: frame.samplingMs,
            width: this.engine.context.width(),
            height: this.engine.context.height(),
        };
        for (const cb of this.statsListeners) cb(this.lastStats);
    }

    private emitError(err: Error): void {
        for (const cb of this.errorListeners) cb(err);
    }

    private watchDeviceLoss(): void {
        void this.engine.context.device.lost.then((info) => {
            // destroy() 也会让这个 promise 以 'destroyed' 落地，那不是错误。
            if (this.destroyed) return;
            const message = info.message || info.reason || 'unknown';
            this.emitError(new Error(`WebGPU device lost: ${message}`));
            for (const cb of this.deviceLostListeners) cb();
        });
    }

    private assertAlive(): void {
        if (this.destroyed) throw new Error('Prism has been destroyed');
    }
}

/** 业务层的场景标识，来自 config 里的 SCENES 清单。 */
export type SceneKey = keyof typeof SCENES;

export interface PrismOptions {
    /** 渲染目标。目前只支持主线程的 canvas，worker 支持要等 RenderContext 改造。 */
    canvas: HTMLCanvasElement;
    /** 场景 key，见 config/config.ts 的 SCENES。 */
    scene: SceneKey;
    /** 覆盖场景自带的机位；不传则用场景作者定的构图。 */
    camera?: CameraSpec;
    /** 运行期错误的回调（设备丢失、导出失败等）。 */
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
