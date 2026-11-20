export function srgbToLinear(x: number): number {
    if (x <= 0.04045) return x / 12.92;
    return Math.pow((x + 0.055) / 1.055, 2.4);
}

export function linearToSRGB(x: number): number {
    if (x <= 0.0) return 0.0;
    if (x <= 0.0031308) return x * 12.92;
    return 1.055 * Math.pow(x, 1.0 / 2.4) - 0.055;
}
