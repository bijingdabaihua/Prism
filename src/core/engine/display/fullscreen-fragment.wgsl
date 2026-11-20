@group(0) @binding(0) var input_texture: texture_2d<f32>;

// 整条链路里唯一做显示映射的地方：线性 HDR → 色调映射 → sRGB 编码。
// 中间不插任何缩放：环境图给的就是场景的辐射亮度，ACES 负责把它压进屏幕，
// 再多乘一个「曝光」只会把物理量重新变成一个可以随便调的数字。

// 镜头语言：所有场景共用同一个「镜头」，参数不跟场景走。
// 暗角和颗粒加在色调映射之后（显示空间里），和真实相机的成像顺序一致。
const VIGNETTE_STRENGTH: f32 = 0.45;
const GRAIN_STRENGTH: f32 = 0.012;

// ACES 拟合（Narkowicz 2015）：把无上界的 HDR 值压到 [0,1]，高光平滑滚降。
fn aces_tone_map(x: vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3(0.0), vec3(1.0));
}

fn linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
  let v = clamp(c, vec3(0.0), vec3(1.0));
  let low = v * 12.92;
  let high = 1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055;
  return select(high, low, v <= vec3(0.0031308));
}

// 静态颗粒：按像素坐标哈希，不随帧变化 —— 否则整张图会闪，累积静帧也会被
// 颗粒淹没。强度只够打散暗部色带，不改变明暗关系。
fn grain_hash(p: vec2<f32>) -> f32 {
  var p3 = fract(p.xyx * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

@fragment
fn main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  // 渲染尺寸与画布一比一，直接取整像素；取不到的（画布比纹理大的过渡帧）由
  // textureLoad 越界规则返回 0，不会画错内容。
  let coord = vec2<i32>(position.xy);
  let hdr = textureLoad(input_texture, coord, 0).rgb;

  var color = aces_tone_map(hdr);

  // 暗角：距画面中心越远越暗，转角处压到约 78%
  let uv = position.xy / vec2<f32>(textureDimensions(input_texture));
  let offset = uv - vec2<f32>(0.5);
  color *= 1.0 - VIGNETTE_STRENGTH * dot(offset, offset);

  let srgb = linear_to_srgb(color);
  let grain = (grain_hash(position.xy) - 0.5) * GRAIN_STRENGTH;
  return vec4(clamp(srgb + grain, vec3(0.0), vec3(1.0)), 1.0);
}
