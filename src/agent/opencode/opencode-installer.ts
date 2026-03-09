import { existsSync, mkdirSync, unlinkSync } from "node:fs";

import { HookScriptCopier } from "../../hooks/hook-script-copier.js";
import { paths } from "../../utils/paths.js";

export class OpencodeInstaller {
  static isInstalled(): boolean {
    return existsSync(paths.opencodePluginFile);
  }

  static verifyIntegrity(): { complete: boolean; missing: string[] } {
    const missing: string[] = [];

    if (!existsSync(paths.opencodePluginFile)) {
      missing.push("ccpoke-notify.js in plugins dir");
    } else if (HookScriptCopier.needsCopy("opencode-notify.js", paths.opencodePluginFile)) {
      missing.push("outdated ccpoke-notify.js");
    }

    return { complete: missing.length === 0, missing };
  }

  static install(): void {
    OpencodeInstaller.uninstall();
    mkdirSync(paths.opencodePluginsDir, { recursive: true });
    HookScriptCopier.copy("opencode-notify.js", paths.opencodePluginFile);
  }

  static uninstall(): void {
    try {
      unlinkSync(paths.opencodePluginFile);
    } catch {
      /* may not exist */
    }
  }
}
