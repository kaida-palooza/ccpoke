import type { AgentRegistry } from "../agent/agent-registry.js";
import { logger } from "../utils/log.js";
import { SessionState, type SessionMap } from "./session-map.js";
import type { TmuxBridge } from "./tmux-bridge.js";
import { isPaneAlive } from "./tmux-scanner.js";

export type InjectResult =
  | { sent: true }
  | { empty: true }
  | { busy: true }
  | { sessionNotFound: true }
  | { tmuxDead: true };

const MAX_MESSAGE_LENGTH = 10_000;
const SEND_RETRIES = 2;
const RETRY_DELAY_MS = 300;

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* busy-wait */
  }
}

export class SessionStateManager {
  constructor(
    private sessionMap: SessionMap,
    private tmuxBridge: TmuxBridge,
    private registry: AgentRegistry
  ) {}

  injectMessage(sessionId: string, text: string): InjectResult {
    let session = this.sessionMap.getBySessionId(sessionId);
    if (!session) session = this.sessionMap.resolveExpired(sessionId);
    if (!session) {
      logger.debug(`[Inject] sessionNotFound: sessionId=${sessionId}`);
      return { sessionNotFound: true };
    }

    logger.debug(
      `[Inject] found: sessionId=${sessionId} tmuxTarget=${session.tmuxTarget} state=${session.state}`
    );

    if (!this.checkPaneAlive(session.tmuxTarget)) {
      logger.debug(`[Inject] pane dead after retries: tmuxTarget=${session.tmuxTarget}`);
      this.sessionMap.unregister(sessionId);
      return { tmuxDead: true };
    }

    const trimmed = text.trim();
    if (trimmed.length === 0) return { empty: true };

    const safeText =
      trimmed.length > MAX_MESSAGE_LENGTH ? trimmed.slice(0, MAX_MESSAGE_LENGTH) : trimmed;

    if (session.state === SessionState.Busy) {
      logger.debug(`[Inject] busy: sessionId=${sessionId}`);
      return { busy: true };
    }

    const submitKeys = this.registry.resolve(session.agent)!.submitKeys;
    const sendResult = this.trySendKeys(session.tmuxTarget, safeText, submitKeys);
    if (!sendResult) {
      logger.debug(`[Inject] sendKeys failed after retries: sessionId=${sessionId}`);
      return { tmuxDead: true };
    }

    this.sessionMap.updateState(sessionId, SessionState.Busy);
    this.sessionMap.touch(sessionId);
    logger.debug(`[Inject] sent: sessionId=${sessionId} tmuxTarget=${session.tmuxTarget}`);
    return { sent: true };
  }

  onStopHook(sessionId: string, model?: string): void {
    this.sessionMap.updateState(sessionId, SessionState.Idle);
    if (model) this.sessionMap.updateModel(sessionId, model);
    this.sessionMap.touch(sessionId);
  }

  private checkPaneAlive(target: string): boolean {
    for (let i = 0; i <= SEND_RETRIES; i++) {
      if (isPaneAlive(target)) return true;
      if (i < SEND_RETRIES) {
        logger.debug(`[Inject] isPaneAlive failed, retry ${i + 1}/${SEND_RETRIES} for ${target}`);
        sleepSync(RETRY_DELAY_MS);
      }
    }
    return false;
  }

  private trySendKeys(target: string, text: string, submitKeys: string[]): boolean {
    for (let i = 0; i <= SEND_RETRIES; i++) {
      try {
        this.tmuxBridge.sendKeys(target, text, submitKeys);
        return true;
      } catch (err) {
        logger.debug(
          `[Inject] sendKeys attempt ${i + 1}/${SEND_RETRIES + 1} failed: target=${target} err=${err}`
        );
        if (i < SEND_RETRIES) sleepSync(RETRY_DELAY_MS);
      }
    }
    return false;
  }
}
