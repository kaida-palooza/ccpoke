import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
  type DMChannel,
  type TextChannel,
} from "discord.js";

import type { PermissionRequestEvent } from "../../agent/agent-handler.js";
import type { SessionMap } from "../../tmux/session-map.js";
import type { TmuxBridge } from "../../tmux/tmux-bridge.js";
import { logger } from "../../utils/log.js";
import { summarizeTool } from "../summarize-tool.js";

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
const EMBED_COLOR_WARN = 0xfdcb6e;
const EMBED_COLOR_ALLOW = 0x00b894;
const EMBED_COLOR_DENY = 0xd63031;

export class DiscordPermissionHandler {
  private pending = new Map<number, PendingPermission>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private nextPendingId = 1;

  constructor(
    private getChannel: () => DMChannel | TextChannel | null,
    private sessionMap: SessionMap,
    private tmuxBridge: TmuxBridge
  ) {}

  async forwardPermission(event: PermissionRequestEvent): Promise<void> {
    const channel = this.getChannel();
    if (!channel || !event.tmuxTarget) return;

    logger.info(
      `[Discord:PermReq] sessionId=${event.sessionId} tmuxTarget=${event.tmuxTarget} tool=${event.toolName}`
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

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR_WARN)
      .setTitle("⚠️ Permission Request")
      .setDescription(`**${projectName}**`)
      .addFields(
        { name: "🔧 Tool", value: event.toolName, inline: true },
        { name: "Input", value: `\`${toolSummary}\`` }
      )
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`perm:a:${pendingId}`)
        .setLabel("Allow")
        .setStyle(ButtonStyle.Success)
        .setEmoji("✅"),
      new ButtonBuilder()
        .setCustomId(`perm:d:${pendingId}`)
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger)
        .setEmoji("❌")
    );

    await channel.send({ embeds: [embed], components: [row] }).catch((err: unknown) => {
      logger.error({ err }, "[Discord:PermReq] send failed");
    });
  }

  async handleInteraction(interaction: ButtonInteraction): Promise<void> {
    const parts = interaction.customId.split(":");
    if (parts.length < 3) return;

    const action = parts[1];
    const pendingId = parseInt(parts[2]!, 10);
    const allow = action === "a";

    const pp = this.pending.get(pendingId);
    if (!pp) {
      await interaction.reply({ content: "This permission request has expired.", ephemeral: true });
      return;
    }

    const resultEmoji = allow ? "✅" : "❌";
    const resultText = allow
      ? `Allowed: **${pp.toolName}** — \`${pp.toolSummary}\``
      : `Denied: **${pp.toolName}** — \`${pp.toolSummary}\``;

    const updatedEmbed = new EmbedBuilder()
      .setColor(allow ? EMBED_COLOR_ALLOW : EMBED_COLOR_DENY)
      .setDescription(`${resultEmoji} ${resultText}`)
      .setTimestamp();

    await interaction.deferUpdate();

    try {
      await injectResponse(this.tmuxBridge, pp.tmuxTarget, allow);
      logger.debug(`[Discord:PermReq] injected ${allow ? "allow" : "deny"} → ${pp.tmuxTarget}`);
    } catch (err) {
      logger.error({ err }, "[Discord:PermReq] injection failed");
    }

    await interaction.editReply({ embeds: [updatedEmbed], components: [] }).catch(() => {});

    this.clearPending(pendingId);
  }

  destroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
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

async function injectResponse(
  tmuxBridge: TmuxBridge,
  tmuxTarget: string,
  allow: boolean
): Promise<void> {
  const ready = await tmuxBridge.waitForTuiReady(tmuxTarget, 5000);
  if (!ready) throw new Error("TUI not ready");
  tmuxBridge.sendKeys(tmuxTarget, allow ? "y" : "n", ["Enter"]);
}
