import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { t } from "../../i18n/index.js";
import { collectGitChanges } from "../../utils/git-collector.js";
import { logger } from "../../utils/log.js";
import {
  AGENT_DISPLAY_NAMES,
  AgentName,
  type AgentEventResult,
  type AgentProvider,
} from "../types.js";
import { cursorInstaller } from "./cursor-installer.js";
import {
  extractProjectName,
  isValidStopEvent,
  parseStopEvent,
  parseTranscript,
} from "./cursor-parser.js";
import { readComposerData } from "./cursor-state-reader.js";

export class CursorProvider implements AgentProvider {
  readonly name = AgentName.Cursor;
  readonly displayName = AGENT_DISPLAY_NAMES[AgentName.Cursor];
  readonly settleDelayMs = 0;
  readonly submitKeys = ["Enter"];

  detect(): boolean {
    return existsSync(join(homedir(), ".cursor"));
  }

  isHookInstalled(): boolean {
    return cursorInstaller.isInstalled();
  }

  installHook(): void {
    cursorInstaller.install();
  }

  uninstallHook(): void {
    cursorInstaller.uninstall();
  }

  verifyIntegrity(): { complete: boolean; missing: string[] } {
    return cursorInstaller.verifyIntegrity();
  }

  parseEvent(raw: unknown): AgentEventResult {
    if (!isValidStopEvent(raw)) {
      return this.createFallbackResult(raw);
    }

    const event = parseStopEvent(raw);
    logger.debug(`[Cursor:raw] ${JSON.stringify(raw)}`);

    const composerData = readComposerData(event.conversationId);
    logger.debug(`[Cursor:composer] model=${composerData.model || "NONE"}`);

    let summary = {
      lastAssistantMessage: "",
      model: "",
    };

    try {
      if (event.transcriptPath) {
        summary = parseTranscript(event.transcriptPath);
        logger.debug(
          `[Cursor:transcript] lastMsg=${summary.lastAssistantMessage.slice(0, 80) || "EMPTY"}`
        );
      } else {
        logger.debug(`[Cursor:transcript] SKIPPED — no transcriptPath`);
      }
    } catch (err: unknown) {
      logger.error({ err }, t("hook.transcriptFailed"));
    }

    const gitChanges = collectGitChanges(event.cwd);

    const obj = raw as Record<string, unknown>;
    const tmuxTarget = typeof obj.tmux_target === "string" ? obj.tmux_target : undefined;

    return {
      projectName: extractProjectName(event.cwd, event.transcriptPath),
      responseSummary: summary.lastAssistantMessage,
      gitChanges,
      model: composerData.model || event.model,
      agentSessionId: event.conversationId,
      cwd: event.cwd,
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
      cwd,
      tmuxTarget,
    };
  }
}
