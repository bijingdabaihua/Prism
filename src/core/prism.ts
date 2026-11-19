import { RpcClient } from './rpc-client';
import { PrismUnsupportedError } from './errors';
import { RpcCamera } from './handles/camera';
import { RpcBackground } from './handles/background';
import { RpcModel } from './handles/model';
import type { CameraHandle } from './handles/camera';
import type { BackgroundHandle } from './handles/background';
import type { ModelHandle } from './handles/model';

/**
 * 门面：起 Worker、装配三个句柄、管生命周期。
 *
 * 实际渲染跑在 Worker 里 —— 一个实例一个 Worker、一个独立 GPUDevice，
 * 主线程从头到尾不碰 GPU。实例只对外暴露 camera / background / model
 * 三个只读句柄；各自的契约和主线程实现都在 handles/。
 *
 * 业务层只认识这一个类。画布和引擎还没搬进 Worker：机位命令现在只被收下，
 * takePhoto 会明确拒绝。
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
     * 传了画布：`transferControlToOffscreen()` 把它交给 Worker，之后所有
     * 绘制都在 Worker 里发生，主线程只量尺寸、发生指针事件。
     * 不传画布：只有设备和资源（场景能装、环境图能换），但不出图 ——
     * 适合预加载或后台实例。
     */
    public static async create(canvas?: HTMLCanvasElement): Promise<Prism> {
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
            if (canvas) {
                const surface = canvas.transferControlToOffscreen();
                await withTimeout(
                    rpc.request<void>(
                        (id) => ({ type: 'attachCanvas', id, canvas: surface }),
                        [surface],
                    ),
                    READY_TIMEOUT_MS,
                    `Prism.create: Worker 未在 ${READY_TIMEOUT_MS} ms 内接过画布`,
                );
            }
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

    private readonly rpc: RpcClient;
    private disposed = false;

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
