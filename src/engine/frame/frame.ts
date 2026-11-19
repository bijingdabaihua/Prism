import type { Camera } from '../camera';
import type { Model } from '../model/model';
import type { Background } from '../background';
import type { RenderContext } from '../context';
import { GpuTimer } from './gpu-timer';
import { PathTracePass } from './path-tracing/pathTrace';
import { Display } from '../display/display';
import { Denoiser } from '../denoise/denoise';

/** 给 HUD / 外部观察的一帧统计。 */
/** 一张读回的画面：RGBA8，行间无 padding。 */
export interface PixelBuffer {
    width: number;
    height: number;
    data: Uint8ClampedArray<ArrayBuffer>;
}

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
     * 降噪开关：实时渲染里手动开关（按 D）。
     *
     * 实时累积到几千 spp 之后画面自己就干净了，再降噪只会糊掉细节；但刚拖动
     * 完机位、只攒了几 spp 的时候，降噪能立刻把画面压干净。
     */
    private denoiseOn = false;

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

    /**
     * 读回当前画面（已色调映射的显示结果）。
     *
     * 不走 canvas 的 convertToBlob —— WebGPU canvas 的读回在部分环境里会失败。
     * 显示 pass 画进一张临时纹理，copyTextureToBuffer 读回来，通道按格式翻成 RGBA。
     * 采样和显示各提交一次，不改动累积状态。
     */
    public async readPixels(): Promise<PixelBuffer> {
        const width = this.context.width();
        const height = this.context.height();
        if (!width || !height) throw new Error('还没有可拍下来的画面');
        const device = this.context.device;
        const format = this.context.format;
        const texture = device.createTexture({
            size: { width, height },
            format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
            label: 'photo-target',
        });
        const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
        const buffer = device.createBuffer({
            size: bytesPerRow * height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            label: 'photo-readback',
        });

        try {
            const encoder = device.createCommandEncoder();
            let view: GPUTextureView | null = null;
            if (this.denoiseOn) {
                this.pathTracePass.recordGuides(encoder);
                view = this.denoiser.record(
                    encoder,
                    this.pathTracePass.radianceView(),
                    this.pathTracePass.guideView(),
                );
            }
            this.display.recordTo(
                encoder,
                view ?? this.pathTracePass.radianceView(),
                this.pathTracePass.radianceVersion,
                texture.createView(),
            );
            encoder.copyTextureToBuffer(
                { texture },
                { buffer, bytesPerRow, rowsPerImage: height },
                { width, height },
            );
            device.queue.submit([encoder.finish()]);

            await buffer.mapAsync(GPUMapMode.READ);
            const src = new Uint8Array(buffer.getMappedRange());
            const data = new Uint8ClampedArray(width * height * 4);
            const bgra = format === 'bgra8unorm';
            for (let y = 0; y < height; y++) {
                let s = y * bytesPerRow;
                let o = y * width * 4;
                for (let x = 0; x < width; x++, s += 4, o += 4) {
                    if (bgra) {
                        data[o] = src[s + 2]!;
                        data[o + 1] = src[s + 1]!;
                        data[o + 2] = src[s]!;
                    } else {
                        data[o] = src[s]!;
                        data[o + 1] = src[s + 1]!;
                        data[o + 2] = src[s + 2]!;
                    }
                    data[o + 3] = src[s + 3]!;
                }
            }
            return { width, height, data };
        } finally {
            buffer.unmap();
            buffer.destroy();
            texture.destroy();
        }
    }

    public destroy(): void {
        this.pathTracePass.destroy();
        this.display.destroy();
        this.denoiser.destroy();
        this.timer.destroy();
    }
}
