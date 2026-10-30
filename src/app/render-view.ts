import { Engine } from '../engine/engine';
import type { FrameStats } from '../engine/frame/frame';
import type { SceneEntry } from '../config/config';
import { ExportPanel } from './export-panel';

/**
 * 渲染页外壳：画布、输入、加载状态、HUD。
 *
 * 这里可以出现 DOM 与事件；engine/ 不行。
 */
export class RenderView {
    private engine: Engine | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private stage: HTMLElement | null = null;
    private hud: HTMLElement | null = null;
    private loading: HTMLElement | null = null;
    private exportPanel: ExportPanel | null = null;
    private dragging = false;
    private dragMode: '' | 'orbit' | 'pan' | 'zoom' = '';
    private pinching = false;
    private disposed = false;
    private lastX = 0;
    private lastY = 0;
    private pinchDist = 0;
    /** 后台继续渲染的开关状态，HUD 末尾显示。 */
    private keepRunning = false;
    private denoising = false;
    private lastStats: FrameStats | null = null;
    /** 开关打开期间挂着的静音音源，见 startSilentAudio。 */
    private silentAudio: { ctx: AudioContext; osc: OscillatorNode } | null = null;
    private readonly config: SceneEntry;

    constructor(config: SceneEntry) {
        this.config = config;
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
            const engine = await Engine.create(canvas);
            this.engine = engine;
            // 初始化期间被切走（连点两下卡片）—— 把刚建好的 device 还回去
            if (this.disposed) {
                engine.destroy();
                return;
            }

            const hud = document.createElement('div');
            hud.className = 'hud';
            this.hud = hud;
            stage.appendChild(hud);

            // 返回画廊的入口。浏览器后退也行，但访客不会去按。
            const back = document.createElement('a');
            back.className = 'stage-back';
            back.href = '#/';
            back.textContent = '← 全部场景';
            stage.appendChild(back);

            const hint = document.createElement('div');
            hint.className = 'stage-hint';
            hint.textContent =
                '实时路径追踪 · 中键旋转 · Shift+中键平移 · 滚轮缩放 · 按 D 降噪 · 按 S 保存截图 · 按 K 后台继续渲染 · 右上角导出视频';
            stage.appendChild(hint);

            this.updateLoading('Loading scene...');
            const scene = await this.config.scene.load();
            if (this.disposed) {
                engine.destroy();
                return;
            }
            engine.setScene(scene);
            engine.loop.setOnFrame((stats) => this.renderHud(stats));

            const exportPanel = new ExportPanel(engine, scene, (busy) => {
                stage.classList.toggle('exporting', busy);
            });
            this.exportPanel = exportPanel;
            stage.appendChild(exportPanel.element);

            this.bindInput();
            hint.classList.add('shown');
            setTimeout(() => hint.classList.remove('shown'), 6000);

            // 第一帧真正提交之后再撤 loading：BVH 和贴图上传都在 setScene 里同步做完，
            // 撤早了会露出半张没光/没几何的画面。
            // 后台标签页里 rAF 不触发，加个兜底，否则 loading 永远挂着。
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 2000);
                requestAnimationFrame(() =>
                    requestAnimationFrame(() => {
                        clearTimeout(timer);
                        resolve();
                    }),
                );
            });
            loading.classList.add('hidden');
        } catch (err: any) {
            this.updateLoading(err?.message ?? String(err), true);
            loading.classList.add('error');
        }
    }

    public unmount(): void {
        this.disposed = true;
        this.stopSilentAudio();
        this.exportPanel?.destroy();
        this.exportPanel = null;
        if (this.engine) {
            this.engine.destroy();
            this.engine = null;
        }
        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('mouseup', this.onMouseUp);
        window.removeEventListener('keydown', this.onKeyDown);

        this.hud?.remove();
        this.hud = null;
        this.loading?.remove();
        this.loading = null;
        this.canvas = null;
        this.stage?.remove();
        this.stage = null;
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

    private renderHud(stats: FrameStats): void {
        this.lastStats = stats;
        if (!this.hud) return;
        // 采样耗时单独列出来：它和总耗时的差就是显示 + 提交间隙。
        // 采样量掉到下限时，一眼能分清是「算得慢」还是「在等呈现」。
        this.hud.textContent =
            `${stats.pixels.toLocaleString()} px/帧 · ${stats.samples} spp · ` +
            `${stats.gpuMs.toFixed(1)} ms（采样 ${stats.samplingMs.toFixed(1)}）· ` +
            `${stats.fps.toFixed(0)} fps` +
            (this.denoising ? ' · 降噪' : '') +
            (this.keepRunning ? ' · 后台继续中' : '');
    }

    /**
     * 后台继续渲染。
     *
     * 光靠 loop 的定时器兜底不够：隐藏的标签页会被浏览器节流，定时器先被压到
     * 一秒一次、五分钟后再压到一分钟一次 —— 一分钟一帧等于没在算。正在播放
     * 音频的页面不受这条约束，所以开关打开时挂一个 -80 dB 的振荡器，耳朵听不见，
     * 但页面不再是「安静的」。代价是标签上多一个喇叭图标。
     *
     * 用键盘事件触发，正好满足自动播放策略要求的用户手势。
     */
    private toggleKeepRunning(): void {
        this.keepRunning = !this.keepRunning;
        this.engine?.loop.setKeepRunning(this.keepRunning);
        if (this.keepRunning) this.startSilentAudio();
        else this.stopSilentAudio();
        // 开关状态挂在 HUD 末尾，不用等下一帧
        if (this.lastStats) this.renderHud(this.lastStats);
    }

    private startSilentAudio(): void {
        if (this.silentAudio) return;
        try {
            const ctx = new AudioContext();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            // 不是 0：完全静音的信号有的实现会当成「没在放」
            gain.gain.value = 1e-4;
            osc.connect(gain).connect(ctx.destination);
            osc.start();
            void ctx.resume();
            this.silentAudio = { ctx, osc };
        } catch {
            // 没有音频设备也不影响：定时器兜底照跑，只是可能被降频
        }
    }

    private stopSilentAudio(): void {
        if (!this.silentAudio) return;
        try {
            this.silentAudio.osc.stop();
        } catch {
            /* 已经停了 */
        }
        void this.silentAudio.ctx.close();
        this.silentAudio = null;
    }

    private downloadScreenshot(): void {
        if (!this.canvas) return;
        this.canvas.toBlob((blob) => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `render-${this.config.card.title.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}.png`;
            a.click();
            URL.revokeObjectURL(url);
        }, 'image/png');
    }

    private orbit(dx: number, dy: number): void {
        const cam = this.engine?.camera;
        if (!cam) return;
        cam.orbitTheta(dx * 0.008);
        cam.orbitPhi(-dy * 0.008);
    }

    private pan(dx: number, dy: number): void {
        this.engine?.camera.pan(dx, dy);
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
            this.engine?.camera.zoom(Math.exp(dy * 0.005));
        }
    };

    private onMouseUp = () => {
        this.dragging = false;
        this.dragMode = '';
    };

    private onWheel = (e: WheelEvent) => {
        e.preventDefault();
        this.engine?.camera.zoom(e.deltaY > 0 ? 1.1 : 0.9);
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
                this.engine?.camera.zoom(this.pinchDist / next);
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
        if (e.key === 's' || e.key === 'S') this.downloadScreenshot();
        else if (e.key === 'k' || e.key === 'K') this.toggleKeepRunning();
        else if (e.key === 'd' || e.key === 'D') this.toggleDenoise();
    };

    /** 空间降噪开关：低 spp 时压噪声，高 spp 时反而会糊，随时可以关掉对比。 */
    private toggleDenoise(): void {
        const frame = this.engine?.frame;
        if (!frame) return;
        this.denoising = !this.denoising;
        frame.setDenoise(this.denoising);
        if (this.lastStats) this.renderHud(this.lastStats);
    }

    private touchDistance(e: TouchEvent): number {
        const a = e.touches[0];
        const b = e.touches[1];
        return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }
}
