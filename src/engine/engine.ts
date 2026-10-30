import type { Scene } from '../ir/scene';
import { RenderContext } from './context';
import { Background } from './background';
import { Model } from './model/model';
import { Camera } from './camera';
import { Frame } from './frame/frame';
import { RenderLoop } from './loop';

/**
 * 组装根：把 GPU 上下文、场景、相机、帧循环拼起来。
 *
 * 它不是「场景」—— 场景是 Scene IR。这里只负责持有生命周期。
 */
export class Engine {
    public static async create(canvas: HTMLCanvasElement): Promise<Engine> {
        if (!navigator.gpu) throw new Error('WebGPU not supported. Try Chrome 113+.');

        // 双显卡笔记本上 dGPU 休眠时 'high-performance' 档可能拿不到 adapter，
        // 超时或 null 都退回默认档再试一次。
        const adapter =
            (await raceTimeout(
                navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }),
                ADAPTER_TIMEOUT_MS,
            )) ?? (await raceTimeout(navigator.gpu.requestAdapter(), ADAPTER_TIMEOUT_MS));
        if (!adapter) {
            throw new Error(
                'No WebGPU adapter. 打开 chrome://gpu 确认 WebGPU 为 Enabled，' +
                    '并检查系统设置里「使用图形加速」是否开启。',
            );
        }

        // 时间戳用于测量每帧 GPU 采样耗时（采样预算控制器的输入）。
        // 拿不到就退回 onSubmittedWorkDone，不影响渲染。
        const requiredFeatures: GPUFeatureName[] = [];
        if (adapter.features.has('timestamp-query')) requiredFeatures.push('timestamp-query');

        const device = await adapter.requestDevice({ requiredFeatures });
        return new Engine(device, canvas);
    }

    public readonly context: RenderContext;
    public readonly camera: Camera;
    public readonly background: Background;
    public readonly model: Model;
    public readonly frame: Frame;
    public readonly loop: RenderLoop;
    /** destroy() 之后为 true：设备已经还回去了，任何组件都不能再提交。 */
    public destroyed = false;

    private constructor(device: GPUDevice, canvas: HTMLCanvasElement) {
        this.context = new RenderContext(device, canvas);
        this.camera = new Camera(this.context);
        this.background = new Background(device);
        this.model = new Model(device);
        this.frame = new Frame(this.context, this.model, this.camera, this.background);
        this.loop = new RenderLoop(this.frame);
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

    public destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.loop.stop();
        this.model.destroy();
        this.background.destroy();
        this.frame.destroy();
        this.camera.destroy();
        this.context.device.destroy();
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
