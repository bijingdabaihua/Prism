import type { Vec3 } from '../../math/types';
import type { CameraView } from '../ir/camera';
import type { RenderContext } from './context';
import type { Model } from './model/model';
import type { Background } from './background';
import { Frame } from './frame/frame';
import { vec3, normalize, cross, sub, add, scale } from '../../math/vec3';
import { Mat4 } from '../../math/mat4';

/**
 * 轨道相机：观察状态 + 它的 uniform buffer（112 B，布局见 structs.wgsl）+ 出图。
 *
 * 内外一致：外面（CameraHandle）只有 `camera.listen` 能拿到画面，里面也把
 * 渲染藏在这一层 —— `Frame` 是相机的私有实现，外部只调 `startListening` /
 * `renderFrame`。
 *
 * 和 Background 一样是「一份状态 + 它的 GPU 镜像」：相机自己知道参数变化了
 * 没有，脏了就写 buffer，调用方只看返回值决定要不要重置累积。
 *
 * 初始值只是占位：外部装场景时会用 `camera.set` 覆盖掉。
 * 分辨率是渲染目标的事，但相机跟着它变，所以这里订阅 canvas 尺寸变化。
 */
export class Camera {
    public readonly buffer: GPUBuffer;
    /** 正在往哪里推画面；null = 没人监听。 */
    private listener: Listener | null = null;
    private listenTimer: ReturnType<typeof setTimeout> | null = null;
    private dirty = true;
    private target: Vec3 = { x: 0, y: 0, z: 0 };
    private orbitDist = 5;
    private theta = 0;
    private phi = Math.PI / 3;
    private fovYRads = (60 * Math.PI) / 180;
    /** 入射光瞳半径（米）。0 = 针孔。 */
    private apertureRadius = 0;
    /** 对焦距离（米）。0 = 无穷远。 */
    private focusDistance = 0;
    /** 最近一次整套装进来的机位；reset() 回到这里。 */
    private sceneView: CameraView | null = null;
    private aspect = 16 / 9;
    private near = 0.01;
    private far = 100;
    private renderWidth = 800;
    private renderHeight = 600;
    private readonly device: GPUDevice;
    /** 相机的渲染器；画面只从这里出。 */
    private readonly frame: Frame;

    constructor(context: RenderContext, model: Model, background: Background) {
        this.device = context.device;
        this.buffer = this.device.createBuffer({
            size: 112,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: 'camera-uniform',
        });
        this.frame = new Frame(context, model, this, background);
        context.onResize((w, h) => this.setResolution(w, h));
    }

    /** 参数变化（脏）时写入 uniform buffer；返回是否有变化。 */
    public upload(): boolean {
        if (!this.dirty) return false;
        this.dirty = false;

        const buf = new ArrayBuffer(112);
        const f32 = new Float32Array(buf);

        f32.set(this.invViewProj().raw(), 0);

        const eye = this.computeEye();
        f32[16] = eye.x;
        f32[17] = eye.y;
        f32[18] = eye.z;
        f32[19] = 1.0;

        // vec4 resolution：只用得到 x、y，zw 留空
        f32[20] = this.renderWidth;
        f32[21] = this.renderHeight;

        f32[24] = this.fovYRads;
        f32[25] = this.apertureRadius;
        f32[26] = this.focusDistance;

        this.device.queue.writeBuffer(this.buffer, 0, buf);
        return true;
    }

    /**
     * 按间隔把当前画面推出去 —— 画面是相机的输出，所以推送也挂在相机上。
     *
     * 和主线程的 `CameraHandle.listen` 同一个语义：渲染比间隔慢时不重复推
     * 同一帧。同一时刻只保留一个监听者，重复调用会替换旧的。
     */
    public startListening(intervalMs: number, onFrame: (frame: ImageBitmap) => void): void {
        this.stopListening();
        const listener: Listener = { intervalMs: Math.max(1, intervalMs), onFrame, lastSent: -1 };
        this.listener = listener;
        this.deliver(listener);
    }

    public stopListening(): void {
        this.listener = null;
        if (this.listenTimer !== null) {
            clearTimeout(this.listenTimer);
            this.listenTimer = null;
        }
    }

    /** 提交一帧（渲染循环驱动）。 */
    public renderFrame(): boolean {
        return this.frame.renderFrame();
    }

    /** 这一帧还能不能提交 —— 渲染循环的节流判断。 */
    public readyForNextFrame(): boolean {
        return this.frame.readyForNextFrame();
    }

    /** 上一帧是否重开了累积 —— 渲染循环据此切换采样预算档位。 */
    public restarted(): boolean {
        return this.frame.restarted();
    }

    /** 每帧 GPU 预算（毫秒）。 */
    public setTargetFrameMs(ms: number): void {
        this.frame.setTargetFrameMs(ms);
    }

    public eye(): Vec3 {
        return this.computeEye();
    }

