# 贴图资产

全部来自 [Poly Haven](https://polyhaven.com)，**CC0**（可商用、无需署名）。
这里记录来源，便于追溯和替换。

贴图管线要求每张图正好 1024×1024（见
`src/engine/model/material/texture/texture-set.ts`），所以一律取 1K 版本。
法线图用 PNG，颜色和粗糙度用 JPEG 控制体积。

| 目录 | 来源 | 用途 |
|---|---|---|
| `forest_ground_06/` | https://polyhaven.com/a/forest_ground_06 | 夯实的砂土夹碎石：`.blend` + `textures/`（diff / rough / normal / disp） |

`forest_ground_06/` 收的是作者在 Blender 里实际在用的那份 `.blend`，不是
Poly Haven 同步导出的 `.gltf` / `.mtlx`：glTF 的材质模型里没有位移，Midlevel
和 Scale 只能手抄进 `extras`；`.mtlx` 有位移节点但没有 Midlevel，而且官方给
的 `scale="0.01"` 和 `.blend` 里的 0.05 对不上。`.blend` 是唯一一处两个数都在、
且和作者视图一致的地方。解析见 `src/config/blend.ts`。

模型自带的贴图不放在这里，跟模型放在一起（`assets/model/<名字>/textures/`），
由 glTF 导入器按文件里的相对路径去取。
