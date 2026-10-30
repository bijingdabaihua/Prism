import type { AABB, Vec3 } from '../../math/types';
import type { Mesh } from '../../ir/mesh';

class BVHNode {
    public bounds: AABB;
    public left = 0;
    public right = 0;
    public leftChild?: BVHNode;
    public rightChild?: BVHNode;
    constructor(bounds: AABB) {
        this.bounds = bounds;
    }
}

interface ItemData<T> {
    item: T;
    index: number;
    bounds: AABB;
    centroid: Vec3;
}

export function buildBVH<T>(items: readonly T[], getBounds: (item: T) => AABB): Float32Array {
    if (items.length === 0) return new Float32Array(0);
    const itemData: ItemData<T>[] = items.map((item, i) => {
        const b = getBounds(item);
        return {
            item,
            index: i,
            bounds: b,
            centroid: { x: (b.min.x + b.max.x) * 0.5, y: (b.min.y + b.max.y) * 0.5, z: (b.min.z + b.max.z) * 0.5 },
        };
    });
    const root = buildNode(itemData, 0);
    const flat = flatten(root);
    return flat;
}

/** SAH 的分桶数。16 是常用值：再细收益落在噪声里，构建却线性变慢。 */
const SAH_BINS = 16;

/**
 * 回到中位数切分的深度。
 *
 * SAH 愿意为了「面积 × 数量」更小的切法接受左右不均衡，树因此可能长歪；
 * 而 shader 的遍历栈是 64 层（`bvh.wgsl` 的 `array<u32, 64>`）。到这条线就
 * 强制对半分 —— 之后每层至少分走一半，最多再长 log2(n) 层。
 */
const SAH_MAX_DEPTH = 40;

const AXES = ['x', 'y', 'z'] as const;

/**
 * 分桶 SAH：对三条轴各分一版桶，选代价最小的切法。
 *
 * 代价是 traversal SAH —— `面积(左) × 左数量 + 面积(右) × 右数量`，即
 * 「随机光线穿过这棵树期望要做多少次包围盒测试」。构建比中位数慢几倍，
 * 但树只在装载时建一次，之后每条光线都在遍历它。
 *
 * 叶子最多两个图元（节点格式决定的，两个槽各指一个图元），所以这里只
 * 决定「怎么切」，「要不要切」没有余地。
 */
function buildNode<T>(items: ItemData<T>[], depth: number): BVHNode {
    const count = items.length;
    if (count <= 2) return createLeaf(items);

    let split: SAHSplit | null = null;
    if (depth < SAH_MAX_DEPTH) split = findSAHSplit(items);
    const [left, right] = split ? partitionByBin(items, split) : medianPartition(items);

    const lChild = buildNode(left, depth + 1);
    const rChild = buildNode(right, depth + 1);
    const node = new BVHNode(mergeBounds(lChild.bounds, rChild.bounds));
    node.leftChild = lChild;
    node.rightChild = rChild;
    return node;
}

interface SAHSplit {
    /** 每个图元落在哪个桶（沿选中轴）。 */
    bins: Uint8Array;
    /** 左半 = 桶号 ≤ 它的所有图元。 */
    splitBin: number;
    cost: number;
}

