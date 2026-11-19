import type { Scene } from '../ir/scene';
import { RenderContext } from './context';
import type { RenderSurface } from './context';
import { Background } from './background';
import { Model } from './model/model';
import { Camera } from './camera';
import { RenderLoop } from './loop';

/** 拿不到 WebGPU 设备 —— 调用方据此走降级页，而不是当成普通错误。 */
export class WebGPUUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WebGPUUnavailableError';
    }
}

/**
 * 申请 adapter + device。主线程和 Worker 走同一条 —— 设备的申请条件只写一遍。
 *
 * 浏览器没有 WebGPU、或者拿不到 adapter（驱动进黑名单、虚拟机、关了硬件加速），
 * 都抛 WebGPUUnavailableError；requestDevice 自身的失败原样上抛。
 */
export async function createDevice(): Promise<GPUDevice> {
    if (!navigator.gpu) {
        throw new WebGPUUnavailableError('WebGPU not supported. Try Chrome 113+.');
    }

    // 双显卡笔记本上 dGPU 休眠时 'high-performance' 档可能拿不到 adapter，
    // 超时或 null 都退回默认档再试一次。
    const adapter =
        (await raceTimeout(
            navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }),
            ADAPTER_TIMEOUT_MS,
        )) ?? (await raceTimeout(navigator.gpu.requestAdapter(), ADAPTER_TIMEOUT_MS));
    if (!adapter) {
        throw new WebGPUUnavailableError(
            'No WebGPU adapter. 打开 chrome://gpu 确认 WebGPU 为 Enabled，' +
                '并检查系统设置里「使用图形加速」是否开启。',
        );
    }

    // 时间戳用于测量每帧 GPU 采样耗时（采样预算控制器的输入）。
    // 拿不到就退回 onSubmittedWorkDone，不影响渲染。
    const requiredFeatures: GPUFeatureName[] = [];
    if (adapter.features.has('timestamp-query')) requiredFeatures.push('timestamp-query');

    return adapter.requestDevice({ requiredFeatures });
}

/**
 * 组装根：把 GPU 上下文、场景、相机、帧循环拼起来。
 *
 * 它不是「场景」—— 场景是 Scene IR。这里只负责持有生命周期。
 */
export class Engine {
    /**
     * 用已有的 device 装配引擎 —— Worker 在 init 时就把设备建好了，
     * 画布后到，不能再申请第二个。
     */
    public static fromDevice(device: GPUDevice, canvas: RenderSurface): Engine {
        return new Engine(device, canvas);
    }

    public readonly context: RenderContext;
    public readonly camera: Camera;
    public readonly background: Background;
    public readonly model: Model;
    public readonly loop: RenderLoop;
    /** release() 之后为 true：渲染资源已经卸掉，只剩设备。 */
    private released = false;

    private constructor(device: GPUDevice, canvas: RenderSurface) {
        this.context = new RenderContext(device, canvas);
        this.background = new Background(device);
        this.model = new Model(device);
        // 相机持有自己的渲染器：画面从相机出，帧循环也只认它这一个来源
        this.camera = new Camera(this.context, this.model, this.background);
        this.loop = new RenderLoop(this.camera);
    }

    /**
     * 装载场景 IR —— 引擎认识世界的唯一入口。GPU 侧不解析任何东西，
     * 只接收已经准备好的数据：几何、光源、机位都从 Scene 里来。
     */
    public setScene(scene: Scene): void {
        // 顺序是契约：先编译几何 / 材质，最后送环境图 —— 后者到位等于「场景就绪」，
        // PathTracePass 靠它决定能不能建 bind group。
        this.model.compile(scene.instances);
        this.background.setImage(scene.env);

        this.camera.applyView(scene.camera);
    }

    /**
     * 卸掉这一套渲染资源，但保留设备 —— Worker 换场景时用：引擎重建，
     * 设备是 Worker 的，不能跟着死。
     */
    public release(): void {
        if (this.released) return;
        this.released = true;
        this.loop.stop();
        this.model.destroy();
        this.background.destroy();
        // 相机连同它内部的 Frame 一起销毁
        this.camera.destroy();
    }
}

/** requestAdapter 在某些机器上会一直不 resolve，别让调用方无限等待。 */
const ADAPTER_TIMEOUT_MS = 8000;

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), ms);
        p.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            () => {
                clearTimeout(timer);
                resolve(null);
            },
        );
    });
}
