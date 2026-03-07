import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import TelegramBot from "node-telegram-bot-api";

import type {
  AskUserQuestionEvent,
  NotificationEvent,
  PermissionRequestEvent,
} from "../../agent/agent-handler.js";
import type { AgentRegistry } from "../../agent/agent-registry.js";
import { AGENT_DISPLAY_NAMES, AgentName } from "../../agent/types.js";
import { ConfigManager, type Config } from "../../config-manager.js";
import { getTranslations, t } from "../../i18n/index.js";
import type { SessionMap, TmuxSession } from "../../tmux/session-map.js";
import type { SessionStateManager } from "../../tmux/session-state.js";
import type { TmuxBridge } from "../../tmux/tmux-bridge.js";
import { log, logDebug, logError, logWarn } from "../../utils/log.js";
import { extractProseSnippet } from "../../utils/markdown.js";
import { formatModelName } from "../../utils/stats-format.js";
import { autoTrustWorkspace, launchAgent } from "../agent-launcher.js";
import type { ChannelDeps, NotificationChannel, NotificationData } from "../types.js";
import { AskQuestionHandler } from "./ask-question-handler.js";
import { escapeMarkdownV2, isInlineMessage, markdownToTelegramV2 } from "./escape-markdown.js";
import { PendingReplyStore } from "./pending-reply-store.js";
import { PermissionRequestHandler } from "./permission-request-handler.js";
import { formatProjectList } from "./project-list.js";
import { PromptHandler } from "./prompt-handler.js";
import { formatSessionList } from "./session-list.js";
import { sendTelegramMessage } from "./telegram-sender.js";

export class TelegramChannel implements NotificationChannel {
  private bot: TelegramBot;
  private cfg: Config;
  private chatId: number | null = null;
  private isDisconnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastPollingActivity = Date.now();
  private startedAt = 0;
  private pendingReplyStore = new PendingReplyStore();
  private instanceId = randomUUID();
  private sessionMap: SessionMap | null;
  private stateManager: SessionStateManager | null;
  private tmuxBridge: TmuxBridge | null;
  private registry: AgentRegistry | null;
  private promptHandler: PromptHandler | null = null;
  private askQuestionHandler: AskQuestionHandler | null = null;
  private permissionRequestHandler: PermissionRequestHandler | null = null;

  constructor(cfg: Config, deps?: ChannelDeps) {
    this.cfg = cfg;
    this.sessionMap = deps?.sessionMap ?? null;
    this.stateManager = deps?.stateManager ?? null;
    this.tmuxBridge = deps?.tmuxBridge ?? null;
    this.registry = deps?.registry ?? null;
    this.bot = new TelegramBot(cfg.telegram_bot_token, {
      polling: {
        autoStart: false,
        params: { allowed_updates: ["message", "callback_query"] },
      },
    });
    this.chatId = ConfigManager.loadChatState().chat_id;
    this.registerHandlers();
    this.registerChatHandlers();
    this.registerSessionsHandlers();
    this.registerProjectsHandlers();
    this.registerPollingErrorHandler();
    this.registerTakeoverListener();

    this.pendingReplyStore.setOnCleanup((chatId, messageId) => {
      this.bot.deleteMessage(chatId, messageId).catch(() => {});
    });

    if (this.sessionMap && this.tmuxBridge && this.registry) {
      this.promptHandler = new PromptHandler(
        this.bot,
        () => this.chatId,
        this.sessionMap,
        this.tmuxBridge,
        this.registry
      );
      this.promptHandler.onElicitationSent = (chatId, messageId, sessionId, project) => {
        this.pendingReplyStore.set(chatId, messageId, sessionId, project);
      };
      this.askQuestionHandler = new AskQuestionHandler(
        this.bot,
        () => this.chatId,
        this.tmuxBridge
      );
      this.permissionRequestHandler = new PermissionRequestHandler(
        this.bot,
        () => this.chatId,
        this.sessionMap,
        this.tmuxBridge
      );
    }
  }

  async initialize(): Promise<void> {
    this.startedAt = Date.now();
    this.lastPollingActivity = Date.now();

    if (this.chatId) {
      const takeoverMsg = await this.bot
        .sendMessage(this.chatId, `__ccpoke_takeover:${this.instanceId}`)
        .catch(() => null);
      if (takeoverMsg) {
        this.bot.deleteMessage(this.chatId, takeoverMsg.message_id).catch(() => {});
      }
    }

    this.bot.startPolling();
    await this.registerCommands();
    await this.registerMenuButton();
    log(t("bot.telegramStarted"));

    if (this.chatId) {
      this.bot
        .sendMessage(this.chatId, t("bot.startupReady", { host: escapeMarkdownV2(hostname()) }), {
          parse_mode: "MarkdownV2",
        })
        .catch(() => {});
    }
  }

