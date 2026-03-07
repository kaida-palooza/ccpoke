import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

import { ApiRoute, isWindows } from "../../utils/constants.js";
import { getPackageVersion, paths, toPosixPath } from "../../utils/paths.js";
import { buildWindowsHookScript } from "../../utils/windows-hook-script-builder.js";
import { AgentName } from "../types.js";

const VERSION_HEADER_PATTERN = /^#\s*ccpoke-version:\s*(\S+)/;
const VERSION_HEADER_PATTERN_WIN = /^@REM\s+ccpoke-version:\s*(\S+)/;

interface CursorStopHook {
  command: string;
  timeout: number;
}

interface CursorHooksConfig {
  version?: number;
  hooks?: {
    stop?: CursorStopHook[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function hasCcpokeHook(stopHooks: CursorStopHook[]): boolean {
  return stopHooks.some(
    (entry) => typeof entry.command === "string" && entry.command.includes("ccpoke")
  );
}

function hasExactHookPath(stopHooks: CursorStopHook[]): boolean {
  const expected = toPosixPath(paths.cursorHookScript);
  return stopHooks.some((entry) => typeof entry.command === "string" && entry.command === expected);
}

function readScriptVersion(scriptPath: string): string | null {
  try {
    const content = readFileSync(scriptPath, "utf-8");
    const lines = content.split("\n");
    for (const line of lines.slice(0, 3)) {
      const match = line.match(VERSION_HEADER_PATTERN) ?? line.match(VERSION_HEADER_PATTERN_WIN);
      if (match) return match[1] ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

export class CursorInstaller {
  static isInstalled(): boolean {
    try {
      if (!existsSync(paths.cursorHooksJson)) return false;

      const config = CursorInstaller.readConfig();
      return hasCcpokeHook(config.hooks?.stop ?? []);
    } catch {
      return false;
    }
  }

  static install(hookPort: number, hookSecret: string): void {
    mkdirSync(paths.cursorDir, { recursive: true });

    const config = CursorInstaller.readConfig();

    if (!config.hooks) config.hooks = {};

    const existing = config.hooks.stop ?? [];
    const filtered = existing.filter(
      (entry) => !(typeof entry.command === "string" && entry.command.includes("ccpoke"))
    );

    filtered.push({
      command: toPosixPath(paths.cursorHookScript),
      timeout: 10,
    });

    config.hooks.stop = filtered;
    if (!config.version) config.version = 1;

    writeFileSync(paths.cursorHooksJson, JSON.stringify(config, null, 2));
    CursorInstaller.writeScript(hookPort, hookSecret);
  }

  static verifyIntegrity(): { complete: boolean; missing: string[] } {
    const missing: string[] = [];

    try {
      const config = CursorInstaller.readConfig();
      const stopHooks = config.hooks?.stop ?? [];
      if (!hasCcpokeHook(stopHooks)) missing.push("Stop hook in hooks.json");
      else if (!hasExactHookPath(stopHooks)) missing.push("wrong hook script path in hooks.json");
    } catch {
      missing.push("hooks.json");
    }

    if (!existsSync(paths.cursorHookScript)) {
      missing.push("stop script file");
    } else if (readScriptVersion(paths.cursorHookScript) !== getPackageVersion()) {
      missing.push("outdated stop script");
    }

    return { complete: missing.length === 0, missing };
  }

  static uninstall(): void {
    CursorInstaller.removeFromHooksJson();
    CursorInstaller.removeScript();
  }

  private static writeScript(hookPort: number, hookSecret: string): void {
    mkdirSync(paths.hooksDir, { recursive: true });

    const agentParam = `?agent=${AgentName.Cursor}`;
    const version = getPackageVersion();
    if (isWindows()) {
      writeFileSync(
        paths.cursorHookScript,
        buildWindowsHookScript(version, hookPort, `${ApiRoute.HookStop}${agentParam}`, hookSecret),
        { mode: 0o644 }
      );
      return;
    }

    const script = `#!/bin/bash
# ccpoke-version: ${version}
CCPOKE_HOST="\${CCPOKE_HOST:-localhost}"
INPUT=$(cat | tr -d '\\n\\r')
[ -z "$INPUT" ] && exit 0
TMUX_TARGET=""
if [ -n "$TMUX_PANE" ]; then
  TMUX_TARGET=$(tmux display-message -t "$TMUX_PANE" -p '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null || echo "")
elif [ -n "$TMUX" ]; then
  TMUX_TARGET=$(tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null || echo "")
fi
if [ -n "$TMUX_TARGET" ] && echo "$TMUX_TARGET" | grep -qE '^[a-zA-Z0-9_.:/@ -]+$'; then
  INPUT=$(echo "$INPUT" | sed 's/}$/,"tmux_target":"'"$TMUX_TARGET"'"}/')
fi
echo "$INPUT" | curl -s -X POST "http://$CCPOKE_HOST:${hookPort}${ApiRoute.HookStop}${agentParam}" \\
  -H "Content-Type: application/json" \\
  -H "X-CCPoke-Secret: ${hookSecret}" \\
  --data-binary @- > /dev/null 2>&1 || true
`;

    writeFileSync(paths.cursorHookScript, script, { mode: 0o700 });
  }

  private static removeScript(): void {
    try {
      unlinkSync(paths.cursorHookScript);
    } catch {
      // script may not exist
    }
  }

  private static removeFromHooksJson(): void {
    if (!existsSync(paths.cursorHooksJson)) return;

    const config = CursorInstaller.readConfig();
    if (!config.hooks?.stop) return;

    const filtered = config.hooks.stop.filter(
      (entry) => !(typeof entry.command === "string" && entry.command.includes("ccpoke"))
    );

    if (filtered.length === 0) {
      delete config.hooks.stop;
    } else {
      config.hooks.stop = filtered;
    }

    if (Object.keys(config.hooks).length === 0) {
      delete config.hooks;
    }

    writeFileSync(paths.cursorHooksJson, JSON.stringify(config, null, 2));
  }

  private static readConfig(): CursorHooksConfig {
    try {
      return JSON.parse(readFileSync(paths.cursorHooksJson, "utf-8"));
    } catch (err: unknown) {
      const isFileNotFound =
        err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
      if (isFileNotFound) return { version: 1, hooks: {} };
      throw err;
    }
  }
}
