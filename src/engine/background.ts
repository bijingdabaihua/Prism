import type { Image } from '../ir/image';

/**
 * 环境光照的 GPU 侧。
 *
 * 只认 Image IR —— 不知道 URL，也不知道源文件是 .exr 还是 .hdr。
 * 产物是一张带 mip 链的 envMap 纹理（光线 miss 时直接取）和一份亮度 CDF
 * （环境 NEE 按亮度采样方向，避免萤火虫）。
 *
 * 为什么要 mip：路径追踪没有屏幕空间导数，`textureSample` 用不了，只能显式给
 * LOD。没有 mip 时每个逃进环境的光线只取一个纹素 —— 光滑表面的反射瓣落在这张
 * 2k 点云上，相邻样本在亮暗之间跳，表现是釉面上一层彩色颗粒。mip 链让 BSDF
 * 侧能按粗糙度取一个已经按瓣宽平均过的值（见 shade.wgsl 的 env_radiance_rough）。
 *
 * 格式用 rgba16float 而不是 rgba32float：WebGPU 里 f16 默认可过滤，f32 的可
 * 过滤性是要单独申请的设备特性。半浮点的范围（65504）对 HDRI 绰绰有余，太阳
 * 也就几千。
 *
 * 一个 Engine 只装一个场景，所以 setImage() 只调用一次，纹理和 CDF 在这一
 * 次里直接建好 —— 没有「待上传」状态，也没有重建路径。
 *
 * 没有「没有环境图」这个状态：Scene.env 是必填的，构造时也不预留占位图，
 * setImage 之前就是还没有。`hasEnvironment()` 同时是「整个场景已就绪」的
 * 信号 —— Engine.setScene 最后才调它。
 */
export class Background {
    private envMapTex: GPUTexture | null = null;
    private envMapTexView: GPUTextureView | null = null;
    /** 亮度 CDF（打包布局见文件末尾的 buildEnvDistribution），供环境 NEE 使用。 */
    private envDistBuf: GPUBuffer | null = null;
    private readonly device: GPUDevice;

    constructor(device: GPUDevice) {
        this.device = device;
    }

    /** 编译环境图 —— 整个生命周期只调用一次。 */
    public setImage(image: Image): void {
        if (this.envMapTex) throw new Error('Background: setImage 只能调用一次 —— 换场景请换 Engine');
        if (image.layout !== 'equirect') {
            throw new Error(`Unsupported environment layout: ${image.layout}`);
        }
        const { tex, view, dist } = this.build(image);
        this.envMapTex = tex;
        this.envMapTexView = view;
        this.envDistBuf = dist;
    }

    /**
     * 是否已经有一张环境图可用。
     *
     * 场景在引擎创建之后才异步加载，那之前的帧没有任何光照 —— bind group
     * 建不起来，PathTracePass 用这个判断要不要跳过这一帧。
     */
    public hasEnvironment(): boolean {
        return this.envMapTexView !== null;
    }

    public envMapView(): GPUTextureView {
        if (!this.envMapTexView) {
            throw new Error('Background: environment map is not available yet');
        }
        return this.envMapTexView;
    }

    public envDistributionBuffer(): GPUBuffer {
        if (!this.envDistBuf) {
            throw new Error('Background: environment distribution is not available (destroyed?)');
        }
        return this.envDistBuf;
    }

    public destroy(): void {
        this.envMapTex?.destroy();
        this.envMapTexView = null;
        this.envDistBuf?.destroy();
        this.envMapTex = null;
        this.envDistBuf = null;
    }

    private build(image: Image): EnvResources {
        // 存线性 HDR：Image.data 本身就是线性 RGB，直接上传，不做任何色调映射。
        // 显示编码只在 display pass 的最后一步发生。
        return this.buildFromImage(image, 'env-map');
    }

    private buildFromImage(image: Image, label: string): EnvResources {
        const mips = buildEnvMips(image);
        const tex = this.createTex(image.width, image.height, mips.length, label);
        try {
            const view = tex.createView();
            this.writeTex(tex, mips);
            const dist = this.createDistribution(image);
            return { tex, view, dist };
        } catch (err) {
            // 构建到一半失败时清掉已分配的资源，避免泄漏。
            tex.destroy();
            throw err;
        }
    }

    /** 亮度 CDF → storage buffer（shader 里按 array<f32> 直接用）。 */
    private createDistribution(image: Image): GPUBuffer {
        const { data } = buildEnvDistribution(image);
        const buffer = this.device.createBuffer({
            size: data.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: 'env-distribution',
        });
        try {
            this.device.queue.writeBuffer(buffer, 0, data as GPUAllowSharedBufferSource);
        } catch (err) {
            buffer.destroy();
            throw err;
        }
        return buffer;
    }

