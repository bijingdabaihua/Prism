/**
 * 门面对外抛出的错误类型。
 *
 * 单独一个文件是为了打断 import 环：RpcClient 要把 Worker 的 `unsupported`
 * 回执转成这个错误，门面和句柄又要 import RpcClient —— 错误类放这里，
 * 谁都可以引，没有环。
 */

/** 这台机器跑不了 WebGPU —— 调用方据此走降级页，而不是错误态。 */
export class PrismUnsupportedError extends Error {
    constructor(message = 'WebGPU is not available in this browser') {
        super(message);
        this.name = 'PrismUnsupportedError';
    }
}
