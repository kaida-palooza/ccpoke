#!/usr/bin/env node
import { basename } from "node:path";

import { AgentHandler } from "./agent/agent-handler.js";
import { createDefaultRegistry } from "./agent/agent-registry.js";
import { DiscordChannel } from "./channel/discord/discord-channel.js";
import { SlackChannel } from "./channel/slack/slack-channel.js";
import { TelegramChannel } from "./channel/telegram/telegram-channel.js";
import type { ChannelDeps, NotificationChannel } from "./channel/types.js";
import { runBug } from "./commands/bug.js";
import { runChannel } from "./commands/channel.js";
import { runHelp } from "./commands/help.js";
import { runProject } from "./commands/project.js";
import { runSetup } from "./commands/setup.js";
import { runUninstall } from "./commands/uninstall.js";
import { runUpdate } from "./commands/update.js";
import { ConfigManager, type Config } from "./config-manager.js";
import { HookEnvWriter } from "./hooks/hook-env-writer.js";
import { t } from "./i18n/index.js";
import { ApiServer } from "./server/api-server.js";
import { PaneRegistry } from "./tmux/pane-registry.js";
import { PaneStateManager } from "./tmux/pane-state-manager.js";
import { TmuxBridge } from "./tmux/tmux-bridge.js";
import { TmuxPaneResolver } from "./tmux/tmux-pane-resolver.js";
import { findAgentDescendant, queryPanePid } from "./tmux/tmux-scanner.js";
import { TunnelManager } from "./tunnel/tunnel-manager.js";
import { ChannelName, CliCommand, InstallMethod, refreshWindowsPath } from "./utils/constants.js";
import { detectInstallMethod } from "./utils/install-detection.js";
import { flushLogger, logger } from "./utils/log.js";
import { ensureShellCompletion } from "./utils/shell-completion.js";
import { checkForUpdates } from "./utils/version-check.js";

refreshWindowsPath();

const args = process.argv.slice(2);

if (args.length > 0) {
  handleSubcommand(args);
} else {
  startBot();
}

async function loadOrSetupConfig(): Promise<Config> {
  try {
    const config = ConfigManager.load();
    ensureAgentHooks(config);
    return config;
  } catch {
    logger.info(t("bot.firstTimeSetup"));
    try {
      return await runSetup({ autoStart: true });
    } catch (err: unknown) {
      logger.error({ err }, t("common.setupFailed"));
      return new Promise(() => flushLogger(() => process.exit(1)));
    }
  }
}

function ensureAgentHooks(config: Config): void {
  const registry = createDefaultRegistry();
  HookEnvWriter.write(config.hook_port, config.hook_secret);

  for (const agentName of config.agents) {
    const provider = registry.resolve(agentName);
    if (!provider) continue;

    const integrity = provider.verifyIntegrity();
    if (integrity.complete) continue;

    if (!provider.detect()) {
      logger.error(t("setup.agentNotInstalled", { agent: provider.displayName }));
      continue;
    }

    provider.installHook();
    logger.info(
      t("tmux.hookRepaired", { agent: provider.displayName, missing: integrity.missing.join(", ") })
    );
  }
}

function formatWarningBox(msg: string): string {
  const maxLen = msg.length;
  const top = "┏" + "━".repeat(maxLen + 2) + "┓";
  const bottom = "┗" + "━".repeat(maxLen + 2) + "┛";
  const line = `┃ ${msg} ┃`;
  return [top, line, bottom].join("\n");
}

