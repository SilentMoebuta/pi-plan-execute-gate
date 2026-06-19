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
  // `mode` is keyed by session id so an in-process subagent's session_start
  // (which forces Build Mode) cannot clobber the parent's persisted Plan Mode
  // held in this same closure. `planDirectory` is cwd-derived and shared
  // across parent/subagent (same project); the subagent path never mutates it.
  const modeBySession = new Map<string, GateMode>();
  let planDirectory: string = DEFAULT_CONFIG.planDirectory;

  function sessionId(ctx: ExtensionContext): string {
    const sm = ctx.sessionManager as unknown as { getSessionId?: () => string };
    return (typeof sm.getSessionId === "function" && sm.getSessionId()) || "default";
  }

  function currentMode(ctx: ExtensionContext): GateMode {
    return modeBySession.get(sessionId(ctx)) ?? DEFAULT_CONFIG.defaultMode;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  function updateStatus(ctx: ExtensionContext): void {
    const mode = currentMode(ctx);
    const color = mode === "plan" ? "warning" : "accent";
    ctx.ui.setStatus("plan-execute", ctx.ui.theme.fg(color, getStatusLabel(mode)));
  }

  function persistState(ctx: ExtensionContext): void {
    pi.appendEntry("plan-execute-mode", { mode: currentMode(ctx) });
  }

  function isTrusted(ctx: ExtensionContext): boolean {
    const fn = (ctx as unknown as { isProjectTrusted?: () => boolean }).isProjectTrusted;
    return typeof fn === "function" ? fn.call(ctx) : true;
  }

  // ── session_start ──────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const id = sessionId(ctx);
    // Subagent sessions (in-process, spawned by @gotgenes/pi-subagents) always
    // load the parent's extensions but start with a fresh SessionManager, so
    // they have no persisted plan-execute-mode state and would otherwise fall
    // back to defaultMode (Plan) — silently blocking their write/edit calls.
    // Delegated execution is authorized by the main agent; force Build Mode
    // for THIS session id only — the parent's entry in modeBySession is left
    // untouched so it survives the subagent run even if session_start does
    // not re-fire for the parent on return.
    if (isSubagentSession(ctx as unknown as Parameters<typeof isSubagentSession>[0])) {
      modeBySession.set(id, "execute");
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

    let restored: GateMode;
    if (saved?.data?.mode === "execute" || saved?.data?.mode === "plan") {
      restored = saved.data.mode as GateMode;
    } else {
      restored = config.defaultMode;
    }
    modeBySession.set(id, restored);

    updateStatus(ctx);
    // Notify only when not the default (Build). The default Build Mode is
    // silent so the gate stays out of the way for users who never opt into
    // Plan Mode; a persisted non-default mode (Plan, or restored Plan) is
    // worth surfacing.
    if (restored !== DEFAULT_CONFIG.defaultMode) {
      ctx.ui.notify(
        `pi-plan-execute-gate: ${restored === "plan" ? "Plan Mode (read-only)" : "Build Mode (full access)"}`,
        "info",
      );
    }
  });

  // ── tool_call: block writes in Plan Mode ───────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    const input = (event as unknown as { input?: Record<string, unknown> }).input;
    const mode = currentMode(ctx);
    if (
      mode === "plan" &&
      !isReadOnlyToolCall(event.toolName, input, { cwd: ctx.cwd, planDirectory })
    ) {
      updateStatus(ctx);
      return {
        block: true,
        reason: `Plan Mode: "${event.toolName}" is blocked. Only read/search tools, spawn_role delegations (any role), and direct writes under ${planDirectory}/ are allowed. Ask the user to run /execute to switch to Build Mode.`,
      };
    }
  });

  // ── before_agent_start: inject mode context each turn ─────────────────

  pi.on("before_agent_start", async (_event, ctx) => {
    return {
      message: {
        customType: "plan-execute-context",
        content: getModeContext(currentMode(ctx), planDirectory),
        display: false,
      },
    };
  });

  // ── Commands ───────────────────────────────────────────────────────────

  pi.registerCommand("plan", {
    description: "Switch to Plan Mode (read-only tools only)",
    handler: async (_args, ctx) => {
      modeBySession.set(sessionId(ctx), "plan");
      persistState(ctx);
      updateStatus(ctx);
      ctx.ui.notify("Plan Mode active — read-only tools only.", "info");
    },
  });

  pi.registerCommand("execute", {
    description: "Switch to Build Mode (all tools available)",
    handler: async (_args, ctx) => {
      // /execute is unconditional by default. superpowers users can opt into
      // the strict plan-first gate via .pi/plan-execute.json:
      // { "requirePlanForExecute": true }
      const requirePlan = loadConfig(ctx.cwd, isTrusted(ctx)).requirePlanForExecute === true;
      const hasPlan = !requirePlan || hasApprovedPlan(ctx.cwd, planDirectory);
      const result = switchMode(currentMode(ctx), "execute", hasPlan);
      if (result.success) {
        modeBySession.set(sessionId(ctx), result.newMode);
        persistState(ctx);
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
