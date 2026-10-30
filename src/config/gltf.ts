import type { PBRMaterial, TextureKind } from '../ir/material';
import type { Image } from '../ir/image';
import { Mesh } from '../ir/mesh';
import { defaultPBRMaterial } from '../ir/material';
import { Instance } from '../ir/instance';
import { loadTexture } from './load-texture';

/**
 * glTF 2.0 导入器（.gltf + 外链资源，或 .glb 单文件）。
 *
 * 支持的范围，以及每个缺失项会怎么坏：
 * - 只要三角形（mode 4），其它 primitive 模式直接报错而不是悄悄丢；
 * - 读 baseColor / normal / metallicRoughness / occlusion 四张图，分别进
 *   四个贴图数组；
 * - 节点变换进 Instance，顶点保持局部坐标，同一个 mesh 被多个节点引用时
 *   共享几何（BLAS 按 mesh 建，不该按节点建）；
 * - 不支持 Draco / meshopt 压缩、morph target、蒙皮、动画 —— 遇到 Draco
 *   明确报错，其余忽略。
 *
 * 坐标与 UV 不需要转换：glTF 是 Y 轴向上、米为单位，且 UV 原点在贴图左上角，
 * 和 decodeBitmap 的解码方向、WebGPU 的采样原点一致。
 */

// 容器与常量

const GLB_MAGIC = 0x46546c67; // 'glTF' 小端
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

const MODE_TRIANGLES = 4;

const COMPONENT = {
    5120: { view: 'getInt8', size: 1, norm: 127 },
    5121: { view: 'getUint8', size: 1, norm: 255 },
    5122: { view: 'getInt16', size: 2, norm: 32767 },
    5123: { view: 'getUint16', size: 2, norm: 65535 },
    5125: { view: 'getUint32', size: 4, norm: 4294967295 },
    5126: { view: 'getFloat32', size: 4, norm: 1 },
} as const;

const TYPE_COMPONENTS: Record<string, number> = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16,
};

// 解析后的文档 —— 只声明用到的字段

interface GLTFDocument {
    accessors: GLTFAccessor[];
    bufferViews: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
    /** 只有材质的文档没有 buffer —— 顶点数据是唯一需要它的东西。 */
    buffers?: { byteLength: number; uri?: string }[];
    meshes: GLTFMesh[];
    nodes: GLTFNode[];
    materials?: GLTFMaterial[];
    textures?: { source?: number; sampler?: number }[];
    images?: { uri?: string; bufferView?: number; mimeType?: string }[];
    scenes?: { nodes?: number[] }[];
    scene?: number;
}

interface GLTFAccessor {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    normalized?: boolean;
    count: number;
    type: string;
    sparse?: unknown;
}

interface GLTFMesh {
    name?: string;
    primitives: GLTFPrimitive[];
}

interface GLTFPrimitive {
    attributes: Record<string, number>;
    indices?: number;
    material?: number;
    mode?: number;
    extensions?: Record<string, unknown>;
}

interface GLTFNode {
    name?: string;
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
}

interface GLTFTextureRef {
    index: number;
    /** normalTexture 的法线强度。 */
    scale?: number;
    /** occlusionTexture 的遮挡强度。 */
    strength?: number;
}

interface GLTFMaterial {
    name?: string;
    normalTexture?: GLTFTextureRef;
    occlusionTexture?: GLTFTextureRef;
    pbrMetallicRoughness?: {
        baseColorFactor?: number[];
        baseColorTexture?: GLTFTextureRef;
        metallicFactor?: number;
        roughnessFactor?: number;
        metallicRoughnessTexture?: GLTFTextureRef;
    };
}

// 加载上下文

/** 一次加载期间共享的状态：解码后的 buffer、贴图 URL 缓存、待释放的 blob URL。 */
interface LoadContext {
    doc: GLTFDocument;
    buffers: ArrayBuffer[];
    baseUrl: string;
    /** texture 索引 → 已解析的贴图 URL。occlusion 要现场抽通道，单独缓存。 */
    textureUrls: Map<number, Promise<string | null>>;
    /** image 索引 → 已解析的 URL（位移图直接按 image 引用，不经过 texture）。 */
    imageUrls: Map<number, Promise<string | null>>;
    occlusionUrls: Map<number, Promise<string | null>>;
}

