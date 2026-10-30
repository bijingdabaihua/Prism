import type { AABB } from '../math/types';
import type { PBRMaterial } from './material';
import type { Image } from './image';

/**
 * 材质上的位移拆成两份：图 + 两个刻度（零点、每格几米）。格距不用给 —— 它由图自己定。
 *
 * 图上一个 texel 覆盖 `meters / width` 米，取它当细分格距：再多切就是采同一个
 * texel 好几遍（白烧三角形），再少切就是把几个 texel 压进一格（混叠成尖刺）。
 *
 * 图在进这里之前要先降到网格采得住的分辨率（`prepareHeightImage`）。这一步
 * 放在这里而不是材质加载时：降多细取决于「有几块三角形要切」，材质不知道。
 */
interface Displacement {
    image: Image;
    /** 高度零点，见 `PBRMaterial.displacementMid`。 */
    mid: number;
    /** 高度刻度（米），见 `PBRMaterial.displacementScale`。 */
    scale: number;
    /** 细分格距（米）= 图上一个 texel 的边长。 */
    cell: number;
}

function displacementOf(material: PBRMaterial): Displacement | undefined {
    const image = material.displacement;
    if (!image) return undefined;
    const { displacementMid: mid, displacementScale: scale } = material;
    if (mid === undefined || scale === undefined) {
        throw new Error('材质给了位移贴图，就必须给 displacementMid 和 displacementScale');
    }
    const prepared = prepareHeightImage(image);
    return { image: prepared, mid, scale, cell: (prepared.meters ?? 1) / prepared.width };
}

// 位移高度场

/**
 * 位移贴图 → 网格用的高度场：先降一次采样，再交给几何。
 *
 * 网格格距取的是**降采样之后**一个 texel 的边长（见 `displacementOf`），所以
 * 这一步决定了网格有多密。原图直接上会有两个问题：扫描噪点、JPEG 块比网格
 * 还细，会被当成真实起伏抽成尖刺；而网格密度翻倍则纯粹是白烧三角形。
 * 降一半之后，一个 texel 正好一格。
 *
 * 要降到多细取决于「有几块三角形要切」，那张图自己不知道 —— 所以只有演化
 * 这一步该调它。材质共享于多个 mesh 时按源图缓存，降一次就够。
 */
function prepareHeightImage(image: Image): Image {
    const cached = preparedImages.get(image);
    if (cached) return cached;
    const prepared = filterHeightImage(image, Math.max(1, Math.floor(image.width / 2)));
    preparedImages.set(image, prepared);
    return prepared;
}

/** 源图 → 降采样结果。位移图在加载时被多个 instance 共享，降一次就够了。 */
const preparedImages = new WeakMap<Image, Image>();

/**
 * 2×2 盒式降采样到 targetSize 以内。
 *
 * 采样定理：顶点间距必须小于 Nyquist 波长的一半。位移图和网格的尺寸比
 * 直接决定会不会混叠 —— 一个 texel 一个格是安全的上限。
 */
function filterHeightImage(image: Image, targetSize: number): Image {
    let width = image.width;
    let height = image.height;
    let data = image.data;
    while (width > targetSize || height > targetSize) {
        const nw = Math.max(1, width >> 1);
        const nh = Math.max(1, height >> 1);
        const out = new Float32Array(nw * nh * 3);
        for (let y = 0; y < nh; y++) {
            const y0 = Math.min(y * 2, height - 1);
            const y1 = Math.min(y * 2 + 1, height - 1);
            for (let x = 0; x < nw; x++) {
                const x0 = Math.min(x * 2, width - 1);
                const x1 = Math.min(x * 2 + 1, width - 1);
                const a = (y0 * width + x0) * 3;
                const b = (y0 * width + x1) * 3;
                const c = (y1 * width + x0) * 3;
                const d = (y1 * width + x1) * 3;
                const o = (y * nw + x) * 3;
                out[o] = (data[a] + data[b] + data[c] + data[d]) * 0.25;
                out[o + 1] = (data[a + 1] + data[b + 1] + data[c + 1] + data[d + 1]) * 0.25;
                out[o + 2] = (data[a + 2] + data[b + 2] + data[c + 2] + data[d + 2]) * 0.25;
            }
        }
        width = nw;
        height = nh;
        data = out;
    }
    return { ...image, width, height, data };
}

