import type { CameraHandle } from './handles/camera';
import type { BackgroundHandle } from './handles/background';
import type { ModelHandle } from './handles/model';
import { RpcClient } from './rpc-client';
import { PrismUnsupportedError } from './errors';
import { RpcCamera } from './handles/camera';
import { RpcBackground } from './handles/background';
import { RpcModel } from './handles/model';

// core 的公共面：外部只从这一个文件拿东西。prism.ts 同时也是唯一入口 ——
// Prism 类、错误类型、三个句柄的契约都在这里露出来，内部文件怎么摆不关外面的事。
export { PrismUnsupportedError } from './errors';
export type { CameraHandle } from './handles/camera';
export type { BackgroundHandle } from './handles/background';
export type { ModelHandle } from './handles/model';
export type { CameraSpec, SceneKey, SceneStats, ViewportSize } from './protocol';

/**
 * 门面：起 Worker、装配三个句柄、管生命周期。
 *
 * 实际渲染跑在 Worker 里 —— 一个实例一个 Worker、一个独立 GPUDevice，
 * 主线程从头到尾不碰 GPU。实例只对外暴露 camera / background / model
 * 三个只读句柄；各自的契约和主线程实现都在 handles/。
 *
 * 业务层只认识这一个类。画面是相机的输出：`camera.listen(interval, cb)`
 * 每 interval 毫秒把一帧 ImageBitmap 推回主线程，worker 内部自己持有画布。
 */
export class Prism {
    /**
     * 异步工厂：一次调用 = 一个 Worker = 一个独立 GPUDevice。
     *
     * 主线程先看一眼 navigator.gpu —— 没有就连 Worker 都不起，直接拒绝。
     * 这一眼只说明「浏览器有这个 API」，不保证真能跑：requestAdapter() 在
     * Worker 里仍可能返回 null（驱动进黑名单、虚拟机、关了硬件加速），
     * 那种情况同样以 PrismUnsupportedError 拒绝 —— 消息由 Worker 报回来。
     *
     * 不接画布：Worker 内部自建 OffscreenCanvas，画面通过
     * `camera.listen()` 以 ImageBitmap 推回来 —— 主线程不碰 GPU。
     */
    public static async create(): Promise<Prism> {
        if (!navigator.gpu) {
            throw new PrismUnsupportedError('WebGPU is not available. Try Chrome 113+.');
        }

        const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
        const rpc = new RpcClient(worker);
        try {
            await withTimeout(
                rpc.init(),
                READY_TIMEOUT_MS,
                `Prism.create: Worker 未在 ${READY_TIMEOUT_MS} ms 内就绪`,
            );
        } catch (err) {
            // 半途失败的 Worker 不能留着：它可能已经占着设备了
            rpc.dispose();
            worker.terminate();
            throw err;
        }
        return new Prism(worker, rpc);
    }

    /** 观察者：机位控制。 */
    public readonly camera: CameraHandle;
    /** 环境光照。 */
    public readonly background: BackgroundHandle;
    /** 场景几何：已编译的模型。 */
    public readonly model: ModelHandle;
    private disposed = false;
    private readonly rpc: RpcClient;

    private constructor(
        private readonly worker: Worker,
        rpc: RpcClient,
    ) {
        this.rpc = rpc;
        this.camera = new RpcCamera(rpc);
        this.background = new RpcBackground(rpc);
        this.model = new RpcModel(rpc);
    }

    /**
     * 释放这个实例的 Worker 和 GPU 设备。
     *
     * 实例独占一个 Worker 和一个 GPUDevice，dispose 之后所有句柄失效；
     * 重复调用无副作用。不 dispose 就等于一直占着一个 Worker 和一份显存。
     */
    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.rpc.dispose();
        this.worker.terminate();
    }
}

/** Worker 建设备的上限。requestAdapter 自身有 8 s 超时，这里再兜一层。 */
const READY_TIMEOUT_MS = 15000;

/** 给一个 Promise 加超时；超时之后迟到的回执会被 RpcClient 忽略。 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}
