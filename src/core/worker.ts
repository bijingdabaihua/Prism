/**
 * 光追 Worker —— 一个 Prism 实例一个，独占一个 GPUDevice。
 *
 * 整个渲染管线（Engine / Camera / Model / Frame）都跑在这个线程里，画布是
 * Worker 自己建的 OffscreenCanvas，主线程从头到尾不碰 GPU。画面通过
 * `camera.listen()` 以 ImageBitmap 推回主线程 —— 每间隔最多一帧。
 *
 * 这里也是 core 唯一 import app/ 的地方：场景清单（`app/scenes/manifest`）
 * 从这里插进渲染器，其余 core 代码不认识任何具体场景。
 *
 * 运行态全部挂在 `WorkerHost` 一个实例上。消息语义沉到 Engine —— 机位命令和
 * 画面监听直接委托 `engine.camera`，环境图委托 `engine.background`；顶层只留
 * 「跨引擎」的东西：引擎本身、换场景编排、串行队列、回执。
 */
import type { CameraCommand, WorkerRequest, WorkerResponse } from './protocol';
import { WebGPUUnavailableError } from './engine/context';
import { Engine } from './engine/engine';
import { loadImage } from './ir/image';
import { SCENES } from '../app/scenes/manifest';

/**
 * Worker 的运行态。
 *
 * 换场景只换 `engine` 这一个字段；画面监听是「跨引擎」状态，换引擎后重挂到
 * 新相机上。消息里凡是「引擎自己会」的（机位、监听、环境图）都委托下去，
 * 「跨引擎」的（监听开关、换场景、回执）留在这里。
 */
class WorkerHost {
    /** 渲染引擎：init 时建，model/setScene 时整个换掉。 */
    private engine: Engine | null = null;
    /** 是否在往主线程推画面。换引擎后要重新挂到新相机上。 */
    private listening = false;
    private listenInterval = 1;
    /** 异步任务的串行链。 */
    private taskChain: Promise<void> = Promise.resolve();

    /** 消息入口：写命令直接做，有返回值的进队列。 */
    public async handle(request: WorkerRequest): Promise<void> {
        switch (request.type) {
            case 'init':
                try {
                    this.engine ??= await Engine.create();
                    this.reply(request.id, undefined);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    if (err instanceof WebGPUUnavailableError) this.unsupported(request.id, message);
                    else this.failure(request.id, message);
                }
                return;
            case 'camera':
                this.applyCamera(request.command);
                return;
            case 'listen/start':
                this.listening = true;
                this.listenInterval = Math.max(1, request.intervalMs);
                this.engine?.camera.startListening(this.listenInterval, postFrame);
                return;
            case 'listen/stop':
                this.listening = false;
                this.engine?.camera.stopListening();
                return;
            case 'background/setImage':
                this.enqueue(() => this.setImage(request.id, request.url));
                return;
            case 'background/setRotation':
                this.enqueue(() => this.setRotation(request.id, request.rotation));
                return;
            case 'model/setScene':
                this.enqueue(() => this.setScene(request.id, request.key));
                return;
        }
    }

    /**
     * 异步任务的串行化。
     *
     * `loadImage` / `scene.load()` 都是异步的：连着调两次，先发的那次可能后回来，
     * 把后发的那张顶掉。排队之后「最后发起的那次」一定最后落地。
     */
    private enqueue(task: () => Promise<void>): void {
        this.taskChain = this.taskChain.then(task);
    }

