import { existsSync } from "node:fs";

import { collectGitChanges } from "../../utils/git-collector.js";
import { logger } from "../../utils/log.js";
import { paths } from "../../utils/paths.js";
import {
  AGENT_DISPLAY_NAMES,
  AgentName,
  type AgentEventResult,
  type AgentProvider,
} from "../types.js";
import { codexInstaller } from "./codex-installer.js";
import {
  extractProjectName,
  isValidNotifyEvent,
  parseNotifyEvent,
  parseRolloutFile,
} from "./codex-parser.js";

const ROLLOUT_SETTLE_DELAY_MS = 500;

export class CodexProvider implements AgentProvider {
  readonly name = AgentName.Codex;
  readonly displayName = AGENT_DISPLAY_NAMES[AgentName.Codex];
  readonly settleDelayMs = ROLLOUT_SETTLE_DELAY_MS;
  readonly submitKeys = ["Escape", "Enter"];

  detect(): boolean {
    return existsSync(paths.codexDir);
  }

  isHookInstalled(): boolean {
    return codexInstaller.isInstalled();
  }

  installHook(): void {
    codexInstaller.install();
  }

  uninstallHook(): void {
    codexInstaller.uninstall();
  }

  verifyIntegrity(): { complete: boolean; missing: string[] } {
    return codexInstaller.verifyIntegrity();
  }

  parseEvent(raw: unknown): AgentEventResult {
    if (!isValidNotifyEvent(raw)) {
      return this.createFallbackResult(raw);
    }

    const event = parseNotifyEvent(raw);
    logger.debug(`[Codex:raw] threadId=${event.threadId} cwd=${event.cwd}`);

    let rollout = { model: "" };
    try {
      if (event.threadId) rollout = parseRolloutFile(event.threadId);
    } catch {
      /* noop */
    }

    const gitChanges = event.cwd ? collectGitChanges(event.cwd) : [];
    const obj = raw as Record<string, unknown>;
    const tmuxTarget = typeof obj.tmux_target === "string" ? obj.tmux_target : undefined;

    return {
      projectName: extractProjectName(event.cwd),
      responseSummary: event.lastAssistantMessage,
      gitChanges,
      model: rollout.model,
      agentSessionId: event.threadId || undefined,
      cwd: event.cwd,
      tmuxTarget,
    };
  }

  private createFallbackResult(raw: unknown): AgentEventResult {
    const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const cwd = typeof obj.cwd === "string" ? obj.cwd : "";
    const tmuxTarget = typeof obj.tmux_target === "string" ? obj.tmux_target : undefined;

    return {
      projectName: cwd ? extractProjectName(cwd) : "unknown",
      responseSummary: "",
      gitChanges: cwd ? collectGitChanges(cwd) : [],
      model: "",
      cwd,
      tmuxTarget,
    };
  }
}
