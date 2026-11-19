/**
 * 核心包的唯一出口。
 *
 * 运行时有 Prism 和 PrismUnsupportedError 两个值（后者要 instanceof），
 * 其余全是类型 —— 类型在编译后擦除，不产生 JS，但使用者需要它们来标注变量。
 */
export { Prism, PrismUnsupportedError } from './prism';
export type {
    SceneKey,
    CameraSpec,
    CameraHandle,
    PhotoOptions,
    BackgroundHandle,
    ModelHandle,
} from './prism';
