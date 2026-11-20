import { Instance, placeInstances } from '../../core/ir/instance';
import { buildTiledGround, loadGroundMaterial, GROUND_TILE } from './ground';

/**
 * 荒地 —— 一只青花瓷罐搁在夕阳下的砂土上，右下角躺着一根枯枝。
 *
 * 这里只造几何。机位和环境图在 `catalog.ts` 的 setup 里 —— 外部先把机位和
 * 环境装好，再调 `model.load('vase-on-dirt')` 把这份几何编译进引擎。
 *
 * 地面是主角的一半：位移让土块在掠射光下全部立起来，景深把二十米外的土化成
 * 一片暖光。铺法见 `buildTiledGround`：一块 2.11 m 的砖、九块、共用一棵 BLAS。
 */

const VASE_URL = '/model/antique_ceramic_vase_01/antique_ceramic_vase_01_1k.gltf';
const BRANCH_URL = '/model/dead_quiver_branch_01/dead_quiver_branch_01_1k.gltf';

export async function createVaseOnDirt(): Promise<Instance[]> {
    const material = await loadGroundMaterial();
    // 3×3 块砖（6.33 m 见方）。范围按「砖心落在 ±1 块」给，
    // 边界正好落在最外一圈砖的外沿，不会多铺半块。
    const ground = buildTiledGround(
        material,
        -GROUND_TILE,
        GROUND_TILE,
        -GROUND_TILE,
        GROUND_TILE,
    );

    const vase = await Instance.buildByGltf(VASE_URL);
    // 罐子正对原点：底面就在 y = 0，直接坐在砂土上。
    placeInstances(vase, { position: { x: 0, y: 0, z: 0 }, rotationY: 0.4 });

    // 枯枝躺在地上：绕 X 放倒 90°，再绕 Y 转 22° 斜着躺进画面右下角。
    // 抬 9 cm 是因为放倒之后最低点（原来是 −z 方向的那一侧）在 y = −0.097，
    // 少抬 7 mm 让它陷进土里一点，别像搁在玻璃上。
    const branch = await Instance.buildByGltf(BRANCH_URL);
    placeInstances(branch, {
        position: { x: 0.04, y: 0.09, z: -0.27 },
        rotationX: -Math.PI / 2,
        rotationY: 0.38,
    });

    return [...ground, ...vase, ...branch];
}
