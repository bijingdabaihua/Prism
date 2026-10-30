// À-trous 小波降噪：一遍 5×5，调步长做三级，可见半径 1+2+4 像素。
//
// 输入是路径追踪累加出来的 radiance（线性 HDR，fp32），引导是同一帧的
// 几何法线 + 命中距离。权重分三部分：
//
//   空间  —— B3 样条 5×5 核，中心 6/16，边缘 1/16
//   几何  —— 法线夹角 + 相对深度差。这两个才是「是不是同一个表面」的依据。
//   亮度  —— 一个很温和的项，只用来挡住罐子上青花的硬边，不能太强：
//            16 spp 的噪声本身就是大幅度的亮度差，权重收得太紧等于没降噪。
//
// 天空（引导 w = 0）不跨边界混：天空与几何、天空与天空各混各的。

struct Params {
  step: i32,
  width: u32,
  height: u32,
  _pad: u32,
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var guide: texture_2d<f32>;
@group(0) @binding(3) var<uniform> p: Params;

fn luminance(c: vec3<f32>) -> f32 {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// B3 样条的四个非零权重（对称）：[1,4,6,4,1] / 16
fn b3(i: i32) -> f32 {
  switch (i) {
    case 0, 4: { return 0.0625; }
    case 1, 3: { return 0.25; }
    default: { return 0.375; }
  }
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) { return; }
  let coord = vec2<i32>(i32(id.x), i32(id.y));

  let g0 = textureLoad(guide, coord, 0);
  let c0 = textureLoad(src, coord, 0);
  // w = 0：这条射线没打到任何东西
  let sky0 = g0.w <= 0.0;

  var sum = vec3(0.0);
  var wsum = 0.0;

  for (var dy: i32 = -2; dy <= 2; dy = dy + 1) {
    for (var dx: i32 = -2; dx <= 2; dx = dx + 1) {
      let ncoord = coord + vec2<i32>(dx, dy) * p.step;
      if (ncoord.x < 0 || ncoord.y < 0 || ncoord.x >= i32(p.width) || ncoord.y >= i32(p.height)) {
        continue;
      }

      let g1 = textureLoad(guide, ncoord, 0);
      let sky1 = g1.w <= 0.0;
      // 天空和几何之间不混，否则物体边缘会长出一圈灰边
      if (sky0 != sky1) { continue; }

      var w = b3(dx + 2) * b3(dy + 2);

      if (!sky0) {
        let nd = clamp(dot(g0.xyz, g1.xyz), 0.0, 1.0);
        // 约 25° 以内的法线差才认为是同一块面
        w *= pow(nd, 16.0);
        // 相对深度差，容忍度随步长放大 —— 斜着看地面时相邻像素本来就差一截
        w *= exp(-abs(g0.w - g1.w) / (0.025 * f32(p.step) * g0.w + 1e-4));
      }

      let c1 = textureLoad(src, ncoord, 0);
      let l0 = luminance(c0.rgb);
      let l1 = luminance(c1.rgb);
      w *= 1.0 / (1.0 + 2.0 * abs(l0 - l1) / (l0 + l1 + 1e-3));

      sum += c1.rgb * w;
      wsum += w;
    }
  }

  let out_color = select(c0.rgb, sum / wsum, wsum > 0.0);
  textureStore(dst, coord, vec4(out_color, 1.0));
}