/** 双线性采样高度图（灰度存成 RGB，取任意通道），UV 按 repeat 环绕。 */
function sampleHeight(image: Image, u: number, v: number): number {
    const w = image.width;
    const h = image.height;
    const x = (((u % 1) + 1) % 1) * w - 0.5;
    const y = (((v % 1) + 1) % 1) * h - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const px = (i: number) => ((i % w) + w) % w;
    const py = (i: number) => ((i % h) + h) % h;
    const a = image.data[(py(y0) * w + px(x0)) * 3];
    const b = image.data[(py(y0) * w + px(x0 + 1)) * 3];
    const c = image.data[(py(y0 + 1) * w + px(x0)) * 3];
    const d = image.data[(py(y0 + 1) * w + px(x0 + 1)) * 3];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/**
 * 位移量（米）：`(高度 - mid) × scale`，和 Blender Displacement 节点的
 * Midlevel / Scale 是同一套定义。两个数都由材质给，这里不测量、不缩放。
 *
 * 早先这里按 5–95 分位自动标定、再用 tanh 压尾巴，理由是「扫描图存的不是
 * 绝对高度」。但资产其实给了绝对刻度（材质作者的 .blend 里就有），自己
 * 再测一遍只是把作者的选择换成一个猜的。
 *
 * u/v 是米制 UV，按图自己的一格几米（`image.meters`）折成图上的重复。只看 UV：
 * 同一个三角形上，位置不同、UV 相同的地方抬得一样高。
 */
function sampleDisplacement(
    image: Image,
    u: number,
    v: number,
    mid: number,
    scale: number,
): number {
    const meters = image.meters ?? 1;
    return (sampleHeight(image, u / meters, v / meters) - mid) * scale;
}

/**
 * Mesh IR：几何 + 材质引用，不含任何 GPU 或加速结构。
 *
 * BLAS 是派生数据（buildMeshBVH），属于 compile 层，不放进 IR。
 *
 * 唯一的例外是 `evolve()` —— 它把材质上的位移贴图烘成真几何。位移贴图是
 * 材质的运行时属性（导入器 / 场景作者给），而「一块几何长什么样」必须在这里
 * 定下来：BVH、包围盒、实例摆放读到的都得是已经演化过的顶点。
 */
export class Mesh {
    /** 显示用名字（文件名或场景内标签），不参与任何计算 */
    public readonly name?: string;
    /** 交错排布：pos(3) + normal(3) + uv(2) + tangent(4) = 12 floats/vertex */
    public readonly vertexData: Float32Array;
    /** 每个三角形 4 个 uint32：v0, v1, v2, matIdx */
    public readonly triangleData: Uint32Array;
    /** 这个 mesh 用到的 PBR 材质（triangleData 里的 matIdx 指向这里） */
    public readonly materials: readonly PBRMaterial[];
    /** 局部空间 AABB */
    public readonly bounds: AABB;

    private evolved?: Mesh;

    constructor(
        vertexData: Float32Array,
        triangleData: Uint32Array,
        materials: readonly PBRMaterial[],
        name?: string,
    ) {
        this.vertexData = vertexData;
        this.triangleData = triangleData;
        this.materials = materials;
        this.name = name;
        this.bounds = computeBounds(vertexData);
    }

    /**
     * 演化：把材质上的位移贴图消耗掉，返回可以直接进渲染的 mesh。
     *
     * 有位移贴图的三角形按图上一个 texel 一格的密度细分成网格、顶点按材质的
     * 零点和刻度抬起，法线按高度场重新求；没有的三角形一个顶点都不动。返回的 mesh 上，
     * 那些材质是删掉 `displacement` 的副本 —— 上 GPU 的材质里不再有位移贴图。
     *
     * 结果缓存在 mesh 上：同一个 mesh 的多个 instance 共享一份演化结果，
     * 也就共享同一棵 BLAS。没有位移的 mesh 原样返回（=== 自己）。
     */
    public evolve(): Mesh {
        if (!this.materials.some((m) => m.displacement)) return this;
        if (!this.evolved) this.evolved = evolveMesh(this);
        return this.evolved;
    }
}

/** 位移贴图烘成几何 —— `evolve()` 的实现。 */
function evolveMesh(mesh: Mesh): Mesh {
    const vd = mesh.vertexData;
    const td = mesh.triangleData;
    // 材质副本：位移贴图和相关参数被消耗掉，其余字段一个不少
    const materials = mesh.materials.map((m) => {
        if (!m.displacement) return m;
        const {
            displacement: _image,
            displacementMid: _mid,
            displacementScale: _scale,
            ...rest
        } = m;
        return rest;
    });

    const verts: number[] = [];
    const tris: number[] = [];
    for (let t = 0; t < td.length; t += 4) {
        const ia = td[t];
        const ib = td[t + 1];
        const ic = td[t + 2];
        const mat = td[t + 3];
        const displacement = displacementOf(mesh.materials[mat]);

        if (!displacement) {
            const base = verts.length / 12;
            for (const v of [ia, ib, ic]) {
                for (let k = 0; k < 12; k++) verts.push(vd[v * 12 + k]);
            }
            tris.push(base, base + 1, base + 2, mat);
            continue;
        }

        tessellate(vd, ia, ib, ic, mat, displacement, verts, tris);
    }

    return new Mesh(new Float32Array(verts), new Uint32Array(tris), materials, mesh.name);
}

/**
 * 把一个三角形铺成重心坐标网格：每边按最长边 / 格距等分，
 * 网格点按 `displacement` 抬起、按高度场重算法线。
 *
 * 两边三角形用同样的等分数，共用边上落点一致 —— 相邻三角形之间不会裂开。
 * 顶点不跨三角形共享（每个格子自带一份），代价是边界附近的重复顶点，
 * 换来的是不用做焊接、法线也不会在接缝处断开。
 */
function tessellate(
    vd: Float32Array,
    ia: number,
    ib: number,
    ic: number,
    mat: number,
    displacement: Displacement,
    verts: number[],
    tris: number[],
): void {
    const a = vd.subarray(ia * 12, ia * 12 + 12);
    const b = vd.subarray(ib * 12, ib * 12 + 12);
    const c = vd.subarray(ic * 12, ic * 12 + 12);
    const longest = Math.max(edgeLength(a, b), edgeLength(a, c), edgeLength(b, c));
    const n = Math.max(1, Math.ceil(longest / displacement.cell));

    // 三角形网格按行排：第 j 行有 n+1-j 个顶点（重心 j/n）
    const rowStart = new Int32Array(n + 1);
    let cursor = verts.length / 12;
    for (let j = 0; j <= n; j++) {
        rowStart[j] = cursor;
        cursor += n + 1 - j;
    }

    const v = new Float32Array(12);
    for (let j = 0; j <= n; j++) {
        for (let i = 0; i <= n - j; i++) {
            const wb = i / n;
            const wc = j / n;
            const wa = 1 - wb - wc;
            for (let k = 0; k < 12; k++) v[k] = a[k] * wa + b[k] * wb + c[k] * wc;
            displace(v, displacement);
            for (let k = 0; k < 12; k++) verts.push(v[k]);
        }
    }

    const at = (j: number, i: number) => rowStart[j] + i;
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n - j; i++) {
            const p0 = at(j, i);
            const p1 = at(j, i + 1);
            const p2 = at(j + 1, i);
            tris.push(p0, p1, p2, mat);
            if (i < n - 1 - j) {
                const p3 = at(j + 1, i + 1);
                tris.push(p1, p3, p2, mat);
            }
        }
    }
}

