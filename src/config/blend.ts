import type { Image } from '../ir/image';
import type { PBRMaterial } from '../ir/material';
import { defaultPBRMaterial } from '../ir/material';
import { loadTexture } from './load-texture';
import { loadImage } from './load-image';

/**
 * .blend 材质导入器：文件 → PBRMaterial。
 *
 * 为什么不走 glTF：glTF 没有位移，材质作者的位移刻度（Blender 的 Midlevel /
 * Scale）只能自己写在 extras 里，等于把唯一权威源抄一遍。MaterialX 有位移节点，
 * 但没有 Midlevel，而且 Poly Haven 自己发的 .mtlx 和 .blend 的 Scale 都对不上。
 * .blend 是作者真正在用的那个文件，两个数都在里面。
 *
 * .blend 是内存 dump：文件头 + 一串内存块，每块带 SDNA 索引；DNA1 块里带着
 * 这份文件自己的 struct 定义（类型名 / 字段名 / 长度）。知道 SDNA 就能把块当
 * 结构体读 —— 这也是它版本兼容的方式：字段位置是文件自己声明的，不是猜的。
 *
 * 这里**不做**通用节点图求值。只认 Poly Haven 那条固定链路：
 *
 *   TexImage ─┬─→ Principled.Base Color
 *             ├─→ Principled.Roughness
 *             ├─→ NormalMap → Principled.Normal
 *             └─→ Displacement.Height → Output.Displacement
 *
 * 遇到不认识的节点（Mix / ColorRamp / 节点组……）直接抛错。猜错的材质比加载
 * 失败更糟：它会让一张图看起来"差不多对"，然后没人再去查。
 */

// 文件格式

interface Block {
    code: string;
    sdna: number;
    /**
     * 写入时的内存地址，用来还原指针引用。
     *
     * 必须是 BigInt：这是 64 位 dump 出来的真实地址（本例 0x5b46ff59012d4d80），
     * 越过 2^53 后 number 会按 1024 的间隔取整，不同指针会撞成一个值 —— 链表
     * 就会走到别的块上去。
     */
    old: bigint;
    nr: number;
    /** 块数据在文件里的偏移 */
    offset: number;
    len: number;
    /**
     * 归属的 ID 块（在 blocks 里的下标）。
     *
     * .blend 里 `old` 地址只保证在**同一个 ID 内**唯一：材质、合成器、灯光组
     * 各自一套节点树，卸载后地址会被复用。所以按 DATA 指针找块必须先限定
     * 在同一个 ID 里，否则会拿到另一棵树里的同名地址。
     */
    owner: number;
}

interface FieldDef {
    name: string;
    type: string;
    offset: number;
    size: number;
    count: number;
    ptr: boolean;
}

interface StructDef {
    name: string;
    fields: Map<string, FieldDef>;
}

/** zstd 压缩的 .blend（Blender 3.0 起默认如此）。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

async function decompress(buf: ArrayBuffer): Promise<ArrayBuffer> {
    const head = new Uint8Array(buf, 0, 4);
    if (!ZSTD_MAGIC.every((b, i) => head[i] === b)) return buf;
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('.blend 是 zstd 压缩的，但这个浏览器没有 DecompressionStream("zstd")');
    }
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('zstd' as CompressionFormat));
    return new Response(stream).arrayBuffer();
}

/**
 * 一份解析好的 .blend：块表 + SDNA。
 *
 * 只实现读，不实现写；只做小端。
 */
class BlendFile {
    private readonly bytes: Uint8Array;
    private readonly view: DataView;
    private readonly structs: StructDef[] = [];
    private readonly blocks: Block[] = [];
    /** ID 指针 → 块（ID 地址全文件唯一）。 */
    private readonly byOld = new Map<bigint, Block>();
    /** ID 下标 → (地址 → 块)，DATA 指针只在所属 ID 内可信。 */
    private readonly byOwner = new Map<number, Map<bigint, Block>>();

    constructor(buffer: ArrayBuffer) {
        this.bytes = new Uint8Array(buffer);
        this.view = new DataView(buffer);
        this.readAll();
    }

    // 结构体

    /** 某个结构体的所有块，按结构名取。 */
    public blocksOf(structName: string): Block[] {
        return this.blocks.filter((b) => this.structOf(b)?.name === structName);
    }

    public structOf(block: Block): StructDef | undefined {
        return this.structs[block.sdna];
    }

