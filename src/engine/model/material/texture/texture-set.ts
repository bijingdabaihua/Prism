import type { Image } from '../../../../ir/image';
import type { TextureKind } from '../../../../ir/material';
import { linearToSRGB } from '../../../../math/color';

/**
 * 材质贴图 —— 四个 texture_2d_array（颜色 / 法线 / 粗糙度 / AO），各自带完整 mip 链。
 *
 * 为什么不用图集：图集里一张 1024 的贴图只占 1/4 页，几套材质就把 2048 页塞满，
 * 而且整页共用一个 mip 链，小图和大图只能取同一个 LOD。分数组之后每张贴图
 * 独立分层，层号进材质表，shader 用 textureSampleLevel 显式选 LOD。
 *
 * 为什么用数组不用多张纹理：每 stage 的采样纹理数有上限（默认 16），
 * 一套材质四张图，几个材质就会超。四个数组把绑定数固定成 4。
 *
 * 生命周期跟着 MaterialStore（按 key 缓存），换场景时不清空：贴图是资产，不是场景数据。
 * 四个数组按需分配 —— 一张贴图都没注册时不占显存，只留 1×1 占位。
 * 0 号层永远保留给占位数据，真正的贴图从 1 号层开始。
 */

/** 颜色贴图存 sRGB（8 位精度保留在暗部），数据贴图存原始值。 */
const FORMAT: Record<TextureKind, GPUTextureFormat> = {
    albedo: 'rgba8unorm-srgb',
    normal: 'rgba8unorm',
    roughness: 'rgba8unorm',
    occlusion: 'rgba8unorm',
};

const ENCODE_SRGB: Record<TextureKind, boolean> = {
    albedo: true,
    normal: false,
    roughness: false,
    occlusion: false,
};

/** 0 号层的占位颜色：白色、平面法线、全粗糙、无遮挡。 */
const PLACEHOLDER: Record<TextureKind, [number, number, number]> = {
    albedo: [1, 1, 1],
    normal: [0.5, 0.5, 1],
    roughness: [1, 1, 1],
    occlusion: [1, 1, 1],
};

interface Channel {
    texture: GPUTexture;
    view: GPUTextureView;
    /** 下一个可用层号；0 号层是占位。 */
    next: number;
    allocated: boolean;
    /** 已注册的贴图 → 层号；按 Image 对象身份去重。 */
    keys: Map<Image, number>;
}

export class TextureSet {
    public readonly size: number;
    public readonly layerCount: number;
    private readonly device: GPUDevice;
    private readonly channels: Record<TextureKind, Channel>;
    private readonly texSampler: GPUSampler;

