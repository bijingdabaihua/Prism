import type { Instance } from '../../ir/instance';
import { INST_FLOATS } from '../../ir/instance';
import type { Mesh } from '../../ir/mesh';
import { Mat4 } from '../../math/mat4';
import { buildBVH, meshBLAS } from './bvh';
import { MaterialStore } from './material/material-store';
import type { TextureSet } from './material/texture/texture-set';

/**
 * Model —— 场景的 GPU 形态：一组 buffer。
 *
 * 和 `model/scene.ts` 的 `Scene` 是同一样东西的两面：`Scene` 是 CPU 侧的描述
 * （Instance IR），这里是它编译出来的 GPU 数据。render 层只认识这一面，
 * 不碰任何 CPU 侧的几何对象。
 *
 * 这里的 model 指「场景在 GPU 这边的模型」，不是 `assets/model/` 下那个
 * glTF 资产 —— 后者是 Mesh / Instance 的事。
 *
 * 编译是一条直线，四个阶段都在这个文件里：
 *
 *   布局    mesh 去重，算出每个 mesh 的 BLAS / 顶点 / 三角形起始下标
 *   节点表  TLAS + 各 mesh 的 BLAS 拼成一张扁平 Float32Array，下标重基
 *   打包    顶点 / 三角形 / 实例各自铺成大数组，材质下标换成绝对槽位
 *   上传    建 buffer、写进去 —— 只搬运，不算数据
 *
 * 合成一个文件是因为它们只有这一条调用链：中间的数据结构（SceneOffsets /
 * SceneNodesData）没有第二个消费者，拆成三个模块只是让读者来回跳。
 *
 * 材质表由其内部按本次打包的结果维护，材质采样的图集归材质表持有（见 MaterialStore）。
 */

// 布局

/**
 * 场景资源的布局：几何 / BLAS / 三角形按 **mesh** 划分区域，不按 instance。
 *
 * 同一 mesh 的多个 instance 共享同一段几何与同一棵 BLAS，instance buffer 里
 * 只各存一份变换和指向同一区域的基址。这样实例化才真的省显存。
 */
interface SceneOffsets {
    /** 去重后的 mesh，按首次出现顺序 */
    meshes: Mesh[];
    /** 每个 mesh 的 BLAS 起始下标（float） */
    blas: number[];
    /** 每个 mesh 的顶点起始下标（vertex） */
    vert: number[];
    /** 每个 mesh 的三角形起始下标（triangle） */
    tri: number[];
    /** 每个 instance 引用的 mesh 在 meshes[] 中的下标 */
    instMesh: number[];
}

function computeOffsets(insts: readonly Instance[]): SceneOffsets {
    const meshes: Mesh[] = [];
    const meshIndex = new Map<Mesh, number>();
    const instMesh: number[] = [];
    for (const inst of insts) {
        let idx = meshIndex.get(inst.mesh);
        if (idx === undefined) {
            idx = meshes.length;
            meshIndex.set(inst.mesh, idx);
            meshes.push(inst.mesh);
        }
        instMesh.push(idx);
    }

    const blas: number[] = [];
    const vert: number[] = [];
    const tri: number[] = [];
    let b = 0;
    let v = 0;
    let t = 0;
    for (const mesh of meshes) {
        blas.push(b);
        vert.push(v);
        tri.push(t);
        b += meshBLAS(mesh).length;
        v += mesh.vertexData.length / 12;
        t += mesh.triangleData.length / 4;
    }
    return { meshes, blas, vert, tri, instMesh };
}

// 节点表

/**
 * TLAS + 所有 mesh 的 BLAS 合并成一张扁平的 Float32Array。
 *
 * 纯 CPU 的编译产物：这里只决定「节点按什么顺序排、下标怎么重基」，
 * 写进 buffer 是文件后半段 upload* 的事。
 *
 * 合并的直接动因是绑定名额：WebGPU 默认每个 shader stage 最多 8 个 storage
 * buffer，几何 / 三角形 / 材质 / 实例 / 环境 CDF 已经接近上限，合并后才有
 * 位置放像素采样顺序表。
 *
 * 布局：[TLAS 节点 ...][BLAS 节点 ...]，每节点 8 个 float。
 */

