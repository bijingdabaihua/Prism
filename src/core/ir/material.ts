import type { Color } from '../../math/types';
import type { Image } from './image';
import { loadTexture } from '../loaders/texture';
import { loadImage } from '../loaders/image';

/**
 * 渲染器内部统一的材质表达。
 *
 * glTF 的材质在 loaders/gltf.ts 里映射成构造参数；.blend 的解析器就在这个文件
 * 末尾，由 `buildByBlend` 驱动。映射是有损的，损失多少由各导入器自己负责说明。
 * GPU 打包在 engine/model/material/packing.ts。
 *
 * 贴图字段是解码后的 Image，不是 URL —— IR 里不留文件路径，导入器在场景加载时
 * 就把图解开，编译层拿到的全是内存里的像素。
 */
export class PBRMaterial {
    /**
     * 从 `.blend` 的材质节点图构造。解析代码在这个文件末尾。
     *
     * `meters` 是一格贴图覆盖的真实尺寸：Blender 里它记在场景 / 物体上，
     * 材质文件里没有，只能由调用方给。
     */
    public static async buildByBlend(url: string, meters?: number): Promise<PBRMaterial> {
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

        const options: PBRMaterialOptions = {};
        const metallic = scalar(blend, surface, 'Metallic');
        const roughness = scalar(blend, surface, 'Roughness');
        if (metallic !== undefined) options.metallic = metallic;
        if (roughness !== undefined) options.roughness = roughness;

        const baseColorTex = tex(blend, baseUrl, surface, 'Base Color');
        if (baseColorTex) options.baseColorTexture = await loadTexture(baseColorTex.path, 'albedo', meters);

        // Roughness 在 Blender 里是 float 插槽，接一张彩色图时按灰度取。我们的
        // roughness 通道读 .r，灰度图三通道同值，等价。
        const roughnessTex = tex(blend, baseUrl, surface, 'Roughness');
        if (roughnessTex) {
            options.roughnessTexture = await loadTexture(roughnessTex.path, 'roughness', meters);
            options.roughness = 1;
        }

        const normalTex = tex(blend, baseUrl, surface, 'Normal');
        if (normalTex) {
            options.normalTexture = await loadTexture(normalTex.path, 'normal', meters);
            options.normalScale = normalTex.strength ?? 1;
        }

        const height = await displacement(blend, baseUrl, output, meters);
        if (height) {
            options.displacement = height.image;
            options.displacementMid = height.mid;
            options.displacementScale = height.scale;
        }

        return new PBRMaterial(options);
    }

    public readonly baseColor: Color;
    public readonly metallic: number;
    public readonly roughness: number;
    public readonly baseColorTexture?: Image;
    /**
     * glTF 的 metallic-roughness 打包图：G = 粗糙度，B = 金属度，R = 环境光遮蔽。
     * Poly Haven 的 arm 图（AO / Rough / Metal）是同一套通道排列，可以直接用。
     *
     * metallic / roughness 两个标量在这条路径上是**乘数**（glTF 的
     * metallicFactor / roughnessFactor），不是覆盖值 —— 金属度终于能随贴图变化了。
     */
    public readonly metallicRoughnessTexture?: Image;
    /**
     * 单通道粗糙度图（Poly Haven 的 Rough 图）。
     *
     * 和 metallicRoughnessTexture 同时设置时，粗糙度以后者为准、这条路径只覆盖
     * 粗糙度（金属度仍从打包图取）；同一张贴图不必按两种 kind 注册两次。
     */
    public readonly roughnessTexture?: Image;
    public readonly normalTexture?: Image;
    public readonly normalScale: number;
    public readonly occlusionTexture?: Image;
    public readonly occlusionStrength: number;
    /**
     * 位移贴图：灰度高度图，和 albedo 一样按它自己的 `meters` 重复。
     *
     * 有它的材质，三角形在进渲染前会被细分、按图抬起（见 `ir/mesh.ts` 的
     * `Mesh.evolve`）。只看三角形自己的 UV，不看位置。演化之后这张图就被
     * **消耗**掉了 —— 上 GPU 的材质里不再有它，着色器也从来不知道它存在。
     *
     * 有图就必须给 `displacementMid` 和 `displacementScale`。格距不用给 ——
     * 由图的一格几米和像素宽度算出来（一个 texel 一格）。
     */
    public readonly displacement?: Image;
    /**
     * 高度零点：图上这个灰度值当作「不抬不陷」，对应 Blender Displacement
     * 节点的 Midlevel。扫描图存的不是绝对高度，零点只能由材质作者定。
     */
    public readonly displacementMid?: number;
    /**
     * 高度刻度（米）：灰度每差 1.0 位移这么多，对应 Blender Displacement
     * 节点的 Scale。位移量 = `(高度 - displacementMid) × displacementScale`。
     */
    public readonly displacementScale?: number;

    constructor(options: PBRMaterialOptions = {}) {
        this.baseColor = options.baseColor ?? { r: 0.85, g: 0.85, b: 0.85, a: 1 };
        this.metallic = options.metallic ?? 0;
        this.roughness = options.roughness ?? 0.5;
        this.baseColorTexture = options.baseColorTexture;
        this.metallicRoughnessTexture = options.metallicRoughnessTexture;
        this.roughnessTexture = options.roughnessTexture;
        this.normalTexture = options.normalTexture;
        this.normalScale = options.normalScale ?? 1;
        this.occlusionTexture = options.occlusionTexture;
        this.occlusionStrength = options.occlusionStrength ?? 1;
        this.displacement = options.displacement;
        this.displacementMid = options.displacementMid;
        this.displacementScale = options.displacementScale;
    }

    /**
     * 去掉位移贴图和相关刻度，返回可以直接上 GPU 的材质。
     *
     * `Mesh.evolve` 把位移烘成几何时调用：位移进 GPU 之前必须消失，着色器
     * 不知道它存在，材质 SSBO 里也没有这一格。没有位移时原样返回（`===` 自己）。
     */
    public withoutDisplacement(): PBRMaterial {
        if (!this.displacement) return this;
        const {
            displacement: _image,
            displacementMid: _mid,
            displacementScale: _scale,
            ...rest
        } = this;
        return new PBRMaterial(rest);
    }
}

/**
 * 构造参数。省略的字段取默认值：0.85 灰、非金属、粗糙度 0.5、
 * 法线强度 1、遮蔽强度 1。
 */
export interface PBRMaterialOptions {
    baseColor?: Color;
    metallic?: number;
    roughness?: number;
    baseColorTexture?: Image;
    metallicRoughnessTexture?: Image;
    roughnessTexture?: Image;
    normalTexture?: Image;
    normalScale?: number;
    occlusionTexture?: Image;
    occlusionStrength?: number;
    displacement?: Image;
    displacementMid?: number;
    displacementScale?: number;
}

/** 材质贴图的四个通道：决定进哪个 texture_2d_array，也决定要不要 sRGB 解码。 */
export type TextureKind = 'albedo' | 'normal' | 'roughness' | 'occlusion';

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
function tex(blend: BlendFile, baseUrl: string, node: Block, socketName: string): TexImage | undefined {
    let source = upstream(blend, node, socketName);
    let strength: number | undefined;
    if (source && (blend.read(source, 'idname') as string) === 'ShaderNodeNormalMap') {
        strength = scalar(blend, source, 'Strength');
        source = upstream(blend, source, 'Color');
    }
    if (!source) return undefined;
    const image = imageOf(blend, baseUrl, source);
    return image ? { ...image, strength } : undefined;
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