    constructor(device: GPUDevice, size = 1024, layerCount = 16) {
        this.device = device;
        this.size = size;
        this.layerCount = layerCount;
        this.channels = {
            albedo: this.createPlaceholder('albedo'),
            normal: this.createPlaceholder('normal'),
            roughness: this.createPlaceholder('roughness'),
            occlusion: this.createPlaceholder('occlusion'),
        };
        this.texSampler = device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'repeat',
            addressModeV: 'repeat',
        });
    }

    /**
     * 把一张贴图写进对应数组的一层，返回层号。同一张 Image（按对象身份）只占一层。
     *
     * 贴图尺寸必须等于数组尺寸：数组内各层共享 mip 链，尺寸不一致没法放进来。
     */
    public register(kind: TextureKind, image: Image): number {
        // 尺寸先校验：ensureChannel 会分配整块数组，尺寸不对时不该先占显存
        if (image.width !== this.size || image.height !== this.size) {
            throw new Error(
                `TextureSet: ${kind} texture is ${image.width}×${image.height}, ` + `expected ${this.size}×${this.size}`,
            );
        }
        const channel = this.ensureChannel(kind);
        const cached = channel.keys.get(image);
        if (cached !== undefined) return cached;
        if (channel.next >= this.layerCount) {
            throw new Error(
                `TextureSet: ${kind} array is full (${this.layerCount} layers); raise layerCount or share textures`,
            );
        }

        const layer = channel.next++;
        channel.keys.set(image, layer);
        this.uploadMips(channel, layer, image, ENCODE_SRGB[kind]);
        return layer;
    }

    public albedoView(): GPUTextureView {
        return this.channels.albedo.view;
    }

    public normalView(): GPUTextureView {
        return this.channels.normal.view;
    }

    public roughnessView(): GPUTextureView {
        return this.channels.roughness.view;
    }

    public occlusionView(): GPUTextureView {
        return this.channels.occlusion.view;
    }

    public sampler(): GPUSampler {
        return this.texSampler;
    }

    public destroy(): void {
        for (const kind of Object.keys(this.channels) as TextureKind[]) {
            this.channels[kind].texture.destroy();
        }
    }

    /**
     * 首次真正注册时才分配整块数组（1024² × 16 层 × mip 约 84 MB，四个通道合计 ~335 MB）。
     *
     * 给到 16 是因为「地面一套材质 + 摆几个 glTF 模型」这种组合场景里，
     * 每个模型自带漫反射/法线/粗糙度三张图，8 层只够放两个模型。
     */
    private ensureChannel(kind: TextureKind): Channel {
        const channel = this.channels[kind];
        if (channel.allocated) return channel;

        const mipLevelCount = Math.floor(Math.log2(this.size)) + 1;
        const texture = this.device.createTexture({
            size: { width: this.size, height: this.size, depthOrArrayLayers: this.layerCount },
            format: FORMAT[kind],
            mipLevelCount,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            label: `texture-set-${kind}`,
        });
        channel.texture.destroy();
        channel.texture = texture;
        channel.view = texture.createView({ dimension: '2d-array' });
        channel.allocated = true;
        return channel;
    }

    private createPlaceholder(kind: TextureKind): Channel {
        const texture = this.device.createTexture({
            size: { width: 1, height: 1, depthOrArrayLayers: 1 },
            format: FORMAT[kind],
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            label: `texture-set-${kind}-placeholder`,
        });
        const view = texture.createView({ dimension: '2d-array' });
        const rgb = PLACEHOLDER[kind];
        const texel = new Uint8Array(256);
        texel[0] = Math.round(rgb[0] * 255);
        texel[1] = Math.round(rgb[1] * 255);
        texel[2] = Math.round(rgb[2] * 255);
        texel[3] = 255;
        this.device.queue.writeTexture({ texture }, texel, { bytesPerRow: 256 }, { width: 1, height: 1 });
        return { texture, view, next: 1, allocated: false, keys: new Map() };
    }

    /** 逐级降采样并上传：每一级的数据都从上一级算，保证 mip 之间连续。 */
    private uploadMips(channel: Channel, layer: number, image: Image, srgb: boolean): void {
        let width = image.width;
        let height = image.height;
        let data = image.data;
        for (let level = 0; ; level++) {
            this.writeLevel(channel, layer, level, width, height, data, srgb);
            if (width === 1 && height === 1) break;
            const nextWidth = Math.max(1, width >> 1);
            const nextHeight = Math.max(1, height >> 1);
            data = downsample(data, width, height, nextWidth, nextHeight);
            width = nextWidth;
            height = nextHeight;
        }
    }

    private writeLevel(
        channel: Channel,
        layer: number,
        level: number,
        width: number,
        height: number,
        linear: Float32Array,
        srgb: boolean,
    ): void {
        const rowBytes = width * 4;
        // writeTexture 的 bytesPerRow 必须是 256 的倍数，小 mip 需要补行尾。
        const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
        const source = encodeRGBA8(linear, width * height, srgb);
        let bytes = source;
        if (bytesPerRow !== rowBytes) {
            bytes = new Uint8Array(bytesPerRow * height);
            for (let y = 0; y < height; y++) {
                bytes.set(source.subarray(y * rowBytes, (y + 1) * rowBytes), y * bytesPerRow);
            }
        }
        this.device.queue.writeTexture(
            { texture: channel.texture, mipLevel: level, origin: { x: 0, y: 0, z: layer } },
            bytes as any,
            { bytesPerRow, rowsPerImage: height },
            { width, height, depthOrArrayLayers: 1 },
        );
    }
}

/** 线性 RGB float → 8 位 RGBA。颜色贴图编码回 sRGB 交给硬件解码。 */
function encodeRGBA8(linear: Float32Array, pixels: number, srgb: boolean): Uint8Array {
    const out = new Uint8Array(pixels * 4);
    for (let i = 0; i < pixels; i++) {
        for (let c = 0; c < 3; c++) {
            const value = clamp01(linear[i * 3 + c]);
            const encoded = srgb ? linearToSRGB(value) : value;
            out[i * 4 + c] = Math.round(encoded * 255);
        }
        out[i * 4 + 3] = 255;
    }
    return out;
}

/** 2×2 盒式降采样，边缘夹取。输入/输出都是线性 RGB float。 */
function downsample(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
    const dst = new Float32Array(dw * dh * 3);
    for (let y = 0; y < dh; y++) {
        const y0 = Math.min(y * 2, sh - 1);
        const y1 = Math.min(y * 2 + 1, sh - 1);
        for (let x = 0; x < dw; x++) {
            const x0 = Math.min(x * 2, sw - 1);
            const x1 = Math.min(x * 2 + 1, sw - 1);
            const a = (y0 * sw + x0) * 3;
            const b = (y0 * sw + x1) * 3;
            const c = (y1 * sw + x0) * 3;
            const d = (y1 * sw + x1) * 3;
            const o = (y * dw + x) * 3;
            dst[o] = (src[a] + src[b] + src[c] + src[d]) * 0.25;
            dst[o + 1] = (src[a + 1] + src[b + 1] + src[c + 1] + src[d + 1]) * 0.25;
            dst[o + 2] = (src[a + 2] + src[b + 2] + src[c + 2] + src[d + 2]) * 0.25;
        }
    }
    return dst;
}

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}
