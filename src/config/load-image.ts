import type { Image } from '../ir/image';
import { srgbToLinear } from '../math/color';

/**
 * 图像导入器：文件 → Image IR。
 *
 * 这一层是**唯一**允许知道「.exr / .hdr / .png」存在的地方。
 * 它上方（Background / 渲染器）看到的只有 Image，下方才是具体格式的解码细节。
 *
 * 因此：新增一种格式 = 加一个 decodeXxx + 在 sniff 里认一下 magic，
 * 渲染层一行不动。
 */

export interface ImageOptions {
    /**
     * 位图是否按 sRGB 解码成线性。颜色贴图为 true（默认）；
     * 法线、粗糙度这类**数据贴图**必须为 false —— 它们的数值不是颜色，
     * 做一次 sRGB 解码会把粗糙度整体压暗，材质看起来会偏黑偏亮。
     */
    srgb?: boolean;
    /** 输出用途。环境图是 equirect，材质贴图是 texture。 */
    layout?: 'equirect' | 'texture';
    /** 一格贴图覆盖的真实尺寸（米），见 `Image.meters`。 */
    meters?: number;
}

export async function loadImage(url: string, options?: ImageOptions): Promise<Image> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to load ${url} (${resp.status})`);
    const image = await decodeImage(await resp.arrayBuffer(), options);
    return {
        ...image,
        layout: options?.layout ?? image.layout,
        meters: options?.meters ?? image.meters,
    };
}

/** 按 magic bytes 判断格式，不看扩展名——URL 怎么起名不影响解码。 */
function sniff(buf: ArrayBuffer): 'exr' | 'hdr' | 'bitmap' {
    const b = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
    // OpenEXR: 0x76 0x2f 0x31 0x01
    if (b.length >= 4 && b[0] === 0x76 && b[1] === 0x2f && b[2] === 0x31 && b[3] === 0x01) {
        return 'exr';
    }
    // Radiance HDR: "#?"
    if (b.length >= 2 && b[0] === 0x23 && b[1] === 0x3f) {
        return 'hdr';
    }
    return 'bitmap';
}

export async function decodeImage(buf: ArrayBuffer, options?: ImageOptions): Promise<Image> {
    switch (sniff(buf)) {
        case 'exr':
            return decodeEXR(buf);
        case 'hdr':
            return decodeHDR(buf);
        default:
            return decodeBitmap(buf, options?.srgb ?? true);
    }
}

// OpenEXR —— 用 three 的解码器，约定输出 Float32 RGBA

async function decodeEXR(buf: ArrayBuffer): Promise<Image> {
    const [{ EXRLoader }, { FloatType }] = await Promise.all([
        import('three/examples/jsm/loaders/EXRLoader.js'),
        import('three'),
    ]);

    const loader = new EXRLoader();
    loader.setDataType(FloatType as never);

    const objectUrl = URL.createObjectURL(new Blob([buf]));
    let texture: { image: { width: number; height: number; data: Float32Array }; dispose(): void };
    try {
        texture = await new Promise((resolve, reject) => {
            loader.load(objectUrl, resolve as never, undefined, reject);
        });
    } finally {
        URL.revokeObjectURL(objectUrl);
    }

    const { width, height, data } = texture.image;
    texture.dispose();

    // three 可能给 RGB 也可能给 RGBA，按实际长度判通道数
    const channels = data.length / (width * height);
    const rgb = new Float32Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
        rgb[i * 3] = data[i * channels];
        rgb[i * 3 + 1] = data[i * channels + 1];
        rgb[i * 3 + 2] = data[i * channels + 2];
    }
    return { width, height, data: rgb, layout: 'equirect' };
}

// Radiance HDR (.hdr) —— RGBE / 新式扫描线 RLE

function decodeHDR(buf: ArrayBuffer): Image {
    const bytes = new Uint8Array(buf);
    let pos = 0;

    const readLine = (): string => {
        let s = '';
        while (pos < bytes.length && bytes[pos] !== 0x0a) s += String.fromCharCode(bytes[pos++]);
        pos++;
        return s;
    };

    const magic = readLine();
    if (magic !== '#?RADIANCE' && magic !== '#?RGBE') throw new Error('Not a Radiance HDR file');

    let format = '';
    for (;;) {
        const line = readLine();
        if (line === '') break;
        if (line.startsWith('FORMAT=')) format = line.slice(7).trim();
        if (pos >= bytes.length) throw new Error('Truncated HDR header');
    }
    if (format !== '' && format !== '32-bit_rle_rgbe') {
        throw new Error(`Unsupported HDR format: ${format}`);
    }

    // 分辨率行，形如 "-Y 1024 +X 2048"
    const res = readLine().trim().split(/\s+/);
    if (res.length !== 4) throw new Error(`Bad HDR resolution line: "${res.join(' ')}"`);
    const [axisY, hStr, axisX, wStr] = res;
    const height = parseInt(hStr, 10);
    const width = parseInt(wStr, 10);
    if (!(width > 0 && height > 0)) throw new Error(`Bad HDR size: ${width}x${height}`);

    const rgbe = new Uint8Array(width * height * 4);
    const scanline = new Uint8Array(width * 4);
    const yStart = axisY === '-Y' ? 0 : height - 1;
    const yStep = axisY === '-Y' ? 1 : -1;
    const yIndex = (row: number) => yStart + row * yStep;

    for (let row = 0; row < height; row++) {
        const isNewRLE =
            pos + 4 <= bytes.length &&
            bytes[pos] === 2 &&
            bytes[pos + 1] === 2 &&
            ((bytes[pos + 2] << 8) | bytes[pos + 3]) === width &&
            width >= 8 &&
            width < 32768;

        if (isNewRLE) {
            pos += 4;
            // 4 个通道各自做 RLE
            for (let c = 0; c < 4; c++) {
                let x = 0;
                while (x < width) {
                    let count = bytes[pos++];
                    if (count > 128) {
                        count -= 128;
                        const v = bytes[pos++];
                        if (count === 0 || x + count > width) throw new Error('Corrupt HDR RLE');
                        for (let i = 0; i < count; i++) scanline[(x + i) * 4 + c] = v;
                    } else {
                        if (count === 0 || x + count > width) throw new Error('Corrupt HDR RLE');
                        for (let i = 0; i < count; i++) scanline[(x + i) * 4 + c] = bytes[pos++];
                    }
                    x += count;
                }
            }
        } else {
            // 旧式平铺。旧式 (1,1,1,n) 运行长度编码未支持——现代导出器已不使用。
            if (pos + width * 4 > bytes.length) throw new Error('Truncated HDR scanline');
            scanline.set(bytes.subarray(pos, pos + width * 4));
            pos += width * 4;
        }

        const base = yIndex(row) * width * 4;
        if (axisX === '-X') {
            for (let x = 0; x < width; x++) {
                const src = (width - 1 - x) * 4;
                rgbe.set(scanline.subarray(src, src + 4), base + x * 4);
            }
        } else {
            rgbe.set(scanline, base);
        }
    }

    // RGBE → 线性浮点
    const data = new Float32Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
        const e = rgbe[i * 4 + 3];
        if (e === 0) continue;
        const f = Math.pow(2, e - 136); // 2^(e-128) / 256
        data[i * 3] = (rgbe[i * 4] + 0.5) * f;
        data[i * 3 + 1] = (rgbe[i * 4 + 1] + 0.5) * f;
        data[i * 3 + 2] = (rgbe[i * 4 + 2] + 0.5) * f;
    }
    return { width, height, data, layout: 'equirect' };
}

// 位图 (PNG / JPEG / WebP …) —— 8 位，srgb=true 时解码到线性

async function decodeBitmap(buf: ArrayBuffer, srgb: boolean): Promise<Image> {
    const bitmap = await createImageBitmap(new Blob([buf]), { colorSpaceConversion: 'none' });
    const { width, height } = bitmap;

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    bitmap.close();

    const data = new Float32Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
        const r = rgba[i * 4] / 255;
        const g = rgba[i * 4 + 1] / 255;
        const b = rgba[i * 4 + 2] / 255;
        data[i * 3] = srgb ? srgbToLinear(r) : r;
        data[i * 3 + 1] = srgb ? srgbToLinear(g) : g;
        data[i * 3 + 2] = srgb ? srgbToLinear(b) : b;
    }
    return { width, height, data, layout: 'equirect' };
}
