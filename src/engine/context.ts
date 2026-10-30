/**
 * RenderContext 把 GPUDevice 和 canvas 绑定为一个整体，作为渲染目标尺寸的单一持有者。
 *
 * Canvas 的宽高是共享基础设施，不属于任何单个 pass；尺寸变化通过 onResize 订阅通知
 * 各组件（Camera / PathTracePass 等），各自响应。驱动方式为每帧在渲染循环里调用
 * applyResizeIfNeeded()，符合业界 "deferred resize" 实践（ResizeObserver 或逐帧检测
 * 只记录尺寸，应用放到 render loop 中 getCurrentTexture 之前）。
 */
export class RenderContext {
    public readonly device: GPUDevice;
    /** 平台首选 canvas 格式，device 无关，构造时即可确定。 */
    public readonly format: GPUTextureFormat = navigator.gpu.getPreferredCanvasFormat();
    private canvasEl: HTMLCanvasElement | null = null;
    private ctx: GPUCanvasContext | null = null;
    private _width = 0;
    private _height = 0;
    /** 导出期间尺寸被钉死，不再跟 CSS 走。 */
    private forced = false;
    private resizeListeners: Array<(width: number, height: number) => void> = [];

    constructor(device: GPUDevice, canvas: HTMLCanvasElement) {
        this.device = device;
        this.canvasEl = canvas;
        const ctx = canvas.getContext('webgpu');
        if (!ctx) throw new Error('Failed to get WebGPU context');
        this.ctx = ctx;
        this.ctx.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });
    }

    public gpuContext(): GPUCanvasContext | null {
        return this.ctx;
    }

    public canvas(): HTMLCanvasElement | null {
        return this.canvasEl;
    }

    /**
     * 把渲染尺寸钉死在给定分辨率，不再跟 CSS 尺寸走 —— 导出视频要用它。
     *
     * 传 null 恢复：把当前尺寸清零，下一次 applyResizeIfNeeded() 会按 CSS 重算
     * 并通知订阅者（累积纹理、相机宽高比都跟着重建）。
     */
    public forceSize(width: number | null, height = 0): void {
        const canvas = this.canvasEl;
        if (!canvas) return;
        if (width === null) {
            this.forced = false;
            this._width = 0;
            this._height = 0;
            return;
        }
        this.forced = true;
        this._width = width;
        this._height = height;
        canvas.width = width;
        canvas.height = height;
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
        const canvas = this.canvasEl;
        if (!canvas || this.forced) return false;
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
