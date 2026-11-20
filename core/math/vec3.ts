import type { Vec3 } from './types';

export function vec3(x: number, y: number, z: number): Vec3 {
    return { x, y, z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(v: Vec3, s: number): Vec3 {
    return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
    return {
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x,
    };
}

export function length(v: Vec3): number {
    return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/** 零长度输入返回零向量，不产生 NaN。 */
export function normalize(v: Vec3): Vec3 {
    const len = length(v);
    if (len < 1e-12) return { x: 0, y: 0, z: 0 };
    return scale(v, 1 / len);
}
