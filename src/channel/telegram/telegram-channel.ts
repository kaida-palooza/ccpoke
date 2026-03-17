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
import { PaneState, type PaneRegistry } from "../../tmux/pane-registry.js";
import type { PaneStateManager } from "../../tmux/pane-state-manager.js";
import type { TmuxBridge } from "../../tmux/tmux-bridge.js";
import { checkPaneHealth } from "../../tmux/tmux-scanner.js";
import { logger } from "../../utils/log.js";
import { truncateMarkdown } from "../../utils/markdown.js";
import { formatModelName } from "../../utils/stats-format.js";
import { autoAcceptStartupPrompts, launchAgent } from "../agent-launcher.js";
import { buildSessionLabel } from "../session-label.js";
import type { ChannelDeps, NotificationChannel, NotificationData } from "../types.js";
import { AskQuestionHandler } from "./ask-question-handler.js";
import { buildTargetCallback, parseTargetCallback } from "./callback-parser.js";
import { escapeMarkdownV2, markdownToTelegramV2 } from "./escape-markdown.js";
import { formatPaneList } from "./pane-list.js";
import { PendingReplyStore } from "./pending-reply-store.js";
import { PermissionRequestHandler } from "./permission-request-handler.js";
import { formatProjectList } from "./project-list.js";
import { PromptHandler } from "./prompt-handler.js";
import { padMaxWidth, sendTelegramMessage } from "./telegram-sender.js";

export class TelegramChannel implements NotificationChannel {
  private bot: TelegramBot;
  private cfg: Config;
  private chatId: number | null = null;
  private isDisconnected = false;
  private consecutivePollingErrors = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastPollingActivity = Date.now();
  private startedAt = 0;
  private pendingReplyStore = new PendingReplyStore();
  private instanceId = randomUUID();
  private paneRegistry: PaneRegistry | null;
  private paneStateManager: PaneStateManager | null;
  private tmuxBridge: TmuxBridge | null;
  private registry: AgentRegistry | null;
  private promptHandler: PromptHandler | null = null;
  private askQuestionHandler: AskQuestionHandler | null = null;
  private permissionRequestHandler: PermissionRequestHandler | null = null;
  private processedUpdateIds = new Map<string, number>();

