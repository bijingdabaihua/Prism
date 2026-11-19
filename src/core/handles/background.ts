import type { RpcClient } from '../rpc-client';

/**
 * 环境光句柄：契约 + 主线程侧实现。
 *
 * URL 交给 Worker 去解码、上传 —— 主线程不碰像素。
 */
export interface BackgroundHandle {
    /** 设置环境图（URL）。重复调用即换背景；Promise 解决时纹理和 CDF 已经就位。 */
    setImage(url: string): Promise<void>;
}

/** 环境光句柄的主线程实现。 */
export class RpcBackground implements BackgroundHandle {
    constructor(private readonly rpc: RpcClient) {}

    public setImage(url: string): Promise<void> {
        return this.rpc.request<void>((id) => ({ type: 'background/setImage', id, url }));
    }
}
