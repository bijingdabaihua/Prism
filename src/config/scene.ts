import type { CameraPath, CameraView } from '../ir/camera';
import type { Image } from '../ir/image';
import type { Scene } from '../ir/scene';
import { Instance } from '../ir/instance';
import { MeshBuilder } from './mesh-builder';
import { placeInstances } from './placement';
import { defaultPBRMaterial } from '../ir/material';

export interface SceneOptions {
    /** 省略或空数组 → 放一个 1 m 的灰盒子当占位。 */
    instances?: Instance[];
    /** 省略 → 中灰的渐变天光。 */
    env?: Image;
    /** 省略 → 正对原点、3 m 远的默认机位。 */
    camera?: CameraView;
    /** 省略 → 不能导出运镜视频，只能导出静止画面。 */
    cameraPath?: CameraPath;
}

/** 默认机位：正对原点、3 m 远、0.7 rad 垂直视野 —— 够看清 1 m 的占位盒子。 */
const DEFAULT_CAMERA: CameraView = {
    target: { x: 0, y: 0, z: 0 },
    distance: 3,
    theta: Math.PI / 2,
    phi: Math.PI / 2,
    fovY: 0.7,
};

/**
 * 创建 Scene 的唯一入口。
 *
 * 缺省值不是「什么都不要」，而是**能直接渲染的最小场景**：一个灰盒子 + 一片
 * 灰色环境光。新场景从这个状态起步，加东西、换 HDR，每一步都能在浏览器里
 * 看到画面 —— 而不是先面对一张全黑的图去猜是没光、没几何还是管线坏了。
 */
export function createScene(options: SceneOptions = {}): Scene {
    const instances = options.instances ?? [];
    return {
        instances: instances.length > 0 ? instances : [createPlaceholderBox()],
        env: options.env ?? createGrayEnvironment(),
        camera: options.camera ?? DEFAULT_CAMERA,
        cameraPath: options.cameraPath,
    };
}

/**
 * 占位盒子：边长 1 m，法线朝外。
 *
 * 反照率压到 0.3 而不是默认的 0.85：均匀环境下漫反射表面的亮度 ≈ 反照率 ×
 * 环境亮度，背景就是环境本身，所以两者之比约等于反照率 —— 用 0.85 的灰盒子
 * 站在灰背景前几乎看不出来（差 15%），0.3 的深灰才有轮廓。
 */
function createPlaceholderBox(): Instance {
    const builder = new MeshBuilder();
    builder.addBox(1, 0);
    const material = defaultPBRMaterial();
    material.baseColor = { r: 0.3, g: 0.3, b: 0.3, a: 1 };
    const box = new Instance(builder.build([material], 'placeholder-box'));
    // 绕 Y 转 35°：正对着看只是一个方块，斜着才看得到两个面的明暗差，
    // 一眼能确认法线、明暗、透视都是对的。
    placeInstances([box], { position: { x: 0, y: 0, z: 0 }, rotationY: 0.6 });
    return box;
}

/**
 * 中灰的渐变天光 —— 没配 HDR 时的默认环境。
 *
 * 天顶亮、地面暗（0.42 → 0.06），而不是均匀灰：均匀环境光没有方向性，
 * 盒子的六个面亮度完全一样，画面上就是一个方块，看不出立体也看不出阴影。
 * 一点点梯度就够让法线、遮蔽、接触阴影都显形。
 *
 * 尺寸是窄而高的 32×256：数据只有整列相同，宽度大没有意义；高度决定渐变
 * 的平滑度（着色器按 texel 直取、不做插值，行太少会在背景上看到横向条带）。
 */
function createGrayEnvironment(sky = 0.42, ground = 0.06): Image {
    const width = 32;
    const height = 256;
    const data = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        // 图像第 0 行对应 θ = π（正下方），最后一行是 θ = 0（正上方）
        const t = (y + 0.5) / height;
        data.fill(ground + (sky - ground) * t, y * width * 3, (y + 1) * width * 3);
    }
    return { width, height, data, layout: 'equirect' };
}
