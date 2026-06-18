import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  getStatusLabel,
  getModeContext,
  hasApprovedPlan,
  isReadOnlyToolCall,
  isSubagentSession,
  loadConfig,
  switchMode,
  type GateMode,
} from "./gate";

export default function (pi: ExtensionAPI) {
  let mode: GateMode = DEFAULT_CONFIG.defaultMode;
  let planDirectory: string = DEFAULT_CONFIG.planDirectory;

  // ── Helpers ────────────────────────────────────────────────────────────

  function updateStatus(ctx: ExtensionContext): void {
    const color = mode === "plan" ? "warning" : "accent";
    ctx.ui.setStatus("plan-execute", ctx.ui.theme.fg(color, getStatusLabel(mode)));
  }

  function persistState(): void {
    pi.appendEntry("plan-execute-mode", { mode });
  }

  function isTrusted(ctx: ExtensionContext): boolean {
    const fn = (ctx as unknown as { isProjectTrusted?: () => boolean }).isProjectTrusted;
    return typeof fn === "function" ? fn.call(ctx) : true;
  }

  // ── session_start ──────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Subagent sessions (in-process, spawned by @gotgenes/pi-subagents) always
    // load the parent's extensions but start with a fresh SessionManager, so
    // they have no persisted plan-execute-mode state and would otherwise fall
    // back to defaultMode (Plan) — silently blocking their write/edit calls.
    // Delegated execution is authorized by the main agent; force Build Mode.
    if (isSubagentSession(ctx as unknown as Parameters<typeof isSubagentSession>[0])) {
      mode = "execute";
      planDirectory = DEFAULT_CONFIG.planDirectory;
      updateStatus(ctx);
      // Stay quiet in subagent sessions (no notify spam in their headless runs).
      return;
    }

    // (Re)load config each session so edits to .pi/plan-execute.json take effect.
    const config = loadConfig(ctx.cwd, isTrusted(ctx));
    planDirectory = config.planDirectory;

    // Restore persisted state from session entries; fall back to configured default.
    const entries = ctx.sessionManager.getEntries();
    const saved = entries
      .filter((e) => (e as { customType?: string }).customType === "plan-execute-mode")
      .pop() as { data?: { mode?: string } } | undefined;

    if (saved?.data?.mode === "execute" || saved?.data?.mode === "plan") {
      mode = saved.data.mode as GateMode;
    } else {
      mode = config.defaultMode;
    }

    updateStatus(ctx);
    ctx.ui.notify(
      `pi-plan-execute-gate: ${mode === "plan" ? "Plan Mode (read-only)" : "Build Mode (full access)"}`,
      "info",
    );
  });

  // ── tool_call: block writes in Plan Mode ───────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    const input = (event as unknown as { input?: Record<string, unknown> }).input;
    if (
      mode === "plan" &&
      !isReadOnlyToolCall(event.toolName, input, { cwd: ctx.cwd, planDirectory })
    ) {
      updateStatus(ctx);
      return {
        block: true,
        reason: `Plan Mode: "${event.toolName}" is blocked. Only read/search tools, subagent delegations (any type), and direct writes under ${planDirectory}/ are allowed. Ask the user to run /execute to switch to Build Mode (requires a .md file in ${planDirectory}/).`,
      };
    }
  });

  // ── before_agent_start: inject mode context each turn ─────────────────

  pi.on("before_agent_start", async () => {
    return {
      message: {
        customType: "plan-execute-context",
        content: getModeContext(mode, planDirectory),
        display: false,
      },
    };
  });

  // ── Commands ───────────────────────────────────────────────────────────

  pi.registerCommand("plan", {
    description: "Switch to Plan Mode (read-only tools only)",
    handler: async (_args, ctx) => {
      mode = "plan";
      persistState();
      updateStatus(ctx);
      ctx.ui.notify("Plan Mode active — read-only tools only.", "info");
    },
  });

  pi.registerCommand("execute", {
    description: "Switch to Build Mode (all tools, requires an approved plan in the plan directory)",
    handler: async (_args, ctx) => {
      const result = switchMode(mode, "execute", hasApprovedPlan(ctx.cwd, planDirectory));
      if (result.success) {
        mode = result.newMode;
        persistState();
      }
      updateStatus(ctx);
      if (result.success) {
        ctx.ui.notify("Build Mode active — all tools available.", "info");
      } else {
        ctx.ui.notify(result.reason || "Cannot switch to Build Mode.", "warning");
      }
    },
  });
}
