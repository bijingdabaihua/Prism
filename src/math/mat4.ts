import type { Vec3 } from './types';
import { normalize, cross, sub, dot } from './vec3';

/**
 * 4×4 matrix stored in column-major order (Float32Array).
 * Column-major = elements accessed as m[col * 4 + row].
 * This matches WGSL's default matrix layout.
 *
 * Layout:
 *   c0r0  c0r1  c0r2  c0r3
 *   c1r0  c1r1  c1r2  c1r3
 *   c2r0  c2r1  c2r2  c2r3
 *   c3r0  c3r1  c3r2  c3r3
 *
 * Index: m[col*4 + row]
 */
export class Mat4 {
    /** Create from flat column-major Float32Array */
    public static from(data: Float32Array): Mat4 {
        return new Mat4(new Float32Array(data));
    }

    /** Create a perspective projection matrix */
    public static perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
        const f = 1 / Math.tan(fovY / 2);
        const nf = 1 / (near - far);
        return new Mat4(
            new Float32Array([
                f / aspect,
                0,
                0,
                0,
                0,
                f,
                0,
                0,
                0,
                0,
                (far + near) * nf,
                -1,
                0,
                0,
                2 * far * near * nf,
                0,
            ]),
        );
    }

    /** Create a look-at view matrix */
    public static lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
        const f = normalize(sub(target, eye));
        const s = normalize(cross(f, up));
        const u = cross(s, f);

        return new Mat4(
            new Float32Array([
                s.x,
                u.x,
                -f.x,
                0,
                s.y,
                u.y,
                -f.y,
                0,
                s.z,
                u.z,
                -f.z,
                0,
                -dot(s, eye),
                -dot(u, eye),
                dot(f, eye),
                1,
            ]),
        );
    }

    private constructor(public data: Float32Array) {}

    /** Multiply this * b. Returns a new matrix. */
    public multiply(b: Mat4): Mat4 {
        const a = this.data;
        const d = b.data;
        const out = new Float32Array(16);
        for (let col = 0; col < 4; col++) {
            for (let row = 0; row < 4; row++) {
                out[col * 4 + row] =
                    a[0 * 4 + row] * d[col * 4 + 0] +
                    a[1 * 4 + row] * d[col * 4 + 1] +
                    a[2 * 4 + row] * d[col * 4 + 2] +
                    a[3 * 4 + row] * d[col * 4 + 3];
            }
        }
        return new Mat4(out);
    }

    /** Invert. Returns identity if matrix is singular. */
    public invert(): Mat4 {
        const m = this.data;
        const out = new Float32Array(16);

        const a00 = m[0],
            a01 = m[1],
            a02 = m[2],
            a03 = m[3];
        const a10 = m[4],
            a11 = m[5],
            a12 = m[6],
            a13 = m[7];
        const a20 = m[8],
            a21 = m[9],
            a22 = m[10],
            a23 = m[11];
        const a30 = m[12],
            a31 = m[13],
            a32 = m[14],
            a33 = m[15];

        const b00 = a00 * a11 - a01 * a10;
        const b01 = a00 * a12 - a02 * a10;
        const b02 = a00 * a13 - a03 * a10;
        const b03 = a01 * a12 - a02 * a11;
        const b04 = a01 * a13 - a03 * a11;
        const b05 = a02 * a13 - a03 * a12;
        const b06 = a20 * a31 - a21 * a30;
        const b07 = a20 * a32 - a22 * a30;
        const b08 = a20 * a33 - a23 * a30;
        const b09 = a21 * a32 - a22 * a31;
        const b10 = a21 * a33 - a23 * a31;
        const b11 = a22 * a33 - a23 * a32;

        const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
        if (Math.abs(det) < 1e-12) return Mat4.identity();

        const invDet = 1 / det;
        out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * invDet;
        out[1] = (-a01 * b11 + a02 * b10 - a03 * b09) * invDet;
        out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * invDet;
        out[3] = (-a21 * b05 + a22 * b04 - a23 * b03) * invDet;
        out[4] = (-a10 * b11 + a12 * b08 - a13 * b07) * invDet;
        out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * invDet;
        out[6] = (-a30 * b05 + a32 * b02 - a33 * b01) * invDet;
        out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * invDet;
        out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * invDet;
        out[9] = (-a00 * b10 + a01 * b08 - a03 * b06) * invDet;
        out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * invDet;
        out[11] = (-a20 * b04 + a21 * b02 - a23 * b00) * invDet;
        out[12] = (-a10 * b09 + a11 * b07 - a12 * b06) * invDet;
        out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * invDet;
        out[14] = (-a30 * b03 + a31 * b01 - a32 * b00) * invDet;
        out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * invDet;

        return new Mat4(out);
    }

    /** Get the raw Float32Array (column-major) */
    public raw(): Float32Array {
        return this.data;
    }

    /** Create an identity matrix */
    private static identity(): Mat4 {
        return new Mat4(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
    }
}
