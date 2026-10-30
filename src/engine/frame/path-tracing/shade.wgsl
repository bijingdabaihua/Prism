// Shading: PBR material with environment reflection + material texture sampling

// ---------------------------------------------------------------------------
// LDS — stateless low-discrepancy sampler via PCG-hashed (seed, sample, dim).
//
// Each (sample, dim) pair produces a deterministic pseudo-random value; the
// seed varies per pixel.  Multiplication by large primes preserves all bits
// unlike << which truncates; the Wang finalizer provides high-quality
// avalanche mixing.
// ---------------------------------------------------------------------------

fn lds(seed: u32, sample: u32, dim: u32) -> f32 {
  var v = seed;
  v = v ^ (sample * 0x9E3779B9u);   // golden-ratio prime
  v = v ^ (dim * 0x517CC1B7u);      // another large prime
  v = v * 0x85EBCA6Bu;  // Wang hash finalizer: 3 rounds of xor-shift-mul
  v = v ^ (v >> 16u);
  v = v * 0xC2B2AE35u;
  v = v ^ (v >> 13u);
  v = v * 0x27D4EB2Du;
  v = v ^ (v >> 16u);
  return f32(v >> 8u) / f32(0xFFFFFFu);
}

fn lds2(seed: u32, sample: u32, dim: u32) -> vec2<f32> {
  return vec2(lds(seed, sample, dim), lds(seed, sample, dim + 1u));
}

// ---------------------------------------------------------------------------
// SurfaceInfo — material data at a hit point, used by bounce loop
// ---------------------------------------------------------------------------

struct SurfaceInfo {
  position: vec3<f32>,
  normal: vec3<f32>,
  // 三角形自己的面法线，已翻向射线。着色用上面的插值法线，阴影射线的偏移
  // 用这一条 —— 扫描模型的顶点法线在曲率大的地方会和真实面差很多，
  // 拿它做偏移会把射线推进相邻三角形里，表现是表面上一片固定的黑点。
  geo_normal: vec3<f32>,
  wo: vec3<f32>,           // direction from surface toward incoming ray
  albedo: vec3<f32>,
  roughness: f32,
  metallic: f32,
  // 环境光遮蔽（0..1）：只衰减从这个点继续弹出去的间接光，直射光不乘。
  ao: f32,
  hit: bool,
}

// ---------------------------------------------------------------------------
// Evaluate material at a hit point — no lighting, used by bounce loop
// ---------------------------------------------------------------------------

// Resolve the GPU material slot for a triangle: absolute material index baked
// into triangles[*][3] at merge time.
fn material_slot(global_triangle_index: u32) -> u32 {
  return triangles[global_triangle_index * 4u + 3u];
}

