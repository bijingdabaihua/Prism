import type { Color } from '../math/types';
import type { Image } from './image';

/**
 * 渲染器内部统一的材质表达。
 *
 * 导入器（glTF）把各自的材质模型映射到这里；
 * 映射是有损的，损失多少由各导入器自己负责说明。GPU 打包在 engine/model/material/packing.ts。
 *
 * 贴图字段是解码后的 Image，不是 URL —— IR 里不留文件路径，导入器在场景加载时
 * 就把图解开，编译层拿到的全是内存里的像素。
 */
export interface PBRMaterial {
    baseColor: Color;
    metallic: number;
    roughness: number;
    baseColorTexture?: Image;
    /**
     * glTF 的 metallic-roughness 打包图：G = 粗糙度，B = 金属度，R = 环境光遮蔽。
     * Poly Haven 的 arm 图（AO / Rough / Metal）是同一套通道排列，可以直接用。
     *
     * metallic / roughness 两个标量在这条路径上是**乘数**（glTF 的
     * metallicFactor / roughnessFactor），不是覆盖值 —— 金属度终于能随贴图变化了。
     */
    metallicRoughnessTexture?: Image;
    /**
     * 单通道粗糙度图（Poly Haven 的 Rough 图）。
     *
     * 和 metallicRoughnessTexture 同时设置时，粗糙度以后者为准、这条路径只覆盖
     * 粗糙度（金属度仍从打包图取）；同一张贴图不必按两种 kind 注册两次。
     */
    roughnessTexture?: Image;
    normalTexture?: Image;
    normalScale: number;
    occlusionTexture?: Image;
    occlusionStrength: number;
    /**
     * 位移贴图：灰度高度图，和 albedo 一样按它自己的 `meters` 重复。
     *
     * 有它的材质，三角形在进渲染前会被细分、按图抬起（见 `ir/mesh.ts` 的
     * `Mesh.evolve`）。只看三角形自己的 UV，不看位置。演化之后这张图就被
     * **消耗**掉了 —— 上 GPU 的材质里不再有它，着色器也从来不知道它存在。
     *
     * 有图就必须给 `displacementMid` 和 `displacementScale`。格距不用给 ——
     * 由图的一格几米和像素宽度算出来（一个 texel 一格）。
     */
    displacement?: Image;
    /**
     * 高度零点：图上这个灰度值当作「不抬不陷」，对应 Blender Displacement
     * 节点的 Midlevel。扫描图存的不是绝对高度，零点只能由材质作者定。
     */
    displacementMid?: number;
    /**
     * 高度刻度（米）：灰度每差 1.0 位移这么多，对应 Blender Displacement
     * 节点的 Scale。位移量 = `(高度 - displacementMid) × displacementScale`。
     */
    displacementScale?: number;
}

/** 材质贴图的四个通道：决定进哪个 texture_2d_array，也决定要不要 sRGB 解码。 */
export type TextureKind = 'albedo' | 'normal' | 'roughness' | 'occlusion';

export function defaultPBRMaterial(): PBRMaterial {
    return {
        baseColor: { r: 0.85, g: 0.85, b: 0.85, a: 1 },
        metallic: 0.0,
        roughness: 0.5,
        normalScale: 1.0,
        occlusionStrength: 1.0,
    };
}
