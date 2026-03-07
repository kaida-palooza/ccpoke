import { execSync } from "node:child_process";

import { AgentName } from "../agent/types.js";
import { getTmuxBinary, type TmuxBridge } from "../tmux/tmux-bridge.js";
import { logDebug } from "../utils/log.js";
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
  const needsTrust = agentKey === AgentName.Cursor || agentKey === AgentName.GeminiCli;
  return { paneTarget, needsTrust };
}

export function autoTrustWorkspace(
  tmuxBridge: TmuxBridge,
  paneTarget: string,
  agentKey: string,
  onInterval: (interval: ReturnType<typeof setInterval>) => void,
  onClear: (interval: ReturnType<typeof setInterval>) => void
): void {
  let attempts = 0;
  const maxAttempts = 10;

  const interval = setInterval(() => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(interval);
      onClear(interval);
      return;
    }
    try {
      const content = tmuxBridge.capturePane(paneTarget, 10);
      if (content.includes("Trust")) {
        tmuxBridge.sendSpecialKey(paneTarget, "Enter");
        logDebug(`[AgentLauncher] auto-trusted workspace at ${paneTarget} for ${agentKey}`);
        clearInterval(interval);
        onClear(interval);
      }
    } catch {
      clearInterval(interval);
      onClear(interval);
    }
  }, 1000);

  onInterval(interval);
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