function findSAHSplit<T>(items: ItemData<T>[]): SAHSplit | null {
    const n = items.length;
    const cmin = { x: Infinity, y: Infinity, z: Infinity };
    const cmax = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const it of items) {
        if (it.centroid.x < cmin.x) cmin.x = it.centroid.x;
        if (it.centroid.y < cmin.y) cmin.y = it.centroid.y;
        if (it.centroid.z < cmin.z) cmin.z = it.centroid.z;
        if (it.centroid.x > cmax.x) cmax.x = it.centroid.x;
        if (it.centroid.y > cmax.y) cmax.y = it.centroid.y;
        if (it.centroid.z > cmax.z) cmax.z = it.centroid.z;
    }

    let best: SAHSplit | null = null;
    for (const axis of AXES) {
        const lo = cmin[axis];
        const extent = cmax[axis] - lo;
        // 质心在这条轴上完全重合，分不开
        if (!(extent > 0)) continue;

        const scale = SAH_BINS / extent;
        const bins = new Uint8Array(n);
        const counts = new Uint32Array(SAH_BINS);
        const binBounds: AABB[] = Array.from({ length: SAH_BINS }, emptyBounds);
        for (let i = 0; i < n; i++) {
            // 最大质心正好落在 SAH_BINS 上，夹回最后一桶
            const b = Math.min(SAH_BINS - 1, Math.floor((items[i]!.centroid[axis] - lo) * scale));
            bins[i] = b;
            counts[b]!++;
            growBounds(binBounds[b]!, items[i]!.bounds);
        }

        // 两侧各扫一遍，得到「切在第 i 桶之后」时左右两边的面积和数量
        const leftArea = new Float64Array(SAH_BINS);
        const rightArea = new Float64Array(SAH_BINS);
        const leftCount = new Uint32Array(SAH_BINS);
        const rightCount = new Uint32Array(SAH_BINS);

        const lb = emptyBounds();
        let lc = 0;
        for (let i = 0; i < SAH_BINS - 1; i++) {
            growBounds(lb, binBounds[i]!);
            lc += counts[i]!;
            leftArea[i] = lc > 0 ? area(lb) : Infinity;
            leftCount[i] = lc;
        }
        const rb = emptyBounds();
        let rc = 0;
        for (let i = SAH_BINS - 1; i > 0; i--) {
            growBounds(rb, binBounds[i]!);
            rc += counts[i]!;
            rightArea[i] = rc > 0 ? area(rb) : Infinity;
            rightCount[i] = rc;
        }

        for (let i = 0; i < SAH_BINS - 1; i++) {
            if (leftCount[i] === 0 || rightCount[i + 1] === 0) continue;
            const cost = leftArea[i]! * leftCount[i]! + rightArea[i + 1]! * rightCount[i + 1]!;
            if (!best || cost < best.cost) best = { bins, splitBin: i, cost };
        }
    }
    return best;
}

/** 按桶计数排序后对半切开 —— O(n)，比重新排序快，也保证同桶图元不跨左右。 */
function partitionByBin<T>(items: ItemData<T>[], split: SAHSplit): [ItemData<T>[], ItemData<T>[]] {
    const start = new Uint32Array(SAH_BINS + 1);
    for (const b of split.bins) start[b + 1]!++;
    for (let i = 0; i < SAH_BINS; i++) start[i + 1]! += start[i]!;

    const sorted = new Array<ItemData<T>>(items.length);
    const cursor = start.slice(0, SAH_BINS);
    for (let i = 0; i < items.length; i++) sorted[cursor[split.bins[i]!]!++] = items[i]!;

    const k = start[split.splitBin + 1]!;
    return [sorted.slice(0, k), sorted.slice(k)];
}

/** 兜底：最长轴质心中位数对半分。质心全重合、或已经到深度上限时用它。 */
function medianPartition<T>(items: ItemData<T>[]): [ItemData<T>[], ItemData<T>[]] {
    const b = mergeAllBounds(items);
    const ex = b.max.x - b.min.x;
    const ey = b.max.y - b.min.y;
    const ez = b.max.z - b.min.z;
    const axis: (typeof AXES)[number] = ex >= ey && ex >= ez ? 'x' : ey >= ez ? 'y' : 'z';
    items.sort((a, b) => a.centroid[axis] - b.centroid[axis]);
    const mid = items.length >> 1;
    return [items.slice(0, mid), items.slice(mid)];
}

function emptyBounds(): AABB {
    return {
        min: { x: Infinity, y: Infinity, z: Infinity },
        max: { x: -Infinity, y: -Infinity, z: -Infinity },
    };
}

function growBounds(a: AABB, b: AABB): void {
    if (b.min.x < a.min.x) a.min.x = b.min.x;
    if (b.min.y < a.min.y) a.min.y = b.min.y;
    if (b.min.z < a.min.z) a.min.z = b.min.z;
    if (b.max.x > a.max.x) a.max.x = b.max.x;
    if (b.max.y > a.max.y) a.max.y = b.max.y;
    if (b.max.z > a.max.z) a.max.z = b.max.z;
}

/** 表面积（半值，差一个常数不影响比较）。 */
function area(b: AABB): number {
    const dx = b.max.x - b.min.x;
    const dy = b.max.y - b.min.y;
    const dz = b.max.z - b.min.z;
    return dx * dy + dy * dz + dz * dx;
}

