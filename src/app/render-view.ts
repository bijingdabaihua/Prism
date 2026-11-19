import { Prism } from '../core';
import type { SceneEntry } from '../config/config';

/** 场景编译完之后，再给 Worker 这么久把画面铺满，然后撤 loading。 */
const LOADING_HOLD_MS = 1500;

/**
 * 渲染页外壳：画布、输入、加载状态、HUD。
 *
 * 这里只认识 `Prism` —— 画布交给它的 Worker，指针事件翻译成相机命令，
 * 尺寸从 DOM 量出来送进去。主线程不碰任何 GPU 资源。
 */
export class RenderView {
    private prism: Prism | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private stage: HTMLElement | null = null;
    private loading: HTMLElement | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private dragging = false;
    private dragMode: '' | 'orbit' | 'pan' | 'zoom' = '';
    private pinching = false;
    private disposed = false;
    private lastX = 0;
    private lastY = 0;
    private pinchDist = 0;
    private readonly config: SceneEntry;
    private readonly key: string;

    constructor(config: SceneEntry, key: string) {
        this.config = config;
        this.key = key;
    }

    public async mount(container: HTMLElement): Promise<void> {
        const stage = document.createElement('div');
        stage.className = 'stage';
        this.stage = stage;
        container.appendChild(stage);

        const loading = this.buildLoading();
        this.loading = loading;
        stage.appendChild(loading);

        try {
            const canvas = document.createElement('canvas');
            this.canvas = canvas;
            stage.insertBefore(canvas, loading);

            this.updateLoading('Initializing GPU...');
            const prism = await Prism.create(canvas);
            this.prism = prism;
            // 初始化期间被切走（连点两下卡片）—— 把刚建好的 Worker 还回去
            if (this.disposed) {
                prism.dispose();
                return;
            }

            // 画布已经是离屏的了，尺寸只能从 DOM 量出来送进去
            this.watchSize();

            // 返回画廊的入口。浏览器后退也行，但访客不会去按。
            const back = document.createElement('a');
            back.className = 'stage-back';
            back.href = '#/';
            back.textContent = '← 全部场景';
            stage.appendChild(back);

            const hint = document.createElement('div');
            hint.className = 'stage-hint';
            hint.textContent = '实时路径追踪 · 拖动旋转 · 滚轮缩放 · 按 S 保存截图';
            stage.appendChild(hint);

            this.updateLoading('Loading scene...');
            await prism.model.setScene(this.key);
            if (this.disposed) {
                prism.dispose();
                return;
            }
            this.bindInput();
            hint.classList.add('shown');
            setTimeout(() => hint.classList.remove('shown'), 6000);

            // 编译完成不等于画面已经铺满：Worker 的采样预算从 4096 像素/帧起步，
            // 页面这边看不到它的帧进度，只能等一小会儿再撤 loading。
            // 底下的画布其实一直在画，等的是「不再是零星几点」的那一刻。
            await new Promise<void>((resolve) => setTimeout(resolve, LOADING_HOLD_MS));
            loading.classList.add('hidden');
        } catch (err) {
            this.updateLoading(err instanceof Error ? err.message : String(err), true);
            loading.classList.add('error');
        }
    }

    public unmount(): void {
        this.disposed = true;
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.prism?.dispose();
        this.prism = null;

        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('mouseup', this.onMouseUp);
        window.removeEventListener('keydown', this.onKeyDown);

        this.loading?.remove();
        this.loading = null;
        this.canvas = null;
        this.stage?.remove();
        this.stage = null;
    }

    /** 把画布的物理像素尺寸喂给相机（Worker 里读不到 clientWidth / dpr）。 */
    private watchSize(): void {
        const canvas = this.canvas;
        if (!canvas) return;
        const apply = () => {
            const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
            const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
            const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
            this.prism?.camera.resize({ width, height });
        };
        this.resizeObserver = new ResizeObserver(apply);
        this.resizeObserver.observe(canvas);
        apply();
    }

    private bindInput(): void {
        const canvas = this.canvas;
        if (!canvas) return;
        canvas.addEventListener('mousedown', this.onMouseDown);
        canvas.addEventListener('wheel', this.onWheel, { passive: false });
        canvas.addEventListener('contextmenu', this.onContextMenu);
        canvas.addEventListener('touchstart', this.onTouchStart, { passive: false });
        canvas.addEventListener('touchmove', this.onTouchMove, { passive: false });
        canvas.addEventListener('touchend', this.onTouchEnd);
        window.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('mouseup', this.onMouseUp);
        window.addEventListener('keydown', this.onKeyDown);
    }

