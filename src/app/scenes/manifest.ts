import type { Scene } from '../../core/ir/scene';
import { createVaseOnDirt } from './vase-on-dirt';

/**
 * 场景清单 —— 唯一写场景文件路径的地方。
 *
 * key 是画廊卡片和路由共用的业务标识（卡片数据在 catalog.ts）；这里只回答
 * 「这个 key 怎么造出 Scene IR」，提供 loader 而不是 URL —— 场景来自文件还是
 * 来自代码，对上层是同一种东西。
 *
 * 场景是业务内容，住在这里：`core/` 和 `engine/` 里不该出现「凳子」「砂土」
 * 这种词。唯一读这份清单的是 Worker 组合根（core/worker.ts）。
 */
export const SCENES: Record<string, () => Promise<Scene>> = {
    'vase-on-dirt': () => createVaseOnDirt('/env/sundowner_overlook_2k.exr'),
};