    /** 按地址找一个块。给了上下文块就在同一个 ID 里找，否则回落到全局。 */
    public blockAt(ptr: bigint, near?: Block): Block | undefined {
        if (!ptr) return undefined;
        if (near) {
            const scoped = this.byOwner.get(near.owner)?.get(ptr);
            if (scoped) return scoped;
        }
        return this.byOld.get(ptr);
    }

    /** 读字段。指针返回地址（bigint），其余返回 number（char 数组返回 string）。 */
    public read(block: Block, field: string, index = 0): number | string | bigint {
        const def = this.structOf(block);
        const f = def?.fields.get(field);
        if (!f) throw new Error(`.blend: ${def?.name ?? '?'} 没有字段 ${field}`);
        const at = block.offset + f.offset + index * f.size;
        if (f.ptr) return this.view.getBigUint64(at, true);
        if (f.type === 'char') {
            let end = at;
            while (end < at + f.count * f.size && this.bytes[end] !== 0) end++;
            return new TextDecoder().decode(this.bytes.subarray(at, end));
        }
        switch (f.type) {
            case 'float':
                return this.view.getFloat32(at, true);
            case 'int':
            case 'int32_t':
                return this.view.getInt32(at, true);
            case 'short':
            case 'int16_t':
                return this.view.getInt16(at, true);
            case 'uint8_t':
                return this.bytes[at];
            case 'int8_t':
                return this.view.getInt8(at);
            default:
                throw new Error(`.blend: 不会读字段类型 ${f.type}`);
        }
    }

    /** 跟一个指针字段，拿到它指向的块。空指针返回 undefined。 */
    public deref(block: Block, field: string): Block | undefined {
        return this.blockAt(this.read(block, field) as bigint, block);
    }

    /** 读嵌在结构体里的子结构体的字符串字段（`Image.colorspace_settings.name`）。 */
    public readNestedString(block: Block, structField: string, field: string): string {
        const def = this.structOf(block);
        const outer = def?.fields.get(structField);
        const inner = this.structs.find((s) => s.name === outer?.type)?.fields.get(field);
        if (!outer || !inner) throw new Error(`.blend: ${def?.name ?? '?'}.${structField}.${field} 不存在`);
        const at = block.offset + outer.offset + inner.offset;
        let end = at;
        while (this.bytes[end] !== 0) end++;
        return new TextDecoder().decode(this.bytes.subarray(at, end));
    }

    /** ListBase { first, last }：第一个元素 + 靠 next 串起来的链表。 */
    public list(block: Block, field: string): Block[] {
        const def = this.structOf(block);
        const f = def?.fields.get(field);
        if (!f) throw new Error(`.blend: ${def?.name ?? '?'} 没有字段 ${field}`);
        let at = this.view.getBigUint64(block.offset + f.offset, true);
        const out: Block[] = [];
        while (at) {
            const node = this.blockAt(at, block);
            if (!node || !this.structOf(node)?.fields.has('next')) break;
            out.push(node);
            at = this.read(node, 'next') as bigint;
        }
        return out;
    }

    // 解析

    private readAll(): void {
        const h = this.bytes;
        const magic = String.fromCharCode(...h.subarray(0, 7));
        if (magic !== 'BLENDER') throw new Error('不是 .blend 文件');

        // v0：12 字节头（'BLENDER' + 指针宽度 + 端序 + 3 位版本）
        // v1：17 字节头（Blender 5.0 起，块头固定 LargeBHead8）
        const v1 = h[7] === 0x31 && h[8] === 0x37;
        if (!v1 && h[8] !== 0x76) throw new Error('.blend: 只支持小端文件');
        const pointerSize = v1 ? 8 : h[7] === 0x2d ? 8 : 4;
        if (pointerSize !== 8) throw new Error('.blend: 只支持 64 位指针的文件');

        let pos = v1 ? 17 : 12;
        let currentId = -1;
        while (pos + 32 <= h.length) {
            let code: string;
            let sdna: number;
            let old: bigint;
            let len: number;
            let nr: number;
            if (v1) {
                // LargeBHead8: code, sdna, old, len, nr
                code = this.codeAt(pos);
                sdna = this.view.getInt32(pos + 4, true);
                old = this.view.getBigUint64(pos + 8, true);
                len = Number(this.view.getBigInt64(pos + 16, true));
                nr = Number(this.view.getBigInt64(pos + 24, true));
                pos += 32;
            } else {
                // SmallBHead8: code, len, old, sdna, nr
                code = this.codeAt(pos);
                len = this.view.getInt32(pos + 4, true);
                old = this.view.getBigUint64(pos + 8, true);
                sdna = this.view.getInt32(pos + 16, true);
                nr = this.view.getInt32(pos + 20, true);
                pos += 24;
            }
            if (code === 'ENDB') break;
            if (code === 'DNA1') this.parseSDNA(pos);
            // 两字符的块码是 ID 块（MA / NT / IM / OB …），它后面的 DATA 都归它
            if (code.length === 2) currentId = this.blocks.length;
            const block: Block = { code, sdna, old, nr, offset: pos, len, owner: currentId };
            this.blocks.push(block);
            if (old) {
                this.byOld.set(old, block);
                let scoped = this.byOwner.get(block.owner);
                if (!scoped) this.byOwner.set(block.owner, (scoped = new Map()));
                scoped.set(old, block);
            }
            pos += len;
            // 块之间按 8 字节对齐
            if (pos % 8 && this.codeAtOrNull(pos) === null) pos += 8 - (pos % 8);
        }
    }

