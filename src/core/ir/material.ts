import type { Color } from '../../math/types';
import type { Image } from './image';
import { parseBlendMaterial } from './blend';

/**
 * 渲染器内部统一的材质表达。
 *
 * glTF 的材质在 ir/instance.ts 的导入器里映射成构造参数；.blend 的导入器在
 * ir/blend.ts，由 `buildByBlend` 驱动。映射是有损的，损失多少由各导入器自己说明。
 * GPU 打包在 engine/model/material/packing.ts。
 *
 * 贴图字段是解码后的 Image，不是 URL —— IR 里不留文件路径，导入器在场景加载时
 * 就把图解开，编译层拿到的全是内存里的像素。
 */
export class PBRMaterial {
    /**
     * 从 `.blend` 的材质节点图构造（解析器在 ir/blend.ts）。
     *
     * `meters` 是一格贴图覆盖的真实尺寸：Blender 里它记在场景 / 物体上，
     * 材质文件里没有，只能由调用方给。
     */
    public static async buildByBlend(url: string, meters?: number): Promise<PBRMaterial> {
        return new PBRMaterial(await parseBlendMaterial(url, meters));
    }

    public readonly baseColor: Color;
    public readonly metallic: number;
    public readonly roughness: number;
    public readonly baseColorTexture?: Image;
    /**
     * glTF 的 metallic-roughness 打包图：G = 粗糙度，B = 金属度，R = 环境光遮蔽。
     * Poly Haven 的 arm 图（AO / Rough / Metal）是同一套通道排列，可以直接用。
     *
     * metallic / roughness 两个标量在这条路径上是**乘数**（glTF 的
     * metallicFactor / roughnessFactor），不是覆盖值 —— 金属度终于能随贴图变化了。
     */
    public readonly metallicRoughnessTexture?: Image;
    /**
     * 单通道粗糙度图（Poly Haven 的 Rough 图）。
     *
     * 和 metallicRoughnessTexture 同时设置时，粗糙度以后者为准、这条路径只覆盖
     * 粗糙度（金属度仍从打包图取）；同一张贴图不必按两种 kind 注册两次。
     */
    public readonly roughnessTexture?: Image;
    public readonly normalTexture?: Image;
    public readonly normalScale: number;
    public readonly occlusionTexture?: Image;
    public readonly occlusionStrength: number;
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
    public readonly displacement?: Image;
    /**
     * 高度零点：图上这个灰度值当作「不抬不陷」，对应 Blender Displacement
     * 节点的 Midlevel。扫描图存的不是绝对高度，零点只能由材质作者定。
     */
    public readonly displacementMid?: number;
    /**
     * 高度刻度（米）：灰度每差 1.0 位移这么多，对应 Blender Displacement
     * 节点的 Scale。位移量 = `(高度 - displacementMid) × displacementScale`。
     */
    public readonly displacementScale?: number;

    constructor(options: PBRMaterialOptions = {}) {
        this.baseColor = options.baseColor ?? { r: 0.85, g: 0.85, b: 0.85, a: 1 };
        this.metallic = options.metallic ?? 0;
        this.roughness = options.roughness ?? 0.5;
        this.baseColorTexture = options.baseColorTexture;
        this.metallicRoughnessTexture = options.metallicRoughnessTexture;
        this.roughnessTexture = options.roughnessTexture;
        this.normalTexture = options.normalTexture;
        this.normalScale = options.normalScale ?? 1;
        this.occlusionTexture = options.occlusionTexture;
        this.occlusionStrength = options.occlusionStrength ?? 1;
        this.displacement = options.displacement;
        this.displacementMid = options.displacementMid;
        this.displacementScale = options.displacementScale;
    }

    /**
     * 去掉位移贴图和相关刻度，返回可以直接上 GPU 的材质。
     *
     * `Mesh.evolve` 把位移烘成几何时调用：位移进 GPU 之前必须消失，着色器
     * 不知道它存在，材质 SSBO 里也没有这一格。没有位移时原样返回（`===` 自己）。
     */
    public withoutDisplacement(): PBRMaterial {
        if (!this.displacement) return this;
        const {
            displacement: _image,
            displacementMid: _mid,
            displacementScale: _scale,
            ...rest
        } = this;
        return new PBRMaterial(rest);
    }
}

/**
 * 构造参数。省略的字段取默认值：0.85 灰、非金属、粗糙度 0.5、
 * 法线强度 1、遮蔽强度 1。
 */
export interface PBRMaterialOptions {
    baseColor?: Color;
    metallic?: number;
    roughness?: number;
    baseColorTexture?: Image;
    metallicRoughnessTexture?: Image;
    roughnessTexture?: Image;
    normalTexture?: Image;
    normalScale?: number;
    occlusionTexture?: Image;
    occlusionStrength?: number;
    displacement?: Image;
    displacementMid?: number;
    displacementScale?: number;
}

/** 材质贴图的四个通道：决定进哪个 texture_2d_array，也决定要不要 sRGB 解码。 */
export type TextureKind = 'albedo' | 'normal' | 'roughness' | 'occlusion';
