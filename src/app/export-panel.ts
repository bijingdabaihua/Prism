import type { Engine } from '../engine/engine';
import type { Scene } from '../ir/scene';
import { exportVideo, type ExportProgress, type VideoSettings } from './video-export';

/**
 * 导出面板：右上角一颗按钮，点开是一张表单 —— 分辨率、帧率、时长、每帧采样、码率。
 *
 * 导出期间把表单锁住、把进度顶上来。所有时间都是「已用 / 剩余」，
 * 因为这类渲染动辄十几分钟，没有剩余时间就没法决定要不要去泡杯茶。
 */

const RESOLUTIONS = [
    { label: '1280 × 720', width: 1280, height: 720 },
    { label: '1920 × 1080', width: 1920, height: 1080 },
    { label: '2560 × 1440', width: 2560, height: 1440 },
    { label: '3840 × 2160', width: 3840, height: 2160 },
];
const FPS_CHOICES = [24, 30, 60];
const DEFAULT_DURATION = 6;
const DEFAULT_SPP = 16;
const DEFAULT_MBPS = 12;

export class ExportPanel {
    public readonly element: HTMLElement;

    private readonly engine: Engine;
    private readonly scene: Scene;
    private readonly onExportChange: (busy: boolean) => void;

    private readonly panel: HTMLElement;
    private readonly toggle: HTMLButtonElement;
    private readonly resolution: HTMLSelectElement;
    private readonly fpsSelect: HTMLSelectElement;
    private readonly duration: HTMLInputElement;
    private readonly sppInput: HTMLInputElement;
    private readonly bitrate: HTMLInputElement;
    private readonly summary: HTMLElement;
    private readonly bar: HTMLElement;
    private readonly barFill: HTMLElement;
    private readonly status: HTMLElement;
    private readonly startButton: HTMLButtonElement;
    private readonly cancelButton: HTMLButtonElement;

    private busy = false;
    private abort: AbortController | null = null;
    private disposed = false;

    constructor(engine: Engine, scene: Scene, onExportChange: (busy: boolean) => void) {
        this.engine = engine;
        this.scene = scene;
        this.onExportChange = onExportChange;

        const root = document.createElement('div');
        root.className = 'stage-export';

        this.toggle = document.createElement('button');
        this.toggle.className = 'export-toggle';
        this.toggle.textContent = '导出视频';
        root.appendChild(this.toggle);

        this.panel = document.createElement('div');
        this.panel.className = 'export-panel hidden';
        root.appendChild(this.panel);

        this.resolution = this.addSelect('分辨率', RESOLUTIONS.map((r) => r.label), 1);
        this.fpsSelect = this.addSelect(
            '帧率',
            FPS_CHOICES.map((f) => `${f} fps`),
            1,
        );
        this.duration = this.addNumber(
            '时长',
            scene.cameraPath?.duration ?? DEFAULT_DURATION,
            1,
            120,
            '秒',
        );
        this.sppInput = this.addNumber('每帧采样', DEFAULT_SPP, 1, 512, 'spp');
        this.bitrate = this.addNumber('码率', DEFAULT_MBPS, 1, 200, 'Mbps');

        this.summary = document.createElement('div');
        this.summary.className = 'export-summary';
        this.panel.appendChild(this.summary);

        const barWrap = document.createElement('div');
        barWrap.className = 'export-bar hidden';
        this.bar = barWrap;
        this.barFill = document.createElement('div');
        this.barFill.className = 'export-bar-fill';
        barWrap.appendChild(this.barFill);
        this.panel.appendChild(barWrap);

        this.status = document.createElement('div');
        this.status.className = 'export-status hidden';
        this.panel.appendChild(this.status);

        const actions = document.createElement('div');
        actions.className = 'export-actions';
        this.startButton = document.createElement('button');
        this.startButton.className = 'export-start';
        this.startButton.textContent = '开始导出';
        this.cancelButton = document.createElement('button');
        this.cancelButton.className = 'export-close';
        this.cancelButton.textContent = '收起';
        actions.append(this.startButton, this.cancelButton);
        this.panel.appendChild(actions);

        this.element = root;
        this.bind();
        this.refreshSummary();
    }

    public destroy(): void {
        this.disposed = true;
        this.abort?.abort();
        this.element.remove();
    }

    private addSelect(label: string, options: string[], selected: number): HTMLSelectElement {
        const row = document.createElement('label');
        row.className = 'export-row';
        const name = document.createElement('span');
        name.textContent = label;
        const select = document.createElement('select');
        options.forEach((text, i) => {
            const option = document.createElement('option');
            option.textContent = text;
            option.value = String(i);
            if (i === selected) option.selected = true;
            select.appendChild(option);
        });
        row.append(name, select);
        this.panel.appendChild(row);
        return select;
    }

