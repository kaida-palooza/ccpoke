import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { ApiRoute, isWindows } from "../../utils/constants.js";
import { getPackageVersion, paths, toPosixPath } from "../../utils/paths.js";
import { buildWindowsHookScript } from "../../utils/windows-hook-script-builder.js";
import { AgentName } from "../types.js";

const VERSION_HEADER_PATTERN = /^#\s*ccpoke-version:\s*(\S+)/;
const VERSION_HEADER_PATTERN_WIN = /^@REM\s+ccpoke-version:\s*(\S+)/;

interface ClaudeHookCommand {
  type: string;
  command: string;
  timeout: number;
}

interface ClaudeHookEntry {
  matcher?: string;
  hooks: ClaudeHookCommand[];
}

interface ClaudeSettings {
  hooks?: {
    Stop?: ClaudeHookEntry[];
    SessionStart?: ClaudeHookEntry[];
    Notification?: ClaudeHookEntry[];
    PreToolUse?: ClaudeHookEntry[];
    PermissionRequest?: ClaudeHookEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function hasCcpokeHook(entries: ClaudeHookEntry[]): boolean {
  return entries.some((entry) =>
    entry.hooks?.some((h) => typeof h.command === "string" && h.command.includes("ccpoke"))
  );
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

function isScriptOutdated(scriptPath: string): boolean {
  if (!existsSync(scriptPath)) return false;
  return readScriptVersion(scriptPath) !== getPackageVersion();
}

export class ClaudeCodeInstaller {
  static isInstalled(): boolean {
    try {
      const settings = ClaudeCodeInstaller.readSettings();
      return (
        hasCcpokeHook(settings.hooks?.Stop ?? []) &&
        hasCcpokeHook(settings.hooks?.SessionStart ?? []) &&
        hasCcpokeHook(settings.hooks?.Notification ?? []) &&
        hasCcpokeHook(settings.hooks?.PreToolUse ?? []) &&
        hasCcpokeHook(settings.hooks?.PermissionRequest ?? [])
      );
    } catch {
      return false;
    }
  }

  static verifyIntegrity(): { complete: boolean; missing: string[] } {
    const missing: string[] = [];
    try {
      const settings = ClaudeCodeInstaller.readSettings();
      if (!hasCcpokeHook(settings.hooks?.Stop ?? [])) missing.push("Stop hook in settings");
      if (!hasCcpokeHook(settings.hooks?.SessionStart ?? []))
        missing.push("SessionStart hook in settings");
      if (!hasCcpokeHook(settings.hooks?.Notification ?? []))
        missing.push("Notification hook in settings");
      if (!hasCcpokeHook(settings.hooks?.PreToolUse ?? []))
        missing.push("PreToolUse hook in settings");
      if (!hasCcpokeHook(settings.hooks?.PermissionRequest ?? []))
        missing.push("PermissionRequest hook in settings");
    } catch {
      missing.push("settings.json");
    }
    if (!existsSync(paths.claudeCodeHookScript)) missing.push("stop script file");
    if (!existsSync(paths.claudeCodeSessionStartScript)) missing.push("session-start script file");
    if (!existsSync(paths.claudeCodeNotificationScript)) missing.push("notification script file");
    if (!existsSync(paths.claudeCodePreToolUseScript)) missing.push("pretooluse script file");
    if (!existsSync(paths.claudeCodePermissionRequestScript))
      missing.push("permission-request script file");
    if (isScriptOutdated(paths.claudeCodeHookScript)) missing.push("outdated stop script");
    if (isScriptOutdated(paths.claudeCodeSessionStartScript))
      missing.push("outdated session-start script");
    if (isScriptOutdated(paths.claudeCodeNotificationScript))
      missing.push("outdated notification script");
    if (isScriptOutdated(paths.claudeCodePreToolUseScript))
      missing.push("outdated pretooluse script");
    if (isScriptOutdated(paths.claudeCodePermissionRequestScript))
      missing.push("outdated permission-request script");

    return { complete: missing.length === 0, missing };
  }

  static install(hookPort: number, hookSecret: string): void {
    ClaudeCodeInstaller.uninstall();

    const settings = ClaudeCodeInstaller.readSettings();
    if (!settings.hooks) settings.hooks = {};

    settings.hooks.Stop = [
      ...(settings.hooks.Stop ?? []),
      {
        hooks: [{ type: "command", command: toPosixPath(paths.claudeCodeHookScript), timeout: 10 }],
      },
    ];

    settings.hooks.SessionStart = [
      ...(settings.hooks.SessionStart ?? []),
      {
        hooks: [
          { type: "command", command: toPosixPath(paths.claudeCodeSessionStartScript), timeout: 5 },
        ],
      },
    ];
    settings.hooks.Notification = [
      ...(settings.hooks.Notification ?? []),
      {
        hooks: [
          {
            type: "command",
            command: toPosixPath(paths.claudeCodeNotificationScript),
            timeout: 10,
          },
        ],
      },
    ];
    settings.hooks.PreToolUse = [
      ...(settings.hooks.PreToolUse ?? []),
      {
        matcher: "AskUserQuestion",
        hooks: [
          { type: "command", command: toPosixPath(paths.claudeCodePreToolUseScript), timeout: 5 },
        ],
      },
    ];
    settings.hooks.PermissionRequest = [
      ...(settings.hooks.PermissionRequest ?? []),
      {
        hooks: [
          {
            type: "command",
            command: toPosixPath(paths.claudeCodePermissionRequestScript),
            timeout: 5,
          },
        ],
      },
    ];

    mkdirSync(paths.claudeDir, { recursive: true });
    const tmpSettings = `${paths.claudeSettings}.tmp`;
    writeFileSync(tmpSettings, JSON.stringify(settings, null, 2));
    renameSync(tmpSettings, paths.claudeSettings);

    ClaudeCodeInstaller.writeStopScript(hookPort, hookSecret);
    ClaudeCodeInstaller.writeSessionStartScript(hookPort, hookSecret);
    ClaudeCodeInstaller.writeNotificationScript(hookPort, hookSecret);
    ClaudeCodeInstaller.writePreToolUseScript(hookPort, hookSecret);
    ClaudeCodeInstaller.writePermissionRequestScript(hookPort, hookSecret);
  }

  static uninstall(): void {
    ClaudeCodeInstaller.removeFromSettings();
    ClaudeCodeInstaller.removeStopScript();
    ClaudeCodeInstaller.removeSessionStartScript();
    ClaudeCodeInstaller.removeNotificationScript();
    ClaudeCodeInstaller.removePreToolUseScript();
    ClaudeCodeInstaller.removePermissionRequestScript();
  }

  private static writeStopScript(hookPort: number, hookSecret: string): void {
    mkdirSync(paths.hooksDir, { recursive: true });

    const agentParam = `?agent=${AgentName.ClaudeCode}`;
    const version = getPackageVersion();

    if (isWindows()) {
      writeFileSync(
        paths.claudeCodeHookScript,
        buildWindowsHookScript(version, hookPort, `${ApiRoute.HookStop}${agentParam}`, hookSecret),
        { mode: 0o644 }
      );
      return;
    }

    const script = `#!/bin/bash
# ccpoke-version: ${version}
CCPOKE_HOST="\${CCPOKE_HOST:-localhost}"
INPUT=$(cat | tr -d '\\n\\r')
echo "$INPUT" | grep -q '"session_id"' || exit 0
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
  -H "Content-Type: application/json" -H "X-CCPoke-Secret: ${hookSecret}" \\
  --data-binary @- > /dev/null 2>&1 || true
`;

    writeFileSync(paths.claudeCodeHookScript, script, { mode: 0o700 });
  }

  private static writeSessionStartScript(hookPort: number, hookSecret: string): void {
    mkdirSync(paths.hooksDir, { recursive: true });

    const version = getPackageVersion();

    if (isWindows()) {
      writeFileSync(
        paths.claudeCodeSessionStartScript,
        buildWindowsHookScript(version, hookPort, ApiRoute.HookSessionStart, hookSecret),
        { mode: 0o644 }
      );
      return;
    }
    const script = `#!/bin/bash
# ccpoke-version: ${version}
CCPOKE_HOST="\${CCPOKE_HOST:-localhost}"
[ -z "$TMUX" ] && exit 0

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
CWD=$(echo "$INPUT" | grep -o '"cwd":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$TMUX_PANE" ]; then
  TMUX_TARGET=$(tmux display-message -t "$TMUX_PANE" -p '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null)
else
  TMUX_TARGET=$(tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}')
fi

[ -z "$SESSION_ID" ] && exit 0

json_escape() {
  printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g; s/\t/\\\\t/g' | tr -d '\\n\\r'
}

PAYLOAD=$(printf '{"session_id":"%s","cwd":"%s","tmux_target":"%s"}' \\
  "$(json_escape "$SESSION_ID")" "$(json_escape "$CWD")" "$(json_escape "$TMUX_TARGET")")

curl -s -X POST "http://$CCPOKE_HOST:${hookPort}${ApiRoute.HookSessionStart}" \\
  -H "Content-Type: application/json" \\
  -H "X-CCPoke-Secret: ${hookSecret}" \\
  -d "$PAYLOAD" \\
  --max-time 3 > /dev/null 2>&1 || true
`;

    writeFileSync(paths.claudeCodeSessionStartScript, script, { mode: 0o700 });
  }

  private static writeNotificationScript(hookPort: number, hookSecret: string): void {
    mkdirSync(paths.hooksDir, { recursive: true });

    const version = getPackageVersion();

    if (isWindows()) {
      writeFileSync(
        paths.claudeCodeNotificationScript,
        buildWindowsHookScript(version, hookPort, ApiRoute.HookNotification, hookSecret),
        { mode: 0o644 }
      );
      return;
    }
    const script = `#!/bin/bash
# ccpoke-version: ${version}
CCPOKE_HOST="\${CCPOKE_HOST:-localhost}"
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -z "$SESSION_ID" ] && exit 0

TMUX_TARGET=""
if [ -n "$TMUX_PANE" ]; then
  TMUX_TARGET=$(tmux display-message -t "$TMUX_PANE" -p '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null || echo "")
elif [ -n "$TMUX" ]; then
  TMUX_TARGET=$(tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null || echo "")
fi

# Inject tmux_target into the raw JSON from Claude Code
if [ -n "$TMUX_TARGET" ] && echo "$TMUX_TARGET" | grep -qE '^[a-zA-Z0-9_.:/@ -]+$'; then
  PAYLOAD=$(echo "$INPUT" | sed 's/}$/,"tmux_target":"'"$TMUX_TARGET"'"}/')
else
  PAYLOAD="$INPUT"
fi

echo "$PAYLOAD" | curl -s -X POST "http://$CCPOKE_HOST:${hookPort}${ApiRoute.HookNotification}" \\
  -H "Content-Type: application/json" \\
  -H "X-CCPoke-Secret: ${hookSecret}" \\
  --data-binary @- \\
  --max-time 5 > /dev/null 2>&1 || true
`;

    writeFileSync(paths.claudeCodeNotificationScript, script, { mode: 0o700 });
  }

  private static writePreToolUseScript(hookPort: number, hookSecret: string): void {
    mkdirSync(paths.hooksDir, { recursive: true });

    const version = getPackageVersion();

    if (isWindows()) {
      writeFileSync(
        paths.claudeCodePreToolUseScript,
        buildWindowsHookScript(version, hookPort, ApiRoute.HookAskUserQuestion, hookSecret),
        { mode: 0o644 }
      );
      return;
    }
    const script = `#!/bin/bash
# ccpoke-version: ${version}
CCPOKE_HOST="\${CCPOKE_HOST:-localhost}"
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | grep -o '"tool_name":"[^"]*"' | head -1 | cut -d'"' -f4)
[ "$TOOL_NAME" != "AskUserQuestion" ] && exit 0

SESSION_ID=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -z "$SESSION_ID" ] && exit 0

TMUX_TARGET=""
if [ -n "$TMUX_PANE" ]; then
  TMUX_TARGET=$(tmux display-message -t "$TMUX_PANE" -p '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null || echo "")
elif [ -n "$TMUX" ]; then
  TMUX_TARGET=$(tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null || echo "")
fi

if [ -n "$TMUX_TARGET" ] && echo "$TMUX_TARGET" | grep -qE '^[a-zA-Z0-9_.:/@ -]+$'; then
  PAYLOAD=$(echo "$INPUT" | sed 's/}$/,"tmux_target":"'"$TMUX_TARGET"'"}/')
else
  PAYLOAD="$INPUT"
fi

echo "$PAYLOAD" | curl -s -X POST "http://$CCPOKE_HOST:${hookPort}${ApiRoute.HookAskUserQuestion}" \\
  -H "Content-Type: application/json" \\
  -H "X-CCPoke-Secret: ${hookSecret}" \\
  --data-binary @- \\
  --max-time 3 > /dev/null 2>&1 || true
`;

    writeFileSync(paths.claudeCodePreToolUseScript, script, { mode: 0o700 });
  }

  private static writePermissionRequestScript(hookPort: number, hookSecret: string): void {
    mkdirSync(paths.hooksDir, { recursive: true });

    const version = getPackageVersion();

    if (isWindows()) {
      writeFileSync(
        paths.claudeCodePermissionRequestScript,
        buildWindowsHookScript(version, hookPort, ApiRoute.HookPermissionRequest, hookSecret),
        { mode: 0o644 }
      );
      return;
    }
    const script = `#!/bin/bash
# ccpoke-version: ${version}
CCPOKE_HOST="\${CCPOKE_HOST:-localhost}"
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | grep -o '"tool_name":"[^"]*"' | head -1 | cut -d'"' -f4)
[ "$TOOL_NAME" = "AskUserQuestion" ] && exit 0

SESSION_ID=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -z "$SESSION_ID" ] && exit 0

TMUX_TARGET=""
if [ -n "$TMUX_PANE" ]; then
  TMUX_TARGET=$(tmux display-message -t "$TMUX_PANE" -p '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null || echo "")
elif [ -n "$TMUX" ]; then
  TMUX_TARGET=$(tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null || echo "")
fi

if [ -n "$TMUX_TARGET" ] && echo "$TMUX_TARGET" | grep -qE '^[a-zA-Z0-9_.:/@ -]+$'; then
  PAYLOAD=$(echo "$INPUT" | sed 's/}$/,"tmux_target":"'"$TMUX_TARGET"'"}/')
else
  PAYLOAD="$INPUT"
fi

echo "$PAYLOAD" | curl -s -X POST "http://$CCPOKE_HOST:${hookPort}${ApiRoute.HookPermissionRequest}" \\
  -H "Content-Type: application/json" \\
  -H "X-CCPoke-Secret: ${hookSecret}" \\
  --data-binary @- \\
  --max-time 3 > /dev/null 2>&1 || true
`;

    writeFileSync(paths.claudeCodePermissionRequestScript, script, { mode: 0o700 });
  }

  private static removeStopScript(): void {
    try {
      unlinkSync(paths.claudeCodeHookScript);
    } catch {
      /* may not exist */
    }
  }

  private static removeSessionStartScript(): void {
    try {
      unlinkSync(paths.claudeCodeSessionStartScript);
    } catch {
      /* may not exist */
    }
  }

  private static removeNotificationScript(): void {
    try {
      unlinkSync(paths.claudeCodeNotificationScript);
    } catch {
      /* may not exist */
    }
  }

  private static removePreToolUseScript(): void {
    try {
      unlinkSync(paths.claudeCodePreToolUseScript);
    } catch {
      /* may not exist */
    }
  }

  private static removePermissionRequestScript(): void {
    try {
      unlinkSync(paths.claudeCodePermissionRequestScript);
    } catch {
      /* may not exist */
    }
  }

  private static removeFromSettings(): void {
    const settings = ClaudeCodeInstaller.readSettings();
    if (!settings.hooks) return;

    const hooks = settings.hooks as Record<string, ClaudeHookEntry[]>;
    for (const hookType of Object.keys(hooks)) {
      const entries = hooks[hookType];
      if (!Array.isArray(entries)) continue;

      const filtered = entries.filter(
        (entry) =>
          !entry.hooks?.some((h) => typeof h.command === "string" && h.command.includes("ccpoke"))
      );

      if (filtered.length === 0) {
        delete hooks[hookType];
      } else {
        hooks[hookType] = filtered;
      }
    }

    if (Object.keys(hooks).length === 0) {
      delete settings.hooks;
    }

    const tmpSettings = `${paths.claudeSettings}.tmp`;
    writeFileSync(tmpSettings, JSON.stringify(settings, null, 2));
    renameSync(tmpSettings, paths.claudeSettings);
  }

  private static readSettings(): ClaudeSettings {
    try {
      return JSON.parse(readFileSync(paths.claudeSettings, "utf-8"));
    } catch (err: unknown) {
      const isFileNotFound =
        err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
      if (isFileNotFound) return {};
      throw err;
    }
  }
}
