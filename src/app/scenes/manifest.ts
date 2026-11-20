import type { Instance } from '../../core/ir/instance';
import { createVaseOnDirt } from './vase-on-dirt';

/**
 * 场景几何清单 —— 唯一写场景文件路径的地方。
 *
 * 只回答「这个 key 的几何怎么造」；机位和环境图在 `catalog.ts`，由外部
 * 按顺序装进引擎。场景来自文件还是来自代码，对上层是同一种东西。
 *
 * 场景是业务内容，住在这里：`core/` 和 `engine/` 里不该出现「罐子」「砂土」
 * 这种词。唯一读这份清单的是 Worker（`core/worker.ts`）。
 */
export const SCENES: Record<string, () => Promise<Instance[]>> = {
    'vase-on-dirt': createVaseOnDirt,
};
