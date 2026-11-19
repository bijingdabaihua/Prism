/**
 * 核心包的唯一出口。
 *
 * 运行时只有一个值：Prism。其余全是类型 —— 类型在编译后擦除，不产生 JS，
 * 但使用者需要它们来标注变量。
 */
export { Prism } from './prism';
export type {
    SceneKey,
    CameraSpec,
    CameraHandle,
    BackgroundHandle,
    ModelHandle,
} from './prism';