  async shutdown(): Promise<void> {
    this.promptHandler?.destroy();
    this.askQuestionHandler?.destroy();
    this.permissionRequestHandler?.destroy();
    this.pendingReplyStore.destroy();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.bot.stopPolling();
  }

  handleNotificationEvent(event: NotificationEvent): void {
    this.promptHandler?.forwardPrompt(event).catch(() => {});
  }

  handleAskUserQuestionEvent(event: AskUserQuestionEvent): void {
    this.askQuestionHandler?.forwardQuestion(event).catch(() => {});
  }

  handlePermissionRequestEvent(event: PermissionRequestEvent): void {
    this.permissionRequestHandler?.forwardPermission(event).catch(() => {});
  }

  async sendNotification(data: NotificationData, responseUrl?: string): Promise<void> {
    if (!this.chatId) {
      log(t("bot.noChatId"));
      return;
    }

    const text = this.formatNotification(data);

    try {
      await sendTelegramMessage(this.bot, this.chatId, text, responseUrl, data.sessionId);
    } catch (err: unknown) {
      logError(t("bot.notificationFailed"), err);
    }
  }

  private formatNotification(data: NotificationData): string {
    const parts: string[] = [];

    const titleLine = `📦 *${escapeMarkdownV2(data.projectName)}*`;
    const metaLine = `🐾 ${escapeMarkdownV2(data.agentDisplayName)}`;
    parts.push(`${titleLine}\n${metaLine}`);

    if (data.responseSummary) {
      if (isInlineMessage(data.responseSummary)) {
        parts.push(markdownToTelegramV2(data.responseSummary.trim()));
      } else {
        const snippet = extractProseSnippet(data.responseSummary, 150);
        parts.push(escapeMarkdownV2(snippet + "..."));
      }
    } else {
      parts.push(escapeMarkdownV2("✅ Task done"));
    }

    if (data.model) {
      parts.push(`🤖 ${escapeMarkdownV2(formatModelName(data.model))}`);
    }

    return parts.join("\n\n");
  }

  private async registerCommands(): Promise<void> {
    const translations = getTranslations();
    const commands: TelegramBot.BotCommand[] = [
      { command: "start", description: translations.bot.commands.start },
      { command: "sessions", description: translations.bot.commands.sessions },
      { command: "projects", description: translations.bot.commands.projects },
    ];

    try {
      await this.bot.setMyCommands(commands);
      log(t("bot.commandsRegistered"));
    } catch (err: unknown) {
      logError(t("bot.commandsRegisterFailed"), err);
    }
  }

  private async registerMenuButton(): Promise<void> {
    try {
      await this.bot.setChatMenuButton({
        menu_button: JSON.stringify({ type: "commands" }),
      } as Record<string, unknown>);
      log(t("bot.menuButtonRegistered"));
    } catch (err: unknown) {
      logError(t("bot.menuButtonFailed"), err);
    }
  }

  private registerHandlers(): void {
    this.bot.onText(/\/start(?:\s|$)/, (msg) => {
      if (!ConfigManager.isOwner(this.cfg, msg.from?.id ?? 0)) {
        log(
          t("bot.unauthorizedUser", {
            userId: msg.from?.id ?? 0,
            username: msg.from?.username ?? "",
          })
        );
        return;
      }

      if (this.chatId === msg.chat.id) {
        this.bot.sendMessage(msg.chat.id, t("bot.alreadyConnected"));
        return;
      }

      this.chatId = msg.chat.id;
      ConfigManager.saveChatState({ chat_id: this.chatId });
      log(t("bot.registeredChatId", { chatId: msg.chat.id }));
      this.bot.sendMessage(msg.chat.id, t("bot.ready"), { parse_mode: "MarkdownV2" });
    });
  }

