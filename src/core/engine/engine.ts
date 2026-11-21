import type { Instance } from '../ir/instance';
import type { RenderSurface } from './context';
import { createDevice } from './context';
import { Background } from './background';
import { Model } from './model/model';
import { Camera } from './camera';

/**
 * 组装根：把模型、环境图、相机拼起来。
 *
 * 渲染目标、帧循环都归相机 —— 主线程那边也只有 camera 一个句柄管尺寸和出图，
 * 内外同一套分工。这里只负责持有生命周期。
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

    public readonly camera: Camera;
    public readonly background: Background;
    /** release() 之后为 true：渲染资源已经卸掉，只剩设备。 */
    private released = false;
    private readonly model: Model;

    private constructor(device: GPUDevice, canvas: RenderSurface) {
        this.background = new Background(device);
        this.model = new Model(device);
        this.camera = new Camera(device, canvas, this.model, this.background);
    }

    /**
     * 向场景追加几何 —— 引擎认识世界的入口之一。GPU 侧不解析任何东西，
     * 只接收已经准备好的 Instance；材质、位移、BVH 都在 Model.add 里。
     *
     * 可以反复调用：每次把新实例接在已有实例后面整体重编一遍。机位和环境图
     * 各走 `camera.applyView` / `background.setImage`，三者的先后由外部决定 ——
     * PathTracePass 等两边都到位才建 bind group。
     */
    public addInstances(instances: Instance[]): void {
        this.model.add(instances);
    }

    /**
     * 卸掉这一套渲染资源，但保留设备 —— Prism.dispose 时用：引擎销毁，
     * 设备是 Worker 的，不能跟着死。
     */
    public release(): void {
        if (this.released) return;
        this.released = true;
        // 相机先停：帧循环和各个 pass 都是它的，之后才能拆几何 / 环境图
        this.camera.destroy();
        this.model.destroy();
        this.background.destroy();
    }
}
