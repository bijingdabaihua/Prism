import type { Scene } from '../ir/scene';
import { createVaseOnDirt } from './scenes/vase-on-dirt';

/**
 * 场景清单 —— 唯一写场景文件路径的地方。
 *
 * key 是画廊卡片和路由共用的业务标识（卡片数据在 catalog.ts）；这里只回答
 * 「这个 key 怎么造出 Scene IR」，提供 loader 而不是 URL —— 场景来自文件还是
 * 来自代码，对上层是同一种东西。
 *
 * 场景是内容，不是引擎：`engine/` 里不该出现「凳子」「砂土」这种词。
 */
export const SCENES: Record<string, () => Promise<Scene>> = {
    'vase-on-dirt': () => createVaseOnDirt('/env/sundowner_overlook_2k.exr'),
};