  private registerChatHandlers(): void {
    this.bot.on("callback_query", async (query) => {
      try {
        logDebug(
          `[TG:callback] id=${query.id} from=${query.from.id} data=${query.data ?? "(none)"}`
        );
        if (!ConfigManager.isOwner(this.cfg, query.from.id)) {
          logDebug(`[TG:callback] dropped: unauthorized userId=${query.from.id}`);
          return;
        }

        if (query.data?.startsWith("aq:") || query.data?.startsWith("am:")) {
          await this.askQuestionHandler?.handleCallback(query);
          return;
        }

        if (query.data?.startsWith("perm:")) {
          await this.permissionRequestHandler?.handleCallback(query);
          return;
        }

        if (query.data?.startsWith("elicit:")) {
          const sessionId = query.data.slice(7);
          logDebug(`[Elicit:callback] sessionId=${sessionId}`);
          await this.handleElicitReplyButton(query, sessionId);
          return;
        }

        if (query.data?.startsWith("proj:")) {
          await this.handleProjectCallback(query);
          return;
        }

        if (query.data?.startsWith("agent_start:")) {
          await this.handleAgentStartCallback(query);
          return;
        }

        if (query.data?.startsWith("session:")) {
          await this.handleSessionCallback(query);
          return;
        }

        if (query.data?.startsWith("session_chat:")) {
          // Rewrite to chat: flow
          const sessionId = query.data.slice(13);
          query.data = `chat:${sessionId}`;
          // fall through to chat: handler below
        }

        if (query.data?.startsWith("session_close:")) {
          await this.handleSessionCloseConfirm(query);
          return;
        }

        if (query.data?.startsWith("session_close_yes:")) {
          await this.handleSessionCloseExecute(query);
          return;
        }

        if (query.data === "session_close_no:") {
          if (query.message) {
            await this.bot
              .deleteMessage(query.message.chat.id, query.message.message_id)
              .catch(() => {});
          }
          await this.bot.answerCallbackQuery(query.id);
          return;
        }

        if (query.data?.startsWith("session_dismiss:")) {
          await this.handleSessionDismiss(query);
          return;
        }

        if (!query.data?.startsWith("chat:")) return;

        const sessionId = query.data.slice(5);
        logDebug(`[Chat:callback] sessionId=${sessionId}`);

        if (!this.sessionMap) {
          await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
          return;
        }

        const session = this.resolveSession(sessionId);
        if (!session) {
          await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
          return;
        }

        if (!query.message) {
          await this.bot.answerCallbackQuery(query.id);
          return;
        }

        const sent = await this.bot.sendMessage(
          query.message.chat.id,
          `💬 *${escapeMarkdownV2(session.project)}*\n${escapeMarkdownV2(t("chat.replyHint"))}`,
          {
            parse_mode: "MarkdownV2",
            reply_to_message_id: query.message.message_id,
            reply_markup: {
              force_reply: true,
              selective: true,
              input_field_placeholder: `${session.project} → Claude`,
            },
          }
        );

        this.pendingReplyStore.set(
          query.message.chat.id,
          sent.message_id,
          sessionId,
          session.project
        );
        logDebug(
          `[Chat:pending] msgId=${sent.message_id} → sessionId=${sessionId} project=${session.project} tmuxTarget=${session.tmuxTarget}`
        );
        await this.bot.answerCallbackQuery(query.id);
      } catch (err) {
        logError("[callback_query] unhandled error", err);
        try {
          await this.bot.answerCallbackQuery(query.id);
        } catch {
          /* best-effort ack */
        }
      }
    });

    this.bot.on("message", async (msg) => {
      logDebug(
        `[TG:msg] msgId=${msg.message_id} from=${msg.from?.id ?? "?"} chatId=${msg.chat.id} hasReply=${!!msg.reply_to_message} hasText=${!!msg.text}`
      );
      if (!msg.reply_to_message) {
        logDebug(`[TG:msg] dropped: no reply_to_message msgId=${msg.message_id}`);
        return;
      }
      if (!msg.text) {
        logDebug(`[TG:msg] dropped: no text msgId=${msg.message_id}`);
        return;
      }
      if (!ConfigManager.isOwner(this.cfg, msg.from?.id ?? 0)) {
        logDebug(`[TG:msg] dropped: unauthorized userId=${msg.from?.id ?? "?"}`);
        return;
      }

      logDebug(
        `[Chat:msg] replyTo=${msg.reply_to_message.message_id} text="${msg.text.slice(0, 50)}"`
      );

      if (
        this.askQuestionHandler?.hasPendingOtherReply(msg.chat.id, msg.reply_to_message.message_id)
      ) {
        const handled = await this.askQuestionHandler.handleOtherTextReply(
          msg.chat.id,
          msg.reply_to_message.message_id,
          msg.text
        );
        if (handled) return;
      }

      const pending = this.pendingReplyStore.get(msg.chat.id, msg.reply_to_message.message_id);
      if (!pending) {
        logDebug(
          `[TG:msg] dropped: no pending reply for chatId=${msg.chat.id} replyToMsgId=${msg.reply_to_message.message_id}`
        );
        return;
      }

      this.pendingReplyStore.delete(msg.chat.id, msg.reply_to_message.message_id);
      this.bot.deleteMessage(msg.chat.id, msg.reply_to_message.message_id).catch(() => {});
      if (this.promptHandler) {
        const injected = this.promptHandler.injectElicitationResponse(pending.sessionId, msg.text);
        if (injected) {
          logDebug(`[Chat:result] elicitation injected → sessionId=${pending.sessionId}`);
          await this.bot.sendMessage(
            msg.chat.id,
            t("prompt.responded", { project: pending.project })
          );
          return;
        }
      }

      if (!this.stateManager) {
        await this.bot.sendMessage(msg.chat.id, t("chat.sessionNotFound"));
        return;
      }

      const result = this.stateManager.injectMessage(pending.sessionId, msg.text);

      if ("sent" in result) {
        logDebug(`[Chat:result] sent → sessionId=${pending.sessionId}`);
        await this.bot.sendMessage(msg.chat.id, t("chat.sent", { project: pending.project }));
      } else if ("busy" in result) {
        logDebug(`[Chat:result] busy → sessionId=${pending.sessionId}`);
        await this.bot.sendMessage(msg.chat.id, t("chat.busy"));
      } else if ("sessionNotFound" in result) {
        logDebug(`[Chat:result] sessionNotFound → sessionId=${pending.sessionId}`);
        await this.bot.sendMessage(msg.chat.id, t("chat.sessionNotFound"));
      } else if ("tmuxDead" in result) {
        logDebug(`[Chat:result] tmuxDead → sessionId=${pending.sessionId}`);
        await this.bot.sendMessage(msg.chat.id, t("chat.tmuxDead"));
      }
    });
  }

