import type { Camera } from '../camera';
import type { Model } from '../model/model';
import type { Background } from '../background';
import type { RenderContext } from '../context';
import { GpuTimer } from './gpu-timer';
import { PathTracePass } from './path-tracing/pathTrace';
import { Display } from '../display/display';

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
    private readonly timer: GpuTimer;
    /** 已提交的帧数 —— 相机靠它判断画布上有没有新画面可推。 */
    private submittedFrames = 0;

    constructor(context: RenderContext, model: Model, camera: Camera, background: Background) {
        this.context = context;
        this.camera = camera;
        this.pathTracePass = new PathTracePass(context, model, camera.buffer, background);
        this.display = new Display(context);
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

    /** 已提交的帧数。 */
    public get frameCount(): number {
        return this.submittedFrames;
    }

    /**
     * 把画布上最近一次呈现的画面搬成位图。
     *
     * 只有 OffscreenCanvas（Worker 里）支持；还没提交过任何一帧时返回 null，
     * 调用方等下一次。
     */
    public capture(): ImageBitmap | null {
        if (this.submittedFrames === 0) return null;
        const canvas = this.context.canvas();
        if (typeof OffscreenCanvas === 'undefined' || !(canvas instanceof OffscreenCanvas)) return null;
        try {
            return canvas.transferToImageBitmap();
        } catch {
            // 画布还没呈现过任何一帧
            return null;
        }
    }

    /** 每帧 GPU 预算（毫秒），由 RenderLoop 按实测显示器刷新率下发。 */
    public setTargetFrameMs(ms: number): void {
        this.pathTracePass.setTargetFrameMs(ms);
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

        this.display.record(encoder, this.pathTracePass.radianceView(), this.pathTracePass.radianceVersion);
        this.timer.end(encoder, this.pathTracePass.lastDispatch);

        this.context.device.queue.submit([encoder.finish()]);
        this.timer.afterSubmit();
        this.submittedFrames++;

        return true;
    }

    public destroy(): void {
        this.pathTracePass.destroy();
        this.display.destroy();
        this.timer.destroy();
    }
}
