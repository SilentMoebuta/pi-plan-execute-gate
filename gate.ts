import * as fs from "node:fs";
import * as path from "node:path";

export type GateMode = "plan" | "execute";

/**
 * Read-only tools allowed in Plan Mode (no path/object restrictions).
 * Note: `subagent` is intentionally NOT here — it is handled separately in
 * isReadOnlyToolCall as a delegated-execution tool (always allowed), not a
 * read-only tool.
 */
const READ_ONLY_TOOLS = new Set([
  "read", "grep", "find", "ls",
  "web_search", "fetch_content", "get_search_content", "code_search",
  "ask_user", "propose_goal_draft",
  "memory_search", "memory_recall", "memory_status",
  "get_subagent_result",
]);

const READ_ONLY_BASH_COMMANDS = new Set([
  "ls", "pwd", "grep", "rg", "find", "cat", "head", "tail", "wc",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show",
]);

const READ_ONLY_CODEGRAPH_SUBCOMMANDS = new Set([
  "status", "files", "query", "explore", "node", "callers", "callees", "impact", "affected",
]);

const UNSAFE_SHELL_TOKENS = /(;|&&|\|\||\||>|<|`|\$\(|\n)/;

export interface PlanExecuteConfig {
  defaultMode: GateMode;
  /** Plan directory, relative to cwd. */
  planDirectory: string;
}

export const DEFAULT_CONFIG: PlanExecuteConfig = {
  defaultMode: "plan",
  planDirectory: "docs/plans",
};

function firstWords(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function isReadOnlyBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || UNSAFE_SHELL_TOKENS.test(trimmed)) return false;

  const words = firstWords(trimmed);
  const executable = words[0];
  const subcommand = words[1];

  if (READ_ONLY_BASH_COMMANDS.has(executable)) {
    if (executable === "find" && words.some((w) => w === "-delete" || w === "-exec")) return false;
    return true;
  }

  if (executable === "git") {
    return Boolean(subcommand && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand));
  }

  if (executable === "codegraph") {
    return Boolean(subcommand && READ_ONLY_CODEGRAPH_SUBCOMMANDS.has(subcommand));
  }

  return false;
}

/**
 * Directories under docs/ where read-only workflow artifacts may be drafted
 * in Plan Mode (plans, research, reviews, specs). Keeps Plan Mode able to run
 * the full superpowers planning workflow without blocking its file outputs.
 */
const READ_ONLY_DOC_DIRS = new Set(["plans", "research", "reviews", "specs"]);

/**
 * Resolve a possibly-relative path against cwd.
 */
function resolveUnder(filePath: string, cwd: string): string {
  return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath);
}

/**
 * Whether a file path lives under the plan directory.
 * Lets the agent draft plan documents while still in Plan Mode (escape hatch
 * for the plan→execute gate: otherwise the agent could never create the plan
 * required to switch modes).
 */
export function isPlanPath(filePath: string, cwd: string, planDirectory: string): boolean {
  const target = resolveUnder(filePath, cwd);
  const planAbs = resolveUnder(planDirectory, cwd);
  const rel = path.relative(planAbs, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Whether a file path lives under any read-only workflow docs directory
 * (docs/plans, docs/research, docs/reviews, docs/specs). Lets the agent draft
 * the full set of superpowers workflow artifacts (research notes, review
 * reports, specs, plans) in Plan Mode without touching project source.
 */
export function isWorkflowDocPath(filePath: string, cwd: string): boolean {
  const target = resolveUnder(filePath, cwd);
  const docsAbs = resolveUnder("docs", cwd);
  const rel = path.relative(docsAbs, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const firstSeg = rel.split(path.sep)[0];
  return READ_ONLY_DOC_DIRS.has(firstSeg);
}

/**
 * Check whether the plan directory contains at least one .md file.
 */
export function hasApprovedPlan(
  cwd: string,
  planDirectory: string = DEFAULT_CONFIG.planDirectory,
): boolean {
  const plansDir = path.join(cwd, planDirectory);
  if (!fs.existsSync(plansDir)) return false;
  try {
    return fs.readdirSync(plansDir).some((f) => f.endsWith(".md"));
  } catch {
    return false;
  }
}

/**
 * Check whether a tool name is in the read-only allowlist.
 */
export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName);
}

export interface ReadOnlyToolCallOptions {
  cwd?: string;
  planDirectory?: string;
}

/**
 * Check whether a full tool call is safe in Plan Mode.
 * - Read-only tools: allowed.
 * - write/edit: allowed only when the target path is under the plan directory.
 * - subagent: allowed only for read-only agent types (Explore, Plan).
 * - bash: allowed only for conservative read-only inspection commands.
 */
export function isReadOnlyToolCall(
  toolName: string,
  input?: Record<string, unknown>,
  options?: ReadOnlyToolCallOptions,
): boolean {
  if (isReadOnlyTool(toolName)) return true;

  // Workflow artifacts (plans/research/reviews/specs) may be drafted in Plan Mode.
  if (toolName === "write" || toolName === "edit") {
    const filePath = input?.path;
    const cwd = options?.cwd;
    const planDirectory = options?.planDirectory ?? DEFAULT_CONFIG.planDirectory;
    if (typeof filePath === "string" && cwd) {
      return isWorkflowDocPath(filePath, cwd) || isPlanPath(filePath, cwd, planDirectory);
    }
    return false;
  }

  // Subagents are explicit delegations: dispatching a coder/debugger/reviewer
  // is an intentional execution decision by the main agent, not an accidental
  // write. Subagents run in isolated sessions, so Plan Mode (which constrains
  // the main agent's *direct* writes) does not gate them. This keeps the gate
  // compatible with subagent-driven workflows (superpowers' coder/debugger/
  // parallel-agents skills) while still blocking the main agent from directly
  // writing to the project during planning.
  if (toolName === "subagent") {
    return true;
  }

  if (toolName === "bash") {
    const command = input?.command;
    return typeof command === "string" && isReadOnlyBashCommand(command);
  }

  return false;
}

export interface SwitchResult {
  success: boolean;
  newMode: GateMode;
  reason?: string;
}

/**
 * Pure function: compute the new mode after a switch attempt.
 * - Switching to current mode is a no-op.
 * - Switching to execute requires an approved plan.
 * - Switching to plan always works.
 */
export function switchMode(
  currentMode: GateMode,
  targetMode: GateMode,
  hasPlan: boolean,
): SwitchResult {
  if (currentMode === targetMode) {
    return { success: true, newMode: targetMode };
  }

  if (targetMode === "execute" && !hasPlan) {
    return {
      success: false,
      newMode: currentMode,
      reason: "No approved plan found in the plan directory. Create a plan first.",
    };
  }

  return { success: true, newMode: targetMode };
}

/**
 * Human-readable status label for the Pi status bar.
 */
export function getStatusLabel(mode: GateMode): string {
  return mode === "plan" ? "📋 Plan" : "🔧 Build";
}

/**
 * Per-turn mode context injected before each agent run.
 */
export function getModeContext(
  mode: GateMode,
  planDirectory: string = DEFAULT_CONFIG.planDirectory,
): string {
  if (mode === "plan") {
    return `[📋 PLAN MODE — Read-Only]
You are in Plan Mode. Read/search/approval tools are allowed.
- Allowed: read, grep, find, ls, web_search, fetch_content, get_search_content, code_search, ask_user, propose_goal_draft, memory_search, memory_recall, memory_status, get_subagent_result.
- subagent: ALL types allowed (coder/debugger/reviewer/etc.). Spawning a subagent is an explicit delegation that runs in an isolated session; Plan Mode gates only your *direct* writes, not delegated work.
- bash: only conservative read-only commands (ls, pwd, rg/grep, find, cat, head, tail, wc, git status/diff/log/show, codegraph read subcommands). Pipes, redirection, and chaining are blocked.
- write/edit: allowed ONLY for files under ${planDirectory}/ (to draft the plan). All other direct writes are blocked.
Other direct write tools are blocked. You cannot run commands yourself — to switch to Build Mode, ask the user to run /execute (requires at least one .md file in ${planDirectory}/).`;
  }

  return `[🔧 BUILD MODE — Full Access]
You are in Build Mode. All tools are available for implementation, testing, and refactoring.
Continue following the approved plan in ${planDirectory}/ and run verification before claiming completion.
To return to read-only planning, ask the user to run /plan.`;
}

/**
 * Whether the current session is a subagent session (spawned by @gotgenes/
 * pi-subagents or similar in-process subagent machinery).
 *
 * Subagents are explicit delegations by the main agent and run in isolated
 * sessions with their own agent.md tool allowlists. They always load the
 * parent's extensions, which means pi-plan-execute-gate would otherwise start
 * them in Plan Mode (no persisted state → defaultMode) and silently block
 * their write/edit calls — breaking coder/debugger/researcher subagents
 * dispatched by pi-goal, dag-run, and superpowers.
 *
 * Detection: a subagent session is created via SessionManager.newSession({
 * parentSession }), so ctx.sessionManager.getHeader()?.parentSession is set.
 * When in doubt (no header available), fall back to Build Mode to avoid
 * silently blocking delegated work.
 */
export function isSubagentSession(ctx: {
  sessionManager: { getHeader?: () => { parentSession?: string } | null } | null;
}): boolean {
  try {
    const header = ctx.sessionManager?.getHeader?.();
    if (!header) return true; // be permissive: no header → assume subagent → Build Mode
    return Boolean(header.parentSession);
  } catch {
    return true; // permissive on any error
  }
}

/**
 * Load optional config from <cwd>/.pi/plan-execute.json.
 * Only honored for trusted projects (an untrusted project must not be able to
 * bypass the gate by setting defaultMode: "execute"). Falls back to defaults
 * on any error.
 */
export function loadConfig(cwd: string, trusted: boolean): PlanExecuteConfig {
  if (!trusted) return { ...DEFAULT_CONFIG };
  const cfgPath = path.join(cwd, ".pi", "plan-execute.json");
  try {
    if (!fs.existsSync(cfgPath)) return { ...DEFAULT_CONFIG };
    const raw = JSON.parse(
      fs.readFileSync(cfgPath, "utf8"),
    ) as Partial<PlanExecuteConfig> & Record<string, unknown>;
    const defaultMode: GateMode = raw.defaultMode === "execute" ? "execute" : "plan";
    const planDirectory =
      typeof raw.planDirectory === "string" && raw.planDirectory.trim()
        ? raw.planDirectory.trim()
        : DEFAULT_CONFIG.planDirectory;
    return { defaultMode, planDirectory };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
