import type { RenderContext } from '../../context';
import type { Model } from '../../model/model';
import type { Background } from '../../background';
import type { TextureSet } from '../../model/material/texture/texture-set';
import { buildPixelOrder } from './pixel-order';
import structs from './structs.wgsl?raw';
import aabb from './aabb.wgsl?raw';
import intersect from './intersect.wgsl?raw';
import bvh from './bvh.wgsl?raw';
import shade from './shade.wgsl?raw';
import main from './main.wgsl?raw';

/** 每帧至少采样的像素数（再慢也不低于这个，保证拖动时画面不是全黑）。 */
const MIN_DISPATCH = 4096;
/** 1D dispatch 的 workgroup 大小。 */
const WORKGROUP_SIZE = 64;
/** dispatchWorkgroups 的单维上限是 65535，这里换算成像素数。 */
const MAX_DISPATCH = 65535 * WORKGROUP_SIZE;
/** GPU 实测耗时还没回来之前用的帧预算（约 60Hz 的 75%）。 */
const DEFAULT_TARGET_MS = 12.5;
/** 显示 blit + 提交间隙的固定预留（毫秒），从每帧预算里先扣掉。 */
const FIXED_RESERVE_MS = 0.5;

/**
 * 路径追踪 compute pass。
 *
 * 每帧只采样屏幕的一部分像素：顺序表是 0..W*H-1 的随机排列，游标从表头开始
 * 每帧取连续的一段，一轮正好覆盖每个像素一次。dispatch 是 1D 的 —— 一个线程
 * 对应表里的一个像素，采样量由 GPU 实测耗时自适应（见 reportFrameTime）。
 *
 * 累加平均的分母不需要逐像素存储：顺序表每跨过 W*H 个采样，所有像素恰好
 * 各多采一次，所以「该像素之前采过几次」= 已完成轮数 (+ 本帧是否跨轮)。
 */
export class PathTracePass {
    /**
     * 路径弹射次数上限，写入 shader uniform（u.max_bounces）。
     *
     * 这只是安全上限：shader 里在第 4 次弹射之后开俄罗斯轮盘赌，正常路径
     * 按吞吐量自己决定要不要继续。设成 12 是为了防止极端情况下的死循环。
     */
    public maxBounces = 12;
    /** Bumped on every accumulation-texture rebuild; drives Display blit bind-group invalidation. */
    public radianceVersion = 0;

    private context: RenderContext;
    private model: Model;
    private cameraUniform: GPUBuffer;
    private background: Background;
    private textures: TextureSet;
    private width = 0;
    private height = 0;
    private pixelCount = 0;
    /** Set by onResize; consumed (rebuild) at the next record(). */
    private resizeDirty = false;
    private pipeline?: GPUComputePipeline;
    /** 降噪引导的入口（同一个 shader 模块的 `guides` entry point）。 */
    private guidePipeline?: GPUComputePipeline;
    private bgl?: GPUBindGroupLayout;
    /** 环境图采样器：u 环绕、v 夹边，与材质贴图那个 repeat/repeat 分开。 */
    private readonly envSampler: GPUSampler;
    private uniformBuf?: GPUBuffer;
    private accumTextures: [GPUTexture?, GPUTexture?] = [undefined, undefined];
    private accumViews: [GPUTextureView?, GPUTextureView?] = [undefined, undefined];
    /** 降噪引导：xyz = 几何法线，w = 命中距离（天空 0）。与累加纹理同尺寸。 */
    private guideTexture?: GPUTexture;
    private guideViewRef?: GPUTextureView;
    /** 引导缓冲是否过期（换机位 / 换尺寸 / 刚打开降噪）。过期才重算，静态画面不白跑。 */
    private guidesDirty = true;
    private accumIndex = 0;
    private currentWriteView: GPUTextureView | null = null;
    /** 像素采样顺序表（0..pixelCount-1 的随机排列），resize 时重建。 */
    private orderBuf?: GPUBuffer;
    /** Ping-pong bind groups, indexed by the current write index. */
    private bindGroups: [GPUBindGroup?, GPUBindGroup?] = [undefined, undefined];
    /** Which write view each cached bind group was created against (detects texture rebuild). */
    private bindGroupWriteViews: [GPUTextureView?, GPUTextureView?] = [undefined, undefined];

