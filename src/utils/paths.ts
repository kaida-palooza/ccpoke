import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isWindows } from "./constants.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(MODULE_DIR, "..", "..");

const CCPOKE_HOME = join(homedir(), ".ccpoke");
const CLAUDE_HOME = join(homedir(), ".claude");
const CURSOR_HOME = join(homedir(), ".cursor");
const CODEX_HOME = join(homedir(), ".codex");
const GEMINI_HOME = join(homedir(), ".gemini");
const OPENCODE_HOME = join(homedir(), ".config", "opencode");

export const paths = {
  projectRoot: PROJECT_ROOT,

  packageJson: join(PROJECT_ROOT, "package.json"),
  lockFile: join(PROJECT_ROOT, "ccpoke-lock.json"),

  ccpokeDir: CCPOKE_HOME,
  configFile: join(CCPOKE_HOME, "config.json"),
  stateFile: join(CCPOKE_HOME, "state.json"),
  hooksDir: join(CCPOKE_HOME, "hooks"),
  hookEnvFile: join(CCPOKE_HOME, "hooks", ".env"),
  hookEnvCmdFile: join(CCPOKE_HOME, "hooks", ".env.cmd"),
  hookLibDir: join(CCPOKE_HOME, "hooks", "lib"),
  hookSourceDir: join(PROJECT_ROOT, "hooks"),
  responsesDir: join(CCPOKE_HOME, "responses"),
  completionsDir: join(CCPOKE_HOME, "completions"),
  zshCompletion: join(CCPOKE_HOME, "completions", "_ccpoke"),
  bashCompletion: join(CCPOKE_HOME, "completions", "ccpoke.bash"),

  claudeDir: CLAUDE_HOME,
  claudeSettings: join(CLAUDE_HOME, "settings.json"),
  claudeProjectsDir: join(CLAUDE_HOME, "projects"),
  claudeCodeHookScript: join(
    CCPOKE_HOME,
    "hooks",
    isWindows() ? "claude-code-stop.cmd" : "claude-code-stop.sh"
  ),
  claudeCodeSessionStartScript: join(
    CCPOKE_HOME,
    "hooks",
    isWindows() ? "claude-code-session-start.cmd" : "claude-code-session-start.sh"
  ),
  claudeCodeNotificationScript: join(
    CCPOKE_HOME,
    "hooks",
    isWindows() ? "claude-code-notification.cmd" : "claude-code-notification.sh"
  ),
  claudeCodePreToolUseScript: join(
    CCPOKE_HOME,
    "hooks",
    isWindows() ? "claude-code-pretooluse.cmd" : "claude-code-pretooluse.sh"
  ),
  claudeCodePermissionRequestScript: join(
    CCPOKE_HOME,
    "hooks",
    isWindows() ? "claude-code-permission-request.cmd" : "claude-code-permission-request.sh"
  ),

  cursorDir: CURSOR_HOME,
  cursorHooksJson: join(CURSOR_HOME, "hooks.json"),
  cursorProjectsDir: join(CURSOR_HOME, "projects"),
  cursorHookScript: join(CCPOKE_HOME, "hooks", isWindows() ? "cursor-stop.cmd" : "cursor-stop.sh"),

  codexDir: CODEX_HOME,
  codexConfigToml: join(CODEX_HOME, "config.toml"),
  codexSessionsDir: join(CODEX_HOME, "sessions"),
  codexHookScript: join(CCPOKE_HOME, "hooks", isWindows() ? "codex-notify.cmd" : "codex-notify.sh"),

  geminiDir: GEMINI_HOME,
  geminiSettings: join(GEMINI_HOME, "settings.json"),
  geminiStopScript: join(CCPOKE_HOME, "hooks", isWindows() ? "gemini-stop.cmd" : "gemini-stop.sh"),
  geminiSessionStartScript: join(
    CCPOKE_HOME,
    "hooks",
    isWindows() ? "gemini-session-start.cmd" : "gemini-session-start.sh"
  ),
  geminiNotificationScript: join(
    CCPOKE_HOME,
    "hooks",
    isWindows() ? "gemini-notification.cmd" : "gemini-notification.sh"
  ),
  geminiPreToolUseScript: join(CCPOKE_HOME, "hooks", "gemini-pretooluse.sh"),

  opencodeDir: OPENCODE_HOME,
  opencodePluginsDir: join(OPENCODE_HOME, "plugins"),
  opencodePluginFile: join(OPENCODE_HOME, "plugins", "ccpoke-notify.js"),
} as const;

export function getPackageVersion(): string {
  try {
    return JSON.parse(readFileSync(paths.packageJson, "utf-8")).version;
  } catch {
    return "unknown";
  }
}

export function toPosixPath(filepath: string): string {
  return filepath.replace(/\\/g, "/");
}

export function expandHome(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}
