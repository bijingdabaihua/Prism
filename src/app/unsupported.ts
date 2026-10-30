import type { SceneEntry } from '../config/config';

/**
 * 降级页：浏览器没有 WebGPU 时替代渲染页。
 *
 * 落地页要回答三个问题，别的都不重要：这里本来是什么、为什么现在看不到、
 * 怎么才能看到。所以给一张同源渲出来的图，一行原因，一张支持矩阵。
 */
const BROWSERS: ReadonlyArray<readonly [string, string]> = [
    ['Chrome / Edge', '113 及以上，默认开启'],
    ['Safari', '18 及以上'],
    ['Firefox', '需要在 about:config 打开 dom.webgpu.enabled'],
];

export class UnsupportedView {
    private readonly config: SceneEntry;
    private root: HTMLElement | null = null;

    constructor(config: SceneEntry) {
        this.config = config;
    }

    public mount(container: HTMLElement): void {
        const root = document.createElement('div');
        root.className = 'unsupported';

        const back = document.createElement('a');
        back.className = 'unsupported-back';
        back.href = '#/';
        back.textContent = '← 全部场景';
        root.appendChild(back);

        const head = document.createElement('header');
        head.className = 'unsupported-head';
        const title = document.createElement('h1');
        title.textContent = '这个浏览器还跑不了 WebGPU';
        head.appendChild(title);
        const lede = document.createElement('p');
        lede.textContent =
            'Prism 的每一帧都是在显卡上现算的，本站没有预渲染的版本。下面是同一套代码在支持的浏览器里渲出来的样子。';
        head.appendChild(lede);
        root.appendChild(head);

        const figure = document.createElement('figure');
        figure.className = 'unsupported-figure';
        if (this.config.card.cover) {
            const img = document.createElement('img');
            img.src = this.config.card.cover;
            img.alt = this.config.card.title;
            figure.appendChild(img);
        }
        const caption = document.createElement('figcaption');
        caption.textContent = `${this.config.card.title} — ${this.config.card.subtitle}`;
        figure.appendChild(caption);
        root.appendChild(figure);

        const table = document.createElement('table');
        table.className = 'unsupported-table';
        for (const [name, how] of BROWSERS) {
            const row = document.createElement('tr');
            const th = document.createElement('th');
            th.textContent = name;
            const td = document.createElement('td');
            td.textContent = how;
            row.appendChild(th);
            row.appendChild(td);
            table.appendChild(row);
        }
        root.appendChild(table);

        const note = document.createElement('p');
        note.className = 'unsupported-note';
        note.textContent =
            '如果用的已经是新版 Chrome，打开 chrome://gpu 搜 WebGPU，确认状态是 Enabled —— 被企业策略或实验开关关掉时，浏览器版本再新也跑不起来。';
        root.appendChild(note);

        container.appendChild(root);
        this.root = root;
    }

    public unmount(): void {
        this.root?.remove();
        this.root = null;
    }
}