fn compute_surface(ray: Ray, hit: BVHResult) -> SurfaceInfo {
  // Miss — no geometry at all; store ray direction in wo for env map sampling
  if (hit.t <= 0.0) {
    return SurfaceInfo(vec3(0.0), vec3(0.0), vec3(0.0), -ray.direction, vec3(0.0), 0.0, 0.0, 1.0, false);
  }

  let inst = instances[hit.instance_index];
  let o = material_slot(u32(hit.triangle_index)) * 28u;

  var base_color = vec3(materials[o+0u], materials[o+1u], materials[o+2u]);
  // metallic / roughness 是 glTF 的 factor：有贴图时它们当乘数，没有时就是全部。
  let metallic_factor = materials[o+3u];
  let roughness_factor = materials[o+4u];
  var metallic = metallic_factor;
  var roughness = roughness_factor;
  let normal_scale = materials[o+5u];

  // Read triangle vertices
  let triangle_data_offset = hit.triangle_index * 4u;
  let i0 = triangles[triangle_data_offset];
  let i1 = triangles[triangle_data_offset+1u];
  let i2 = triangles[triangle_data_offset+2u];

  let v0 = read_vertex(i0);
  let v1 = read_vertex(i1);
  let v2 = read_vertex(i2);

  let w = 1.0 - hit.u - hit.v;
  let uv = w * v0.uv + hit.u * v1.uv + hit.v * v2.uv;
  // Defensive: a NaN/zero barycentric sum would make normalize() NaN (normalize(0) = NaN).
  // Fall back to the geometric face normal so the hit normal is always valid.
  var local_normal = w * v0.normal + hit.u * v1.normal + hit.v * v2.normal;
  if (!(dot(local_normal, local_normal) > 0.0)) {
    local_normal = cross(v1.position - v0.position, v2.position - v0.position);
  }
  local_normal = normalize(local_normal);

  let local_tangent = w * v0.tangent + hit.u * v1.tangent + hit.v * v2.tangent;
  let world_tangent = normalize((inst.transform * vec4<f32>(local_tangent.xyz, 0.0)).xyz);
  let world_normal = normalize((inst.transform * vec4<f32>(local_normal, 0.0)).xyz);
  let facing_normal = select(-world_normal, world_normal, dot(world_normal, -ray.direction) > 0.0);

  var geo_local = cross(v1.position - v0.position, v2.position - v0.position);
  if (!(dot(geo_local, geo_local) > 0.0)) { geo_local = local_normal; }
  let world_geo = normalize((inst.transform * vec4<f32>(geo_local, 0.0)).xyz);
  let facing_geo = select(-world_geo, world_geo, dot(world_geo, -ray.direction) > 0.0);

  let tangent_axis = normalize(world_tangent - facing_normal * dot(facing_normal, world_tangent));
  let bitangent_axis = cross(facing_normal, tangent_axis) * local_tangent.w;

  // 贴图采样：材质表里每个槽位是 [layer, scale, has, _]（见 compile/packing.ts）。
  //
  // LOD 只能用估算：路径追踪没有屏幕空间导数，textureSample 用不了。
  // 关键是像素覆盖不能当一个圆看：视线贴着地面走时，一个像素沿视线方向
  // 覆盖好几米、垂直方向只覆盖几毫米。原来按「法线夹角」算一个各向同性
  // 尺寸，两条轴一起降 mip，远景地面就糊成一片横向条纹 —— 掠射面看起来
  // 「分辨率不够」，就是这里来的。所以沿 u/v 各算一次：小轴定 mip，
  // 大轴用多次采样补回来（见 sample_texture）。
  //
  // 沿轴 a 的世界覆盖是 step / sqrt(1 - (d·a)²)：视线越贴着这条轴走，
  // 屏幕上一个像素在这条轴上跨得越远。截到 20 倍，地平线附近不退化。
  let pixel_angle = clamp(
    2.0 * tan(camera.fov * 0.5) / max(camera.resolution.y, 1.0),
    1e-6,
    0.5,
  );
  let step = hit.t * pixel_angle;
  let d_tan = dot(tangent_axis, ray.direction);
  let d_bit = dot(bitangent_axis, ray.direction);
  let foot_t = step / sqrt(max(1.0 - d_tan * d_tan, 0.0025));
  let foot_b = step / sqrt(max(1.0 - d_bit * d_bit, 0.0025));

  var normal_perturbation = vec3<f32>(0.0, 0.0, 1.0);
  if (materials[o + 10u] > 0.5) {
    let scale = materials[o + 9u];
    base_color = sample_texture(albedo_texture, materials[o + 8u], scale, uv, foot_t, foot_b).rgb;
  }
  // 打包的 metallic-roughness（glTF 约定 / Poly Haven 的 arm 图）：G = 粗糙度，
  // B = 金属度。金属度到这一版才真正能随贴图变化 —— 之前只有标量，
  // 一张钢板上同时有漆面和裸金属的地方就画不对。
  if (materials[o + 26u] > 0.5) {
    let scale = materials[o + 25u];
    let mr = sample_texture(roughness_texture, materials[o + 24u], scale, uv, foot_t, foot_b);
    roughness = mr.g * roughness_factor;
    metallic = mr.b * metallic_factor;
  }
  // 单通道粗糙度图：和打包图并存时只覆盖粗糙度。
  if (materials[o + 14u] > 0.5) {
    let scale = materials[o + 13u];
    roughness = sample_texture(roughness_texture, materials[o + 12u], scale, uv, foot_t, foot_b).r * roughness_factor;
  }
  if (materials[o + 18u] > 0.5) {
    let scale = materials[o + 17u];
    let ns = sample_texture(normal_texture, materials[o + 16u], scale, uv, foot_t, foot_b).rgb;
    normal_perturbation = normalize(ns * 2.0 - 1.0);
    normal_perturbation = vec3(normal_perturbation.xy * normal_scale, normal_perturbation.z);
  }

  // AO：材质表里 [layer, scale, has, _] 和另外三张图同一套约定。glTF 的
  // occlusion 只有 R 通道，导入器会把 R 抄进 RGB，这里取 .r 即可。
  var ao = 1.0;
  if (materials[o + 22u] > 0.5) {
    let occ = sample_texture(occlusion_texture, materials[o + 20u], materials[o + 21u], uv, foot_t, foot_b).r;
    ao = mix(1.0, occ, clamp(materials[o + 6u], 0.0, 1.0));
  }

  let mapped_normal = normalize(
    tangent_axis * normal_perturbation.x +
    bitangent_axis * normal_perturbation.y +
    facing_normal * normal_perturbation.z
  );

  let hit_pos = ray.origin + ray.direction * hit.t;

  return SurfaceInfo(
    hit_pos,
    mapped_normal,
    facing_geo,
    -ray.direction,
    base_color,
    roughness,
    metallic,
    ao,
    true,
  );
}

