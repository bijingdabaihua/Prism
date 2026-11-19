/**
 * 光追 Worker —— 一个 Prism 实例一个，独占一个 GPUDevice。
 *
 * 画布用 transferControlToOffscreen() 交进来之后，整个渲染管线（Engine /
 * Camera / Model / Frame）都跑在这个线程里：主线程从头到尾不碰 GPU，
 * 只发生指针事件和尺寸。没交画布时只有设备与资源，不出图。
 */
import { createDevice, Engine, WebGPUUnavailableError } from '../engine/engine';
import { Background } from '../engine/background';
import { Model } from '../engine/model/model';
import { loadImage } from '../config/load-image';
import { SCENES } from '../config/config';
import type { Scene } from '../ir/scene';
import type { CameraView } from '../ir/camera';
import type { CameraCommand, WorkerRequest, WorkerResponse } from './protocol';
import type { SceneStats } from './handles/model';
import type { PhotoOptions, ViewportSize } from './handles/camera';

/**
 * Worker 全局作用域的最小声明。
 *
 * tsconfig 的 lib 只有 DOM，`self` 是 Window —— 那上面的 postMessage 要求
 * 传 targetOrigin。Worker 里没有这一套，所以按实际用法声明一份。
 */
const scope = self as unknown as {
    postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
    onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

/** 这个 Worker 的设备。 */
let device: GPUDevice | null = null;
/** 主线程交进来的画布；没交时引擎不存在。 */
let surface: OffscreenCanvas | null = null;
let engine: Engine | null = null;
/** 没有引擎时的独立环境光与模型（create() 不带画布的用法）。 */
let background: Background | null = null;
let model: Model | null = null;
/** 当前场景的规模；没装过场景时为 null。 */
let stats: SceneStats | null = null;
/** 场景自带机位，`camera.reset()` 回到这里。 */
let sceneView: CameraView | null = null;
/** 最近一次视口尺寸。引擎重建后要重放，否则新上下文是 0×0。 */
let viewport: ViewportSize | null = null;

const DEFAULT_VIEW: CameraView = {
    target: { x: 0, y: 0, z: 0 },
    distance: 5,
    theta: 0,
    phi: Math.PI / 3,
    fovY: Math.PI / 3,
};

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
    const request = event.data;

    switch (request.type) {
        case 'init':
            void handleInit(request.id);
            return;
        case 'attachCanvas':
            enqueue(() => handleAttachCanvas(request.id, request.canvas));
            return;
        case 'camera':
            handleCamera(request.command);
            return;
        case 'background/setImage':
            enqueue(() => handleSetImage(request.id, request.url));
            return;
        case 'background/ready':
            reply(request.id, activeBackground()?.hasEnvironment() ?? false);
            return;
        case 'model/setScene':
            enqueue(() => handleSetScene(request.id, request.key));
            return;
        case 'model/stats':
            reply(request.id, stats);
            return;
        case 'takePhoto':
            enqueue(() => handleTakePhoto(request.id, request.options));
            return;
    }
};

async function handleInit(id: number): Promise<void> {
    if (!device) {
        try {
            device = await createDevice();
            background = new Background(device);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (err instanceof WebGPUUnavailableError) unsupported(id, message);
            else failure(id, message);
            return;
        }
    }
    reply(id, undefined);
}

/**
 * 接过画布：引擎在这一刻落地，之后 background / model 的调用都走引擎自己的
 * 那一份，不再用独立资源。
 *
 * 独立模式下已经装好的场景在这里作废（它没有渲染目标，也从来没出过图）。
 * 所以带画布的用法是 create(canvas) 之后才 setScene。
 */
async function handleAttachCanvas(id: number, canvas: OffscreenCanvas): Promise<void> {
    try {
        if (!device) throw new Error('Prism 还没初始化');
        if (engine) throw new Error('画布已经绑过了');
        background?.destroy();
        background = null;
        model?.destroy();
        model = null;
        stats = null;
        sceneView = null;
        surface = canvas;
        engine = Engine.fromDevice(device, canvas);
        applyViewport();
        reply(id, undefined);
    } catch (err) {
        failure(id, err instanceof Error ? err.message : String(err));
    }
}

/**
 * 换环境图：URL → 解码 → 上传。
 *
 * URL 相对 **Worker 脚本**解析，不是相对页面 —— 所以调用方要给根路径
 * （`/env/xxx.exr`）或绝对 URL。原图原样使用，不做 rotateEquirect：
 * 太阳方位由资产本身决定。
 *
 * 引擎已经在跑时也可以换：Background.version 变化会让 PathTracePass 在
 * 下一帧重建 bind group 并清零累积。
 */
async function handleSetImage(id: number, url: string): Promise<void> {
    try {
        const bg = activeBackground();
        if (!bg) throw new Error('Prism 还没初始化');
        bg.setImage(await loadImage(url));
        reply(id, undefined);
    } catch (err) {
        failure(id, err instanceof Error ? err.message : String(err));
    }
}

