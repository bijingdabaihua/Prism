import type { Camera } from '../camera';
import type { Model } from '../model/model';
import type { Background } from '../background';
import type { RenderContext } from '../context';
import { GpuTimer } from './gpu-timer';
import { PathTracePass } from './path-tracing/pathTrace';
import { Display } from '../display/display';
import { Denoiser } from '../denoise/denoise';

/** 给 HUD / 外部观察的一帧统计。 */
export interface FrameStats {
    /** 已完成的整轮采样数（每个像素的样本数下界）。 */
    samples: number;
    /** 本帧调度的像素数。 */
    pixels: number;
    /** 本帧 GPU 总耗时（毫秒）；首次测量回来之前为 0。 */
    gpuMs: number;
    /** 最近一帧的呈现帧率。 */
    fps: number;
    /** 最近一帧「拷贝 + compute」的 GPU 耗时（毫秒），和 gpuMs 的差就是显示 + 提交。 */
    samplingMs: number;
}

/**
 * 一帧的提交单元。
 *
 * 编排顺序是固定的：先路径追踪（写累加纹理），再 display（blit 到 canvas）。
 * 采样预算、游标推进都在 PathTracePass 内部；这里只负责把各段串起来，
 * 以及在两端打 GPU 时间戳。
 */
export class Frame {
    public readonly context: RenderContext;
    private readonly camera: Camera;
    private readonly pathTracePass: PathTracePass;
    private readonly display: Display;
    private readonly denoiser: Denoiser;
    private readonly timer: GpuTimer;

    /**
     * 降噪开关：导出时必开，实时渲染里可以手动开关（按 D）。
     *
     * 实时累积到几千 spp 之后画面自己就干净了，再降噪只会糊掉细节；但刚拖动
     * 完机位、只攒了几 spp 的时候，降噪能立刻把画面压干净。导出每帧固定 spp，
     * 噪声是结构性的，必须压。
     */
    private denoiseOn = false;

    public get denoiseEnabled(): boolean {
        return this.denoiseOn;
    }

    /** 打开时强制下一帧重算引导 —— 静态画面里它可能一次都还没算过。 */
    public setDenoise(on: boolean): void {
        if (on === this.denoiseOn) return;
        this.denoiseOn = on;
        if (on) this.pathTracePass.invalidateGuides();
    }

    constructor(context: RenderContext, model: Model, camera: Camera, background: Background) {
        this.context = context;
        this.camera = camera;
        this.pathTracePass = new PathTracePass(context, model, camera.buffer, background);
        this.display = new Display(context);
        this.denoiser = new Denoiser(context);
        this.timer = new GpuTimer(context.device);
        this.timer.onMeasure = (samplingMs, _totalMs, dispatch) =>
            this.pathTracePass.reportFrameTime(samplingMs, dispatch);
    }

    public stats(elapsedMs: number): FrameStats {
        return {
            samples: this.pathTracePass.completedSamples,
            pixels: this.pathTracePass.lastDispatch,
            gpuMs: this.timer.lastTotalMs,
            fps: elapsedMs > 0 ? 1000 / elapsedMs : 0,
            samplingMs: this.timer.lastSamplingMs,
        };
    }

    /** 每帧 GPU 预算（毫秒），由 RenderLoop 按实测显示器刷新率下发。 */
    public setTargetFrameMs(ms: number): void {
        this.pathTracePass.setTargetFrameMs(ms);
    }

    /** 导出模式：每次提交推进固定像素数（0 = 回到实时预算）。 */
    public setExportChunk(pixels: number): void {
        this.pathTracePass.setExportChunk(pixels);
    }

    /** 已完成的整轮采样数 —— 每个像素至少采过这么多次（离线导出按它收帧）。 */
    public get samples(): number {
        return this.pathTracePass.completedSamples;
    }

    /** 下一帧清空累积、从头采样（离线导出换机位时用）。 */
    public requestReset(): void {
        this.pathTracePass.requestReset();
    }

