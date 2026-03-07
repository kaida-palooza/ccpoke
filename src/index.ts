#!/usr/bin/env node
import { basename } from "node:path";

import { AgentHandler } from "./agent/agent-handler.js";
import { createDefaultRegistry } from "./agent/agent-registry.js";
import { DiscordChannel } from "./channel/discord/discord-channel.js";
import { SlackChannel } from "./channel/slack/slack-channel.js";
import { TelegramChannel } from "./channel/telegram/telegram-channel.js";
import type { ChannelDeps, NotificationChannel } from "./channel/types.js";
import { runChannel } from "./commands/channel.js";
import { runHelp } from "./commands/help.js";
import { runProject } from "./commands/project.js";
import { runSetup } from "./commands/setup.js";
import { runUninstall } from "./commands/uninstall.js";
import { runUpdate } from "./commands/update.js";
import { ConfigManager, type Config } from "./config-manager.js";
import { t } from "./i18n/index.js";
import { ApiServer } from "./server/api-server.js";
import { SessionMap } from "./tmux/session-map.js";
import { SessionStateManager } from "./tmux/session-state.js";
import { TmuxBridge } from "./tmux/tmux-bridge.js";
import { TmuxSessionResolver } from "./tmux/tmux-session-resolver.js";
import { ChannelName, CliCommand, InstallMethod } from "./utils/constants.js";
import { detectInstallMethod } from "./utils/install-detection.js";
import { log, logError, logWarn } from "./utils/log.js";
import { ensureShellCompletion } from "./utils/shell-completion.js";
import { TunnelManager } from "./utils/tunnel.js";
import { checkForUpdates } from "./utils/version-check.js";

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
    log(t("bot.firstTimeSetup"));
    try {
      return await runSetup({ autoStart: true });
    } catch (err: unknown) {
      logError(t("common.setupFailed"), err);
      process.exit(1);
    }
  }
}

function ensureAgentHooks(config: Config): void {
  const registry = createDefaultRegistry();

  for (const agentName of config.agents) {
    const provider = registry.resolve(agentName);
    if (!provider) continue;

    const integrity = provider.verifyIntegrity();
    if (integrity.complete) continue;

    if (!provider.detect()) {
      logError(t("setup.agentNotInstalled", { agent: provider.displayName }));
      continue;
    }

    provider.installHook(config.hook_port, config.hook_secret);
    log(
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
  const sessionMap = new SessionMap();
  const stateManager = new SessionStateManager(sessionMap, tmuxBridge, registry);

  let chatResolver: TmuxSessionResolver | undefined;

  if (tmuxBridge.isTmuxAvailable()) {
    sessionMap.load();
    const bootResult = sessionMap.refreshFromTmux(tmuxBridge);
    chatResolver = new TmuxSessionResolver(sessionMap, stateManager);
    sessionMap.startPeriodicScan(tmuxBridge, 5_000, (result) => {
      for (const s of result.discovered)
        log(t("tmux.sessionDiscovered", { target: s.tmuxTarget, project: s.project }));
      for (const s of result.removed) {
        log(t("tmux.sessionLost", { target: s.tmuxTarget, project: s.project }));
      }
      if (result.discovered.length > 0 || result.removed.length > 0)
        log(
          t("tmux.scanSummary", {
            active: result.total,
            discovered: result.discovered.length,
            lost: result.removed.length,
          })
        );
    });
    for (const s of bootResult.discovered)
      log(t("tmux.sessionDiscovered", { target: s.tmuxTarget, project: s.project }));
    log(t("tmux.scanComplete", { count: bootResult.total }));
    log(t("bot.twowayEnabled"));
  } else {
    logWarn(formatWarningBox(t("tmux.notAvailable")), { showTimestamp: false });
  }

  const apiServer = new ApiServer(cfg.hook_port, cfg.hook_secret);
  await apiServer.start();
  log(`ccpoke: ${t("bot.started", { port: cfg.hook_port })}`);

  const tunnelManager = new TunnelManager();
  apiServer.setTunnelManager(tunnelManager);
  try {
    const tunnelUrl = await tunnelManager.start(cfg.hook_port);
    log(t("tunnel.started", { url: tunnelUrl }));
  } catch (err: unknown) {
    logError(t("tunnel.failed"), err);
  }

  let channel: NotificationChannel;

  const deps: ChannelDeps = { sessionMap, stateManager, tmuxBridge, registry };

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
    if (typeof obj.session_id !== "string" || typeof obj.tmux_target !== "string") return;
    if (!/^[a-zA-Z0-9_.:/@ -]+$/.test(obj.tmux_target)) return;
    const cwd = typeof obj.cwd === "string" ? obj.cwd : "";
    const project = basename(cwd) || "unknown";
    sessionMap.register(obj.session_id, obj.tmux_target, project, cwd);
    sessionMap.save();
    log(
      t("tmux.hookReceived", {
        event: "SessionStart",
        sessionId: obj.session_id,
        target: obj.tmux_target,
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
    log(t("bot.globalInstallTip"));
  }

  let shutdownStarted = false;
  const shutdown = async () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    log(t("bot.shuttingDown"));
    sessionMap.stopPeriodicScan();
    sessionMap.save();
    tunnelManager.stop();
    await channel.shutdown();
    await apiServer.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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
        logError(t("common.setupFailed"), err);
        process.exit(1);
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
        logError(t("common.setupFailed"), err);
        process.exit(1);
      });
      break;

    case CliCommand.Channel:
      runChannel().catch((err: unknown) => {
        logError(t("common.setupFailed"), err);
        process.exit(1);
      });
      break;

    case CliCommand.Help:
    case CliCommand.HelpFlag:
    case CliCommand.HelpShort:
      runHelp();
      break;

    default:
      logError(t("common.unknownCommand", { command: args[0]! }));
      runHelp();
      process.exit(1);
  }
}
