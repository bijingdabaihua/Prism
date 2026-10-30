import type { CameraPath, CameraView } from '../ir/camera';
import type { Scene } from '../ir/scene';
import { createScene } from './scene';
import { buildTiledGround, loadGroundMaterial, ENV_ROTATION, GROUND_TILE } from './ground';
import { loadGLTF } from './gltf';
import { loadImage } from './load-image';
import { placeInstances } from './placement';
import { rotateEquirect } from './rotate-equirect';

/**
 * 荒地 —— 一只青花瓷罐搁在夕阳下的砂土上，右下角躺着一根枯枝。
 *
 * 地面是主角的一半：位移让土块在掠射光下全部立起来，景深把二十米外的土化成
 * 一片暖光。
 *
 * 地面只有 3×3 块砖（6.33 m 见方），所以机位是按**这块地**算的，不是反过来：
 * phi = 1.12（视线相对水平面俯 25.8°）时眼高 0.94 m，视锥最上面那个角打在
 * 地上离原点 2.2 m 的地方 —— 外沿在 3.165 m，整幅画都压在砖面里，一丝天都
 * 看不到。压低机位、或者把视线放平，落点很快越过外沿，画面顶上就露出环境图。
 *
 * 铺法见 `buildTiledGround`：一块 2.11 m 的砖、九块、共用一棵 BLAS ——
 * 整片地面按 4 mm 一格切是四亿多个三角形，实际只有一个 52 万面的砖被反复摆。
 */

const VASE_URL = '/model/antique_ceramic_vase_01/antique_ceramic_vase_01_1k.gltf';
const BRANCH_URL = '/model/dead_quiver_branch_01/dead_quiver_branch_01_1k.gltf';

/**
 * 相机：50 mm 等效、离地 0.94 m、俯角 25.8°、开 f/1.2。
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
const CAMERA: CameraView = {
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

/**
 * 演示运镜：6 秒，从稍远处缓缓推近，同时横移约 5°。
 *
 * 幅度是压着的 —— 地面只有 3×3 块，转出去或者压低视线就会露出地边。
 * 距离从 1.72 m 收到 1.56 m，视差够让罐子和枯枝分开，又不至于把构图拆散。
 * 俯角基本不动：最远那一帧（1.72 m）的上角已经贴着砖边，再把视线放平就得出画。
 */
const CAMERA_PATH: CameraPath = {
    duration: 6,
    keyframes: [
        { t: 0, target: CAMERA.target, distance: 1.72, theta: -0.035, phi: 1.121 },
        { t: 0.5, target: CAMERA.target, distance: 1.64, theta: 0.01, phi: 1.12 },
        { t: 1, target: CAMERA.target, distance: 1.56, theta: 0.05, phi: 1.119 },
    ],
};

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
const SUN_ROTATION = ENV_ROTATION + 0.60;

export async function createVaseOnDirt(envUrl: string): Promise<Scene> {
    const material = await loadGroundMaterial();
    // 临时：3×3 块砖（6.33 m 见方）。范围按「砖心落在 ±1 块」给，
    // 边界正好落在最外一圈砖的外沿，不会多铺半块。
    const ground = buildTiledGround(
        material,
        -GROUND_TILE,
        GROUND_TILE,
        -GROUND_TILE,
        GROUND_TILE,
    );

    const vase = await loadGLTF(VASE_URL);
    // 罐子正对原点：底面就在 y = 0，直接坐在砂土上。
    placeInstances(vase, { position: { x: 0, y: 0, z: 0 }, rotationY: 0.4 });

    // 枯枝躺在地上：绕 X 放倒 90°，再绕 Y 转 22° 斜着躺进画面右下角。
    // 抬 9 cm 是因为放倒之后最低点（原来是 −z 方向的那一侧）在 y = −0.097，
    // 少抬 7 mm 让它陷进土里一点，别像搁在玻璃上。
    const branch = await loadGLTF(BRANCH_URL);
    placeInstances(branch, {
        position: { x: 0.04, y: 0.09, z: -0.27 },
        rotationX: -Math.PI / 2,
        rotationY: 0.38,
    });

    return createScene({
        instances: [...ground, ...vase, ...branch],
        env: rotateEquirect(await loadImage(envUrl), SUN_ROTATION),
        camera: CAMERA,
        cameraPath: CAMERA_PATH,
    });
}
