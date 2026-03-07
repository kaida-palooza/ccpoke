import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { ApiRoute, isWindows } from "../../utils/constants.js";
import { getPackageVersion, paths } from "../../utils/paths.js";
import { AgentName } from "../types.js";

const VERSION_HEADER_PATTERN = /^#\s*ccpoke-version:\s*(\S+)/;
const NOTIFY_LINE_PATTERN = /^notify\s*=\s*\[([\s\S]*?)\]/m;
const CCPOKE_MARKER = "ccpoke";

function readScriptVersion(scriptPath: string): string | null {
  try {
    const lines = readFileSync(scriptPath, "utf-8").split("\n");
    for (const line of lines.slice(0, 3)) {
      const match = line.match(VERSION_HEADER_PATTERN);
      if (match) return match[1] ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

function readNotifyArray(content: string): string[] {
  const match = content.match(NOTIFY_LINE_PATTERN);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function writeNotifyLine(entries: string[]): string {
  const quoted = entries.map((e) => `'${e}'`).join(", ");
  return `notify = [${quoted}]`;
}

function readConfigFile(): string {
  try {
    return readFileSync(paths.codexConfigToml, "utf-8");
  } catch {
    return "";
  }
}

function writeConfigFile(content: string): void {
  mkdirSync(dirname(paths.codexConfigToml), { recursive: true });
  const tmp = `${paths.codexConfigToml}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, paths.codexConfigToml);
}

export class CodexInstaller {
  static isInstalled(): boolean {
    try {
      if (!existsSync(paths.codexConfigToml)) return false;
      const entries = readNotifyArray(readConfigFile());
      return entries.some((e) => e.includes(CCPOKE_MARKER));
    } catch {
      return false;
    }
  }

  static install(hookPort: number, hookSecret: string): void {
    let content = readConfigFile();
    const entries = readNotifyArray(content).filter((e) => !e.includes(CCPOKE_MARKER));
    entries.push(paths.codexHookScript);

    const newLine = writeNotifyLine(entries);
    if (NOTIFY_LINE_PATTERN.test(content)) {
      content = content.replace(NOTIFY_LINE_PATTERN, newLine);
    } else {
      const sectionMatch = content.match(/^\[/m);
      if (sectionMatch?.index !== undefined) {
        content =
          content.slice(0, sectionMatch.index) + newLine + "\n" + content.slice(sectionMatch.index);
      } else {
        content = content.trimEnd() + (content.trim() ? "\n" : "") + newLine + "\n";
      }
    }

    writeConfigFile(content);
    CodexInstaller.writeScript(hookPort, hookSecret);
  }

  static uninstall(): void {
    CodexInstaller.removeFromConfig();
    CodexInstaller.removeScript();
  }

  static verifyIntegrity(): { complete: boolean; missing: string[] } {
    const missing: string[] = [];

    try {
      const entries = readNotifyArray(readConfigFile());
      if (!entries.some((e) => e.includes(CCPOKE_MARKER)))
        missing.push("notify entry in config.toml");
      else if (!entries.includes(paths.codexHookScript))
        missing.push("wrong notify script path in config.toml");
    } catch {
      missing.push("config.toml");
    }

    if (!existsSync(paths.codexHookScript)) {
      missing.push("notify script file");
    } else if (readScriptVersion(paths.codexHookScript) !== getPackageVersion()) {
      missing.push("outdated notify script");
    }

    return { complete: missing.length === 0, missing };
  }

  private static writeScript(hookPort: number, hookSecret: string): void {
    mkdirSync(paths.hooksDir, { recursive: true });

    const version = getPackageVersion();
    const agentParam = `?agent=${AgentName.Codex}`;

    if (isWindows()) {
      const script = `@REM ccpoke-version: ${version}\n@echo off\necho %~1 | curl -s -X POST http://localhost:${hookPort}${ApiRoute.HookStop}${agentParam} -H "Content-Type: application/json" -H "X-CCPoke-Secret: ${hookSecret}" --data-binary "%~1" > nul 2>&1\n`;
      writeFileSync(paths.codexHookScript, script, { mode: 0o644 });
      return;
    }

    const script = `#!/bin/bash
# ccpoke-version: ${version}
JSON="$1"
[ -z "$JSON" ] && exit 0
TMUX_TARGET=""
if [ -n "$TMUX_PANE" ]; then
  TMUX_TARGET=$(tmux display-message -t "$TMUX_PANE" -p '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null || echo "")
elif [ -n "$TMUX" ]; then
  TMUX_TARGET=$(tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null || echo "")
fi
if [ -n "$TMUX_TARGET" ] && echo "$TMUX_TARGET" | grep -qE '^[a-zA-Z0-9_.:/@ -]+$'; then
  JSON=$(echo "$JSON" | sed 's/}$/,"tmux_target":"'"$TMUX_TARGET"'"}/')
fi
echo "$JSON" | curl -s -X POST "http://localhost:${hookPort}${ApiRoute.HookStop}${agentParam}" \\
  -H "Content-Type: application/json" \\
  -H "X-CCPoke-Secret: ${hookSecret}" \\
  --data-binary @- > /dev/null 2>&1 || true
`;

    writeFileSync(paths.codexHookScript, script, { mode: 0o700 });
  }

  private static removeScript(): void {
    try {
      unlinkSync(paths.codexHookScript);
    } catch {
      /* noop */
    }
  }

  private static removeFromConfig(): void {
    if (!existsSync(paths.codexConfigToml)) return;

    let content = readConfigFile();
    const entries = readNotifyArray(content).filter((e) => !e.includes(CCPOKE_MARKER));

    if (entries.length === 0) {
      content = content.replace(/^notify\s*=\s*\[[\s\S]*?\]\s*\n?/m, "");
    } else {
      content = content.replace(NOTIFY_LINE_PATTERN, writeNotifyLine(entries));
    }

    writeConfigFile(content);
  }
}
