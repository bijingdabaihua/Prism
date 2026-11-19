/**
 * 相机 IR：场景作者指定的机位。
 *
 * 构图是场景的一部分 —— 同一个场景换一套参数就是另一张图，所以它跟着
 * Scene 走（`Scene.camera`），由场景构建器给出。引擎侧的 Camera 把这份
 * 描述变成轨道参数和 112 B uniform；之后鼠标怎么转，是观察者的事。
 */
export interface CameraView {
    target: { x: number; y: number; z: number };
    /** 相机到 target 的距离（米，轨道半径） */
    distance: number;
    /** 水平角，π/2 表示从 +z 方向看过来 */
    theta: number;
    /** 俯仰角，π/2 是水平视线，越小相机越高 */
    phi: number;
    /**
     * 垂直视野角，弧度。水平视野 = 2·atan(tan(fovY/2) · 宽高比)，
     * 所以它只管上下开口，左右跟着窗口走。
     */
    fovY: number;
    /**
     * 入射光瞳半径（米）。省略或 0 = 针孔相机，没有景深。
     *
     * 这是镜头的物理尺寸，不是「虚化强度」：薄透镜只有两个自由度，光圈多大、
     * 对焦在多远。f 值要自己按焦距换算（50 mm 镜头开 f/2.8，光瞳直径
     * 17.9 mm，半径 8.9 mm）。
     */
    apertureRadius?: number;
    /**
     * 对焦距离（米，沿视线从相机量起）。需要和 `apertureRadius` 一起给才生效。
     *
     * 对焦是镜头的状态，不跟着鼠标轨道转 —— 观察者绕着场景转时，合焦面停在
     * 场景作者定的那层深度上。
     */
    focusDistance?: number;
}
