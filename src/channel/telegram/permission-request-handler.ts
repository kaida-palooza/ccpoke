import type TelegramBot from "node-telegram-bot-api";

import type { PermissionRequestEvent } from "../../agent/agent-handler.js";
import { t } from "../../i18n/index.js";
import type { SessionMap } from "../../tmux/session-map.js";
import type { TmuxBridge } from "../../tmux/tmux-bridge.js";
import { logger } from "../../utils/log.js";
import { summarizeTool } from "../summarize-tool.js";
import { escapeMarkdownV2 } from "./escape-markdown.js";

interface PendingPermission {
  pendingId: number;
  sessionId: string;
  tmuxTarget: string;
  toolName: string;
  toolSummary: string;
  createdAt: number;
}

const EXPIRE_MS = 10 * 60 * 1000;
const MAX_PENDING = 50;

export class PermissionRequestHandler {
  private pending = new Map<number, PendingPermission>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private nextPendingId = 1;
  private processedCallbacks = new Set<string>();

  constructor(
    private bot: TelegramBot,
    private chatId: () => number | null,
    private sessionMap: SessionMap,
    private tmuxBridge: TmuxBridge
  ) {}

  async forwardPermission(event: PermissionRequestEvent): Promise<void> {
    const chat = this.chatId();
    if (!chat || !event.tmuxTarget) return;

    logger.info(
      `[PermReq] sessionId=${event.sessionId} tmuxTarget=${event.tmuxTarget} tool=${event.toolName}`
    );

    if (this.pending.size >= MAX_PENDING) {
      const oldest = [...this.pending.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (oldest) this.clearPending(oldest[0]);
    }

    const pendingId = this.nextPendingId++;
    const toolSummary = summarizeTool(event.toolName, event.toolInput);
    const session = this.sessionMap.getBySessionId(event.sessionId);
    const projectName = session?.project ?? "unknown";

    const pp: PendingPermission = {
      pendingId,
      sessionId: event.sessionId,
      tmuxTarget: event.tmuxTarget,
      toolName: event.toolName,
      toolSummary,
      createdAt: Date.now(),
    };

    this.setPending(pendingId, pp);

    const text = this.formatMessage(projectName, event.toolName, toolSummary);
    const keyboard: TelegramBot.InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: `✅ ${t("permissionRequest.allow")}`, callback_data: `perm:a:${pendingId}` },
          { text: `❌ ${t("permissionRequest.deny")}`, callback_data: `perm:d:${pendingId}` },
        ],
      ],
    };

    await this.bot
      .sendMessage(chat, text, { parse_mode: "MarkdownV2", reply_markup: keyboard })
      .catch((err: unknown) => logger.error({ err }, "[PermReq] send failed"));
  }

  async handleCallback(query: TelegramBot.CallbackQuery): Promise<void> {
    if (!query.data || !query.message) return;

    if (this.processedCallbacks.has(query.id)) {
      try {
        await this.bot.answerCallbackQuery(query.id);
      } catch {
        /* best-effort */
      }
      return;
    }
    this.processedCallbacks.add(query.id);
    if (this.processedCallbacks.size > 200) {
      const first = this.processedCallbacks.values().next().value as string;
      this.processedCallbacks.delete(first);
    }

    const parts = query.data.split(":");
    if (parts.length < 3) return;

    const action = parts[1];
    const pendingId = parseInt(parts[2]!, 10);
    const allow = action === "a";

    const pp = this.pending.get(pendingId);
    if (!pp) {
      await this.bot.answerCallbackQuery(query.id, { text: t("permissionRequest.sessionExpired") });
      return;
    }

    await this.bot.answerCallbackQuery(query.id, { text: t("permissionRequest.sending") });

    const resultText = allow
      ? t("permissionRequest.allowed", { tool: pp.toolName, summary: pp.toolSummary })
      : t("permissionRequest.denied", { tool: pp.toolName, summary: pp.toolSummary });
    const resultEmoji = allow ? "✅" : "❌";
    await this.bot
      .editMessageText(`${resultEmoji} ${escapeMarkdownV2(resultText)}`, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: "MarkdownV2",
      })
      .catch(() => {});

    try {
      await this.injectResponse(pp.tmuxTarget, allow);
      logger.debug(`[PermReq] injected ${allow ? "allow" : "deny"} → ${pp.tmuxTarget}`);
    } catch (err) {
      logger.error({ err }, t("permissionRequest.injectionFailed"));
    }

    this.clearPending(pendingId);
  }

  destroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
    this.processedCallbacks.clear();
  }

  private async injectResponse(tmuxTarget: string, allow: boolean): Promise<void> {
    const ready = await this.tmuxBridge.waitForTuiReady(tmuxTarget, 5000);
    if (!ready) throw new Error("TUI not ready");
    this.tmuxBridge.sendKeys(tmuxTarget, allow ? "y" : "n", ["Enter"]);
  }

  private formatMessage(project: string, toolName: string, summary: string): string {
    const header = `⚠️ *${escapeMarkdownV2(t("permissionRequest.title"))}*\n_${escapeMarkdownV2(project)}_`;
    const tool = `🔧 *${escapeMarkdownV2(toolName)}*\n\`${escapeMarkdownV2(summary)}\``;
    return `${header}\n\n${tool}`;
  }

  private setPending(pendingId: number, pp: PendingPermission): void {
    this.pending.set(pendingId, pp);
    const timer = setTimeout(() => this.clearPending(pendingId), EXPIRE_MS);
    this.timers.set(pendingId, timer);
  }

  private clearPending(pendingId: number): void {
    this.pending.delete(pendingId);
    const timer = this.timers.get(pendingId);
    if (timer) clearTimeout(timer);
    this.timers.delete(pendingId);
  }
}
