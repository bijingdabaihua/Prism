import type { WorkerRequest, WorkerResponse } from './protocol';
import { PrismUnsupportedError } from './errors';

/**
 * 主线程这一侧的 RPC：发消息、接回执。
 *
 * 有返回值的调用带一个自增 id；写操作（机位命令）是「发完不管」。
 * 同一个 MessagePort 上的消息是 FIFO —— 所以 `camera.set()` 之后立刻
 * `takePhoto()`，Worker 一定先看到机位，再看到要图。
 *
 * 句柄（handles/）只认识这个类：各自把方法翻译成一条 WorkerRequest，
 * 不管 Worker 里怎么实现。
 */
export class RpcClient {
    private nextId = 1;
    private closed = false;
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
            }
        });
    }

    /** 初始化：Worker 里建好设备。 */
    public init(): Promise<void> {
        return this.request<void>((id) => ({ type: 'init', id }));
    }

    /**
     * 有返回值的一次调用；build 拿 id 组消息。
     *
     * transfer 里的东西随消息转移所有权（画布只能走这条）。
     */
    public request<T>(build: (id: number) => WorkerRequest, transfer?: Transferable[]): Promise<T> {
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
            try {
                this.send(build(id), transfer);
            } catch (err) {
                this.pending.delete(id);
                reject(err);
            }
        });
    }

    /** 发完不管：机位命令走这条，不等回执。 */
    public send(request: WorkerRequest, transfer?: Transferable[]): void {
        if (this.closed) throw new Error('Prism 已经 dispose');
        this.worker.postMessage(request, transfer ?? []);
    }

    /** Worker 走了：还挂着的请求全部拒绝，之后的调用直接抛。 */
    public dispose(): void {
        this.closed = true;
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

interface Pending {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
}
