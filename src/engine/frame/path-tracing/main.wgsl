// Path tracing with NEE (Next Event Estimation) — explicit direct light sampling + indirect scattering

/** 从第几次弹射之后开始做俄罗斯轮盘赌（0 起算）。 */
const RR_START_BOUNCE: u32 = 4u;

// Camera ray generation — pixel coordinates + sub-pixel jitter for AA.
// Consumes 2 LDS dimensions (pixel_x, pixel_y jitter), plus 2 more when the
// lens has an aperture (thin-lens depth of field).
//
// 薄透镜：像素决定的是**焦平面上**的那个点，不是方向。光线从光圈圆盘上的
// 一个随机点出发、指向那个点 —— 圆盘越大，焦平面之外的物体散得越开。
// 光圈半径为 0 时圆盘退化成一个点，整条式子还原成针孔，不多采一次样。
fn generate_ray(pixel_x: u32, pixel_y: u32, seed: u32, dim: ptr<function, u32>) -> Ray {
  let eye = camera.camera_position.xyz;
  let jx = lds(seed, u.frame_index, *dim); *dim += 1u;
  let jy = lds(seed, u.frame_index, *dim); *dim += 1u;
  let jittered_x = f32(pixel_x) + jx;
  let jittered_y = f32(pixel_y) + jy;
  let ndc_x = jittered_x / f32(u.resolution.x) * 2.0 - 1.0;
  let ndc_y = jittered_y / f32(u.resolution.y) * 2.0 - 1.0;
  let clip = vec4(ndc_x, -ndc_y, 1.0, 1.0);
  let world = camera.inv_view_projection * clip;
  let direction = normalize(world.xyz / world.w - eye);

  if (camera.aperture_radius <= 0.0 || camera.focus_distance <= 0.0) {
    return Ray(eye, direction);
  }

  // 光圈圆盘上均匀取一点：半径按 sqrt(r) 铺，否则会挤在圆心。
  let r1 = lds(seed, u.frame_index, *dim); *dim += 1u;
  let r2 = lds(seed, u.frame_index, *dim); *dim += 1u;
  let radius = sqrt(r1) * camera.aperture_radius;
  let angle = 2.0 * 3.14159265 * r2;

  // 相机的右/上基。视线竖直向下时 cross 退化，退回世界 X 轴。
  let right_raw = cross(direction, vec3(0.0, 1.0, 0.0));
  let right = select(vec3(1.0, 0.0, 0.0), normalize(right_raw), length(right_raw) > 1e-6);
  let up = cross(right, direction);

  let offset = right * (radius * cos(angle)) + up * (radius * sin(angle));
  let focal_point = eye + direction * camera.focus_distance;
  let origin = eye + offset;

  return Ray(origin, normalize(focal_point - origin));
}

// Scatter — BSDF-scatter result at a vertex.
//
//   contrib : radiance from this vertex (environment on escape), already
//             weighted; caller adds  L += beta * scat.contrib.
//   weight  : BSDF weight multiplier for beta on the next bounce.
//   alive   : false stops the path (miss).
//   next    : surface at the scattered direction; first-iteration hole
//             is filled by the caller, subsequent ones from scatter's probe.
struct Scatter {
  contrib: vec3<f32>,
  weight: vec3<f32>,
  alive: bool,
  next: SurfaceInfo,
}