function createLeaf<T>(items: ItemData<T>[]): BVHNode {
    const node = new BVHNode(mergeAllBounds(items));
    for (let i = 0; i < items.length; i++) {
        const slot = i === 0 ? 'left' : ('right' as const);
        node[slot] = -(items[i].index + 1);
    }
    return node;
}

const NODE_STRIDE = 8;
function flatten(root: BVHNode): Float32Array {
    const nodes: number[] = [];
    function walk(node: BVHNode): number {
        const base = nodes.length;
        for (let i = 0; i < NODE_STRIDE; i++) nodes.push(0);
        if (node.leftChild) nodes[base + 6] = walk(node.leftChild) * NODE_STRIDE + 1;
        else if (node.left < 0) nodes[base + 6] = node.left;
        if (node.rightChild) nodes[base + 7] = walk(node.rightChild) * NODE_STRIDE + 1;
        else if (node.right < 0) nodes[base + 7] = node.right;
        nodes[base + 0] = node.bounds.min.x;
        nodes[base + 1] = node.bounds.min.y;
        nodes[base + 2] = node.bounds.min.z;
        nodes[base + 3] = node.bounds.max.x;
        nodes[base + 4] = node.bounds.max.y;
        nodes[base + 5] = node.bounds.max.z;
        return base / NODE_STRIDE;
    }
    walk(root);
    return new Float32Array(nodes);
}

function mergeAllBounds<T>(items: ItemData<T>[]): AABB {
    let mnX = Infinity,
        mnY = Infinity,
        mnZ = Infinity;
    let mxX = -Infinity,
        mxY = -Infinity,
        mxZ = -Infinity;
    for (const it of items) {
        mnX = Math.min(mnX, it.bounds.min.x);
        mnY = Math.min(mnY, it.bounds.min.y);
        mnZ = Math.min(mnZ, it.bounds.min.z);
        mxX = Math.max(mxX, it.bounds.max.x);
        mxY = Math.max(mxY, it.bounds.max.y);
        mxZ = Math.max(mxZ, it.bounds.max.z);
    }
    return { min: { x: mnX, y: mnY, z: mnZ }, max: { x: mxX, y: mxY, z: mxZ } };
}

function mergeBounds(a: AABB, b: AABB): AABB {
    return {
        min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y), z: Math.min(a.min.z, b.min.z) },
        max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y), z: Math.max(a.max.z, b.max.z) },
    };
}

/** Mesh IR → BLAS（扁平 BVH 数组）。同一个 Mesh 只应构建一次。 */
const blasCache = new WeakMap<Mesh, Float32Array>();

/**
 * 按 mesh 缓存的 BLAS：同一个 mesh 的多个 instance 共享同一棵树。
 * 重建场景时 mesh 对象不变，缓存命中，不用重算。
 */
export function meshBLAS(mesh: Mesh): Float32Array {
    let b = blasCache.get(mesh);
    if (!b) {
        b = buildMeshBVH(mesh);
        blasCache.set(mesh, b);
    }
    return b;
}

export function buildMeshBVH(mesh: Mesh): Float32Array {
    const vd = mesh.vertexData;
    const tri = mesh.triangleData;
    const triCount = tri.length / 4;
    const items = Array.from({ length: triCount }, (_, t) => t);
    return buildBVH(items, (t: number) => {
        const off = t * 4;
        let mnX = Infinity,
            mnY = Infinity,
            mnZ = Infinity;
        let mxX = -Infinity,
            mxY = -Infinity,
            mxZ = -Infinity;
        for (const vi of [tri[off], tri[off + 1], tri[off + 2]]) {
            // vertexData 是交错的 12 floats/vertex，位置在前 3 个
            const b = vi * 12;
            mnX = Math.min(mnX, vd[b]);
            mxX = Math.max(mxX, vd[b]);
            mnY = Math.min(mnY, vd[b + 1]);
            mxY = Math.max(mxY, vd[b + 1]);
            mnZ = Math.min(mnZ, vd[b + 2]);
            mxZ = Math.max(mxZ, vd[b + 2]);
        }
        return { min: { x: mnX, y: mnY, z: mnZ }, max: { x: mxX, y: mxY, z: mxZ } };
    });
}