/**
 * 实例 → TLAS。
 *
 * 叶子节点编码 -(instanceIndex + 1)；只有一个实例时直接退化成单节点，
 * 与 shader 里 `bvh.wgsl` 的约定一致。
 */
function buildTLAS(insts: readonly Instance[]): Float32Array {
    if (insts.length === 0) return new Float32Array(0);
    if (insts.length === 1) {
        const b = insts[0].getBounds();
        const n = new Float32Array(8);
        n[0] = b.min.x;
        n[1] = b.min.y;
        n[2] = b.min.z;
        n[3] = b.max.x;
        n[4] = b.max.y;
        n[5] = b.max.z;
        n[6] = -1;
        return n;
    }
    return buildBVH(insts, (i) => {
        const b = i.getBounds();
        return { min: { x: b.min.x, y: b.min.y, z: b.min.z }, max: { x: b.max.x, y: b.max.y, z: b.max.z } };
    });
}

/**
 * 每个 mesh 合并成一棵 BLAS；叶子里的三角形下标重基到该 mesh 的全局三角形区。
 *
 * @param nodeBase 这棵 BLAS 在合并 nodes buffer 里的起始下标（float）。
 *   内部节点的子节点偏移会加上它；叶子（负值）是三角形下标，不受影响。
 */
function mergeBLAS(offsets: SceneOffsets, nodeBase: number): Float32Array {
    const all = offsets.meshes.map((m) => meshBLAS(m));
    let total = 0;
    for (const b of all) total += b.length;
    const merged = new Float32Array(total);
    for (let i = 0; i < all.length; i++) {
        const b = all[i];
        const off = offsets.blas[i];
        const triOff = offsets.tri[i];
        for (let n = 0; n < b.length; n += 8) {
            for (let j = 0; j < 6; j++) merged[off + n + j] = b[n + j];
            for (let j = 6; j < 8; j++) {
                const s = b[n + j];
                if (s < 0) {
                    merged[off + n + j] = s - triOff;
                } else {
                    merged[off + n + j] = s > 0 ? s + off + nodeBase : 0;
                }
            }
        }
    }
    return merged;
}

interface SceneNodesData {
    /** [TLAS ...][BLAS ...]，每节点 8 floats */
    data: Float32Array;
    /** BLAS 区在 data 里的起始下标（float），实例表的 blas_node_offset 要烘进它 */
    blasBase: number;
}

/** 建 TLAS，把所有 mesh 的 BLAS 接在它后面，并重基内部节点下标。 */
function buildSceneNodes(insts: readonly Instance[], offsets: SceneOffsets): SceneNodesData {
    const tlas = buildTLAS(insts);
    const blas = mergeBLAS(offsets, tlas.length);
    const data = new Float32Array(tlas.length + blas.length);
    data.set(tlas, 0);
    data.set(blas, tlas.length);
    return { data, blasBase: tlas.length };
}

// 搬上 GPU

/**
 * 编译产物 → GPU buffer。
 *
 * 只做搬运：拿上面算好的数组建 buffer、写进去，不再算任何布局。
 */

function createBuffer(
    device: GPUDevice,
    data: Float32Array | Uint32Array,
    label: string,
    emptySize = 4,
): GPUBuffer {
    const buf = device.createBuffer({
        size: data.byteLength || emptySize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        label,
    });
    if (data.byteLength) device.queue.writeBuffer(buf, 0, data as any);
    return buf;
}

function uploadGeometry(device: GPUDevice, offsets: SceneOffsets): GPUBuffer {
    let total = 0;
    for (const mesh of offsets.meshes) total += mesh.vertexData.length / 12;
    const data = new Float32Array(total * 12);
    for (let i = 0; i < offsets.meshes.length; i++) {
        data.set(offsets.meshes[i].vertexData, offsets.vert[i] * 12);
    }
    return createBuffer(device, data, 'scene-geometry');
}

