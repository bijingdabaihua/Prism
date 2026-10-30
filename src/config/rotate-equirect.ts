import type { Image } from '../ir/image';

/**
 * 把环境图绕 +y 轴转 angle 弧度：等距柱状图沿经度整体平移。
 *
 * 渲染器的方位角约定是 φ = atan2(z, x)，φ = 0 指向 +x、向 +z 增大。
 * 正 angle 会让图里的特征（太阳、地平线上的亮区）向 φ 减小的方向移动。
 * 例：太阳在 φ = 36° 的 HDR，转 +0.632 之后太阳就落在 +x 方向上。
 *
 * 这是给场景作者对齐太阳用的：房间是正南正北的，HDR 的太阳未必。
 * 亮度 CDF 由旋转后的图重新构建，采样和 pdf 仍然自洽，不引入任何偏差。
 */
export function rotateEquirect(image: Image, angle: number): Image {
    if (image.layout !== 'equirect') {
        throw new Error(`rotateEquirect: expected an equirect image, got "${image.layout}"`);
    }
    const width = image.width;
    const height = image.height;
    const shift = Math.round((angle / (2 * Math.PI)) * width);
    const k = ((shift % width) + width) % width;
    if (k === 0) return image;

    const src = image.data;
    const out = new Float32Array(src.length);
    const rowFloats = width * 3;
    const split = k * 3;
    for (let y = 0; y < height; y++) {
        const row = y * rowFloats;
        // 输出列 x 取输入列 x + k
        out.set(src.subarray(row + split, row + rowFloats), row);
        out.set(src.subarray(row, row + split), row + rowFloats - split);
    }
    return { ...image, data: out };
}
