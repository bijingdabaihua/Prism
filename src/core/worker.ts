/**
 * 光追 Worker —— 一个 Prism 实例一个，独占一个 GPUDevice。
 *
 * 整个渲染管线（Engine / Camera / Model / Frame）都跑在这个线程里，画布是
 * Worker 自己建的 OffscreenCanvas，主线程从头到尾不碰 GPU。画面通过
 * `camera.listen()` 以 ImageBitmap 推回主线程 —— 每间隔最多一帧。
 *
 * 这里也是 core 唯一 import app/ 的地方：场景清单（`app/scenes/manifest`）
 * 从这里插进渲染器，其余 core 代码不认识任何具体场景。
 */
import type { Scene } from './ir/scene';
import type { CameraView } from './ir/camera';
import type { CameraCommand, SceneStats, ViewportSize, WorkerRequest, WorkerResponse } from './protocol';
import { createDevice, WebGPUUnavailableError } from './engine/context';
import { Engine } from './engine/engine';
import { loadImage } from './loaders/image';
import { SCENES } from '../app/scenes/manifest';

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
/** 渲染目标 —— Worker 自己持有，主线程看不到。 */
let surface: OffscreenCanvas | null = null;
let engine: Engine | null = null;
/** 当前场景的规模；没装过场景时为 null。 */
let stats: SceneStats | null = null;
/** 场景自带机位，`camera.reset()` 回到这里。 */
let sceneView: CameraView | null = null;
/** 最近一次视口尺寸。引擎重建后要重放，否则新上下文是 0×0。 */
let viewport: ViewportSize | null = null;

/** 是否在往主线程推画面。换引擎后要重新挂到新相机上。 */
let listening = false;
let listenInterval = 1;
/** 当前相机 listen 的取消函数；没有引擎时是 null。 */
let detachFrames: (() => void) | null = null;

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
        case 'camera':
            handleCamera(request.command);
            return;
        case 'listen/start':
            startListening(request.intervalMs);
            return;
        case 'listen/stop':
            stopListening();
            return;
        case 'background/setImage':
            enqueue(() => handleSetImage(request.id, request.url));
            return;
        case 'background/setRotation':
            enqueue(() => handleSetRotation(request.id, request.rotation));
            return;
        case 'model/setScene':
            enqueue(() => handleSetScene(request.id, request.key));
            return;
        case 'model/stats':
            reply(request.id, stats);
            return;
    }
};

async function handleInit(id: number): Promise<void> {
    if (!device) {
        try {
            device = await createDevice();
            // 离屏画布是 Worker 的内部实现，尺寸由 resize 命令驱动
            surface = new OffscreenCanvas(1, 1);
            engine = makeEngine();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (err instanceof WebGPUUnavailableError) unsupported(id, message);
            else failure(id, message);
            return;
        }
    }
    reply(id, undefined);
}

/** 装配一个引擎；换场景 / 首次初始化都走这条。 */
function makeEngine(): Engine {
    return Engine.fromDevice(device!, surface!);
}

/**
 * 换环境图：URL → 解码 → 上传。
 *
 * URL 相对 **Worker 脚本**解析，不是相对页面 —— 所以调用方要给根路径
 * （`/env/xxx.exr`）或绝对 URL。这条路径不给旋转角度，原图原样使用；
 * 场景里的太阳对齐走 `Scene.envRotation`。
 *
 * 引擎已经在跑时也可以换：Background.version() 变化会让 PathTracePass 在
 * 下一帧重建 bind group 并清零累积。
 */
async function handleSetImage(id: number, url: string): Promise<void> {
    try {
        if (!engine) throw new Error('Prism 还没初始化');
        engine.background.setImage(await loadImage(url));
        reply(id, undefined);
    } catch (err) {
        failure(id, err instanceof Error ? err.message : String(err));
    }
}

/**
 * 转环境图：不重新解码，拿 Background 留着的原图按新角度重建纹理和 CDF。
 *
 * 和 setImage 同一套角度定义（绕 +y 的弧度）。累积会自动清零 ——
 * Background.version() 变了，下一帧重建 bind group。
 */
async function handleSetRotation(id: number, rotation: number): Promise<void> {
    try {
        if (!engine) throw new Error('Prism 还没初始化');
        engine.background.setRotation(rotation);
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
        if (!device || !engine) throw new Error('Prism 还没初始化');
        const load = SCENES[key];
        if (!load) {
            throw new Error(`没有场景 "${key}"。可用：${Object.keys(SCENES).join(', ')}`);
        }

        const scene = await load();
        const next = makeEngine();
        try {
            next.setScene(scene);
        } catch (err) {
            next.release();
            throw err;
        }
        engine.release();
        engine = next;
        applyViewport();

        sceneView = scene.camera;
        stats = countScene(scene);
        // 旧引擎的推送随 release() 停了，新相机要重新挂上
        if (listening) attachFrames();
        reply(id, undefined);
    } catch (err) {
        failure(id, err instanceof Error ? err.message : String(err));
    }
}

/**
 * 机位命令。
 *
 * 没有引擎时（还没 init 完）命令没处落，直接忽略 —— 句柄的方法仍然是
 * 同步的、不抛，等引擎到了 resize 会被重放。
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

/**
 * 画面推送。
 *
 * 画面是相机的输出：Worker 这边不自己管定时器和「有没有新帧」，只把
 * 主线程的 listen 原样转给引擎里的相机 —— 内外同一套语义。
 */
function startListening(intervalMs: number): void {
    listening = true;
    listenInterval = Math.max(1, intervalMs);
    attachFrames();
}

function attachFrames(): void {
    detachFrames?.();
    detachFrames =
        engine?.camera.listen(listenInterval, (bitmap) => {
            scope.postMessage({ type: 'frame', bitmap }, [bitmap]);
        }) ?? null;
}

function stopListening(): void {
    listening = false;
    detachFrames?.();
    detachFrames = null;
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

/**
 * 异步任务的串行化。
 *
 * `loadImage` / `scene.load()` 都是异步的：连着调两次，先发的那次可能后回来，
 * 把后发的那张顶掉。排队之后「最后发起的那次」一定最后落地。
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
