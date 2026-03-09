import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { HookScriptCopier } from "../../hooks/hook-script-copier.js";
import { isWindows } from "../../utils/constants.js";
import { paths, toPosixPath } from "../../utils/paths.js";

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

  static install(): void {
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

    const tmp = `${paths.cursorHooksJson}.tmp`;
    writeFileSync(tmp, JSON.stringify(config, null, 2));
    renameSync(tmp, paths.cursorHooksJson);

    HookScriptCopier.copyLib();
    const ext = isWindows() ? ".cmd" : ".sh";
    HookScriptCopier.copy(`cursor-stop${ext}`, paths.cursorHookScript);
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
    } else {
      const ext = isWindows() ? ".cmd" : ".sh";
      if (HookScriptCopier.needsCopy(`cursor-stop${ext}`, paths.cursorHookScript)) {
        missing.push("outdated stop script");
      }
    }

    return { complete: missing.length === 0, missing };
  }

  static uninstall(): void {
    CursorInstaller.removeFromHooksJson();
    HookScriptCopier.remove(paths.cursorHookScript);
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

    const tmp = `${paths.cursorHooksJson}.tmp`;
    writeFileSync(tmp, JSON.stringify(config, null, 2));
    renameSync(tmp, paths.cursorHooksJson);
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
