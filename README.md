# pi-plan-execute-gate

双模式门控扩展 —— 在 Plan Mode（只读）与 Build Mode（全工具）之间切换，确保 Agent 先规划、后执行。

## 安装

```bash
pi install git:github.com/SilentMoebuta/pi-plan-execute-gate
```

> 旧的手动复制（`cp -r`）与 `pi -e` 加载方式已废弃，请使用上面的包安装。

## 工作原理

扩展监听 `tool_call` 事件，根据当前模式决定是否拦截写操作工具。

**默认行为：Build Mode（全工具）。** 装了本扩展不会改变 pi 的默认行为——开 session / spawn subagent 默认都是 Build Mode，用户不受任何限制。只有显式 `/plan` 才进入只读模式。

```
启动 → Build Mode（默认，全工具）
         │
    /plan 命令（opt-in 只读）
         ▼
   Plan Mode（只读）
         │
    /execute 命令
         ├─ 默认：无条件切回 Build Mode
         └─ 若 .pi/plan-execute.json 设 {"requirePlanForExecute": true}：
            需 docs/plans/ 有 .md 才切（superpowers 严格门）
         ▼
   Build Mode
```

### Plan Mode（规划模式）

- 允许**只读/审批工具**：`read`、`grep`、`find`、`ls`、`web_search`、`fetch_content`、`get_search_content`、`code_search`、`ask_user`、`propose_goal_draft`、`memory_search`、`memory_recall`、`memory_status`
- `spawn_role`：**一律放行**（所有角色）。pi-roles 的 `spawn_role` 是主 agent 的显式委托，在前台隔离 session 中执行并直接返回结果；Plan Mode 只约束主 agent 的*直接*写操作，不拦截委托执行。这样兼容 superpowers 的 `coder`/`debugger`/`researcher`/`reviewer` 等角色化工作流（见 [subagent-driven-development](#与-superpowers-的集成)）
- `bash` 仅允许保守只读命令：`ls`、`pwd`、`rg`/`grep`、`find`（禁止 `-delete/-exec`）、`cat`、`head`、`tail`、`wc`、`tree`、`echo`/`printf`、`test`、`stat`、`which`、`file`、`du`、`df`、`git status/diff/log/show`、`git branch -v/-a/-r`（参数级判别，拦 `-D/-d/-m`）、`git remote -v/show`、`git tag`/`-l`、`git config --get/-l`、`codegraph status/files/query/explore/node/callers/callees/impact` 等；禁止管道、重定向、命令串联
- `write`/`edit`：允许目标路径在 **任一工作流文档目录** 下（`docs/plans/`、`docs/research/`、`docs/reviews/`、`docs/specs/`），用于起草计划/研究/评审/规格文档；其余写操作被拦截
- 其他写操作（危险 `bash`、`git commit`、向项目源码 `write`/`edit` 等）会被**拦截并提示原因**
- 适用于需求分析、代码探索、设计方案阶段，同时不会阻止向用户请求审批

> **为何允许向工作流文档目录写文件？** Plan Mode 下若用户想起草计划，需要能写 `.md`。限制写作用域到工作流文档目录（plans/research/reviews/specs），既让 Plan Mode 能起草计划又不让源码被误改。注：这是 Plan Mode 的限制；默认 Build Mode 下写入不受限。

### Build Mode（构建模式）

- **所有工具均可用**，无限制
- 切换到此模式后所有工具可用（默认）。若 `.pi/plan-execute.json` 设了 `"requirePlanForExecute": true`，则需 `docs/plans/` 下存在 `.md` 才能切换（superpowers 严格门，opt-in）
- 适用于编码实现、测试执行、重构操作

## 命令

| 命令 | 说明 |
|------|------|
| `/plan` | 切换到 Plan Mode（只读工具）。**随时可用**，无需条件。 |
| `/execute` | 切换到 Build Mode（全部工具）。**默认无条件**；若设了 `requirePlanForExecute: true` 才需 `docs/plans/` 有 `.md`。 |

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
cp extensions/pi-plan-execute-gate/plan-execute.example.json .pi/plan-execute.json
```

然后按需修改 `.pi/plan-execute.json`。

### 配置项

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `defaultMode` | `"plan" \| "execute"` | `"execute"` | 会话启动时的默认模式（无持久化状态时生效）。默认 Build，不强制规划。 |
| `planDirectory` | `string` | `"docs/plans"` | 存放计划文档的目录路径，同时是 Plan Mode 下 `write`/`edit` 的唯一允许作用域 |
| `requirePlanForExecute` | `boolean` | `false` | `true` 时 `/execute` 需 `planDirectory` 下有 `.md`（superpowers 严格门）。默认 `false`：`/execute` 无条件切 Build，不绑定任何工作流。 |

> **安全**：配置仅对**已信任项目**生效。未信任项目即使放置了 `.pi/plan-execute.json` 也会被忽略，回退到默认（Build Mode）。配置文件格式错误时回退到默认值。

> 说明：早先文档曾列出 `planModeTools` 字段，但该字段从未实现（Plan Mode 工具策略由路径作用域 + 类型白名单 + bash 命令白名单共同决定，无法用单一字符串数组表达），已移除。

## superpowers 工作流用户迁移

本扩展曾经默认 Plan Mode 且 `/execute` 强制要求 `docs/plans/*.md`（隐式绑定 superpowers 工作流）。现已改为默认 Build、`/execute` 无条件。若你想恢复原有的 superpowers 严格门（强制先写计划再执行），在项目根创建 `.pi/plan-execute.json`：

```json
{
  "defaultMode": "plan",
  "requirePlanForExecute": true
}
```

这样 session 启动即 Plan Mode，且 `/execute` 需 `docs/plans/` 下有 `.md` 才切换——与 superpowers 的 HARD-GATE 工作流一致。

## 前置条件

**无。** 默认 Build Mode，开箱即用，不强制任何工作流。

仅当用户主动 `/plan` 进入只读模式后，Plan Mode 的限制（write/edit 限工作流文档目录、bash 只读白名单）才生效。若再设 `requirePlanForExecute: true`，则 `/execute` 需 `docs/plans/` 下有 `.md`（superpowers 工作流的审批门）。

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

- **pi-plan-execute-gate**：模式级门控，在 Plan Mode 下拦截所有写工具
- **hooks-system**：操作级钩子，在 Build Mode 下对具体操作做精细控制（如阻止特定命令、注入提示）

组合后在 `pre_tool_use` 阶段，`pi-plan-execute-gate` 先判断模式，未拦截的才交给 `hooks-system` 处理。

### auto-fix-loop（自动修复循环）

与 `auto-fix-loop` 完全兼容。在 Build Mode 下编辑代码后，`auto-fix-loop` 自动运行格式化 → 类型检查 → 代码检查 → 测试的流水线。由于 `auto-fix-loop` 的写操作（自动修复）是作为工具调用发出的，它们受当前模式约束 —— 即在 Plan Mode 下自动修复也会被拦截，避免意外的自动修改。

## 安全说明

- 模式状态持久化到项目条目中，跨会话保持
- Plan Mode 白名单通过 `Set` 结构 O(1) 查找，无性能开销
- 拦截提示中包含具体被阻止的工具名称和切换指引
- 切换逻辑是纯函数（`switchMode`），无副作用，易于测试

## 许可证

MIT
