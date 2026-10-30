@vertex
fn main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4<f32> {
  let position = array(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  return vec4(position[vertex_index], 0.0, 1.0);
}