// ---------------------------------------------------------------------------
// TBN — build orthonormal basis from a unit normal
// ---------------------------------------------------------------------------

struct TBN { u: vec3<f32>, v: vec3<f32>, w: vec3<f32> }

fn build_tbn(n: vec3<f32>) -> TBN {
  let w = normalize(n);
  // Pick a reference axis guaranteed non-parallel to w
  let a = normalize(select(vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, 1.0), abs(w.x) > 0.9));
  let u = normalize(cross(w, a));
  let v = cross(w, u);
  return TBN(u, v, w);
}

// ---------------------------------------------------------------------------
// sample_hemisphere_cosine — cosine-weighted direction in hemisphere around n
// ---------------------------------------------------------------------------

fn sample_hemisphere_cosine(n: vec3<f32>, r1: f32, r2: f32) -> vec3<f32> {
  // Validate n: if n is NaN or zero, build_tbn will break — fall back to +Y
  if (n.x != n.x || n.y != n.y || n.z != n.z || dot(n, n) < 1e-12) { return vec3(0.0, 1.0, 0.0); }
  let c1 = clamp(r1, 0.0, 1.0);
  let c2 = clamp(r2, 0.0, 1.0);
  let tbn = build_tbn(n);
  let phi = c1 * 6.2831853;
  let cos_theta = sqrt(max(1.0 - c2, 0.0));
  let sin_theta = sqrt(max(c2, 0.0));
  let dir = tbn.u * sin_theta * cos(phi) + tbn.v * sin_theta * sin(phi) + tbn.w * cos_theta;
  return normalize(dir);
}

// ---------------------------------------------------------------------------
// BSDF 采样：漫反射瓣（Lambert）+ 镜面瓣（GGX）的混合
//
// 采样时按 specular_probability 二选一；返回的 pdf 必须是**混合**密度
// p·pdf_spec + (1-p)·pdf_diff —— 那才是这个采样过程在 wo 处的真实密度，
// NEE 一侧的 MIS 用的也是同一个数。
//
// 采样和求值共用 evaluate_bsdf，所以两者的 pdf 不会各算各的。
// 以前采样是纯余弦、求值是 GGX 混合，两边对不上，MIS 权重加起来不等于 1。
// ---------------------------------------------------------------------------

struct BSDFSample {
  wo: vec3<f32>,
  f: vec3<f32>,
  pdf: f32,
  /// 这个方向是从镜面瓣还是余弦瓣采出来的。逃生到环境时，只有镜面样本
  /// 才配按粗糙度取预滤波的 mip —— 余弦样本要的是余弦加权的半球平均，
  /// 用一张被糊成全球平均的 mip 去乘它，地面会直接亮一倍。
  specular: bool,
}

/// 镜面瓣的采样概率。sample_bsdf 和 evaluate_bsdf 必须用同一个值。
/// 电介质（metallic = 0）留 20% 给镜面：它的真实贡献只有百分之几，
/// 全给镜面会把余弦采样饿死，室内场景的漫反射噪声会明显变差。
fn specular_probability(metallic: f32) -> f32 {
  return clamp(mix(0.2, 1.0, metallic), 0.05, 1.0);
}

