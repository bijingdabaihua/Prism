import type { Frame, FrameStats } from './frame/frame';

/**
 * 目标预算占实测刷新间隔的比例 —— 两档。
 *
 * 画面正在被改动（拖动相机、重置累积）时用 0.75：给合成器留余量，帧率优先，
 * 不然松手的滞后会被看见。
 *
 * 静止累积时用 1.9：每帧摊到两个刷新间隔。这时画面只是在往同一张图上加样本，
 * 慢半拍画出来的还是那张图，而预算翻倍等于在原本空转的 GPU 时间里把采样量
 * 也翻一倍 —— 静置几十秒后的画面差别是成倍的，不是百分之几。
 */
const RESPONSIVE_RATIO = 0.75;
const ACCUMULATING_RATIO = 1.9;
/** 刷新率采样帧数（取中位数，避开启动抖动）。 */
const REFRESH_SAMPLES = 12;
/** 量刷新率最多等多久：后台标签页里 rAF 一帧都不来，不能把启动卡死。 */
const REFRESH_TIMEOUT_MS = 600;

/**
 * 后台保活。
 *
 * 标签页被切到后台（或窗口被完全遮住）时 rAF 停发，画面就冻在最后一帧上。
 * 这时改用定时器自己喂帧：隐藏页的定时器先被压到 1 秒一次、5 分钟后再压到
 * 1 分钟一次，所以每帧的预算必须一次给足 —— 一秒一次小预算等于没算。
 *
 * 900 ms 而不是 1000：给浏览器和合成器留一成。
 */
const BACKGROUND_BUDGET_MS = 900;
/** 多久没提交过一帧就认为 rAF 停了。 */
const STALL_MS = 700;
/** rAF 还活着时的轮询间隔：只是看一眼，不做事。 */
const KEEPALIVE_POLL_MS = 250;
/** 顶上 rAF 之后的尝试间隔：让 GPU 连轴转。 */
const KEEPALIVE_RETRY_MS = 16;

/**
 * 帧循环。
 *
 * 只负责「什么时候再渲染一帧」和「每帧的 GPU 预算」，不知道场景、相机、材质的存在。
 */
export class RenderLoop {
    public running = false;
    private animFrameId: number | null = null;
    private onFrame?: FrameCallback;
    private lastFrameTime = 0;
    /** boot/stop 代际号：防止 stop 之后旧的 rAF 链继续跑。 */
    private generation = 0;
    /** 实测的刷新间隔（毫秒），每帧的预算按它乘比例算。 */
    private refreshMs = 1000 / 60;
    /** 后台保活开关：打开后 rAF 停了也有定时器顶上。 */
    private keepRunning = false;
    private keepAliveId: number | null = null;
    /** 最近一次提交帧的时间，用来判断 rAF 是不是停了。 */
    private lastSubmit = 0;
    private readonly frame: Frame;

    constructor(frame: Frame) {
        this.frame = frame;
        this.boot();
    }

    public boot(): void {
        if (this.running) return;
        this.running = true;
        const generation = ++this.generation;

        // 先空跑几帧量刷新率。这里不提交任何 GPU 工作，rAF 间隔就是显示器的
        // 呈现节奏；比用「渲染帧间隔」可靠（后者会被 GPU 负载拉长成 2×/3×）。
        this.measureRefresh(generation, (refreshMs) => {
            if (!this.running || generation !== this.generation) return;
            this.refreshMs = refreshMs;
            this.frame.setTargetFrameMs(refreshMs * RESPONSIVE_RATIO);
            this.lastFrameTime = 0;
            this.tick(generation);
        });
    }

    public stop(): void {
        this.running = false;
        this.generation++;
        if (this.animFrameId !== null) {
            cancelAnimationFrame(this.animFrameId);
            this.animFrameId = null;
        }
        this.setKeepRunning(false);
    }

    public setOnFrame(cb?: FrameCallback): void {
        this.onFrame = cb;
    }

