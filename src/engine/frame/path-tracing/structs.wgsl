// Shared structs and bindings for path tracing

struct Uniforms {
  resolution: vec2<u32>,
  frame_index: u32,      // 帧序号：只喂给 LDS，不参与累加平均
  max_bounces: u32,
  // ── 部分采样 ──
  dispatch_count: u32,   // 本帧调度的像素数（≤ pixel_count）
  cursor: u32,           // 当前轮内已采样的像素数 [0, pixel_count)
  sweep: u32,            // 已完成的整轮采样数（= 每个像素的样本数下界）
  pixel_count: u32,      // width * height
}

struct CameraUniforms {
  inv_view_projection: mat4x4<f32>,
  camera_position: vec4<f32>,
  resolution: vec4<f32>,
  fov: f32,
  // 入射光瞳半径（米）。0 = 针孔。
  aperture_radius: f32,
  // 对焦距离（米，沿视线量）。0 = 无穷远。
  focus_distance: f32,
}

struct Ray { origin: vec3<f32>, direction: vec3<f32> }
struct BVHResult { t: f32, u: f32, v: f32, triangle_index: u32, instance_index: u32 }

struct Instance {
  blas_node_offset: f32,
  transform: mat4x3<f32>,
  inv_transform: mat4x3<f32>,
}

const epsilon = 1e-6;

@group(0) @binding(0) var<uniform> u: Uniforms;
// TLAS + BLAS 合并节点表：[TLAS ...][BLAS ...]，每节点 8 float。
// BLAS 的 node offset 在打包时已经加上 TLAS 长度（见 gpu/upload.ts）。
@group(0) @binding(2) var<storage, read> nodes: array<f32>;
// 像素采样顺序：0..pixel_count-1 的随机排列（见 gpu/pixel-order.ts）。
@group(0) @binding(3) var<storage, read> pixel_order: array<u32>;
@group(0) @binding(4) var<storage, read> geometry: array<f32>;
@group(0) @binding(5) var<storage, read> triangles: array<u32>;
@group(0) @binding(6) var<storage, read> materials: array<f32>;
@group(0) @binding(7) var<storage, read> instances: array<Instance>;
@group(0) @binding(8) var out_texture: texture_storage_2d<rgba32float, write>;
@group(0) @binding(9) var environment_texture: texture_2d<f32>;
// 材质贴图：三个 texture_2d_array，材质表里存层号（见 TextureSet）。
@group(0) @binding(10) var albedo_texture: texture_2d_array<f32>;
@group(0) @binding(11) var normal_texture: texture_2d_array<f32>;
@group(0) @binding(12) var roughness_texture: texture_2d_array<f32>;
// AO 图（R 通道）：只衰减间接光，照亮面的直射光不受影响，见 main.wgsl 的 beta。
@group(0) @binding(19) var occlusion_texture: texture_2d_array<f32>;
@group(0) @binding(17) var texture_sampler: sampler;
// 环境图专用采样器：u 环绕、v 夹边。材质贴图那个是 repeat/repeat —— 环境图
// 的 v 是极角，绕回去会从北极直接串到南极。
@group(0) @binding(21) var environment_sampler: sampler;
@group(0) @binding(13) var previous_accumulation_texture: texture_2d<f32>;
@group(0) @binding(15) var<uniform> camera: CameraUniforms;
// 降噪引导缓冲：xyz = 世界几何法线，w = 命中距离（天空为 0）。只有导出时用。
@group(0) @binding(20) var guide_texture: texture_storage_2d<rgba32float, write>;
// 环境亮度 CDF（布局见 engine/background.ts）
@group(0) @binding(16) var<storage, read> env_distribution: array<f32>;