/** @param matSlots 每个 mesh 的材质表：把三角形里的相对材质下标映射成绝对槽位 */
function uploadTriangles(device: GPUDevice, offsets: SceneOffsets, matSlots: number[][]): GPUBuffer {
    let total = 0;
    for (const mesh of offsets.meshes) total += mesh.triangleData.length / 4;
    const data = new Uint32Array(total * 4);
    for (let i = 0; i < offsets.meshes.length; i++) {
        const tri = offsets.meshes[i].triangleData;
        const vOff = offsets.vert[i];
        const mats = matSlots[i];
        const tBase = offsets.tri[i] * 4;
        for (let s = 0; s < tri.length; s += 4) {
            data[tBase + s] = tri[s] + vOff;
            data[tBase + s + 1] = tri[s + 1] + vOff;
            data[tBase + s + 2] = tri[s + 2] + vOff;
            data[tBase + s + 3] = mats[tri[s + 3]];
        }
    }
    return createBuffer(device, data, 'scene-triangles');
}

/** 世界变换的逆 —— 着色时从世界空间回到局部空间用。派生数据，故在打包时算。 */
function invertTransform(transform: Float32Array): Float32Array {
    return Mat4.from(transform).invert().raw();
}

function uploadInstances(
    device: GPUDevice,
    insts: Instance[],
    offsets: SceneOffsets,
    blasBase: number,
): GPUBuffer {
    const data = new Float32Array(insts.length * INST_FLOATS);
    for (let i = 0; i < insts.length; i++) {
        const b = i * INST_FLOATS;
        const inst = insts[i];
        // 同一 mesh 的所有 instance 指向同一棵 BLAS；BLAS 区在合并 nodes buffer
        // 里从 blasBase 开始，所以这里把基址直接烘进 offset。
        data[b] = offsets.blas[offsets.instMesh[i]] + blasBase;
        const pm = (m: Float32Array, o: number) => {
            data[b + o] = m[0];
            data[b + o + 1] = m[1];
            data[b + o + 2] = m[2];
            data[b + o + 3] = 0;
            data[b + o + 4] = m[4];
            data[b + o + 5] = m[5];
            data[b + o + 6] = m[6];
            data[b + o + 7] = 0;
            data[b + o + 8] = m[8];
            data[b + o + 9] = m[9];
            data[b + o + 10] = m[10];
            data[b + o + 11] = 0;
            data[b + o + 12] = m[12];
            data[b + o + 13] = m[13];
            data[b + o + 14] = m[14];
            data[b + o + 15] = 0;
        };
        pm(inst.transform, 4);
        pm(invertTransform(inst.transform), 20);
    }
    // WebGPU 对 `array<Instance>` 有最小 binding size（INST_FLOATS*4 B/instance），空场景也要满足
    return createBuffer(device, data, 'scene-instances', INST_FLOATS * 4);
}

/** 节点表：[TLAS ...][BLAS ...]，每节点 8 floats（构造见上面的 buildSceneNodes）。 */
function uploadSceneNodes(device: GPUDevice, data: Float32Array): GPUBuffer {
    return createBuffer(device, data, 'scene-nodes');
}

/**
 * Model —— 场景的 GPU 形态：一组 buffer。
 *
 * 和 `model/scene.ts` 的 `Scene` 是同一样东西的两面：`Scene` 是 CPU 侧的描述
 * （Instance IR），这里是它编译出来的 GPU 数据。render 层只认识这一面，
 * 不碰任何 CPU 侧的几何对象。
 *
 * 这里的 model 指「场景在 GPU 这边的模型」，不是 `assets/model/` 下那个
 * glTF 资产 —— 后者是 Mesh / Instance 的事。
 *
 * 材质表由其内部按本次打包的结果维护，材质采样的图集归材质表持有（见 MaterialStore）。
 */
