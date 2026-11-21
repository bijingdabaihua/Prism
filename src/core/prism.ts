/**
 * core 的公共面：门面 + 主线程 RPC + 消息协议 + 错误。
 *
 * 四个句柄的契约和主线程实现分别在 `camera.ts` / `background.ts` /
 * `model.ts` / `scene.ts`；本文件只负责装配它们。主线程只从 `core/prism`
 * 拿东西；Worker 只从同一文件做纯类型导入，编译后不留下运行时依赖。
 */

import type { BackgroundHandle, BackgroundRequest } from './background';
import type { CameraHandle, CameraRequest } from './camera';
import type { ModelHandle, ModelRequest } from './model';
import type { SceneHandle, SceneRequest } from './scene';
import { createBackground } from './background';
import { createCamera } from './camera';
import { createModel } from './model';
import { createScene } from './scene';

export type { BackgroundHandle } from './background';
export type { CameraHandle, CameraSpec, ViewportSize } from './camera';
export type { InstancePlacement, InstanceSpec, ModelHandle } from './model';
export type { SceneHandle } from './scene';

/**
 * 公开契约
 *
 * 以下类型、接口和门面签名是对外 API。修改前先确认调用方影响；
 * 具体实现从本文件的「实现」一节开始。
 */

/**
 * 门面契约（实例侧）。
 *
 * 创建入口是 `Prism.create()`；实例只暴露四个只读句柄和 `dispose()`。
 * 四个句柄的契约分别在 `camera.ts` / `background.ts` / `model.ts` / `scene.ts`。
 */
export interface Prism {
    /** 观察者：机位控制。 */
    readonly camera: CameraHandle;
    /** 环境光照。 */
    readonly background: BackgroundHandle;
    /** 模型资产：glTF 的字节入口。 */
    readonly model: ModelHandle;
    /** 场景配方：把多个资产和程序化几何装配成场景。 */
    readonly scene: SceneHandle;
    /** 释放 Worker 和 GPU 设备；重复调用无副作用。 */
    dispose(): void;
}

/** 门面工厂：`Prism.create()` 的签名。 */
export interface PrismFactory {
    create(): Promise<Prism>;
}

/** 这台机器跑不了 WebGPU —— 调用方据此走降级页，而不是错误态。 */
export class PrismUnsupportedError extends Error {
    constructor(message = 'WebGPU is not available in this browser') {
        super(message);
        this.name = 'PrismUnsupportedError';
    }
}

/**
 * 实现
 *
 * 以下内容不属于公开契约：内部消息协议、门面的具体实现和主线程 RPC。
 */

/** Worker 侧机位命令类型；由 camera.ts 的实现段定义。 */
export type { CameraCommand } from './camera';

/**
 * 主线程 → Worker。
 *
 * 两类消息：写操作（机位命令）没有 id；有返回值的调用带自增 id，
 * Worker 用 result / failure 回执。「跑不了 WebGPU」单独一种回执，
 * 主线程据此转成 PrismUnsupportedError。
 *
 * 四个句柄的消息形状由各自的文件定义，这里只做汇总。
 */
export type WorkerRequest =
    | { type: 'init'; id: number }
    | CameraRequest
    | BackgroundRequest
    | ModelRequest
    | SceneRequest;

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

/**
 * 门面：起 Worker、装配四个句柄、管生命周期。
 *
 * 四个句柄的契约和主线程实现分别在 camera.ts / background.ts / model.ts /
 * scene.ts；这里只负责创建和持有。实际渲染跑在 Worker 里 —— 一个实例一个
 * Worker、一个独立 GPUDevice，主线程从头到尾不碰 GPU。
 *
 * 业务层只认识这个门面。画面是相机的输出：`camera.listen(interval, cb)`
 * 每 interval 毫秒把一帧 ImageBitmap 推回主线程，worker 内部自己持有画布。
 */
class PrismImpl implements Prism {
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
        return new PrismImpl(worker, rpc);
    }

    /** 观察者：机位控制。 */
    public readonly camera: CameraHandle;
    /** 环境光照。 */
    public readonly background: BackgroundHandle;
    /** 模型资产：glTF 的字节入口。 */
    public readonly model: ModelHandle;
    /** 场景配方：把多个资产和程序化几何装配成场景。 */
    public readonly scene: SceneHandle;
    private disposed = false;
    private readonly rpc: RpcClient;

    private constructor(
        private readonly worker: Worker,
        rpc: RpcClient,
    ) {
        this.rpc = rpc;
        this.camera = createCamera(rpc);
        this.background = createBackground(rpc);
        this.model = createModel(rpc);
        this.scene = createScene(rpc);
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

/**
 * 导出的门面工厂：值就是 PrismImpl，外部只能通过 `Prism.create()` 创建。
 * 保留构造函数值是为了 `instanceof` 仍然可用；实现类本身不单独导出。
 */
export const Prism: PrismFactory & typeof PrismImpl = PrismImpl;

/**
 * 主线程这一侧的 RPC：发消息、接回执。
 *
 * 有返回值的调用带一个自增 id；写操作（机位命令）是「发完不管」。
 * 同一个 MessagePort 上的消息是 FIFO —— 所以 `camera.set()` 之后立刻
 * `camera.listen()`，Worker 一定先看到机位，再开始推帧。
 *
 * 三个句柄只通过各自的最小 RPC 接口使用它：该发消息的发消息、该发请求的
 * 发请求，谁都不认识 Worker 里的实现。具体类本身不导出。
 */
class RpcClient {
    private nextId = 1;
    private closed = false;
    /** listen 推回来的帧。同一时刻只服务一个监听者。 */
    private frameHandler: ((bitmap: ImageBitmap) => void) | null = null;
    private readonly pending = new Map<number, Pending>();

    constructor(private readonly worker: Worker) {
        worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
            const message = event.data;
            if (message.type === 'result') {
                this.settle(message.id, (pending) => pending.resolve(message.value));
            } else if (message.type === 'failure') {
                this.settle(message.id, (pending) => pending.reject(new Error(message.message)));
            } else if (message.type === 'unsupported') {
                this.settle(message.id, (pending) =>
                    pending.reject(new PrismUnsupportedError(message.message)),
                );
            } else if (message.type === 'frame') {
                this.frameHandler?.(message.bitmap);
            }
        });
    }

    /** 谁在听帧。null = 没有监听者（收到的帧直接丢掉）。 */
    public setFrameHandler(handler: ((bitmap: ImageBitmap) => void) | null): void {
        this.frameHandler = handler;
    }

    /** 初始化：Worker 里建好设备。 */
    public init(): Promise<void> {
        return this.request<void>((id) => ({ type: 'init', id }));
    }

    /** 有返回值的一次调用；build 拿 id 组消息。 */
    public request<T>(build: (id: number) => WorkerRequest): Promise<T> {
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
            try {
                this.send(build(id));
            } catch (err) {
                this.pending.delete(id);
                reject(err);
            }
        });
    }

    /** 发完不管：机位命令 / listen 开关走这条，不等回执。 */
    public send(request: WorkerRequest): void {
        if (this.closed) throw new Error('Prism 已经 dispose');
        this.worker.postMessage(request);
    }

    /** Worker 走了：还挂着的请求全部拒绝，之后的调用直接抛。 */
    public dispose(): void {
        this.closed = true;
        this.frameHandler = null;
        for (const pending of this.pending.values()) {
            pending.reject(new Error('Prism 已经 dispose'));
        }
        this.pending.clear();
    }

    private settle(id: number, act: (pending: Pending) => void): void {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        act(pending);
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

interface Pending {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
}
