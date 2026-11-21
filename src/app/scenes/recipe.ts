import type { InstancePlacement } from '../../core/prism';
import { Instance, placeInstances } from '../../core/ir/instance';
import { buildTiledGround, loadGroundMaterial } from './ground';

/**
 * 场景配方 —— 场景几何的数据格式 + 解释器。
 *
 * 主线程把配方以 JSON Blob 交给 Prism；Worker 在这里把它变成 Instance[]。
 * core 不认识这些字段：资产路径、摆放和程序化几何都留在业务层。
 */

/** 一个 glTF 资产包。多个节点按文件里的变换一起进来；给 `index` 时只取一个。 */
export interface GltfObject {
    type: 'gltf';
    /** `.gltf` / `.glb` 的 URL。 */
    url: string;
    /** 取展开后的第几个 Instance；省略 = 全部。 */
    index?: number;
    /** 省略 = 保留文件里的变换。 */
    placement?: InstancePlacement;
}

/** 一片程序化地面：一块带位移材质的四边形按 `tile` 铺成网格。 */
export interface TiledGroundObject {
    type: 'tiled-ground';
    /** `.blend` 材质 URL。 */
    material: string;
    /** 一格贴图覆盖的真实尺寸（米），也是砖边长。 */
    tile: number;
    /** 砖心范围（米）。 */
    x0: number;
    x1: number;
    z0: number;
    z1: number;
}

export type SceneObject = GltfObject | TiledGroundObject;

/** 一份场景几何配方。 */
export interface SceneRecipe {
    objects: SceneObject[];
}

/**
 * 配方 → Instance[]。
 *
 * 配方来自 Blob，先按结构收窄；单个对象的字段由各分支自己检查。
 */
export async function buildScene(recipe: unknown): Promise<Instance[]> {
    if (!isRecipe(recipe)) {
        throw new Error('场景配方格式不对：需要 { objects: [...] }');
    }

    const instances: Instance[] = [];
    for (const object of recipe.objects) {
        if (!object || typeof object !== 'object') {
            throw new Error('场景配方里有非对象条目');
        }
        if (object.type === 'gltf') {
            instances.push(...(await buildGltf(object)));
        } else if (object.type === 'tiled-ground') {
            instances.push(...(await buildGround(object)));
        } else {
            const type = (object as { type?: unknown }).type;
            throw new Error(`未知的场景对象类型: ${String(type)}`);
        }
    }
    return instances;
}

async function buildGltf(object: GltfObject): Promise<Instance[]> {
    const all = await Instance.buildByGltf(object.url);
    const selected = object.index === undefined ? all : [all[object.index]];
    if (!selected[0]) {
        throw new Error(`glTF 里没有第 ${object.index} 个 Instance（共 ${all.length} 个）`);
    }
    if (object.placement) placeInstances(selected, object.placement);
    return selected;
}

async function buildGround(object: TiledGroundObject): Promise<Instance[]> {
    const material = await loadGroundMaterial(object.material, object.tile);
    return buildTiledGround(
        material,
        object.tile,
        object.x0,
        object.x1,
        object.z0,
        object.z1,
    );
}

function isRecipe(value: unknown): value is SceneRecipe {
    if (!value || typeof value !== 'object') {
        return false;
    }
    return Array.isArray((value as { objects?: unknown }).objects);
}
