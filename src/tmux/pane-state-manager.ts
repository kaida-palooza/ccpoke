import type { AgentRegistry } from "../agent/agent-registry.js";
import { logger } from "../utils/log.js";
import { PaneState, type PaneRegistry } from "./pane-registry.js";
import type { TmuxBridge } from "./tmux-bridge.js";
import { checkPaneHealth } from "./tmux-scanner.js";

export type InjectResult =
  | { sent: true }
  | { sentToShell: true }
  | { empty: true }
  | { busy: true }
  | { sessionNotFound: true }
  | { paneDead: true }
  | { noAgent: true };

const MAX_MESSAGE_LENGTH = 10_000;
const SEND_RETRIES = 2;
const RETRY_DELAY_MS = 300;

const sleepBuffer = new SharedArrayBuffer(4);
const sleepArray = new Int32Array(sleepBuffer);

function sleepSync(ms: number): void {
  Atomics.wait(sleepArray, 0, 0, ms);
}

export class PaneStateManager {
  constructor(
    private paneRegistry: PaneRegistry,
    private tmuxBridge: TmuxBridge,
    private registry: AgentRegistry
  ) {}

  injectMessage(paneId: string, text: string): InjectResult {
    const pane = this.paneRegistry.getByPaneId(paneId);
    if (!pane) {
      logger.debug(`[Inject] sessionNotFound: paneId=${paneId}`);
      return { sessionNotFound: true };
    }

    logger.debug(`[Inject] found: paneId=${paneId} state=${pane.state}`);

    const health = checkPaneHealth(paneId);
    if (health.status === "dead") {
      logger.debug(`[Inject] pane dead: paneId=${paneId}`);
      this.paneRegistry.unregister(paneId);
      return { paneDead: true };
    }

    const agentGone = health.status === "no_agent";

    const trimmed = text.trim();
    if (trimmed.length === 0) return { empty: true };

    const safeText =
      trimmed.length > MAX_MESSAGE_LENGTH ? trimmed.slice(0, MAX_MESSAGE_LENGTH) : trimmed;

    if (agentGone) {
      logger.debug(`[Inject] no agent, sending directly to shell: paneId=${paneId}`);
      try {
        this.tmuxBridge.sendText(paneId, safeText);
        this.tmuxBridge.sendSpecialKey(paneId, "Enter");
        this.paneRegistry.touch(paneId);
        return { sentToShell: true };
      } catch (err) {
        logger.debug(`[Inject] direct shell send failed: paneId=${paneId} err=${err}`);
        return { paneDead: true };
      }
    }

    if (pane.state === PaneState.Busy) {
      logger.debug(`[Inject] busy: paneId=${paneId}`);
      return { busy: true };
    }

    const submitKeys = this.registry.resolve(pane.agent)!.submitKeys;
    const sendResult = this.trySendKeys(paneId, safeText, submitKeys);
    if (!sendResult) {
      logger.debug(`[Inject] sendKeys failed after retries: paneId=${paneId}`);
      return { paneDead: true };
    }

    this.paneRegistry.updateState(paneId, PaneState.Busy);
    this.paneRegistry.touch(paneId);
    logger.debug(`[Inject] sent: paneId=${paneId}`);
    return { sent: true };
  }

  onStopHook(paneId: string, model?: string): void {
    this.paneRegistry.updateState(paneId, PaneState.Idle);
    if (model) this.paneRegistry.updateModel(paneId, model);
    this.paneRegistry.touch(paneId);
  }

  private trySendKeys(paneId: string, text: string, submitKeys: string[]): boolean {
    for (let i = 0; i <= SEND_RETRIES; i++) {
      try {
        this.tmuxBridge.sendKeys(paneId, text, submitKeys);
        return true;
      } catch (err) {
        logger.debug(
          `[Inject] sendKeys attempt ${i + 1}/${SEND_RETRIES + 1} failed: paneId=${paneId} err=${err}`
        );
        if (i < SEND_RETRIES) sleepSync(RETRY_DELAY_MS);
      }
    }
    return false;
  }
}
