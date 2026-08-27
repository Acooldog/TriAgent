# 贡献指南

感谢你对 TriAgent 的关注和贡献！

---

## 提交 Pull Request

1. Fork 本仓库并创建你的分支：`git checkout -b feature/your-feature`
2. 保持代码风格一致：遵循现有架构的 SOLID 原则
3. 代码行数限制：单个文件不超过 300 行；子文件夹超过 7 个文件必须拆分
4. 添加测试：新增功能必须附带对应测试
5. 更新文档：涉及变更的 README/CODE_OF_CONDUCT 等文档需同步更新
6. 通过 CI 检查：确保 TypeScript 类型检查和 Python 语法检查通过
7. 双轴评审：提交前完成 Standard（代码规范）+ Spec（需求覆盖）双轴评审

## 代码规范

### TypeScript

- 严格模式开启，不使用 `any` 除非有充分理由
- 优先使用 `interface` 而非 `type` 定义对象类型
- 异步操作必须使用 `async/await`
- 错误处理使用统一的错误类型（ErrorResult）
- 所有 Hooks 必须以 `use` 开头
- 组件函数名使用 PascalCase，变量/函数使用 camelCase

### Python

- 遵循 PEP 8 风格指南
- 使用 `from __future__ import annotations` 延迟类型注解
- 所有公共函数必须有完整的 docstring
- 使用类型注解，不使用 `Any` 除非必要
- 使用 `pathlib.Path` 而非 `os.path`
- 异常处理不使用裸 `except:`

### 架构约束

- **前端三层架构**：Presentation -> Application -> Infrastructure，严格单向依赖
- **后端六边形架构**：Port（接口）-> Adapter（实现），Application 层只依赖 Port
- **SOLID 原则**：
  - 单一职责：每个类/模块只有一个变更原因
  - 开闭原则：对扩展开放，对修改关闭
  - 里氏替换：子类可以替换父类使用
  - 接口隔离：客户端不应该依赖它不需要的接口
  - 依赖倒置：高层模块不依赖低层模块，都依赖抽象

### 工具系统约束

- 所有工具必须通过 `ToolManifest` v1 协议注册
- 工具输入/输出必须声明 JSON Schema
- 敏感操作（删除文件、网络请求等）必须声明权限级别
- 工具实现必须可取消（cancellation = true）
- 工具必须设置合理的超时时间

## Issue 分类

- Bug 报告：请附上复现步骤、期望行为、实际行为、日志
- 功能建议：请先阅读 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) 的相关规定

## 评审流程

1. **自审**：提交前自行完成一轮完整的代码审查
2. **双轴评审**：作者将从两个维度评审：
   - **Standard 轴**：代码规范、架构符合度、SOLID 原则、代码行数限制等
   - **Spec 轴**：需求覆盖度、功能正确性、边界条件处理、性能影响等
3. **反馈与修改**：根据评审意见修改，修改后回复评审者
4. **合并**：评审通过后由作者合并

## 提交前检查清单

- [ ] 代码遵循 SOLID 原则
- [ ] 单个文件不超过 300 行
- [ ] 子文件夹文件数不超过 7 个（超过需拆分子文件夹）
- [ ] TypeScript 类型检查通过
- [ ] Python 语法检查通过
- [ ] 新增功能有对应测试
- [ ] 公共 API 有文档字符串
- [ ] README/相关文档已同步更新
- [ ] Issue 或 Discussion 中已讨论方案（重要变更）
