import type { Scene } from '../ir/scene';
import { createVaseOnDirt } from './vase-on-dirt';

/**
 * 场景清单 —— 唯一写场景文件路径的地方。
 *
 * 一条记录分两半，因为读者完全不同：
 *
 *   card   画廊卡片上的文字和封面。纯展示，渲染一行都不读
 *   scene  进了渲染页才用到：怎么造出 Scene IR
 *
 * 每个条目提供 loader 而不是 URL：场景来自文件还是来自代码，对上层是同一种东西。
 *
 * 清单下面紧接着就是每个 `load()` 的实现。场景是内容，不是引擎：
 * `engine/` 里不该出现「凳子」「砂土」这种词，它只认 Instance 和 Scene。
 */
export interface SceneEntry {
    card: SceneCard;
    scene: SceneSetup;
}

/** 画廊卡片上展示的东西。和渲染无关，改它不会改变图。 */
export interface SceneCard {
    title: string;
    /** 卡片上的一句话说明 */
    subtitle: string;
    /** 卡片上的技术标签，让人一眼看到用了什么 */
    tags: string[];
    /** 画廊封面；缺省时卡片显示占位底纹。放在 assets/gallery/<key>.png */
    cover?: string;
}

/** 进渲染页之后才用到的东西：场景从哪来、怎么显示。 */
export interface SceneSetup {
    load: () => Promise<Scene>;
}

export const SCENES: Record<string, SceneEntry> = {
    'vase-on-dirt': {
        card: {
            title: '荒地',
            subtitle: '青花瓷罐搁在夕阳下的砂土上，一片平地铺到画外，只剩土和光',
            tags: ['实例化地表', '薄透镜景深', 'glTF 资产'],
            cover: '/gallery/vase-on-dirt.png',
        },
        scene: {
            load: () => createVaseOnDirt('/env/sundowner_overlook_2k.exr'),
        },
    },
};
