import { hostname } from "node:os";

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  type ButtonInteraction,
  type DMChannel,
  type TextChannel,
} from "discord.js";

import type {
  AskUserQuestionEvent,
  NotificationEvent,
  PermissionRequestEvent,
} from "../../agent/agent-handler.js";
import type { AgentRegistry } from "../../agent/agent-registry.js";
import { ConfigManager, type Config } from "../../config-manager.js";
import { t } from "../../i18n/index.js";
import type { SessionMap } from "../../tmux/session-map.js";
import type { SessionStateManager } from "../../tmux/session-state.js";
import type { TmuxBridge } from "../../tmux/tmux-bridge.js";
import { logger } from "../../utils/log.js";
import type { ChannelDeps, NotificationChannel, NotificationData } from "../types.js";
import { DiscordAskQuestionHandler } from "./discord-ask-question-handler.js";
import { formatNotificationEmbed } from "./discord-markdown.js";
import { DiscordPermissionHandler } from "./discord-permission-handler.js";
import { DiscordPromptHandler } from "./discord-prompt-handler.js";
import { sendDiscordDM } from "./discord-sender.js";
import { DiscordSessionCommandHandler } from "./discord-session-command-handler.js";

interface PendingElicitation {
  messageId: string;
  sessionId: string;
  project: string;
}

const MAX_PENDING_ELICITATIONS = 50;
const ELICITATION_TTL_MS = 10 * 60 * 1000;
const DISCORD_READY_TIMEOUT_MS = 30_000;

export class DiscordChannel implements NotificationChannel {
  private client: Client;
  private dmChannel: DMChannel | TextChannel | null = null;
  private cfg: Config;
  private sessionMap: SessionMap | null;
  private stateManager: SessionStateManager | null;
  private tmuxBridge: TmuxBridge | null;
  private registry: AgentRegistry | null;
  private permissionHandler: DiscordPermissionHandler | null = null;
  private askQuestionHandler: DiscordAskQuestionHandler | null = null;
  private promptHandler: DiscordPromptHandler | null = null;
  private sessionCommandHandler: DiscordSessionCommandHandler | null = null;
  private pendingElicitations = new Map<string, PendingElicitation>();
  private elicitationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private activeIntervals: ReturnType<typeof setInterval>[] = [];