/**
 * 派生 blob URL 的缓存，按「贴图来源」而不是按加载批次。
 *
 * 键必须是稳定的：TextureSet 用它当层号缓存键，图层永不回收 —— 如果每次
 * 加载都生成新的 blob URL，来回切几次场景就会把数组的层耗尽。
 * 代价是 blob 本身不释放（几百 KB），换来的是同一张贴图永远对应同一层。
 */
const derivedBlobs = new Map<string, Promise<string | null>>();

// 入口

/**
 * 读一个 glTF 文件，返回若干可加入场景的 Instance。
 *
 * 一个文件可能包含多个节点，每个节点一次摆放 —— 所以返回的是数组，
 * 调用方要把它们当成一个整体来摆放，而不是逐个 placeIntoScene。
 *
 * 材质已经在 Mesh 里了（贴图解码成 Image）：导入器交出的就是 IR 里
 * 能直接进 Scene 的东西，没有第二份「结果」需要调用方再拼。
 */
export async function loadGLTF(url: string): Promise<Instance[]> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to load glTF: ${url} (${resp.status})`);
    const buf = await resp.arrayBuffer();

    const { doc, bin } = parseContainer(buf, url);
    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
    const buffers = await loadBuffers(doc, bin, baseUrl, url);

    const ctx: LoadContext = {
        doc,
        buffers,
        baseUrl,
        textureUrls: new Map(),
        imageUrls: new Map(),
        occlusionUrls: new Map(),
    };

    const materials = await Promise.all((doc.materials ?? []).map((m) => convertMaterial(m, ctx)));
    const meshes = doc.meshes.map((m, i) => buildMesh(ctx, m, materials, `gltf-mesh-${i}`));
    const instances = buildInstances(doc, meshes);

    return instances;
}

// 容器

/** .glb 是 12 字节头 + 若干 chunk；.gltf 就是纯 JSON。按 magic 判断，不看扩展名。 */
function parseContainer(buf: ArrayBuffer, url: string): { doc: GLTFDocument; bin: ArrayBuffer | null } {
    const view = new DataView(buf);
    if (buf.byteLength >= 12 && view.getUint32(0, true) === GLB_MAGIC) {
        const version = view.getUint32(4, true);
        if (version !== 2) throw new Error(`glTF ${url}: 只支持 glTF 2.0，这个文件是 ${version}`);
        let offset = 12;
        let doc: GLTFDocument | null = null;
        let bin: ArrayBuffer | null = null;
        while (offset + 8 <= buf.byteLength) {
            const length = view.getUint32(offset, true);
            const type = view.getUint32(offset + 4, true);
            const start = offset + 8;
            if (type === CHUNK_JSON) {
                doc = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, start, length))) as GLTFDocument;
            } else if (type === CHUNK_BIN) {
                bin = buf.slice(start, start + length);
            }
            offset = start + length + ((4 - (length % 4)) % 4);
        }
        if (!doc) throw new Error(`glTF ${url}: GLB 里没有 JSON chunk`);
        return { doc, bin };
    }
    const text = new TextDecoder().decode(buf);
    if (text.trimStart().startsWith('<')) {
        throw new Error(`glTF ${url}: 看起来是 HTML/XML，不是 JSON —— 多半是 404 页面`);
    }
    return { doc: JSON.parse(text) as GLTFDocument, bin: null };
}

/**
 * glTF 允许 buffer 分散在多个外部文件里，也可以只有一个内嵌 BIN。
 * 统一读成一组 ArrayBuffer，accessor 用 buffer 下标索引。
 */
async function loadBuffers(
    doc: GLTFDocument,
    bin: ArrayBuffer | null,
    baseUrl: string,
    url: string,
): Promise<ArrayBuffer[]> {
    return Promise.all(
        (doc.buffers ?? []).map(async (b, i) => {
            if (!b.uri) {
                if (!bin) throw new Error(`glTF ${url}: buffer[${i}] 没有 uri，也没有内嵌 BIN chunk`);
                return bin;
            }
            const bufUrl = b.uri.startsWith('data:') ? b.uri : resolveUri(b.uri, baseUrl);
            const resp = await fetch(bufUrl);
            if (!resp.ok) throw new Error(`glTF ${url}: 读不到 buffer[${i}] (${bufUrl})`);
            return resp.arrayBuffer();
        }),
    );
}

// accessor

/**
 * 读成一个紧密排布的 Float32Array。
 *
 * 中间隔着一层 de-interleave：bufferView 可以带 byteStride（多个属性交错存在
 * 一起），而下游的 Mesh IR 要求紧密排布，所以这里必须逐元素取，不能直接把
 * 底层 ArrayBuffer 当成数组用 —— 那样对齐和步长都会错。
 */
function readAccessorFloats(ctx: LoadContext, index: number): Float32Array {
    const acc = ctx.doc.accessors[index];
    if (acc.sparse) throw new Error('glTF: 暂不支持 sparse accessor');
    if (acc.bufferView === undefined) {
        // 合法的「全零」accessor：没有 bufferView 就表示数据缺省为 0。
        return new Float32Array(acc.count * TYPE_COMPONENTS[acc.type]);
    }

    const components = TYPE_COMPONENTS[acc.type];
    const comp = COMPONENT[acc.componentType as keyof typeof COMPONENT];
    if (!comp) throw new Error(`glTF: 未知的 componentType ${acc.componentType}`);

    const bv = ctx.doc.bufferViews[acc.bufferView];
    const data = new DataView(ctx.buffers[bv.buffer]);
    const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const stride = bv.byteStride ?? components * comp.size;
    const read = comp.view as 'getFloat32';

    const out = new Float32Array(acc.count * components);
    for (let i = 0; i < acc.count; i++) {
        const elementBase = base + i * stride;
        for (let c = 0; c < components; c++) {
            const raw = data[read](elementBase + c * comp.size, true) as number;
            out[i * components + c] = acc.normalized ? Math.max(raw / comp.norm, -1) : raw;
        }
    }
    return out;
}

/** 索引统一升到 Uint32：Mesh IR 的 triangleData 本来就是 uint32。 */
function readIndices(ctx: LoadContext, index: number): Uint32Array {
    const acc = ctx.doc.accessors[index];
    if (acc.type !== 'SCALAR') throw new Error(`glTF: 索引 accessor 的 type 是 ${acc.type}`);
    if (acc.sparse) throw new Error('glTF: 暂不支持 sparse accessor');
    const bv = ctx.doc.bufferViews[acc.bufferView!];
    const data = new DataView(ctx.buffers[bv.buffer]);
    const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const size = COMPONENT[acc.componentType as keyof typeof COMPONENT].size;
    const stride = bv.byteStride ?? size;
    const read = COMPONENT[acc.componentType as keyof typeof COMPONENT].view as 'getUint32';

    const out = new Uint32Array(acc.count);
    for (let i = 0; i < acc.count; i++) out[i] = data[read](base + i * stride, true) as number;
    return out;
}

// 几何

/**
 * 一个 glTF mesh 的所有 primitive 合并成一个 Mesh IR。
 *
 * 合并的理由是 Mesh IR 只有「一张顶点表 + 一张三角形表 + 材质数组」，
 * 一个 mesh 内部的多个 primitive 恰好共享同一套节点变换，合并后仍然只需要
 * 一个 Instance。primitive 之间的区分靠 triangleData 每四个数最后一位的材质下标。
 */
function buildMesh(ctx: LoadContext, gm: GLTFMesh, materials: PBRMaterial[], name: string): Mesh {
    // 先扫一遍拿到总数，才能把几个 primitive 一次性铺进同一份顶点/三角形表
    let vertexCount = 0;
    let idxCount = 0;
    for (const prim of gm.primitives) {
        checkPrimitive(prim);
        const count = ctx.doc.accessors[prim.attributes.POSITION].count;
        vertexCount += count;
        idxCount += prim.indices !== undefined ? ctx.doc.accessors[prim.indices].count : count;
    }
    const triCount = idxCount / 3;

    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const gTan = new Float32Array(vertexCount * 4);
    let hasNormals = true;
    let hasTangents = true;
    let hasUvs = true;

    const triangles = new Uint32Array(triCount * 4);
    const meshMaterials: PBRMaterial[] = [];

    let vo = 0; // 顶点写入偏移
    let to = 0; // 三角形写入偏移

    for (const prim of gm.primitives) {
        const pos = readAccessorFloats(ctx, prim.attributes.POSITION);
        const count = ctx.doc.accessors[prim.attributes.POSITION].count;
        positions.set(pos, vo * 3);

        const nrm = prim.attributes.NORMAL !== undefined ? readAccessorFloats(ctx, prim.attributes.NORMAL) : null;
        if (nrm) normals.set(nrm, vo * 3);
        else hasNormals = false;

        const uv =
            prim.attributes.TEXCOORD_0 !== undefined ? readAccessorFloats(ctx, prim.attributes.TEXCOORD_0) : null;
        if (uv) uvs.set(uv, vo * 2);
        else hasUvs = false;

        const tan = prim.attributes.TANGENT !== undefined ? readAccessorFloats(ctx, prim.attributes.TANGENT) : null;
        if (tan) gTan.set(tan, vo * 4);
        else hasTangents = false;

        // 材质槽：同一个 PBRMaterial 在一个 mesh 里只占一个下标
        const source = prim.material !== undefined ? materials[prim.material] : undefined;
        const mat = source ?? defaultPBRMaterial();
        let matIdx = meshMaterials.indexOf(mat);
        if (matIdx < 0) {
            matIdx = meshMaterials.length;
            meshMaterials.push(mat);
        }

        const idx =
            prim.indices !== undefined
                ? readIndices(ctx, prim.indices)
                : Uint32Array.from({ length: count }, (_, i) => i);
        if (idx.length % 3 !== 0) throw new Error(`glTF: primitive 索引数 ${idx.length} 不是 3 的倍数`);
        for (let i = 0; i < idx.length; i += 3) {
            triangles[to] = idx[i] + vo;
            triangles[to + 1] = idx[i + 1] + vo;
            triangles[to + 2] = idx[i + 2] + vo;
            triangles[to + 3] = matIdx;
            to += 4;
        }

        vo += count;
    }

    const triTotal = to / 4;

    // 缺法线：glTF 规范要求按面法线算（平直着色）。这里做顶点平滑，
    // 差别只在硬边处 —— 而没有法线的模型本来就没有硬边的意图。
    if (!hasNormals) {
        const synthetic = [];
        for (let t = 0; t < triTotal; t++) {
            synthetic.push({
                vertices: [
                    { pi: triangles[t * 4], ti: -1, ni: -1 },
                    { pi: triangles[t * 4 + 1], ti: -1, ni: -1 },
                    { pi: triangles[t * 4 + 2], ti: -1, ni: -1 },
                ],
            });
        }
        const smooth = computeSmoothNormals(positions, synthetic);
        for (let v = 0; v < vertexCount; v++) {
            const n = smooth[v];
            if (!n) continue;
            normals[v * 3] = n.x;
            normals[v * 3 + 1] = n.y;
            normals[v * 3 + 2] = n.z;
        }
    }

    // 切线：文件里有就用（导出器算的更准），没有就从 UV 反推。
    const tangents = hasTangents ? gTan : computeTangents(positions, normals, hasUvs ? uvs : null, triangles, triTotal);

    // 顶点交错排布：pos(3) + normal(3) + uv(2) + tangent(4)，与 Mesh IR 一致
    const vertexData = new Float32Array(vertexCount * 12);
    for (let v = 0; v < vertexCount; v++) {
        const d = v * 12;
        vertexData[d] = positions[v * 3];
        vertexData[d + 1] = positions[v * 3 + 1];
        vertexData[d + 2] = positions[v * 3 + 2];
        vertexData[d + 3] = normals[v * 3];
        vertexData[d + 4] = normals[v * 3 + 1];
        vertexData[d + 5] = normals[v * 3 + 2];
        vertexData[d + 6] = uvs[v * 2];
        vertexData[d + 7] = uvs[v * 2 + 1];
        vertexData[d + 8] = tangents[v * 4];
        vertexData[d + 9] = tangents[v * 4 + 1];
        vertexData[d + 10] = tangents[v * 4 + 2];
        vertexData[d + 11] = tangents[v * 4 + 3];
    }

    return new Mesh(
        vertexData,
        triangles,
        meshMaterials.length > 0 ? meshMaterials : [defaultPBRMaterial()],
        gm.name ?? name,
    );
}

/** 不支持的 primitive 在这里一次性挡掉，避免后面的解析报出看不懂的错。 */
function checkPrimitive(prim: GLTFPrimitive): void {
    if (prim.mode !== undefined && prim.mode !== MODE_TRIANGLES) {
        throw new Error(`glTF: 只支持三角形（mode 4），这个 primitive 是 mode ${prim.mode}`);
    }
    if (prim.attributes.POSITION === undefined) {
        throw new Error('glTF: primitive 没有 POSITION 属性');
    }
    if (prim.extensions && 'KHR_draco_mesh_compression' in prim.extensions) {
        throw new Error('glTF: 这个模型用了 Draco 压缩，需要先解压或改用未压缩导出');
    }
}

// 几何工具
//
// 只有 glTF 导入用得到：glTF 的顶点表可能缺法线、缺切线，三角形表是三个
// 索引一组（这里再补一位材质下标，变成四个）。程序化几何走 MeshBuilder，
// 自己有完整的顶点数据，不需要这些。

interface FaceVertex {
    pi: number;
    ti: number;
    ni: number;
}

function computeTangents(
    positions: Float32Array,
    normals: Float32Array,
    uvs: Float32Array | null,
    triIndices: Uint32Array,
    triCount: number,
): Float32Array {
    const n = positions.length / 3;
    const tangents = new Float32Array(n * 4);
    const tan1 = new Float32Array(n * 3);
    const tan2 = new Float32Array(n * 3);
    const triStride = triIndices.length / triCount;

    for (let t = 0; t < triCount; t++) {
        const off = t * triStride;
        const i0 = triIndices[off],
            i1 = triIndices[off + 1],
            i2 = triIndices[off + 2];
        const p0x = positions[i0 * 3],
            p0y = positions[i0 * 3 + 1],
            p0z = positions[i0 * 3 + 2];
        const p1x = positions[i1 * 3],
            p1y = positions[i1 * 3 + 1],
            p1z = positions[i1 * 3 + 2];
        const p2x = positions[i2 * 3],
            p2y = positions[i2 * 3 + 1],
            p2z = positions[i2 * 3 + 2];

        if (uvs) {
            const uv0x = uvs[i0 * 2],
                uv0y = uvs[i0 * 2 + 1];
            const uv1x = uvs[i1 * 2],
                uv1y = uvs[i1 * 2 + 1];
            const uv2x = uvs[i2 * 2],
                uv2y = uvs[i2 * 2 + 1];
            const e1x = p1x - p0x,
                e1y = p1y - p0y,
                e1z = p1z - p0z;
            const e2x = p2x - p0x,
                e2y = p2y - p0y,
                e2z = p2z - p0z;
            const du1 = uv1x - uv0x,
                dv1 = uv1y - uv0y;
            const du2 = uv2x - uv0x,
                dv2 = uv2y - uv0y;
            const denom = du1 * dv2 - du2 * dv1;
            if (Math.abs(denom) > 1e-12) {
                const r = 1.0 / denom;
                const tx = (e1x * dv2 - e2x * dv1) * r;
                const ty = (e1y * dv2 - e2y * dv1) * r;
                const tz = (e1z * dv2 - e2z * dv1) * r;
                const bx = (e2x * du1 - e1x * du2) * r;
                const by = (e2y * du1 - e1y * du2) * r;
                const bz = (e2z * du1 - e1z * du2) * r;
                for (const vi of [i0, i1, i2]) {
                    tan1[vi * 3] += tx;
                    tan1[vi * 3 + 1] += ty;
                    tan1[vi * 3 + 2] += tz;
                    tan2[vi * 3] += bx;
                    tan2[vi * 3 + 1] += by;
                    tan2[vi * 3 + 2] += bz;
                }
            }
        }
    }

    for (let i = 0; i < n; i++) {
        const nx = normals[i * 3],
            ny = normals[i * 3 + 1],
            nz = normals[i * 3 + 2];
        const tx = tan1[i * 3],
            ty = tan1[i * 3 + 1],
            tz = tan1[i * 3 + 2];
        const dotNT = nx * tx + ny * ty + nz * tz;
        let tanX = tx - dotNT * nx,
            tanY = ty - dotNT * ny,
            tanZ = tz - dotNT * nz;
        let tanLen = Math.sqrt(tanX * tanX + tanY * tanY + tanZ * tanZ);
        if (tanLen > 1e-12) {
            tanX /= tanLen;
            tanY /= tanLen;
            tanZ /= tanLen;
        } else {
            const absNx = Math.abs(nx),
                absNy = Math.abs(ny);
            let fx = 0,
                fy = 1,
                fz = 0;
            if (absNx < absNy) {
                fx = 1;
                fy = 0;
            }
            const fd = fx * nx + fy * ny + fz * nz;
            tanX = fx - fd * nx;
            tanY = fy - fd * ny;
            tanZ = fz - fd * nz;
            tanLen = Math.sqrt(tanX * tanX + tanY * tanY + tanZ * tanZ);
            if (tanLen > 1e-12) {
                tanX /= tanLen;
                tanY /= tanLen;
                tanZ /= tanLen;
            }
        }
        const bx = tan2[i * 3],
            by = tan2[i * 3 + 1],
            bz = tan2[i * 3 + 2];
        const handedness =
            (ny * tanZ - nz * tanY) * bx + (nz * tanX - nx * tanZ) * by + (nx * tanY - ny * tanX) * bz < 0 ? -1 : 1;
        tangents[i * 4] = tanX;
        tangents[i * 4 + 1] = tanY;
        tangents[i * 4 + 2] = tanZ;
        tangents[i * 4 + 3] = handedness;
    }
    return tangents;
}

function computeSmoothNormals(
    positions: Float32Array,
    faces: { vertices: FaceVertex[] }[],
): Record<number, { x: number; y: number; z: number }> {
    const acc: Record<number, { x: number; y: number; z: number }> = {};
    const addN = (vi: number, nx: number, ny: number, nz: number) => {
        if (acc[vi]) {
            acc[vi].x += nx;
            acc[vi].y += ny;
            acc[vi].z += nz;
        } else {
            acc[vi] = { x: nx, y: ny, z: nz };
        }
    };
    for (const face of faces) {
        const fv = face.vertices;
        for (let i = 1; i < fv.length - 1; i++) {
            const i0 = fv[0].pi,
                i1 = fv[i].pi,
                i2 = fv[i + 1].pi;
            const ax = positions[i0 * 3],
                ay = positions[i0 * 3 + 1],
                az = positions[i0 * 3 + 2];
            const bx = positions[i1 * 3],
                by = positions[i1 * 3 + 1],
                bz = positions[i1 * 3 + 2];
            const cx = positions[i2 * 3],
                cy = positions[i2 * 3 + 1],
                cz = positions[i2 * 3 + 2];
            let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay),
                ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az),
                nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (len > 1e-12) {
                nx /= len;
                ny /= len;
                nz /= len;
            }
            addN(i0, nx, ny, nz);
            addN(i1, nx, ny, nz);
            addN(i2, nx, ny, nz);
        }
    }
    for (const vi of Object.keys(acc)) {
        const nrm = acc[+vi];
        const len = Math.sqrt(nrm.x * nrm.x + nrm.y * nrm.y + nrm.z * nrm.z);
        if (len > 1e-12) {
            nrm.x /= len;
            nrm.y /= len;
            nrm.z /= len;
        }
    }
    return acc;
}

// 节点

/**
 * 沿节点树累乘变换，每个带 mesh 的节点产出一个 Instance。
 *
 * 变换留在 Instance 上而不是烤进顶点：同一个 mesh 被多个节点复用时，
 * 几何只该有一份（BLAS 按 mesh 建）。
 */
function buildInstances(doc: GLTFDocument, meshes: Mesh[]): Instance[] {
    const out: Instance[] = [];
    const sceneIndex = doc.scene ?? 0;
    const roots = doc.scenes?.[sceneIndex]?.nodes ?? doc.nodes.map((_, i) => i);

    const walk = (nodeIndex: number, parent: Float32Array): void => {
        const node = doc.nodes[nodeIndex];
        if (!node) return;
        const world = mulMat4(parent, localMatrix(node));

        if (node.mesh !== undefined) {
            const mesh = meshes[node.mesh];
            if (mesh) out.push(new Instance(mesh, world));
        }
        for (const child of node.children ?? []) walk(child, world);
    };

    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    for (const root of roots) walk(root, identity);
    return out;
}

function localMatrix(node: GLTFNode): Float32Array {
    if (node.matrix) return new Float32Array(node.matrix);

    const [tx, ty, tz] = node.translation ?? [0, 0, 0];
    const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
    const [sx, sy, sz] = node.scale ?? [1, 1, 1];

    // 四元数 → 旋转矩阵（列主序），再右乘缩放、写入平移
    const x2 = x + x,
        y2 = y + y,
        z2 = z + z;
    const xx = x * x2,
        xy = x * y2,
        xz = x * z2;
    const yy = y * y2,
        yz = y * z2,
        zz = z * z2;
    const wx = w * x2,
        wy = w * y2,
        wz = w * z2;
    return new Float32Array([
        (1 - (yy + zz)) * sx,
        (xy + wz) * sx,
        (xz - wy) * sx,
        0,
        (xy - wz) * sy,
        (1 - (xx + zz)) * sy,
        (yz + wx) * sy,
        0,
        (xz + wy) * sz,
        (yz - wx) * sz,
        (1 - (xx + yy)) * sz,
        0,
        tx,
        ty,
        tz,
        1,
    ]);
}

/** 列主序 4×4 相乘，out = a * b（先 b 后 a）。 */
function mulMat4(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
            out[c * 4 + r] = sum;
        }
    }
    return out;
}

// 贴图

function resolveUri(uri: string, baseUrl: string): string {
    if (/^https?:\/\//.test(uri) || uri.startsWith('data:') || uri.startsWith('blob:')) return uri;
    return baseUrl + uri.replace(/^\.\//, '');
}

/** 贴图来源的稳定标识：外链就是绝对 URL，内嵌就是「文件 + 图片下标」。 */
function imageKey(ctx: LoadContext, imageIndex: number): string | null {
    const image = ctx.doc.images?.[imageIndex];
    if (!image) return null;
    return image.uri ? resolveUri(image.uri, ctx.baseUrl) : `${ctx.baseUrl}#image=${imageIndex}`;
}