  /** Handle elicitation "Reply" button — sends force_reply targeted at this specific elicitation */
  private async handleElicitReplyButton(
    query: TelegramBot.CallbackQuery,
    sessionId: string
  ): Promise<void> {
    if (!this.sessionMap || !query.message) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    const session = this.resolveSession(sessionId);
    if (!session) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    const sent = await this.bot.sendMessage(
      query.message.chat.id,
      `💬 *${escapeMarkdownV2(session.project)}*\n${escapeMarkdownV2(t("prompt.elicitationReplyHint"))}`,
      {
        parse_mode: "MarkdownV2",
        reply_to_message_id: query.message.message_id,
        reply_markup: {
          force_reply: true,
          selective: true,
          input_field_placeholder: t("chat.placeholder"),
        },
      }
    );

    this.pendingReplyStore.set(query.message.chat.id, sent.message_id, sessionId, session.project);
    logDebug(
      `[Elicit:pending] msgId=${sent.message_id} → sessionId=${sessionId} project=${session.project}`
    );
    await this.bot.answerCallbackQuery(query.id);
  }

  private resolveSession(sessionId: string): TmuxSession | undefined {
    if (!this.sessionMap) return undefined;
    return this.sessionMap.getBySessionId(sessionId) ?? this.sessionMap.resolveExpired(sessionId);
  }

  private registerSessionsHandlers(): void {
    this.bot.onText(/\/sessions(?:\s|$)/, (msg) => {
      if (!ConfigManager.isOwner(this.cfg, msg.from?.id ?? 0)) return;
      if (!this.sessionMap) {
        this.bot.sendMessage(msg.chat.id, t("sessions.empty")).catch(() => {});
        return;
      }

      const beforeCount = this.sessionMap.getAllActive().length;
      if (this.tmuxBridge) {
        const result = this.sessionMap.refreshFromTmux(this.tmuxBridge);
        logDebug(
          `[/sessions] refresh: before=${beforeCount} after=${result.total} discovered=${result.discovered.length} removed=${result.removed.length}`
        );
      }

      const sessions = this.sessionMap.getAllActive();
      logDebug(`[/sessions] count=${sessions.length}`);
      const { text, replyMarkup } = formatSessionList(sessions);

      const opts: TelegramBot.SendMessageOptions = { parse_mode: "MarkdownV2" };
      if (replyMarkup) opts.reply_markup = replyMarkup;

      this.bot.sendMessage(msg.chat.id, text, opts).catch((err) => {
        logError("[/sessions] MarkdownV2 sendMessage failed, retrying plain text", err);
        const plain = sessions.map((s) => `${s.project} (${s.state})`).join("\n");
        this.bot.sendMessage(msg.chat.id, plain || t("sessions.empty")).catch(() => {});
      });
    });
  }

