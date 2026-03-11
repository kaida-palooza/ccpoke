import { existsSync } from "node:fs";

import { t } from "../../i18n/index.js";
import { collectGitChanges } from "../../utils/git-collector.js";
import { logger } from "../../utils/log.js";
import { paths } from "../../utils/paths.js";
import {
  AGENT_DISPLAY_NAMES,
  AgentName,
  type AgentEventResult,
  type AgentProvider,
} from "../types.js";
import { claudeCodeInstaller } from "./claude-code-installer.js";
import { extractProjectName, isValidStopEvent, parseTranscript } from "./claude-code-parser.js";

const TRANSCRIPT_SETTLE_DELAY_MS = 500;

export class ClaudeCodeProvider implements AgentProvider {
  readonly name = AgentName.ClaudeCode;
  readonly displayName = AGENT_DISPLAY_NAMES[AgentName.ClaudeCode];
  readonly settleDelayMs = TRANSCRIPT_SETTLE_DELAY_MS;
  readonly submitKeys = ["Enter"];

  detect(): boolean {
    return existsSync(paths.claudeDir);
  }

  isHookInstalled(): boolean {
    return claudeCodeInstaller.isInstalled();
  }

  installHook(): void {
    claudeCodeInstaller.install();
  }

  uninstallHook(): void {
    claudeCodeInstaller.uninstall();
  }

  verifyIntegrity(): { complete: boolean; missing: string[] } {
    return claudeCodeInstaller.verifyIntegrity();
  }

  parseEvent(raw: unknown): AgentEventResult {
    if (!isValidStopEvent(raw)) {
      return this.createFallbackResult(raw);
    }

    let summary = {
      lastAssistantMessage: "",
      model: "",
    };

    try {
      summary = parseTranscript(raw.transcript_path);
    } catch (err: unknown) {
      logger.error({ err }, t("hook.transcriptFailed"));
    }

    const gitChanges = collectGitChanges(raw.cwd);

    const obj = raw as unknown as Record<string, unknown>;
    const tmuxTarget = typeof obj.tmux_target === "string" ? obj.tmux_target : undefined;

    return {
      projectName: extractProjectName(raw.cwd, raw.transcript_path),
      responseSummary: summary.lastAssistantMessage,
      gitChanges,
      model: summary.model,
      agentSessionId: raw.session_id,
      cwd: raw.cwd,
      tmuxTarget,
    };
  }

  private createFallbackResult(raw: unknown): AgentEventResult {
    const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const cwd = typeof obj.cwd === "string" ? obj.cwd : "";
    const transcriptPath = typeof obj.transcript_path === "string" ? obj.transcript_path : "";
    const tmuxTarget = typeof obj.tmux_target === "string" ? obj.tmux_target : undefined;

    return {
      projectName: cwd ? extractProjectName(cwd, transcriptPath) : "unknown",
      responseSummary: "",
      gitChanges: cwd ? collectGitChanges(cwd) : [],
      model: "",
      agentSessionId: typeof obj.session_id === "string" ? obj.session_id : undefined,
      cwd,
      tmuxTarget,
    };
  }
}
