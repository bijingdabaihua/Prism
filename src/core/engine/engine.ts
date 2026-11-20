import type { Scene } from '../ir/scene';
import type { RenderSurface } from './context';
import { RenderContext, createDevice } from './context';
import { Background } from './background';
import { Model } from './model/model';
import { Camera } from './camera';
import { RenderLoop } from './loop';

/**
 * 组装根：把 GPU 上下文、场景、相机、帧循环拼起来。
 *
 * 它不是「场景」—— 场景是 Scene IR。这里只负责持有生命周期。
 */
export class Engine {
    /**
     * 装配引擎 —— 唯一的工厂入口：自己申请设备、建离屏画布。
     *
     * Worker 初始化（init 消息）和换场景都走这条 —— 每次装配都是全新的一套，
     * 不复用上一套的设备 / 画布（旧 engine release() 后由 GC 回收）。
     *
     * Engine 只活在 Worker 里，画布直接 new OffscreenCanvas；主线程不碰这个类。
     */
    public static async create(): Promise<Engine> {
        const device = await createDevice();
        return new Engine(device, new OffscreenCanvas(1, 1));
    }

    public readonly context: RenderContext;
    public readonly camera: Camera;
    public readonly background: Background;
    /** release() 之后为 true：渲染资源已经卸掉，只剩设备。 */
    private released = false;
    private readonly model: Model;
    private readonly loop: RenderLoop;

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
        this.background.setImage(scene.env, scene.envRotation);

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
