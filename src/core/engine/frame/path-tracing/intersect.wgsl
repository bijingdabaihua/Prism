// Möller–Trumbore with indexed geometry (indices are absolute in merged buffers)

struct VertexData { position: vec3<f32>, normal: vec3<f32>, uv: vec2<f32>, tangent: vec4<f32> }

fn read_vertex(vertex_index: u32) -> VertexData {
  let base = vertex_index * 12u;
  return VertexData(
    vec3(geometry[base], geometry[base+1u], geometry[base+2u]),
    vec3(geometry[base+3u], geometry[base+4u], geometry[base+5u]),
    vec2(geometry[base+6u], geometry[base+7u]),
    vec4(geometry[base+8u], geometry[base+9u], geometry[base+10u], geometry[base+11u]),
  );
}

// Ray-triangle hit: t = distance along the ray, u/v = barycentric coordinates
// (reused for normal/uv interpolation in compute_surface). t = -1 = no hit.
struct TriHit { t: f32, u: f32, v: f32 }

fn intersect_triangle(ray: Ray, triangle_index: u32) -> TriHit {
  let t_offset = triangle_index * 4u;
  let i0 = triangles[t_offset];     
  let i1 = triangles[t_offset + 1u]; 
  let i2 = triangles[t_offset + 2u];
  
  let a = read_vertex(i0).position;
  let b = read_vertex(i1).position;
  let c = read_vertex(i2).position;

  let e1 = b - a; let e2 = c - a;
  let p_vector = cross(ray.direction, e2);
  let det = dot(e1, p_vector);
  // `det != det` also rejects NaN — a NaN determinant would otherwise slip past
  // the abs() threshold and poison every barycentric coordinate below.
  if (abs(det) < 1e-12 || det != det) { return TriHit(-1.0, 0.0, 0.0); }
  let inv_det = 1.0 / det;
  let t_vector = ray.origin - a;
  let u = dot(t_vector, p_vector) * inv_det;
  // `!(u >= 0.0 && u <= 1.0)` rejects NaN too (NaN fails every comparison),
  // unlike `u < 0.0 || u > 1.0` which lets a NaN barycentric slip through and
  // NaN-poison the interpolated normal downstream.
  if (!(u >= 0.0 && u <= 1.0)) { return TriHit(-1.0, 0.0, 0.0); }
  let q_vector = cross(t_vector, e1);
  let v = dot(ray.direction, q_vector) * inv_det;
  if (!(v >= 0.0 && u + v <= 1.0)) { return TriHit(-1.0, 0.0, 0.0); }
  let t = dot(e2, q_vector) * inv_det;
  if (!(t >= epsilon && t <= 1e10)) { return TriHit(-1.0, 0.0, 0.0); }
  return TriHit(t, u, v);
}