    /**
     * 后台保活开关：标签页不可见、rAF 停发时，用定时器继续喂 GPU。
     *
     * 只换驱动方式，不换渲染内容 —— 采样预算、累积游标都由 PathTracePass 管，
     * 后台只是把每帧预算放到接近一秒。
     */
    public setKeepRunning(on: boolean): void {
        if (on === this.keepRunning) return;
        this.keepRunning = on;
        if (this.keepAliveId !== null) {
            clearTimeout(this.keepAliveId);
            this.keepAliveId = null;
        }
        if (!on) return;
        this.lastSubmit = performance.now();
        this.keepAlive();
    }

    private measureRefresh(generation: number, done: (ms: number) => void): void {
        const deltas: number[] = [];
        let last = 0;
        let finished = false;
        const finish = (ms: number) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            done(ms);
        };
        // 后台标签页里 rAF 一帧都不来，等满 12 帧等于永远等下去。
        // 等不到就按默认 60 Hz 起跑，等回到前台再让真实间隔自然接管。
        const timeout = setTimeout(() => finish(this.refreshMs), REFRESH_TIMEOUT_MS);
        const step = (now: number) => {
            if (!this.running || generation !== this.generation) return;
            if (last !== 0) deltas.push(now - last);
            last = now;
            if (deltas.length < REFRESH_SAMPLES) {
                requestAnimationFrame(step);
                return;
            }
            deltas.sort((a, b) => a - b);
            const median = deltas[deltas.length >> 1]!;
            // 夹到 [30Hz, 240Hz]：后台节流或异常采样不该把预算带偏
            finish(Math.min(1000 / 30, Math.max(1000 / 240, median)));
        };
        requestAnimationFrame(step);
    }

    /**
     * 后台保活的定时器链。
     *
     * rAF 还活着（窗口可见）时每 250 ms 扫一眼不动手；一旦超过 STALL_MS 没有
     * 提交，就认定 rAF 被停掉了，自己提交帧并每 16 ms 再来一次。回到前台后
     * rAF 重新开始提交，这条链自动退回「只扫不动手」。
     */
    private keepAlive(): void {
        this.keepAliveId = null;
        if (!this.keepRunning || !this.running) return;

        const stalled = performance.now() - this.lastSubmit > STALL_MS;
        if (!stalled) {
            this.keepAliveId = setTimeout(() => this.keepAlive(), KEEPALIVE_POLL_MS);
            return;
        }

        // 隐藏页的定时器最少一秒才来一次，预算必须一次给足。
        this.frame.setTargetFrameMs(BACKGROUND_BUDGET_MS);
        if (this.frame.readyForNextFrame && this.frame.renderFrame()) {
            this.lastSubmit = performance.now();
        }
        this.keepAliveId = setTimeout(() => this.keepAlive(), KEEPALIVE_RETRY_MS);
    }

    private tick(generation: number): void {
        if (!this.running || generation !== this.generation) return;

        // 上一帧的 GPU 还没跑完就跳过这一帧：稳态预算允许一帧占两个刷新间隔，
        // 无条件每帧提交会让提交速度超过 GPU，队列越积越深，读回槽位占满之后
        // 采样量就冻住不动了（表现为卡在 MIN_DISPATCH 上）。跳过 rAF 不算亏——
        // 这一帧本来就来不及画。
        if (this.frame.readyForNextFrame && this.frame.renderFrame()) {
            // 下一帧的预算：本帧重开过累积（画面正在被改动）就用响应档，
            // 否则画面只是在累积，用吞吐档。预算下发晚一帧正好 —— 本帧的
            // 采样量在提交前就定了，这里改的是下一帧。
            // 后台保活把预算抬到 0.9 秒的地方（见 keepAlive）也靠这里拉回来。
            this.frame.setTargetFrameMs(
                this.refreshMs * (this.frame.restarted ? RESPONSIVE_RATIO : ACCUMULATING_RATIO),
            );

            const prev = this.lastFrameTime;
            const now = performance.now();
            this.lastFrameTime = now;
            this.lastSubmit = now;
            if (prev !== 0) {
                this.onFrame?.(this.frame.stats(now - prev));
            }
        }

        this.animFrameId = requestAnimationFrame(() => this.tick(generation));
    }
}

export type FrameCallback = (stats: FrameStats) => void;
