import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  DEFAULT_CONFIG,
  hasApprovedPlan,
  isPlanPath,
  isReadOnlyTool,
  isReadOnlyToolCall,
  isSubagentSession,
  isWorkflowDocPath,
  switchMode,
  getStatusLabel,
  getModeContext,
  loadConfig,
} from "../gate";

// ---------------------------------------------------------------------------
// hasApprovedPlan
// ---------------------------------------------------------------------------
describe("hasApprovedPlan", () => {
  it("returns false when docs/plans/ directory does not exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-"));
    try {
      assert.equal(hasApprovedPlan(tmp), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns false when docs/plans/ exists but has no .md files", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-"));
    try {
      fs.mkdirSync(path.join(tmp, "docs", "plans"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "docs", "plans", "notes.txt"), "hello");
      assert.equal(hasApprovedPlan(tmp), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns true when docs/plans/ has at least one .md file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-"));
    try {
      fs.mkdirSync(path.join(tmp, "docs", "plans"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "docs", "plans", "design.md"), "# plan");
      assert.equal(hasApprovedPlan(tmp), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns false for nonexistent path (error handling)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-"));
    try {
      const nonexistent = path.join(tmp, "definitely-does-not-exist");
      assert.equal(hasApprovedPlan(nonexistent), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("honors a custom planDirectory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-"));
    try {
      fs.mkdirSync(path.join(tmp, "specs", "plans"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "specs", "plans", "p.md"), "# p");
      assert.equal(hasApprovedPlan(tmp, "specs/plans"), true);
      assert.equal(hasApprovedPlan(tmp, "docs/plans"), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// isReadOnlyTool
// ---------------------------------------------------------------------------
describe("isReadOnlyTool", () => {
  it("returns true for known read-only tools", () => {
    for (const name of [
      "read", "grep", "find", "ls",
      "web_search", "fetch_content", "get_search_content", "code_search",
      "ask_user", "propose_goal_draft",
      "memory_search", "memory_recall", "memory_status",
      "get_subagent_result",
    ]) {
      assert.equal(isReadOnlyTool(name), true, name);
    }
  });

  it("returns false for write-capable tools", () => {
    assert.equal(isReadOnlyTool("write"), false);
    assert.equal(isReadOnlyTool("edit"), false);
    assert.equal(isReadOnlyTool("bash"), false);
    assert.equal(isReadOnlyTool("subagent"), false);
  });

  it("returns false for unknown / empty names", () => {
    assert.equal(isReadOnlyTool("nonexistent_tool"), false);
    assert.equal(isReadOnlyTool(""), false);
  });
});

// ---------------------------------------------------------------------------
// isPlanPath
// ---------------------------------------------------------------------------
describe("isPlanPath", () => {
  const cwd = "/project";

  it("allows relative paths under the plan directory", () => {
    assert.equal(isPlanPath("docs/plans/foo.md", cwd, "docs/plans"), true);
    assert.equal(isPlanPath("docs/plans/sub/bar.md", cwd, "docs/plans"), true);
  });

  it("allows absolute paths under the plan directory", () => {
    assert.equal(isPlanPath("/project/docs/plans/x.md", cwd, "docs/plans"), true);
  });

  it("rejects paths outside the plan directory", () => {
    assert.equal(isPlanPath("src/index.ts", cwd, "docs/plans"), false);
    assert.equal(isPlanPath("README.md", cwd, "docs/plans"), false);
    assert.equal(isPlanPath("../evil.md", cwd, "docs/plans"), false);
    assert.equal(isPlanPath("/etc/passwd", cwd, "docs/plans"), false);
  });

  it("rejects path traversal that escapes the plan directory", () => {
    assert.equal(isPlanPath("docs/plans/../../etc/passwd", cwd, "docs/plans"), false);
  });
});

// ---------------------------------------------------------------------------
// switchMode
// ---------------------------------------------------------------------------
describe("switchMode", () => {
  it("plan → plan is no-op success", () => {
    const result = switchMode("plan", "plan", false);
    assert.equal(result.success, true);
    assert.equal(result.newMode, "plan");
    assert.equal(result.reason, undefined);
  });

  it("plan → execute with plan exists → success", () => {
    const result = switchMode("plan", "execute", true);
    assert.equal(result.success, true);
    assert.equal(result.newMode, "execute");
    assert.equal(result.reason, undefined);
  });

  it("plan → execute without plan → fail with reason", () => {
    const result = switchMode("plan", "execute", false);
    assert.equal(result.success, false);
    assert.equal(result.newMode, "plan");
    assert.ok(result.reason !== undefined);
    assert.ok(result.reason!.includes("plan"));
  });

  it("execute → plan always works", () => {
    const result = switchMode("execute", "plan", false);
    assert.equal(result.success, true);
    assert.equal(result.newMode, "plan");
    assert.equal(result.reason, undefined);
  });

  it("execute → execute is no-op even without a plan", () => {
    const result = switchMode("execute", "execute", false);
    assert.equal(result.success, true);
    assert.equal(result.newMode, "execute");
  });
});

// ---------------------------------------------------------------------------
// getStatusLabel
// ---------------------------------------------------------------------------
describe("getStatusLabel", () => {
  it('returns "📋 Plan" for plan', () => {
    assert.equal(getStatusLabel("plan"), "📋 Plan");
  });

  it('returns "🔧 Build" for execute', () => {
    assert.equal(getStatusLabel("execute"), "🔧 Build");
  });
});

// ---------------------------------------------------------------------------
// isReadOnlyToolCall
// ---------------------------------------------------------------------------
describe("isReadOnlyToolCall", () => {
  it("allows ask_user in Plan Mode so the agent can request approval", () => {
    assert.equal(isReadOnlyToolCall("ask_user"), true);
  });

  it("allows read-only memory retrieval tools in Plan Mode", () => {
    assert.equal(isReadOnlyToolCall("memory_search"), true);
    assert.equal(isReadOnlyToolCall("memory_recall"), true);
    assert.equal(isReadOnlyToolCall("memory_status"), true);
  });

  it("allows get_subagent_result (pure read)", () => {
    assert.equal(isReadOnlyToolCall("get_subagent_result", { agent_id: "x" }), true);
  });

  it("allows conservative read-only bash commands needed for code exploration", () => {
    assert.equal(isReadOnlyToolCall("bash", { command: "codegraph files" }), true);
    assert.equal(isReadOnlyToolCall("bash", { command: "git status --short" }), true);
    assert.equal(isReadOnlyToolCall("bash", { command: "rg \"foo\" extensions" }), true);
  });

  it("allows codegraph affected (read-only test-impact query)", () => {
    assert.equal(isReadOnlyToolCall("bash", { command: "codegraph affected" }), true);
    assert.equal(isReadOnlyToolCall("bash", { command: "codegraph affected src/x.ts" }), true);
  });

  it("blocks bash commands with shell chaining or write-like commands", () => {
    assert.equal(isReadOnlyToolCall("bash", { command: "rg foo .; rm -rf tmp" }), false);
    assert.equal(isReadOnlyToolCall("bash", { command: "mkdir tmp" }), false);
    assert.equal(isReadOnlyToolCall("bash", { command: "git commit -m test" }), false);
  });

  // ── write/edit path scoping ──────────────────────────────────────────

  const opts = { cwd: "/project", planDirectory: "docs/plans" };

  it("allows write under the plan directory", () => {
    assert.equal(isReadOnlyToolCall("write", { path: "docs/plans/p.md", content: "x" }, opts), true);
  });

  it("allows write under any workflow docs dir (research/reviews/specs)", () => {
    assert.equal(isReadOnlyToolCall("write", { path: "docs/research/lib.md", content: "x" }, opts), true);
    assert.equal(isReadOnlyToolCall("write", { path: "docs/reviews/auth.md", content: "x" }, opts), true);
    assert.equal(isReadOnlyToolCall("write", { path: "docs/specs/design.md", content: "x" }, opts), true);
    assert.equal(isReadOnlyToolCall("edit", { path: "docs/plans/sub/x.md", edits: [] }, opts), true);
  });

  it("allows edit under the plan directory", () => {
    assert.equal(isReadOnlyToolCall("edit", { path: "docs/plans/p.md", edits: [] }, opts), true);
  });

  it("blocks write outside the plan directory", () => {
    assert.equal(isReadOnlyToolCall("write", { path: "src/x.ts", content: "x" }, opts), false);
    assert.equal(isReadOnlyToolCall("edit", { path: "README.md", edits: [] }, opts), false);
  });

  it("blocks write/edit when cwd is unavailable (cannot resolve path)", () => {
    assert.equal(isReadOnlyToolCall("write", { path: "docs/plans/p.md" }), false);
    assert.equal(isReadOnlyToolCall("edit", { path: "docs/plans/p.md", edits: [] }), false);
  });

  // ── subagent: delegated execution is always allowed ─────────────────
  // Rationale: spawning a subagent (coder/debugger/etc.) is an explicit,
  // intentional delegation by the main agent, not an accidental write.
  // Subagents run in isolated sessions. Plan Mode constrains the main
  // agent's *direct* writes; delegated work is always authorized.

  it("allows all subagent types (delegation = authorized execution)", () => {
    for (const t of [
      "Explore", "Plan",
      "general-purpose", "coder", "debugger", "researcher", "reviewer",
    ]) {
      assert.equal(isReadOnlyToolCall("subagent", { subagent_type: t, prompt: "x" }), true, t);
    }
  });

  it("allows subagent resume (no subagent_type)", () => {
    assert.equal(isReadOnlyToolCall("subagent", { resume: "agent-1" }), true);
  });

  it("still reports subagent as non-read-only in isReadOnlyTool (delegated, not read-only)", () => {
    assert.equal(isReadOnlyTool("subagent"), false);
  });
});

// ---------------------------------------------------------------------------
// getModeContext
// ---------------------------------------------------------------------------
describe("getModeContext", () => {
  it("returns explicit Plan Mode context describing the actual policy", () => {
    const context = getModeContext("plan");
    assert.match(context, /PLAN MODE/);
    assert.match(context, /subagent.*allowed/i);     // subagent policy mentioned
    assert.match(context, /docs\/plans/);            // plan dir mentioned
    assert.match(context, /ask the user to run \/execute/); // agent cannot run commands itself
  });

  it("includes the custom plan directory when provided", () => {
    const context = getModeContext("plan", "specs/plans");
    assert.match(context, /specs\/plans/);
  });

  it("returns explicit Build Mode context", () => {
    const context = getModeContext("execute");
    assert.match(context, /BUILD MODE/);
    assert.match(context, /All tools are available/);
  });
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------
describe("loadConfig", () => {
  it("returns defaults for untrusted projects (no bypass via defaultMode)", () => {
    const cfg = loadConfig("/anywhere", false);
    assert.deepEqual(cfg, DEFAULT_CONFIG);
  });

  it("returns defaults when no config file exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cfg-"));
    try {
      const cfg = loadConfig(tmp, true);
      assert.equal(cfg.defaultMode, "execute");
      assert.equal(cfg.planDirectory, "docs/plans");
      assert.equal(cfg.requirePlanForExecute, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reads custom config for trusted projects", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cfg-"));
    try {
      fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, ".pi", "plan-execute.json"),
        JSON.stringify({ defaultMode: "execute", planDirectory: "specs/plans" }),
      );
      const cfg = loadConfig(tmp, true);
      assert.equal(cfg.defaultMode, "execute");
      assert.equal(cfg.planDirectory, "specs/plans");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("clamps invalid defaultMode to execute (the default)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cfg-"));
    try {
      fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, ".pi", "plan-execute.json"),
        JSON.stringify({ defaultMode: "bogus" }),
      );
      const cfg = loadConfig(tmp, true);
      assert.equal(cfg.defaultMode, "execute");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reads requirePlanForExecute=true for superpowers-style strict gate", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cfg-"));
    try {
      fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, ".pi", "plan-execute.json"),
        JSON.stringify({ requirePlanForExecute: true, defaultMode: "plan" }),
      );
      const cfg = loadConfig(tmp, true);
      assert.equal(cfg.requirePlanForExecute, true);
      assert.equal(cfg.defaultMode, "plan");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignores untrusted projects even when a config file exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cfg-"));
    try {
      fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, ".pi", "plan-execute.json"),
        JSON.stringify({ defaultMode: "plan" }),
      );
      const cfg = loadConfig(tmp, false);
      assert.equal(cfg.defaultMode, "execute"); // default Build; untrusted cannot force Plan either
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to defaults on malformed JSON", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cfg-"));
    try {
      fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
      fs.writeFileSync(path.join(tmp, ".pi", "plan-execute.json"), "{ not json");
      const cfg = loadConfig(tmp, true);
      assert.equal(cfg.defaultMode, "execute");
      assert.equal(cfg.planDirectory, "docs/plans");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// isWorkflowDocPath
// ---------------------------------------------------------------------------
describe("isWorkflowDocPath", () => {
  const cwd = "/project";

  it("allows paths under docs/plans, docs/research, docs/reviews, docs/specs", () => {
    assert.equal(isWorkflowDocPath("docs/plans/p.md", cwd), true);
    assert.equal(isWorkflowDocPath("docs/research/lib.md", cwd), true);
    assert.equal(isWorkflowDocPath("docs/reviews/auth.md", cwd), true);
    assert.equal(isWorkflowDocPath("docs/specs/design.md", cwd), true);
    assert.equal(isWorkflowDocPath("docs/plans/sub/deep.md", cwd), true);
  });

  it("allows absolute paths under those docs dirs", () => {
    assert.equal(isWorkflowDocPath("/project/docs/research/x.md", cwd), true);
  });

  it("rejects docs/ itself and other docs subdirs not in the allowlist", () => {
    assert.equal(isWorkflowDocPath("docs/", cwd), false);
    assert.equal(isWorkflowDocPath("docs/random.md", cwd), false);
    assert.equal(isWorkflowDocPath("docs/notes/x.md", cwd), false);
  });

  it("rejects paths outside docs entirely", () => {
    assert.equal(isWorkflowDocPath("src/index.ts", cwd), false);
    assert.equal(isWorkflowDocPath("README.md", cwd), false);
    assert.equal(isWorkflowDocPath("/etc/passwd", cwd), false);
  });

  it("rejects path traversal escaping docs", () => {
    assert.equal(isWorkflowDocPath("docs/plans/../../etc/passwd", cwd), false);
  });
});

// ---------------------------------------------------------------------------
// isSubagentSession
// ---------------------------------------------------------------------------
describe("isSubagentSession", () => {
  it("returns true when sessionManager has parentSession set (subagent)", () => {
    const ctx = { sessionManager: { getHeader: () => ({ parentSession: "parent-123" }) } };
    assert.equal(isSubagentSession(ctx), true);
  });

  it("returns false for a top-level session (no parentSession)", () => {
    const ctx = { sessionManager: { getHeader: () => ({ parentSession: undefined }) } };
    assert.equal(isSubagentSession(ctx), false);
    const ctx2 = { sessionManager: { getHeader: () => ({}) } };
    assert.equal(isSubagentSession(ctx2), false);
  });

  it("falls back to true (permissive Build Mode) when header is null", () => {
    const ctx = { sessionManager: { getHeader: () => null } };
    assert.equal(isSubagentSession(ctx), true);
  });

  it("falls back to true when getHeader throws or is missing", () => {
    const ctx = { sessionManager: { getHeader: () => { throw new Error("boom"); } } };
    assert.equal(isSubagentSession(ctx), true);
    const ctx2 = { sessionManager: null };
    assert.equal(isSubagentSession(ctx2), true);
    const ctx3 = {};
    assert.equal(isSubagentSession(ctx3 as any), true);
  });
});
