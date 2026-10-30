import { SCENES } from '../config/config';
import { GalleryView } from './gallery';
import { RenderView } from './render-view';
import { UnsupportedView } from './unsupported';

/**
 * 路由：`#/` 是画廊，`#/render/<key>` 是渲染页。
 *
 * 只用 hash —— 静态托管不需要任何服务端重写规则。
 */

interface View {
    mount(container: HTMLElement): void | Promise<void>;
    unmount(): void;
}

interface Route {
    name: 'gallery' | 'render';
    key: string;
}

const root = document.getElementById('app')!;

let current: View | null = null;
let currentId = '';

function parseRoute(hash: string): Route {
    const raw = hash.replace(/^#\/?/, '');
    if (!raw) {
        return { name: 'gallery', key: '' };
    }
    const match = raw.match(/^render\/(.+)$/);
    const key = match ? match[1] : raw;
    if (key in SCENES) {
        return { name: 'render', key };
    }
    return { name: 'gallery', key: '' };
}

function routeId(route: Route): string {
    return route.name === 'gallery' ? 'gallery' : `render:${route.key}`;
}

function show(hash: string): void {
    const route = parseRoute(hash);
    const id = routeId(route);
    if (id === currentId) return;

    current?.unmount();
    currentId = id;

    if (route.name === 'render') {
        // 画廊本身就是静态图，没有 WebGPU 也能看；只有渲染页必须降级。
        const config = SCENES[route.key];
        const view = navigator.gpu ? new RenderView(config) : new UnsupportedView(config);
        current = view;
        void view.mount(root);
    } else {
        const view = new GalleryView();
        current = view;
        view.mount(root);
    }
}

show(location.hash);
window.addEventListener('hashchange', () => show(location.hash));
