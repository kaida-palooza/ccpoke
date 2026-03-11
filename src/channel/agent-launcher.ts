import { execSync } from "node:child_process";

import { AgentName } from "../agent/types.js";
import { getTmuxBinary, type TmuxBridge } from "../tmux/tmux-bridge.js";
import { isWindows } from "../utils/constants.js";
import { logger } from "../utils/log.js";
import { escapeShellArg } from "../utils/shell.js";

const AGENT_START_COMMANDS: Record<string, string> = {
  [AgentName.ClaudeCode]: "claude --dangerously-skip-permissions",
  [AgentName.Cursor]: "cursor agent --force",
  [AgentName.Codex]: "codex --full-auto",
  [AgentName.GeminiCli]: "gemini --yolo",
  [AgentName.OpenCode]: "opencode",
};

export function launchAgent(
  tmuxBridge: TmuxBridge,
  projectPath: string,
  agentKey: string
): { paneTarget: string; needsTrust: boolean } {
  const startCommand =
    AGENT_START_COMMANDS[agentKey] ?? AGENT_START_COMMANDS[AgentName.ClaudeCode]!;
  const tmuxSession = getTmuxSessionName();
  const paneTarget = tmuxBridge.createPane(tmuxSession, projectPath);
  tmuxBridge.sendKeys(paneTarget, startCommand, ["Enter"]);
  const needsTrust =
    agentKey === AgentName.ClaudeCode ||
    agentKey === AgentName.Cursor ||
    agentKey === AgentName.GeminiCli;
  return { paneTarget, needsTrust };
}

export function autoAcceptStartupPrompts(
  tmuxBridge: TmuxBridge,
  paneTarget: string,
  agentKey: string,
  onInterval: (interval: ReturnType<typeof setInterval>) => void,
  onClear: (interval: ReturnType<typeof setInterval>) => void
): void {
  let attempts = 0;
  const maxAttempts = 20;
  let bypassHandled = false;
  let trustHandled = false;

  const interval = setInterval(() => {
    attempts++;
    if (attempts > maxAttempts || (bypassHandled && trustHandled)) {
      clearInterval(interval);
      onClear(interval);
      return;
    }
    try {
      const content = tmuxBridge.capturePane(paneTarget, 20);

      if (!bypassHandled && tryAcceptBypassPermissions(tmuxBridge, paneTarget, content, agentKey)) {
        bypassHandled = true;
        return;
      }

      if (!trustHandled && content.includes("Trust")) {
        tmuxBridge.sendSpecialKey(paneTarget, "Enter");
        logger.debug(`[AgentLauncher] auto-trusted workspace at ${paneTarget} for ${agentKey}`);
        trustHandled = true;
      }
    } catch {
      clearInterval(interval);
      onClear(interval);
    }
  }, 1000);

  onInterval(interval);
}

function tryAcceptBypassPermissions(
  tmuxBridge: TmuxBridge,
  paneTarget: string,
  content: string,
  agentKey: string
): boolean {
  if (!content.includes("Bypass Permissions") && !content.includes("Yes, I accept")) {
    return false;
  }

  const lines = content.split("\n");
  const acceptLine = findOptionLine(lines, "Yes, I accept");
  const cursorLine = findCursorLine(lines);

  if (acceptLine === -1) return false;

  if (cursorLine === -1) {
    tmuxBridge.sendSpecialKey(paneTarget, "Enter");
  } else {
    const offset = acceptLine - cursorLine;
    navigateToOption(tmuxBridge, paneTarget, offset);
  }

  logger.debug(`[AgentLauncher] auto-accepted bypass permissions at ${paneTarget} for ${agentKey}`);
  return true;
}

function findOptionLine(lines: string[], optionText: string): number {
  return lines.findIndex((line) => line.includes(optionText));
}

function findCursorLine(lines: string[]): number {
  return lines.findIndex((line) => /^\s*[›>❯]/.test(line));
}

function navigateToOption(tmuxBridge: TmuxBridge, paneTarget: string, offset: number): void {
  const key = offset > 0 ? "Down" : "Up";
  const steps = Math.abs(offset);
  for (let i = 0; i < steps; i++) {
    tmuxBridge.sendSpecialKey(paneTarget, key);
  }
  tmuxBridge.sendSpecialKey(paneTarget, "Enter");
}

function getTmuxSessionName(): string {
  const bin = getTmuxBinary();
  if (process.env.TMUX) {
    try {
      return execSync(`${bin} display-message -p ${escapeShellArg("#{session_name}")}`, {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 3000,
      }).trim();
    } catch {
      /* fall through */
    }
  }

  try {
    if (isWindows()) {
      const output = execSync(`${bin} ls`, {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 3000,
      }).trim();
      const match = output.split("\n")[0]?.match(/^(\S+?):/);
      return match?.[1] || "0";
    }

    const output = execSync(`${bin} list-sessions -F ${escapeShellArg("#{session_name}")}`, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 3000,
    }).trim();
    const first = output.split("\n")[0];
    return first || "0";
  } catch {
    return "0";
  }
}