    private addNumber(
        label: string,
        value: number,
        min: number,
        max: number,
        unit: string,
    ): HTMLInputElement {
        const row = document.createElement('label');
        row.className = 'export-row';
        const name = document.createElement('span');
        name.textContent = label;
        const input = document.createElement('input');
        input.type = 'number';
        input.min = String(min);
        input.max = String(max);
        input.step = '1';
        input.value = String(value);
        const suffix = document.createElement('span');
        suffix.className = 'export-unit';
        suffix.textContent = unit;
        const wrap = document.createElement('span');
        wrap.className = 'export-field';
        wrap.append(input, suffix);
        row.append(name, wrap);
        this.panel.appendChild(row);
        return input;
    }

    private bind(): void {
        this.toggle.addEventListener('click', () => {
            this.panel.classList.toggle('hidden');
            this.toggle.classList.toggle('active', !this.panel.classList.contains('hidden'));
        });
        for (const el of [this.resolution, this.fpsSelect, this.duration, this.sppInput, this.bitrate]) {
            el.addEventListener('input', () => this.refreshSummary());
        }
        this.startButton.addEventListener('click', () => void this.start());
        this.cancelButton.addEventListener('click', () => {
            if (this.busy) this.abort?.abort();
            else this.panel.classList.add('hidden');
        });
    }

    private settings(): VideoSettings {
        const res = RESOLUTIONS[Number(this.resolution.value)] ?? RESOLUTIONS[1]!;
        const fps = FPS_CHOICES[Number(this.fpsSelect.value)] ?? 30;
        const duration = clamp(numberOf(this.duration, DEFAULT_DURATION), 1, 120);
        return {
            width: res.width,
            height: res.height,
            fps,
            frames: Math.max(1, Math.round(duration * fps)),
            spp: Math.round(clamp(numberOf(this.sppInput, DEFAULT_SPP), 1, 512)),
            bitrate: clamp(numberOf(this.bitrate, DEFAULT_MBPS), 1, 200) * 1e6,
        };
    }

    private refreshSummary(): void {
        const s = this.settings();
        const seconds = s.frames / s.fps;
        const megabytes = (s.bitrate * seconds) / 8 / 1e6;
        const still = this.scene.cameraPath ? '' : ' · 无轨迹（静止画面）';
        this.summary.textContent =
            `${s.width} × ${s.height} · ${s.fps} fps · ${s.frames} 帧 · ` +
            `${seconds.toFixed(1)} 秒 · 约 ${megabytes.toFixed(1)} MB${still}`;
    }

    private async start(): Promise<void> {
        if (this.busy) return;
        const settings = this.settings();
        const controller = new AbortController();
        this.abort = controller;
        this.busy = true;
        this.setBusyUi(true);
        this.bar.classList.remove('hidden');
        this.status.classList.remove('hidden');
        this.onExportChange(true);

        try {
            const blob = await exportVideo(
                this.engine,
                this.scene.camera,
                this.scene.cameraPath,
                settings,
                (p) => this.showProgress(p),
                controller.signal,
            );
            if (this.disposed) return;
            this.download(blob, settings);
            this.setStatus(`已导出 ${(blob.size / 1e6).toFixed(1)} MB，开始下载`);
            this.barFill.style.width = '100%';
        } catch (err) {
            if (this.disposed) return;
            const aborted = err instanceof DOMException && err.name === 'AbortError';
            this.setStatus(aborted ? '已取消' : `导出失败：${(err as Error)?.message ?? err}`);
            this.barFill.style.width = '0%';
        } finally {
            if (!this.disposed) {
                this.busy = false;
                this.abort = null;
                this.setBusyUi(false);
                this.onExportChange(false);
            }
        }
    }

    private showProgress(p: ExportProgress): void {
        const ratio = p.frame / p.frames;
        this.barFill.style.width = `${(ratio * 100).toFixed(1)}%`;
        // 第一帧还没跑完时没有可信的每帧耗时，宁可显示 --:-- 也不要报个 0:00
        const perFrame = p.frame > 0 ? p.elapsedMs / p.frame : NaN;
        const remaining = perFrame * (p.frames - p.frame);
        this.setStatus(
            `第 ${Math.min(p.frame + 1, p.frames)} / ${p.frames} 帧 · ` +
                `当前帧 ${p.samples} / ${p.spp} spp · ` +
                `已用 ${clock(p.elapsedMs)} · 剩余约 ${clock(remaining)}`,
        );
    }

    private setStatus(text: string): void {
        this.status.textContent = text;
    }

    private setBusyUi(busy: boolean): void {
        this.startButton.disabled = busy;
        this.startButton.textContent = busy ? '导出中…' : '开始导出';
        this.cancelButton.textContent = busy ? '取消' : '收起';
        for (const el of [this.resolution, this.fpsSelect, this.duration, this.sppInput, this.bitrate]) {
            el.disabled = busy;
        }
    }

    private download(blob: Blob, settings: VideoSettings): void {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `prism-${settings.height}p-${settings.fps}fps.mp4`;
        a.click();
        // 下载是异步的，立刻 revoke 会让部分浏览器拿不到内容
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
}

function numberOf(input: HTMLInputElement, fallback: number): number {
    const value = Number(input.value);
    return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/** 毫秒 → m:ss（超过一小时就不客气了） */
function clock(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '--:--';
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}
