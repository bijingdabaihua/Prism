/**
 * 主线程 ↔ Worker 的消息协议。
 *
 * 消息都是纯数据（结构化克隆），不带方法 —— 方法住在两端的类里。
 * 一个 Worker 只服务一个 Prism 实例，所以消息里不需要实例 id。
 */

/** 主线程 → Worker。 */
export type WorkerRequest = { type: 'init' };

/** Worker → 主线程。 */
export type WorkerResponse =
    | { type: 'ready' }
    | { type: 'unsupported'; message: string }
    | { type: 'failed'; message: string };
