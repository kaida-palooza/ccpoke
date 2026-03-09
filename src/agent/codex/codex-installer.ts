import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { HookScriptCopier } from "../../hooks/hook-script-copier.js";
import { isWindows } from "../../utils/constants.js";
import { paths, toPosixPath } from "../../utils/paths.js";

const NOTIFY_LINE_PATTERN = /^notify\s*=\s*\[([\s\S]*?)\]/m;
const CCPOKE_MARKER = "ccpoke";

function readNotifyArray(content: string): string[] {
  const match = content.match(NOTIFY_LINE_PATTERN);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function writeNotifyLine(entries: string[]): string {
  const quoted = entries.map((e) => `"${e}"`).join(", ");
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

  static install(): void {
    let content = readConfigFile();
    const entries = readNotifyArray(content).filter((e) => !e.includes(CCPOKE_MARKER));
    entries.push(toPosixPath(paths.codexHookScript));

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

    HookScriptCopier.copyLib();
    const ext = isWindows() ? ".cmd" : ".sh";
    HookScriptCopier.copy(`codex-notify${ext}`, paths.codexHookScript);
  }

  static uninstall(): void {
    CodexInstaller.removeFromConfig();
    HookScriptCopier.remove(paths.codexHookScript);
  }

  static verifyIntegrity(): { complete: boolean; missing: string[] } {
    const missing: string[] = [];

    try {
      const entries = readNotifyArray(readConfigFile());
      if (!entries.some((e) => e.includes(CCPOKE_MARKER)))
        missing.push("notify entry in config.toml");
      else if (!entries.includes(toPosixPath(paths.codexHookScript)))
        missing.push("wrong notify script path in config.toml");
    } catch {
      missing.push("config.toml");
    }

    if (!existsSync(paths.codexHookScript)) {
      missing.push("notify script file");
    } else {
      const ext = isWindows() ? ".cmd" : ".sh";
      if (HookScriptCopier.needsCopy(`codex-notify${ext}`, paths.codexHookScript)) {
        missing.push("outdated notify script");
      }
    }

    return { complete: missing.length === 0, missing };
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
