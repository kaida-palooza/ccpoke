import type { KnownBlock, WebClient } from "@slack/web-api";

import { logger } from "../../utils/log.js";

const MAX_BLOCKS_PER_MESSAGE = 50;

export class SlackSender {
  constructor(
    private client: WebClient,
    private channelId: string
  ) {}

  async sendMessage(text: string, blocks: KnownBlock[]): Promise<void> {
    try {
      if (blocks.length <= MAX_BLOCKS_PER_MESSAGE) {
        await this.client.chat.postMessage({ channel: this.channelId, text, blocks });
        return;
      }

      const chunks: KnownBlock[][] = [];
      for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_MESSAGE) {
        chunks.push(blocks.slice(i, i + MAX_BLOCKS_PER_MESSAGE));
      }

      for (let i = 0; i < chunks.length; i++) {
        await this.client.chat.postMessage({
          channel: this.channelId,
          text: i === 0 ? text : "…",
          blocks: chunks[i],
        });
      }
    } catch (err) {
      logger.error({ err }, "[Slack] sendMessage failed");
    }
  }
}