    /**
     * 离线导出的提交单元：只做一段路径追踪采样。
     *
     * 不测时间（不占读回槽位，就不会卡在 canSubmit 上）、不画布。导出要的是
     * 「确定的采样数」，不是每帧的耗时；连续提交的顺序由 GPU 队列保证，
     * 调用方只在要读回的那一下同步。
     */
    public submitSamples(): void {
        this.context.applyResizeIfNeeded();
        if (this.context.width() === 0 || this.context.height() === 0) return;
        const cameraChanged = this.camera.upload();
        const encoder = this.context.device.createCommandEncoder();
        this.pathTracePass.record(encoder, cameraChanged);
        this.context.device.queue.submit([encoder.finish()]);
    }

    /**
     * 导出时收帧前的最后一步：刷引导缓冲 + 空间降噪，返回可以显示的视图。
     *
     * 返回值是 null 表示没开降噪，调用方直接用 radiance。
     */
    public denoiseFrame(encoder: GPUCommandEncoder): GPUTextureView | null {
        if (!this.denoiseOn) return null;
        this.pathTracePass.recordGuides(encoder);
        return this.denoiser.record(encoder, this.pathTracePass.radianceView(), this.pathTracePass.guideView());
    }

    /**
     * 只把当前画面画到画布 —— 导出时每个视频帧一次，预览不至于冻住。
     *
     * @param view 降噪后的结果；null = 直接显示 radiance
     */
    public drawPreview(encoder: GPUCommandEncoder, view: GPUTextureView | null): void {
        this.display.record(encoder, view ?? this.pathTracePass.radianceView(), this.pathTracePass.radianceVersion);
    }

    /**
     * 把当前画面（色调映射之后的那张）画到离屏纹理，供导出读回。
     *
     * 画布本身不能读：交换链纹理不保证可拷贝，快照还依赖合成器呈现。
     * 这条路径和显示完全同一条着色器，所以导出和看到的是同一张图。
     */
    public renderDisplayTo(
        encoder: GPUCommandEncoder,
        view: GPUTextureView | null,
        target: GPUTextureView,
    ): void {
        this.display.recordTo(
            encoder,
            view ?? this.pathTracePass.radianceView(),
            this.pathTracePass.radianceVersion,
            target,
        );
    }

    /** 上一帧是否重开了累积 —— 渲染循环据此在「响应 / 吞吐」两档预算间切换。 */
    public get restarted(): boolean {
        return this.pathTracePass.restarted;
    }

    /**
     * 这一帧还能不能提交。在途帧到上限就先跳过：队列越积越深会让测量断供，
     * 采样量冻住不动（见 GpuTimer.canSubmit）。
     */
    public get readyForNextFrame(): boolean {
        return this.timer.canSubmit;
    }

    /**
     * 提交一帧。先应用 canvas 尺寸变化（deferred resize：在 getCurrentTexture 之前），
     * 尺寸为 0（canvas 尚未布局）时跳过整帧。返回是否实际提交了渲染。
     */
    public renderFrame(): boolean {
        this.context.applyResizeIfNeeded();
        if (this.context.width() === 0 || this.context.height() === 0) return false;

        const cameraChanged = this.camera.upload();

        const encoder = this.context.device.createCommandEncoder();
        this.timer.begin(encoder);
        this.pathTracePass.record(encoder, cameraChanged);
        this.timer.afterSampling(encoder);

        // 降噪接在采样之后、显示之前：它属于「这一帧的呈现成本」，
        // 不计进 samplingMs（那个数只喂采样预算控制器）。
        let view: GPUTextureView | null = null;
        if (this.denoiseOn) {
            this.pathTracePass.recordGuides(encoder);
            view = this.denoiser.record(encoder, this.pathTracePass.radianceView(), this.pathTracePass.guideView());
        }
        this.display.record(encoder, view ?? this.pathTracePass.radianceView(), this.pathTracePass.radianceVersion);
        this.timer.end(encoder, this.pathTracePass.lastDispatch);

        this.context.device.queue.submit([encoder.finish()]);
        this.timer.afterSubmit();

        return true;
    }

    public destroy(): void {
        this.pathTracePass.destroy();
        this.display.destroy();
        this.denoiser.destroy();
        this.timer.destroy();
    }
}