    private codeAt(pos: number): string {
        const c = this.codeAtOrNull(pos);
        if (c === null) throw new Error(`.blend: 偏移 ${pos} 处不是块头`);
        return c;
    }

    /** 块码：4 字符（'DATA'）或 2 字符 + 补零（'OB'）。 */
    private codeAtOrNull(pos: number): string | null {
        if (pos + 4 > this.bytes.length) return null;
        let end = pos;
        while (end < pos + 4 && this.bytes[end] !== 0) end++;
        if (end === pos) return null;
        for (let i = pos; i < end; i++) {
            const c = this.bytes[i];
            if (c < 32 || c > 126) return null;
        }
        return String.fromCharCode(...this.bytes.subarray(pos, end));
    }

    /** DNA1：类型名 / 字段名 / 类型长度 / 结构体定义，全是文件自己带的。 */
    private parseSDNA(at: number): void {
        const dv = this.view;
        let p = at;
        const tag = (t: string): void => {
            const s = String.fromCharCode(...this.bytes.subarray(p, p + 4));
            if (s !== t) throw new Error(`.blend: 期望 ${t}，读到 ${s}`);
            p += 4;
        };
        const align = (): void => {
            p = (p + 3) & ~3;
        };
        const strList = (): string[] => {
            const n = dv.getInt32(p, true);
            p += 4;
            const out: string[] = [];
            for (let i = 0; i < n; i++) {
                let e = p;
                while (this.bytes[e] !== 0) e++;
                out.push(String.fromCharCode(...this.bytes.subarray(p, e)));
                p = e + 1;
            }
            align();
            return out;
        };

        tag('SDNA');
        tag('NAME');
        const names = strList();
        tag('TYPE');
        const types = strList();
        tag('TLEN');
        // TLEN 没有计数：长度个数就等于类型个数
        const sizes: number[] = [];
        for (let i = 0; i < types.length; i++) {
            sizes.push(dv.getInt16(p, true));
            p += 2;
        }
        align();
        tag('STRC');
        const count = dv.getInt32(p, true);
        p += 4;

        for (let i = 0; i < count; i++) {
            const typeIdx = dv.getInt16(p, true);
            const nfields = dv.getInt16(p + 2, true);
            p += 4;
            const fields = new Map<string, FieldDef>();
            let offset = 0;
            for (let f = 0; f < nfields; f++) {
                const ft = dv.getInt16(p, true);
                const fn = dv.getInt16(p + 2, true);
                p += 4;
                const rawName = names[fn];
                const type = types[ft];
                // SDNA 把指针和数组都写在字段名里：'*next'、'name[64]'
                const ptr = rawName.startsWith('*');
                let name = rawName.replace(/^\*/, '');
                let count = 1;
                const bracket = name.indexOf('[');
                if (bracket >= 0) {
                    count = parseInt(name.slice(bracket + 1), 10);
                    name = name.slice(0, bracket);
                }
                const base = ptr ? 8 : sizes[ft];
                const align = Math.min(Math.max(base, 1), 8);
                offset = Math.ceil(offset / align) * align;
                fields.set(name, { name, type, offset, size: base, count, ptr });
                offset += base * count;
            }
            this.structs.push({ name: types[typeIdx], fields });
        }
    }
}

// 节点图 → 材质

/** 按 URL 缓存解析结果：一份 .blend 被多次加载时只解一次。 */
const documents = new Map<string, Promise<BlendFile>>();