/** image 索引 → 可直接 fetch 的 URL。内嵌图片转成 blob URL（只转一次）。 */
function imageUrl(ctx: LoadContext, imageIndex: number): Promise<string | null> {
    const cached = ctx.imageUrls.get(imageIndex);
    if (cached) return cached;
    const job = (async (): Promise<string | null> => {
        const image = ctx.doc.images?.[imageIndex];
        if (!image) return null;
        if (image.uri) return resolveUri(image.uri, ctx.baseUrl);
        if (image.bufferView === undefined) return null;

        const key = imageKey(ctx, imageIndex);
        if (!key) return null;
        let blob = derivedBlobs.get(key);
        if (!blob) {
            const bv = ctx.doc.bufferViews[image.bufferView];
            const bytes = new Uint8Array(ctx.buffers[bv.buffer], bv.byteOffset ?? 0, bv.byteLength);
            blob = Promise.resolve(URL.createObjectURL(new Blob([bytes], { type: image.mimeType ?? 'image/png' })));
            derivedBlobs.set(key, blob);
        }
        return blob;
    })();
    ctx.imageUrls.set(imageIndex, job);
    return job;
}

/** texture 索引 → 可直接 fetch 的 URL。 */
function textureUrl(ctx: LoadContext, index: number): Promise<string | null> {
    const cached = ctx.textureUrls.get(index);
    if (cached) return cached;
    const job = (async (): Promise<string | null> => {
        const source = ctx.doc.textures?.[index]?.source;
        return source === undefined ? null : await imageUrl(ctx, source);
    })();
    ctx.textureUrls.set(index, job);
    return job;
}

