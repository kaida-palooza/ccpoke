import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";

import { AGENT_DISPLAY_NAMES, AgentName } from "../../agent/types.js";
import { ConfigManager } from "../../config-manager.js";
import { PaneState, type PaneRegistry } from "../../tmux/pane-registry.js";
import type { PaneStateManager } from "../../tmux/pane-state-manager.js";
import type { TmuxBridge } from "../../tmux/tmux-bridge.js";
import { isPaneAlive, queryPanePid } from "../../tmux/tmux-scanner.js";
import { logger } from "../../utils/log.js";
import { autoAcceptStartupPrompts, launchAgent } from "./discord-agent-launcher.js";

function extractTmuxTarget(suffix: string): string {
  const lastColon = suffix.lastIndexOf(":");
  if (lastColon === -1) return suffix;
  const maybePid = suffix.slice(lastColon + 1);
  if (/^\d+$/.test(maybePid)) return suffix.slice(0, lastColon);
  return suffix;
}

export class DiscordPaneCommandHandler {
  constructor(
    private paneRegistry: PaneRegistry,
    private tmuxBridge: TmuxBridge | null,
    private paneStateManager: PaneStateManager | null,
    private activeIntervals: ReturnType<typeof setInterval>[]
  ) {}

  async handleSessionsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (this.tmuxBridge) this.paneRegistry.refreshFromTmux(this.tmuxBridge);