/// Smith 几何项的 G1（单方向遮蔽）。VNDF 的 pdf 里需要它。
fn smith_g1(n_dot_v: f32, alpha2: f32) -> f32 {
  let c = max(n_dot_v, 1e-4);
  return 2.0 * c / (c + sqrt(alpha2 * (1.0 - c * c) + c * c));
}

/// VNDF 采样 —— Heitz 2018, "Sampling the GGX Distribution of Visible Normals"。
///
/// 与按 D(h)·(n·h) 的 NDF 采样相比，只在「从视线看得见的那部分微表面」里采：
/// 掠射角下不会把样本浪费在地平线以下的半程向量上，噪声明显更低。
///
/// 切线空间进、切线空间出（法线 = +Z）；ve 是视线方向。
fn sample_ggx_vndf(ve: vec3<f32>, alpha: f32, r1: f32, r2: f32) -> vec3<f32> {
  let vh = normalize(vec3(alpha * ve.x, alpha * ve.y, max(ve.z, 1e-4)));

  let lensq = vh.x * vh.x + vh.y * vh.y;
  var t1 = vec3(1.0, 0.0, 0.0);
  if (lensq > 1e-12) { t1 = vec3(-vh.y, vh.x, 0.0) * inverseSqrt(lensq); }
  let t2 = cross(vh, t1);

  let r = sqrt(clamp(r1, 0.0, 1.0));
  let phi = 6.2831853 * r2;
  let p1 = r * cos(phi);
  var p2 = r * sin(phi);
  // 把圆盘下半部分撑开，避开背向视线的微表面
  let s = 0.5 * (1.0 + vh.z);
  p2 = (1.0 - s) * sqrt(max(1.0 - p1 * p1, 0.0)) + s * p2;

  let nh = p1 * t1 + p2 * t2 + sqrt(max(1.0 - p1 * p1 - p2 * p2, 0.0)) * vh;
  return normalize(vec3(alpha * nh.x, alpha * nh.y, max(nh.z, 1e-6)));
}

/// 世界空间下的 GGX 半程向量采样。alpha = roughness²。
fn sample_ggx_half_vector(n: vec3<f32>, wo: vec3<f32>, alpha: f32, r1: f32, r2: f32) -> vec3<f32> {
  let tbn = build_tbn(n);
  let ve = vec3(dot(wo, tbn.u), dot(wo, tbn.v), dot(wo, tbn.w));
  let nh = sample_ggx_vndf(ve, alpha, r1, r2);
  return normalize(tbn.u * nh.x + tbn.v * nh.y + tbn.w * nh.z);
}

fn sample_bsdf(surf: SurfaceInfo, r1: f32, r2: f32, r3: f32) -> BSDFSample {
  let n = surf.normal;
  let alpha = max(surf.roughness * surf.roughness, 0.001);
  let spec_prob = specular_probability(surf.metallic);

  var wo: vec3<f32>;
  let specular = r3 < spec_prob;
  if (specular) {
    let h = sample_ggx_half_vector(n, surf.wo, alpha, r1, r2);
    wo = normalize(reflect(-surf.wo, h));
    // 反射到地平线以下：该方向的密度为 0，这个样本只能丢弃，
    // 否则 f·cos/pdf 会除出巨大的权重，变成萤火虫。
    if (dot(wo, n) <= 0.0) { return BSDFSample(vec3(0.0, 1.0, 0.0), vec3(0.0), 0.0, true); }
  } else {
    wo = sample_hemisphere_cosine(n, r1, r2);
  }

  let val = evaluate_bsdf(-wo, surf.wo, n, surf.metallic, surf.roughness, surf.albedo);
  return BSDFSample(wo, val.f, val.pdf, specular);
}

// ---------------------------------------------------------------------------
// Evaluvation — given wi (toward surface), wo (away from surface),
// compute f(wi, wo) and pdf(wi→wo) for explicit light sampling / MIS.
// ---------------------------------------------------------------------------

struct BSDFResult {
  f: vec3<f32>,
  pdf: f32,
}

