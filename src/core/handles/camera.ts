import type { RpcClient } from '../rpc-client';
import type { CameraSpec, ViewportSize } from '../protocol';

/**
 * 相机句柄：契约 + 主线程侧实现。
 *
 * Worker 里的 `Camera` 才是真的机位；这边只把方法翻成消息。命令全部是
 * 同步的「发完不管」；只有 `listen` 有心跳 —— 帧是 Worker 主动推回来的。
 */

/**
 * 相机句柄 —— 所有方法都是同步的，调用即返回，不等帧。
 *
 * 宽高比是投影的一部分，所以尺寸挂在相机上（`resize`），而不是画布上：
 * 相机不知道自己画到哪块画布，只知道画面有多宽。
 *
 * 角度单位一律是弧度，位移单位一律是屏幕像素 —— 前者是相机语义，后者
 * 直接接指针事件，中间的手感系数（比如每像素转多少弧度）留在业务层。
 */
export interface CameraHandle {
    /**
     * 直接指定机位（完整一格，不是增量）。
     *
     * 外部装场景的顺序通常是 `set` → `background.setImage` → `model.load`；
     * 装载几何不会改机位。
     */
    set(spec: CameraSpec): void;
    /**
     * 回到场景自带的机位；还没装场景时回到内置的默认机位
     * （原点、5 m 远、水平视线、垂直视野 60°）。
     */
    reset(): void;
    /** 视口尺寸（物理像素）。宽高比跟着它走。 */
    resize(size: ViewportSize): void;
    /** 绕 target 旋转，单位弧度。phi 夹在 (0, π) 之间，翻不过头顶。 */
    orbit(deltaTheta: number, deltaPhi: number): void;
    /** 推拉：>1 拉远，<1 推近。乘性，拖多远都是等比例。 */
    zoom(factor: number): void;
    /** 平移 target，单位是屏幕像素 —— 直接接指针的位移。 */
    pan(deltaX: number, deltaY: number): void;
    /**
     * 按间隔把当前画面推回来 —— 画面是相机的输出，所以挂在相机上。
     *
     * 每 `intervalMs` 毫秒最多推一帧；渲染比它慢就等下一帧，不重复推同一张。
     * 推回来的是 `ImageBitmap`：主线程用 bitmaprenderer 的
     * `transferFromImageBitmap()` 直接贴上去，不经过读回和编码。
     *
     * 返回取消函数。同一时刻只允许一个监听者。
     */
    listen(intervalMs: number, onFrame: (frame: ImageBitmap) => void): () => void;
}

/** 相机句柄的主线程实现：每条命令原样转给 Worker，不等回执。 */
export class RpcCamera implements CameraHandle {
    private listener: ((frame: ImageBitmap) => void) | null = null;

    constructor(private readonly rpc: RpcClient) {}

    public set(spec: CameraSpec): void {
        this.rpc.send({ type: 'camera', command: { type: 'set', spec } });
    }

    public reset(): void {
        this.rpc.send({ type: 'camera', command: { type: 'reset' } });
    }

    public resize(size: ViewportSize): void {
        this.rpc.send({ type: 'camera', command: { type: 'resize', size } });
    }

    public orbit(deltaTheta: number, deltaPhi: number): void {
        this.rpc.send({ type: 'camera', command: { type: 'orbit', deltaTheta, deltaPhi } });
    }

    public zoom(factor: number): void {
        this.rpc.send({ type: 'camera', command: { type: 'zoom', factor } });
    }

    public pan(deltaX: number, deltaY: number): void {
        this.rpc.send({ type: 'camera', command: { type: 'pan', deltaX, deltaY } });
    }

    public listen(intervalMs: number, onFrame: (frame: ImageBitmap) => void): () => void {
        if (this.listener) throw new Error('camera.listen：已经有一个监听者');
        this.listener = onFrame;
        this.rpc.setFrameHandler(onFrame);
        this.rpc.send({ type: 'listen/start', intervalMs });
        return () => {
            if (this.listener !== onFrame) return;
            this.listener = null;
            this.rpc.setFrameHandler(null);
            try {
                this.rpc.send({ type: 'listen/stop' });
            } catch {
                // 已经 dispose：Worker 都没了，不用停
            }
        };
    }
}
