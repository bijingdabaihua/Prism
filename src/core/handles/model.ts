import type { RpcClient } from '../rpc-client';

/**
 * 模型句柄：契约 + 主线程侧实现。
 *
 * 场景清单、文件解码、位移、BVH 全在 Worker 里；这边只递一个 key。
 */

/** 业务层的场景标识，来自 config 里的 SCENES 清单。 */
export type SceneKey = string;

export interface ModelHandle {
    /**
     * 装载场景（按 key）。重复调用即换场景。
     *
     * Promise 解决时几何 / 材质已经编译完（位移烘成真几何、BVH 建好、
     * buffer 上传完），环境光也换成了场景自带的那张 —— 这就是「场景就绪」。
     *
     * 场景自带机位：`camera` 会跟着换成场景的构图，之后再用
     * `camera.set()` 覆盖。
     */
    setScene(key: SceneKey): Promise<void>;
    /** 当前场景的规模；还没装过场景时为 null。 */
    stats(): Promise<SceneStats | null>;
}

export interface SceneStats {
    /** 实例数（同一 mesh 摆多次算多个）。 */
    instances: number;
    /** 三角形总数 —— 按实例展开，位移细分之后的数字。 */
    triangles: number;
}

/** 模型句柄的主线程实现。 */
export class RpcModel implements ModelHandle {
    constructor(private readonly rpc: RpcClient) {}

    public setScene(key: SceneKey): Promise<void> {
        return this.rpc.request<void>((id) => ({ type: 'model/setScene', id, key }));
    }

    public stats(): Promise<SceneStats | null> {
        return this.rpc.request<SceneStats | null>((id) => ({ type: 'model/stats', id }));
    }
}
