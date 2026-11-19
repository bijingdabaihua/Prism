/**
 * 核心包的唯一出口。
 *
 * 运行时有 Prism 和 PrismUnsupportedError 两个值（后者要 instanceof），
 * 句柄是门面的字段，类型随契约从 handles/ 导出。
 */
export { Prism } from './prism';
export { PrismUnsupportedError } from './errors';
export type { CameraSpec, CameraHandle, ViewportSize, PhotoOptions } from './handles/camera';
export type { BackgroundHandle } from './handles/background';
export type { SceneKey, ModelHandle, SceneStats } from './handles/model';
