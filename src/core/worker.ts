/**
 * 光追 Worker —— 一个 Prism 实例一个，独占一个 GPUDevice。
 *
 * 整个渲染管线（Engine / Camera / Model / Frame）都跑在这个线程里，画布是
 * Worker 自己建的 OffscreenCanvas，主线程从头到尾不碰 GPU。画面通过
 * `camera.listen()` 以 ImageBitmap 推回主线程 —— 每间隔最多一帧。
 *
 * 这里也是 core 唯一 import app/ 的地方：场景配方解释器
 * （`app/scenes/recipe`）从这里插进渲染器，其余 core 代码不认识任何具体场景。
 *
 * 运行态全部挂在 `WorkerHost` 一个实例上。消息语义沉到 Engine —— 机位命令和
 * 画面监听直接委托 `engine.camera`，环境图委托 `engine.background`，几何委托
 * `engine.addInstances`；顶层只留引擎本身、串行队列和回执。
 */
// 纯类型导入：消息协议和门面同文件，编译后这条边会完全擦除。
import type { CameraCommand, InstanceSpec, WorkerRequest, WorkerResponse } from './prism';
import { WebGPUUnavailableError } from './engine/context';
import { Engine } from './engine/engine';
import { loadImage } from './ir/image';
import { Instance, placeInstances } from './ir/instance';
import { buildScene } from '../app/scenes/recipe';

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
                this.enqueue(() => this.setImage(request.id, request.blob));
                return;
            case 'background/setRotation':
                this.enqueue(() => this.setRotation(request.id, request.rotation));
                return;
            case 'scene/load':
                this.enqueue(() => this.loadScene(request.id, request.source));
                return;
            case 'model/loadGltf':
                this.enqueue(() => this.loadGltf(request.id, request.source));
                return;
            case 'model/loadInstance':
                this.enqueue(() => this.loadInstance(request.id, request.instance));
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
     * 换环境图：Blob → 解码 → 上传。
     *
     * 主线程只负责提供字节；格式识别和解码都在 Worker 里。只换图，不动
     * 朝向；朝向由 setRotation 单独负责。
     *
     * 引擎已经在跑时也可以换：Background.version() 变化会让 PathTracePass 在
     * 下一帧重建 bind group 并清零累积。解码留在顶层（loadImage 是 ir 的
     * 入口），解码后的 Image 才交给引擎。
     */
    private async setImage(id: number, blob: Blob): Promise<void> {
        try {
            if (!this.engine) throw new Error('Prism 还没初始化');
            this.engine.background.setImage(await loadImage(blob));
            this.reply(id, undefined);
        } catch (err) {
            this.failure(id, err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * 旋转环境图：不重新解码，拿 Background 留着的原图按新角度重建纹理和 CDF。
     *
     * 需要先 setImage。角度是绕 +y 的弧度，和场景数据里的 `envRotation` 同一套
     * 定义。累积会自动清零 —— Background.version() 变了，下一帧重建 bind group。
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
     * 追加场景几何：配方 JSON → Instance → 交给引擎编译。
     *
     * 配方格式由 `app/scenes/recipe` 定义；core 只负责把字节解成 JSON。
     * 机位和环境图不在这条消息里 —— 外部按自己的顺序调 `camera.set` /
     * `background.setImage`，引擎等三者都到位才出图。
     */
    private async loadScene(id: number, source: Blob): Promise<void> {
        try {
            if (!this.engine) throw new Error('Prism 还没初始化');
            const text = await source.text();
            let recipe: unknown;
            try {
                recipe = JSON.parse(text);
            } catch {
                throw new Error('场景配方不是合法 JSON');
            }
            this.engine.addInstances(await buildScene(recipe));
            this.reply(id, undefined);
        } catch (err) {
            this.failure(id, err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * 加载一个 glTF 文件里的全部 Instance，追加到当前场景。
     *
     * 与场景配方入口一样，最终都落到 `engine.addInstances`。模型入口都是
     * 追加语义，外部可以一个一个调用，把多个来源拼进同一个场景。
     */
    private async loadGltf(id: number, source: Blob): Promise<void> {
        try {
            if (!this.engine) throw new Error('Prism 还没初始化');
            this.engine.addInstances(await Instance.buildByGltf(source));
            this.reply(id, undefined);
        } catch (err) {
            this.failure(id, err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * 从 glTF 里取一个 Instance，按指定摆放编译。
     *
     * 不摆放时保留文件里的节点变换；`index` 是 glTF 展开后的 Instance 顺序。
     */
    private async loadInstance(id: number, spec: InstanceSpec): Promise<void> {
        try {
            if (!this.engine) throw new Error('Prism 还没初始化');
            const instances = await Instance.buildByGltf(spec.source);
            const index = spec.index ?? 0;
            const instance = instances[index];
            if (!instance) {
                throw new Error(`glTF 里没有第 ${index} 个 Instance（共 ${instances.length} 个）`);
            }
            if (spec.placement) placeInstances([instance], spec.placement);
            this.engine.addInstances([instance]);
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