fn evaluate_bsdf(wi: vec3<f32>, wo: vec3<f32>, n: vec3<f32>, metallic: f32, roughness: f32, albedo: vec3<f32>) -> BSDFResult {
  let wi_std = -wi;
  let n_dot_wi = max(dot(n, wi_std), 0.001);
  let n_dot_wo = max(dot(n, wo), 0.001);

  // 半程向量：wi 与 wo 几乎反向时（掠射）它没有定义，此时 BRDF 也没有意义
  let hsum = wi_std + wo;
  if (dot(hsum, hsum) < 1e-12) { return BSDFResult(vec3(0.0), 0.0); }
  let h = normalize(hsum);
  let h_dot_n = dot(n, h);
  let n_dot_h = max(h_dot_n, 0.001);
  let h_dot_wo = max(dot(h, wo), 0.001);
  // 半程向量落到表面之下：VNDF 采样器永远不会产生这种半程向量，
  // 镜面瓣的 f 与 pdf 都必须归零，否则 NEE 在掠射角会高估 BSDF 的 pdf。
  let spec_visible = select(0.0, 1.0, h_dot_n > 0.0);

  let a = max(roughness * roughness, 0.001);
  let a2 = a * a;

  let f0 = mix(vec3(0.04), albedo, metallic);
  // Schlick 的夹角是「视线与半程向量」，不是视线与法线
  let fresnel = f0 + (vec3(1.0) - f0) * pow(1.0 - h_dot_wo, 5.0);

  let d = a2 / (3.14159265 * pow(n_dot_h * n_dot_h * (a2 - 1.0) + 1.0, 2.0));

  let ggxv = n_dot_wo * sqrt((n_dot_wi * n_dot_wi) * (1.0 - a2) + a2);
  let ggxl = n_dot_wi * sqrt((n_dot_wo * n_dot_wo) * (1.0 - a2) + a2);
  let g = 2.0 * n_dot_wi * n_dot_wo / max(ggxv + ggxl, 1e-8);

  let f_spec = spec_visible * fresnel * d * g / (4.0 * n_dot_wi * n_dot_wo + 1e-8);
  let f_diff = albedo * (1.0 - metallic) / 3.14159265;

  // VNDF 采样的立体角 pdf（Heitz 2018）：p(wo) = D(h)·G1(wo) / (4·(n·wo))。
  // 必须和 sample_ggx_half_vector 用的是同一套采样过程，否则权重和 MIS 都会错。
  let pdf_spec = spec_visible * d * smith_g1(n_dot_wo, a2) / (4.0 * n_dot_wo);
  let pdf_diff = n_dot_wi / 3.14159265;

  let spec_prob = specular_probability(metallic);

  return BSDFResult(
    f_spec + f_diff,
    pdf_spec * spec_prob + pdf_diff * (1.0 - spec_prob),
  );
}

// ---------------------------------------------------------------------------
// 阴影射线的法线偏移。要压过求交的 epsilon（1e-6）以避免自相交，又要远小于
// 场景里最小的「面到面」间隙 —— 取 0.1 mm。
// ---------------------------------------------------------------------------

const SHADOW_EPSILON = 1e-4;

// ---------------------------------------------------------------------------
// MIS power heuristic — beta=2: the estimator with higher PDF dominates.
// pdf_a = PDF of the estimator being weighted, pdf_b = competing PDF.
// ---------------------------------------------------------------------------

fn mis_weight(pdf_a: f32, pdf_b: f32) -> f32 {
  let a2 = pdf_a * pdf_a;
  return a2 / max(a2 + pdf_b * pdf_b, 1e-12);
}

// ---------------------------------------------------------------------------
// NEE: 环境光采样
//
// 环境是无穷远的发光体，没有「点」，只有方向：按亮度 CDF 采一个方向，
// 追一条阴影射线，可见就直接取该方向的辐亮度。
//
// 没有这一段时，太阳只能靠漫反射余弦采样「碰巧」命中，偶尔命中就会
// 产生被 1/pdf 放大的萤火虫。有了 NEE，太阳方向每帧都被直接采到，
// BSDF 一侧偶尔命中的样本再被 MIS 压低，萤火虫消失。
// ---------------------------------------------------------------------------