async function startBot(): Promise<void> {
  await checkForUpdates().catch(() => {});

  const cfg = await loadOrSetupConfig();
  ensureShellCompletion();

  const registry = createDefaultRegistry();

  const tmuxBridge = new TmuxBridge();
  const paneRegistry = new PaneRegistry();
  const paneStateManager = new PaneStateManager(paneRegistry, tmuxBridge, registry);

  let chatResolver: TmuxPaneResolver | undefined;

  if (tmuxBridge.isTmuxAvailable()) {
    paneRegistry.load();
    const bootResult = paneRegistry.refreshFromTmux(tmuxBridge);
    if (
      bootResult.reconciled > 0 ||
      bootResult.discovered.length > 0 ||
      bootResult.removed.length > 0
    ) {
      paneRegistry.save();
    }
    chatResolver = new TmuxPaneResolver(paneRegistry, paneStateManager);
    paneRegistry.startPeriodicScan(tmuxBridge, 5_000, (result) => {
      for (const p of result.discovered)
        logger.info(t("tmux.sessionDiscovered", { target: p.paneId, project: p.project }));
      for (const p of result.removed) {
        logger.info(t("tmux.sessionLost", { target: p.paneId, project: p.project }));
      }
      if (result.discovered.length > 0 || result.removed.length > 0)
        logger.info(
          t("tmux.scanSummary", {
            active: result.total,
            discovered: result.discovered.length,
            lost: result.removed.length,
          })
        );
    });
    for (const p of bootResult.discovered)
      logger.info(t("tmux.sessionDiscovered", { target: p.paneId, project: p.project }));
    logger.info(t("tmux.scanComplete", { count: bootResult.total }));
    logger.info(t("bot.twowayEnabled"));
  } else {
    logger.warn(formatWarningBox(t("tmux.notAvailable")));
  }

  const apiServer = new ApiServer(cfg.hook_port, cfg.hook_secret);
  await apiServer.start();
  logger.info(`ccpoke: ${t("bot.started", { port: cfg.hook_port })}`);

  const tunnelManager = new TunnelManager(cfg.tunnel, cfg.ngrok_authtoken);
  apiServer.setTunnelManager(tunnelManager);
  try {
    const tunnelUrl = await tunnelManager.start(cfg.hook_port);
    if (tunnelUrl) logger.info(t("tunnel.started", { url: tunnelUrl }));
  } catch (err: unknown) {
    logger.error({ err }, t("tunnel.failed"));
  }

  let channel: NotificationChannel;

  const deps: ChannelDeps = { paneRegistry, paneStateManager, tmuxBridge, registry };

  switch (cfg.channel) {
    case ChannelName.Discord:
      channel = new DiscordChannel(cfg, deps);
      break;
    case ChannelName.Slack:
      channel = new SlackChannel(cfg, deps);
      break;
    default:
      channel = new TelegramChannel(cfg, deps);
      break;
  }

  const handler = new AgentHandler(registry, channel, cfg.hook_port, tunnelManager, chatResolver);

  handler.onSessionStart = (rawEvent) => {
    const obj = (typeof rawEvent === "object" && rawEvent !== null ? rawEvent : {}) as Record<
      string,
      unknown
    >;
    if (typeof obj.session_id !== "string" || typeof obj.pane_id !== "string") return;
    if (!/^%\d+$/.test(obj.pane_id)) return;
    const cwd = typeof obj.cwd === "string" ? obj.cwd : "";
    const project = basename(cwd) || "unknown";
    const panePid = typeof obj.pane_id === "string" ? queryPanePid(obj.pane_id) : undefined;
    const detectedAgent = panePid ? (findAgentDescendant(panePid) ?? undefined) : undefined;
    paneRegistry.register(obj.pane_id, project, cwd, "", detectedAgent);
    paneRegistry.save();
    logger.info(
      t("tmux.hookReceived", {
        event: "SessionStart",
        sessionId: obj.session_id,
        target: obj.pane_id,
        project,
      })
    );
  };

  handler.onNotification = (event) => {
    channel.handleNotificationEvent(event);
  };

  handler.onAskUserQuestion = (event) => {
    channel.handleAskUserQuestionEvent(event);
  };

  handler.onPermissionRequest = (event) => {
    channel.handlePermissionRequestEvent(event);
  };

  apiServer.setHandler(handler);

  await channel.initialize();

  if (detectInstallMethod() === InstallMethod.Npx) {
    logger.info(t("bot.globalInstallTip"));
  }

  let shutdownStarted = false;
  const shutdown = async () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    logger.info(t("bot.shuttingDown"));
    paneRegistry.stopPeriodicScan();
    paneRegistry.save();
    await tunnelManager.stop();
    await channel.shutdown();
    await apiServer.stop();
    flushLogger(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.on("uncaughtException", (err) => {
    logger.error({ err }, "uncaught exception");
    flushLogger(() => process.exit(1));
  });

  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "unhandled rejection");
    flushLogger(() => process.exit(1));
  });
}

function handleSubcommand(args: string[]): void {
  try {
    ConfigManager.load();
  } catch {
    // config may not exist yet for setup command
  }

  switch (args[0]) {
    case CliCommand.Setup:
      runSetup().catch((err: unknown) => {
        logger.error({ err }, t("common.setupFailed"));
        flushLogger(() => process.exit(1));
      });
      break;

    case CliCommand.Update:
      runUpdate();
      break;

    case CliCommand.Uninstall:
      runUninstall();
      break;

    case CliCommand.Project:
      runProject().catch((err: unknown) => {
        logger.error({ err }, t("common.setupFailed"));
        flushLogger(() => process.exit(1));
      });
      break;

    case CliCommand.Channel:
      runChannel().catch((err: unknown) => {
        logger.error({ err }, t("common.setupFailed"));
        flushLogger(() => process.exit(1));
      });
      break;

    case CliCommand.Help:
    case CliCommand.HelpFlag:
    case CliCommand.HelpShort:
      runHelp();
      break;

    case CliCommand.Bug:
      runBug().catch((err: unknown) => {
        logger.error({ err }, t("common.setupFailed"));
        flushLogger(() => process.exit(1));
      });
      break;

    default:
      logger.error(t("common.unknownCommand", { command: args[0]! }));
      runHelp();
      flushLogger(() => process.exit(1));
  }
}