export class Model {
    /**
     * TLAS + BLAS 合并节点 buffer：每节点 8 floats。
     * 布局 [TLAS ...][BLAS ...]；TLAS 叶子编码 -(instanceID + 1)，
     * BLAS 叶子编码 -(绝对三角形下标 + 1)。
     */
    public nodes!: GPUBuffer;
    /** 合并后的顶点数据，12 floats/vertex */
    public geometry!: GPUBuffer;
    /** 合并后的三角形，4 × u32（v0,v1,v2, 绝对材质槽位） */
    public triangles!: GPUBuffer;
    /** 实例表：36 floats/instance（blas_node_offset + transform + inv_transform） */
    public instanceBuffer!: GPUBuffer;
    private readonly device: GPUDevice;
    private readonly materialStore: MaterialStore;

    constructor(device: GPUDevice) {
        this.device = device;
        this.materialStore = new MaterialStore(device);
    }

    /**
     * 编译场景 —— 整个生命里只调一次。
     *
     * 一个 Engine 只装载一个场景：换场景就换 Engine，所以这里没有增量更新、
     * 没有脏标记、没有 buffer 复用，一次把整条链走完。`compile()` 之前这四个
     * buffer 都不存在 —— PathTracePass 以 `Background.hasEnvironment()` 作闸门，
     * 而 Engine.setScene 最后才设环境图，读到的永远是编译完的 Model。
     */
    public compile(insts: Instance[]): void {
        if (this.nodes) throw new Error('Model: compile 只能调用一次 —— 换场景请换 Engine');

        // 演化：材质上带位移贴图的 instance 在这里换成细分的真几何，
        // 从那以后 GPU 侧既没有位移贴图，也没有「位移」这个概念
        const instances = insts.map((inst) => inst.evolve());
        const offsets = computeOffsets(instances);
        // 材质按对象注册：同一材质被多个 mesh 引用时只占一个槽位
        const matSlots = offsets.meshes.map((mesh) => mesh.materials.map((m) => this.materialStore.register(m)));
        this.materialStore.compile();

        const compiled = this.build(offsets, instances, matSlots);
        this.nodes = compiled.nodes;
        this.geometry = compiled.geometry;
        this.triangles = compiled.triangles;
        this.instanceBuffer = compiled.instanceBuffer;
    }

    /** 材质 SSBO，供 bind group 直接绑定。 */
    public materialBuffer(): GPUBuffer {
        return this.materialStore.getBuffer();
    }

    /** 材质图集，供 bind group 直接绑定。 */
    public textures(): TextureSet {
        return this.materialStore.textures;
    }

    public destroy(): void {
        this.nodes?.destroy();
        this.geometry?.destroy();
        this.triangles?.destroy();
        this.instanceBuffer?.destroy();
        this.materialStore.destroy();
    }

    /** 构建一整套新 buffer；失败时销毁已建的部分，不留下泄漏。 */
    private build(offsets: SceneOffsets, insts: Instance[], matSlots: number[][]): CompiledBuffers {
        const d = this.device;
        const created: GPUBuffer[] = [];
        const track = (buf: GPUBuffer): GPUBuffer => {
            created.push(buf);
            return buf;
        };
        try {
            // 节点表在 CPU 侧拼好，实例表要用它的 BLAS 基址
            const nodes = buildSceneNodes(insts, offsets);
            return {
                nodes: track(uploadSceneNodes(d, nodes.data)),
                geometry: track(uploadGeometry(d, offsets)),
                triangles: track(uploadTriangles(d, offsets, matSlots)),
                instanceBuffer: track(uploadInstances(d, insts, offsets, nodes.blasBase)),
            };
        } catch (err) {
            for (const buf of created) buf.destroy();
            throw err;
        }
    }
}

interface CompiledBuffers {
    nodes: GPUBuffer;
    geometry: GPUBuffer;
    triangles: GPUBuffer;
    instanceBuffer: GPUBuffer;
}