  constructor(cfg: Config, deps?: ChannelDeps) {
    this.cfg = cfg;
    this.paneRegistry = deps?.paneRegistry ?? null;
    this.paneStateManager = deps?.paneStateManager ?? null;
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
    this.patchProcessUpdate();

    this.pendingReplyStore.setOnCleanup((chatId, messageId) => {
      this.bot.deleteMessage(chatId, messageId).catch(() => {});
    });

    if (this.paneRegistry && this.tmuxBridge && this.registry) {
      this.promptHandler = new PromptHandler(
        this.bot,
        () => this.chatId,
        this.paneRegistry,
        this.tmuxBridge,
        this.registry
      );
      this.promptHandler.onElicitationSent = (chatId, messageId, paneId, panePid, project) => {
        this.pendingReplyStore.set(chatId, messageId, paneId, panePid, project);
      };
      this.askQuestionHandler = new AskQuestionHandler(
        this.bot,
        () => this.chatId,
        this.tmuxBridge,
        this.paneRegistry
      );
      this.permissionRequestHandler = new PermissionRequestHandler(
        this.bot,
        () => this.chatId,
        this.paneRegistry,
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
    logger.info(t("bot.telegramStarted"));

    if (this.chatId) {
      this.bot
        .sendMessage(
          this.chatId,
          padMaxWidth(t("bot.startupReady", { host: escapeMarkdownV2(hostname()) })),
          {
            parse_mode: "MarkdownV2",
          }
        )
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
      logger.info(t("bot.noChatId"));
      return;
    }

    const text = this.formatNotification(data);

    try {
      await sendTelegramMessage(
        this.bot,
        this.chatId,
        text,
        responseUrl,
        data.paneId,
        data.panePid
      );
    } catch (err: unknown) {
      logger.error({ err }, t("bot.notificationFailed"));
    }
  }

  private formatNotification(data: NotificationData): string {
    const parts: string[] = [];

    const label = buildSessionLabel(data.projectName, "", data.paneId ?? "");
    const titleLine = `📦 *${escapeMarkdownV2(label)}*`;
    const metaLine = `🐾 ${escapeMarkdownV2(data.agentDisplayName)}`;
    parts.push(`${titleLine}\n${metaLine}`);

    if (data.responseSummary) {
      const content = truncateMarkdown(data.responseSummary.trim(), 500);
      parts.push(markdownToTelegramV2(content));
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
      logger.info(t("bot.commandsRegistered"));
    } catch (err: unknown) {
      logger.error({ err }, t("bot.commandsRegisterFailed"));
    }
  }

  private async registerMenuButton(): Promise<void> {
    try {
      await this.bot.setChatMenuButton({
        menu_button: JSON.stringify({ type: "commands" }),
      } as Record<string, unknown>);
      logger.info(t("bot.menuButtonRegistered"));
    } catch (err: unknown) {
      logger.error({ err }, t("bot.menuButtonFailed"));
    }
  }

  private registerHandlers(): void {
    this.bot.onText(/\/start(?:\s|$)/, (msg) => {
      if (!ConfigManager.isOwner(this.cfg, msg.from?.id ?? 0)) {
        logger.info(
          t("bot.unauthorizedUser", {
            userId: msg.from?.id ?? 0,
            username: msg.from?.username ?? "",
          })
        );
        return;
      }

      if (this.chatId === msg.chat.id) {
        this.bot.sendMessage(msg.chat.id, padMaxWidth(t("bot.alreadyConnected")));
        return;
      }

      this.chatId = msg.chat.id;
      ConfigManager.saveChatState({ chat_id: this.chatId });
      logger.info(t("bot.registeredChatId", { chatId: msg.chat.id }));
      this.bot.sendMessage(msg.chat.id, padMaxWidth(t("bot.ready")), { parse_mode: "MarkdownV2" });
    });
  }

  private registerChatHandlers(): void {
    this.bot.on("callback_query", async (query) => {
      try {
        logger.debug(
          `[TG:callback] id=${query.id} from=${query.from.id} data=${query.data ?? "(none)"}`
        );
        if (!ConfigManager.isOwner(this.cfg, query.from.id)) {
          logger.debug(`[TG:callback] dropped: unauthorized userId=${query.from.id}`);
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
          const parsed = parseTargetCallback(query.data, "elicit");
          if (!parsed) {
            await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
            return;
          }
          logger.debug(`[Elicit:callback] paneId=${parsed.paneId}`);
          await this.handleElicitReplyButton(query, parsed.paneId, parsed.panePid);
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
          const parsed = parseTargetCallback(query.data, "session_chat");
          if (!parsed) {
            await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
            return;
          }
          query.data = buildTargetCallback("chat", parsed.paneId, parsed.panePid);
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

        const chatParsed = parseTargetCallback(query.data, "chat");
        if (!chatParsed) {
          await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
          return;
        }

        const chatHealth = checkPaneHealth(chatParsed.paneId);
        if (chatHealth.status === "dead") {
          await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
          return;
        }

        const chatSession = this.paneRegistry?.getByPaneId(chatParsed.paneId);
        if (!chatSession) {
          await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
          return;
        }

        logger.debug(`[Chat:callback] paneId=${chatParsed.paneId} project=${chatSession.project}`);

        if (!query.message) {
          await this.bot.answerCallbackQuery(query.id);
          return;
        }

        const chatLabel = buildSessionLabel(chatSession.project, "", chatParsed.paneId);
        const sent = await this.bot.sendMessage(
          query.message.chat.id,
          padMaxWidth(
            `💬 *${escapeMarkdownV2(chatLabel)}*\n${escapeMarkdownV2(t("chat.replyHint"))}`
          ),
          {
            parse_mode: "MarkdownV2",
            reply_to_message_id: query.message.message_id,
            reply_markup: {
              force_reply: true,
              selective: true,
              input_field_placeholder: `${chatLabel} → Claude`,
            },
          }
        );

        this.pendingReplyStore.set(
          query.message.chat.id,
          sent.message_id,
          chatParsed.paneId,
          chatParsed.panePid,
          chatSession.project
        );
        logger.debug(
          `[Chat:pending] msgId=${sent.message_id} → paneId=${chatParsed.paneId} project=${chatSession.project}`
        );
        await this.bot.answerCallbackQuery(query.id);
      } catch (err) {
        logger.error({ err }, "[callback_query] unhandled error");
        try {
          await this.bot.answerCallbackQuery(query.id);
        } catch {
          /* best-effort ack */
        }
      }
    });

    this.bot.on("message", async (msg) => {
      logger.debug(
        `[TG:msg] msgId=${msg.message_id} from=${msg.from?.id ?? "?"} chatId=${msg.chat.id} hasReply=${!!msg.reply_to_message} hasText=${!!msg.text}`
      );
      if (!msg.reply_to_message) {
        if (
          msg.text &&
          !msg.text.startsWith("/") &&
          !msg.text.startsWith("__ccpoke_") &&
          ConfigManager.isOwner(this.cfg, msg.from?.id ?? 0)
        ) {
          await this.bot
            .sendMessage(msg.chat.id, padMaxWidth(t("chat.directMessageHint")), {
              reply_to_message_id: msg.message_id,
            })
            .catch(() => {});
        }
        logger.debug(`[TG:msg] dropped: no reply_to_message msgId=${msg.message_id}`);
        return;
      }
      if (!msg.text) {
        logger.debug(`[TG:msg] dropped: no text msgId=${msg.message_id}`);
        return;
      }
      if (!ConfigManager.isOwner(this.cfg, msg.from?.id ?? 0)) {
        logger.debug(`[TG:msg] dropped: unauthorized userId=${msg.from?.id ?? "?"}`);
        return;
      }

      logger.debug(
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
        logger.debug(
          `[TG:msg] dropped: no pending reply for chatId=${msg.chat.id} replyToMsgId=${msg.reply_to_message.message_id}`
        );
        return;
      }

      logger.debug(
        `[Chat:pending-found] replyToMsgId=${msg.reply_to_message.message_id} → paneId=${pending.paneId} panePid=${pending.panePid} project=${pending.project}`
      );

      this.pendingReplyStore.delete(msg.chat.id, msg.reply_to_message.message_id);
      this.bot.deleteMessage(msg.chat.id, msg.reply_to_message.message_id).catch(() => {});

      const health = checkPaneHealth(pending.paneId);
      if (health.status === "dead") {
        await this.bot.sendMessage(msg.chat.id, padMaxWidth(t("chat.sessionNotFound")));
        return;
      }

      if (this.promptHandler) {
        const injected = this.promptHandler.injectElicitationResponse(pending.paneId, msg.text);
        if (injected) {
          logger.debug(`[Chat:result] elicitation injected → paneId=${pending.paneId}`);
          await this.bot.sendMessage(
            msg.chat.id,
            padMaxWidth(t("prompt.responded", { project: pending.project }))
          );
          return;
        }
      }

      if (!this.paneStateManager) {
        await this.bot.sendMessage(msg.chat.id, padMaxWidth(t("chat.sessionNotFound")));
        return;
      }

      const result = this.paneStateManager.injectMessage(pending.paneId, msg.text);

      if ("sent" in result) {
        logger.debug(`[Chat:result] sent → paneId=${pending.paneId}`);
        await this.bot.sendMessage(
          msg.chat.id,
          padMaxWidth(t("chat.sent", { project: pending.project }))
        );
      } else if ("busy" in result) {
        logger.debug(`[Chat:result] busy → paneId=${pending.paneId}`);
        await this.bot.sendMessage(msg.chat.id, padMaxWidth(t("chat.busy")));
      } else if ("sessionNotFound" in result) {
        logger.debug(`[Chat:result] sessionNotFound → paneId=${pending.paneId}`);
        await this.bot.sendMessage(msg.chat.id, padMaxWidth(t("chat.sessionNotFound")));
      } else if ("paneDead" in result) {
        logger.debug(`[Chat:result] paneDead → paneId=${pending.paneId}`);
        await this.bot.sendMessage(msg.chat.id, padMaxWidth(t("chat.tmuxDead")));
      } else if ("noAgent" in result) {
        logger.debug(`[Chat:result] noAgent → paneId=${pending.paneId}`);
        await this.bot.sendMessage(msg.chat.id, padMaxWidth(t("chat.noAgent")));
      } else if ("sentToShell" in result) {
        logger.debug(`[Chat:result] sentToShell → paneId=${pending.paneId}`);
        await this.bot.sendMessage(
          msg.chat.id,
          padMaxWidth(t("chat.sentToShell", { project: pending.project }))
        );
      }
    });
  }

  private async handleElicitReplyButton(
    query: TelegramBot.CallbackQuery,
    paneId: string,
    panePid: string
  ): Promise<void> {
    if (!this.paneRegistry || !query.message) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    const health = checkPaneHealth(paneId);
    if (health.status === "dead") {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    const pane = this.paneRegistry.getByPaneId(paneId);
    if (!pane) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    const elicitLabel = buildSessionLabel(pane.project, "", paneId);
    const sent = await this.bot.sendMessage(
      query.message.chat.id,
      padMaxWidth(
        `💬 *${escapeMarkdownV2(elicitLabel)}*\n${escapeMarkdownV2(t("prompt.elicitationReplyHint"))}`
      ),
      {
        parse_mode: "MarkdownV2",
        reply_to_message_id: query.message.message_id,
        reply_markup: {
          force_reply: true,
          selective: true,
          input_field_placeholder: `${elicitLabel} → Claude`,
        },
      }
    );

    this.pendingReplyStore.set(
      query.message.chat.id,
      sent.message_id,
      paneId,
      panePid,
      pane.project
    );
    logger.debug(
      `[Elicit:pending] msgId=${sent.message_id} → paneId=${paneId} project=${pane.project}`
    );
    await this.bot.answerCallbackQuery(query.id);
  }

  private registerSessionsHandlers(): void {
    this.bot.onText(/\/sessions(?:\s|$)/, (msg) => {
      if (!ConfigManager.isOwner(this.cfg, msg.from?.id ?? 0)) return;
      if (!this.paneRegistry) {
        this.bot.sendMessage(msg.chat.id, padMaxWidth(t("sessions.empty"))).catch(() => {});
        return;
      }

      const beforeCount = this.paneRegistry.getAllActive().length;
      if (this.tmuxBridge) {
        const result = this.paneRegistry.refreshFromTmux(this.tmuxBridge);
        logger.debug(
          `[/sessions] refresh: before=${beforeCount} after=${result.total} discovered=${result.discovered.length} removed=${result.removed.length}`
        );
      }

      const panes = this.paneRegistry.getAllActive();
      logger.debug(`[/sessions] count=${panes.length}`);
      for (const p of panes) {
        logger.debug(`[/sessions:dump] target=${p.paneId} project=${p.project} cwd=${p.cwd}`);
      }
      const { text, replyMarkup } = formatPaneList(panes);

      const opts: TelegramBot.SendMessageOptions = { parse_mode: "MarkdownV2" };
      if (replyMarkup) opts.reply_markup = replyMarkup;

      this.bot.sendMessage(msg.chat.id, padMaxWidth(text), opts).catch((err) => {
        logger.error({ err }, "[/sessions] MarkdownV2 sendMessage failed, retrying plain text");
        const plain = panes.map((p) => `${p.project} (${p.state})`).join("\n");
        this.bot
          .sendMessage(msg.chat.id, padMaxWidth(plain || t("sessions.empty")))
          .catch(() => {});
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

      this.bot.sendMessage(msg.chat.id, padMaxWidth(text), opts).catch(() => {});
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
      padMaxWidth(t("projects.chooseAgent", { project: project.name })),
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
      const { paneId, needsTrust } = launchAgent(this.tmuxBridge, project.path, agentKey);

      this.paneRegistry?.register(paneId, project.name, project.path, "", agentKey as AgentName);
      this.paneRegistry?.updateState(paneId, PaneState.Launching);

      if (needsTrust) {
        autoAcceptStartupPrompts(
          this.tmuxBridge,
          paneId,
          agentKey,
          () => {},
          () => {}
        );
      }

      logger.info(`[Projects] started ${agentKey} in ${paneId} for ${project.name}`);
      await this.bot.sendMessage(
        query.message!.chat.id,
        padMaxWidth(t("projects.started", { project: project.name }))
      );
    } catch (err) {
      logger.error({ err }, `[Projects] failed to start panel for ${project.name}`);
      await this.bot.sendMessage(
        query.message.chat.id,
        padMaxWidth(t("projects.startFailed", { project: project.name }))
      );
    }
  }

  private async handleSessionCallback(query: TelegramBot.CallbackQuery): Promise<void> {
    if (!this.paneRegistry || !query.message) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    const parsed = parseTargetCallback(query.data!, "session");
    if (!parsed) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    const health = checkPaneHealth(parsed.paneId);
    if (health.status === "dead") {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    const pane = this.paneRegistry.getByPaneId(parsed.paneId);
    if (!pane) {
      logger.debug(`[Session:callback] NOT FOUND paneId=${parsed.paneId}`);
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }
    logger.debug(`[Session:callback] resolved target=${parsed.paneId} project=${pane.project}`);

    const livePid = health.panePid;

    await this.bot.answerCallbackQuery(query.id);
    await this.bot.sendMessage(
      query.message.chat.id,
      padMaxWidth(`*${escapeMarkdownV2(pane.project)}*`),
      {
        parse_mode: "MarkdownV2",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `💬 ${t("sessions.chatButton")}`,
                callback_data: buildTargetCallback("session_chat", parsed.paneId, livePid),
              },
              {
                text: `🗑 ${t("sessions.closeButton")}`,
                callback_data: buildTargetCallback("session_close", parsed.paneId, livePid),
              },
              {
                text: `❌ ${t("chat.cancelButton")}`,
                callback_data: buildTargetCallback("session_dismiss", parsed.paneId, livePid),
              },
            ],
          ],
        },
      }
    );
  }
  private async handleSessionDismiss(query: TelegramBot.CallbackQuery): Promise<void> {
    if (!this.paneRegistry || !this.tmuxBridge) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    const parsed = parseTargetCallback(query.data!, "session_dismiss");
    if (!parsed) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    const health = checkPaneHealth(parsed.paneId);
    if (health.status === "dead" || health.panePid !== parsed.panePid) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    try {
      this.tmuxBridge.sendSpecialKey(parsed.paneId, "Escape");
    } catch {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.tmuxDead") });
      return;
    }

    await this.bot.answerCallbackQuery(query.id, { text: t("chat.cancelled") });
  }

  private async handleSessionCloseConfirm(query: TelegramBot.CallbackQuery): Promise<void> {
    if (!this.paneRegistry || !query.message) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    const parsed = parseTargetCallback(query.data!, "session_close");
    if (!parsed) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    const health = checkPaneHealth(parsed.paneId);
    if (health.status === "dead" || health.panePid !== parsed.panePid) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    const pane = this.paneRegistry.getByPaneId(parsed.paneId);
    if (!pane) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    await this.bot.answerCallbackQuery(query.id);
    await this.bot.editMessageText(
      padMaxWidth(t("sessions.confirmClose", { project: pane.project })),
      {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `✅ ${t("sessions.yes")}`,
                callback_data: buildTargetCallback(
                  "session_close_yes",
                  parsed.paneId,
                  parsed.panePid
                ),
              },
              { text: `❌ ${t("sessions.no")}`, callback_data: `session_close_no:` },
            ],
          ],
        },
      }
    );
  }