/**
 * 打包图 → 单通道贴图（把指定的通道抄到 RGB）。
 *
 * glTF 用压缩打包：roughness 在 G、metallic 在 B、occlusion 在 R。
 * metallicRoughness 整张直接进 roughness 数组，G/B 各取所需；只有 AO 走这里 ——
 * occlusion 数组的采样读 .r，而 R 通道正好就是 AO，抄进 RGB 只是为了配合
 * 其他贴图「单通道图三通道同值」的习惯，不是必需，但代价只有一次转码。
 *
 * 只做重排、不做色彩转换（colorSpaceConversion: 'none'），所以数值不失真。
 * 派生结果按「源贴图 + 通道」缓存，同一张 ORM 图被多个材质引用只转一次。
 */
function channelUrl(
    ctx: LoadContext,
    index: number,
    channel: number,
    tag: string,
    cache: Map<number, Promise<string | null>>,
): Promise<string | null> {
    const cached = cache.get(index);
    if (cached) return cached;
    const job = (async (): Promise<string | null> => {
        // 键按「源贴图」而不是按 glTF 材质：同一张 ARM 图被多个材质引用时只转一次，
        // 而且换场景再加载回来仍然命中同一条缓存，不会多吃一层。
        const tex = ctx.doc.textures?.[index];
        const key = tex?.source !== undefined ? imageKey(ctx, tex.source) : null;
        if (!key) return null;
        const id = `${tag}:${key}`;
        const hit = derivedBlobs.get(id);
        if (hit) return hit;

        const job = (async (): Promise<string | null> => {
            const url = await textureUrl(ctx, index);
            if (!url) return null;
            const resp = await fetch(url);
            if (!resp.ok) return null;
            const bitmap = await createImageBitmap(await resp.blob(), { colorSpaceConversion: 'none' });
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const c2d = canvas.getContext('2d');
            if (!c2d) throw new Error('glTF: 2D context 不可用，无法重排 metallicRoughness');
            c2d.drawImage(bitmap, 0, 0);
            const px = c2d.getImageData(0, 0, bitmap.width, bitmap.height);
            const d = px.data;
            for (let i = 0; i < d.length; i += 4) {
                const v = d[i + channel];
                d[i] = v;
                d[i + 1] = v;
                d[i + 2] = v;
            }
            c2d.putImageData(px, 0, 0);
            bitmap.close();
            return URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' }));
        })();
        derivedBlobs.set(id, job);
        return job;
    })();
    cache.set(index, job);
    return job;
}

