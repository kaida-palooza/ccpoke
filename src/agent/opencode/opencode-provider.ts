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
import { opencodeInstaller } from "./opencode-installer.js";
import { extractProjectName, isValidOpencodeEvent, parseOpencodeEvent } from "./opencode-parser.js";

export class OpencodeProvider implements AgentProvider {
  readonly name = AgentName.OpenCode;
  readonly displayName = AGENT_DISPLAY_NAMES[AgentName.OpenCode];
  readonly settleDelayMs = 0;
  readonly submitKeys = ["Enter"];

  detect(): boolean {
    return existsSync(paths.opencodeDir);
  }

  isHookInstalled(): boolean {
    return opencodeInstaller.isInstalled();
  }

  installHook(): void {
    opencodeInstaller.install();
  }

  uninstallHook(): void {
    opencodeInstaller.uninstall();
  }

  verifyIntegrity(): { complete: boolean; missing: string[] } {
    return opencodeInstaller.verifyIntegrity();
  }

  parseEvent(raw: unknown): AgentEventResult {
    if (!isValidOpencodeEvent(raw)) {
      return this.createFallbackResult(raw);
    }

    const event = parseOpencodeEvent(raw);
    logger.debug(`[OpenCode:raw] sessionId=${event.sessionId} cwd=${event.cwd}`);

    const gitChanges = event.cwd ? collectGitChanges(event.cwd) : [];
    const obj = raw as Record<string, unknown>;
    const tmuxTarget = typeof obj.tmux_target === "string" ? obj.tmux_target : undefined;

    return {
      projectName: extractProjectName(event.cwd),
      responseSummary: event.promptResponse,
      gitChanges,
      model: event.model,
      agentSessionId: event.sessionId || undefined,
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
