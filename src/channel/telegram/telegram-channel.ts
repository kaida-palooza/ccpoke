import { execSync } from "node:child_process";

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
import type { SessionMap } from "../../tmux/session-map.js";
import type { SessionStateManager } from "../../tmux/session-state.js";
import type { TmuxBridge } from "../../tmux/tmux-bridge.js";
import { log, logDebug, logError, logWarn } from "../../utils/log.js";
import { extractProseSnippet } from "../../utils/markdown.js";
import { formatDuration, formatModelName, formatTokenCount } from "../../utils/stats-format.js";
import type { NotificationChannel, NotificationData } from "../types.js";
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
  private pendingReplyStore = new PendingReplyStore();
  private sessionMap: SessionMap | null;
  private stateManager: SessionStateManager | null;
  private tmuxBridge: TmuxBridge | null;
  private registry: AgentRegistry | null;
  private promptHandler: PromptHandler | null = null;
  private askQuestionHandler: AskQuestionHandler | null = null;
  private permissionRequestHandler: PermissionRequestHandler | null = null;

  constructor(
    cfg: Config,
    sessionMap?: SessionMap,
    stateManager?: SessionStateManager,
    tmuxBridge?: TmuxBridge,
    registry?: AgentRegistry
  ) {
    this.cfg = cfg;
    this.sessionMap = sessionMap ?? null;
    this.stateManager = stateManager ?? null;
    this.tmuxBridge = tmuxBridge ?? null;
    this.registry = registry ?? null;
    this.bot = new TelegramBot(cfg.telegram_bot_token, { polling: false });
    this.chatId = ConfigManager.loadChatState().chat_id;
    this.registerHandlers();
    this.registerChatHandlers();
    this.registerSessionsHandlers();
    this.registerProjectsHandlers();
    this.registerPollingErrorHandler();

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
    this.bot.startPolling();
    await this.registerCommands();
    await this.registerMenuButton();
    log(t("bot.telegramStarted"));
    if (this.chatId) {
      this.bot
        .sendMessage(this.chatId, t("bot.startupReady"), { parse_mode: "MarkdownV2" })
        .catch(() => {});
    }
  }

  async shutdown(): Promise<void> {
    this.promptHandler?.destroy();
    this.askQuestionHandler?.destroy();
    this.permissionRequestHandler?.destroy();
    this.pendingReplyStore.destroy();
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
    let metaLine = `🐾 ${escapeMarkdownV2(data.agentDisplayName)}`;
    if (data.durationMs > 0) {
      metaLine += ` · ⏱ ${escapeMarkdownV2(formatDuration(data.durationMs))}`;
    }
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

    if (data.inputTokens > 0 || data.outputTokens > 0) {
      let statsLine = `📊 ${escapeMarkdownV2(formatTokenCount(data.inputTokens))} → ${escapeMarkdownV2(formatTokenCount(data.outputTokens))}`;
      if (data.model) {
        statsLine += ` · 🤖 ${escapeMarkdownV2(formatModelName(data.model))}`;
      }
      parts.push(statsLine);
    } else if (data.model) {
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
        if (!ConfigManager.isOwner(this.cfg, query.from.id)) return;

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
            await this.bot.deleteMessage(query.message.chat.id, query.message.message_id);
          }
          await this.bot.answerCallbackQuery(query.id);
          return;
        }

        if (!query.data?.startsWith("chat:")) return;

        const sessionId = query.data.slice(5);
        logDebug(`[Chat:callback] sessionId=${sessionId}`);

        if (!this.sessionMap) {
          await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
          return;
        }

        const session = this.sessionMap.getBySessionId(sessionId);
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
      if (!msg.reply_to_message) return;
      if (!msg.text) return;
      if (!ConfigManager.isOwner(this.cfg, msg.from?.id ?? 0)) return;

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
        if (this.pendingReplyStore.wasExpired(msg.chat.id, msg.reply_to_message.message_id)) {
          await this.bot.sendMessage(msg.chat.id, t("chat.sessionExpired"));
        }
        return;
      }

      this.pendingReplyStore.delete(msg.chat.id, msg.reply_to_message.message_id);

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

    const session = this.sessionMap.getBySessionId(sessionId);
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

  private registerSessionsHandlers(): void {
    this.bot.onText(/\/sessions(?:\s|$)/, (msg) => {
      if (!ConfigManager.isOwner(this.cfg, msg.from?.id ?? 0)) return;
      if (!this.sessionMap) {
        this.bot.sendMessage(msg.chat.id, t("sessions.empty")).catch(() => {});
        return;
      }

      if (this.tmuxBridge) {
        this.sessionMap.refreshFromTmux(this.tmuxBridge);
      }

      const sessions = this.sessionMap.getAllActive();
      const { text, replyMarkup } = formatSessionList(sessions);

      const opts: TelegramBot.SendMessageOptions = { parse_mode: "MarkdownV2" };
      if (replyMarkup) opts.reply_markup = replyMarkup;

      this.bot.sendMessage(msg.chat.id, text, opts).catch(() => {});
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
      await this.bot.answerCallbackQuery(query.id);
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
    const rows = [buttons];

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
      const startCommand = resolveAgentStartCommand(agentKey);
      const tmuxSession = this.getTmuxSessionName();
      const paneTarget = this.tmuxBridge.createPane(tmuxSession, project.path);
      this.tmuxBridge.sendKeys(paneTarget, startCommand, ["Enter"]);

      if (agentKey === AgentName.Cursor) {
        this.autoTrustCursorWorkspace(paneTarget);
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

  private autoTrustCursorWorkspace(paneTarget: string): void {
    let attempts = 0;
    const maxAttempts = 10;

    const interval = setInterval(() => {
      attempts++;
      if (attempts > maxAttempts || !this.tmuxBridge) {
        clearInterval(interval);
        return;
      }
      try {
        const content = this.tmuxBridge.capturePane(paneTarget, 10);
        if (content.includes("Trust")) {
          this.tmuxBridge.sendSpecialKey(paneTarget, "Enter");
          logDebug(`[Cursor] auto-trusted workspace at ${paneTarget}`);
          clearInterval(interval);
        }
      } catch {
        clearInterval(interval);
      }
    }, 1000);
  }

  /** Session sub-menu: Chat / Close */
  private async handleSessionCallback(query: TelegramBot.CallbackQuery): Promise<void> {
    const sessionId = query.data!.slice(8);
    if (!this.sessionMap || !query.message) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    const session = this.sessionMap.getBySessionId(sessionId);
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
          ],
        ],
      },
    });
  }

  /** Session close confirmation */
  private async handleSessionCloseConfirm(query: TelegramBot.CallbackQuery): Promise<void> {
    const sessionId = query.data!.slice(14);
    if (!this.sessionMap || !query.message) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    const session = this.sessionMap.getBySessionId(sessionId);
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

    const session = this.sessionMap.getBySessionId(sessionId);
    if (!session) {
      await this.bot.answerCallbackQuery(query.id, { text: t("chat.sessionExpired") });
      return;
    }

    // Kill tmux pane (best-effort)
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

  private getTmuxSessionName(): string {
    // If ccpoke was started inside tmux, use that session
    if (process.env.TMUX) {
      try {
        return execSync("tmux display-message -p '#{session_name}'", {
          encoding: "utf-8",
          stdio: "pipe",
          timeout: 3000,
        }).trim();
      } catch {
        // fall through
      }
    }

    // Fallback: first available session
    try {
      const output = execSync("tmux list-sessions -F '#{session_name}'", {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 3000,
      }).trim();
      const first = output.split("\n")[0];
      return first || "0";
    } catch {
      return "0";
    }
  }

  private registerPollingErrorHandler(): void {
    this.bot.on("polling_error", () => {
      if (!this.isDisconnected) {
        this.isDisconnected = true;
        logWarn(t("bot.connectionLost"));
      }
    });

    this.bot.on("polling", () => {
      if (this.isDisconnected) {
        this.isDisconnected = false;
        log(t("bot.connectionRestored"));
      }
    });
  }
}

const AGENT_START_COMMANDS: Record<string, string> = {
  [AgentName.ClaudeCode]: "claude --dangerously-skip-permissions",
  [AgentName.Cursor]: "cursor agent --force",
  [AgentName.Codex]: "codex --full-auto",
};

function resolveAgentStartCommand(agent: string): string {
  return AGENT_START_COMMANDS[agent] ?? AGENT_START_COMMANDS[AgentName.ClaudeCode]!;
}
