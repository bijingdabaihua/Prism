/**
 * 主线程模型句柄：契约 + 实现。
 *
 * 场景清单、文件解码、位移、BVH 全在 Worker 里；这边只递一个 key。
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
 * 模型句柄 —— 场景几何的远程入口。
 *
 * 场景清单、文件解码、位移、BVH 全在 Worker 里；这边只递一个 key。
 */
export interface ModelHandle {
    /**
     * 装载场景几何（按 key）。
     *
     * Promise 解决时几何 / 材质已经编译完（位移烘成真几何、BVH 建好、
     * buffer 上传完）。机位和环境图不在这条消息里 —— 外部按自己的顺序
     * 调 `camera.set()` / `background.setImage()` / `background.setRotation()`。
     *
     * 一个 Prism 只装一份几何；换场景就换 Prism。
     */
    load(key: SceneKey): Promise<void>;
}

/**
 * 实现
 *
 * 以下内容不属于公开契约：消息形状、RPC 依赖和句柄实现。
 */

/** 模型相关的 Worker 消息。 */
export type ModelRequest = {
    type: 'model/load';
    id: number;
    key: SceneKey;
};

/** 模型句柄需要的最小 RPC 面：一次带返回值的请求。 */
export interface ModelRpc {
    request<T>(build: (id: number) => ModelRequest): Promise<T>;
}

/** 模型句柄的主线程实现：把 load 翻成一条带 id 的请求。 */
class RpcModel implements ModelHandle {
    constructor(private readonly rpc: ModelRpc) {}

    public load(key: SceneKey): Promise<void> {
        return this.rpc.request<void>((id) => ({ type: 'model/load', id, key }));
    }
}

/** 主线程模型句柄的工厂：实现类不导出。 */
export function createModel(rpc: ModelRpc): ModelHandle {
    return new RpcModel(rpc);
}