/**
 * texture 索引 → 解码好的 Image。
 *
 * URL 那一层只是为了命中解码缓存（内嵌图要先转 blob URL）：loadTexture 按
 * kind + URL 去重，同一张图被多个材质引用时拿到的是同一个 Image 对象。
 */
async function textureImage(
    ctx: LoadContext,
    index: number,
    kind: TextureKind,
): Promise<Image | undefined> {
    const url = await textureUrl(ctx, index);
    return url ? await loadTexture(url, kind) : undefined;
}

/** occlusion 的 R 通道 → AO 图。 */
function occlusionUrl(ctx: LoadContext, index: number): Promise<string | null> {
    return channelUrl(ctx, index, 0, 'ao', ctx.occlusionUrls);
}

// 材质

async function convertMaterial(gm: GLTFMaterial, ctx: LoadContext): Promise<PBRMaterial> {
    const mat = defaultPBRMaterial();
    const pbr = gm.pbrMetallicRoughness ?? {};

    const [r, g, b, a] = pbr.baseColorFactor ?? [1, 1, 1, 1];
    mat.baseColor = { r, g, b, a };
    mat.metallic = pbr.metallicFactor ?? 1;
    mat.roughness = pbr.roughnessFactor ?? 1;

    if (pbr.baseColorTexture) {
        mat.baseColorTexture = await textureImage(ctx, pbr.baseColorTexture.index, 'albedo');
    }
    if (gm.normalTexture) {
        mat.normalTexture = await textureImage(ctx, gm.normalTexture.index, 'normal');
        mat.normalScale = gm.normalTexture.scale ?? 1;
    }
    if (pbr.metallicRoughnessTexture) {
        // 整张 RGBA 原样保留：G 是粗糙度、B 是金属度，shader 各取所需。
        // 早先这里只抽出 G 通道、丢掉 B —— 金属度就永远停在标量上。
        mat.metallicRoughnessTexture = await textureImage(
            ctx,
            pbr.metallicRoughnessTexture.index,
            'roughness',
        );
    }
    if (gm.occlusionTexture) {
        const url = await occlusionUrl(ctx, gm.occlusionTexture.index);
        if (url) mat.occlusionTexture = await loadTexture(url, 'occlusion');
        mat.occlusionStrength = gm.occlusionTexture.strength ?? 1;
    }

    return mat;
}
