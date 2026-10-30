// Basic types

export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

export interface Color {
    r: number;
    g: number;
    b: number;
    a?: number;
}

export interface AABB {
    min: Vec3;
    max: Vec3;
}