  private async handleSessionCloseExecute(query: TelegramBot.CallbackQuery): Promise<void> {
    if (!this.paneRegistry || !query.message) {
      await this.bot.answerCallbackQuery(query.id);
      return;
    }

    const parsed = parseTargetCallback(query.data!, "session_close_yes");
    if (!parsed) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    const pane = this.paneRegistry.getByPaneId(parsed.paneId);
    if (!pane) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    if (this.tmuxBridge) {
      try {
        this.tmuxBridge.killPane(parsed.paneId);
      } catch {
        // pane may already be dead
      }
    }

    this.paneRegistry.unregister(parsed.paneId);
    this.paneRegistry.save();
    logger.info(`[Sessions] closed session ${parsed.paneId} (${pane.project})`);

    await this.bot.answerCallbackQuery(query.id);
    await this.bot.editMessageText(padMaxWidth(t("sessions.closed", { project: pane.project })), {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
    });
  }

  private patchProcessUpdate(): void {
    const originalGetUpdates = this.bot.getUpdates.bind(this.bot);
    this.bot.getUpdates = (...args: Parameters<typeof this.bot.getUpdates>) => {
      this.lastPollingActivity = Date.now();
      return originalGetUpdates(...args);
    };

    const original = this.bot.processUpdate.bind(this.bot);
    this.bot.processUpdate = (update: TelegramBot.Update) => {
      const uid = update.update_id as number;
      const key = `uid:${uid}`;
      this.lastPollingActivity = Date.now();
      this.consecutivePollingErrors = 0;
      if (this.isDisconnected) {
        this.isDisconnected = false;
        logger.info(t("bot.connectionRestored"));
      }
      if (this.processedUpdateIds.has(key)) {
        logger.warn(`[Polling] duplicate update_id=${uid} skipped`);
        return;
      }
      this.processedUpdateIds.set(key, Date.now());
      this.trimProcessedIds();
      return original(update);
    };
  }