    private buildLoading(): HTMLElement {
        const el = document.createElement('div');
        el.id = 'loading-overlay';
        el.innerHTML = `
      <div class="spinner"></div>
      <div class="msg" id="loading-msg">Initializing...</div>
    `;
        return el;
    }

    private updateLoading(msg: string, isError = false): void {
        const el = this.loading?.querySelector('#loading-msg');
        if (el) el.textContent = msg;
        if (isError) {
            this.loading?.querySelector('.spinner')?.classList.add('hidden');
        }
    }

    /** 截图：Worker 按当前机位编码好 Blob，主线程只负责下载。 */
    private async downloadScreenshot(): Promise<void> {
        const prism = this.prism;
        if (!prism) return;
        try {
            const blob = await prism.camera.takePhoto();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `render-${this.config.card.title.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}.png`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            console.warn('截图失败：', err);
        }
    }

    private orbit(dx: number, dy: number): void {
        this.prism?.camera.orbit(dx * 0.008, -dy * 0.008);
    }

    private pan(dx: number, dy: number): void {
        this.prism?.camera.pan(dx, dy);
    }

    /**
     * 鼠标映射照 Blender 的视口来：
     *
     *   中键拖       转视角
     *   Shift + 中键 平移
     *   Ctrl + 中键  推拉
     *   滚轮         推拉
     *
     * 左键也留给旋转：Mac 触控板没有中键，不然只剩右键平移、没法转视角了。
     */
    private onMouseDown = (e: MouseEvent) => {
        if (e.button === 0) {
            this.dragMode = e.shiftKey ? 'pan' : 'orbit';
        } else if (e.button === 1) {
            this.dragMode = e.ctrlKey || e.metaKey ? 'zoom' : e.shiftKey ? 'pan' : 'orbit';
        } else if (e.button === 2) {
            this.dragMode = 'pan';
        } else {
            return;
        }
        this.dragging = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        e.preventDefault();
    };

    private onMouseMove = (e: MouseEvent) => {
        if (!this.dragging) return;
        const dx = e.clientX - this.lastX;
        const dy = e.clientY - this.lastY;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        if (this.dragMode === 'orbit') {
            this.orbit(dx, dy);
        } else if (this.dragMode === 'pan') {
            this.pan(dx, dy);
        } else if (this.dragMode === 'zoom') {
            // 往上拖推近：指数映射，拖多远都是等比例，不会突然冲过头
            this.prism?.camera.zoom(Math.exp(dy * 0.005));
        }
    };

    private onMouseUp = () => {
        this.dragging = false;
        this.dragMode = '';
    };

    private onWheel = (e: WheelEvent) => {
        e.preventDefault();
        this.prism?.camera.zoom(e.deltaY > 0 ? 1.1 : 0.9);
    };

    private onContextMenu = (e: Event) => {
        e.preventDefault();
    };

    private onTouchStart = (e: TouchEvent) => {
        if (e.touches.length >= 2) {
            this.pinching = true;
            this.pinchDist = this.touchDistance(e);
        } else if (e.touches.length === 1) {
            this.pinching = false;
            this.dragging = true;
            this.dragMode = 'orbit';
            this.lastX = e.touches[0].clientX;
            this.lastY = e.touches[0].clientY;
        }
    };

    private onTouchMove = (e: TouchEvent) => {
        e.preventDefault();
        if (this.pinching && e.touches.length >= 2) {
            const next = this.touchDistance(e);
            if (this.pinchDist > 0 && next > 0) {
                this.prism?.camera.zoom(this.pinchDist / next);
            }
            this.pinchDist = next;
            return;
        }
        if (!this.dragging || e.touches.length !== 1) return;
        const touch = e.touches[0];
        const dx = touch.clientX - this.lastX;
        const dy = touch.clientY - this.lastY;
        this.lastX = touch.clientX;
        this.lastY = touch.clientY;
        this.orbit(dx, dy);
    };

    private onTouchEnd = () => {
        this.dragging = false;
        this.pinching = false;
        this.dragMode = '';
    };

    private onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 's' || e.key === 'S') void this.downloadScreenshot();
    };

    private touchDistance(e: TouchEvent): number {
        const a = e.touches[0];
        const b = e.touches[1];
        return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }
}
