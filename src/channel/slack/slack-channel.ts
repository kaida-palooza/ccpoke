import { hostname } from "node:os";

import { WebClient } from "@slack/web-api";

import type {
  AskUserQuestionEvent,
  NotificationEvent,
  PermissionRequestEvent,
} from "../../agent/agent-handler.js";
import type { Config } from "../../config-manager.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/log.js";
import type { ChannelDeps, NotificationChannel, NotificationData } from "../types.js";
import { buildNotificationBlocks } from "./slack-block-builder.js";
import { SlackSender } from "./slack-sender.js";

export class SlackChannel implements NotificationChannel {
  private client: WebClient | null = null;
  private sender: SlackSender | null = null;

  constructor(
    private cfg: Config,
    _deps?: ChannelDeps
  ) {}

  async initialize(): Promise<void> {
    if (!this.cfg.slack_bot_token || !this.cfg.slack_channel_id) {
      throw new Error("[Slack] slack_bot_token and slack_channel_id are required");
    }

    this.client = new WebClient(this.cfg.slack_bot_token);

    try {
      await this.client.auth.test();
      logger.info("[Slack] connected");
    } catch (err) {
      logger.error({ err }, "[Slack] auth.test failed");
      throw err;
    }

    this.sender = new SlackSender(this.client, this.cfg.slack_channel_id);
    await this.sender
      .sendMessage(t("bot.startupReadyPlain", { host: hostname() }), [])
      .catch(() => {});
  }

  async shutdown(): Promise<void> {}

  async sendNotification(data: NotificationData, responseUrl?: string): Promise<void> {
    if (!this.sender) {
      logger.error("[Slack] not initialized");
      return;
    }

    const blocks = buildNotificationBlocks(data, responseUrl);
    const text = `${data.projectName} — ${data.agentDisplayName}`;
    await this.sender.sendMessage(text, blocks);
  }

  handleNotificationEvent(_event: NotificationEvent): void {}

  handleAskUserQuestionEvent(_event: AskUserQuestionEvent): void {}

  handlePermissionRequestEvent(_event: PermissionRequestEvent): void {}
}
