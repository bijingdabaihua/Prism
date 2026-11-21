/**
 * 主线程环境光句柄：契约 + 实现。
 *
 * URL 交给 Worker 去解码、上传 —— 主线程不碰像素。
 * 创建入口是 `createBackground(rpc)`，实现类不导出。
 */

/**
 * 公开契约
 *
 * 以下类型和接口是对外 API。修改前先确认调用方影响。
 */

/**
 * 环境光句柄 —— 环境图的远程入口。
 */
export interface BackgroundHandle {
    /**
     * 设置环境图（URL）。重复调用即换背景；Promise 解决时纹理和 CDF 已经就位。
     *
     * 只换图，不动当前朝向 —— 朝向是独立状态，由 `setRotation` 负责。
     */
    setImage(url: string): Promise<void>;
    /**
     * 设置环境图朝向（绕 +y 的弧度）。
     *
     * 已经有图时立即重建纹理和 CDF；还没有图时只记住角度，等 setImage 时
     * 一次建好。两种情况 Promise 解决时角度都已经确定。
     *
     * 朝向是独立状态：之后再换图，朝向保持不变。
     */
    setRotation(rotation: number): Promise<void>;
}

/**
 * 实现
 *
 * 以下内容不属于公开契约：消息形状、RPC 依赖和句柄实现。
 */

/** 环境光相关的 Worker 消息。 */
export type BackgroundRequest =
    | { type: 'background/setImage'; id: number; url: string }
    | { type: 'background/setRotation'; id: number; rotation: number };

/** 环境光句柄需要的最小 RPC 面：一次带返回值的请求。 */
export interface BackgroundRpc {
    request<T>(build: (id: number) => BackgroundRequest): Promise<T>;
}

/** 环境光句柄的主线程实现。 */
class RpcBackground implements BackgroundHandle {
    constructor(private readonly rpc: BackgroundRpc) {}

    public setImage(url: string): Promise<void> {
        return this.rpc.request<void>((id) => ({ type: 'background/setImage', id, url }));
    }

    public setRotation(rotation: number): Promise<void> {
        return this.rpc.request<void>((id) => ({ type: 'background/setRotation', id, rotation }));
    }
}

/** 主线程环境光句柄的工厂：实现类不导出。 */
export function createBackground(rpc: BackgroundRpc): BackgroundHandle {
    return new RpcBackground(rpc);
}