fn direct_environment(surf: SurfaceInfo, seed: u32, dim: ptr<function, u32>) -> vec3<f32> {
  let r1 = lds(seed, u.frame_index, *dim); *dim += 1u;
  let r2 = lds(seed, u.frame_index, *dim); *dim += 1u;
  let sample = sample_environment_light(r1, r2);

  // 只采上半球（法线一侧）的方向
  let cos_surf = dot(surf.normal, sample.direction);
  if (cos_surf <= 0.0) { return vec3(0.0); }

  // 环境在无穷远：命中任何表面都算被遮挡
  let shadow_origin = surf.position + surf.geo_normal * SHADOW_EPSILON;
  let shadow_hit = intersect_scene(Ray(shadow_origin, sample.direction));
  if (shadow_hit.t > 0.0) { return vec3(0.0); }

  let bsdf_val = evaluate_bsdf(
    -sample.direction, surf.wo, surf.normal, surf.metallic, surf.roughness, surf.albedo
  );
  if (bsdf_val.pdf <= 0.0) { return vec3(0.0); }

  // pdf 都是立体角测度，可以直接比较。
  let mis_w = mis_weight(sample.pdf, bsdf_val.pdf);
  let radiance = env_texel(sample.direction);

  return mis_w * bsdf_val.f * radiance * cos_surf / max(sample.pdf, 1e-12);
}

// ---------------------------------------------------------------------------
// Environment / atlas samplers (used by the bounce loop)
// ---------------------------------------------------------------------------

fn environment_uv(direction: vec3<f32>) -> vec2<f32> {
  let phi = atan2(direction.z, direction.x);
  let theta = acos(clamp(direction.y, -1.0, 1.0));
  return vec2(phi / 6.2831853 + 0.5, 1.0 - theta / 3.14159265);
}

/// 相机射线直接逃进环境：mip 0 双线性。
fn env_radiance(direction: vec3<f32>) -> vec3<f32> {
  return textureSampleLevel(environment_texture, environment_sampler, environment_uv(direction), 0.0).rgb;
}

/// NEE 用：按纹素精确取值，和亮度 CDF 的采样保持同一个函数。
fn env_texel(direction: vec3<f32>) -> vec3<f32> {
  let uv = environment_uv(direction);
  let size = textureDimensions(environment_texture, 0);
  // 夹到有效 texel：uv 正好落在 1.0 时坐标会越界。
  let coordinate = clamp(
    vec2<i32>(uv * vec2<f32>(size)),
    vec2<i32>(0),
    vec2<i32>(size) - vec2<i32>(1),
  );
  return textureLoad(environment_texture, coordinate, 0).rgb;
}

/// BSDF 逃生方向用：按粗糙度取一条预滤波过的 mip。
///
/// GGX 瓣在环境图上覆盖的纹素宽度 ≈ 2α / (2π / width) = α·width/π（α = roughness²），
/// 取 log2 就是 mip 级数。没有这一条时，光滑表面每个样本只取一个纹素 ——
/// 釉面反射的是一张 2k 的点云，相邻样本在亮暗之间跳，收敛极慢。
///
/// 和 NEE 用不同的 mip 不影响无偏性：MIS 权重只看两侧的 pdf，不看亮度；
/// 而这里估的本来就是「瓣内环境的平均」，模糊过的 mip 正是它的近似。
fn env_radiance_rough(direction: vec3<f32>, roughness: f32) -> vec3<f32> {
  let width = f32(textureDimensions(environment_texture, 0).x);
  let alpha = max(roughness * roughness, 1e-4);
  let lod = clamp(log2(max(alpha * width / 3.14159265, 1.0)), 0.0, 12.0);
  return textureSampleLevel(environment_texture, environment_sampler, environment_uv(direction), lod).rgb;
}

// ---------------------------------------------------------------------------
// 环境重要性采样
//
// 环境图每像素权重 = 亮度 × sinθ（行内归一化），边缘 CDF 再按行权重归一化。
// 采样步骤：先按边缘 CDF 选行，再按该行的条件 CDF 选列，最后取像素中心方向。
//
// 立体角换算：等距柱状的 (u,v) → 立体角雅可比是 2π²·sinθ（u 覆盖 2π、v 覆盖 π），
// 所以 pdf_ω = p_row · p_col · w·h / (2π² · sinθ)。
// 采样和 pdf 用同一个公式，MIS 权重才自洽。
// ---------------------------------------------------------------------------

struct EnvLightSample {
  direction: vec3<f32>,
  pdf: f32,
}

