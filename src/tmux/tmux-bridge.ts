import { execSync } from "node:child_process";

import { isAgentIdleByProcess, type ProcessTree } from "./tmux-scanner.js";

export class TmuxBridge {
  private available: boolean | null = null;

  isTmuxAvailable(): boolean {
    if (this.available !== null) return this.available;
    try {
      execSync("tmux -V", { stdio: "pipe" });
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  sendKeys(target: string, text: string, submitKeys: string[]): void {
    const tgt = escapeShellArg(target);
    const collapsed = text.replace(/\n+/g, " ").trim();
    if (collapsed.length === 0) return;

    const escaped = escapeTmuxText(collapsed);
    execSync(`tmux send-keys -t ${tgt} -l ${escaped}`, {
      stdio: "pipe",
      timeout: 5000,
    });
    execSync("sleep 0.1", { stdio: "pipe", timeout: 2000 });
    for (let i = 0; i < submitKeys.length; i++) {
      if (i > 0) execSync("sleep 0.15", { stdio: "pipe", timeout: 2000 });
      execSync(`tmux send-keys -t ${tgt} ${escapeShellArg(submitKeys[i]!)}`, {
        stdio: "pipe",
        timeout: 5000,
      });
    }
  }

  /** Send text without trailing Enter — caller controls submission */
  sendText(target: string, text: string): void {
    const tgt = escapeShellArg(target);
    const collapsed = text.replace(/\n+/g, " ").trim();
    if (collapsed.length === 0) return;

    const escaped = escapeTmuxText(collapsed);
    execSync(`tmux send-keys -t ${tgt} -l ${escaped}`, {
      stdio: "pipe",
      timeout: 5000,
    });
  }

  sendSpecialKey(
    target: string,
    key: "Down" | "Up" | "Space" | "Enter" | "Right" | "Left" | "Escape"
  ): void {
    const tgt = escapeShellArg(target);
    execSync(`tmux send-keys -t ${tgt} ${key}`, {
      stdio: "pipe",
      timeout: 5000,
    });
  }

  capturePane(target: string, lines = 50): string {
    const tgt = escapeShellArg(target);
    return execSync(`tmux capture-pane -t ${tgt} -p -S -${lines}`, {
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
    try {
      const panePid = execSync(
        `tmux display-message -t ${escapeShellArg(target)} -p '#{pane_pid}'`,
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
    const dir = escapeShellArg(cwd);

    if (!this.hasRunningSession(sessionName)) {
      const name = escapeShellArg(sessionName);
      return execSync(
        `tmux new-session -d -s ${name} -c ${dir} -P -F '#{session_name}:#{window_index}.#{pane_index}'`,
        { encoding: "utf-8", stdio: "pipe", timeout: 5000 }
      ).trim();
    }

    const target = escapeShellArg(`${sessionName}:0`);
    const paneTarget = execSync(
      `tmux split-window -t ${target} -c ${dir} -P -F '#{session_name}:#{window_index}.#{pane_index}'`,
      { encoding: "utf-8", stdio: "pipe", timeout: 5000 }
    ).trim();

    execSync(`tmux select-layout -t ${target} tiled`, {
      stdio: "pipe",
      timeout: 3000,
    });

    return paneTarget;
  }

  private hasRunningSession(sessionName: string): boolean {
    try {
      execSync(`tmux has-session -t ${escapeShellArg(sessionName)}`, {
        stdio: "pipe",
        timeout: 3000,
      });
      return true;
    } catch {
      return false;
    }
  }

  killPane(target: string): void {
    const tgt = escapeShellArg(target);
    execSync(`tmux kill-pane -t ${tgt}`, { stdio: "pipe", timeout: 5000 });
  }
}

function escapeTmuxText(text: string): string {
  const escaped = text
    .replace(/\r/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
    .replace(/;/g, "\\;");
  return `"${escaped}"`;
}

export function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
