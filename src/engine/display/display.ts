import type { RenderContext } from '../context';
import VS from './fullscreen-vertex.wgsl?raw';
import FS from './fullscreen-fragment.wgsl?raw';

/**
 * 显示 pass：把累加纹理 blit 到 canvas —— ACES、暗角、颗粒。
 *
 * 输入是 fp32 累加器，不可过滤 —— 用 textureLoad 逐像素取值，不采样；
 * 显示尺寸和渲染尺寸一比一，本来也不需要插值。
 */
export class Display {
    private context: RenderContext;
    private pipeline: GPURenderPipeline | null = null;
    private bgl: GPUBindGroupLayout;
    private blitVersion = -1;
    /** Blit bind groups keyed by radiance view — ping-pong 每帧在两张 view 间切换，每个版本正好 2 个缓存项。 */
    private blitBindGroups = new Map<GPUTextureView, GPUBindGroup>();

    constructor(context: RenderContext) {
        this.context = context;
        const d = context.device;
        this.bgl = d.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
                },
            ],
        });
        this.pipeline = d.createRenderPipeline({
            layout: d.createPipelineLayout({ bindGroupLayouts: [this.bgl] }),
            vertex: { module: d.createShaderModule({ code: VS }), entryPoint: 'main' },
            fragment: {
                module: d.createShaderModule({ code: FS }),
                entryPoint: 'main',
                targets: [{ format: context.format }],
            },
            primitive: { topology: 'triangle-list' },
        });
    }

    /**
     * @param view   要显示的纹理（累加结果）
     * @param version 上游重建纹理时递增；变化则丢弃所有缓存的 bind group
     */
    public record(encoder: GPUCommandEncoder, view: GPUTextureView | null, version: number): void {
        const ctx = this.context.gpuContext();
        if (!ctx) return;
        const bindGroup = this.bindGroupFor(view, version);
        if (!bindGroup) return;
        this.draw(encoder, bindGroup, ctx.getCurrentTexture().createView());
    }

    /**
     * 把同一张画面画到指定纹理上 —— 导出视频用。
     *
     * 离屏目标可以被 copyTextureToBuffer 读回。不能直接读 canvas 的纹理：
     * 交换链纹理不保证带 COPY_SRC，而且快照得等合成器呈现，后台标签页里
     * 那一步根本不发生。
     */
    public recordTo(
        encoder: GPUCommandEncoder,
        view: GPUTextureView | null,
        version: number,
        target: GPUTextureView,
    ): void {
        const bindGroup = this.bindGroupFor(view, version);
        if (!bindGroup) return;
        this.draw(encoder, bindGroup, target);
    }

    private bindGroupFor(view: GPUTextureView | null, version: number): GPUBindGroup | null {
        if (version !== this.blitVersion) {
            this.blitBindGroups.clear();
            this.blitVersion = version;
        }

        // 用 view 做键缓存：上游每帧在两张视图间切换时直接命中
        if (!view || !this.pipeline) return null;

        const cached = this.blitBindGroups.get(view);
        if (cached) return cached;

        const bindGroup = this.createBlitBindGroup(view);
        this.blitBindGroups.set(view, bindGroup);
        return bindGroup;
    }

    private draw(encoder: GPUCommandEncoder, bindGroup: GPUBindGroup, target: GPUTextureView): void {
        if (!this.pipeline) return;
        const rp = encoder.beginRenderPass({
            colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store' }],
        });
        rp.setPipeline(this.pipeline);
        rp.setBindGroup(0, bindGroup);
        rp.draw(3);
        rp.end();
    }

    public destroy(): void {
        this.pipeline = null;
        this.blitBindGroups.clear();
    }

    private createBlitBindGroup(radianceView: GPUTextureView): GPUBindGroup {
        return this.context.device.createBindGroup({
            layout: this.bgl,
            entries: [{ binding: 0, resource: radianceView }],
        });
    }
}