fn sample_environment_light(r1: f32, r2: f32) -> EnvLightSample {
  let size = textureDimensions(environment_texture, 0);
  let w = size.x;
  let h = size.y;
  let stride = w + 1u;
  let marginal_offset = h * stride;

  // 选行（边缘 CDF 下标 y 表示「前 y 行的累计」）
  var row_lo: u32 = 0u;
  var row_hi = h - 1u;
  loop {
    if (row_lo >= row_hi) { break; }
    let mid = (row_lo + row_hi) / 2u;
    if (env_distribution[marginal_offset + mid + 1u] <= r1) { row_lo = mid + 1u; }
    else { row_hi = mid; }
  }
  let row = row_lo;
  let row_base = row * stride;

  // 选列（行内条件 CDF）
  var col_lo: u32 = 0u;
  var col_hi = w - 1u;
  loop {
    if (col_lo >= col_hi) { break; }
    let mid = (col_lo + col_hi) / 2u;
    if (env_distribution[row_base + mid + 1u] <= r2) { col_lo = mid + 1u; }
    else { col_hi = mid; }
  }
  let col = col_lo;

  let row_prob = env_distribution[marginal_offset + row + 1u] - env_distribution[marginal_offset + row];
  let col_prob = env_distribution[row_base + col + 1u] - env_distribution[row_base + col];

  // 像素中心 → 方向（与 environment_uv 互逆）
  let theta = 3.14159265 * (1.0 - (f32(row) + 0.5) / f32(h));
  let phi = 6.2831853 * ((f32(col) + 0.5) / f32(w) - 0.5);
  let sin_theta = sin(theta);
  let direction = vec3(sin_theta * cos(phi), cos(theta), sin_theta * sin(phi));

  let wh = f32(w) * f32(h);
  let pdf = row_prob * col_prob * wh / (19.7392088 * max(sin_theta, 1e-6));

  return EnvLightSample(direction, pdf);
}

/** 任意方向在环境分布下的 pdf（立体角测度），供 BSDF 估计器做 MIS。 */
fn environment_pdf(direction: vec3<f32>) -> f32 {
  let size = textureDimensions(environment_texture, 0);
  let w = size.x;
  let h = size.y;
  let stride = w + 1u;

  let uv = environment_uv(direction);
  let col = min(u32(uv.x * f32(w)), w - 1u);
  let row = min(u32(uv.y * f32(h)), h - 1u);
  let marginal_offset = h * stride;

  let row_prob = env_distribution[marginal_offset + row + 1u] - env_distribution[marginal_offset + row];
  let col_prob = env_distribution[row * stride + col + 1u] - env_distribution[row * stride + col];

  let theta = 3.14159265 * (1.0 - (f32(row) + 0.5) / f32(h));
  let wh = f32(w) * f32(h);
  return row_prob * col_prob * wh / (19.7392088 * max(sin(theta), 1e-6));
}

/**
 * 从材质贴图数组里按层号取一张，显式指定 LOD，并沿覆盖较长的轴做各向异性采样。
 *
 * foot_t / foot_b 是像素在表面两个切向上的覆盖长度（米）。换成 texel 数之后，
 * 小的一轴决定 mip（细节不会被过度抹掉），大小轴之比决定沿大轴铺几个 tap。
 * 墙这种正对着看的面比值为 1，退化成一次采样；掠射地面才会走多 tap。
 */
fn sample_texture(
  texture: texture_2d_array<f32>,
  layer: f32,
  scale: f32,
  uv: vec2<f32>,
  foot_t: f32,
  foot_b: f32,
) -> vec4<f32> {
  let size = f32(textureDimensions(texture, 0).x);
  let texels_t = max(foot_t * scale * size, 1.0);
  let texels_b = max(foot_b * scale * size, 1.0);
  let major = max(texels_t, texels_b);
  let minor = min(texels_t, texels_b);
  // 上限 4 个 tap：比值再大也截住，否则一次采样的开销没有上界。
  let taps = i32(clamp(ceil(major / minor), 1.0, 4.0));
  let dir = select(vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), texels_t >= texels_b);

  var sum = vec4<f32>(0.0);
  for (var i = 0; i < taps; i++) {
    // tap 均匀铺满整段覆盖：taps = 1 时 offset 正好为 0
    let offset = (f32(i) + 0.5) / f32(taps) - 0.5;
    sum += textureSampleLevel(
      texture,
      texture_sampler,
      uv * scale + dir * offset * major / size,
      i32(layer),
      log2(minor),
    );
  }
  return sum / f32(taps);
}
