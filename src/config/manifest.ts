import type { Scene } from '../ir/scene';
import { createVaseOnDirt } from './scenes/vase-on-dirt';
import { SCENE_CARDS } from './catalog';
import type { SceneCard } from './catalog';

/**
 * 场景清单 —— 唯一写场景文件路径的地方。
 *
 * 一条记录分两半，因为读者完全不同：
 *
 *   card  画廊卡片上的文字和封面。纯展示，渲染一行都不读
 *   load  进了渲染页才用到：怎么造出 Scene IR
 *
 * 提供 loader 而不是 URL：场景来自文件还是来自代码，对上层是同一种东西。
 * 场景是内容，不是引擎：`engine/` 里不该出现「凳子」「砂土」这种词。
 */
interface SceneDefinition {
    card: SceneCard;
    load: () => Promise<Scene>;
}

export const SCENES: Record<string, SceneDefinition> = {
    'vase-on-dirt': {
        card: SCENE_CARDS['vase-on-dirt'],
        load: () => createVaseOnDirt('/env/sundowner_overlook_2k.exr'),
    },
};
