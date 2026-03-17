import { execSync } from "node:child_process";

import { isWindows } from "../utils/constants.js";
import { logger } from "../utils/log.js";
import { busyWaitMs, escapeShellArg } from "../utils/shell.js";
import { isAgentIdleByProcess, type ProcessTree } from "./tmux-scanner.js";

let resolvedBinary: string | null = null;

export function resetTmuxBinaryCache(): void {
  resolvedBinary = null;
}

export function getTmuxBinary(): string {
  if (resolvedBinary) return resolvedBinary;
  try {
    execSync("tmux -V", { stdio: "pipe", timeout: 3000 });
    resolvedBinary = "tmux";
    return resolvedBinary;
  } catch {
    if (isWindows()) {
      try {
        execSync("psmux -V", { stdio: "pipe", timeout: 3000 });
        resolvedBinary = "psmux";
        return resolvedBinary;
      } catch {
        /* not available */
      }
    }
    resolvedBinary = "tmux";
    return resolvedBinary;
  }
}

export class TmuxBridge {
  private available: boolean | null = null;
  private paneTargetCache = new Map<string, string>();

  isTmuxAvailable(): boolean {
    if (this.available !== null) return this.available;
    try {
      execSync(`${getTmuxBinary()} -V`, { stdio: "pipe", timeout: 3000 });
      this.available = true;
      return true;
    } catch {
      this.available = false;
      return false;
    }
  }

  resolveTarget(paneId: string): string {
    if (!isWindows() || !paneId.startsWith("%")) return paneId;

    const cached = this.paneTargetCache.get(paneId);
    if (cached) return cached;

    try {
      const bin = getTmuxBinary();
      const fmt = escapeShellArg("#{session_name}:#{window_index}.#{pane_index}");
      const resolved = execSync(
        `${bin} display-message -t ${escapeShellArg(paneId)} -p -F ${fmt}`,
        { encoding: "utf-8", stdio: "pipe", timeout: 3000 }
      ).trim();
      if (resolved) {
        this.paneTargetCache.set(paneId, resolved);
        return resolved;
      }
    } catch {
      logger.debug(`[TmuxBridge] resolveTarget failed for ${paneId}`);
    }
    return paneId;
  }

  invalidateTargetCache(paneId?: string): void {
    if (paneId) {
      this.paneTargetCache.delete(paneId);
    } else {
      this.paneTargetCache.clear();
    }
  }

  sendKeys(target: string, text: string, submitKeys: string[]): void {
    const bin = getTmuxBinary();
    const tgt = escapeShellArg(this.resolveTarget(target));
    const collapsed = text.replace(/\n+/g, " ").trim();
    if (collapsed.length === 0) return;

    const escaped = escapeTmuxText(collapsed);
    execSync(`${bin} send-keys -t ${tgt} -l ${escaped}`, {
      stdio: "pipe",
      timeout: 5000,
    });
    busyWaitMs(100);
    for (let i = 0; i < submitKeys.length; i++) {
      if (i > 0) busyWaitMs(150);
      execSync(
        `${bin} send-keys -t ${escapeShellArg(this.resolveTarget(target))} ${escapeShellArg(submitKeys[i]!)}`,
        {
          stdio: "pipe",
          timeout: 5000,
        }
      );
    }
  }

  sendText(target: string, text: string): void {
    const bin = getTmuxBinary();
    const tgt = escapeShellArg(this.resolveTarget(target));
    const collapsed = text.replace(/\n+/g, " ").trim();
    if (collapsed.length === 0) return;

    const escaped = escapeTmuxText(collapsed);
    execSync(`${bin} send-keys -t ${tgt} -l ${escaped}`, {
      stdio: "pipe",
      timeout: 5000,
    });
  }

  sendSpecialKey(
    target: string,
    key: "Down" | "Up" | "Space" | "Enter" | "Right" | "Left" | "Escape"
  ): void {
    const bin = getTmuxBinary();
    const tgt = escapeShellArg(this.resolveTarget(target));
    execSync(`${bin} send-keys -t ${tgt} ${key}`, {
      stdio: "pipe",
      timeout: 5000,
    });
  }

