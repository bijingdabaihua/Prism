# 代码规范

Prism 项目 TypeScript / WGSL 代码规范。所有 AI 生成的代码必须遵守。

## TypeScript

### 导入

- 项目内全部用相对路径
- type-only import 放最前面

### 类设计

- 所有成员显式标注 `public` / `private`，不允许省略
- 禁止 getter/setter，全部用普通方法（`width()` 而非 `get width()`）

### 类成员顺序

越开放越靠前，严格按以下顺序排列：

```
public static
public 属性
public readonly
private 属性
private readonly
constructor
public 方法
private 方法
```

**属性区规则：**
- 属性之间不允许空行
- 不同可见性分组（public / public readonly / private / private readonly）之间也不允许空行
- 整个属性区从上到下是连续的，中间不插入空行

**方法区规则：**
- 方法体必须展开换行，即使只有一行 return 也不允许单行写法
  ```typescript
  // ❌ 错误
  public width(): number { return this.w; }

  // ✅ 正确
  public width(): number {
    return this.w;
  }
  ```
- 方法之间必须有空行分隔

### 文件内顺序

- 主类放在文件最前面（import 之后）
- 工具函数和其他类型声明放到类的后面

### 注释

- 只在关键逻辑处写简短注释
- 禁止装饰性分隔线（`// ----`、`// ====` 等）、ASCII 结构框
- 禁止重复代码已表达内容的注释
- 改完自查

## WGSL

- 变量/函数名使用 `snake_case`
- 结构体名使用 `PascalCase`
