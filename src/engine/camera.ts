import type { Vec3 } from '../math/types';
import type { CameraView } from '../ir/camera';
import type { RenderContext } from './context';
import { vec3, normalize, cross, sub, add, scale } from '../math/vec3';
import { Mat4 } from '../math/mat4';

/**
 * 轨道相机：观察状态 + 它的 uniform buffer（112 B，布局见 structs.wgsl）。
 *
 * 和 Background 一样是「一份状态 + 它的 GPU 镜像」：相机自己知道参数变化了
 * 没有，脏了就写 buffer，调用方只看返回值决定要不要重置累积。
 *
 * 初始值只是占位：一进渲染页 `setScene` 就用 `Scene.camera` 覆盖掉。
 * 分辨率是渲染目标的事，但相机跟着它变，所以这里订阅 canvas 尺寸变化。
 */
export class Camera {
    public readonly buffer: GPUBuffer;
    private readonly device: GPUDevice;
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
    private aspect = 16 / 9;
    private near = 0.01;
    private far = 100;
    private renderWidth = 800;
    private renderHeight = 600;

    constructor(context: RenderContext) {
        this.device = context.device;
        this.buffer = this.device.createBuffer({
            size: 112,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: 'camera-uniform',
        });
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
     * 装载场景机位（`Scene.camera`）。近远平面跟着距离走，场景只报距离。
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
        this.setFovY(view.fovY);
        this.setView(view.target, view.distance, view.theta, view.phi);
        this.setLens(view.apertureRadius ?? 0, view.focusDistance ?? 0);
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
        this.buffer?.destroy();
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
