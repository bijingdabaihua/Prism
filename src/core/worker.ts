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
 * 画面监听直接委托 `engine.camera`，环境图委托 `engine.background`，几何委托
 * `engine.setInstances`；顶层只留引擎本身、串行队列和回执。
 */
// 纯类型导入：消息协议和门面同文件，编译后这条边会完全擦除。
import type { CameraCommand, WorkerRequest, WorkerResponse } from './prism';
import { WebGPUUnavailableError } from './engine/context';
import { Engine } from './engine/engine';
import { loadImage } from './ir/image';
import { SCENES } from '../app/scenes/manifest';

/**
 * Worker 的运行态：一个引擎 + 一条串行队列。
 *
 * 消息里凡是「引擎自己会」的（机位、监听、环境图、几何）都委托下去；
 * 顶层只负责把异步操作排好队、把结果回执出去。
 */
class WorkerHost {
    /** 渲染引擎：init 时建，Prism 生命周期内唯一一个。 */
    private engine: Engine | null = null;
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
                this.engine?.camera.startListening(Math.max(1, request.intervalMs), postFrame);
                return;
            case 'listen/stop':
                this.engine?.camera.stopListening();
                return;
            case 'background/setImage':
                this.enqueue(() => this.setImage(request.id, request.url, request.rotation));
                return;
            case 'background/setRotation':
                this.enqueue(() => this.setRotation(request.id, request.rotation));
                return;
            case 'model/load':
                this.enqueue(() => this.loadModel(request.id, request.key));
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
     * （`/env/xxx.exr`）或绝对 URL。`rotation` 是绕 +y 的弧度，省略则原图原样
     * 使用。
     *
     * 引擎已经在跑时也可以换：Background.version() 变化会让 PathTracePass 在
     * 下一帧重建 bind group 并清零累积。解码留在顶层（loadImage 是 ir 的
     * 入口），解码后的 Image 才交给引擎。
     */
    private async setImage(id: number, url: string, rotation?: number): Promise<void> {
        try {
            if (!this.engine) throw new Error('Prism 还没初始化');
            this.engine.background.setImage(await loadImage(url), rotation);
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
     * 装载场景几何：清单查表 → 造 Instance → 交给引擎编译。
     *
     * 机位和环境图不在这条消息里 —— 外部按自己的顺序调 `camera.set` /
     * `background.setImage`，引擎等三者都到位才出图。
     */
    private async loadModel(id: number, key: string): Promise<void> {
        try {
            if (!this.engine) throw new Error('Prism 还没初始化');
            const build = SCENES[key];
            if (!build) {
                throw new Error(`没有场景 "${key}"。可用：${Object.keys(SCENES).join(', ')}`);
            }
            this.engine.setInstances(await build());
            this.reply(id, undefined);
        } catch (err) {
            this.failure(id, err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * 机位命令：直接落到 Camera 的方法上。
     *
     * resize 改的是渲染目标的尺寸，不是机位参数 —— 相机持有渲染目标和帧循环，
     * 这里只把尺寸交给它。引擎还没建好时命令直接丢弃：句柄侧是同步不抛的，
     * 而 `Prism.create()` 等到 init 回执才把句柄交出去，resize 不会先到。
     */
    private applyCamera(command: CameraCommand): void {
        if (command.type === 'resize') {
            this.engine?.camera.setSize(command.size.width, command.size.height);
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
