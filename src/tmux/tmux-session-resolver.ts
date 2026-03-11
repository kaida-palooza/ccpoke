import type { ChatSessionResolver } from "../agent/chat-session-resolver.js";
import { logger } from "../utils/log.js";
import type { SessionMap } from "./session-map.js";
import type { SessionStateManager } from "./session-state.js";

const MAX_AGENT_CACHE = 100;

export class TmuxSessionResolver implements ChatSessionResolver {
  private agentToTmux = new Map<string, string>();

  constructor(
    private sessionMap: SessionMap,
    private stateManager: SessionStateManager
  ) {}

  resolveSessionId(
    agentSessionId: string,
    projectName: string,
    cwd?: string,
    tmuxTarget?: string
  ): string | undefined {
    logger.debug(
      `[Resolver] input: agentSessionId=${agentSessionId} project=${projectName} cwd=${cwd ?? "NONE"} tmuxTarget=${tmuxTarget ?? "NONE"}`
    );

    if (agentSessionId) {
      const cached = this.agentToTmux.get(agentSessionId);
      if (cached && this.sessionMap.getBySessionId(cached)) {
        logger.debug(`[Resolver] matched by cache: ${agentSessionId} → ${cached}`);
        return cached;
      }
      this.agentToTmux.delete(agentSessionId);
    }

    if (tmuxTarget) {
      const exactMatch = this.findByTmuxTarget(tmuxTarget);
      if (exactMatch) {
        if (agentSessionId) this.cacheAgent(agentSessionId, exactMatch);
        logger.debug(`[Resolver] matched by tmuxTarget: ${tmuxTarget} → ${exactMatch}`);
        return exactMatch;
      }
      logger.debug(`[Resolver] NO match for tmuxTarget=${tmuxTarget}`);
    }

    const tmuxSessionId = this.findByProject(projectName, cwd);
    if (tmuxSessionId && agentSessionId) {
      this.cacheAgent(agentSessionId, tmuxSessionId);
    }
    logger.debug(`[Resolver] matched by project: ${projectName} → ${tmuxSessionId ?? "NONE"}`);
    return tmuxSessionId;
  }

  resolveOrRegister(
    agentSessionId: string,
    projectName: string,
    cwd: string | undefined,
    tmuxTarget: string
  ): string {
    const existing = this.findByTmuxTarget(tmuxTarget);
    if (existing) {
      if (agentSessionId) this.cacheAgent(agentSessionId, existing);
      return existing;
    }
    const syntheticId = `tmux-${tmuxTarget.replace(/[:.]/g, "-")}`;
    this.sessionMap.register(syntheticId, tmuxTarget, projectName, cwd ?? "");
    if (agentSessionId) this.cacheAgent(agentSessionId, syntheticId);
    return syntheticId;
  }

  onStopHook(sessionId: string, model?: string): void {
    this.stateManager.onStopHook(sessionId, model);
  }

  resolveTmuxTarget(sessionId: string): string | undefined {
    return this.sessionMap.getBySessionId(sessionId)?.tmuxTarget;
  }

  private findByTmuxTarget(tmuxTarget: string): string | undefined {
    for (const session of this.sessionMap.getAllActive()) {
      if (session.tmuxTarget === tmuxTarget) {
        logger.info(`session linked by tmux_target: ${session.sessionId} (${tmuxTarget})`);
        return session.sessionId;
      }
    }
    return undefined;
  }

  private cacheAgent(agentSessionId: string, tmuxSessionId: string): void {
    this.agentToTmux.set(agentSessionId, tmuxSessionId);
    if (this.agentToTmux.size > MAX_AGENT_CACHE) {
      const oldest = this.agentToTmux.keys().next().value;
      if (oldest) this.agentToTmux.delete(oldest);
    }
  }

  private findByProject(projectName: string, cwd?: string): string | undefined {
    const matches = this.sessionMap.getByProject(projectName);
    if (matches.length === 0) return undefined;

    const existing =
      (cwd && matches.length > 1 ? matches.find((s) => s.cwd === cwd) : undefined) ?? matches[0]!;
    logger.info(`session linked: ${existing.sessionId} (${projectName})`);
    return existing.sessionId;
  }
}