  private trimProcessedIds(): void {
    if (this.processedUpdateIds.size > 500) {
      const cutoff = Date.now() - 60_000;
      for (const [key, ts] of this.processedUpdateIds) {
        if (ts < cutoff) this.processedUpdateIds.delete(key);
      }
    }
  }

  private registerTakeoverListener(): void {
    this.bot.on("message", (msg) => {
      if (!msg.text?.startsWith("__ccpoke_takeover:")) return;
      if (this.chatId && msg.chat.id !== this.chatId) return;
      const senderId = msg.text.slice("__ccpoke_takeover:".length);
      if (senderId === this.instanceId) return;
      logger.info(t("bot.instanceTakeover"));
      process.emit("SIGTERM", "SIGTERM");
    });
  }

  private registerPollingErrorHandler(): void {
    const STALE_THRESHOLD_MS = 30_000;
    const HEARTBEAT_INTERVAL_MS = 10_000;
    const RESTART_DELAY_MS = 2_000;
    const STARTUP_GRACE_MS = 15_000;
    const DISCONNECT_THRESHOLD = 3;

    this.bot.on("polling_error", (err: unknown) => {
      this.consecutivePollingErrors++;

      if (this.consecutivePollingErrors <= DISCONNECT_THRESHOLD) {
        const errMsg = err instanceof Error ? err.message : String(err ?? "unknown");
        logger.debug(`[Polling] error #${this.consecutivePollingErrors}: ${errMsg}`);
      }

      if (!this.isDisconnected && this.consecutivePollingErrors >= DISCONNECT_THRESHOLD) {
        this.isDisconnected = true;
        if (Date.now() - this.startedAt >= STARTUP_GRACE_MS) {
          logger.warn(t("bot.connectionLost"));
        }
      }
    });

    this.heartbeatInterval = setInterval(() => {
      if (this.reconnectTimer) return;
      if (Date.now() - this.startedAt < STARTUP_GRACE_MS) return;
      const staleMs = Date.now() - this.lastPollingActivity;
      if (staleMs < STALE_THRESHOLD_MS) return;
      logger.warn(t("bot.pollingRestart"));
      this.isDisconnected = true;
      this.lastPollingActivity = Date.now();
      this.reconnectTimer = setTimeout(async () => {
        try {
          await this.bot.stopPolling({ cancel: true, reason: "stale polling" });
        } catch {
          // already stopped
        }
        this.bot.startPolling();
        this.lastPollingActivity = Date.now();
        this.reconnectTimer = null;
        logger.info(t("bot.pollingRestarted"));
      }, RESTART_DELAY_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }
}
