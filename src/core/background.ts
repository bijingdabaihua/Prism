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
     * `rotation` 是绕 +y 的弧度，用于对齐 HDR 里太阳的方位；省略 = 原图方向。
     */
    setImage(url: string, rotation?: number): Promise<void>;
    /**
     * 旋转当前环境图（绕 +y 的弧度）。需要先 setImage；转完纹理和 CDF 一起
     * 重建，Promise 解决时已经生效。
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
    | { type: 'background/setImage'; id: number; url: string; rotation?: number }
    | { type: 'background/setRotation'; id: number; rotation: number };

/** 环境光句柄需要的最小 RPC 面：一次带返回值的请求。 */
export interface BackgroundRpc {
    request<T>(build: (id: number) => BackgroundRequest): Promise<T>;
}

/** 环境光句柄的主线程实现。 */
class RpcBackground implements BackgroundHandle {
    constructor(private readonly rpc: BackgroundRpc) {}

    public setImage(url: string, rotation?: number): Promise<void> {
        return this.rpc.request<void>((id) => ({ type: 'background/setImage', id, url, rotation }));
    }

    public setRotation(rotation: number): Promise<void> {
        return this.rpc.request<void>((id) => ({ type: 'background/setRotation', id, rotation }));
    }
}

/** 主线程环境光句柄的工厂：实现类不导出。 */
export function createBackground(rpc: BackgroundRpc): BackgroundHandle {
    return new RpcBackground(rpc);
}