/**
 * 抬起一个顶点并重算法线（原地写 `v`）。
 *
 * 法线不靠相邻三角形平均：那是焊接之后才有的信息。这里走解析梯度 ——
 * 位移量是 UV 的连续函数，曲面沿 u/v 两个方向的导数直接中心差分出来，
 * 曲面法线 = 两条切线叉乘。网格再稀，法线也是平滑的。
 */
function displace(v: Float32Array, d: Displacement): void {
    const u = v[6];
    const w = v[7];
    const x = v[0];
    const y = v[1];
    const z = v[2];

    // 位移沿顶点法线：高度差 1.0 对应 d.scale 米，零点由材质的 mid 定
    const nx = v[3];
    const ny = v[4];
    const nz = v[5];
    const offset = sampleDisplacement(d.image, u, w, d.mid, d.scale);
    v[0] = x + nx * offset;
    v[1] = y + ny * offset;
    v[2] = z + nz * offset;

    // 切线基：法线 + 沿 u 的切线，副切线 = w × (n × t)
    const sign = v[11] < 0 ? -1 : 1;
    let tx = v[8];
    let ty = v[9];
    let tz = v[10];
    const along = nx * tx + ny * ty + nz * tz;
    tx -= nx * along;
    ty -= ny * along;
    tz -= nz * along;
    const len = Math.hypot(tx, ty, tz);
    if (len < 1e-6) return; // 退化切线：法线原样留着，比除零强
    tx /= len;
    ty /= len;
    tz /= len;
    const bx = (ny * tz - nz * ty) * sign;
    const by = (nz * tx - nx * tz) * sign;
    const bz = (nx * ty - ny * tx) * sign;

    // 中心差分两边各走一格（跨度两格）。步子不能再小：高度图一格才零点几
    // 厘米，差分跨得比它还窄就会把扫描噪点当坡度。
    const e = d.cell;
    // 采样已经是米，差分直接就是坡度（米/米），不用再乘刻度
    const ku =
        (sampleDisplacement(d.image, u + e, w, d.mid, d.scale) -
            sampleDisplacement(d.image, u - e, w, d.mid, d.scale)) /
        (2 * e);
    const kv =
        (sampleDisplacement(d.image, u, w + e, d.mid, d.scale) -
            sampleDisplacement(d.image, u, w - e, d.mid, d.scale)) /
        (2 * e);

    // 曲面沿 u/v 的切线 = 切/副切线 + 法线方向的位移导数
    const ux = tx + nx * ku;
    const uy = ty + ny * ku;
    const uz = tz + nz * ku;
    const vx = bx + nx * kv;
    const vy = by + ny * kv;
    const vz = bz + nz * kv;
    let mx = uy * vz - uz * vy;
    let my = uz * vx - ux * vz;
    let mz = ux * vy - uy * vx;
    const m = Math.hypot(mx, my, mz);
    if (m < 1e-12) return;
    mx /= m;
    my /= m;
    mz /= m;
    v[3] = mx;
    v[4] = my;
    v[5] = mz;
}

function edgeLength(a: Float32Array, b: Float32Array): number {
    return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

function computeBounds(vertexData: Float32Array): AABB {
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (let i = 0; i < vertexData.length; i += 12) {
        const x = vertexData[i];
        const y = vertexData[i + 1];
        const z = vertexData[i + 2];
        if (x < min.x) min.x = x;
        if (y < min.y) min.y = y;
        if (z < min.z) min.z = z;
        if (x > max.x) max.x = x;
        if (y > max.y) max.y = y;
        if (z > max.z) max.z = z;
    }
    return { min, max };
}