    private createTex(width: number, height: number, mipLevels: number, label: string): GPUTexture {
        return this.device.createTexture({
            size: { width, height },
            format: 'rgba16float',
            mipLevelCount: mipLevels,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            label,
        });
    }

    private writeTex(tex: GPUTexture, mips: EnvMip[]): void {
        for (let level = 0; level < mips.length; level++) {
            const { width, height, data } = mips[level]!;
            const tightRow = width * 8; // rgba16float：8 字节一个纹素
            // bytesPerRow 必须 256 字节对齐，1×1、2×2 这些尾部 mip 行宽不够要补。
            const bytesPerRow = Math.ceil(tightRow / 256) * 256;
            const tight = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            let source = tight;
            if (bytesPerRow !== tightRow) {
                source = new Uint8Array(bytesPerRow * height);
                for (let y = 0; y < height; y++) {
                    source.set(tight.subarray(y * tightRow, (y + 1) * tightRow), y * bytesPerRow);
                }
            }
            this.device.queue.writeTexture(
                { texture: tex, mipLevel: level },
                source as GPUAllowSharedBufferSource,
                { bytesPerRow, rowsPerImage: height },
                { width, height },
            );
        }
    }
}

interface EnvResources {
    tex: GPUTexture;
    view: GPUTextureView;
    dist: GPUBuffer;
}

/** 一级 mip：rgba16float，行紧排（补对齐在 writeTex 里做）。 */
interface EnvMip {
    width: number;
    height: number;
    data: Uint16Array;
}

/**
 * 环境图 mip 链：逐级 2×2 盒式降采样，直到 1×1。
 *
 * 等距柱状投影里第 y 行覆盖的立体角 ∝ sinθ，所以四个 tap 各按自己那一行的
 * sinθ 加权 —— 直接平均会让两极的行被多算，反射里的天顶会偏亮。
 * 横向是等角的，直接环绕取两个（x 方向越界就是绕回另一侧，不是夹边）。
 *
 * 一段 mip 的模糊半径对应 BSDF 瓣宽，查表公式见 shade.wgsl 的
 * env_radiance_rough —— 这里只负责把图按正确的面积权重铺好。
 */
function buildEnvMips(image: Image): EnvMip[] {
    let width = image.width;
    let height = image.height;
    let current = new Float32Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
        current[i * 3] = image.data[i * 3]!;
        current[i * 3 + 1] = image.data[i * 3 + 1]!;
        current[i * 3 + 2] = image.data[i * 3 + 2]!;
    }

    const mips: EnvMip[] = [encodeLevel(current, width, height)];
    while (width > 1 || height > 1) {
        const nextWidth = Math.max(1, width >> 1);
        const nextHeight = Math.max(1, height >> 1);
        const next = new Float32Array(nextWidth * nextHeight * 3);
        for (let y = 0; y < nextHeight; y++) {
            const y0 = Math.min(y * 2, height - 1);
            const y1 = Math.min(y * 2 + 1, height - 1);
            const w0 = Math.max(Math.sin((Math.PI * (y0 + 0.5)) / height), 1e-6);
            const w1 = Math.max(Math.sin((Math.PI * (y1 + 0.5)) / height), 1e-6);
            const inv = 1 / (2 * (w0 + w1));
            for (let x = 0; x < nextWidth; x++) {
                const x0 = (x * 2) % width;
                const x1 = (x * 2 + 1) % width;
                const i00 = (y0 * width + x0) * 3;
                const i01 = (y0 * width + x1) * 3;
                const i10 = (y1 * width + x0) * 3;
                const i11 = (y1 * width + x1) * 3;
                const o = (y * nextWidth + x) * 3;
                for (let c = 0; c < 3; c++) {
                    next[o + c] =
                        (current[i00 + c]! * w0 +
                            current[i01 + c]! * w0 +
                            current[i10 + c]! * w1 +
                            current[i11 + c]! * w1) *
                        inv;
                }
            }
        }
        mips.push(encodeLevel(next, nextWidth, nextHeight));
        current = next;
        width = nextWidth;
        height = nextHeight;
    }
    return mips;
}

/** 线性 RGB → rgba16float（alpha 补 1）。 */
function encodeLevel(rgb: Float32Array, width: number, height: number): EnvMip {
    const data = new Uint16Array(width * height * 4);
    for (let i = 0, n = width * height; i < n; i++) {
        data[i * 4] = toHalf(rgb[i * 3]!);
        data[i * 4 + 1] = toHalf(rgb[i * 3 + 1]!);
        data[i * 4 + 2] = toHalf(rgb[i * 3 + 2]!);
        data[i * 4 + 3] = 0x3c00; // 1.0
    }
    return { width, height, data };
}

