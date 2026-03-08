import { execSync } from "node:child_process";

import { isWindows } from "../utils/constants.js";
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

  sendKeys(target: string, text: string, submitKeys: string[]): void {
    const bin = getTmuxBinary();
    const tgt = escapeShellArg(target);
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
      execSync(`${bin} send-keys -t ${tgt} ${escapeShellArg(submitKeys[i]!)}`, {
        stdio: "pipe",
        timeout: 5000,
      });
    }
  }

  sendText(target: string, text: string): void {
    const bin = getTmuxBinary();
    const tgt = escapeShellArg(target);
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
    const tgt = escapeShellArg(target);
    execSync(`${bin} send-keys -t ${tgt} ${key}`, {
      stdio: "pipe",
      timeout: 5000,
    });
  }

  capturePane(target: string, lines = 50): string {
    const bin = getTmuxBinary();
    const tgt = escapeShellArg(target);
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
    const formatArg = escapeShellArg("#{session_name}:#{window_index}.#{pane_index}");

    let paneTarget: string;

    if (!this.hasRunningSession(sessionName)) {
      const name = escapeShellArg(sessionName);
      paneTarget = execSync(`${bin} new-session -d -s ${name} -c ${dir} -P -F ${formatArg}`, {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 5000,
      }).trim();
    } else {
      const target = escapeShellArg(`${sessionName}:0`);
      paneTarget = execSync(`${bin} split-window -t ${target} -c ${dir} -P -F ${formatArg}`, {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 5000,
      }).trim();

      execSync(`${bin} select-layout -t ${target} tiled`, {
        stdio: "pipe",
        timeout: 3000,
      });
    }

    if (isWindows()) {
      this.changePaneCwd(paneTarget, cwd);
    }

    return paneTarget;
  }

  private changePaneCwd(paneTarget: string, cwd: string): void {
    const bin = getTmuxBinary();
    const tgt = escapeShellArg(paneTarget);

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
