import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
  type DMChannel,
  type Message,
  type TextChannel,
} from "discord.js";

import type { NotificationEvent } from "../../agent/agent-handler.js";
import type { AgentRegistry } from "../../agent/agent-registry.js";
import { SessionState, type SessionMap } from "../../tmux/session-map.js";
import type { TmuxBridge } from "../../tmux/tmux-bridge.js";
import { logger } from "../../utils/log.js";

interface PendingPrompt {
  sessionId: string;
  createdAt: number;
}

const PROMPT_EXPIRE_MS = 10 * 60 * 1000;
const MAX_PENDING = 100;
const MAX_RESPONSE_LENGTH = 10_000;
const EMBED_COLOR = 0x74b9ff;

export class DiscordPromptHandler {
  private pending = new Map<string, PendingPrompt>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  onElicitationSent?: (messageId: string, sessionId: string, project: string) => void;

  constructor(
    private getChannel: () => DMChannel | TextChannel | null,
    private sessionMap: SessionMap,
    private tmuxBridge: TmuxBridge,
    private registry: AgentRegistry
  ) {}

  async forwardPrompt(event: NotificationEvent): Promise<void> {
    const channel = this.getChannel();
    if (!channel) return;

    if (event.notificationType === "elicitation_dialog") {
      await this.sendElicitationPrompt(channel, event);
    }
  }

  injectElicitationResponse(sessionId: string, text: string): boolean {
    const session = this.sessionMap.getBySessionId(sessionId);
    if (!session) return false;
    if (!this.pending.has(sessionId)) return false;

    logger.info(
      `[Discord:Prompt:inject] sessionId=${sessionId} tmuxTarget=${session.tmuxTarget} text="${text.slice(0, 50)}"`
    );

    const trimmed = text.trim();
    if (trimmed.length === 0) return false;

    const safeText =
      trimmed.length > MAX_RESPONSE_LENGTH ? trimmed.slice(0, MAX_RESPONSE_LENGTH) : trimmed;

    const submitKeys = this.registry.resolve(session.agent)!.submitKeys;

    try {
      this.tmuxBridge.sendKeys(session.tmuxTarget, safeText, submitKeys);
    } catch {
      return false;
    }

    this.sessionMap.updateState(sessionId, SessionState.Busy);
    this.sessionMap.touch(sessionId);
    this.clearPending(sessionId);
    return true;
  }

  async handleElicitReplyButton(interaction: ButtonInteraction, sessionId: string): Promise<void> {
    const session = this.sessionMap.getBySessionId(sessionId);
    if (!session) {
      await interaction.reply({ content: "Session expired.", ephemeral: true });
      return;
    }

    await interaction.reply({
      content: `Reply for **${session.project}**: send your message as a DM`,
      ephemeral: true,
    });
  }

  destroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }

  private async sendElicitationPrompt(
    channel: DMChannel | TextChannel,
    event: NotificationEvent
  ): Promise<void> {
    const title = event.title ? `❓ ${event.title}` : "❓ Input Required";
    const project = this.sessionMap.getBySessionId(event.sessionId)?.project;

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(title)
      .setDescription(event.message)
      .setTimestamp();

    if (project) {
      embed.setFooter({ text: project });
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`elicit:${event.sessionId}`)
        .setLabel("Reply")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("💬")
    );

    const sent = await channel
      .send({ embeds: [embed], components: [row] })
      .catch(() => null as Message | null);

    if (sent) {
      this.setPending(event.sessionId);
      this.onElicitationSent?.(sent.id, event.sessionId, project ?? "");
      logger.debug(
        `[Discord:Prompt] elicitation sent msgId=${sent.id} sessionId=${event.sessionId}`
      );
    }
  }

  private setPending(sessionId: string): void {
    if (this.pending.size >= MAX_PENDING && !this.pending.has(sessionId)) {
      const oldest = [...this.pending.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (oldest) this.clearPending(oldest[0]);
    }

    this.clearPending(sessionId);
    this.pending.set(sessionId, { sessionId, createdAt: Date.now() });

    const timer = setTimeout(() => {
      this.pending.delete(sessionId);
      this.timers.delete(sessionId);
    }, PROMPT_EXPIRE_MS);
    this.timers.set(sessionId, timer);
  }

  private clearPending(sessionId: string): void {
    this.pending.delete(sessionId);
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }
}