    /** 当前轮内已采样的像素数，[0, pixelCount)。 */
    private cursor = 0;
    /** 已完成的整轮数 —— 每个像素的样本数下界。 */
    private sweep = 0;
    /** 帧序号：只喂 LDS 随机序列，不参与累加平均。 */
    private frameIndex = 1;
    /** 本帧要调度的像素数，由 GPU 实测耗时自适应。 */
    private dispatchTarget = MIN_DISPATCH;
    private lastDispatched = 0;
    /** 每帧 GPU 预算（毫秒），由 RenderLoop 按显示器刷新率下发。 */
    private targetFrameMs = DEFAULT_TARGET_MS;
    /** 下一帧清空累加缓冲并从头开始采样。 */
    private resetPending = false;
    /**
     * 导出模式：每帧固定推进这么多像素，0 = 用自适应预算（实时）。
     *
     * 实时那套是「每帧塞满接近一个刷新间隔的 GPU 时间」，导出不需要跟呈现
     * 对齐，反而需要「步数确定、提交少」：预算控制器让位，改成固定块。
     */
    private exportChunk = 0;

    /**
     * 本帧是否重开了累积（相机/场景/尺寸变化）。
     *
     * 渲染循环据此在「响应」和「吞吐」两档预算间切换：画面正在被改动时延迟要紧，
     * 静止累积时吞吐要紧。用「累积是否被重置」而不是「相机是否动了」来表达，
     * 是因为循环不该认识相机 —— 任何让画面从头再来的原因都该走同一条路。
     */
    public restarted = false;

