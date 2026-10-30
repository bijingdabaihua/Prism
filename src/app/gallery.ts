import { SCENES } from '../config/config';

/**
 * 画廊 —— 打开就能看到的东西。一张卡片一个场景，点进去实时渲染。
 */
export class GalleryView {
    private root: HTMLElement | null = null;

    public mount(container: HTMLElement): void {
        const root = document.createElement('div');
        root.className = 'gallery';

        const head = document.createElement('header');
        head.className = 'gallery-head';
        head.innerHTML = `
            <h1>Prism</h1>
            <p>WebGPU 路径追踪器 · 从零实现的 BVH、NEE + MIS、渐进累积</p>
        `;
        root.appendChild(head);

        // 没 WebGPU 就把话说在前面，免得点进去才发现。
        if (!navigator.gpu) {
            const notice = document.createElement('div');
            notice.className = 'gallery-notice';
            notice.textContent =
                '这个浏览器没有 WebGPU，点进去只能看到静态截图 —— 换 Chrome 113+ 或 Safari 18+ 才能实时渲染。';
            root.appendChild(notice);
        }

        const keys = Object.keys(SCENES);
        const grid = document.createElement('div');
        grid.className = 'grid';
        for (let i = 0; i < keys.length; i++) {
            grid.appendChild(this.buildCard(keys[i], i));
        }
        root.appendChild(grid);

        const foot = document.createElement('footer');
        foot.className = 'gallery-foot';
        foot.textContent = '每张图都是实时渲染：左键拖拽旋转 · 滚轮缩放 · 右键拖拽平移 · 按 S 保存截图';
        root.appendChild(foot);

        container.appendChild(root);
        this.root = root;
    }

    public unmount(): void {
        this.root?.remove();
        this.root = null;
    }

    private buildCard(key: string, index: number): HTMLElement {
        const info = SCENES[key].card;
        const card = document.createElement('a');
        card.className = 'card';
        card.href = `#/render/${key}`;
        card.style.setProperty('--tint', String(200 + index * 70));

        const cover = document.createElement('div');
        cover.className = 'card-cover';
        if (info.cover) {
            const img = document.createElement('img');
            img.src = info.cover;
            img.alt = info.title;
            img.loading = 'lazy';
            // 封面不存在时保持底纹，不要出现浏览器默认的破图图标
            img.addEventListener('error', () => img.remove());
            cover.appendChild(img);
        }
        const badge = document.createElement('span');
        badge.className = 'card-badge';
        badge.textContent = '实时渲染 →';
        cover.appendChild(badge);
        card.appendChild(cover);

        const body = document.createElement('div');
        body.className = 'card-body';

        const title = document.createElement('h3');
        title.textContent = info.title;
        body.appendChild(title);

        const subtitle = document.createElement('p');
        subtitle.textContent = info.subtitle;
        body.appendChild(subtitle);

        const tags = document.createElement('ul');
        tags.className = 'tags';
        for (const t of info.tags) {
            const li = document.createElement('li');
            li.textContent = t;
            tags.appendChild(li);
        }
        body.appendChild(tags);

        card.appendChild(body);
        return card;
    }
}
