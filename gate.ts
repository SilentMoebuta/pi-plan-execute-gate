import * as fs from "node:fs";
import * as path from "node:path";

export type GateMode = "plan" | "execute";

/**
 * Read-only tools allowed in Plan Mode (no path/object restrictions).
 * Note: `spawn_role` is intentionally NOT here — it is handled separately in
 * isReadOnlyToolCall as a delegated-execution tool (always allowed), not a
 * read-only tool. pi-roles' `spawn_role` runs in the foreground and returns
 * its result directly, so there is no `get_subagent_result` polling tool.
 */
const READ_ONLY_TOOLS = new Set([
  "read", "grep", "find", "ls",
  "web_search", "fetch_content", "get_search_content", "code_search",
  "ask_user", "propose_goal_draft",
  "memory_search", "memory_recall", "memory_status",
]);

const READ_ONLY_BASH_COMMANDS = new Set([
  "ls", "pwd", "grep", "rg", "find", "cat", "head", "tail", "wc",
  // Additional read-only inspection commands (no side effects; redirection
  // and chaining are still blocked by UNSAFE_SHELL_TOKENS).
  "tree", "echo", "printf", "test", "stat", "which", "file", "du", "df",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show",
]);

// Read-only argument shapes for git subcommands that also have destructive
// variants (e.g. `git branch -v` read vs `git branch -D` delete). A command is
// read-only only if EVERY flag after the subcommand is in the subcommand's
// allow-set AND no destructive flag appears. Default-deny: unknown flag → false.
const GIT_BRANCH_READ_FLAGS = new Set(["-v", "--verbose", "-a", "--all", "-r", "--remotes", "--list", "-l"]);
const GIT_TAG_READ_FLAGS = new Set(["-l", "--list", "-n", "-n0", "-n1", "-n2", "-n3", "-n4", "-n5", "-n6", "-n7", "-n8", "-n9"]);
const GIT_CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "-l", "--list", "--get-urlmatch"]);

/** Whether a `git <sub>` invocation is read-only, checking arguments not just
 *  the subcommand name (so `git branch -v` is allowed but `git branch -D` is not). */
function isReadOnlyGit(subcommand: string, words: string[]): boolean {
  // Pure name-level read-only subcommands (status/diff/log/show).
  if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return true;

  const flags = words.slice(2);

  if (subcommand === "branch") {
    // `git branch` with no args lists branches (read-only). Any arg must be a
    // known read flag; a bare name (create) or -D/-d/-m is not allowed.
    if (flags.length === 0) return true;
    return flags.every((w) => GIT_BRANCH_READ_FLAGS.has(w));
  }

  if (subcommand === "remote") {
    // `git remote` (no args) lists; `-v`/`--verbose` lists; `show <name>` reads.
    if (flags.length === 0) return true;
    if (flags[0] === "-v" || flags[0] === "--verbose") return flags.length === 1;
    if (flags[0] === "show") return true; // `git remote show <name>` is read-only
    return false;
  }

  if (subcommand === "tag") {
    // `git tag` (no args) lists; `-l`/`--list`/`-nN` lists; a bare name creates.
    if (flags.length === 0) return true;
    return flags.every((w) => GIT_TAG_READ_FLAGS.has(w) || /^-n\d+$/.test(w));
  }

  if (subcommand === "config") {
    // Only the --get* / -l / --list forms are read-only. `git config <k> <v>`
    // writes, `--add`/`--unset` write.
    if (flags.length === 0) return false; // `git config` with no args → not standard; deny
    // Allow exactly one read flag optionally followed by a key (positional value).
    const hasReadFlag = flags.some((w) => GIT_CONFIG_READ_FLAGS.has(w));
    if (!hasReadFlag) return false;
    // No write flags allowed.
    const WRITE_FLAGS = new Set(["--add", "--unset", "--unset-all", "--replace-all", "--remove-section", "--rename-section"]);
    if (flags.some((w) => WRITE_FLAGS.has(w))) return false;
    return true;
  }

  return false;
}

const READ_ONLY_CODEGRAPH_SUBCOMMANDS = new Set([
  "status", "files", "query", "explore", "node", "callers", "callees", "impact", "affected",
]);

/** `find` arguments that execute commands or write files — must never pass
 *  the read-only check. `-exec`/`-execdir`/`-ok`/`-okdir` run arbitrary
 *  commands; `-fls`/`-fprint`/`-fprint0`/`-printf` write to arbitrary files
 *  (-printf to stdout but is paired with -fprint family in abuse);
 *  `-delete` mutates the filesystem. */
const UNSAFE_FIND_ARGS = new Set([
  "-exec", "-execdir", "-ok", "-okdir",
  "-fls", "-fprint", "-fprint0", "-printf", "-delete",
]);