    /**
     * 换环境图：URL → 解码 → 上传。
     *
     * URL 相对 **Worker 脚本**解析，不是相对页面 —— 所以调用方要给根路径
     * （`/env/xxx.exr`）或绝对 URL。这条路径不给旋转角度，原图原样使用；
     * 场景里的太阳对齐走 `Scene.envRotation`。
     *
     * 引擎已经在跑时也可以换：Background.version() 变化会让 PathTracePass 在
     * 下一帧重建 bind group 并清零累积。解码留在顶层（loadImage 是 ir 的
     * 入口），解码后的 Image 才交给引擎。
     */
    private async setImage(id: number, url: string): Promise<void> {
        try {
            if (!this.engine) throw new Error('Prism 还没初始化');
            this.engine.background.setImage(await loadImage(url));
            this.reply(id, undefined);
        } catch (err) {
            this.failure(id, err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * 转环境图：不重新解码，拿 Background 留着的原图按新角度重建纹理和 CDF。
     *
     * 和 setImage 同一套角度定义（绕 +y 的弧度）。累积会自动清零 ——
     * Background.version() 变了，下一帧重建 bind group。
     */
    private async setRotation(id: number, rotation: number): Promise<void> {
        try {
            if (!this.engine) throw new Error('Prism 还没初始化');
            this.engine.background.setRotation(rotation);
            this.reply(id, undefined);
        } catch (err) {
            this.failure(id, err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * 装场景：清单查表 → 造 Scene IR → 编译 → 换引擎。
     *
     * 换场景 = 重建引擎（`Engine.create()` 全新装配一套设备 + 画布）：
     * Model.compile 只能调用一次，PathTracePass 的 bind group 也绑死在那一份
     * buffer 上。release() 只卸渲染资源，旧的设备 / 画布由 GC 回收。
     *
     * 换场景失败时旧场景原样保留 —— 新引擎编译成功之前不动旧的。
     */
    private async setScene(id: number, key: string): Promise<void> {
        try {
            if (!this.engine) throw new Error('Prism 还没初始化');
            const load = SCENES[key];
            if (!load) {
                throw new Error(`没有场景 "${key}"。可用：${Object.keys(SCENES).join(', ')}`);
            }

            const scene = await load();
            const next = await Engine.create();
            try {
                next.setScene(scene);
            } catch (err) {
                next.release();
                throw err;
            }
            // 新上下文是 0×0：接上旧引擎当前的尺寸，否则新场景永远不渲染
            const width = this.engine.context.width();
            const height = this.engine.context.height();
            this.engine.release();
            this.engine = next;
            next.context.setSize(width, height);

            // 换引擎后监听要重新挂到新相机上（listening 是跨引擎状态）
            if (this.listening) next.camera.startListening(this.listenInterval, postFrame);
            this.reply(id, undefined);
        } catch (err) {
            this.failure(id, err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * 机位命令：直接落到 Camera 的方法上。
     *
     * resize 改的是渲染目标的尺寸，不是相机参数 —— 交给 context，相机和各个
     * pass 通过 resize 订阅跟着变。引擎还没建好时命令直接丢弃：句柄侧是同步
     * 不抛的，而 `Prism.create()` 等到 init 回执才把句柄交出去，resize 不会先到。
     */
    private applyCamera(command: CameraCommand): void {
        if (command.type === 'resize') {
            this.engine?.context.setSize(command.size.width, command.size.height);
            return;
        }
        const camera = this.engine?.camera;
        if (!camera) return;

        switch (command.type) {
            case 'set':
                camera.applyView(command.spec);
                return;
            case 'reset':
                camera.reset();
                return;
            case 'orbit':
                camera.orbitTheta(command.deltaTheta);
                camera.orbitPhi(command.deltaPhi);
                return;
            case 'zoom':
                camera.zoom(command.factor);
                return;
            case 'pan':
                camera.pan(command.deltaX, command.deltaY);
                return;
        }
    }

    private reply(id: number, value: unknown): void {
        scope.postMessage({ type: 'result', id, value });
    }

    private failure(id: number, message: string): void {
        scope.postMessage({ type: 'failure', id, message });
    }

    private unsupported(id: number, message: string): void {
        scope.postMessage({ type: 'unsupported', id, message });
    }
}

/**
 * Worker 全局作用域的最小声明。
 *
 * tsconfig 的 lib 只有 DOM，`self` 是 Window —— 那上面的 postMessage 要求
 * 传 targetOrigin。Worker 里没有这一套，所以按实际用法声明一份。
 */
const scope = self as unknown as {
    postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
    onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

/** 画面出口：相机的 listen 回调，把帧推回主线程。 */
function postFrame(bitmap: ImageBitmap): void {
    scope.postMessage({ type: 'frame', bitmap }, [bitmap]);
}

/** Worker 唯一的运行态；消息全部转给它。 */
const host = new WorkerHost();

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
    void host.handle(event.data);
};