/**
 * 装场景：清单查表 → 造 Scene IR → 编译 → 换环境图 / 机位。
 *
 * 换场景 = 重建引擎：Model.compile 只能调用一次，PathTracePass 的 bind group
 * 也绑死在那一份 buffer 上。release() 只卸渲染资源，设备留给下一个引擎。
 *
 * 换场景失败时旧场景原样保留 —— 新引擎编译成功之前不动旧的。
 */
async function handleSetScene(id: number, key: string): Promise<void> {
    try {
        if (!device) throw new Error('Prism 还没初始化');
        const entry = SCENES[key];
        if (!entry) {
            throw new Error(`没有场景 "${key}"。可用：${Object.keys(SCENES).join(', ')}`);
        }

        const scene = await entry.scene.load();

        if (engine) {
            const next = Engine.fromDevice(device, surface!);
            try {
                next.setScene(scene);
            } catch (err) {
                next.release();
                throw err;
            }
            engine.release();
            engine = next;
            applyViewport();
        } else {
            const next = new Model(device);
            try {
                next.compile(scene.instances);
                background ??= new Background(device);
                background.setImage(scene.env);
            } catch (err) {
                next.destroy();
                throw err;
            }
            model?.destroy();
            model = next;
        }

        sceneView = scene.camera;
        stats = countScene(scene);
        reply(id, undefined);
    } catch (err) {
        failure(id, err instanceof Error ? err.message : String(err));
    }
}

/**
 * 按当前机位出一张图。
 *
 * 画面从 GPU 读回（Frame.readPixels：显示 pass 画进临时纹理再 copy），
 * 不依赖 canvas 的 convertToBlob —— WebGPU canvas 的读回在部分环境里会
 * 直接失败。编码在 Worker 里用 2D 画布做，主线程拿到的就是最终 Blob。
 */
async function handleTakePhoto(id: number, options?: PhotoOptions): Promise<void> {
    try {
        if (!device || !engine) throw new Error('takePhoto：还没有画面可拍');
        if (!engine.background.hasEnvironment()) throw new Error('takePhoto：场景还没装好');
        // 先等已提交的 GPU 工作落地，拍到的才是最新一帧
        await device.queue.onSubmittedWorkDone();
        const { width, height, data } = await engine.frame.readPixels();
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('takePhoto：拿不到 2D 编码上下文');
        ctx.putImageData(new ImageData(data, width, height), 0, 0);
        const blob = await canvas.convertToBlob({
            type: options?.type ?? 'image/png',
            quality: options?.quality,
        });
        reply(id, blob);
    } catch (err) {
        failure(id, err instanceof Error ? err.message : String(err));
    }
}

/**
 * 机位命令。
 *
 * 没有引擎时（create() 没带画布）命令没处落，直接忽略 —— 句柄的方法仍然
 * 是同步的、不抛，等画布到了 resize 会被重放。
 */
function handleCamera(command: CameraCommand): void {
    if (command.type === 'resize') {
        viewport = command.size;
        applyViewport();
        return;
    }
    const camera = engine?.camera;
    if (!camera) return;

    switch (command.type) {
        case 'set': {
            const { target, distance, theta, phi, fovY, apertureRadius, focusDistance } = command.spec;
            camera.setView(target, distance, theta, phi);
            camera.setFovY(fovY);
            camera.setLens(apertureRadius ?? 0, focusDistance ?? 0);
            return;
        }
        case 'reset':
            if (sceneView) camera.applyView(sceneView);
            else camera.applyView(DEFAULT_VIEW);
            return;
        case 'orbit':
            camera.orbitTheta(command.deltaTheta);
            camera.orbitPhi(command.deltaPhi);
            return;
        case 'zoom':
            camera.zoom(command.factor);
            return;
        case 'pan':
            camera.pan(command.deltaX, command.deltaY);
            return;
    }
}

/** 把最近一次尺寸给引擎 —— 新上下文默认 0×0，不重放就永远跳过渲染。 */
function applyViewport(): void {
    if (engine && viewport) engine.context.setSize(viewport.width, viewport.height);
}

/**
 * 场景规模。三角形数按实例展开 —— 位移细分的结果缓存在 mesh 上，
 * 这里读到的就是 Model.compile 实际上传的那份。
 */
function countScene(scene: Scene): SceneStats {
    let triangles = 0;
    for (const inst of scene.instances) {
        triangles += inst.evolve().mesh.triangleData.length / 4;
    }
    return { instances: scene.instances.length, triangles };
}

function activeBackground(): Background | null {
    return engine ? engine.background : background;
}

/**
 * 异步任务的串行化。
 *
 * `loadImage` / `scene.load()` 都是异步的：连着调两次，先发的那次可能后回来，
 * 把后发的那张顶掉。排队之后「最后发起的那次」一定最后落地。
 * 画布 / 场景 / 环境图 / 拍照全走这一条，顺序就是调用的顺序。
 */
let taskChain: Promise<void> = Promise.resolve();
function enqueue(task: () => Promise<void>): void {
    taskChain = taskChain.then(task);
}

function reply(id: number, value: unknown): void {
    scope.postMessage({ type: 'result', id, value });
}

function failure(id: number, message: string): void {
    scope.postMessage({ type: 'failure', id, message });
}

function unsupported(id: number, message: string): void {
    scope.postMessage({ type: 'unsupported', id, message });
}