/**
 * float32 → float16（就近舍入）。
 *
 * 先夹到半浮点的有限范围：环境图里的太阳偶尔会超过 65504，转成 Inf 会把
 * 整条路径的辐射度污染成 NaN。
 */
const halfBits = new Uint32Array(1);
const halfValue = new Float32Array(halfBits.buffer);
function toHalf(value: number): number {
    halfValue[0] = Math.min(Math.max(value, -65504), 65504);
    const x = halfBits[0]!;
    const sign = (x >>> 16) & 0x8000;
    const exponent = (x >>> 23) & 0xff;
    let mantissa = x & 0x7fffff;
    let e = exponent - 127 + 15;
    if (e >= 0x1f) return sign | 0x7c00;
    if (e <= 0) {
        if (e < -10) return sign;
        mantissa |= 0x800000;
        const shift = 14 - e;
        return sign | ((mantissa >>> shift) + ((mantissa >>> (shift - 1)) & 1));
    }
    let m = (mantissa >>> 13) + ((mantissa >>> 12) & 1);
    if (m === 0x400) {
        m = 0;
        e += 1;
        if (e >= 0x1f) return sign | 0x7c00;
    }
    return sign | (e << 10) | m;
}

// 亮度 CDF

/**
 * 环境图的重要性采样分布 —— 纯 CPU，不碰 GPU。
 *
 * 光线打不中场景时直接取环境图是正确但有巨大方差的：太阳只占环境图
 * 几个像素，余弦采样的光子偶尔命中它，贡献被 pdf 放大成萤火虫。
 * 这里为环境方向预先烘焙一张二维 CDF，让 NEE 能按亮度直接采到太阳。
 *
 * 采样分布：像素权重 = 亮度 × sinθ（等距柱状投影里每行覆盖的立体角
 * 正比于 sinθ）。行内归一化后，边缘 CDF 再按行权重重归一化。
 *
 * 打包布局（单个 Float32Array，直接对应 shader 里的 array<f32>）：
 *
 *   [0, height*(width+1))        条件 CDF，每行 width+1 个，行内归一化到 1
 *   [height*(width+1), +height+1) 边缘 CDF，归一化到 1
 */
interface EnvDistribution {
    readonly width: number;
    readonly height: number;
    /** 边缘 CDF 在 data 中的起始下标 = height * (width + 1) */
    readonly marginalOffset: number;
    readonly data: Float32Array;
}

function buildEnvDistribution(image: Image): EnvDistribution {
    const w = image.width;
    const h = image.height;
    const stride = w + 1;
    const marginalOffset = h * stride;
    const data = new Float32Array(marginalOffset + h + 1);
    const src = image.data;

    const rowWeights = new Float64Array(h);
    let total = 0;

    for (let y = 0; y < h; y++) {
        // 图像第 0 行是顶部，uv.y = (y + 0.5) / h；shader 里 uv.y = 1 - theta/π，
        // 所以这一行的像素中心对应 theta = π * (1 - (y + 0.5) / h)。
        const theta = Math.PI * (1 - (y + 0.5) / h);
        const sinTheta = Math.max(Math.sin(theta), 0);
        const base = y * stride;
        let acc = 0;
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 3;
            const lum = 0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2];
            acc += Math.max(lum, 0) * sinTheta;
            data[base + x + 1] = acc;
        }
        rowWeights[y] = acc;
        total += acc;
    }

    if (total <= 0) {
        // 全黑环境：没有可采样的方向，退化成均匀分布（pdf 仍然是有限值，
        // 不会让 NEE 除零）。
        for (let y = 0; y < h; y++) {
            const base = y * stride;
            for (let x = 0; x < w; x++) data[base + x + 1] = x + 1;
            rowWeights[y] = 1;
        }
        total = h;
    }

    // 行内归一化到 1。全零行（纯黑）的权重为 0，边缘 CDF 永远不会选中它，
    // 但归一化时仍要避免 0 * Infinity = NaN。
    for (let y = 0; y < h; y++) {
        const base = y * stride;
        const rw = rowWeights[y];
        const inv = rw > 0 ? 1 / rw : 0;
        for (let x = 1; x <= w; x++) data[base + x] *= inv;
    }

    let acc = 0;
    for (let y = 0; y < h; y++) {
        acc += rowWeights[y];
        data[marginalOffset + y + 1] = acc / total;
    }

    return { width: w, height: h, marginalOffset, data };
}
