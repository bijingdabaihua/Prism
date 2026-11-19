/**
 * 场景卡片元数据：画廊上展示的东西，和渲染无关。
 *
 * 单独成一个文件，是为了不 import 任何场景构建器 / 导入器 —— 主线程
 * （core/Prism 与 app）读它时不会把 glTF / blend / 图像解码器打进首屏
 * chunk。场景怎么造（`scene.load`）仍然只在 `config.ts` 里写。
 */
export interface SceneCard {
    title: string;
    /** 卡片上的一句话说明 */
    subtitle: string;
    /** 卡片上的技术标签，让人一眼看到用了什么 */
    tags: string[];
    /** 画廊封面；缺省时卡片显示占位底纹。放在 assets/gallery/<key>.png */
    cover?: string;
}

export const SCENE_CARDS = {
    'vase-on-dirt': {
        title: '荒地',
        subtitle: '青花瓷罐搁在夕阳下的砂土上，一片平地铺到画外，只剩土和光',
        tags: ['实例化地表', '薄透镜景深', 'glTF 资产'],
        cover: '/gallery/vase-on-dirt.png',
    },
} satisfies Record<string, SceneCard>;
