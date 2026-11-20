/**
 * 渲染表面：主线程的 canvas，或交给 Worker 的 OffscreenCanvas。
 *
 * 两者在 WebGPU 眼里是同一种东西，区别只在尺寸怎么来 —— 主线程可以读
 * clientWidth，Worker 读不到，只能由主线程通过 camera.resize 送进来。
 */
export type RenderSurface = HTMLCanvasElement | OffscreenCanvas;

/**
 * GPU 基础设施：申请设备（createDevice）并把 GPUDevice 和 canvas 绑定为一个整体。
 * RenderContext 是渲染目标尺寸的单一持有者。
 *
 * Canvas 的宽高是共享基础设施，不属于任何单个 pass；尺寸变化通过 onResize 订阅通知
 * 各组件（Camera / PathTracePass 等），各自响应。驱动方式为每帧在渲染循环里调用
 * applyResizeIfNeeded()，符合业界 "deferred resize" 实践（ResizeObserver 或逐帧检测
 * 只记录尺寸，应用放到 render loop 中 getCurrentTexture 之前）。
 *
 * OffscreenCanvas 没有 clientWidth/devicePixelRatio，逐帧探测没有意义：
 * 尺寸由 setSize() 从外部（Worker 收到的 resize 命令）直接给。
 */
export class RenderContext {
    public readonly device: GPUDevice;
    /** 平台首选 canvas 格式，device 无关，构造时即可确定。 */
    public readonly format: GPUTextureFormat = navigator.gpu.getPreferredCanvasFormat();
    private ctx: GPUCanvasContext | null = null;
    private _width = 0;
    private _height = 0;
    private resizeListeners: Array<(width: number, height: number) => void> = [];
    private readonly canvasEl: RenderSurface;
    private readonly offscreen: boolean;

    constructor(device: GPUDevice, canvas: RenderSurface) {
        this.device = device;
        this.canvasEl = canvas;
        // Worker 里没有 HTMLCanvasElement 这个全局，instanceof 前要先看它存不存在
        this.offscreen = typeof HTMLCanvasElement === 'undefined' || !(canvas instanceof HTMLCanvasElement);
        const ctx = canvas.getContext('webgpu');
        if (!ctx) throw new Error('Failed to get WebGPU context');
        this.ctx = ctx;
        this.ctx.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });
    }

    public gpuContext(): GPUCanvasContext | null {
        return this.ctx;
    }

    public canvas(): RenderSurface {
        return this.canvasEl;
    }

    /** 尺寸来源是外部（OffscreenCanvas）：直接应用并通知订阅者。 */
    public setSize(width: number, height: number): void {
        if (width <= 0 || height <= 0) return;
        if (width === this._width && height === this._height) return;
        this._width = width;
        this._height = height;
        this.canvasEl.width = width;
        this.canvasEl.height = height;
        for (const fn of this.resizeListeners) fn(width, height);
    }

    public width(): number {
        return this._width;
    }

    public height(): number {
        return this._height;
    }

    /**
     * 每帧调用：把 canvas 当前 CSS 尺寸 × devicePixelRatio 应用到 backing store。
     * 尺寸变化时通知所有订阅者，返回是否发生变化。DPR 动态读取，支持换屏。
     */
    public applyResizeIfNeeded(): boolean {
        // 离屏画布的主尺寸由 setSize() 管，这里不猜
        if (this.offscreen) return false;
        const canvas = this.canvasEl as HTMLCanvasElement;
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        const w = Math.round(canvas.clientWidth * dpr);
        const h = Math.round(canvas.clientHeight * dpr);
        if (w === this._width && h === this._height) return false;
        this._width = w;
        this._height = h;
        canvas.width = w;
        canvas.height = h;
        for (const fn of this.resizeListeners) fn(w, h);
        return true;
    }

    /** 注册尺寸变化回调。回调在 applyResizeIfNeeded() 内同步触发。 */
    public onResize(fn: (width: number, height: number) => void): void {
        this.resizeListeners.push(fn);
    }
}

/** 拿不到 WebGPU 设备 —— 调用方据此走降级页，而不是当成普通错误。 */
export class WebGPUUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WebGPUUnavailableError';
    }
}

/**
 * 申请 adapter + device。主线程和 Worker 走同一条 —— 设备的申请条件只写一遍。
 *
 * 浏览器没有 WebGPU、或者拿不到 adapter（驱动进黑名单、虚拟机、关了硬件加速），
 * 都抛 WebGPUUnavailableError；requestDevice 自身的失败原样上抛。
 */
export async function createDevice(): Promise<GPUDevice> {
    if (!navigator.gpu) {
        throw new WebGPUUnavailableError('WebGPU not supported. Try Chrome 113+.');
    }

    // 双显卡笔记本上 dGPU 休眠时 'high-performance' 档可能拿不到 adapter，
    // 超时或 null 都退回默认档再试一次。
    const adapter =
        (await raceTimeout(
            navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }),
            ADAPTER_TIMEOUT_MS,
        )) ?? (await raceTimeout(navigator.gpu.requestAdapter(), ADAPTER_TIMEOUT_MS));
    if (!adapter) {
        throw new WebGPUUnavailableError(
            'No WebGPU adapter. 打开 chrome://gpu 确认 WebGPU 为 Enabled，' +
                '并检查系统设置里「使用图形加速」是否开启。',
        );
    }

    // 时间戳用于测量每帧 GPU 采样耗时（采样预算控制器的输入）。
    // 拿不到就退回 onSubmittedWorkDone，不影响渲染。
    const requiredFeatures: GPUFeatureName[] = [];
    if (adapter.features.has('timestamp-query')) requiredFeatures.push('timestamp-query');

    return adapter.requestDevice({ requiredFeatures });
}

/** requestAdapter 在某些机器上会一直不 resolve，别让调用方无限等待。 */
const ADAPTER_TIMEOUT_MS = 8000;

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), ms);
        p.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            () => {
                clearTimeout(timer);
                resolve(null);
            },
        );
    });
}
