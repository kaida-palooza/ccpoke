import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { HookScriptCopier } from "../../hooks/hook-script-copier.js";
import { isWindows } from "../../utils/constants.js";
import { paths, toPosixPath } from "../../utils/paths.js";

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

const SCRIPT_MAP = [
  { source: "claude-code-stop", target: () => paths.claudeCodeHookScript },
  { source: "claude-code-session-start", target: () => paths.claudeCodeSessionStartScript },
  { source: "claude-code-notification", target: () => paths.claudeCodeNotificationScript },
  { source: "claude-code-pretooluse", target: () => paths.claudeCodePreToolUseScript },
  {
    source: "claude-code-permission-request",
    target: () => paths.claudeCodePermissionRequestScript,
  },
] as const;

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

    const ext = isWindows() ? ".cmd" : ".sh";
    for (const entry of SCRIPT_MAP) {
      const targetPath = entry.target();
      if (!existsSync(targetPath)) {
        missing.push(`${entry.source} script file`);
      } else if (HookScriptCopier.needsCopy(`${entry.source}${ext}`, targetPath)) {
        missing.push(`outdated ${entry.source} script`);
      }
    }

    return { complete: missing.length === 0, missing };
  }

  static install(): void {
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

    ClaudeCodeInstaller.copyScripts();
  }

  static uninstall(): void {
    ClaudeCodeInstaller.removeFromSettings();
    for (const entry of SCRIPT_MAP) {
      HookScriptCopier.remove(entry.target());
    }
  }

  private static copyScripts(): void {
    HookScriptCopier.copyLib();
    const ext = isWindows() ? ".cmd" : ".sh";
    for (const entry of SCRIPT_MAP) {
      HookScriptCopier.copy(`${entry.source}${ext}`, entry.target());
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
