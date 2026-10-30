/**
 * 一帧 GPU 耗时的测量器。
 *
 * 优先用 timestamp-query：在命令流里打 3 个时间戳（帧开始 / 采样结束 / 显示结束），
 * resolve 后异步读回。时间戳是 GPU 自己的时钟，不受 vsync 量化影响 —— 用
 * performance.now() 包 submit() 只能测到 CPU 提交，用 rAF 帧间隔又会卡在
 * 16.7/33.3ms 的台阶上，都不足以驱动采样预算。
 *
 * 设备不支持 timestamp-query 时退回 queue.onSubmittedWorkDone()：
 * 从提交到 GPU 执行完的墙钟时间，含少量驱动开销，但足够让控制器收敛。
 */

/**
 * 规范里 GPUCommandEncoder.writeTimestamp() 已经是正式 API，但 @webgpu/types
 * 0.1.71 还没声明它，这里补一个局部接口。
 */
interface TimestampCommandEncoder extends GPUCommandEncoder {
    writeTimestamp(querySet: GPUQuerySet, queryIndex: number): void;
}

function writeTimestamp(encoder: GPUCommandEncoder, querySet: GPUQuerySet, index: number): void {
    (encoder as TimestampCommandEncoder).writeTimestamp(querySet, index);
}

/**
 * 设备是否真的能写时间戳。
 *
 * 只看 features 不够：有些实现（实验性的 Firefox WebGPU 等）会声明
 * timestamp-query 特性，却没有实现 encoder.writeTimestamp，调用直接抛
 * TypeError。以方法本身是否存在为准，缺了就整条链路退回 onSubmittedWorkDone。
 */
function supportsTimestamps(device: GPUDevice): boolean {
    if (!device.features.has('timestamp-query')) return false;
    const proto = (globalThis as any).GPUCommandEncoder?.prototype;
    return typeof proto?.writeTimestamp === 'function';
}

/** 允许同时在途的帧数：留一个读回槽位永远空着，测量就不会断供。 */
const MAX_IN_FLIGHT = 2;
/** 读回槽位个数。比 MAX_IN_FLIGHT 多一个，是上面那条的前提。 */
const SLOT_COUNT = 3;

export class GpuTimer {
    /** 每次测量完成时回调（异步，通常比提交晚 1–2 帧）。 */
    public onMeasure?: (samplingMs: number, totalMs: number, dispatch: number) => void;
    /** 最近一次总耗时（毫秒），HUD 读取。 */
    public lastTotalMs = 0;
    /** 最近一次「拷贝 + compute」耗时（毫秒），HUD 读取。 */
    public lastSamplingMs = 0;

    /**
     * 还能不能再提交一帧。
     *
     * 提交得比 GPU 跑得快，队列就越积越深：槽位全被占满之后测量被丢弃，
     * 控制器收不到任何新数据、采样量冻住不动，直到队列排空才缓过来。
     *
     * 上限是 2 而不是 1：只许一帧在途的话，提交要等上一帧的读回、再等下一个
     * rAF，GPU 每帧空转最多半个刷新间隔 —— 采样量直接掉三成。2 帧在途
     * 正好让 GPU 连轴转，而 3 个槽位永远留着一个空位，测量不断供。
     */
    public get canSubmit(): boolean {
        if (this.slots.length === 0) return !this.fallbackBusy;
        return this.inFlight < MAX_IN_FLIGHT;
    }

    private readonly device: GPUDevice;
    private querySet: GPUQuerySet | null = null;
    private resolveBuf: GPUBuffer | null = null;
    private slots: Array<{ buf: GPUBuffer; busy: boolean }> = [];
    /** 已提交、还没读回的帧数。 */
    private inFlight = 0;
    private pending: { slot: { buf: GPUBuffer; busy: boolean }; dispatch: number } | null = null;

    /** 退回方案用的 CPU 起点与当前帧采样量。 */
    private cpuStart = 0;
    private fallbackDispatch = 0;
    private fallbackBusy = false;

    constructor(device: GPUDevice) {
        this.device = device;

        if (supportsTimestamps(device)) {
            this.querySet = device.createQuerySet({ type: 'timestamp', count: 3 });
            this.resolveBuf = device.createBuffer({
                size: 24,
                usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
            });
            for (let i = 0; i < SLOT_COUNT; i++) {
                this.slots.push({
                    buf: device.createBuffer({
                        size: 24,
                        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
                    }),
                    busy: false,
                });
            }
        }
    }

    /** 帧开始（采样之前）。 */
    public begin(encoder: GPUCommandEncoder): void {
        if (this.querySet) {
            writeTimestamp(encoder, this.querySet, 0);
        } else {
            this.cpuStart = performance.now();
        }
    }

    /** 路径追踪（拷贝 + compute）结束。 */
    public afterSampling(encoder: GPUCommandEncoder): void {
        if (this.querySet) writeTimestamp(encoder, this.querySet, 1);
    }

    /** 显示（blit）结束；同时 resolve 时间戳并排进读回队列。 */
    public end(encoder: GPUCommandEncoder, dispatch: number): void {
        if (!this.querySet || !this.resolveBuf) {
            this.fallbackDispatch = dispatch;
            return;
        }
        writeTimestamp(encoder, this.querySet, 2);
        encoder.resolveQuerySet(this.querySet, 0, 3, this.resolveBuf, 0);

        const slot = this.slots.find((s) => !s.busy);
        if (!slot) {
            this.pending = null;
            return;
        }
        slot.busy = true;
        this.inFlight++;
        encoder.copyBufferToBuffer(this.resolveBuf, 0, slot.buf, 0, 24);
        this.pending = { slot, dispatch };
    }

    /** submit 之后调用：开始读回（时间戳）或等待 GPU 完成（退回方案）。 */
    public afterSubmit(): void {
        if (!this.querySet) {
            this.fallbackAfterSubmit();
            return;
        }

        const pending = this.pending;
        this.pending = null;
        if (!pending) return;

        pending.slot.buf
            .mapAsync(GPUMapMode.READ)
            .then(() => {
                const values = new BigUint64Array(pending.slot.buf.getMappedRange());
                const t0 = Number(values[0]);
                const t1 = Number(values[1]);
                const t2 = Number(values[2]);
                pending.slot.buf.unmap();
                pending.slot.busy = false;
                this.inFlight--;
                if (t2 <= t0 || t1 < t0) return;
                const samplingMs = (t1 - t0) / 1e6;
                this.lastTotalMs = (t2 - t0) / 1e6;
                this.lastSamplingMs = samplingMs;
                this.onMeasure?.(samplingMs, this.lastTotalMs, pending.dispatch);
            })
            .catch(() => {
                pending.slot.busy = false;
                this.inFlight--;
            });
    }

    public destroy(): void {
        this.resolveBuf?.destroy();
        for (const s of this.slots) s.buf.destroy();
        this.slots = [];
        this.querySet?.destroy();
        this.querySet = null;
    }

    private fallbackAfterSubmit(): void {
        if (this.fallbackBusy) return;
        this.fallbackBusy = true;
        const start = this.cpuStart;
        const dispatch = this.fallbackDispatch;
        this.device.queue
            .onSubmittedWorkDone()
            .then(() => {
                this.fallbackBusy = false;
                const ms = performance.now() - start;
                if (dispatch > 0 && ms > 0) {
                    this.lastTotalMs = ms;
                    this.onMeasure?.(ms, ms, dispatch);
                }
            })
            .catch(() => {
                this.fallbackBusy = false;
            });
    }
}
