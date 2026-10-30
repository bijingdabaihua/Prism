---
name: optimize-ts
description: 全面优化 TypeScript 文件——死代码、可见性、简化、函数边界、成员排序、注释，一键搞定。
user-invocable: true
argument-hint: "[file-path]"
---

# TypeScript 代码全面优化

对一个 TypeScript 文件依次执行 6 个维度的优化，每步修改后跑 `npx tsc --noEmit` 确保通过。

## 执行顺序

```
1. 死代码      → 先删没用的
2. 可见性      → 收紧 public→private，加 readonly，去 export
3. 简化        → 去 static、展平嵌套、消冗余
4. 函数边界    → 提取纯函数 / 收拢耦合函数
5. 成员排序    → 按规范重排类成员
6. 注释        → 删废话、补必要
```

---

## 1. 死代码清理

**未使用的 import**：
- 检查每个 import 符号是否在文件中被引用（包括类型注解、值使用）
- 未使用的具名导入 → 从 import 中移除该符号
- 移除后 import 为空 → 删除整行
- `import type` 同理

```ts
// 改前
import { Vec3, Color, Mat4 } from '../other/types';
const c: Color = [1, 0, 0];

// 改后
import { Color } from '../other/types';
```

**未使用的变量**：
- 局部变量/常量声明后从未被引用 → 删除声明

**未调用的 private 方法**：
- 在整个文件中搜索方法名，仅出现在定义处 → 删除

**未使用的 private 字段**：
- 在类中搜索字段名，仅出现在声明处 → 删除

**空构造函数**：
- `constructor() {}` 或只有注释的 → 删除。但如果类是公开实例化的（外部 `new` 调用），保留。

**未使用的参数**：
- 以 `_` 开头的未使用参数 → 删除，同时更新所有调用处

**例外**：export 的公开 API 不删；生命周期方法（constructor/destroy）即使空也保留如果类被实例化。

---

## 2. 可见性与不可变性

**public → private**：
- 每个非 `private` 的实例方法，在整个 `src/` 目录下搜索方法名
- 没有任何外部调用 → 加 `private`
- 实现接口/抽象类要求的方法 → 保持，不收紧

**export → 不导出**：
- 搜索每个 `export` 符号是否被其他文件 import
- 仅在当前文件使用 → 去掉 `export`

**加 readonly**：
- 实例字段：只在构造函数中赋值，之后从未重新赋值 → 加 `readonly`
- 静态字段：从未被重新赋值 → 加 `readonly`

```ts
// 改前
private camera: Camera;
constructor(camera: Camera) { this.camera = camera; }

// 改后
private readonly camera: Camera;
```

**例��**：回调接口、模板引用的属性、故意的可变字段不处理。

---

## 3. 代码简化

**多余的 `static`**：
- `private static` 方法不访问任何 `static` 属性 → 去掉 `static`，改为普通 `private` 方法
- 调用处从 `ClassName.method()` 改为 `this.method()`

**深层嵌套 → 早返回**：
- if-else 嵌套超过 2 层 → 翻转条件，先 return/continue 处理异常情况
- 主逻辑保持在正常缩进层

```ts
// 改前
if (x !== null) {
  if (x > 0) { return 'ok'; }
  else { return 'too small'; }
} else { return 'null'; }

// 改后
if (x === null) return 'null';
if (x <= 0) return 'too small';
return 'ok';
```

**冗余中间变量**：
- 变量声明后仅用于紧接着的 `return` → 直接 return 表达式

```ts
// 改前
const result = compute(x);
return result;

// 改后
return compute(x);
```

**无意义的 else**：
- if 以 return/throw/break/continue 结尾 → 后续 else 多余

```ts
// 改前
if (err) { return null; } else { return process(data); }

// 改后
if (err) return null;
return process(data);
```

**布尔冗余**：
```ts
// 改前
if (valid === true) { ... }
return condition ? true : false;

// 改后
if (valid) { ... }
return condition;
```

**例外**：可读性优先不强行展平；有副作用的表达式不求值顺序改变。

---

## 4. 函数边界

### 方法 → 模块级函数（提取）

满足**全部**条件时，提取为模块级 `function`：
1. 方法体内无 `this.xxx`
2. 不读实例属性
3. 不调用实例方法

提取步骤：
- 把方法移出类，去掉 `static`，改为 `function`
- 如果访问了 `private static` 属性 → 属性也提升为模块级 `const`
- 类内调用从 `ClassName.method()` 改为裸 `method()`

### 跨文件迁移（提取后必检）

提取后立刻判断：**这个函数属于当前文件吗？**

