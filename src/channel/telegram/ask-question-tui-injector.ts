import type { AskUserQuestionItem } from "../../agent/agent-handler.js";
import { AgentName } from "../../agent/types.js";
import type { TmuxBridge } from "../../tmux/tmux-bridge.js";
import { logger } from "../../utils/log.js";

export interface InjectionAnswer {
  indices: number[];
}

const KEY_DELAY_MS = 80;
const SPACE_SETTLE_MS = 100;

export class AskQuestionTuiInjector {
  constructor(private tmuxBridge: TmuxBridge) {}

  async injectSingleSelect(
    target: string,
    _q: AskUserQuestionItem,
    answer: InjectionAnswer,
    agent?: string
  ): Promise<void> {
    if (answer.indices.length > 0) {
      const targetIdx = answer.indices[0]!;
      logger.debug(`[Inject:single] target=${target} idx=${targetIdx} agent=${agent ?? "default"}`);
      for (let i = 0; i < targetIdx; i++) {
        await this.delayedKey(target, "Down");
      }
      await this.delayedKey(target, "Enter");
    }
  }

  async injectMultiSelect(
    target: string,
    q: AskUserQuestionItem,
    answer: InjectionAnswer,
    agent?: string
  ): Promise<void> {
    const isOpenCode = agent === AgentName.OpenCode;
    const toggleKey = isOpenCode ? "Enter" : "Space";
    const sorted = [...answer.indices].sort((a, b) => a - b);
    let currentPos = 0;

    logger.debug(
      `[Inject:multi] target=${target} agent=${agent ?? "default"} toggleKey=${toggleKey} indices=[${sorted.join(",")}]`
    );

    for (const idx of sorted) {
      const moves = idx - currentPos;
      for (let i = 0; i < moves; i++) {
        await this.delayedKey(target, "Down");
      }
      await this.delayedKey(target, toggleKey);
      await delay(SPACE_SETTLE_MS);
      currentPos = idx;
    }

    if (isOpenCode) {
      await this.delayedKey(target, "Right");
    } else {
      const totalOptions = q.options.length;
      const stepsToNext = totalOptions - currentPos + 1;
      for (let i = 0; i < stepsToNext; i++) {
        await this.delayedKey(target, "Down");
      }
      await this.delayedKey(target, "Enter");
    }
  }

  async waitForTui(target: string, timeoutMs = 5000): Promise<boolean> {
    return this.tmuxBridge.waitForTuiReady(target, timeoutMs);
  }

  sendEnter(target: string): void {
    this.tmuxBridge.sendSpecialKey(target, "Enter");
  }

  private async delayedKey(
    target: string,
    key: "Down" | "Up" | "Space" | "Enter" | "Right" | "Left"
  ): Promise<void> {
    this.tmuxBridge.sendSpecialKey(target, key);
    await delay(KEY_DELAY_MS);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
