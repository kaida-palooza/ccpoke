import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { HookScriptCopier } from "../../hooks/hook-script-copier.js";
import { isWindows } from "../../utils/constants.js";
import { paths, toPosixPath } from "../../utils/paths.js";
import {
  buildHookConfigs,
  hasCcpokeHook,
  isScriptCurrent,
  isScriptPresent,
  readGeminiSettings,
} from "./gemini-cli-settings.js";

const GEMINI_SOURCE_MAP: Record<string, string> = {
  "ccpoke-stop": "gemini-stop",
  "ccpoke-session-start": "gemini-session-start",
  "ccpoke-notification": "gemini-notification",
};

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

    const ext = isWindows() ? ".cmd" : ".sh";

    for (const cfg of buildHookConfigs()) {
      const baseName = GEMINI_SOURCE_MAP[cfg.hookName];
      const sourceFile = baseName ? `${baseName}${ext}` : undefined;
      if (!isScriptPresent(cfg.scriptPath)) {
        missing.push(`${cfg.hookName} script file`);
      } else if (sourceFile && !isScriptCurrent(cfg.scriptPath, sourceFile)) {
        missing.push(`outdated ${cfg.hookName} script`);
      }
    }

    return { complete: missing.length === 0, missing };
  }

  static install(): void {
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

    GeminiCliInstaller.copyScripts();
  }

  static uninstall(): void {
    GeminiCliInstaller.removeFromSettings();
    for (const cfg of buildHookConfigs()) {
      HookScriptCopier.remove(cfg.scriptPath);
    }
  }

  private static copyScripts(): void {
    HookScriptCopier.copyLib();
    const ext = isWindows() ? ".cmd" : ".sh";

    for (const cfg of buildHookConfigs()) {
      const baseName = GEMINI_SOURCE_MAP[cfg.hookName];
      const sourceFile = baseName ? `${baseName}${ext}` : undefined;
      if (sourceFile) {
        HookScriptCopier.copy(sourceFile, cfg.scriptPath);
      }
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
