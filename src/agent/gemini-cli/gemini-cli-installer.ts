import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { isWindows } from "../../utils/constants.js";
import { getPackageVersion, paths, toPosixPath } from "../../utils/paths.js";
import { buildWindowsHookScript } from "../../utils/windows-hook-script-builder.js";
import {
  buildHookConfigs,
  hasCcpokeHook,
  isScriptCurrent,
  isScriptPresent,
  readGeminiSettings,
  type HookEventConfig,
} from "./gemini-cli-settings.js";

export class GeminiCliInstaller {
  static isInstalled(): boolean {
    try {
      const settings = readGeminiSettings();
      if (!settings.hooks) return false;
      return buildHookConfigs().every((cfg) => hasCcpokeHook(settings.hooks?.[cfg.event] ?? []));
    } catch {
      return false;
    }
  }

  static verifyIntegrity(): { complete: boolean; missing: string[] } {
    const missing: string[] = [];

    try {
      const settings = readGeminiSettings();
      for (const cfg of buildHookConfigs()) {
        if (!hasCcpokeHook(settings.hooks?.[cfg.event] ?? []))
          missing.push(`${cfg.event} hook in settings`);
      }
    } catch {
      missing.push("settings.json");
    }

    for (const cfg of buildHookConfigs()) {
      if (!isScriptPresent(cfg.scriptPath)) {
        missing.push(`${cfg.hookName} script file`);
      } else if (!isScriptCurrent(cfg.scriptPath)) {
        missing.push(`outdated ${cfg.hookName} script`);
      }
    }

    return { complete: missing.length === 0, missing };
  }

  static install(hookPort: number, hookSecret: string): void {
    GeminiCliInstaller.uninstall();

    const settings = readGeminiSettings();
    if (!settings.hooks) settings.hooks = {};

    for (const cfg of buildHookConfigs()) {
      const existing = (settings.hooks[cfg.event] ?? []).filter((e) => !hasCcpokeHook([e]));
      existing.push({
        matcher: cfg.matcher,
        hooks: [
          {
            name: cfg.hookName,
            type: "command",
            command: toPosixPath(cfg.scriptPath),
            timeout: cfg.timeout,
          },
        ],
      });
      settings.hooks[cfg.event] = existing;
    }

    mkdirSync(dirname(paths.geminiSettings), { recursive: true });
    const tmp = `${paths.geminiSettings}.tmp`;
    writeFileSync(tmp, JSON.stringify(settings, null, 2));
    renameSync(tmp, paths.geminiSettings);

    for (const cfg of buildHookConfigs()) {
      GeminiCliInstaller.writeScript(cfg, hookPort, hookSecret);
    }
  }

  static uninstall(): void {
    GeminiCliInstaller.removeFromSettings();
    for (const cfg of buildHookConfigs()) {
      GeminiCliInstaller.removeScript(cfg.scriptPath);
    }
  }

  private static writeScript(cfg: HookEventConfig, hookPort: number, hookSecret: string): void {
    mkdirSync(paths.hooksDir, { recursive: true });

    const version = getPackageVersion();

    if (isWindows()) {
      writeFileSync(
        cfg.scriptPath,
        buildWindowsHookScript(version, hookPort, cfg.route, hookSecret),
        { mode: 0o644 }
      );
      return;
    }

    const script = `#!/bin/bash
# ccpoke-version: ${version}
CCPOKE_HOST="\${CCPOKE_HOST:-localhost}"
INPUT=$(cat)
echo '{}'
(
TMUX_TARGET=""
if [ -n "$TMUX_PANE" ]; then
  TMUX_TARGET=$(tmux display-message -t "$TMUX_PANE" -p '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null || echo "")
elif [ -n "$TMUX" ]; then
  TMUX_TARGET=$(tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null || echo "")
fi
if [ -n "$TMUX_TARGET" ] && echo "$TMUX_TARGET" | grep -qE '^[a-zA-Z0-9_.:/@ -]+$'; then
  ESCAPED_TARGET=$(printf '%s' "$TMUX_TARGET" | sed 's/[&/\\\\]/\\\\&/g')
  INPUT=$(echo "$INPUT" | sed 's/}$/,"tmux_target":"'"$ESCAPED_TARGET"'"}/')
fi
echo "$INPUT" | curl -s -X POST "http://$CCPOKE_HOST:${hookPort}${cfg.route}" \\
  -H "Content-Type: application/json" \\
  -H "X-CCPoke-Secret: ${hookSecret}" \\
  --data-binary @- --max-time 5 > /dev/null 2>&1 || true
) &
`;

    writeFileSync(cfg.scriptPath, script, { mode: 0o700 });
  }

  private static removeScript(scriptPath: string): void {
    try {
      unlinkSync(scriptPath);
    } catch {
      /* may not exist */
    }
  }

  private static removeFromSettings(): void {
    try {
      const settings = readGeminiSettings();
      if (!settings.hooks) return;

      for (const event of Object.keys(settings.hooks)) {
        const entries = settings.hooks[event];
        if (!entries) continue;

        const filtered = entries.filter((e) => !hasCcpokeHook([e]));
        if (filtered.length === 0) {
          delete settings.hooks[event];
        } else {
          settings.hooks[event] = filtered;
        }
      }

      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }

      const tmp = `${paths.geminiSettings}.tmp`;
      writeFileSync(tmp, JSON.stringify(settings, null, 2));
      renameSync(tmp, paths.geminiSettings);
    } catch {
      /* settings may not exist */
    }
  }
}