  private registerProjectsHandlers(): void {
    this.bot.onText(/\/projects(?:\s|$)/, (msg) => {
      if (!ConfigManager.isOwner(this.cfg, msg.from?.id ?? 0)) return;

      const cfg = ConfigManager.load();
      const { text, replyMarkup } = formatProjectList(cfg.projects);

      const opts: TelegramBot.SendMessageOptions = {};
      if (replyMarkup) opts.reply_markup = replyMarkup;

      this.bot.sendMessage(msg.chat.id, text, opts).catch(() => {});
    });
  }

  private async handleProjectCallback(query: TelegramBot.CallbackQuery): Promise<void> {
    const idx = Number(query.data!.slice(5));
    const cfg = ConfigManager.load();
    const project = cfg.projects[idx];

    if (!project || !query.message) {
      await this.bot.answerCallbackQuery(query.id, { text: t("projects.stale") });
      return;
    }

    if (!this.tmuxBridge || !this.tmuxBridge.isTmuxAvailable()) {
      await this.bot.answerCallbackQuery(query.id, { text: t("projects.noTmux") });
      return;
    }

    await this.bot.answerCallbackQuery(query.id);

    const agents = cfg.agents;
    if (agents.length === 1) {
      await this.startAgentForProject(query, project, agents[0]!);
      return;
    }

    const buttons: TelegramBot.InlineKeyboardButton[] = agents.map((agent) => ({
      text: AGENT_DISPLAY_NAMES[agent as AgentName] ?? agent,
      callback_data: `agent_start:${idx}:${agent}`,
    }));
    const rows: TelegramBot.InlineKeyboardButton[][] = [];
    for (let i = 0; i < buttons.length; i += 3) {
      rows.push(buttons.slice(i, i + 3));
    }

    await this.bot.sendMessage(
      query.message.chat.id,
      t("projects.chooseAgent", { project: project.name }),
      { reply_markup: { inline_keyboard: rows } }
    );
  }

  private async handleAgentStartCallback(query: TelegramBot.CallbackQuery): Promise<void> {
    const parts = query.data!.slice(12).split(":");
    const idx = Number(parts[0]);
    const agentKey = parts[1];
    const cfg = ConfigManager.load();
    const project = cfg.projects[idx];

    if (!project || !agentKey || !query.message) {
      await this.bot.answerCallbackQuery(query.id);
      return;
    }

    await this.bot.answerCallbackQuery(query.id);
    await this.bot.deleteMessage(query.message.chat.id, query.message.message_id).catch(() => {});
    await this.startAgentForProject(query, project, agentKey);
  }

  private async startAgentForProject(
    query: TelegramBot.CallbackQuery,
    project: { name: string; path: string },
    agentKey: string
  ): Promise<void> {
    if (!this.tmuxBridge || !query.message) return;

    try {
      const { paneTarget, needsTrust } = launchAgent(this.tmuxBridge, project.path, agentKey);

      if (needsTrust) {
        autoTrustWorkspace(
          this.tmuxBridge,
          paneTarget,
          agentKey,
          () => {},
          () => {}
        );
      }

      log(`[Projects] started ${agentKey} in ${paneTarget} for ${project.name}`);
      await this.bot.sendMessage(
        query.message!.chat.id,
        t("projects.started", { project: project.name })
      );
    } catch (err) {
      logError(`[Projects] failed to start panel for ${project.name}`, err);
      await this.bot.sendMessage(
        query.message.chat.id,
        t("projects.startFailed", { project: project.name })
      );
    }
  }

