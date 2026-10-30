import type { Engine } from '../engine/engine';
import type { CameraPath, CameraView } from '../ir/camera';
import { sampleCameraPath } from '../ir/camera';

/**
 * 离线导出视频：按相机轨迹逐帧取机位，每帧累积到给定 spp，编码进 MP4。
 *
 * 和实时渲染是两条路：实时渲染按刷新率切预算、画面可以随时被鼠标打断；
 * 这里每帧必须**恰好**采够再收，跟显示器节奏无关。所以 RenderLoop 在导出期间
 * 停掉，由这里的循环直接 drive Frame，用 queue.onSubmittedWorkDone() 当节拍。
 */

export interface VideoSettings {
    width: number;
    height: number;
    fps: number;
    /** 总帧数（时长 × 帧率）。 */
    frames: number;
    /** 每帧要完成的整轮采样数 —— 每帧每个像素的样本数下界。 */
    spp: number;
    /** 目标码率（bit/s）。文件大小 ≈ 码率 × 时长 ÷ 8。 */
    bitrate: number;
}

export interface ExportProgress {
    /** 已编码完成的帧数。 */
    frame: number;
    frames: number;
    /** 当前帧已完成的整轮采样数。 */
    samples: number;
    spp: number;
    elapsedMs: number;
}

/**
 * 导出时每次提交推进多少像素。
 *
 * 一次提交 = 一次 dispatch + （没扫满整屏时的）全纹理拷贝。块越大提交越少，
 * 但单次 dispatch 太久会撞上驱动的看门狗 —— 一百万像素在 M4 上约 0.4 秒，
 * 是个两头都安全的数。1080p 一次整屏扫描正好两次提交。
 */
const EXPORT_CHUNK_PX = 1 << 20;

/** 最多先排多少帧再同步一次：让 GPU 连轴转，又不至于把命令队列堆成山。 */
const MAX_QUEUED_SUBMITS = 8;

export async function exportVideo(
    engine: Engine,
    view: CameraView,
    path: CameraPath | undefined,
    settings: VideoSettings,
    onProgress: (p: ExportProgress) => void,
    signal: AbortSignal,
): Promise<Blob> {
    const config = await pickCodec(settings);
    // 容器封装只在导出时用得到，别让它进首页的包
    const { ArrayBufferTarget, Muxer } = await import('mp4-muxer');
    const device = engine.context.device;

    // 导出的像素从这张离屏纹理读回来：画布本身不可靠（见 Frame.renderDisplayTo）
    const target = device.createTexture({
        size: { width: settings.width, height: settings.height },
        format: engine.context.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const targetView = target.createView();
    // 每行字节数按 256 对齐是 copyTextureToBuffer 的硬要求
    const bytesPerRow = Math.ceil((settings.width * 4) / 256) * 256;
    const readback = device.createBuffer({
        size: bytesPerRow * settings.height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const pixelFormat = engine.context.format.startsWith('rgba') ? 'RGBA' : 'BGRA';

    const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: 'avc', width: settings.width, height: settings.height, frameRate: settings.fps },
        // moov 放文件头：这样边下边播，也能被绝大多数播放器直接拖进度
        fastStart: 'in-memory',
    });

    let encodeError: Error | null = null;
    const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (e) => {
            encodeError = e;
        },
    });
    encoder.configure(config);

    const started = performance.now();
    engine.loop.stop();
    engine.context.forceSize(settings.width, settings.height);
    // 预算控制器让位：导出按固定块推进，不再「每帧塞满一个刷新间隔」
    engine.frame.setExportChunk(EXPORT_CHUNK_PX);
    // 暂时关掉降噪：先看纯累积的画面，和降噪版对比。
    // 打开这一行就能恢复「每帧收尾跑一遍空间降噪」的行为。
    const denoiseWasOn = engine.frame.denoiseEnabled;
    engine.frame.setDenoise(false);

    try {
        for (let i = 0; i < settings.frames; i++) {
            if (signal.aborted) throw new DOMException('导出已取消', 'AbortError');
            if (encodeError) throw encodeError;

            engine.camera.applyView(frameView(view, path, i, settings.frames));
            engine.frame.requestReset();
            await accumulate(engine, settings.spp, (samples) =>
                onProgress({
                    frame: i,
                    frames: settings.frames,
                    samples,
                    spp: settings.spp,
                    elapsedMs: performance.now() - started,
                }),
                signal,
            );

            const timestamp = Math.round((i * 1e6) / settings.fps);
            const duration = Math.round(1e6 / settings.fps);
            const readEncoder = device.createCommandEncoder();
            // 预览只画一次：采样期间不碰画布，每个视频帧收尾时同步一下。
            // 降噪关着的时候这里返回 null，上面两处直接拿 radiance 显示。
            const denoised = engine.frame.denoiseFrame(readEncoder);
            engine.frame.drawPreview(readEncoder, denoised);
            engine.frame.renderDisplayTo(readEncoder, denoised, targetView);
            readEncoder.copyTextureToBuffer(
                { texture: target },
                { buffer: readback, bytesPerRow },
                { width: settings.width, height: settings.height },
            );
            device.queue.submit([readEncoder.finish()]);

            await readback.mapAsync(GPUMapMode.READ);
            // 读回的行带 256 字节对齐的尾巴，VideoFrame 要的是紧排
            const padded = new Uint8Array(readback.getMappedRange());
            const tight = new Uint8Array(settings.width * settings.height * 4);
            for (let y = 0; y < settings.height; y++) {
                tight.set(
                    padded.subarray(y * bytesPerRow, y * bytesPerRow + settings.width * 4),
                    y * settings.width * 4,
                );
            }
            readback.unmap();

            const frame = new VideoFrame(tight, {
                format: pixelFormat,
                codedWidth: settings.width,
                codedHeight: settings.height,
                timestamp,
                duration,
            });
            // 两秒一个关键帧：拖动进度条不至于一路向前解
            encoder.encode(frame, { keyFrame: i % (settings.fps * 2) === 0 });
            frame.close();
            if (encoder.encodeQueueSize > 6) await encoder.flush();

            onProgress({
                frame: i + 1,
                frames: settings.frames,
                samples: settings.spp,
                spp: settings.spp,
                elapsedMs: performance.now() - started,
            });
        }

        await encoder.flush();
        if (encodeError) throw encodeError;
        muxer.finalize();
    } finally {
        try {
            encoder.close();
        } catch {
            /* 已经关了 */
        }
        target.destroy();
        readback.destroy();
        engine.frame.setExportChunk(0);
        engine.frame.setDenoise(denoiseWasOn);
        // 恢复实时渲染的现场：尺寸、机位、累积、循环。
        // 页面已经卸载（导出被 abort）时不能碰：device 已经销毁，
        // 把循环再拉起来只会对着空气提交。
        if (!engine.destroyed) {
            engine.context.forceSize(null);
            engine.camera.applyView(view);
            engine.frame.requestReset();
            engine.loop.boot();
        }
    }

    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}

