/**
 * 主线程环境光句柄：契约 + 实现。
 *
 * Blob 交给 Worker 去解码、上传 —— 主线程只负责提供字节。
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
     * 设置环境图（Blob）。Worker 负责格式识别、解码和上传；每次换图都从
     * 原图方向开始，需要朝向就调用 `setRotation`。Promise 解决时纹理和
     * CDF 已经就位。
     */
    setImage(blob: Blob): Promise<void>;
    /**
     * 旋转当前环境图（绕 +y 的弧度）。需要先 setImage；转完纹理和 CDF 一起
     * 重建，Promise 解决时已经生效。
     */
    setRotation(rotation: number): Promise<void>;
}

/** 主线程环境光句柄的工厂签名。具体实现放在文件末尾。 */
export type BackgroundFactory = (rpc: BackgroundRpc) => BackgroundHandle;

/**
 * 实现
 *
 * 以下内容不属于公开契约：消息形状、RPC 依赖和句柄实现。
 */

/** 环境光相关的 Worker 消息。 */
export type BackgroundRequest =
    | { type: 'background/setImage'; id: number; blob: Blob }
    | { type: 'background/setRotation'; id: number; rotation: number };

/** 环境光句柄需要的最小 RPC 面：一次带返回值的请求。 */
export interface BackgroundRpc {
    request<T>(build: (id: number) => BackgroundRequest): Promise<T>;
}

/** 环境光句柄的主线程实现。 */
class RpcBackground implements BackgroundHandle {
    constructor(private readonly rpc: BackgroundRpc) {}

    public setImage(blob: Blob): Promise<void> {
        return this.rpc.request<void>((id) => ({ type: 'background/setImage', id, blob }));
    }

    public setRotation(rotation: number): Promise<void> {
        return this.rpc.request<void>((id) => ({ type: 'background/setRotation', id, rotation }));
    }
}

/** 主线程环境光句柄的工厂：实现类不导出。 */
export const createBackground: BackgroundFactory = (rpc) => {
    return new RpcBackground(rpc);
};
