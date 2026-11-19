/**
 * 主线程 ↔ Worker 的消息协议。
 *
 * 消息都是纯数据（结构化克隆），不带方法 —— 方法住在两端的类里。
 * 一个 Worker 只服务一个 Prism 实例，所以消息里不需要实例 id。
 *
 * 两类消息：
 *   - 写操作（机位命令）：发完不管，没有 id；
 *   - 有返回值的调用：带自增 id，Worker 用 result / failure 回执。
 *     「这台机器跑不了 WebGPU」单独一种回执，主线程据此转成 PrismUnsupportedError。
 *
 * 和门面之间的类型是纯类型依赖（`import type`），编译后擦除，没有运行时环。
 */
import type { CameraSpec, ViewportSize } from './handles/camera';
import type { SceneKey } from './handles/model';

/** 机位命令：全部是「照做」的写操作，没有返回值。 */
export type CameraCommand =
    | { type: 'set'; spec: CameraSpec }
    | { type: 'reset' }
    | { type: 'resize'; size: ViewportSize }
    | { type: 'orbit'; deltaTheta: number; deltaPhi: number }
    | { type: 'zoom'; factor: number }
    | { type: 'pan'; deltaX: number; deltaY: number };

/** 主线程 → Worker。 */
export type WorkerRequest =
    | { type: 'init'; id: number }
    | { type: 'camera'; command: CameraCommand }
    /** 开始按间隔把画面推回主线程。 */
    | { type: 'listen/start'; intervalMs: number }
    | { type: 'listen/stop' }
    | { type: 'background/setImage'; id: number; url: string }
    /** 装载场景：读清单 → 造 Scene IR → 编译几何 / 材质。 */
    | { type: 'model/setScene'; id: number; key: SceneKey }
    /** 当前场景规模；没装过时为 null。 */
    | { type: 'model/stats'; id: number };

/** Worker → 主线程。 */
export type WorkerResponse =
    /** 成功了：value 是这次调用的返回值（void 调用不带）。 */
    | { type: 'result'; id: number; value?: unknown }
    /** 这次调用失败了。 */
    | { type: 'failure'; id: number; message: string }
    /** 这台机器跑不了 WebGPU。 */
    | { type: 'unsupported'; id: number; message: string }
    /** 一帧画面（listen 的推送，没有 id）。 */
    | { type: 'frame'; bitmap: ImageBitmap };