/** 第 i 帧的机位：轨迹上有就按轨迹取，没有就一直是场景机位。 */
function frameView(view: CameraView, path: CameraPath | undefined, i: number, frames: number): CameraView {
    if (!path) return view;
    const t = frames <= 1 ? 0 : i / (frames - 1);
    const key = sampleCameraPath(path, t);
    return { ...view, target: key.target, distance: key.distance, theta: key.theta, phi: key.phi };
}

/**
 * 提交采样，直到累积满 spp 整轮。
 *
 * 不再「提交一帧等一帧」：命令队列本身保证顺序，连续排进去 GPU 会自己
 * 连轴转。每排 MAX_QUEUED_SUBMITS 帧同步一次，一是别把队列堆太深，
 * 二是进度条能跟着 GPU 实际进度走，而不是被 CPU 一口气冲到 100%。
 */
async function accumulate(
    engine: Engine,
    spp: number,
    onSamples: (samples: number) => void,
    signal: AbortSignal,
): Promise<void> {
    const frame = engine.frame;
    const queue = engine.context.device.queue;
    let queued = 0;
    let guard = 0;
    while (frame.samples < spp) {
        if (signal.aborted) throw new DOMException('导出已取消', 'AbortError');
        // 一道保险：正常一帧至少推进一个像素，卡住说明状态坏了，别死循环
        if (++guard > 1_000_000) throw new Error('渲染推进失败');
        frame.submitSamples();
        if (++queued >= MAX_QUEUED_SUBMITS) {
            await queue.onSubmittedWorkDone();
            queued = 0;
            onSamples(frame.samples);
        }
    }
    // 收尾：这一帧的采样必须全部落地，读回才看得到完整的一张
    await queue.onSubmittedWorkDone();
    onSamples(frame.samples);
}

/**
 * 挑一个能用的 H.264 配置。
 *
 * codec 串里的 level 跟「宏块每秒」挂钩：1080p30 只要 4.0，1080p60 要 4.2，
 * 4K 要 5.1。写低了浏览器直接拒绝配置，所以先按分辨率算，再依次退到
 * 更高的 level —— 也可以说是「先用最小的，不行再往上试」。
 */
async function pickCodec(s: VideoSettings): Promise<VideoEncoderConfig> {
    const mbPerSec = (s.width / 16) * (s.height / 16) * s.fps;
    const level =
        mbPerSec <= 245_760
            ? 'avc1.640028' // 4.0
            : mbPerSec <= 522_240
              ? 'avc1.64002a' // 4.2
              : mbPerSec <= 983_040
                ? 'avc1.640032' // 5.0
                : 'avc1.640033'; // 5.1

    const candidates = [level, 'avc1.640033', 'avc1.64002a', 'avc1.640028', 'avc1.42001f'];
    for (const codec of new Set(candidates)) {
        const config: VideoEncoderConfig = {
            codec,
            width: s.width,
            height: s.height,
            framerate: s.fps,
            bitrate: s.bitrate,
            latencyMode: 'quality',
        };
        const support = await VideoEncoder.isConfigSupported(config);
        if (support.supported) return config;
    }
    throw new Error('这个浏览器没有可用的 H.264 编码器（WebCodecs 未启用？）');
}
