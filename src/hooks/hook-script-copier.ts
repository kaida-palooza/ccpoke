import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { isWindows } from "../utils/constants.js";
import { paths } from "../utils/paths.js";
import { getLockHash, isFileUpToDate } from "./hook-lock.js";

export class HookScriptCopier {
  static copy(sourceFileName: string, targetPath: string): void {
    const sourcePath = join(paths.hookSourceDir, sourceFileName);
    if (!existsSync(sourcePath)) {
      throw new Error(`Hook source file missing: ${sourceFileName}. Reinstall ccpoke.`);
    }
    const content = readFileSync(sourcePath);

    mkdirSync(dirname(targetPath), { recursive: true });
    const tmpPath = `${targetPath}.tmp`;
    const isCmd = sourceFileName.endsWith(".cmd");
    const isJs = sourceFileName.endsWith(".js");
    const mode = isCmd ? 0o644 : isJs ? 0o600 : 0o755;
    writeFileSync(tmpPath, content, { mode });
    renameSync(tmpPath, targetPath);
  }

  static needsCopy(sourceFileName: string, targetPath: string): boolean {
    if (!existsSync(targetPath)) return true;

    const lockHash = getLockHash(paths.projectRoot, sourceFileName);
    if (!lockHash) return true;

    return !isFileUpToDate(targetPath, lockHash);
  }

  static copyLib(): void {
    mkdirSync(paths.hookLibDir, { recursive: true });

    if (isWindows()) {
      HookScriptCopier.copy(join("lib", "common.cmd"), join(paths.hookLibDir, "common.cmd"));
    } else {
      HookScriptCopier.copy(join("lib", "common.sh"), join(paths.hookLibDir, "common.sh"));
    }
  }

  static remove(targetPath: string): void {
    try {
      unlinkSync(targetPath);
    } catch {
      /* may not exist */
    }
  }
}
