import { Prism, PrismUnsupportedError } from '../core/prism';
import { SCENE_CARDS } from './scenes/catalog';

/** 场景编译完之后，再给 Worker 这么久把画面铺满，然后撤 loading。 */
const LOADING_HOLD_MS = 1500;
/** 请求的画面推送间隔：约 60 Hz，实际受渲染帧率限制。 */
const FRAME_INTERVAL_MS = 1000 / 60;

/**
 * 渲染页外壳：画布、输入、加载状态。
 *
 * 这里只认识 `Prism` —— 画面是 Worker 推回来的 ImageBitmap，主线程用
 * bitmaprenderer 直接贴上，不碰任何 GPU 资源。
 */
export class RenderView {
    private prism: Prism | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private context: ImageBitmapRenderingContext | null = null;
    private stage: HTMLElement | null = null;
    private loading: HTMLElement | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private stopListening: (() => void) | null = null;
    private dragging = false;
    private dragMode: '' | 'orbit' | 'pan' | 'zoom' = '';
    private pinching = false;
    private disposed = false;
    private lastX = 0;
    private lastY = 0;
    private pinchDist = 0;
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
            this.pinchDist = touchDistance(e);
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
            const next = touchDistance(e);
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
    private readonly key: string;
    /** 有 WebGPU API、但拿不到设备时交给外层换成降级页。 */
    private readonly onUnsupported: () => void;

    constructor(key: string, onUnsupported: () => void) {
        this.key = key;
        this.onUnsupported = onUnsupported;
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
            const context = canvas.getContext('bitmaprenderer');
            if (!context) throw new Error('浏览器不支持 bitmaprenderer canvas');
            this.context = context;
            stage.insertBefore(canvas, loading);

            this.updateLoading('Initializing GPU...');
            const prism = await Prism.create();
            this.prism = prism;
            // 初始化期间被切走（连点两下卡片）—— 把刚建好的 Worker 还回去
            if (this.disposed) {
                prism.dispose();
                return;
            }

            // Worker 里的画布尺寸只能由主线程量好送进去
            this.watchSize();

            // 返回画廊的入口。浏览器后退也行，但访客不会去按。
            const back = document.createElement('a');
            back.className = 'stage-back';
            back.href = '#/';
            back.textContent = '← 全部场景';
            stage.appendChild(back);

            const card = SCENE_CARDS[this.key];
            if (!card) throw new Error(`没有场景 "${this.key}"`);

            // 场景由外面一步一步装：机位 → 环境图 + 朝向 → 几何配方 → 开始监听
            this.updateLoading('Loading scene...');
            prism.camera.set(card.setup.camera);
            // 环境图以 Blob 交给 Worker：主线程只取字节，解码仍留在 Worker
            // setImage 从原图方向建好；场景需要别的朝向时再由 setRotation 转
            await prism.background.setImage(await fetchBlob(card.setup.env));
            await prism.background.setRotation(card.setup.envRotation ?? 0);
            // 配方也走 Blob：core 只传字节，格式由 Worker 里的 app/scenes 解释
            await prism.scene.load(
                new Blob([JSON.stringify(card.geometry)], { type: 'application/json' }),
            );
            if (this.disposed) {
                prism.dispose();
                return;
            }

            // 画面从这一条流里来：Worker 每帧推一张 ImageBitmap，贴上即显示
            this.stopListening = prism.camera.listen(FRAME_INTERVAL_MS, (bitmap) => {
                if (!this.context) {
                    bitmap.close();
                    return;
                }
                this.context.transferFromImageBitmap(bitmap);
            });
            this.bindInput();

            // 编译完成不等于画面已经铺满：采样预算从 4096 像素/帧起步，
            // 等一小会儿再撤 loading，避免露出半张没光的画面。
            await new Promise<void>((resolve) => setTimeout(resolve, LOADING_HOLD_MS));
            loading.classList.add('hidden');
        } catch (err) {
            if (this.disposed) return;
            if (err instanceof PrismUnsupportedError) {
                this.onUnsupported();
                return;
            }
            this.updateLoading(err instanceof Error ? err.message : String(err), true);
            loading.classList.add('error');
        }
    }

    public unmount(): void {
        this.disposed = true;
        this.stopListening?.();
        this.stopListening = null;
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.prism?.dispose();
        this.prism = null;

        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('mouseup', this.onMouseUp);

        this.loading?.remove();
        this.loading = null;
        this.context = null;
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
            // bitmaprenderer 不会因为贴位图而改宽高属性，这里跟 Worker 保持一致
            canvas.width = width;
            canvas.height = height;
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

    private orbit(dx: number, dy: number): void {
        this.prism?.camera.orbit(dx * 0.008, -dy * 0.008);
    }

    private pan(dx: number, dy: number): void {
        this.prism?.camera.pan(dx, dy);
    }

}

async function fetchBlob(url: string): Promise<Blob> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to load ${url} (${resp.status})`);
    return resp.blob();
}

function touchDistance(e: TouchEvent): number {
    const a = e.touches[0];
    const b = e.touches[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}
