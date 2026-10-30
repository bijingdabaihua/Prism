import type { Vec3 } from '../math/types';
import type { PBRMaterial } from '../ir/material';
import { Instance } from '../ir/instance';
import { MeshBuilder } from './mesh-builder';
import { loadBlendMaterial } from './blend';

/**
 * 砂土地面 —— 荒地场景的地表。
 *
 * 一张平面铺不出这个场景：低机位下画面顶端几乎贴着地平线，一片 1 m 见方的
 * 板 2 m 外就被看见边了。所以这里是「一块地砖 + 实例化」，见 `buildTiledGround`。
 *
 * 材质全在 `forest_ground_06.blend` 里 —— 四张贴图、色彩空间、法线强度、
 * 位移的 Midlevel / Scale 都是作者填的。这里只给一个文件读不出来的数：一格
 * 贴图多大（Poly Haven 把它放在网页 API 的 `dimensions` 里，不在 .blend 中）。
 *
 * 位移是材质的属性，不是几何的属性：这里只铺一张平的四边形，细分和抬起
 * 由 `Mesh.evolve` 在编译时做。
 */

/** 一格贴图覆盖的真实尺寸（米）：资产接口 `dimensions` = [2109.99, 2109.99] mm。 */
const GROUND_METERS = 2.11;

/**
 * 环境图的太阳方位角：sundowner 36.1°、venice_sunset 35.9°（实测最亮像素
 * 质心），两张图几乎一样。转到相机右后方，影子朝画面左侧扫过去。
 */
export const ENV_ROTATION = (Math.PI / 180) * (36.1 - 100) + Math.PI - 0.6;

/** 水平四边形，绕序保证法线朝 +y（和 addQuad 的约定一致）。 */
function groundQuad(x0: number, x1: number, z0: number, z1: number): [Vec3, Vec3, Vec3, Vec3] {
    return [
        { x: x0, y: 0, z: z1 },
        { x: x1, y: 0, z: z1 },
        { x: x1, y: 0, z: z0 },
        { x: x0, y: 0, z: z0 },
    ];
}

/** 砂土材质：荒地场景的地砖用它。 */
export function loadGroundMaterial(): Promise<PBRMaterial> {
    return loadBlendMaterial('/textures/forest_ground_06/forest_ground_06.blend', GROUND_METERS);
}

/**
 * 地砖边长（米）—— 必须等于贴图周期，否则铺开时位移在砖缝上对不上。
 */
export const GROUND_TILE = GROUND_METERS;

/**
 * 用一块地砖铺出的大地面：一块 mesh、很多实例、共用一棵 BLAS。
 *
 * 为什么切开：4 mm 一格的大地面没法一次切出来。42 m 见方是 2 亿个三角形，
 * 光顶点就 3 GB。切成 2.11 m 的砖之后，几何只算一份（约 52 万三角形），
 * 铺多少块都只多一张实例表 —— `blasCache` 按 mesh 缓存，实例之间共享同一棵树。
 *
 * 为什么边长正好是 2.11 m：位移是从贴图上采样的，贴图每 2.11 m 重复一次。
 * 砖边长等于这个周期时，相邻砖边界上的 UV 正好从 2.11 接回 0，两边采到的高度
 * 相同，位移和图案都自己接上 —— 铺出来的结果和「一整块大地」逐顶点一样。
 * 换成整数 2 m，缝上就错开 0.11 m，又是一条线。
 *
 * 砖中心落在 (i·T, 0, j·T) 上，所以原点是砖心，罐子正好踩在中间那块上。
 * 范围按**砖心**取舍：中心落在 [x0, x1] 里的砖才有。两段地面用相邻的
 * x0 / x1 调，就正好在一条砖缝上接上，既不重叠也不留缝。
 */
export function buildTiledGround(
    material: PBRMaterial,
    x0: number,
    x1: number,
    z0: number,
    z1: number,
    name = 'ground-tile',
): Instance[] {
    const h = GROUND_TILE * 0.5;
    const builder = new MeshBuilder();
    builder.addQuad(groundQuad(-h, h, -h, h), 0);
    const tile = builder.build([material], name);

    const instances: Instance[] = [];
    for (let i = Math.ceil(x0 / GROUND_TILE); i <= Math.floor(x1 / GROUND_TILE); i++) {
        for (let j = Math.ceil(z0 / GROUND_TILE); j <= Math.floor(z1 / GROUND_TILE); j++) {
            const m = new Float32Array(16);
            m[0] = m[5] = m[10] = m[15] = 1;
            m[12] = i * GROUND_TILE;
            m[14] = j * GROUND_TILE;
            instances.push(new Instance(tile, m));
        }
    }
    return instances;
}