  /** Session sub-menu: Chat / Close */
  private async handleSessionCallback(query: TelegramBot.CallbackQuery): Promise<void> {
    const sessionId = query.data!.slice(8);
    if (!this.sessionMap || !query.message) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    const session = this.resolveSession(sessionId);
    if (!session) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    await this.bot.answerCallbackQuery(query.id);
    await this.bot.sendMessage(query.message.chat.id, `*${escapeMarkdownV2(session.project)}*`, {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [
            { text: `💬 ${t("sessions.chatButton")}`, callback_data: `session_chat:${sessionId}` },
            {
              text: `🗑 ${t("sessions.closeButton")}`,
              callback_data: `session_close:${sessionId}`,
            },
            { text: `❌ ${t("chat.cancelButton")}`, callback_data: `session_dismiss:${sessionId}` },
          ],
        ],
      },
    });
  }
  /** Send Escape to tmux pane to cancel running process */
  private async handleSessionDismiss(query: TelegramBot.CallbackQuery): Promise<void> {
    const sessionId = query.data!.slice(16);
    if (!this.sessionMap || !this.tmuxBridge) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    const session = this.resolveSession(sessionId);
    if (!session?.tmuxTarget) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    try {
      this.tmuxBridge.sendSpecialKey(session.tmuxTarget, "Escape");
    } catch {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.tmuxDead") });
      return;
    }

    await this.bot.answerCallbackQuery(query.id, { text: t("chat.cancelled") });
  }

  /** Session close confirmation */
  private async handleSessionCloseConfirm(query: TelegramBot.CallbackQuery): Promise<void> {
    const sessionId = query.data!.slice(14);
    if (!this.sessionMap || !query.message) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    const session = this.resolveSession(sessionId);
    if (!session) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    await this.bot.answerCallbackQuery(query.id);
    await this.bot.editMessageText(t("sessions.confirmClose", { project: session.project }), {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: {
        inline_keyboard: [
          [
            { text: `✅ ${t("sessions.yes")}`, callback_data: `session_close_yes:${sessionId}` },
            { text: `❌ ${t("sessions.no")}`, callback_data: `session_close_no:` },
          ],
        ],
      },
    });
  }

  /** Execute session close: kill tmux pane + unregister */
  private async handleSessionCloseExecute(query: TelegramBot.CallbackQuery): Promise<void> {
    const sessionId = query.data!.slice(18);
    if (!this.sessionMap || !query.message) {
      await this.bot.answerCallbackQuery(query.id);
      return;
    }

    const session = this.resolveSession(sessionId);
    if (!session) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    if (this.tmuxBridge && session.tmuxTarget) {
      try {
        this.tmuxBridge.killPane(session.tmuxTarget);
      } catch {
        // pane may already be dead
      }
    }

    this.sessionMap.unregister(sessionId);
    this.sessionMap.save();
    log(`[Sessions] closed session ${sessionId} (${session.project})`);

    await this.bot.answerCallbackQuery(query.id);
    await this.bot.editMessageText(t("sessions.closed", { project: session.project }), {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
    });
  }

  private registerTakeoverListener(): void {
    this.bot.on("message", (msg) => {
      if (!msg.text?.startsWith("__ccpoke_takeover:")) return;
      if (this.chatId && msg.chat.id !== this.chatId) return;
      const senderId = msg.text.slice("__ccpoke_takeover:".length);
      if (senderId === this.instanceId) return;
      log(t("bot.instanceTakeover"));
      process.emit("SIGTERM", "SIGTERM");
    });
  }

  private registerPollingErrorHandler(): void {
    const STALE_THRESHOLD_MS = 30_000;
    const HEARTBEAT_INTERVAL_MS = 10_000;
    const RESTART_DELAY_MS = 2_000;
    const STARTUP_GRACE_MS = 15_000;

    this.bot.on("polling_error", () => {
      this.lastPollingActivity = Date.now();
      if (!this.isDisconnected) {
        this.isDisconnected = true;
        if (Date.now() - this.startedAt < STARTUP_GRACE_MS) {
          logDebug("polling_error during startup grace — expected, suppressed");
        } else {
          logWarn(t("bot.connectionLost"));
        }
      }
    });

    this.bot.on("polling", () => {
      this.lastPollingActivity = Date.now();
      if (this.isDisconnected) {
        this.isDisconnected = false;
        log(t("bot.connectionRestored"));
      }
    });

    this.heartbeatInterval = setInterval(() => {
      if (this.reconnectTimer) return;
      const staleMs = Date.now() - this.lastPollingActivity;
      if (staleMs < STALE_THRESHOLD_MS) return;
      logWarn(t("bot.pollingRestart"));
      this.isDisconnected = true;
      this.lastPollingActivity = Date.now();
      try {
        this.bot.stopPolling({ cancel: true, reason: "stale polling" });
      } catch {
        // already stopped
      }
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.bot.startPolling();
        log(t("bot.pollingRestarted"));
      }, RESTART_DELAY_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }
}
