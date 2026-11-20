import type { RpcClient } from '../rpc-client';
import type { SceneKey } from '../protocol';

/**
 * 模型句柄：契约 + 主线程侧实现。
 *
 * 场景清单、文件解码、位移、BVH 全在 Worker 里；这边只递一个 key。
 */

export interface ModelHandle {
    /**
     * 装载场景几何（按 key）。
     *
     * Promise 解决时几何 / 材质已经编译完（位移烘成真几何、BVH 建好、
     * buffer 上传完）。机位和环境图不在这条消息里 —— 外部按自己的顺序
     * 调 `camera.set()` / `background.setImage()`。
     *
     * 一个 Prism 只装一份几何；换场景就换 Prism。
     */
    load(key: SceneKey): Promise<void>;
}

/** 模型句柄的主线程实现。 */
export class RpcModel implements ModelHandle {
    constructor(private readonly rpc: RpcClient) {}

    public load(key: SceneKey): Promise<void> {
        return this.rpc.request<void>((id) => ({ type: 'model/load', id, key }));
    }
}