// scatter — BSDF estimator at a vertex.
//
// Determines what happens when a ray lands on this surface.  The light transport
// leaving a vertex is estimated by:
//
//   1. NEE (direct_environment) — pick an environment direction, trace a shadow
//      ray, eval BSDF.  MIS weight: pdf_nee² / (pdf_nee² + pdf_bsdf²).
//
//   2. BSDF scatter (this function) — sample a direction from the BSDF, trace a
//      probe ray.  If the probe escapes into the environment, that radiance is
//      the BSDF estimator.  MIS weight: pdf_bsdf² / Σ pdf².
//
// Both estimators contribute to the same transport path — without MIS, energy
// doubles.  The power heuristic reconciles them.
//
// Cases — miss is resolved by path_trace's zero-bounce term (before scatter is
// reached), so `hit` here is always a surface:
//   probe escapes to env → env radiance (BSDF-weighted), terminate.
//   probe hits surface   → alive, continue with `next`.
fn scatter(hit: SurfaceInfo, seed: u32, dim: ptr<function, u32>) -> Scatter {
  // hit is always a surface here — miss is handled by path_trace's zero-bounce
  // term, which breaks before calling scatter.
  let r1 = lds(seed, u.frame_index, *dim); *dim += 1u;
  let r2 = lds(seed, u.frame_index, *dim); *dim += 1u;
  let r3 = lds(seed, u.frame_index, *dim); *dim += 1u;
  let bsdf = sample_bsdf(hit, r1, r2, r3);
  // 采到地平线以下（pdf = 0）：这个样本没有定义，直接终止路径
  if (bsdf.pdf <= 0.0) { return Scatter(vec3(0.0), vec3(0.0), false, hit); }
  let weight = bsdf.f * abs(dot(hit.normal, bsdf.wo)) / max(bsdf.pdf, 1e-6);

  // Probe toward scattered direction — result reused as `next` by the caller
  let probe_origin = hit.position + hit.geo_normal * 0.0001;
  let next_hit = intersect_surface(Ray(probe_origin, bsdf.wo));

  if (!next_hit.hit) {
    // Probe escaped into the environment — add its radiance here (BSDF-weighted)
    // and terminate.  Deferring this to the next bounce dropped it when the
    // bounce budget ran out (e.g. max_bounces=0 → box exteriors went black).
    // MIS: 环境 NEE 也可能采到同一个方向，功率启发式分摊，否则会重复计能量。
    // 镜面样本按粗糙度取预滤波的 mip（光滑表面只糊一点点）；余弦样本一律
    // 取 mip 0 —— 见 BSDFSample.specular 的注释。
    let env = select(env_radiance(bsdf.wo), env_radiance_rough(bsdf.wo, hit.roughness), bsdf.specular);
    let pdf_env = environment_pdf(bsdf.wo);
    let mis_w = mis_weight(bsdf.pdf, pdf_env);
    // AO 的第一处：天空/环境来的一次散射光按遮蔽率衰减（这就是 AO 的本意：
    // 天空可见度）。太阳的 NEE 项不在这里，仍在 direct_light 里原样保留。
    return Scatter(mis_w * weight * env * hit.ao, vec3(0.0), false, next_hit);
  }
  return Scatter(vec3(0.0), weight, true, next_hit);
}


// intersect_surface — cast a ray and evaluate material at the hit point.
fn intersect_surface(ray: Ray) -> SurfaceInfo {
  return compute_surface(ray, intersect_scene(ray));
}

// Path tracing loop — unidirectional path tracing with NEE + MIS.
//
// Each bounce first adds the zero-bounce radiance (environment on escape) —
// this needs no scattering.  Then the two estimators for light transport to a
// surface are summed into L:
//   1. NEE  (direct_environment) — sample the environment, shadow ray, MIS-weighted.
//   2. BSDF (scatter)        — sample BSDF direction; if the probe escapes, its
//                               environment radiance is the BSDF estimator.
//
// scatter also returns the next surface (via probe, saving one BVH traversal
// per bounce) and the throughput weight.
fn path_trace(ray: Ray, seed: u32, dim: ptr<function, u32>) -> vec3<f32> {
  var beta = vec3(1.0);
  var L = vec3(0.0);
  var hit = intersect_surface(ray);

  for (var bounce: u32 = 0u; bounce <= u.max_bounces; bounce++) {
    // Zero-bounce radiance: a ray escaping into the environment contributes its
    // radiance without scattering.
    if (!hit.hit) {
      L += beta * env_radiance(-hit.wo);
      break;
    }

    // NEE estimator
    L += beta * direct_environment(hit, seed, dim);

    // BSDF estimator
    let scat = scatter(hit, seed, dim);
    L += beta * scat.contrib;
    if (!scat.alive) { break; }
    // AO 只乘在「继续弹出去的路径」上：直接光（NEE 和本 bounce 的 BSDF 命中）
    // 已经加进 L 了，不受影响。这一项等于把宏观遮挡当作间接光的可见度。
    beta *= scat.weight * hit.ao;

    hit = scat.next;

    // 俄罗斯轮盘赌：第 4 次弹射之后按吞吐量决定是否继续，终止的路径按 1/p
    // 补偿。期望值不变，但避免了 max_bounces 硬截断带来的能量损失
    // （封闭盒子里 albedo 0.73，截断 5 次就丢掉两成能量）。
    if (bounce >= RR_START_BOUNCE) {
      let p = clamp(max(beta.r, max(beta.g, beta.b)), 0.05, 1.0);
      let rr = lds(seed, u.frame_index, *dim); *dim += 1u;
      if (rr > p) { break; }
      beta /= p;
    }
  }

  return L;
}

