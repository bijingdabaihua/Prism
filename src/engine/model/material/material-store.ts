import type { Image } from '../../../ir/image';
import type { PBRMaterial, TextureKind } from '../../../ir/material';
import type { MaterialTexSlots, TexRef } from './packing';
import { TextureSet } from './texture/texture-set';
import { packPBRMaterial, PBR_MAT_FLOATS } from './packing';

/**
 * GPU material storage — owns the material SSBO.
 *
 * 一节材质 = PBR_MAT_FLOATS 个 float，shader 用三角形里存的绝对槽位索引它。
 * 同一个材质对象只打包一次，被多个 mesh 引用时共用同一个槽位。
 *
 * 材质表同时也持有所属的 TextureSet：材质表里的 TexRef 就是图集的层号，
 * 两者是一份数据的两半，分开持有只会多一个构造函数参数。
 *
 * 生命周期和场景一样：register() 收集、compile() 一次写进 SSBO，之后只读。
 */
export class MaterialStore {
    /** 材质采样的图集；pathTrace 直接从这里拿四个数组的 view。 */
    public readonly textures: TextureSet;
    private buffer!: GPUBuffer;
    private materials: Float32Array[] = [];
    private readonly device: GPUDevice;
    private readonly slots = new Map<PBRMaterial, number>();

    constructor(device: GPUDevice) {
        this.device = device;
        this.textures = new TextureSet(device);
    }

    /** 返回该材质在材质表里的绝对槽位；重复注册同一个对象返回同一槽位。 */
    public register(material: PBRMaterial): number {
        const cached = this.slots.get(material);
        if (cached !== undefined) return cached;
        const index = this.materials.length;
        const tex = this.resolveTextures(material);
        this.materials.push(packPBRMaterial(material, tex));
        this.slots.set(material, index);
        return index;
    }

    /** 把所有已注册的材质写进一块 SSBO —— 整个场景只做一次。 */
    public compile(): void {
        if (this.materials.length === 0) {
            throw new Error('MaterialStore: 场景里没有任何材质');
        }
        const data = new Float32Array(this.materials.length * PBR_MAT_FLOATS);
        for (let i = 0; i < this.materials.length; i++) {
            data.set(this.materials[i], i * PBR_MAT_FLOATS);
        }
        this.buffer = this.device.createBuffer({
            size: data.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: 'scene-materials',
        });
        this.device.queue.writeBuffer(this.buffer, 0, data as any);
    }

    public getBuffer(): GPUBuffer {
        return this.buffer;
    }

    public destroy(): void {
        this.buffer?.destroy();
        this.textures.destroy();
    }

    /**
     * 材质里的贴图 → texture_2d_array 的层号。
     *
     * IR 里的贴图已经是解码好的 Image，这里不需要再查表 —— 解码和去重都在
     * 导入器那一侧（config/load-texture.ts）完成，编译层只负责分配层号。
     */
    private resolveTextures(material: PBRMaterial): MaterialTexSlots {
        return {
            baseColor: this.texRef(material.baseColorTexture, 'albedo'),
            roughness: this.texRef(material.roughnessTexture, 'roughness'),
            normal: this.texRef(material.normalTexture, 'normal'),
            occlusion: this.texRef(material.occlusionTexture, 'occlusion'),
            // 打包图是数据图（G = rough, B = metal），和单通道粗糙度共用同一个数组：
            // 两者都是 rgba8unorm，通道各自独立，没有必要为它多开一个绑定。
            metallicRoughness: this.texRef(material.metallicRoughnessTexture, 'roughness'),
        };
    }

    /** 每米重复几次，由贴图自己的一格几米换算 —— 几何 UV 以米为单位。 */
    private texRef(image: Image | undefined, kind: TextureKind): TexRef | undefined {
        if (!image) return undefined;
        return { layer: this.textures.register(kind, image), scale: 1 / (image.meters ?? 1), has: 1 };
    }
}
