import type { Image } from '../ir/image';
import type { TextureKind } from '../ir/material';
import { loadImage } from './load-image';

/**
 * 材质贴图的解码与去重。
 *
 * PBRMaterial 的贴图字段是解码后的 Image，所以解码发生在导入器里 —— 也就是
 * 这里，用户代码在造材质时 await 它。同一张图（同 kind + 同 URL）只解码一次，
 * 返回同一个 Image 对象：TextureSet 按对象身份去重图层，重复解码会多占一层。
 *
 * 颜色贴图按 sRGB 解码，法线 / 粗糙度 / AO 保持原始数值。
 */

const IS_COLOR: Record<TextureKind, boolean> = {
    albedo: true,
    normal: false,
    roughness: false,
    occlusion: false,
};

const cache = new Map<string, Promise<Image>>();

export function loadTexture(url: string, kind: TextureKind, meters?: number): Promise<Image> {
    // 一格几米进缓存键：同一张图配不同的尺度，得是不同的 Image。
    const key = `${kind}:${url}:${meters ?? 1}`;
    let job = cache.get(key);
    if (!job) {
        job = loadImage(url, { srgb: IS_COLOR[kind], layout: 'texture', meters });
        cache.set(key, job);
    }
    return job;
}