// ---------------------------------------------------------------------------
// Progressive accumulation
//
// 部分采样：每帧只写顺序表里连续的一段（dispatch_count 个像素），其余像素
// 由 CPU 侧每帧的纹理拷贝原样保留。所以「这个像素采过几次」不能再用帧号，
// 而是由它在顺序表里的位置决定 —— 见 main。
// ---------------------------------------------------------------------------
fn accumulate(coordinate: vec2<i32>, radiance: vec3<f32>, previous_count: u32) {
  let prev = textureLoad(previous_accumulation_texture, coordinate, 0).rgb;
  let count = f32(previous_count);
  let blended = (prev * count + radiance) / (count + 1.0);
  textureStore(out_texture, coordinate, vec4(blended, 1.0));
}

// 1D dispatch：一个线程 = 顺序表里的一个像素。
//
// 全局采样序号 sample_index = cursor + slot，顶多跨过一轮边界
// （CPU 保证 dispatch_count ≤ pixel_count）。顺序表是一整轮无重复的随机
// 排列，每跨过 pixel_count 个采样，所有像素恰好各多采一次，所以
// previous_count = 已完成轮数 + (本次是否已跨入下一轮)，不需要逐像素存计数。
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let slot = id.x;
  if (slot >= u.dispatch_count) { return; }

  let sample_index = u.cursor + slot;
  let previous_count = u.sweep + select(0u, 1u, sample_index >= u.pixel_count);
  let pixel = pixel_order[sample_index % u.pixel_count];

  let pixel_x = pixel % u.resolution.x;
  let pixel_y = pixel / u.resolution.x;
  let coordinate = vec2<i32>(i32(pixel_x), i32(pixel_y));

  let seed = pixel_x ^ (pixel_y << 16u);
  var dim: u32 = 0u;
  let ray = generate_ray(pixel_x, pixel_y, seed, &dim);
  let L = path_trace(ray, seed, &dim);
  accumulate(coordinate, L, previous_count);
}

// ---------------------------------------------------------------------------
// 降噪引导：每个像素一条针孔射线，写几何法线和命中距离。
//
// 只给降噪器判断「相邻两个像素是不是同一个表面」用，所以不抖动、不开光圈、
// 不采第二次 —— 一像素一条就够。用几何法线而不是插值法线：地面材质带法线
// 贴图，插值法线在 4 mm 的土块上逐像素乱跳，降噪器会以为到处是边，反而
// 把噪声原样留下来。几何法线只反映三角形朝向，平地上是连续的。
//
// 天空写 (0,0,0,0)：w = 0 是「无限远」的哨兵值，降噪器据此把天空和几何断开。
// ---------------------------------------------------------------------------
@compute @workgroup_size(8, 8)
fn guides(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= u.resolution.x || id.y >= u.resolution.y) { return; }
  let coord = vec2<i32>(i32(id.x), i32(id.y));

  let ndc_x = (f32(id.x) + 0.5) / f32(u.resolution.x) * 2.0 - 1.0;
  let ndc_y = (f32(id.y) + 0.5) / f32(u.resolution.y) * 2.0 - 1.0;
  let eye = camera.camera_position.xyz;
  let world = camera.inv_view_projection * vec4(ndc_x, -ndc_y, 1.0, 1.0);
  let ray = Ray(eye, normalize(world.xyz / world.w - eye));

  let hit = intersect_scene(ray);
  if (hit.t <= 0.0) {
    textureStore(guide_texture, coord, vec4(0.0));
    return;
  }
  let surface = compute_surface(ray, hit);
  textureStore(guide_texture, coord, vec4(surface.geo_normal, hit.t));
}
