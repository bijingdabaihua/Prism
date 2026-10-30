import type { CameraPath, CameraView } from './camera';
import type { Image } from './image';
import type { Instance } from './instance';

/**
 * 场景 IR —— 导入器的出口，编译层的入口。
 *
 * 描述「世界里有什么 + 从哪儿看」：几何、唯一的光源、机位。不含任何
 * 「怎么渲染」的信息 —— 采样数、色调映射都不在这里。
 * 怎么造出 Scene 在 config/scene.ts。
 */
export interface Scene {
    /** 世界里的物体。空数组 = 什么都没有，不是「不提供」。 */
    instances: Instance[];
    /**
     * 环境图 —— 这个场景唯一的光源。必填：没有环境图就没有光，
     * 缺了它只能是黑屏，那不是任何一个场景想要的结果。
     */
    env: Image;
    /** 机位。构图是场景的一部分：同一个场景换一套机位就是另一张图。 */
    camera: CameraView;
    /**
     * 运镜轨迹（可选）。导出视频时逐帧在这里取样；没有它就只能导出静止画面。
     * 轨迹和机位是两件事：机位是访客看到的那一格，轨迹是「如果拍一段」。
     */
    cameraPath?: CameraPath;
}
