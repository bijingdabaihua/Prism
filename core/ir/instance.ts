import type { Vec3 } from '../math/types';
import type { Mesh } from './mesh';

export const INST_FLOATS = 36;

const IDENTITY_MAT4: Readonly<Float32Array> = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * Instance IR：一个 mesh 的一次摆放。
 *
 * 同一个 mesh 可以被多个 instance 引用 —— BLAS 应该按 mesh 共享，
 * 而不是每个 instance 复制一份。
 *
 * 逆矩阵是派生数据，打包时现算（engine/model/model.ts），不存进 IR。
 */
export class Instance {
    public transform: Float32Array;
    public readonly mesh: Mesh;

    constructor(mesh: Mesh, transform?: Float32Array) {
        this.mesh = mesh;
        this.transform = transform ? new Float32Array(transform) : new Float32Array(IDENTITY_MAT4);
    }

    /**
     * 演化：让 mesh 把材质上的位移贴图消耗掉，返回可以直接进渲染的 instance。
     *
     * 没有位移的 mesh 原样返回（`===` 自己），变换照抄；演化结果缓存在 mesh 上，
     * 所以同一个 mesh 摆很多次也只算一遍、共用一棵 BLAS。
     */
    public evolve(): Instance {
        const mesh = this.mesh.evolve();
        return mesh === this.mesh ? this : new Instance(mesh, this.transform);
    }

    public getBounds(): { min: Vec3; max: Vec3 } {
        const b = this.mesh.bounds;
        const t = this.transform;
        const corners = [
            { x: b.min.x, y: b.min.y, z: b.min.z },
            { x: b.max.x, y: b.min.y, z: b.min.z },
            { x: b.min.x, y: b.max.y, z: b.min.z },
            { x: b.max.x, y: b.max.y, z: b.min.z },
            { x: b.min.x, y: b.min.y, z: b.max.z },
            { x: b.max.x, y: b.min.y, z: b.max.z },
            { x: b.min.x, y: b.max.y, z: b.max.z },
            { x: b.max.x, y: b.max.y, z: b.max.z },
        ];
        let minX = Infinity,
            minY = Infinity,
            minZ = Infinity;
        let maxX = -Infinity,
            maxY = -Infinity,
            maxZ = -Infinity;
        for (const c of corners) {
            const x = t[0] * c.x + t[4] * c.y + t[8] * c.z + t[12];
            const y = t[1] * c.x + t[5] * c.y + t[9] * c.z + t[13];
            const z = t[2] * c.x + t[6] * c.y + t[10] * c.z + t[14];
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
        }
        return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
    }
}
