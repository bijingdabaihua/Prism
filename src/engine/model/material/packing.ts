import type { PBRMaterial } from '../../../ir/material';

/**
 * IR → GPU 定长布局的打包。
 *
 * 这里是唯一把 PBRMaterial 摊平成定长 float、把贴图图集坐标塞进槽位的地方；
 * shader 那边的下标与这里一一对应，改一边必须改另一边。
 *
 * 布局（28 floats / 112 B，槽位下标写在注释里）：
 *   0–2   baseColor            3  metallic
 *   4     roughness            5  normalScale
 *   6     occlusionStrength    7  填充
 *   8–11  baseColor TexRef    12–15 roughness TexRef
 *   16–19 normal TexRef       20–23 occlusion TexRef
 *   24–27 metallic-roughness TexRef
 */

// 贴图引用

/**
 * 一张贴图在 texture_2d_array 里的位置。
 *
 * 贴图按 kind 分到四个数组（albedo / normal / roughness / occlusion），所以一个引用
 * 只需要层号；采样时 UV 再乘 scale —— 几何 UV 以米为单位，scale 是「每米重复几次」，
 * 由贴图自己的一格几米（`Image.meters`）换出来，让墙面这种大表面的贴图密度不随几何尺寸变化。
 */
export interface TexRef {
    layer: number;
    scale: number;
    has: number;
}

export interface MaterialTexSlots {
    baseColor?: TexRef;
    roughness?: TexRef;
    normal?: TexRef;
    occlusion?: TexRef;
    /** 打包的 metallic-roughness（G = rough, B = metal），存在 roughness 数组里。 */
    metallicRoughness?: TexRef;
}

/** TexRef → 4 floats。没有贴图时 layer=0、scale=1、has=0。 */
function packTexRef(t: TexRef | undefined): number[] {
    return t ? [t.layer, t.scale, t.has, 0] : [0, 1, 0, 0];
}

// 材质

export const PBR_MAT_FLOATS = 28;

export function packPBRMaterial(m: PBRMaterial, tex?: MaterialTexSlots): Float32Array {
    const c = m.baseColor;
    const bc = packTexRef(tex?.baseColor);
    const ro = packTexRef(tex?.roughness);
    const n = packTexRef(tex?.normal);
    const ao = packTexRef(tex?.occlusion);
    const mr = packTexRef(tex?.metallicRoughness);
    return new Float32Array([
        c.r,
        c.g,
        c.b,
        m.metallic,
        m.roughness,
        m.normalScale,
        m.occlusionStrength,
        0.0,
        bc[0],
        bc[1],
        bc[2],
        bc[3],
        ro[0],
        ro[1],
        ro[2],
        ro[3],
        n[0],
        n[1],
        n[2],
        n[3],
        ao[0],
        ao[1],
        ao[2],
        ao[3],
        mr[0],
        mr[1],
        mr[2],
        mr[3],
    ]);
}