async function openBlend(url: string): Promise<BlendFile> {
    let job = documents.get(url);
    if (!job) {
        job = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`Failed to load ${url} (${resp.status})`);
            return new BlendFile(await decompress(await resp.arrayBuffer()));
        })();
        documents.set(url, job);
    }
    return job;
}

/** 材质的一张贴图：文件 + 解码规则，还没真正加载。 */
interface TexImage {
    /** 相对 .blend 的路径（`//textures/x.png`） */
    path: string;
    srgb: boolean;
    /** NormalMap 节点上的强度 */
    strength?: number;
}

const SRGB_SPACES = new Set(['sRGB', 'Filmic sRGB']);

/**
 * 把一个 `.blend` 读成 PBRMaterial。
 *
 * `meters` 只能由调用方给：一格贴图覆盖多大是资产的物理尺寸，Blender 里
 * 它记在场景/物体上，不在材质里，文件里根本没有这个数（Poly Haven 放在
 * 网页 API 的 `dimensions` 里）。
 */
export async function loadBlendMaterial(url: string, meters?: number): Promise<PBRMaterial> {
    const blend = await openBlend(url);
    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);

    // 节点块的 SDNA 结构都叫 bNode，具体是哪种节点看 idname 字段
    const nodes = blend.blocksOf('bNode');
    const output = nodes.find((n) => blend.read(n, 'idname') === 'ShaderNodeOutputMaterial');
    if (!output) throw new Error(`${url}: 没有 Material Output 节点`);

    const surface = upstream(blend, output, 'Surface');
    if (!surface) throw new Error(`${url}: Material Output 的 Surface 没接东西`);
    const bsdfType = blend.read(surface, 'idname') as string;
    if (bsdfType !== 'ShaderNodeBsdfPrincipled') {
        throw new Error(`${url}: 只支持 Principled BSDF，这张材质接的是 ${bsdfType}`);
    }

    const mat = defaultPBRMaterial();
    const metallic = scalar(blend, surface, 'Metallic');
    const roughness = scalar(blend, surface, 'Roughness');
    if (metallic !== undefined) mat.metallic = metallic;
    if (roughness !== undefined) mat.roughness = roughness;

    const baseColorTex = await tex(blend, baseUrl, surface, 'Base Color');
    if (baseColorTex) mat.baseColorTexture = await loadTexture(baseColorTex.path, 'albedo', meters);

    // Roughness 在 Blender 里是 float 插槽，接一张彩色图时按灰度取。我们的
    // roughness 通道读 .r，灰度图三通道同值，等价。
    const roughnessTex = await tex(blend, baseUrl, surface, 'Roughness');
    if (roughnessTex) {
        mat.roughnessTexture = await loadTexture(roughnessTex.path, 'roughness', meters);
        mat.roughness = 1;
    }

    const normalTex = await tex(blend, baseUrl, surface, 'Normal');
    if (normalTex) {
        mat.normalTexture = await loadTexture(normalTex.path, 'normal', meters);
        mat.normalScale = normalTex.strength ?? 1;
    }

    const height = await displacement(blend, baseUrl, output, meters);
    if (height) {
        mat.displacement = height.image;
        mat.displacementMid = height.mid;
        mat.displacementScale = height.scale;
    }

    return mat;
}

/** 某个输入插槽接的上游节点。没有连线时返回 undefined。 */
function upstream(blend: BlendFile, node: Block, socketName: string): Block | undefined {
    const socket = socketOf(blend, node, 'inputs', socketName);
    if (!socket) return undefined;
    const links = blend.blocksOf('bNodeLink');
    for (const link of links) {
        if ((blend.read(link, 'tosock') as bigint) === socket.old) {
            const from = blend.read(link, 'fromnode') as bigint;
            return blend.blockAt(from, node);
        }
    }
    return undefined;
}

/** 没接线的输入插槽上的标量默认值。 */
function scalar(blend: BlendFile, node: Block, socketName: string): number | undefined {
    const socket = socketOf(blend, node, 'inputs', socketName);
    if (!socket) return undefined;
    const value = blend.deref(socket, 'default_value');
    if (!value) return undefined;
    return Number((blend.read(value, 'value') as number).toFixed(6));
}

function socketOf(
    blend: BlendFile,
    node: Block,
    list: 'inputs' | 'outputs',
    name: string,
): Block | undefined {
    for (const s of blend.list(node, list)) {
        if ((blend.read(s, 'name') as string) === name) return s;
    }
    return undefined;
}