不属于的信号：
- 函数的领域与文件名/类名无关（如 `linearToSRGB` 出现在 `background.ts`）
- 函数是通用工具，其他模块也可能需要（颜色转换、数学运算、字符串处理等）
- 函数可以独立描述且不提到当前模块的任何概念

属于的情况：
- 函数是当前模块领域内的辅助逻辑（如环境贴图采样之于 Background）
- 函数只在当前文件内使用且没有通用价值

迁移操作：
- 找到或创建合适的文件（如 `linearToSRGB` → `other/color.ts`）
- 移动函数定义，当前文件改为 import
- 仅被当前文件使用 → 不加 `export`；有通用价值 → 加 `export`

```ts
// 改前（background.ts 内）
function linearToSRGB(x: number): number { ... }

// 改后 — 函数移到 other/color.ts，background.ts 加 import
import { linearToSRGB } from '../other/color';
```

### 模块函数 → 类方法（收拢）

满足**任一**条件时，移入类：
1. 第一个参数是类实例，且每次都传
2. 直接操作实例的字段（破坏封装）
3. 只被该类使用，无独立复用价值

```ts
// 改前
function getBounds(mesh: Mesh): Bounds { return new Bounds(mesh.min, mesh.max); }

// 改后 → 移到 Mesh 类中
class Mesh {
  getBounds(): Bounds { return new Bounds(this.min, this.max); }
}
```

**例外**：仅被类内一个方法调用一次的辅助方法保留不动；提取会破坏封装（要求 private→public）的不提取。

---

## 5. 类成员排序

按以下顺序重排：

```
1. static 属性
2. static readonly 属性
3. static 方法
4. static async 方法
5. 实例属性（public, 无 readonly）
6. readonly 实例属性（public, 有 readonly）
7. 实例属性（private）
8. readonly 实例属性（private）
9. constructor
10. getter / setter
11. public 方法
12. public async 方法
13. private 方法
14. private async 方法
```

**排序原则**：越开放越靠上（public → private），相同开放级别时修饰符越少越靠上（如 `public` 方法在 `public async` 方法前面，`public` 字段在 `public readonly` 字段前面）。

**细节**：
- **同类型成员之间不加空行** — 属性之间连续排列，方法之间连续排列。只在字段区 ↔ 方法区之间、不同可见性组之间加一个空行
- 同组内不强制排序，除非有明显使用顺序
- **不要加装饰性分隔注释**（如 `// Public API`、`// Lifecycle`）。代码自身的结构（`readonly`、`private`、方法名）已经说明了组的含义
- `destroy()` 放在最后
- private 工具方法放在对应公开方法后面，不单独分组
- `private` 字段与 getter 冲突时用 `_` 后缀：`private _running` ↔ `get running()`
- `device` 的私有字段用 `private device_: GPUDevice` ↔ `get device`

---

## 6. 注释

核心原则：**注释解释「为什么」，不解释「做什么」**。代码本身说明做了什么，好的命名胜过注释。

**删（优先）**：
- 仅重复代码的注释（`// Set x to 1` `x = 1`）
- **装饰性分隔横幅** — `// ----` + 标签（如 `// Background`、`// Readonly`、`// Public API`、`// Lifecycle`、`// Internal`）。`export class Background` 本身就说了这是 Background，`readonly` 关键字本身就说了这是只读字段，`private` 本身就说了这是内部方法。这些横幅纯属噪音，全部删除
- 自解释方法的冗余 JSDoc（getter/setter 不需要 `/** Returns the name */`）
- 注释掉的代码（无 TODO/FIXME 的不保留）
- 过时/与代码不一致的注释

**补（克制）**：
- export 类/方法名称不足以说明用途时 → 一行 JSDoc
- 非显而易见的逻辑 → 一行注释解释「为什么」
- TODO/FIXME 格式：`// TODO(user): 做什么，为什么现在不做`

```ts
// ✅ 名称自解释 — 不加 JSDoc
export class Background { }
get device(): GPUDevice { return this.device_; }

// ✅ 名称不够 — 加一句
/** Load an equirectangular environment map (EXR or ImageBitmap). */
async load(url: string): Promise<void> { ... }

// ✅ 非显然逻辑 — 解释为什么
// HDR skies need >1 exposure to look bright in LDR
const exposure = 3.0;
```

**不补**：private 方法、简单 getter/setter、参数列表 `@param`/`@returns`（除非真需要解释）。

---

## 完成后

- 运行 `npx tsc --noEmit`，确保零错误
- 按 1-6 维度简要报告：每一步做了什么改动，没有改动则说"跳过"