    public vpMatrix(): Mat4 {
        const view = Mat4.lookAt(this.computeEye(), this.target, { x: 0, y: 1, z: 0 });
        return Mat4.perspective(this.fovYRads, this.aspect, this.near, this.far).multiply(view);
    }

    public invViewProj(): Mat4 {
        return this.vpMatrix().invert();
    }

    /**
     * 装载场景机位。近远平面跟着距离走，外部只报距离。
     *
     * 没有「按包围盒自动取景」这条退路：自动取景在画廊里永远是错的构图 ——
     * 相机会退到刚好看全整个场景的地方，而画廊要的是场景作者选的那一格。
     */
    public setView(target: Vec3, distance: number, theta: number, phi: number): void {
        this.target = target;
        this.orbitDist = Math.max(distance, 0.01);
        this.theta = theta;
        this.phi = Math.max(0.01, Math.min(Math.PI - 0.01, phi));
        this.near = this.orbitDist * 0.01;
        this.far = Math.max(this.orbitDist * 10, 100);
        this.dirty = true;
    }

    /** 整套机位一次装进来：场景机位、运镜关键帧都走这一条。 */
    public applyView(view: CameraView): void {
        this.sceneView = view;
        this.setFovY(view.fovY);
        this.setView(view.target, view.distance, view.theta, view.phi);
        this.setLens(view.apertureRadius ?? 0, view.focusDistance ?? 0);
    }

    /** 回到最近一次整套装进来的机位 —— 观察者运镜之后的复位。 */
    public reset(): void {
        this.applyView(this.sceneView ?? DEFAULT_VIEW);
    }

    public setFovY(radians: number): void {
        this.fovYRads = radians;
        this.dirty = true;
    }

    /**
     * 镜头：光圈半径 + 对焦距离，两个都是米。任一个为 0 就退回针孔。
     *
     * 单位是米而不是 f 值，因为引擎不知道传感器多大 —— 焦距只活在 fovY 里。
     * 场景作者要把「50 mm 开 f/2.8」换成年半径，那是取景的问题，不是渲染的问题。
     */
    public setLens(apertureRadius: number, focusDistance: number): void {
        this.apertureRadius = Math.max(0, apertureRadius);
        this.focusDistance = Math.max(0, focusDistance);
        this.dirty = true;
    }

    public setResolution(w: number, h: number): void {
        this.renderWidth = w;
        this.renderHeight = h;
        this.aspect = w / h;
        this.dirty = true;
    }

    public orbitTheta(delta: number): void {
        this.theta += delta;
        this.dirty = true;
    }
    public orbitPhi(delta: number): void {
        this.phi = Math.max(0.01, Math.min(Math.PI - 0.01, this.phi + delta));
        this.dirty = true;
    }
    public zoom(factor: number): void {
        this.orbitDist = Math.max(0.1, this.orbitDist * factor);
        this.dirty = true;
    }

    public pan(deltaX: number, deltaY: number): void {
        const eye = this.computeEye();
        const viewDir = normalize(sub(this.target, eye));
        const right = normalize(cross(viewDir, { x: 0, y: 1, z: 0 }));
        const up = cross(right, viewDir);
        const speed = this.orbitDist * 0.008;
        this.target = add(this.target, add(scale(right, -deltaX * speed), scale(up, deltaY * speed)));
        this.dirty = true;
    }

    public destroy(): void {
        this.stopListening();
        this.frame.destroy();
        this.buffer?.destroy();
    }

    private deliver(listener: Listener): void {
        if (this.listener !== listener) return;
        try {
            const count = this.frame.frameCount();
            if (count !== listener.lastSent) {
                const bitmap = this.frame.capture();
                if (bitmap) {
                    listener.lastSent = count;
                    listener.onFrame(bitmap);
                }
            }
        } finally {
            // 回调里可能已经取消了监听：只有还挂着才排下一次
            if (this.listener === listener) {
                this.listenTimer = setTimeout(() => this.deliver(listener), listener.intervalMs);
            }
        }
    }

    private computeEye(): Vec3 {
        const ct = Math.cos(this.theta),
            st = Math.sin(this.theta);
        const cp = Math.cos(this.phi),
            sp = Math.sin(this.phi);
        return vec3(
            this.target.x + this.orbitDist * sp * ct,
            this.target.y + this.orbitDist * cp,
            this.target.z + this.orbitDist * sp * st,
        );
    }
}

/** 还没装过场景时的占位机位 —— 和类里的初始值保持一致。 */
const DEFAULT_VIEW: CameraView = {
    target: { x: 0, y: 0, z: 0 },
    distance: 5,
    theta: 0,
    phi: Math.PI / 3,
    fovY: Math.PI / 3,
};

interface Listener {
    readonly intervalMs: number;
    readonly onFrame: (frame: ImageBitmap) => void;
    /** 上一次推出去的是第几帧。 */
    lastSent: number;
}
