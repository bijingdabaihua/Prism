/**
 * 光追 Worker —— 一个 Prism 实例一个，独占一个 GPUDevice。
 *
 * 现在只做一件事：把设备建出来并回报就绪。画布、场景、取景都会在这个
 * Worker 里落地 —— 主线程从头到尾不碰 GPU。
 */
import { createDevice, WebGPUUnavailableError } from '../engine/engine';
import type { WorkerRequest, WorkerResponse } from './protocol';

/**
 * Worker 全局作用域的最小声明。
 *
 * tsconfig 的 lib 只有 DOM，`self` 是 Window —— 那上面的 postMessage 要求
 * 传 targetOrigin。Worker 里没有这一套，所以按实际用法声明一份。
 */
const scope = self as unknown as {
    postMessage(message: WorkerResponse): void;
    onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

/** 这个 Worker 的设备。画布接进来之后，引擎也建在它上面。 */
let device: GPUDevice | null = null;

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
    const request = event.data;
    if (request.type !== 'init') return;

    try {
        device = await createDevice();
        scope.postMessage({ type: 'ready' });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof WebGPUUnavailableError) {
            scope.postMessage({ type: 'unsupported', message });
        } else {
            scope.postMessage({ type: 'failed', message });
        }
    }
};
