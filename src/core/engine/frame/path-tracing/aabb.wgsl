// Ray-AABB intersection (slab test)

struct SlabResult { hit: bool, t_near: f32 }

fn intersect_aabb(ray: Ray, bmin: vec3<f32>, bmax: vec3<f32>, t_min: f32, t_max: f32) -> SlabResult {
  var tn = t_min;
  var tf = t_max;

  // X slab
  if (abs(ray.direction.x) > 1e-12) {
    let id = 1.0 / ray.direction.x;
    var t0 = (bmin.x - ray.origin.x) * id;
    var t1 = (bmax.x - ray.origin.x) * id;
    if (id < 0.0) { let tmp = t0; t0 = t1; t1 = tmp; }
    tn = max(tn, t0); tf = min(tf, t1);
  } else if (ray.origin.x < bmin.x || ray.origin.x > bmax.x) {
    return SlabResult(false, tn);
  }

  // Y slab
  if (tn <= tf && abs(ray.direction.y) > 1e-12) {
    let id = 1.0 / ray.direction.y;
    var t0 = (bmin.y - ray.origin.y) * id;
    var t1 = (bmax.y - ray.origin.y) * id;
    if (id < 0.0) { let tmp = t0; t0 = t1; t1 = tmp; }
    tn = max(tn, t0); tf = min(tf, t1);
  } else if (tn <= tf && (ray.origin.y < bmin.y || ray.origin.y > bmax.y)) {
    return SlabResult(false, tn);
  }

  // Z slab
  if (tn <= tf && abs(ray.direction.z) > 1e-12) {
    let id = 1.0 / ray.direction.z;
    var t0 = (bmin.z - ray.origin.z) * id;
    var t1 = (bmax.z - ray.origin.z) * id;
    if (id < 0.0) { let tmp = t0; t0 = t1; t1 = tmp; }
    tn = max(tn, t0); tf = min(tf, t1);
  } else if (tn <= tf && (ray.origin.z < bmin.z || ray.origin.z > bmax.z)) {
    return SlabResult(false, tn);
  }

  return SlabResult(tn <= tf, tn);
}