    constructor(context: RenderContext, model: Model, cameraUniform: GPUBuffer, background: Background) {
        this.context = context;
        this.model = model;
        this.cameraUniform = cameraUniform;
        this.background = background;
        this.textures = model.textures();
        // 环境图采样：u 环绕、v 夹边。v 是极角，用 repeat 会把北极绕到南极去。
        // 只有按粗糙度取 mip 的那条路用它，NEE 仍是纹素精确的 textureLoad。
        this.envSampler = context.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'repeat',
            addressModeV: 'clamp-to-edge',
        });
        // onResize 只置脏标记，重建推迟到 record()（回调里不做 GPU 工作）
        context.onResize(() => {
            this.resizeDirty = true;
        });
        // 设备级资源（pipeline/bgl/uniform）构造时一次性创建，device 生命周期内不变
        this.rebuildDeviceResources();
    }

    public outView(): GPUTextureView | undefined {
        return this.accumViews[this.accumIndex];
    }

    public radianceView(): GPUTextureView | null {
        return this.currentWriteView ?? this.outView() ?? null;
    }

    /** 降噪引导视图（尺寸和 radiance 一致）。场景/尺寸就绪之前是 null。 */
    public guideView(): GPUTextureView | null {
        return this.guideViewRef ?? null;
    }

    /**
     * 重算引导缓冲：整屏一像素一条针孔射线，写几何法线和命中距离。
     *
     * 每次换机位跑一次（导出时每视频帧一次）。成本是「一条光线 × 像素数」，
     * 相对于这一帧已经打过的 spp 条路径可以忽略。
     */
    public recordGuides(encoder: GPUCommandEncoder): void {
        if (!this.guidesDirty) return;
        if (!this.guidePipeline || !this.guideViewRef || !this.width || !this.height) return;
        if (!this.background.hasEnvironment()) return;
        if (!this.bindGroups[this.accumIndex]) return;

        const pass = encoder.beginComputePass();
        pass.setPipeline(this.guidePipeline);
        pass.setBindGroup(0, this.bindGroups[this.accumIndex]!);
        // guides 用 2D dispatch：4K 的像素数超过一维 65535 组的上限
        pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
        pass.end();
        this.guidesDirty = false;
    }

    /** 强制下一帧重算引导（刚打开降噪时用：静态画面里它可能还没算过）。 */
    public invalidateGuides(): void {
        this.guidesDirty = true;
    }

    /** 本帧实际调度的像素数（HUD / 预算控制器读取）。 */
    public get lastDispatch(): number {
        return this.lastDispatched;
    }

    /**
     * 已完成的整轮采样数（每个像素至少采过这么多次）。
     *
     * 已经请求重置、但还没落到下一帧时算 0：那两张累积纹理马上就会被清掉，
     * 报旧的轮数会让「采够了没有」这个判断在重置之后直接为真 —— 离线导出
     * 循环一帧都不跑就收帧，编出来是一串空画面。
     */
    public get completedSamples(): number {
        return this.resetPending ? 0 : this.sweep;
    }

    /**
     * 清空累加缓冲并从头开始（游标归零）。
     * 相机/场景/背景/渲染参数变化时必须调用，否则新旧画面混叠。
     */
    public requestReset(): void {
        this.resetPending = true;
        // 画面从这一帧重来，引导缓冲（机位相关）也跟着作废
        this.guidesDirty = true;
        // frameIndex 故意不归零：它是 LDS 的采样序号，只喂随机数、不参与累加。
        // 拖动时每帧都重置，若序号回到 1，所有像素会一直用同一组随机数 ——
        // 单样本画面会呈现一张固定的屏幕空间花纹，而不像噪点。
    }

    /**
     * 导出模式：每帧推进固定像素数（0 关闭）。
     *
     * 块大 = 提交次数少。每次提交都带着一次全纹理拷贝和一次测量，导出时
     * 这些纯属浪费；但块也不能无限大 —— 一次 dispatch 太久会把 GPU 看门狗
     * 拖出来。
     */
    public setExportChunk(pixels: number): void {
        this.exportChunk = Math.max(0, Math.floor(pixels));
    }

    /** 每帧 GPU 预算（毫秒）。RenderLoop 按实测刷新率下发。 */
    public setTargetFrameMs(ms: number): void {
        if (ms > 0) this.targetFrameMs = ms;
    }

    /**
     * GPU 实测耗时回调（异步，通常比提交晚 1–2 帧）。
     *
     * @param samplingMs 本帧「拷贝 + compute」的 GPU 时间
     * @param measuredDispatch 测量那一帧实际调度的像素数
     *
     * 用**比例**而不是成本模型：这一帧花了多少毫秒，就按「目标 ÷ 实测」去乘采样量。
     *
     * 之前按「预算 ÷ 每像素成本」直接算出目标值，等于假设耗时与采样量成正比。
     * 但每帧还有一项与采样量无关的固定开销 —— 全屏拷贝累积纹理（部分采样时
     * 未被抽中的像素要从读纹理搬过去）和显示 blit。它在采样量小的时候摊到每个
     * 像素上，把成本估高，估高又让采样量更小、摊得更多 —— 正反馈，一路滑到
     * MIN_DISPATCH 就锁死。比例控制天然带上这一项：它收敛到「实测 ≈ 预算」，
     * 固定开销自动被让出来，不需要知道它有多大。
     *
     * 单帧最多挪动 2 倍；一次坏测量只造成两倍的偏差，下一帧就被实测纠正回来。
     */
    public reportFrameTime(samplingMs: number, measuredDispatch: number): void {
        if (!(samplingMs > 0.02) || measuredDispatch <= 0 || this.pixelCount <= 0) return;

        const budgetMs = this.targetFrameMs - FIXED_RESERVE_MS;
        if (budgetMs <= 1) return;

        const ratio = Math.min(Math.max(budgetMs / samplingMs, 0.5), 2);
        const next = Math.min(
            Math.max(measuredDispatch * ratio, MIN_DISPATCH),
            this.pixelCount,
            MAX_DISPATCH,
        );
        this.dispatchTarget = Math.max(1, Math.round(next));
    }

    public destroy(): void {
        this.uniformBuf?.destroy();
        this.orderBuf?.destroy();
        for (const t of this.accumTextures) t?.destroy();
        this.accumTextures = [undefined, undefined];
        this.accumViews = [undefined, undefined];
        this.guideTexture?.destroy();
        this.guideTexture = undefined;
        this.guideViewRef = undefined;
        this.bindGroups = [undefined, undefined];
        this.bindGroupWriteViews = [undefined, undefined];
    }

    public record(encoder: GPUCommandEncoder, cameraChanged: boolean): void {
        const d = this.context.device;
        const bg = this.background;

        this.restarted = false;

        // resize 脏标记 → 重建累积纹理（尺寸相关的纹理按需懒创建，首帧由 onResize 置脏触发）
        if (this.resizeDirty) {
            this.resizeDirty = false;
            this.width = this.context.width();
            this.height = this.context.height();
            this.rebuildAccumTextures();
            this.restarted = true;
        }
        if (!this.width || !this.height) return;

        // 场景还没送到（仍在加载）：没有光源，几何 / 材质也不存在，bind group 建不起来。
        // 场景只装一次，环境图到位就等于 Model、材质、贴图全部编译完。
        if (!bg.hasEnvironment()) return;

        // 相机动了 → 清空累加、游标归零（采样预算保留，成本没有变）
        if (cameraChanged) this.requestReset();

        // bind group 只在两种情况下重建：还没建过，或累积纹理被 resize 换成了新视图
        // （两张 ping-pong 是新旧视图各建一次，命中任一即说明整批都过期了）。
        if (!this.bindGroups[0] || this.bindGroupWriteViews[0] !== this.accumViews[0]) {
            this.rebuildBindGroups();
        }

        const maxPixels = Math.max(1, Math.min(this.pixelCount, MAX_DISPATCH));
        const n =
            this.exportChunk > 0
                ? Math.min(this.exportChunk, maxPixels)
                : Math.max(1, Math.min(this.dispatchTarget, maxPixels));
        const writeIndex = this.accumIndex;
        const readIndex = 1 - writeIndex;

        if (this.resetPending) {
            // 相机/内容变化：两张都清黑，游标归零，从顺序表开头重新铺。
            this.resetPending = false;
            this.restarted = true;
            this.cursor = 0;
            this.sweep = 0;
            const pass = encoder.beginRenderPass({
                colorAttachments: [
                    {
                        view: this.accumViews[0]!,
                        loadOp: 'clear',
                        storeOp: 'store',
                        clearValue: { r: 0, g: 0, b: 0, a: 0 },
                    },
                    {
                        view: this.accumViews[1]!,
                        loadOp: 'clear',
                        storeOp: 'store',
                        clearValue: { r: 0, g: 0, b: 0, a: 0 },
                    },
                ],
            });
            pass.end();
        } else if (n < this.pixelCount) {
            // 本帧只有 n 个像素会被写；其余像素必须先从读纹理拷过来，
            // 否则写入目标里它们仍是两帧前的旧值（画面会出现空洞/闪烁）。
            // 预算涨到整屏时每个像素都会重写，这一整张拷贝可以省掉。
            encoder.copyTextureToTexture(
                { texture: this.accumTextures[readIndex]!, origin: { x: 0, y: 0 } },
                { texture: this.accumTextures[writeIndex]!, origin: { x: 0, y: 0 } },
                { width: this.width, height: this.height },
            );
        }

        // 每帧都重写 uniform（游标/轮数/预算在变，缓存反而更贵）
        const buf = new ArrayBuffer(48);
        const uni = new Uint32Array(buf);
        uni[0] = this.width;
        uni[1] = this.height;
        uni[2] = this.frameIndex;
        uni[3] = this.maxBounces;
        uni[4] = n;
        uni[5] = this.cursor;
        uni[6] = this.sweep;
        uni[7] = this.pixelCount;
        d.queue.writeBuffer(this.uniformBuf!, 0, buf);

        const pass = encoder.beginComputePass();
        pass.setPipeline(this.pipeline!);
        pass.setBindGroup(0, this.bindGroups[writeIndex]!);
        pass.dispatchWorkgroups(Math.ceil(n / WORKGROUP_SIZE));
        pass.end();

        this.currentWriteView = this.accumViews[writeIndex]!;
        this.accumIndex = readIndex;
        this.lastDispatched = n;

        // 推进游标。n ≤ pixel_count，所以最多跨过一次轮边界。
        this.cursor += n;
        if (this.cursor >= this.pixelCount) {
            this.cursor -= this.pixelCount;
            this.sweep++;
        }
        this.frameIndex++;
    }

    /** Device-level resources: only rebuilt when the GPU device changes. */
    private rebuildDeviceResources(): void {
        const d = this.context.device;

        this.uniformBuf?.destroy();
        this.uniformBuf = d.createBuffer({
            size: 48, // Uniforms: 8 × u32（resolution 2 + 6 个标量）+ 对齐填充，见 structs.wgsl
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // storage buffer：2=nodes, 3=像素顺序, 4..7=几何/三角形/材质/实例, 16=环境 CDF。
        this.bgl = d.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                {
                    binding: 8,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: { format: 'rgba32float', access: 'write-only' },
                },
                {
                    binding: 9,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: 10,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { sampleType: 'float', viewDimension: '2d-array' },
                },
                {
                    binding: 11,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { sampleType: 'float', viewDimension: '2d-array' },
                },
                {
                    binding: 12,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { sampleType: 'float', viewDimension: '2d-array' },
                },
                { binding: 17, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
                {
                    binding: 13,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
                },
                { binding: 15, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 16, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                {
                    binding: 19,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { sampleType: 'float', viewDimension: '2d-array' },
                },
                {
                    binding: 20,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: { format: 'rgba32float', access: 'write-only' },
                },
                { binding: 21, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
            ],
        });

        const module = d.createShaderModule({ code: SHADER });
        const layout = d.createPipelineLayout({ bindGroupLayouts: [this.bgl] });
        this.pipeline = d.createComputePipeline({ layout, compute: { module, entryPoint: 'main' } });
        this.guidePipeline = d.createComputePipeline({ layout, compute: { module, entryPoint: 'guides' } });
    }

    /** Size-level resources: only rebuilt when the render resolution changes. */
    private rebuildAccumTextures(): void {
        const d = this.context.device;
        if (!this.width || !this.height) return;

        for (const t of this.accumTextures) t?.destroy();
        for (let i = 0; i < 2; i++) {
            // 累加器必须是 fp32。fp16 的 ulp 在数值 0.3 附近约 2.4e-4，而第 N 个
            // 样本对均值的贡献是 (radiance - mean)/N —— N 上千以后就落在一个 ulp
            // 以内，更新被四舍五入吞掉。对重尾分布（火萤）尤其致命：均值卡在早期
            // 样本附近不再收敛，画面会随样本数增加而持续变暗。
            //
            // COPY_*：每帧把读纹理拷到写纹理（部分采样只写抽中的像素）。
            // RENDER_ATTACHMENT：重置时用 clear 把两张一起清黑。
            this.accumTextures[i] = d.createTexture({
                size: { width: this.width, height: this.height },
                format: 'rgba32float',
                usage:
                    GPUTextureUsage.STORAGE_BINDING |
                    GPUTextureUsage.TEXTURE_BINDING |
                    GPUTextureUsage.COPY_SRC |
                    GPUTextureUsage.COPY_DST |
                    GPUTextureUsage.RENDER_ATTACHMENT,
                label: `pt-accum-${i}`,
            });
            this.accumViews[i] = this.accumTextures[i]!.createView();
        }

        // 引导缓冲跟着尺寸重建（降噪器按视图对象判断要不要重建 bind group）
        this.guideTexture?.destroy();
        this.guideTexture = d.createTexture({
            size: { width: this.width, height: this.height },
            format: 'rgba32float',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
            label: 'pt-guides',
        });
        this.guideViewRef = this.guideTexture.createView();
        this.guidesDirty = true;

        // 像素采样顺序表：每轮每个像素恰好出现一次。
        this.pixelCount = this.width * this.height;
        this.orderBuf?.destroy();
        const order = buildPixelOrder(this.pixelCount);
        this.orderBuf = d.createBuffer({
            size: order.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: 'pt-pixel-order',
        });
        d.queue.writeBuffer(this.orderBuf, 0, order as any);

        this.accumIndex = 0;
        this.cursor = 0;
        this.sweep = 0;
        this.resetPending = false;
        this.dispatchTarget = Math.min(Math.max(this.dispatchTarget, MIN_DISPATCH), this.pixelCount, MAX_DISPATCH);
        this.radianceVersion++;
    }

    /** Rebuilds both ping-pong bind groups at once so slot 0/1 always reference the same scene resources. */
    private rebuildBindGroups(): void {
        this.bindGroups[0] = this.createBindGroup(this.accumViews[0]!, this.accumViews[1]!);
        this.bindGroups[1] = this.createBindGroup(this.accumViews[1]!, this.accumViews[0]!);
        this.bindGroupWriteViews[0] = this.accumViews[0];
        this.bindGroupWriteViews[1] = this.accumViews[1];
    }

    /** Only the ping-pong views change per rebuild; all scene resources are read from the held references. */
    private createBindGroup(writeView: GPUTextureView, readView: GPUTextureView): GPUBindGroup {
        const model = this.model;
        const bg = this.background;
        return this.context.device.createBindGroup({
            layout: this.bgl!,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuf! } },
                { binding: 2, resource: { buffer: model.nodes } },
                { binding: 3, resource: { buffer: this.orderBuf! } },
                { binding: 4, resource: { buffer: model.geometry } },
                { binding: 5, resource: { buffer: model.triangles } },
                { binding: 6, resource: { buffer: model.materialBuffer() } },
                { binding: 7, resource: { buffer: model.instanceBuffer } },
                { binding: 8, resource: writeView },
                { binding: 9, resource: bg.envMapView() },
                { binding: 10, resource: this.textures.albedoView() },
                { binding: 11, resource: this.textures.normalView() },
                { binding: 12, resource: this.textures.roughnessView() },
                { binding: 17, resource: this.textures.sampler() },
                { binding: 13, resource: readView },
                { binding: 15, resource: { buffer: this.cameraUniform } },
                { binding: 16, resource: { buffer: bg.envDistributionBuffer() } },
                { binding: 19, resource: this.textures.occlusionView() },
                { binding: 20, resource: this.guideViewRef! },
                { binding: 21, resource: this.envSampler },
            ],
        });
    }
}

const SHADER = [structs, aabb, intersect, bvh, shade, main].join('\n');
