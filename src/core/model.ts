/**
 * 主线程模型句柄：契约 + 实现。
 *
 * 文件解码、位移、BVH 全在 Worker 里；这边只递资产字节。创建入口是
 * `createModel(rpc)`，实现类不导出。
 */

/**
 * 公开契约
 *
 * 以下类型和接口是对外 API。修改前先确认调用方影响。
 */

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
    /**
     * 一个 glTF 资产包的字节：自包含 `.glb`、资源内嵌的 `.gltf`，或带
     * `.bin` / 贴图的 `.zip`。ZIP 在 Worker 里解包，主线程只负责取字节。
     */
    source: Blob;
    /** 取第几个 Instance；省略 = 0。 */
    index?: number;
    /** 省略 = 保留 glTF 文件里的变换。 */
    placement?: InstancePlacement;
}

/**
 * 模型句柄 —— 场景几何的远程入口。
 *
 * 文件解码、位移、BVH 全在 Worker 里；这边只递资产字节。
 */
export interface ModelHandle {
    /**
     * 追加一个 glTF 资产包里的全部 Instance。
     *
     * `source` 是资产包字节：自包含 `.glb`、内嵌资源的 `.gltf`，或带
     * `.bin` / 贴图的 `.zip`。URL 也由调用方自己 fetch 成 Blob 再传进来 ——
     * 主线程只递字节，解析和解包都在 Worker。
     * 结果是追加到当前场景，不是替换。
     */
    loadGltf(source: Blob): Promise<void>;
    /**
     * 从 glTF 资产包里取一个 Instance，按 `placement` 摆放后追加到场景。
     *
     * 外部可以连续调用它，把同一个或不同资产包里的节点一个一个摆进来。
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
    | { type: 'model/loadGltf'; id: number; source: Blob }
    | { type: 'model/loadInstance'; id: number; instance: InstanceSpec };

/** 模型句柄需要的最小 RPC 面：一次带返回值的请求。 */
export interface ModelRpc {
    request<T>(build: (id: number) => ModelRequest): Promise<T>;
}

/** 模型句柄的主线程实现：把两个加载入口翻成带 id 的请求。 */
class RpcModel implements ModelHandle {
    constructor(private readonly rpc: ModelRpc) {}

    public loadGltf(source: Blob): Promise<void> {
        return this.rpc.request<void>((id) => ({ type: 'model/loadGltf', id, source }));
    }

    public loadInstance(instance: InstanceSpec): Promise<void> {
        return this.rpc.request<void>((id) => ({ type: 'model/loadInstance', id, instance }));
    }
}

/** 主线程模型句柄的工厂：实现类不导出。 */
export function createModel(rpc: ModelRpc): ModelHandle {
    return new RpcModel(rpc);
}
