/**
 * 主线程场景句柄：契约 + 实现。
 *
 * core 不认识场景格式：句柄只把场景配方的字节交给 Worker，配方由
 * `app/scenes/recipe.ts` 解释成 Instance[]。创建入口是 `createScene(rpc)`，
 * 实现类不导出。
 */

/**
 * 公开契约
 *
 * 以下类型和接口是对外 API。修改前先确认调用方影响。
 */

/**
 * 场景句柄 —— 场景配方的远程入口。
 *
 * 与模型句柄分开：模型句柄只收 glTF 资产；场景配方可以引用多个资产和
 * 程序化几何。core 只负责传输，配方格式属于业务层。
 */
export interface SceneHandle {
    /**
     * 追加一个场景配方。
     *
     * `source` 是配方 JSON 的字节。Worker 里的 `app/scenes/recipe.ts` 把它
     * 解释成 Instance[] 后追加到当前场景。与模型加载入口一样是追加语义：
     * 可以反复调用，每次追加都会重建几何 / 材质 buffer 并清零累积。
     */
    load(source: Blob): Promise<void>;
}

/**
 * 实现
 *
 * 以下内容不属于公开契约：消息形状、RPC 依赖和句柄实现。
 */

/** 场景相关的 Worker 消息。 */
export type SceneRequest = { type: 'scene/load'; id: number; source: Blob };

/** 场景句柄需要的最小 RPC 面：一次带返回值的请求。 */
export interface SceneRpc {
    request<T>(build: (id: number) => SceneRequest): Promise<T>;
}

/** 场景句柄的主线程实现：把配方字节翻成带 id 的请求。 */
class RpcScene implements SceneHandle {
    constructor(private readonly rpc: SceneRpc) {}

    public load(source: Blob): Promise<void> {
        return this.rpc.request<void>((id) => ({ type: 'scene/load', id, source }));
    }
}

/** 主线程场景句柄的工厂：实现类不导出。 */
export function createScene(rpc: SceneRpc): SceneHandle {
    return new RpcScene(rpc);
}
