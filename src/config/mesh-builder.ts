import type { Vec3 } from '../math/types';
import type { PBRMaterial } from '../ir/material';
import { Mesh } from '../ir/mesh';
import { sub, dot, cross, normalize } from '../math/vec3';

/** 贴图坐标（米）：顶点的 u/v = 到原点的位移在这两根轴上的投影。 */
export interface UvProjection {
    origin: Vec3;
    /** 单位向量：贴图的 u 方向 */
    uAxis: Vec3;
    /** 单位向量：贴图的 v 方向 */
    vAxis: Vec3;
}

/**
 * 程序化场景：不经过任何文件，直接在代码里构造 Scene IR。
 *
 * 用它当渲染管线的基准场景 —— 画面不对时可以直接排除 OBJ 解析。
 */
export class MeshBuilder {
    private positions: number[] = [];
    private normals: number[] = [];
    private uvs: number[] = [];
    private tangents: number[] = [];
    private indices: number[] = [];
    private triMaterials: number[] = [];
    private vertexCount = 0;

    /**
     * 四边形。UV 以**米**为单位（沿 a→b 和面内垂直方向），
     * 所以贴图的重复次数只由贴图自己的一格几米（`Image.meters`）决定，与四边形多大无关 ——
     * 一面 8 m 的墙和一块 1 m 的面用同一个材质，贴图密度是连续的。
     *
     * `uv` 给了就改用给定的投影取坐标。默认的「沿边」在折起来的面上会换轴：
     * 地面折成土坡那一刻，贴图方向跟着折 90°，图案在缝上错位。
     */
    public addQuad(
        corners: [Vec3, Vec3, Vec3, Vec3],
        material: number,
        uv?: UvProjection,
    ): void {
        const [a, b, c, d] = corners;
        const e1 = sub(b, a);
        const e2 = sub(c, a);
        const n = normalize(cross(e1, e2));
        const t = normalize(e1);
        const bitangent = cross(n, t);
        const from = uv?.origin ?? a;
        const uAxis = uv?.uAxis ?? t;
        const vAxis = uv?.vAxis ?? bitangent;
        const base = this.vertexCount;
        for (const p of [a, b, c, d]) {
            const offset = sub(p, from);
            this.pushVertex(p, n, dot(offset, uAxis), dot(offset, vAxis), t);
        }
        this.pushTriangle(base, base + 1, base + 2, material);
        this.pushTriangle(base, base + 2, base + 3, material);
    }

    /**
     * 轴对齐立方体：中心在原点，边长 size（米），六个面各一个四边形。
     *
     * 只用来做占位 / 管线自检 —— 一个没有贴图的盒子，光照、阴影、法线
     * 是不是对的，一眼就能看出来。
     */
    public addBox(size: number, material: number): void {
        const h = size * 0.5;
        const v = (x: number, y: number, z: number): Vec3 => ({ x: x * h, y: y * h, z: z * h });
        // 每个面的顶点顺序保证 cross(b-a, c-a) 朝向盒子外侧
        const faces: [Vec3, Vec3, Vec3, Vec3][] = [
            [v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1)],
            [v(1, -1, -1), v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1)],
            [v(1, -1, 1), v(1, -1, -1), v(1, 1, -1), v(1, 1, 1)],
            [v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1), v(-1, 1, -1)],
            [v(-1, 1, 1), v(1, 1, 1), v(1, 1, -1), v(-1, 1, -1)],
            [v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1)],
        ];
        for (const face of faces) this.addQuad(face, material);
    }

    public build(materials: readonly PBRMaterial[], name?: string): Mesh {
        const vertexData = new Float32Array(this.vertexCount * 12);
        for (let i = 0; i < this.vertexCount; i++) {
            const o = i * 12;
            vertexData[o] = this.positions[i * 3];
            vertexData[o + 1] = this.positions[i * 3 + 1];
            vertexData[o + 2] = this.positions[i * 3 + 2];
            vertexData[o + 3] = this.normals[i * 3];
            vertexData[o + 4] = this.normals[i * 3 + 1];
            vertexData[o + 5] = this.normals[i * 3 + 2];
            vertexData[o + 6] = this.uvs[i * 2];
            vertexData[o + 7] = this.uvs[i * 2 + 1];
            vertexData[o + 8] = this.tangents[i * 4];
            vertexData[o + 9] = this.tangents[i * 4 + 1];
            vertexData[o + 10] = this.tangents[i * 4 + 2];
            vertexData[o + 11] = this.tangents[i * 4 + 3];
        }

        const triCount = this.indices.length / 3;
        const triangleData = new Uint32Array(triCount * 4);
        for (let t = 0; t < triCount; t++) {
            const o = t * 4;
            triangleData[o] = this.indices[t * 3];
            triangleData[o + 1] = this.indices[t * 3 + 1];
            triangleData[o + 2] = this.indices[t * 3 + 2];
            triangleData[o + 3] = this.triMaterials[t];
        }

        return new Mesh(vertexData, triangleData, materials, name);
    }

    private pushVertex(p: Vec3, n: Vec3, u: number, v: number, t: Vec3): void {
        this.positions.push(p.x, p.y, p.z);
        this.normals.push(n.x, n.y, n.z);
        this.uvs.push(u, v);
        this.tangents.push(t.x, t.y, t.z, 1);
        this.vertexCount++;
    }

    private pushTriangle(a: number, b: number, c: number, material: number): void {
        this.indices.push(a, b, c);
        this.triMaterials.push(material);
    }
}
