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
import type { SessionMap } from "../../tmux/session-map.js";
import type { SessionStateManager } from "../../tmux/session-state.js";
import type { TmuxBridge } from "../../tmux/tmux-bridge.js";
import { logger } from "../../utils/log.js";
import { autoAcceptStartupPrompts, launchAgent } from "./discord-agent-launcher.js";

export class DiscordSessionCommandHandler {
  constructor(
    private sessionMap: SessionMap,
    private tmuxBridge: TmuxBridge | null,
    private stateManager: SessionStateManager | null,
    private activeIntervals: ReturnType<typeof setInterval>[]
  ) {}

  async handleSessionsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (this.tmuxBridge) this.sessionMap.refreshFromTmux(this.tmuxBridge);

    const sessions = this.sessionMap.getAllActive();
    if (sessions.length === 0) {
      await interaction.reply({ content: "No active sessions.", ephemeral: false });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("Active Sessions")
      .setColor(0x00b894)
      .setDescription(
        sessions
          .slice(0, 20)
          .map((s) => `**${s.project}** · ${s.state}`)
          .join("\n")
      )
      .setTimestamp();

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (const s of sessions.slice(0, 5)) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`session_chat:${s.sessionId}`)
            .setLabel(`💬 ${s.project.slice(0, 30)}`)
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`session_close:${s.sessionId}`)
            .setLabel("Close")
            .setStyle(ButtonStyle.Danger)
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

  async handleSessionChatButton(interaction: ButtonInteraction, sessionId: string): Promise<void> {
    const session = this.sessionMap.getBySessionId(sessionId);
    if (!session) {
      await interaction.reply({ content: "Session not found.", ephemeral: true });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`chat_modal:${sessionId}`)
      .setTitle(`Chat → ${session.project.slice(0, 40)}`);

    const input = new TextInputBuilder()
      .setCustomId("chat_message")
      .setLabel("Message")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setPlaceholder(`Send to ${session.project}...`);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
  }

  async handleChatModalSubmit(
    interaction: ModalSubmitInteraction,
    sessionId: string
  ): Promise<void> {
    const text = interaction.fields.getTextInputValue("chat_message").trim();
    if (!text) {
      await interaction.reply({ content: "Empty message.", ephemeral: true });
      return;
    }

    const session = this.sessionMap.getBySessionId(sessionId);
    if (!session) {
      await interaction.reply({ content: "Session not found.", ephemeral: true });
      return;
    }

    if (!this.stateManager) {
      await interaction.reply({ content: "Two-way chat not available.", ephemeral: true });
      return;
    }

    const result = this.stateManager.injectMessage(sessionId, text);
    if ("sent" in result) {
      await interaction.reply({ content: `Sent to **${session.project}**` });
    } else if ("busy" in result) {
      await interaction.reply({ content: "Agent is busy.", ephemeral: true });
    } else {
      await interaction.reply({ content: "Session not found or expired.", ephemeral: true });
    }
  }

  async handleSessionCloseButton(interaction: ButtonInteraction, sessionId: string): Promise<void> {
    const session = this.sessionMap.getBySessionId(sessionId);
    if (!session) {
      await interaction.reply({ content: "Session not found.", ephemeral: true });
      return;
    }

    if (this.tmuxBridge && session.tmuxTarget) {
      try {
        this.tmuxBridge.killPane(session.tmuxTarget);
      } catch {
        /* pane may already be dead */
      }
    }

    this.sessionMap.unregister(sessionId);
    this.sessionMap.save();
    logger.info(`[Discord] closed session ${sessionId} (${session.project})`);
    await interaction.reply({ content: `Closed session for **${session.project}**` });
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
      const { paneTarget, needsTrust } = launchAgent(this.tmuxBridge, project.path, agentKey);

      this.sessionMap.register(
        `pre-${paneTarget.replace(/[:.]/g, "-")}`,
        paneTarget,
        project.name,
        project.path,
        "",
        agentKey as AgentName
      );

      if (needsTrust) {
        autoAcceptStartupPrompts(
          this.tmuxBridge,
          paneTarget,
          agentKey,
          (iv) => this.activeIntervals.push(iv),
          (iv) => {
            const idx = this.activeIntervals.indexOf(iv);
            if (idx >= 0) this.activeIntervals.splice(idx, 1);
          }
        );
      }

      logger.info(`[Discord] started ${agentKey} in ${paneTarget} for ${project.name}`);
      await interaction.reply({ content: `Started **${agentKey}** for **${project.name}**` });
    } catch (err) {
      logger.error({ err }, `[Discord] failed to start agent for ${project.name}`);
      await interaction.reply({ content: `Failed to start agent for **${project.name}**` });
    }
  }
}
