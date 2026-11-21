import type { CameraSpec } from '../../core/prism';

/**
 * 场景元数据：画廊卡片 + 外面装场景要用的机位 / 环境图。
 *
 * 纯数据，不 import 任何场景构建器 / 导入器 —— 主线程（画廊、渲染页）读它时
 * 不会把 glTF / blend / 图像解码器打进首屏 chunk。几何怎么造仍然只在
 * `manifest.ts` 里写，Worker 按 key 查。
 *
 * 装场景的顺序由外部决定：先 `camera.set`，再 `background.setImage` /
 * `background.setRotation`，然后 `model.load`，最后 `camera.listen`。
 */

/** 渲染器需要、几何之外的场景参数。 */
export interface SceneSetup {
    /** 构图。换一套机位就是另一张图，所以它是场景的一部分。 */
    camera: CameraSpec;
    /** 环境图 URL；Worker 负责解码。 */
    env: string;
    /** 环境图绕 +y 的旋转（弧度），省略 = 原图方向。 */
    envRotation?: number;
}

export interface SceneCard {
    title: string;
    /** 卡片上的一句话说明 */
    subtitle: string;
    /** 卡片上的技术标签，让人一眼看到用了什么 */
    tags: string[];
    /** 画廊封面；缺省时卡片显示占位底纹。放在 assets/gallery/<key>.png */
    cover?: string;
    setup: SceneSetup;
}

/**
 * 太阳方位。
 *
 * 三张候选环境的太阳方位角几乎一样（实测都是 φ ≈ 36.1°），差别只在高度：
 * venice_sunset 3.4°、aarfontein 0.3°、sundowner 27.2°。前两张的太阳贴着
 * 地平线，直射到水平面上只剩 cos(90°) ≈ 0 —— 地面只能靠天光，画面是平的。
 *
 * 所以用 sundowner，再把环境转 34°，让太阳落到 φ ≈ −80°：画面右侧偏后。
 * 方位角只决定影子往哪边扫 —— 太阳在右手边，影子就朝 +z 横着扫过画面左边。
 * 长度是算出来的：0.44 / tan(27.2°) ≈ 0.86 m，正好横穿左半个画面。
 *
 * 再往前转影子会缩回罐子底下，那道长影子就没了；再往后转太阳会跑到罐子背后，
 * 正面只剩天光，罐身的青花就糊成一片。
 */
const ENV_ROTATION = (Math.PI / 180) * (36.1 - 100) + Math.PI - 0.6;
const SUN_ROTATION = ENV_ROTATION + 0.6;

/**
 * 荒地机位：50 mm 等效、离地 0.94 m、俯角 25.8°、开 f/1.2。
 *
 * `fovY` 按 16:9 画幅的 20.25 mm 片高换算：2·atan(20.25/2/50) = 0.399。
 * 视角定了，镜头的物理尺寸就只剩光圈一个自由度：50 mm 开 f/1.2，入射光瞳
 * 直径 41.7 mm，半径 20.8 mm。景深约 3 cm —— 罐子正面全实，罐口后沿散 3 px，
 * 两米半外的土散 10 px，四十米外散 22 px。再开大罐口就虚了，再收小背景又回来抢戏。
 *
 * 机位抬到 25.8°：视锥上缘那条射线落在砖面外沿（3.165 m）以内，
 * 整幅画只剩土，不给环境图留缝。再抬就俯视过头，罐口缩成一个椭圆；
 * 再压回去，画面顶上的角立刻越过砖边。
 *
 * phi 是从 +Y 量的极角：64.2° 时相机水平退开 1.48 m、抬起 0.72 m。
 */
const VASE_CAMERA: CameraSpec = {
    target: { x: 0, y: 0.22, z: -0.10 },
    distance: 1.646,
    theta: 0.0,
    phi: 1.12,
    fovY: 0.399,
    // 暂时关掉景深（原本 0.0208 / 1.522）：光圈每采样一次要再抖一个圆盘位置，
    // 焦外区域的方差大得多，同样的 spp 看起来更脏。调材质期间先把这项静音，
    // 恢复时把下面两个值放回来即可 —— 着色器在 aperture_radius <= 0 时走针孔，
    // 一处都不用改。
    apertureRadius: 0,
    focusDistance: 0,
};

export const SCENE_CARDS: Readonly<Record<string, SceneCard>> = {
    'vase-on-dirt': {
        title: '荒地',
        subtitle: '青花瓷罐搁在夕阳下的砂土上，一片平地铺到画外，只剩土和光',
        tags: ['实例化地表', '薄透镜景深', 'glTF 资产'],
        cover: '/gallery/vase-on-dirt.png',
        setup: {
            camera: VASE_CAMERA,
            env: '/env/sundowner_overlook_2k.exr',
            envRotation: SUN_ROTATION,
        },
    },
};
