import type { RenderContext } from '../context';
import SHADER from './atrous.wgsl?raw';

/**
 * 导出用的空间降噪：三级 à-trous，输入是路径追踪累加出来的 radiance。
 *
 * 为什么只在导出时开：实时渲染会一直累积，几千 spp 之后画面自己就干净了，
 * 再降噪只会把细节糊掉。导出的每一帧是固定 spp（默认 16），噪声是结构性的，
 * 不降噪就会在视频里一直闪。
 *
 * 只做空间、不做时间：视频的机位每帧都在动，重投影要运动矢量、要处理遮挡，
 * 复杂度不是一个量级。三级 à-trous 的可见半径约 8 像素，16 spp 的颗粒
 * 已经能压到「不显眼」，代价是细节略软。
 */

/** 三级：步长 1 / 2 / 4，合起来是 9×9 等效半径的稀疏卷积。 */
const STEPS = [1, 2, 4];
const WORKGROUP = 8;

export class Denoiser {
    private context: RenderContext;
    private readonly pipeline: GPUComputePipeline;
    private readonly bgl: GPUBindGroupLayout;

    private width = 0;
    private height = 0;
    private textures: [GPUTexture?, GPUTexture?] = [];
    private views: [GPUTextureView?, GPUTextureView?] = [];
    /** 每级一份 uniform：step 不同，而 writeBuffer 在 commit 之后才落地，不能共用一块。 */
    private params: GPUBuffer[] = [];
    /** Bind groups 按源纹理缓存（radiance 是 ping-pong 两张，正好两个变体）。 */
    private groups = new Map<GPUTextureView, GPUBindGroup[]>();
    /** 引导纹理换过（rebuild / resize）就整批作废。 */
    private boundGuide: GPUTextureView | null = null;

    constructor(context: RenderContext) {
        this.context = context;
        const d = context.device;
        this.bgl = d.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: { format: 'rgba32float', access: 'write-only' },
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
                },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
            ],
        });
        this.pipeline = d.createComputePipeline({
            layout: d.createPipelineLayout({ bindGroupLayouts: [this.bgl] }),
            compute: { module: d.createShaderModule({ code: SHADER }), entryPoint: 'main' },
        });
    }

    /**
     * 跑完整条降噪链，返回最后一级写到的纹理视图（可以直接交给 Display）。
     *
     * @param radianceView 路径追踪的累加结果
     * @param guideView 同一帧的几何引导（法线 + 距离）
     */
    public record(
        encoder: GPUCommandEncoder,
        radianceView: GPUTextureView | null,
        guideView: GPUTextureView | null,
    ): GPUTextureView | null {
        if (!radianceView || !guideView) return null;
        const width = this.context.width();
        const height = this.context.height();
        if (!width || !height) return null;

        if (width !== this.width || height !== this.height) this.rebuild(width, height);
        if (guideView !== this.boundGuide) {
            this.boundGuide = guideView;
            this.groups.clear();
        }

        let bound = this.groups.get(radianceView);
        if (!bound) {
            bound = this.createGroups(radianceView, guideView);
            this.groups.set(radianceView, bound);
        }

        const pass = encoder.beginComputePass();
        pass.setPipeline(this.pipeline);
        for (let i = 0; i < STEPS.length; i++) {
            pass.setBindGroup(0, bound[i]!);
            pass.dispatchWorkgroups(Math.ceil(width / WORKGROUP), Math.ceil(height / WORKGROUP));
        }
        pass.end();

        // 三级下来最后一级写回 textures[0]
        return this.views[0]!;
    }

    public destroy(): void {
        for (const t of this.textures) t?.destroy();
        this.textures = [];
        this.views = [];
        for (const b of this.params) b.destroy();
        this.params = [];
        this.groups.clear();
        this.boundGuide = null;
        this.width = 0;
        this.height = 0;
    }

    private rebuild(width: number, height: number): void {
        const d = this.context.device;
        for (const t of this.textures) t?.destroy();
        for (const b of this.params) b.destroy();

        this.textures = [];
        this.views = [];
        for (let i = 0; i < 2; i++) {
            const texture = d.createTexture({
                size: { width, height },
                format: 'rgba32float',
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
                label: `denoise-${i}`,
            });
            this.textures.push(texture);
            this.views.push(texture.createView());
        }

        this.params = STEPS.map((step) => {
            const buffer = d.createBuffer({
                size: 16,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                label: `denoise-params-${step}`,
            });
            const data = new Uint32Array([step, width, height, 0]);
            d.queue.writeBuffer(buffer, 0, data);
            return buffer;
        });

        this.width = width;
        this.height = height;
        this.groups.clear();
    }

    /** 三级各自的绑定：src 逐级换，dst 在两张之间交替。 */
    private createGroups(radianceView: GPUTextureView, guideView: GPUTextureView): GPUBindGroup[] {
        const sources: GPUTextureView[] = [radianceView, this.views[0]!, this.views[1]!];
        const targets: GPUTextureView[] = [this.views[0]!, this.views[1]!, this.views[0]!];
        return sources.map((source, i) =>
            this.context.device.createBindGroup({
                layout: this.bgl,
                entries: [
                    { binding: 0, resource: source },
                    { binding: 1, resource: targets[i]! },
                    { binding: 2, resource: guideView },
                    { binding: 3, resource: { buffer: this.params[i]! } },
                ],
            }),
        );
    }
}
