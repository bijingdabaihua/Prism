/**
 * 主线程模型句柄：契约 + 实现。
 *
 * 场景清单、文件解码、位移、BVH 全在 Worker 里；这边只递 key / 加载来源。
 * 创建入口是 `createModel(rpc)`，实现类不导出。
 */

/**
 * 公开契约
 *
 * 以下类型和接口是对外 API。修改前先确认调用方影响。
 */

/** 业务层的场景标识，来自 app/scenes/manifest.ts 的 SCENES 清单。 */
export type SceneKey = string;

/**
 * glTF 来源。
 *
 * URL 按页面地址解析，可以解析 `.gltf` 的外链 buffer / 贴图；Blob 适合
 * 自包含的 `.glb`、资源都用 data URI 内嵌的文件，或者下载来的 `.zip` ——
 * Worker 会解开 ZIP 并把里面的相对路径接上，不需要主线程先解压。
 */
export type GltfSource = string | Blob;

/** 一组实例的摆放，语义与场景构建器里的 `placeInstances` 一致。 */
export interface InstancePlacement {
    position: { x: number; y: number; z: number };
    /** 绕 X 轴，弧度。先于 rotationY 应用。 */
    rotationX?: number;
    /** 绕 Y 轴，弧度。 */
    rotationY?: number;
    scale?: number;
}

/**
 * 从 glTF 里取一个 Instance 编译。
 *
 * glTF 的一个节点展开成一个 Instance；`index` 指的是展开后的顺序。
 */
export interface InstanceSpec {
    source: GltfSource;
    /** 取第几个 Instance；省略 = 0。 */
    index?: number;
    /** 省略 = 保留 glTF 文件里的变换。 */
    placement?: InstancePlacement;
}

/**
 * 模型句柄 —— 场景几何的远程入口。
 *
 * 场景清单、文件解码、位移、BVH 全在 Worker 里；这边只递 key / 来源。
 */
export interface ModelHandle {
    /**
     * 追加场景几何（按 key）。
     *
     * Promise 解决时几何 / 材质已经编译完（位移烘成真几何、BVH 建好、
     * buffer 上传完）。机位和环境图不在这条消息里 —— 外部按自己的顺序
     * 调 `camera.set()` / `background.setImage()` / `background.setRotation()`。
     *
     * 三个加载入口都是**追加**语义：可以反复调用、一个一个把实例加进同一个
     * 场景。每次追加都会重建几何 / 材质 buffer，PathTracePass 自动发现版本
     * 变化并清零累积。
     */
    load(key: SceneKey): Promise<void>;
    /**
     * 追加一个 glTF 文件里的全部 Instance。
     *
     * `.gltf` 的外链资源需要 URL；Blob 可以是自包含 `.glb`、内嵌资源的
     * `.gltf`，也可以是带 `.bin` / 贴图的 `.zip`（在 Worker 里解包）。
     * 与 `load` 一样，结果是追加到当前场景，不是替换。
     */
    loadGltf(source: GltfSource): Promise<void>;
    /**
     * 从 glTF 里取一个 Instance，按 `placement` 摆放后追加到场景。
     *
     * 外部可以连续调用它，把同一个或不同 glTF 里的节点一个一个摆进来。
     */
    loadInstance(instance: InstanceSpec): Promise<void>;
}

/**
 * 实现
 *
 * 以下内容不属于公开契约：消息形状、RPC 依赖和句柄实现。
 */

/** 模型相关的 Worker 消息。 */
export type ModelRequest =
    | { type: 'model/load'; id: number; key: SceneKey }
    | { type: 'model/loadGltf'; id: number; source: GltfSource }
    | { type: 'model/loadInstance'; id: number; instance: InstanceSpec };

/** 模型句柄需要的最小 RPC 面：一次带返回值的请求。 */
export interface ModelRpc {
    request<T>(build: (id: number) => ModelRequest): Promise<T>;
}

/** 模型句柄的主线程实现：把三个加载入口翻成带 id 的请求。 */
class RpcModel implements ModelHandle {
    constructor(private readonly rpc: ModelRpc) {}

    public load(key: SceneKey): Promise<void> {
        return this.rpc.request<void>((id) => ({ type: 'model/load', id, key }));
    }

    public loadGltf(source: GltfSource): Promise<void> {
        return this.rpc.request<void>((id) => ({
            type: 'model/loadGltf',
            id,
            source: resolveGltfSource(source),
        }));
    }

    public loadInstance(instance: InstanceSpec): Promise<void> {
        return this.rpc.request<void>((id) => ({
            type: 'model/loadInstance',
            id,
            instance: { ...instance, source: resolveGltfSource(instance.source) },
        }));
    }
}

/** URL 按页面地址解析；Worker 里没有页面上下文，相对路径会以 Worker 脚本为基准。 */
function resolveGltfSource(source: GltfSource): GltfSource {
    return typeof source === 'string' ? new URL(source, document.baseURI).href : source;
}

/** 主线程模型句柄的工厂：实现类不导出。 */
export function createModel(rpc: ModelRpc): ModelHandle {
    return new RpcModel(rpc);
}
