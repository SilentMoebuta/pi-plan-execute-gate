# plan-execute-gate

双模式门控扩展 —— 在 Plan Mode（只读）与 Build Mode（全工具）之间切换，确保 Agent 先规划、后执行。

## 安装

```bash
# 复制到项目扩展目录
cp -r extensions/plan-execute-gate .pi/extensions/

# 或直接加载
pi -e extensions/plan-execute-gate/index.ts
```

## 工作原理

扩展监听 `tool_call` 事件，根据当前模式决定是否拦截写操作工具。

```
启动 → Plan Mode（只读）
         │
    /execute 命令
         │
         ▼
   检查 docs/plans/ 目录
         │
    ┌────┴────┐
    │ 存在 .md │ 不存在 .md
    │ 计划文件 │ 无计划文件
    └────┬────┘    │
         │         ▼
         │    ❌ 拒绝切换
         │    "No approved plan found in the plan directory"
         ▼
   Build Mode（全部工具可用）
         │
    /plan 命令
         │
         ▼
   返回 Plan Mode
```

### Plan Mode（规划模式）

- 允许**只读/审批工具**：`read`、`grep`、`find`、`ls`、`web_search`、`fetch_content`、`get_search_content`、`code_search`、`ask_user`、`propose_goal_draft`、`memory_search`、`memory_recall`、`memory_status`、`get_subagent_result`
- `subagent`：**一律放行**（所有类型）。spawn subagent 是主 agent 的显式委托，在隔离 session 中执行；Plan Mode 只约束主 agent 的*直接*写操作，不拦截委托执行。这样兼容 superpowers 的 `coder`/`debugger`/`researcher`/`reviewer` 等角色化 subagent 工作流（见 [subagent-driven-development](#与-superpowers-的集成)）
- `bash` 仅允许保守只读命令：`ls`、`pwd`、`rg`/`grep`、`find`（禁止 `-delete/-exec`）、`cat`、`head`、`tail`、`wc`、`git status/diff/log/show`、`codegraph status/files/query/explore/node/callers/callees/impact` 等；禁止管道、重定向、命令串联
- `write`/`edit`：**仅允许目标路径在计划目录下**（默认 `docs/plans/`），用于起草计划文档；其余写操作被拦截
- 其他写操作（危险 `bash`、`git commit`、向项目源码 `write`/`edit` 等）会被**拦截并提示原因**
- 适用于需求分析、代码探索、设计方案阶段，同时不会阻止向用户请求审批

> **为何允许向计划目录写文件？** `/execute` 需要计划目录下存在 `.md` 文件。若 Plan Mode 完全禁止写，Agent 将无法起草计划，陷入“无法写计划 → 无法切到 Build Mode”的死锁。限制写作用域到计划目录，既打破死锁又不让源码被误改。

### Build Mode（构建模式）

- **所有工具均可用**，无限制
- 切换到此模式前必须 `docs/plans/` 目录下存在至少一个 `.md` 计划文件
- 适用于编码实现、测试执行、重构操作

## 命令

| 命令 | 说明 |
|------|------|
| `/plan` | 切换到 Plan Mode（只读工具）。**随时可用**，无需条件。 |
| `/execute` | 切换到 Build Mode（全部工具）。**需要** `docs/plans/` 下至少有一个 `.md` 文件。 |

切换后状态会持久化，重启会话自动恢复上次模式。

## 状态栏

| 模式 | 状态栏显示 |
|------|-----------|
| Plan Mode | 📋 Plan |
| Build Mode | 🔧 Build |

状态栏项注册为 `plan-execute`，可在 Pi 状态栏中实时查看当前模式。配合 `pi-powerline-footer` 可将该 status key 提升为独立 segment。

此外，扩展会在每轮 `before_agent_start` 注入当前模式上下文：
- Plan Mode：说明哪些工具/只读 bash 命令可用，以及如何 `/execute`
- Build Mode：说明当前为全工具模式，并提醒继续遵循已审批计划和完成前验证

## 配置

本扩展开箱即用，无需配置文件。如需自定义，将示例配置复制到项目根目录：

```bash
cp extensions/plan-execute-gate/plan-execute.example.json .pi/plan-execute.json
```

然后按需修改 `.pi/plan-execute.json`。

### 配置项

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `defaultMode` | `"plan" \| "execute"` | `"plan"` | 会话启动时的默认模式（无持久化状态时生效） |
| `planDirectory` | `string` | `"docs/plans"` | 存放计划文档的目录路径，同时是 Plan Mode 下 `write`/`edit` 的唯一允许作用域 |

> **安全**：配置仅对**已信任项目**生效。未信任项目即使放置了 `.pi/plan-execute.json` 也会被忽略，防止恶意项目通过 `defaultMode: "execute"` 绕过门控。配置文件格式错误时回退到默认值。

> 说明：早先文档曾列出 `planModeTools` 字段，但该字段从未实现（Plan Mode 工具策略由路径作用域 + 类型白名单 + bash 命令白名单共同决定，无法用单一字符串数组表达），已移除。

## 前置条件

`/execute` 命令需要计划目录（默认 `docs/plans/`）下存在至少一个 `.md` 文件。如果不存在，切换将被拒绝并提示：

> No approved plan found in the plan directory. Create a plan first.

在 Plan Mode 下，Agent 可以直接向计划目录写 `.md` 文件来起草计划（`write`/`edit` 在该目录下被放行），写好后请用户运行 `/execute` 切换。可通过配置中的 `planDirectory` 字段自定义计划目录位置。

> 注：这里只检查“是否存在 `.md` 文件”，并不做真正的“审批”校验。所谓 approved 是工作流约定（人工确认计划内容后再 `/execute`），而非扩展强制。

## 与 Superpowers 的集成

### writing-plans（编写计划）

`writing-plans` 技能会生成计划文档到 `docs/plans/` 目录。配合本扩展的工作流：

1. 在 Plan Mode 下使用 `writing-plans` 技能制定实施计划
2. 计划文档自动落入 `docs/plans/` 目录
3. 执行 `/execute` 切换到 Build Mode 开始实施

### brainstorming（头脑风暴）

在 Plan Mode 下使用 `brainstorming` 技能进行需求讨论和架构设计，所有操作均为只读，不会误修改代码。

### hooks-system（钩子系统）

两个扩展可组合使用，形成分层防护：

- **plan-execute-gate**：模式级门控，在 Plan Mode 下拦截所有写工具
- **hooks-system**：操作级钩子，在 Build Mode 下对具体操作做精细控制（如阻止特定命令、注入提示）

组合后在 `pre_tool_use` 阶段，`plan-execute-gate` 先判断模式，未拦截的才交给 `hooks-system` 处理。

### auto-fix-loop（自动修复循环）

与 `auto-fix-loop` 完全兼容。在 Build Mode 下编辑代码后，`auto-fix-loop` 自动运行格式化 → 类型检查 → 代码检查 → 测试的流水线。由于 `auto-fix-loop` 的写操作（自动修复）是作为工具调用发出的，它们受当前模式约束 —— 即在 Plan Mode 下自动修复也会被拦截，避免意外的自动修改。

## 安全说明

- 模式状态持久化到项目条目中，跨会话保持
- Plan Mode 白名单通过 `Set` 结构 O(1) 查找，无性能开销
- 拦截提示中包含具体被阻止的工具名称和切换指引
- 切换逻辑是纯函数（`switchMode`），无副作用，易于测试

## 许可证

MIT
