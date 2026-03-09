import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

import { isWindows } from "../utils/constants.js";
import { paths } from "../utils/paths.js";

export class HookEnvWriter {
  static write(port: number, secret: string): void {
    mkdirSync(paths.hooksDir, { recursive: true });

    const envContent = `CCPOKE_PORT=${port}\nCCPOKE_SECRET=${secret}\n`;
    const tmpPath = `${paths.hookEnvFile}.tmp`;
    writeFileSync(tmpPath, envContent, { mode: 0o600 });
    renameSync(tmpPath, paths.hookEnvFile);

    if (isWindows()) {
      const cmdContent = `@set CCPOKE_PORT=${port}\n@set CCPOKE_SECRET=${secret}\n`;
      const tmpCmdPath = `${paths.hookEnvCmdFile}.tmp`;
      writeFileSync(tmpCmdPath, cmdContent, { mode: 0o600 });
      renameSync(tmpCmdPath, paths.hookEnvCmdFile);
    }
  }

  static remove(): void {
    try {
      unlinkSync(paths.hookEnvFile);
    } catch {
      /* may not exist */
    }
    try {
      unlinkSync(paths.hookEnvCmdFile);
    } catch {
      /* may not exist */
    }
  }
}
