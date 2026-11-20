import type { CameraView } from './camera';
import type { Image } from './image';
import type { Instance } from './instance';

/**
 * 场景 IR —— 导入器的出口，编译层的入口。
 *
 * 描述「世界里有什么 + 从哪儿看」：几何、唯一的光源、机位。不含任何
 * 「怎么渲染」的信息 —— 采样数、色调映射都不在这里。
 * 怎么造出 Scene 在 app/scenes/scene.ts。
 */
export interface Scene {
    /** 世界里的物体。空数组 = 什么都没有，不是「不提供」。 */
    instances: Instance[];
    /**
     * 环境图 —— 这个场景唯一的光源。必填：没有环境图就没有光，
     * 缺了它只能是黑屏，那不是任何一个场景想要的结果。
     */
    env: Image;
    /**
     * 环境图绕 +y 的旋转（弧度），省略 = 原图方向。
     *
     * 只用于对齐 HDR 里已有的太阳方位，不改变光源本身。转图、建 CDF 都在
     * `Background.setImage` 里做 —— 场景只给角度。
     */
    envRotation?: number;
    /** 机位。构图是场景的一部分：同一个场景换一套机位就是另一张图。 */
    camera: CameraView;
}
