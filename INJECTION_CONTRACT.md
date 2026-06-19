# Extension Injection Contract

> Status: documented contract for current extensions (no code changes).
> Purpose: make the implicit system-prompt / message / steering injection order
> and channel choices explicit, so that package reordering in `settings.json`
> and future extension additions (e.g. pi-roles) don't silently break context.

This document lives in `pi-plan-execute-gate` because it is the extension that
defines the shared session-mode primitives (`isSubagentSession`, Plan/Build mode)
that other extensions' injection behavior depends on. It is a cross-package
contract, not internal to this package.

---

## 1. The three injection channels

Pi offers three distinct channels for putting context in front of the agent.
They differ in lifecycle and visibility — choosing one is a semantic decision,
not stylistic.

| Channel | How | Lifecycle | Visibility | Used by |
|---|---|---|---|---|
| **A. systemPrompt** | `before_agent_start` handler returns `{ systemPrompt: event.systemPrompt + X }` | Persistent every turn | Base system prompt | pi-goal, pi-memory |
| **B. message** | `before_agent_start` handler returns `{ message: ... }` | Current turn | In-context message | pi-plan-execute-gate |
| **C. sendMessage (steering)** | `pi.sendMessage(...)` async | Async interjection | Session history | pi-event-reminders, pi-auto-fix-loop (failure injection) |

### Why three channels (do not "unify" blindly)

- **A (systemPrompt)** is for context the agent must always see: governance,
  memories. High token cost, always-on.
- **B (message)** is for transient per-turn context: current mode label.
  Lower cost, doesn't bloat the base prompt.
- **C (sendMessage)** is for **asynchronous, event-driven** injection that
  must enter session history as a distinct steering event (e.g. a failure
  surfaced mid-turn, a reminder fired after evaluating state). It is
  intentionally *not* a systemPrompt append — pi-event-reminders' comment
  documents this: reminders should live in session history, not be re-sent
  every turn as a persistent prompt.

**Rule:** do not collapse C into A/B. The channel difference encodes real
semantic intent (always-on vs transient vs async-event). A future
"context orchestrator" extension is explicitly **out of scope** (YAGNI) until
the number of before_agent_start injectors grows beyond current count and
collisions are observed.

---

## 2. before_agent_start execution order

**Mechanism (verified pi 0.79.8):** `before_agent_start` is a **serial pipe**,
not concurrent. Handlers run in extension-load order (= `settings.json`
`packages` array order). Each handler receives the `systemPrompt` as modified
by the previous handler; returning `{ systemPrompt }` **replaces** (most
handlers append), returning `{ message }` **appends** to a messages array.

Only two extensions modify `systemPrompt`, both with append semantics
(`event.systemPrompt + "\n\n" + ownContent`), so there is no overwrite conflict
today. Final base prompt composition:

```
[pi base prompt]
  + [pi-goal governance]        ← appends
  + [pi-memory L1 memories]    ← appends
```

### Current order (settings.json packages array, git: SilentMoebuta entries)

| # | Extension | Channel | What it injects |
|---|---|---|---|
| 1 | pi-goal | A | Goal governance rules (only when a goal is active) |
| 2 | pi-memory | A | Top L1 memories |
| 3 | pi-plan-execute-gate | B | Mode context (Plan/Build label) |
| 4 | pi-auto-fix-loop | — | (no injection; only resets RetryState) |
| 5 | pi-event-reminders | C | Reminders via sendMessage (conditional) |

### Ordering rationale

- **pi-goal before pi-memory:** governance rules are higher-priority framing
  than memories; the agent should see "you are chasing goal X" before
  recalling prior facts. If a memory contradicts active goal governance, the
  goal framing should already be in place.
- **pi-plan-execute-gate as message (not systemPrompt):** the Plan/Build mode
  is a transient session state, not always-on framing — correct as channel B.
- **pi-auto-fix-loop position irrelevant to prompt:** it only resets state
  here; its real work is on `tool_result` (channel C on failure).

### Reordering warning

If you reorder `packages` in `settings.json`, the pi-goal ↔ pi-memory
systemPrompt append order flips. There is no code dependency on this order,
but the agent's behavior may shift subtly (which framing lands first). **Do
not reorder without re-reading this section.**

---

## 3. session_start handlers (no prompt injection, state init only)

Five extensions listen to `session_start` for state initialization, not
prompt injection: pi-goal (reconstruct goal state), pi-plan-execute-gate
(load config), pi-hooks-system (load hooks config), pi-auto-fix-loop
(create RetryState), pi-event-reminders (create ReminderState).

Order is irrelevant here — each initializes independent state. No contract
needed beyond "don't depend on another extension's session_start side
effect."

---

## 4. Future: pi-roles subagent sessions

When `pi-roles` lands, role-scoped subagent sessions will be spawned via
`createAgentSession` with `parentSession` set. **Critical boundary:** a
subagent session is a single-extension-controlled clean environment —
`resources_discover` + that session's own `before_agent_start` are driven
by pi-roles alone. The main-session injection chaos documented here does
**not** propagate into subagent sessions, provided we decide subagent
sessions load a restricted extension set (not the full main-session
extension stack). That decision is tracked separately in the pi-roles
design doc, not here.

---

## 5. Revision protocol

When adding/removing/reordering a before_agent_start injector:
1. Update the table in §2 with channel + what it injects.
2. State the ordering rationale (why before/after its neighbor).
3. If a new channel is introduced, justify why A/B/C don't cover it.

This contract is documentation-only. No code enforces it — discipline +
review enforce it.
