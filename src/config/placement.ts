import type { Vec3 } from '../math/types';
import type { Instance } from '../ir/instance';
import { Mat4 } from '../math/mat4';

export interface Placement {
    position: Vec3;
    /**
     * 绕 X 轴，弧度。先于 `rotationY` 应用。
     *
     * glTF 里站着的模型要躺下，只能绕水平轴放倒 —— 只绕 Y 转永远躺不平。
     * 先绕 X 放倒、再绕 Y 摆方向，和手里拿个东西摆位置时的手感一致。
     */
    rotationX?: number;
    /** 绕 Y 轴，弧度。0 表示模型朝向不变。 */
    rotationY?: number;
    scale?: number;
}

/**
 * 按作者指定的位置/朝向/缩放摆放一组实例，组内相对关系保持不变。
 *
 * 贴图和模型都按米导出，所以 scale 一般给 1 —— 只有在模型尺寸明显不对时
 * 才调它，而不是拿它凑构图。
 */
export function placeInstances(instances: readonly Instance[], p: Placement): void {
    const s = p.scale ?? 1;
    const cy = Math.cos(p.rotationY ?? 0);
    const sy = Math.sin(p.rotationY ?? 0);
    const cx = Math.cos(p.rotationX ?? 0);
    const sx = Math.sin(p.rotationX ?? 0);
    // Ry · Rx，列主序
    const m = Mat4.from(
        new Float32Array([
            cy * s, 0, -sy * s, 0,
            sy * sx * s, cx * s, cy * sx * s, 0,
            sy * cx * s, -sx * s, cy * cx * s, 0,
            p.position.x, p.position.y, p.position.z, 1,
        ]),
    );
    for (const inst of instances) {
        inst.transform = m.multiply(Mat4.from(inst.transform)).raw();
    }
}