  constructor(cfg: Config, deps?: ChannelDeps) {
    this.cfg = cfg;
    this.sessionMap = deps?.sessionMap ?? null;
    this.stateManager = deps?.stateManager ?? null;
    this.tmuxBridge = deps?.tmuxBridge ?? null;
    this.registry = deps?.registry ?? null;

    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  async initialize(): Promise<void> {
    await this.client.login(this.cfg.discord_bot_token);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Discord ready timeout")),
        DISCORD_READY_TIMEOUT_MS
      );
      this.client.once(Events.ClientReady, async () => {
        clearTimeout(timer);
        logger.info(`[Discord] bot ready as ${this.client.user?.tag}`);
        await this.openDMChannel();
        await this.registerSlashCommands();
        this.registerInteractionHandler();
        this.registerMessageHandler();
        resolve();
      });
    });

    if (this.dmChannel && this.sessionMap && this.tmuxBridge && this.registry) {
      this.permissionHandler = new DiscordPermissionHandler(
        () => this.dmChannel,
        this.sessionMap,
        this.tmuxBridge
      );

      this.askQuestionHandler = new DiscordAskQuestionHandler(
        () => this.dmChannel,
        this.tmuxBridge
      );

      this.promptHandler = new DiscordPromptHandler(
        () => this.dmChannel,
        this.sessionMap,
        this.tmuxBridge,
        this.registry
      );

      this.promptHandler.onElicitationSent = (messageId, sessionId, project) => {
        this.trackElicitation(messageId, sessionId, project);
      };

      this.sessionCommandHandler = new DiscordSessionCommandHandler(
        this.sessionMap,
        this.tmuxBridge,
        this.stateManager,
        this.activeIntervals
      );
    }

    if (this.dmChannel) {
      sendDiscordDM(this.dmChannel, t("bot.startupReadyPlain", { host: hostname() })).catch(
        () => {}
      );
    }
  }

  async shutdown(): Promise<void> {
    this.permissionHandler?.destroy();
    this.askQuestionHandler?.destroy();
    this.promptHandler?.destroy();
    for (const timer of this.elicitationTimers.values()) clearTimeout(timer);
    this.elicitationTimers.clear();
    this.pendingElicitations.clear();
    for (const iv of this.activeIntervals) clearInterval(iv);
    this.activeIntervals = [];
    this.client.destroy();
  }

  handleNotificationEvent(event: NotificationEvent): void {
    this.promptHandler?.forwardPrompt(event).catch(() => {});
  }

  handleAskUserQuestionEvent(event: AskUserQuestionEvent): void {
    this.askQuestionHandler?.forwardQuestion(event).catch(() => {});
  }

  handlePermissionRequestEvent(event: PermissionRequestEvent): void {
    this.permissionHandler?.forwardPermission(event).catch(() => {});
  }

  async sendNotification(data: NotificationData, responseUrl?: string): Promise<void> {
    if (!this.dmChannel) {
      logger.info("[Discord] no DM channel configured");
      return;
    }

    try {
      const embed = formatNotificationEmbed(data, responseUrl);
      const components = data.sessionId
        ? [buildChatRow(data.sessionId, responseUrl)]
        : responseUrl
          ? [buildViewRow(responseUrl)]
          : [];

      await this.dmChannel.send({ embeds: [embed], components });
    } catch (err) {
      logger.error({ err }, "[Discord] notification send failed");
    }
  }

  private trackElicitation(messageId: string, sessionId: string, project: string): void {
    if (this.pendingElicitations.size >= MAX_PENDING_ELICITATIONS) {
      const oldest = this.pendingElicitations.keys().next().value as string;
      this.pendingElicitations.delete(oldest);
      const timer = this.elicitationTimers.get(oldest);
      if (timer) {
        clearTimeout(timer);
        this.elicitationTimers.delete(oldest);
      }
    }

    this.pendingElicitations.set(messageId, { messageId, sessionId, project });
    const ttl = setTimeout(() => {
      this.pendingElicitations.delete(messageId);
      this.elicitationTimers.delete(messageId);
    }, ELICITATION_TTL_MS);
    this.elicitationTimers.set(messageId, ttl);
  }

  private clearElicitationTimer(refId: string): void {
    const timer = this.elicitationTimers.get(refId);
    if (timer) {
      clearTimeout(timer);
      this.elicitationTimers.delete(refId);
    }
  }

  private async openDMChannel(): Promise<void> {
    if (!this.cfg.discord_user_id) return;

    try {
      const user = await this.client.users.fetch(this.cfg.discord_user_id);
      this.dmChannel = await user.createDM();

      const saved = ConfigManager.loadChatState();
      if (saved.discord_dm_id !== this.dmChannel.id) {
        ConfigManager.saveChatState({ ...saved, discord_dm_id: this.dmChannel.id });
      }

      logger.debug(`[Discord] DM channel opened: ${this.dmChannel.id}`);
    } catch (err) {
      logger.error({ err }, "[Discord] failed to open DM channel");
    }
  }

  private async registerSlashCommands(): Promise<void> {
    if (!this.client.user || !this.cfg.discord_bot_token) return;

    const commands = [
      new SlashCommandBuilder().setName("sessions").setDescription("List active agent sessions"),
      new SlashCommandBuilder().setName("projects").setDescription("List configured projects"),
    ].map((c) => c.toJSON());

    try {
      const rest = new REST().setToken(this.cfg.discord_bot_token);
      await rest.put(Routes.applicationCommands(this.client.user.id), { body: commands });
      logger.info("[Discord] slash commands registered");
    } catch (err) {
      logger.error({ err }, "[Discord] slash command registration failed");
    }
  }

  private registerInteractionHandler(): void {
    this.client.on("interactionCreate", async (interaction) => {
      try {
        if (interaction.user.id !== this.cfg.discord_user_id) return;
        if (interaction.isChatInputCommand()) {
          if (interaction.commandName === "sessions") {
            await this.sessionCommandHandler?.handleSessionsCommand(interaction);
          } else if (interaction.commandName === "projects") {
            await this.sessionCommandHandler?.handleProjectsCommand(interaction);
          }
          return;
        }

        if (interaction.isModalSubmit()) {
          const customId = interaction.customId;
          if (customId.startsWith("chat_modal:")) {
            await this.sessionCommandHandler?.handleChatModalSubmit(
              interaction,
              customId.slice(11)
            );
          }
          return;
        }

        if (!interaction.isButton()) return;
        const btn = interaction as ButtonInteraction;
        const id = btn.customId;

        if (id.startsWith("perm:")) {
          await this.permissionHandler?.handleInteraction(btn);
        } else if (id.startsWith("aq:") || id.startsWith("am:")) {
          await this.askQuestionHandler?.handleInteraction(btn);
        } else if (id.startsWith("elicit:")) {
          await this.promptHandler?.handleElicitReplyButton(btn, id.slice(7));
        } else if (id.startsWith("session_chat:")) {
          await this.sessionCommandHandler?.handleSessionChatButton(btn, id.slice(13));
        } else if (id.startsWith("session_close:")) {
          await this.sessionCommandHandler?.handleSessionCloseButton(btn, id.slice(14));
        } else if (id.startsWith("proj:")) {
          await this.sessionCommandHandler?.handleProjectButton(btn, parseInt(id.slice(5), 10));
        } else if (id.startsWith("agent_start:")) {
          await this.sessionCommandHandler?.handleAgentStartButton(btn);
        }
      } catch (err) {
        logger.error({ err }, "[Discord] interaction error");
      }
    });
  }

  private registerMessageHandler(): void {
    this.client.on("messageCreate", async (msg) => {
      if (msg.author.bot) return;
      if (msg.author.id !== this.cfg.discord_user_id) return;
      if (!msg.channel.isDMBased()) return;

      const text = msg.content;
      if (!text) return;

      let elicitation: PendingElicitation | undefined;
      let matchedKey: string | undefined;

      if (msg.reference?.messageId) {
        matchedKey = msg.reference.messageId;
        elicitation = this.pendingElicitations.get(matchedKey);
      }

      if (!elicitation || !matchedKey) return;

      this.pendingElicitations.delete(matchedKey);
      this.clearElicitationTimer(matchedKey);

      if (this.promptHandler) {
        const injected = this.promptHandler.injectElicitationResponse(elicitation.sessionId, text);
        if (injected) {
          await msg.reply(`Sent to **${elicitation.project}**`).catch(() => {});
          return;
        }
      }

      if (!this.stateManager) {
        await msg.reply("Session not found or expired.").catch(() => {});
        return;
      }

      const result = this.stateManager.injectMessage(elicitation.sessionId, text);
      if ("sent" in result) {
        await msg.reply(`Sent to **${elicitation.project}**`).catch(() => {});
      } else if ("busy" in result) {
        await msg.reply("Agent is busy.").catch(() => {});
      } else {
        await msg.reply("Session not found or expired.").catch(() => {});
      }
    });
  }
}

function buildChatRow(sessionId: string, responseUrl?: string): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();

  if (responseUrl) {
    row.addComponents(
      new ButtonBuilder().setLabel("📖 View Details").setStyle(ButtonStyle.Link).setURL(responseUrl)
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`session_chat:${sessionId}`)
      .setLabel("💬 Chat")
      .setStyle(ButtonStyle.Primary)
  );

  return row;
}

function buildViewRow(responseUrl: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("📖 View Details").setStyle(ButtonStyle.Link).setURL(responseUrl)
  );
}