const UNSAFE_SHELL_TOKENS = /(;|&&|\|\||\||>|<|`|\$\(|\n)/;

export interface PlanExecuteConfig {
  defaultMode: GateMode;
  /** Plan directory, relative to cwd. */
  planDirectory: string;
  /** When true, /execute requires at least one .md in planDirectory
   *  (superpowers-style strict gate). Default false: /execute is
   *  unconditional, so the gate does not impose a workflow on non-
   *  superpowers users. */
  requirePlanForExecute?: boolean;
}

export const DEFAULT_CONFIG: PlanExecuteConfig = {
  defaultMode: "execute",
  planDirectory: "docs/plans",
  requirePlanForExecute: false,
};

function firstWords(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

export function isReadOnlyBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || UNSAFE_SHELL_TOKENS.test(trimmed)) return false;

  const words = firstWords(trimmed);
  const executable = words[0];
  const subcommand = words[1];

  if (READ_ONLY_BASH_COMMANDS.has(executable)) {
    if (executable === "find" && words.some((w) => UNSAFE_FIND_ARGS.has(w))) return false;
    return true;
  }

  if (executable === "git") {
    return Boolean(subcommand) && isReadOnlyGit(subcommand!, words);
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
 * Whether a single .md file looks like a real plan artifact rather than a
 * stale README/scratch file. A file counts if its name contains "plan"
 * (e.g. `my-plan.md`, `plan-2026-...md`), OR its content begins with YAML
 * frontmatter, OR its content contains the word "plan" (covers superpowers'
 * `# <Feature> Implementation Plan` header). Reads at most the first 2 KiB.
 */
function isPlanArtifact(file: string, plansDir: string): boolean {
  if (/plan/i.test(file)) return true;
  try {
    const content = fs.readFileSync(path.join(plansDir, file), "utf8").slice(0, 2048);
    return /^---\s*\n/.test(content) || /\bplan\b/i.test(content);
  } catch {
    return false;
  }
}

/**
 * Check whether the plan directory contains at least one recognizable plan
 * artifact (a .md file whose name or content looks like a plan, or which has
 * frontmatter). A bare README.md or empty scratch.md no longer satisfies the
 * /execute gate.
 */
export function hasApprovedPlan(
  cwd: string,
  planDirectory: string = DEFAULT_CONFIG.planDirectory,
): boolean {
  const plansDir = path.join(cwd, planDirectory);
  if (!fs.existsSync(plansDir)) return false;
  try {
    return fs.readdirSync(plansDir).some((f) => f.endsWith(".md") && isPlanArtifact(f, plansDir));
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

  // spawn_role (pi-roles) is an explicit delegation: dispatching a
  // coder/debugger/reviewer/researcher is an intentional execution decision
  // by the main agent, not an accidental write. spawn_role runs in an isolated
  // session in the foreground and returns its result directly, so Plan Mode
  // (which constrains the main agent's *direct* writes) does not gate it. This
  // keeps the gate compatible with role-driven workflows (superpowers'
  // coder/debugger/parallel-agents skills) while still blocking the main agent
  // from directly writing to the project during planning.
  if (toolName === "spawn_role") {
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
- Allowed: read, grep, find, ls, web_search, fetch_content, get_search_content, code_search, ask_user, propose_goal_draft, memory_search, memory_recall, memory_status.
- spawn_role: ALL roles allowed (coder/debugger/reviewer/researcher/etc.). Spawning a role subagent is an explicit delegation that runs in an isolated session in the foreground; Plan Mode gates only your *direct* writes, not delegated work.
- bash: only conservative read-only commands (ls, pwd, rg/grep, find, cat, head, tail, wc, git status/diff/log/show, codegraph read subcommands). Pipes, redirection, and chaining are blocked.
- write/edit: allowed ONLY for files under ${planDirectory}/ (to draft the plan). All other direct writes are blocked.
Other direct write tools are blocked. To switch to Build Mode (all tools), ask the user to run /execute.`;
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
  // Only force Build Mode when a parentSession is POSITIVELY present. On a
  // missing/throwing header we must NOT assume subagent — otherwise a top-level
  // session in RPC/print mode (no getHeader) is misclassified as a subagent
  // and forced to Build, silently bypassing a configured `defaultMode: "plan"`.
  try {
    const header = ctx.sessionManager?.getHeader?.();
    if (!header) return false;
    return Boolean(header.parentSession);
  } catch {
    return false;
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
    // Default is Build Mode; only an explicit "plan" opts into Plan Mode.
    // (Any missing/invalid value falls back to "execute" so the gate does
    // not silently lock users into read-only.)
    const defaultMode: GateMode = raw.defaultMode === "plan" ? "plan" : "execute";
    const planDirectory =
      typeof raw.planDirectory === "string" && raw.planDirectory.trim()
        ? raw.planDirectory.trim()
        : DEFAULT_CONFIG.planDirectory;
    const requirePlanForExecute = raw.requirePlanForExecute === true;
    return { defaultMode, planDirectory, requirePlanForExecute };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
