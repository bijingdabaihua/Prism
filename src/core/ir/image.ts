/**
 * 场景 IR 里的图像：与来源格式无关的、解码后的线性浮点数据。
 *
 * 所有导入器（.hdr / .exr / .png / .jpg …）的唯一出口都是它，
 * 渲染侧只认这个类型，所以看不出源文件是什么格式。
 *
 * 约定：
 * - 数据是**线性**光值，不是 sRGB 编码值。显示编码在 GPU 编译层再做。
 * - 数值未归一化，可以大于 1（HDR 环境图的辐照度本来就 > 1）。
 * - layout 区分两种用途：equirect 是等距柱状环境图（宽高比 2:1），
 *   texture 是可以平铺的 2D 贴图。将来要支持 cubemap，就在这里加变体，
 *   而不是改渲染层。
 */
export interface Image {
    readonly width: number;
    readonly height: number;
    /** 3 通道 RGB，row-major，长度 = width * height * 3 */
    readonly data: Float32Array;
    readonly layout: 'equirect' | 'texture';
    /**
     * 一格贴图覆盖的真实尺寸（米）。没有就是 1 m 一格。
     *
     * 图像空间到物理空间的唯一换算依据，只能由资产来源提供 —— 贴图文件里
     * 没有这个信息（Poly Haven 的 `dimensions` 字段给的是毫米）。
     * 着色时把它折成 texel 覆盖（每米重复 1/meters 次），位移时把米制 UV
     * 折成图上的重复，两边读的是同一个数。
     */
    readonly meters?: number;
}