  capturePane(target: string, lines = 50): string {
    const bin = getTmuxBinary();
    const tgt = escapeShellArg(this.resolveTarget(target));
    return execSync(`${bin} capture-pane -t ${tgt} -p -S -${lines}`, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5000,
    });
  }

  waitForTuiReady(target: string, timeoutMs = 5000): Promise<boolean> {
    const TUI_INDICATORS = [/❯/, /\[ \]/, /\( \)/, /\(●\)/, /\[✓\]/, />/];
    const POLL_INTERVAL = 150;
    const start = Date.now();

    return new Promise((resolve) => {
      const check = () => {
        try {
          const content = this.capturePane(target, 30);
          const ready = TUI_INDICATORS.some((re) => re.test(content));
          if (ready) {
            resolve(true);
            return;
          }
        } catch {
          // pane may not be ready
        }
        if (Date.now() - start >= timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(check, POLL_INTERVAL);
      };
      check();
    });
  }

  isAgentIdle(target: string, tree?: ProcessTree): boolean {
    const bin = getTmuxBinary();
    try {
      const panePid = execSync(
        `${bin} display-message -t ${escapeShellArg(target)} -p ${escapeShellArg("#{pane_pid}")}`,
        {
          encoding: "utf-8",
          stdio: "pipe",
          timeout: 3000,
        }
      ).trim();
      return isAgentIdleByProcess(panePid, undefined, tree);
    } catch {
      return false;
    }
  }

  createPane(sessionName: string, cwd: string): string {
    const bin = getTmuxBinary();
    const dir = escapeShellArg(cwd);
    const formatArg = escapeShellArg("#{pane_id}");

    if (isWindows()) this.ensurePsmuxServer(bin);

    let paneId: string;

    if (!this.hasRunningSession(sessionName)) {
      const name = escapeShellArg(sessionName);
      const timeout = isWindows() ? 10000 : 5000;
      paneId = execSync(`${bin} new-session -d -s ${name} -c ${dir} -P -F ${formatArg}`, {
        encoding: "utf-8",
        stdio: "pipe",
        timeout,
      }).trim();
      if (!paneId) paneId = this.resolvePaneIdFallback(bin, sessionName);
    } else if (isWindows()) {
      const target = escapeShellArg(sessionName);
      paneId = execSync(`${bin} new-window -t ${target} -c ${dir} -P -F ${formatArg}`, {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 5000,
      }).trim();

      if (!paneId) {
        paneId = this.resolveLastPane(bin, sessionName);
      }
    } else {
      const target = escapeShellArg(`${sessionName}:0`);
      paneId = execSync(`${bin} split-window -t ${target} -c ${dir} -P -F ${formatArg}`, {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 5000,
      }).trim();

      if (!paneId) {
        paneId = this.resolveLastPane(bin, sessionName);
      }

      execSync(`${bin} select-layout -t ${target} tiled`, {
        stdio: "pipe",
        timeout: 3000,
      });
    }

    if (isWindows()) {
      this.changePaneCwd(paneId, cwd);
    }

    return paneId;
  }

  private ensurePsmuxServer(bin: string): void {
    try {
      execSync(`${bin} ls`, { stdio: "pipe", timeout: 3000 });
      return;
    } catch {
      // server not running
    }

    logger.debug("[TmuxBridge] psmux server not running, warming up");
    try {
      execSync(`${bin} new-session -d -s __ccpoke_warmup`, {
        stdio: "pipe",
        timeout: 8000,
      });
      busyWaitMs(500);
      try {
        execSync(`${bin} kill-session -t __ccpoke_warmup`, {
          stdio: "pipe",
          timeout: 3000,
        });
      } catch {
        // warmup session may have already been cleaned
      }
      logger.debug("[TmuxBridge] psmux server warmed up");
    } catch (err) {
      logger.debug(
        `[TmuxBridge] psmux warmup failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private resolvePaneIdFallback(bin: string, sessionName: string): string {
    const maxAttempts = isWindows() ? 5 : 1;
    const delayMs = 500;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) busyWaitMs(delayMs);
      try {
        const formatArg = escapeShellArg("#{pane_id}");
        const result = execSync(
          `${bin} list-panes -t ${escapeShellArg(sessionName)} -F ${formatArg}`,
          { encoding: "utf-8", stdio: "pipe", timeout: 3000 }
        )
          .trim()
          .split("\n")
          .pop();
        if (result) return result;
      } catch {
        logger.debug(
          `[TmuxBridge] resolvePaneIdFallback attempt ${attempt + 1}/${maxAttempts} failed`
        );
      }
    }
    return "%0";
  }

  private resolveFirstPane(bin: string, sessionName: string): string {
    try {
      const formatArg = escapeShellArg("#{pane_id}");
      const first = execSync(
        `${bin} list-panes -t ${escapeShellArg(sessionName)} -F ${formatArg}`,
        {
          encoding: "utf-8",
          stdio: "pipe",
          timeout: 3000,
        }
      )
        .trim()
        .split("\n")[0];
      return first || "%0";
    } catch {
      return "%0";
    }
  }

  private resolveLastPane(bin: string, sessionName: string): string {
    try {
      const formatArg = escapeShellArg("#{pane_id}");
      return (
        execSync(`${bin} list-panes -t ${escapeShellArg(sessionName)} -F ${formatArg}`, {
          encoding: "utf-8",
          stdio: "pipe",
          timeout: 3000,
        })
          .trim()
          .split("\n")
          .pop()! || "%0"
      );
    } catch {
      return "%0";
    }
  }

  private changePaneCwd(paneId: string, cwd: string): void {
    const bin = getTmuxBinary();
    const tgt = escapeShellArg(this.resolveTarget(paneId));

    busyWaitMs(200);
    const commands = [`cd /d "${cwd}"`, "cls"];
    for (const cmd of commands) {
      execSync(`${bin} send-keys -t ${tgt} -l ${escapeTmuxText(cmd)}`, {
        stdio: "pipe",
        timeout: 5000,
      });
      execSync(`${bin} send-keys -t ${tgt} Enter`, {
        stdio: "pipe",
        timeout: 5000,
      });
      busyWaitMs(200);
    }
  }

  private hasRunningSession(sessionName: string): boolean {
    const bin = getTmuxBinary();
    try {
      execSync(`${bin} has-session -t ${escapeShellArg(sessionName)}`, {
        stdio: "pipe",
        timeout: 3000,
      });
      return true;
    } catch {
      return false;
    }
  }

  killPane(target: string): void {
    const bin = getTmuxBinary();
    const tgt = escapeShellArg(target);
    execSync(`${bin} kill-pane -t ${tgt}`, { stdio: "pipe", timeout: 5000 });
  }
}

function escapeTmuxText(text: string): string {
  const cleaned = text.replace(/\r/g, "");
  if (isWindows()) {
    const escaped = cleaned.replace(/\\/g, "\\\\").replace(/"/g, '""').replace(/%/g, "%%");
    return `"${escaped}"`;
  }
  const escaped = cleaned
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
    .replace(/;/g, "\\;");
  return `"${escaped}"`;
}