/** 顺着 NormalMap 往下找到贴图，顺手带上它的强度。 */
async function tex(
    blend: BlendFile,
    baseUrl: string,
    node: Block,
    socketName: string,
): Promise<TexImage | undefined> {
    let source = upstream(blend, node, socketName);
    let strength: number | undefined;
    if (source && (blend.read(source, 'idname') as string) === 'ShaderNodeNormalMap') {
        strength = scalar(blend, source, 'Strength');
        source = upstream(blend, source, 'Color');
    }
    return source ? imageOf(blend, baseUrl, source) : undefined;
}

/** 贴图节点 → 文件路径 + 色彩空间。中间夹的 Mapping / Reroute 必须是恒等变换。 */
function imageOf(blend: BlendFile, baseUrl: string, node: Block): TexImage | undefined {
    const idname = blend.read(node, 'idname') as string;
    if (idname === 'NodeReroute') return rewrite(blend, baseUrl, node);
    if (idname !== 'ShaderNodeTexImage') {
        throw new Error(`.blend: 只支持直接接图片贴图，这一路接的是 ${idname}`);
    }

    const image = blend.deref(node, 'id');
    if (!image) return undefined;
    const path = blend.read(image, 'name') as string;
    const space = blend.readNestedString(image, 'colorspace_settings', 'name');

    // 现成的 .blend 里 UV 会先过一个 Mapping（Location/Rotation/Scale）。非恒等
    // 的 Mapping 会改变贴图的重复方式，我们没法用「一格几米」表达，宁可报错。
    const vector = upstream(blend, node, 'Vector');
    if (vector) checkMapping(blend, vector);

    return { path: resolveImageUrl(baseUrl, path), srgb: SRGB_SPACES.has(space) };
}

function rewrite(blend: BlendFile, baseUrl: string, node: Block): TexImage | undefined {
    const next = upstream(blend, node, 'Input');
    return next ? imageOf(blend, baseUrl, next) : undefined;
}

function checkMapping(blend: BlendFile, node: Block): void {
    const idname = blend.read(node, 'idname') as string;
    if (idname === 'NodeReroute') {
        const next = upstream(blend, node, 'Input');
        if (next) checkMapping(blend, next);
        return;
    }
    if (idname === 'ShaderNodeTexCoord') return;
    if (idname !== 'ShaderNodeMapping') {
        throw new Error(`.blend: 贴图坐标只支持 UV / 单位 Mapping，接的是 ${idname}`);
    }
    const scale = vectorOf(blend, node, 'Scale');
    if (scale.some((v) => Math.abs(v - 1) > 1e-6)) {
        throw new Error(`.blend: Mapping 的缩放不是 1（${scale.join(', ')}），当前不支持`);
    }
}

function vectorOf(blend: BlendFile, node: Block, socketName: string): number[] {
    const socket = socketOf(blend, node, 'inputs', socketName);
    const value = socket ? blend.deref(socket, 'default_value') : undefined;
    if (!value) return [];
    return [0, 1, 2].map((i) => blend.read(value, 'value', i) as number);
}

/** Displacement 节点 → 高度图 + 零点 + 刻度。 */
async function displacement(
    blend: BlendFile,
    baseUrl: string,
    output: Block,
    meters?: number,
): Promise<{ image: Image; mid: number; scale: number } | undefined> {
    const node = upstream(blend, output, 'Displacement');
    if (!node) return undefined;
    const idname = blend.read(node, 'idname') as string;
    if (idname !== 'ShaderNodeDisplacement') {
        throw new Error(`.blend: 位移输入接的是 ${idname}，只支持 Displacement 节点`);
    }
    const source = upstream(blend, node, 'Height');
    if (!source) throw new Error('.blend: Displacement 节点的 Height 没接东西');
    const tex = imageOf(blend, baseUrl, source);
    if (!tex) throw new Error('.blend: Displacement 的 Height 没接到图片');

    const mid = scalar(blend, node, 'Midlevel');
    const scale = scalar(blend, node, 'Scale');
    if (mid === undefined || scale === undefined) {
        throw new Error('.blend: Displacement 节点缺 Midlevel / Scale');
    }

    const image = await loadImage(tex.path, { srgb: tex.srgb, layout: 'texture', meters });
    return { image, mid, scale };
}

/** `//textures/x.png` 是相对 .blend 的路径；绝对路径原样返回。 */
function resolveImageUrl(baseUrl: string, path: string): string {
    if (path.startsWith('//')) return baseUrl + path.slice(2);
    return path;
}
