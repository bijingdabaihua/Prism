/**
 * 对外唯一入口 —— 接口草案，暂未接入任何实现。
 *
 * 业务层只认识这一个类，实例对外只暴露 camera / background / model
 * 三个只读句柄。
 *
 * 当前只定形状，create 是占位。确认接口之后再接 engine / config。
 */
export class Prism {
    /** 异步工厂：只完成 GPU 初始化；场景与环境图通过句柄的 setter 配置。 */
    public static async create(): Promise<Prism> {
        throw new Error('Prism.create is not implemented yet');
    }

    /** 观察者：机位控制。 */
    public declare readonly camera: CameraHandle;
    /** 环境光照：目前只暴露就绪状态。 */
    public declare readonly background: BackgroundHandle;
    /** 场景几何：已编译的模型。 */
    public declare readonly model: ModelHandle;

    private constructor() {}
}

/**
 * 观察模型：绕 target 的轨道相机。
 *
 * 这是本渲染器的机位语义，不是 ir/CameraView 的拷贝 —— 结构一样只是巧合，
 * 业务契约不跟着 IR 变。
 */
export interface CameraSpec {
    target: { x: number; y: number; z: number };
    /** 相机到 target 的距离（米，轨道半径）。 */
    distance: number;
    /** 水平角，π/2 表示从 +z 方向看过来。 */
    theta: number;
    /** 俯仰角，π/2 是水平视线，越小相机越高。 */
    phi: number;
    /** 垂直视野角，弧度。 */
    fovY: number;
    /** 入射光瞳半径（米）。省略或 0 = 针孔。 */
    apertureRadius?: number;
    /** 对焦距离（米）。需要和 apertureRadius 一起给才生效。 */
    focusDistance?: number;
}

export interface CameraHandle {
    /** 直接指定机位。 */
    set(spec: CameraSpec): void;
    /** 回到场景自带的机位。 */
    reset(): void;
    /** 绕 target 旋转。 */
    orbit(deltaTheta: number, deltaPhi: number): void;
    /** 推拉：>1 拉远，<1 推近。 */
    zoom(factor: number): void;
    /** 平移 target（屏幕空间像素）。 */
    pan(deltaX: number, deltaY: number): void;
}

/** 业务层的场景标识，来自 config 里的 SCENES 清单。 */
export type SceneKey = string;

export interface BackgroundHandle {
    /** 设置环境图（URL）。重复调用即换背景。 */
    setImage(url: string): Promise<void>;
    /** 环境图是否已经装好 —— 也是「场景就绪」的信号。 */
    ready(): boolean;
}

export interface ModelHandle {
    /** 装载场景（按 key）。重复调用即换场景。 */
    setScene(scene: SceneKey): Promise<void>;
    /** 几何是否已经编译好（BVH / buffer 上传完成）。 */
    ready(): boolean;
    /** 场景里的实例数。 */
    instances(): number;
    /** 三角形总数。 */
    triangles(): number;
}
