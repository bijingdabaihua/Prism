import type { Instance } from '../ir/instance';
import type { RenderSurface } from './context';
import { RenderContext, createDevice } from './context';
import { Background } from './background';
import { Model } from './model/model';
import { Camera } from './camera';
import { RenderLoop } from './loop';

/**
 * 组装根：把 GPU 上下文、模型、环境图、相机、帧循环拼起来。
 *
 * 它不拥有「场景」这个概念 —— 机位、环境图、几何分别从三个接口进来，
 * 这里只负责持有生命周期。
 */
export class Engine {
    /**
     * 装配引擎 —— 唯一的工厂入口：自己申请设备、建离屏画布。
     *
     * 一个 Prism 实例只有一套引擎；场景的机位、环境图、几何随后分别送进来。
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
     * 编译场景几何 —— 引擎认识世界的入口之一。GPU 侧不解析任何东西，
     * 只接收已经准备好的 Instance；材质、位移、BVH 都在 Model.compile 里。
     *
     * 机位和环境图各走 `camera.applyView` / `background.setImage`，三者的
     * 先后由外部决定 —— PathTracePass 等两边都到位才建 bind group。
     */
    public setInstances(instances: Instance[]): void {
        this.model.compile(instances);
    }

    /**
     * 卸掉这一套渲染资源，但保留设备 —— Prism.dispose 时用：引擎销毁，
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
