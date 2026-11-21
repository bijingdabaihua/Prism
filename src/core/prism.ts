/**
 * core 的公共面，也是主线程侧的全部实现。
 *
 * 门面、RPC、三个句柄和错误类型都收在这一个文件里 —— 主线程只从
 * `core/prism` 拿东西。Worker 两侧共用的消息类型仍放在 `protocol.ts`
 * （纯类型，主线程与 Worker 都只做 `import type`）。
 */
import type { CameraSpec, SceneKey, ViewportSize, WorkerRequest, WorkerResponse } from './protocol';

export type { CameraSpec, SceneKey, ViewportSize };

/**
 * 门面：起 Worker、装配三个句柄、管生命周期。
 *
 * 实际渲染跑在 Worker 里 —— 一个实例一个 Worker、一个独立 GPUDevice，
 * 主线程从头到尾不碰 GPU。实例只对外暴露 camera / background / model
 * 三个只读句柄；各自的契约和主线程实现都在本文件。
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

/**
 * 相机句柄 —— 所有方法都是同步的，调用即返回，不等帧。
 *
 * 宽高比是投影的一部分，所以尺寸挂在相机上（`resize`），而不是画布上：
 * 相机不知道自己画到哪块画布，只知道画面有多宽。
 *
 * 角度单位一律是弧度，位移单位一律是屏幕像素 —— 前者是相机语义，后者
 * 直接接指针事件，中间的手感系数（比如每像素转多少弧度）留在业务层。
 */
export interface CameraHandle {
    /**
     * 直接指定机位（完整一格，不是增量）。
     *
     * 外部装场景的顺序通常是 `set` → `background.setImage` → `model.load`；
     * 装载几何不会改机位。
     */
    set(spec: CameraSpec): void;
    /**
     * 回到场景自带的机位；还没装场景时回到内置的默认机位
     * （原点、5 m 远、水平视线、垂直视野 60°）。
     */
    reset(): void;
    /** 视口尺寸（物理像素）。宽高比跟着它走。 */
    resize(size: ViewportSize): void;
    /** 绕 target 旋转，单位弧度。phi 夹在 (0, π) 之间，翻不过头顶。 */
    orbit(deltaTheta: number, deltaPhi: number): void;
    /** 推拉：>1 拉远，<1 推近。乘性，拖多远都是等比例。 */
    zoom(factor: number): void;
    /** 平移 target，单位是屏幕像素 —— 直接接指针的位移。 */
    pan(deltaX: number, deltaY: number): void;
    /**
     * 按间隔把当前画面推回来 —— 画面是相机的输出，所以挂在相机上。
     *
     * 每 `intervalMs` 毫秒最多推一帧；渲染比它慢就等下一帧，不重复推同一张。
     * 推回来的是 `ImageBitmap`：主线程用 bitmaprenderer 的
     * `transferFromImageBitmap()` 直接贴上去，不经过读回和编码。
     *
     * 返回取消函数。同一时刻只允许一个监听者。
     */
    listen(intervalMs: number, onFrame: (frame: ImageBitmap) => void): () => void;
}

/**
 * 环境光句柄：契约 + 主线程侧实现。
 *
 * URL 交给 Worker 去解码、上传 —— 主线程不碰像素。
 */
export interface BackgroundHandle {
    /**
     * 设置环境图（URL）。重复调用即换背景；Promise 解决时纹理和 CDF 已经就位。
     *
     * `rotation` 是绕 +y 的弧度，用于对齐 HDR 里太阳的方位；省略 = 原图方向。
     */
    setImage(url: string, rotation?: number): Promise<void>;
    /**
     * 旋转当前环境图（绕 +y 的弧度）。需要先 setImage；转完纹理和 CDF 一起
     * 重建，Promise 解决时已经生效。
     */
    setRotation(rotation: number): Promise<void>;
}

/**
 * 模型句柄：契约 + 主线程侧实现。
 *
 * 场景清单、文件解码、位移、BVH 全在 Worker 里；这边只递一个 key。
 */
export interface ModelHandle {
    /**
     * 装载场景几何（按 key）。
     *
     * Promise 解决时几何 / 材质已经编译完（位移烘成真几何、BVH 建好、
     * buffer 上传完）。机位和环境图不在这条消息里 —— 外部按自己的顺序
     * 调 `camera.set()` / `background.setImage()`。
     *
     * 一个 Prism 只装一份几何；换场景就换 Prism。
     */
    load(key: SceneKey): Promise<void>;
}

/** 这台机器跑不了 WebGPU —— 调用方据此走降级页，而不是错误态。 */
export class PrismUnsupportedError extends Error {
    constructor(message = 'WebGPU is not available in this browser') {
        super(message);
        this.name = 'PrismUnsupportedError';
    }
}

/**
 * 主线程这一侧的 RPC：发消息、接回执。
 *
 * 有返回值的调用带一个自增 id；写操作（机位命令）是「发完不管」。
 * 同一个 MessagePort 上的消息是 FIFO —— 所以 `camera.set()` 之后立刻
 * `camera.listen()`，Worker 一定先看到机位，再开始推帧。
 *
 * 三个句柄只认识这个类：各自把方法翻译成一条 WorkerRequest，
 * 不管 Worker 里怎么实现。
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

/** 相机句柄的主线程实现：每条命令原样转给 Worker，不等回执。 */
class RpcCamera implements CameraHandle {
    private listener: ((frame: ImageBitmap) => void) | null = null;

    constructor(private readonly rpc: RpcClient) {}

    public set(spec: CameraSpec): void {
        this.rpc.send({ type: 'camera', command: { type: 'set', spec } });
    }

    public reset(): void {
        this.rpc.send({ type: 'camera', command: { type: 'reset' } });
    }

    public resize(size: ViewportSize): void {
        this.rpc.send({ type: 'camera', command: { type: 'resize', size } });
    }

    public orbit(deltaTheta: number, deltaPhi: number): void {
        this.rpc.send({ type: 'camera', command: { type: 'orbit', deltaTheta, deltaPhi } });
    }

    public zoom(factor: number): void {
        this.rpc.send({ type: 'camera', command: { type: 'zoom', factor } });
    }

    public pan(deltaX: number, deltaY: number): void {
        this.rpc.send({ type: 'camera', command: { type: 'pan', deltaX, deltaY } });
    }

    public listen(intervalMs: number, onFrame: (frame: ImageBitmap) => void): () => void {
        if (this.listener) throw new Error('camera.listen：已经有一个监听者');
        this.listener = onFrame;
        this.rpc.setFrameHandler(onFrame);
        this.rpc.send({ type: 'listen/start', intervalMs });
        return () => {
            if (this.listener !== onFrame) return;
            this.listener = null;
            this.rpc.setFrameHandler(null);
            try {
                this.rpc.send({ type: 'listen/stop' });
            } catch {
                // 已经 dispose：Worker 都没了，不用停
            }
        };
    }
}

/** 环境光句柄的主线程实现。 */
class RpcBackground implements BackgroundHandle {
    constructor(private readonly rpc: RpcClient) {}

    public setImage(url: string, rotation?: number): Promise<void> {
        return this.rpc.request<void>((id) => ({ type: 'background/setImage', id, url, rotation }));
    }

    public setRotation(rotation: number): Promise<void> {
        return this.rpc.request<void>((id) => ({ type: 'background/setRotation', id, rotation }));
    }
}

/** 模型句柄的主线程实现。 */
class RpcModel implements ModelHandle {
    constructor(private readonly rpc: RpcClient) {}

    public load(key: SceneKey): Promise<void> {
        return this.rpc.request<void>((id) => ({ type: 'model/load', id, key }));
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