    const panes = this.paneRegistry.getAllActive();
    if (panes.length === 0) {
      await interaction.reply({ content: "No active sessions.", ephemeral: false });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("Active Sessions")
      .setColor(0x00b894)
      .setDescription(
        panes
          .slice(0, 20)
          .map((p) => `**${p.project}** · ${p.state}`)
          .join("\n")
      )
      .setTimestamp();

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (const p of panes.slice(0, 5)) {
      const pid = queryPanePid(p.paneId) ?? "";
      const chatId = pid ? `session_chat:${p.paneId}:${pid}` : `session_chat:${p.paneId}`;
      const closeId = pid ? `session_close:${p.paneId}:${pid}` : `session_close:${p.paneId}`;
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(chatId)
            .setLabel(`💬 ${p.project.slice(0, 30)}`)
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(closeId).setLabel("Close").setStyle(ButtonStyle.Danger)
        )
      );
    }

    await interaction.reply({ embeds: [embed], components: rows });
  }

  async handleProjectsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const cfg = ConfigManager.load();
    if (cfg.projects.length === 0) {
      await interaction.reply({ content: "No projects configured.", ephemeral: false });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("Projects")
      .setColor(0x00b894)
      .setDescription(cfg.projects.map((p) => `📂 **${p.name}**`).join("\n"))
      .setTimestamp();

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < Math.min(cfg.projects.length, 5); i++) {
      const proj = cfg.projects[i]!;
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`proj:${i}`)
            .setLabel(`▶ ${proj.name.slice(0, 60)}`)
            .setStyle(ButtonStyle.Success)
        )
      );
    }

    await interaction.reply({ embeds: [embed], components: rows });
  }

  async handleSessionChatButton(
    interaction: ButtonInteraction,
    customIdSuffix: string
  ): Promise<void> {
    const paneId = extractTmuxTarget(customIdSuffix);
    const pane = this.paneRegistry.getByPaneId(paneId);
    if (!pane) {
      await interaction.reply({ content: "Session not found.", ephemeral: true });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`chat_modal:${paneId}`)
      .setTitle(`Chat → ${pane.project.slice(0, 40)}`);

    const input = new TextInputBuilder()
      .setCustomId("chat_message")
      .setLabel("Message")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setPlaceholder(`Send to ${pane.project}...`);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
  }

  async handleChatModalSubmit(interaction: ModalSubmitInteraction, paneId: string): Promise<void> {
    const text = interaction.fields.getTextInputValue("chat_message").trim();
    if (!text) {
      await interaction.reply({ content: "Empty message.", ephemeral: true });
      return;
    }

    const pane = this.paneRegistry.getByPaneId(paneId);
    if (!pane) {
      await interaction.reply({ content: "Session not found.", ephemeral: true });
      return;
    }

    if (!this.paneStateManager) {
      await interaction.reply({ content: "Two-way chat not available.", ephemeral: true });
      return;
    }

    const result = this.paneStateManager.injectMessage(paneId, text);
    if ("sent" in result) {
      await interaction.reply({ content: `Sent to **${pane.project}**` });
    } else if ("sentToShell" in result) {
      await interaction.reply({ content: `Sent to shell (no agent) → **${pane.project}**` });
    } else if ("busy" in result) {
      await interaction.reply({ content: "Agent is busy.", ephemeral: true });
    } else if ("noAgent" in result) {
      await interaction.reply({ content: "No agent running in pane.", ephemeral: true });
    } else {
      await interaction.reply({ content: "Session not found or expired.", ephemeral: true });
    }
  }

  async handleSessionCloseButton(
    interaction: ButtonInteraction,
    customIdSuffix: string
  ): Promise<void> {
    const paneId = extractTmuxTarget(customIdSuffix);
    const pane = this.paneRegistry.getByPaneId(paneId);
    if (!pane) {
      await interaction.reply({ content: "Session not found.", ephemeral: true });
      return;
    }

    if (this.tmuxBridge && pane.paneId && isPaneAlive(pane.paneId)) {
      try {
        this.tmuxBridge.killPane(pane.paneId);
      } catch (e: unknown) {
        logger.debug(
          `[Discord:close] killPane failed: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    this.paneRegistry.unregister(paneId);
    this.paneRegistry.save();
    logger.info(`[Discord] closed session ${paneId} (${pane.project})`);
    await interaction.reply({ content: `Closed session for **${pane.project}**` });
  }

  async handleProjectButton(interaction: ButtonInteraction, idx: number): Promise<void> {
    const cfg = ConfigManager.load();
    const project = cfg.projects[idx];
    if (!project) {
      await interaction.reply({ content: "Project not found.", ephemeral: true });
      return;
    }

    if (!this.tmuxBridge || !this.tmuxBridge.isTmuxAvailable()) {
      await interaction.reply({ content: "tmux is not available.", ephemeral: true });
      return;
    }

    const agents = cfg.agents;
    if (agents.length === 1) {
      await this.startAgentForProject(interaction, project, agents[0]!);
      return;
    }

    const row = new ActionRowBuilder<ButtonBuilder>();
    for (let i = 0; i < Math.min(agents.length, 5); i++) {
      const agent = agents[i]!;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`agent_start:${idx}:${agent}`)
          .setLabel(AGENT_DISPLAY_NAMES[agent as AgentName] ?? agent)
          .setStyle(ButtonStyle.Secondary)
      );
    }

    await interaction.reply({
      content: `Choose agent for **${project.name}**:`,
      components: [row],
    });
  }

  async handleAgentStartButton(interaction: ButtonInteraction): Promise<void> {
    const parts = interaction.customId.slice(12).split(":");
    const idx = Number(parts[0]);
    const agentKey = parts[1];
    const cfg = ConfigManager.load();
    const project = cfg.projects[idx];

    if (!project || !agentKey) {
      await interaction.reply({ content: "Invalid request.", ephemeral: true });
      return;
    }

    await this.startAgentForProject(interaction, project, agentKey);
  }

  private async startAgentForProject(
    interaction: ButtonInteraction,
    project: { name: string; path: string },
    agentKey: string
  ): Promise<void> {
    if (!this.tmuxBridge) return;

    try {
      const {
        paneId,
        panePid: _panePid,
        needsTrust,
      } = launchAgent(this.tmuxBridge, project.path, agentKey);

      this.paneRegistry.register(paneId, project.name, project.path, "", agentKey as AgentName);
      this.paneRegistry.updateState(paneId, PaneState.Launching);

      if (needsTrust) {
        autoAcceptStartupPrompts(
          this.tmuxBridge,
          paneId,
          agentKey,
          (iv) => this.activeIntervals.push(iv),
          (iv) => {
            const idx = this.activeIntervals.indexOf(iv);
            if (idx >= 0) this.activeIntervals.splice(idx, 1);
          }
        );
      }

      logger.info(`[Discord] started ${agentKey} in ${paneId} for ${project.name}`);
      await interaction.reply({ content: `Started **${agentKey}** for **${project.name}**` });
    } catch (err) {
      logger.error({ err }, `[Discord] failed to start agent for ${project.name}`);
      await interaction.reply({ content: `Failed to start agent for **${project.name}**` });
    }
  }
}
