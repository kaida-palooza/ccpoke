import { execSync, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

import * as p from "@clack/prompts";
import { WebClient } from "@slack/web-api";
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import TelegramBot from "node-telegram-bot-api";
import qrcode from "qrcode-terminal";

import { createDefaultRegistry } from "../agent/agent-registry.js";
import { AgentName } from "../agent/types.js";
import { ConfigManager, type Config } from "../config-manager.js";
import { Locale, LOCALE_LABELS, setLocale, SUPPORTED_LOCALES, t } from "../i18n/index.js";
import { resetTmuxBinaryCache } from "../tmux/tmux-bridge.js";
import { ChannelName, DEFAULT_HOOK_PORT, isMacOS, isWindows } from "../utils/constants.js";
import { detectCliPrefix } from "../utils/install-detection.js";
import { promptPath } from "../utils/path-prompt.js";
import { installShellCompletion } from "../utils/shell-completion.js";
import { shellSpawnArgs } from "../utils/shell.js";

const SETUP_WAIT_TIMEOUT_MS = 120_000;

export interface SetupOptions {
  autoStart?: boolean;
}

export async function runSetup(options: SetupOptions = {}): Promise<Config> {
  p.intro(t("setup.intro"));

  let existing: Config | null = null;
  try {
    existing = ConfigManager.load();
  } catch {
    // first-time setup
  }

  const locale = await promptLanguage(existing);
  setLocale(locale);

  const channel = await promptChannel(existing);

  let token = "";
  let userId = 0;

  if (channel === ChannelName.Telegram) {
    token = await promptToken(existing);
    const tokenUnchanged = existing !== null && token === existing.telegram_bot_token;

    if (tokenUnchanged) {
      userId = existing!.user_id;
      p.log.success(t("setup.tokenUnchanged"));
    } else {
      const botUsername = await verifyToken(token);
      userId = await waitForUserStart(token, botUsername);
    }
  }

  const config = buildConfig(channel, token, userId, existing, locale, []);

  if (channel === ChannelName.Discord) {
    await promptDiscordCredentials(config, existing);
  } else if (channel === ChannelName.Slack) {
    await promptSlackCredentials(config, existing);
  }

  const previousAgents = existing?.agents ?? [];
  const selectedAgents = await promptAgents(previousAgents);
  config.agents = selectedAgents;

  saveConfig(config);
  syncAgentHooks(config, previousAgents);
  if (channel === ChannelName.Telegram) {
    registerChatId(userId);
  }
  await promptTmuxSetup();
  await promptProjectSetup(config);

  installShellCompletion();

  if (options.autoStart) {
    p.outro(t("setup.completeAutoStart"));
  } else {
    const startCommand = detectCliPrefix();
    p.outro(t("setup.complete", { command: startCommand }));
  }

  return config;
}

async function promptChannel(existing: Config | null): Promise<string> {
  const result = await p.select({
    message: t("setup.channelMessage"),
    initialValue: existing?.channel ?? ChannelName.Telegram,
    options: [
      { value: ChannelName.Telegram, label: "Telegram" },
      { value: ChannelName.Discord, label: "Discord" },
      { value: ChannelName.Slack, label: "Slack" },
    ],
  });

  if (p.isCancel(result)) {
    p.cancel(t("setup.cancelled"));
    process.exit(0);
  }

  return result;
}

async function promptLanguage(existing: Config | null): Promise<Locale> {
  const result = await p.select({
    message: t("setup.languageMessage"),
    initialValue: existing?.locale ?? Locale.EN,
    options: SUPPORTED_LOCALES.map((loc) => ({
      value: loc,
      label: LOCALE_LABELS[loc],
    })),
  });

  if (p.isCancel(result)) {
    p.cancel(t("setup.cancelled"));
    process.exit(0);
  }

  return result;
}

export async function promptToken(existing: Config | null): Promise<string> {
  const result = await p.text({
    message: t("setup.tokenMessage"),
    placeholder: t("setup.tokenPlaceholder"),
    initialValue: existing?.telegram_bot_token ?? "",
    validate(value) {
      if (!value || !value.trim()) return t("setup.tokenRequired");
      if (!value.includes(":")) return t("setup.tokenInvalidFormat");
    },
  });

  if (p.isCancel(result)) {
    p.cancel(t("setup.cancelled"));
    process.exit(0);
  }

  return result.trim();
}

export async function verifyToken(token: string): Promise<string> {
  const spinner = p.spinner();
  spinner.start(t("setup.verifyingToken"));

  try {
    const bot = new TelegramBot(token);
    const me = await bot.getMe();

    spinner.stop(t("setup.botVerified", { username: me.username ?? "unknown" }));
    return me.username ?? "unknown";
  } catch {
    spinner.stop(t("setup.tokenVerifyFailed"));
    throw new Error(t("setup.tokenVerifyFailed"));
  }
}

export async function waitForUserStart(token: string, botUsername: string): Promise<number> {
  const deepLink = `https://t.me/${botUsername}?start=setup`;

  p.log.step(t("setup.scanOrClick"));

  const qrString = await new Promise<string>((resolve) => {
    qrcode.generate(deepLink, { small: true }, (code: string) => {
      resolve(code);
    });
  });

  const indentedQr = qrString
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => `│    ${line}`)
    .join("\n");

  process.stdout.write(`${indentedQr}\n│\n│    ${deepLink}\n`);

  p.log.step(t("setup.waitingForStart"));

  const bot = new TelegramBot(token, { polling: true });

  try {
    const userId = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        bot.stopPolling();
        reject(new Error(t("setup.waitingTimeout", { seconds: SETUP_WAIT_TIMEOUT_MS / 1000 })));
      }, SETUP_WAIT_TIMEOUT_MS);

      bot.onText(/\/start(?:\s|$)/, (msg) => {
        clearTimeout(timeout);

        bot
          .sendMessage(msg.chat.id, t("setup.userDetected", { userId: msg.from!.id }))
          .finally(() => {
            bot.stopPolling();
            resolve(msg.from!.id);
          });
      });
    });

    p.log.success(t("setup.userDetected", { userId }));
    return userId;
  } catch (err) {
    bot.stopPolling();
    throw err;
  }
}

async function promptAgents(previousAgents: string[]): Promise<string[]> {
  const registry = createDefaultRegistry();
  const providers = registry.all();

  const initialValues = previousAgents.length > 0 ? previousAgents : [AgentName.ClaudeCode];

  const options = providers.map((provider) => {
    const installed = provider.detect();
    const label = installed
      ? `${provider.displayName} (${t("setup.agentDetected")})`
      : `${provider.displayName} ⚠️`;

    return {
      value: provider.name,
      label,
      hint: installed ? "" : t("setup.agentNotInstalled", { agent: provider.displayName }),
    };
  });

  const result = await p.multiselect({
    message: t("setup.selectAgents"),
    options,
    initialValues,
    required: true,
  });

  if (p.isCancel(result)) {
    p.cancel(t("setup.cancelled"));
    process.exit(0);
  }

  const selected = result as string[];
  if (!selected.includes(AgentName.ClaudeCode)) {
    selected.unshift(AgentName.ClaudeCode);
  }

  return selected;
}

function buildConfig(
  channel: string,
  token: string,
  userId: number,
  existing: Config | null,
  locale: Locale,
  agents: string[]
): Config {
  return {
    channel,
    telegram_bot_token: token || existing?.telegram_bot_token || "",
    user_id: userId || existing?.user_id || 0,
    hook_port: existing?.hook_port || DEFAULT_HOOK_PORT,
    hook_secret: existing?.hook_secret || ConfigManager.generateSecret(),
    locale,
    agents,
    projects: existing?.projects || [],
  };
}

function saveConfig(config: Config): void {
  ConfigManager.save(config);
  p.log.success(t("setup.configSaved"));
}

function syncAgentHooks(config: Config, previousAgents: string[]): void {
  const registry = createDefaultRegistry();

  const removedAgents = previousAgents.filter((a) => !config.agents.includes(a));
  for (const agentName of removedAgents) {
    const provider = registry.resolve(agentName);
    if (!provider) continue;

    try {
      provider.uninstallHook();
      p.log.success(t("setup.agentHookUninstalled", { agent: provider.displayName }));
    } catch {
      // hook may not exist
    }
  }

  for (const agentName of config.agents) {
    const provider = registry.resolve(agentName);
    if (!provider) continue;

    if (!provider.detect()) {
      p.log.warn(t("setup.agentNotInstalled", { agent: provider.displayName }));
      continue;
    }

    if (provider.isHookInstalled()) {
      p.log.step(t("setup.agentHookAlreadyInstalled", { agent: provider.displayName }));
      continue;
    }

    try {
      provider.installHook(config.hook_port, config.hook_secret);
      p.log.success(t("setup.agentHookInstalled", { agent: provider.displayName }));
    } catch (err: unknown) {
      p.log.error(
        t("setup.hookFailed", { error: err instanceof Error ? err.message : String(err) })
      );
      throw err;
    }
  }
}

function registerChatId(userId: number): void {
  const state = ConfigManager.loadChatState();

  if (state.chat_id === userId) {
    return;
  }

  state.chat_id = userId;
  ConfigManager.saveChatState(state);
  p.log.success(t("setup.chatIdRegistered"));
}

export async function promptDiscordCredentials(
  config: Config,
  existing: Config | null
): Promise<void> {
  const botToken = await p.text({
    message: t("setup.discordTokenMessage"),
    placeholder: t("setup.discordTokenPlaceholder"),
    initialValue: existing?.discord_bot_token ?? "",
    validate(value) {
      if (!value || !value.trim()) return t("setup.tokenRequired");
    },
  });

  if (p.isCancel(botToken)) {
    p.cancel(t("setup.cancelled"));
    process.exit(0);
  }

  const token = (botToken as string).trim();
  config.discord_bot_token = token;

  const tokenUnchanged = existing !== null && token === existing.discord_bot_token;

  if (tokenUnchanged && existing?.discord_user_id) {
    config.discord_user_id = existing.discord_user_id;
    p.log.success(t("setup.discordTokenUnchanged"));
    return;
  }

  const botInfo = await verifyDiscordToken(token);
  config.discord_user_id = await waitForDiscordDM(token, botInfo.id);
}

async function verifyDiscordToken(token: string): Promise<{ id: string; username: string }> {
  const spinner = p.spinner();
  spinner.start(t("setup.discordVerifyingToken"));

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  try {
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 15_000);
      client.once(Events.ClientReady, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await client.login(token);
    await ready;

    const id = client.user!.id;
    const username = client.user!.tag ?? client.user!.username ?? "unknown";

    spinner.stop(t("setup.discordBotVerified", { username }));
    client.destroy();
    return { id, username };
  } catch {
    client.destroy();
    spinner.stop(t("setup.discordTokenVerifyFailed"));
    throw new Error(t("setup.discordTokenVerifyFailed"));
  }
}

async function waitForDiscordDM(token: string, botId: string): Promise<string> {
  const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${botId}&scope=bot%20applications.commands&permissions=18432`;

  p.log.step(t("setup.discordScanOrClick"));

  const qrString = await new Promise<string>((resolve) => {
    qrcode.generate(inviteUrl, { small: true }, (code: string) => {
      resolve(code);
    });
  });

  const indentedQr = qrString
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => `│    ${line}`)
    .join("\n");

  process.stdout.write(`${indentedQr}\n│\n│    ${inviteUrl}\n`);

  p.log.step(t("setup.discordWaitingForDM"));

  const client = new Client({
    intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.Guilds],
    partials: [Partials.Channel, Partials.Message],
  });

  try {
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 15_000);
      client.once(Events.ClientReady, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await client.login(token);
    await ready;

    const userId = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(t("setup.discordWaitingTimeout", { seconds: SETUP_WAIT_TIMEOUT_MS / 1000 }))
        );
      }, SETUP_WAIT_TIMEOUT_MS);

      client.on(Events.GuildCreate, async (guild) => {
        try {
          const owner = await guild.fetchOwner();
          const dm = await owner.createDM();
          await dm.send(t("setup.discordUserDetected", { userId: owner.id }));
          clearTimeout(timeout);
          resolve(owner.id);
        } catch {
          // guild owner DM failed — fall back to waiting for manual DM
        }
      });

      client.on("messageCreate", async (msg) => {
        if (msg.author.bot) return;
        if (!msg.channel.isDMBased()) return;

        clearTimeout(timeout);
        await msg.reply(t("setup.discordUserDetected", { userId: msg.author.id })).catch(() => {});
        resolve(msg.author.id);
      });
    });

    p.log.success(t("setup.discordUserDetected", { userId }));
    client.destroy();
    return userId;
  } catch (err) {
    client.destroy();
    throw err;
  }
}

export async function promptSlackCredentials(
  config: Config,
  existing: Config | null
): Promise<void> {
  const botToken = await p.text({
    message: t("setup.slackTokenMessage"),
    placeholder: t("setup.slackTokenPlaceholder"),
    initialValue: existing?.slack_bot_token ?? "",
    validate(value) {
      if (!value || !value.trim()) return t("setup.tokenRequired");
      if (!value.startsWith("xoxb-")) return t("setup.slackTokenInvalidFormat");
    },
  });

  if (p.isCancel(botToken)) {
    p.cancel(t("setup.cancelled"));
    process.exit(0);
  }

  const token = (botToken as string).trim();
  config.slack_bot_token = token;

  const tokenUnchanged = existing !== null && token === existing.slack_bot_token;

  if (tokenUnchanged && existing?.slack_channel_id) {
    config.slack_channel_id = existing.slack_channel_id;
    p.log.success(t("setup.slackTokenUnchanged"));
    return;
  }

  const verified = await verifySlackToken(token);
  if (!verified) throw new Error(t("setup.slackTokenVerifyFailed"));

  config.slack_channel_id = await pickSlackChannel(token, existing);
  await verifySlackChannelMembership(token, config.slack_channel_id);
}

async function verifySlackToken(token: string): Promise<boolean> {
  const spinner = p.spinner();
  spinner.start(t("setup.slackVerifyingToken"));

  try {
    const client = new WebClient(token);
    const result = await client.auth.test();
    spinner.stop(
      t("setup.slackBotVerified", { name: (result.bot_id as string | undefined) ?? "bot" })
    );
    return true;
  } catch {
    spinner.stop(t("setup.slackTokenVerifyFailed"));
    return false;
  }
}

async function pickSlackChannel(token: string, existing: Config | null): Promise<string> {
  const client = new WebClient(token);

  let channels: { id: string; name: string }[] = [];
  try {
    const result = await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 100,
    });
    channels =
      result.channels
        ?.filter((c) => c.is_member && c.id && c.name)
        .map((c) => ({ id: c.id!, name: c.name! })) ?? [];
  } catch {
    // scope missing or error — fallback to manual
  }

  if (channels.length > 0) {
    const selected = await p.select({
      message: t("setup.slackSelectChannel"),
      initialValue: existing?.slack_channel_id ?? channels[0]!.id,
      options: channels.map((c) => ({ value: c.id, label: `#${c.name}` })),
    });

    if (p.isCancel(selected)) {
      p.cancel(t("setup.cancelled"));
      process.exit(0);
    }

    return selected;
  }

  const channelId = await p.text({
    message: t("setup.slackChannelIdMessage"),
    placeholder: t("setup.slackChannelIdPlaceholder"),
    initialValue: existing?.slack_channel_id ?? "",
    validate(value) {
      if (!value || !value.trim()) return t("setup.slackChannelIdRequired");
    },
  });

  if (p.isCancel(channelId)) {
    p.cancel(t("setup.cancelled"));
    process.exit(0);
  }

  return (channelId as string).trim();
}

async function verifySlackChannelMembership(token: string, channelId: string): Promise<void> {
  const spinner = p.spinner();
  spinner.start(t("setup.slackVerifyingChannel"));

  const client = new WebClient(token);
  try {
    const info = await client.conversations.info({ channel: channelId });
    if (info.channel?.is_member) {
      spinner.stop(t("setup.slackChannelVerified"));
      return;
    }
  } catch {
    // fall through to bot name lookup + warning
  }

  let botName = "your-bot";
  try {
    const auth = await client.auth.test();
    if (auth.user) botName = auth.user as string;
  } catch {
    // ignore
  }

  spinner.stop(t("setup.slackChannelNotMember", { name: botName }));
}

function getTmuxVersion(): string | null {
  try {
    return execSync("tmux -V", { stdio: "pipe", encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

function detectTmuxInstallCommand(): string | null {
  if (isWindows()) {
    return detectPsmuxInstallCommand();
  }

  if (isMacOS()) {
    try {
      execSync("which brew", { stdio: "pipe" });
      return "brew install tmux";
    } catch {
      return null;
    }
  }

  try {
    execSync("which apt-get", { stdio: "pipe" });
    return "sudo apt-get install -y tmux";
  } catch {
    return null;
  }
}

interface PsmuxInstaller {
  name: string;
  check: string;
  install: string;
}

const PSMUX_INSTALLERS: PsmuxInstaller[] = [
  {
    name: "winget",
    check: "winget --version",
    install:
      "winget install marlocarlo.psmux --accept-source-agreements --accept-package-agreements",
  },
  {
    name: "scoop",
    check: "scoop --version",
    install:
      "scoop install https://raw.githubusercontent.com/marlocarlo/psmux/master/scoop/psmux.json",
  },
  { name: "choco", check: "choco --version", install: "choco install psmux -y" },
];

function detectPsmuxInstallCommand(): string | null {
  for (const installer of PSMUX_INSTALLERS) {
    try {
      execSync(installer.check, { stdio: "pipe", timeout: 5000 });
      return installer.install;
    } catch {
      continue;
    }
  }
  return null;
}

async function promptTmuxSetup(): Promise<void> {
  if (isWindows()) {
    const version = getTmuxVersion() ?? getPsmuxVersion();
    if (version) {
      p.log.success(t("setup.tmuxDetected", { version }));
      return;
    }

    const shouldInstall = await p.confirm({
      message: t("setup.psmuxInstallPrompt"),
      initialValue: true,
    });

    if (p.isCancel(shouldInstall) || !shouldInstall) {
      p.log.info(t("setup.tmuxInstallSkipped"));
      return;
    }

    const installCmd = detectPsmuxInstallCommand();
    if (!installCmd) {
      p.log.warn(t("setup.psmuxInstallFailed"));
      return;
    }

    const installer = PSMUX_INSTALLERS.find((i) => i.install === installCmd)!;
    const s = p.spinner();
    s.start(`${installer.name}: ${installCmd}`);
    try {
      await runCommandAsync(installCmd);
      resetTmuxBinaryCache();
      s.stop(t("setup.tmuxInstallSuccess"));
    } catch {
      s.stop(`${installer.name} failed`);
      p.log.warn(t("setup.psmuxInstallFailed"));
    }
    return;
  }

  const tmuxVersion = getTmuxVersion();
  if (tmuxVersion) {
    p.log.success(t("setup.tmuxDetected", { version: tmuxVersion }));
    return;
  }

  const shouldInstall = await p.confirm({
    message: t("setup.tmuxInstallPrompt"),
    initialValue: true,
  });

  if (p.isCancel(shouldInstall) || !shouldInstall) {
    p.log.info(t("setup.tmuxInstallSkipped"));
    return;
  }

  const installCmd = detectTmuxInstallCommand();
  if (!installCmd) {
    p.log.warn(t("setup.tmuxInstallFailed"));
    return;
  }

  const s = p.spinner();
  s.start(installCmd);

  try {
    await runCommandAsync(installCmd);
    s.stop(t("setup.tmuxInstallSuccess"));
  } catch {
    s.stop(t("setup.tmuxInstallFailed"));
  }
}

function getPsmuxVersion(): string | null {
  try {
    return execSync("psmux -V", { stdio: "pipe", encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

function runCommandAsync(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { cmd, args } = shellSpawnArgs(command);
    const child = spawn(cmd, args, { stdio: "pipe" });

    let output = "";

    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      output += data.toString();
    });

    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });

    child.on("error", reject);
  });
}

async function promptProjectSetup(config: Config): Promise<void> {
  if (config.projects.length > 0) return;

  const shouldAdd = await p.confirm({
    message: t("setup.addProjectPrompt"),
    initialValue: true,
  });

  if (p.isCancel(shouldAdd) || !shouldAdd) {
    p.log.info(t("setup.skipProject"));
    return;
  }

  while (true) {
    const added = await promptSingleProject(config);
    if (!added) break;

    const continueAdding = await p.confirm({
      message: t("setup.addAnotherProject"),
      initialValue: false,
    });

    if (p.isCancel(continueAdding) || !continueAdding) break;
  }
}

async function promptSingleProject(config: Config): Promise<boolean> {
  const rawPath = await promptPath(t("projectCmd.pathMessage"), process.cwd());

  if (p.isCancel(rawPath)) return false;

  const pathStr = rawPath as string;
  if (!pathStr) {
    p.log.error(t("projectCmd.pathRequired"));
    return false;
  }

  const fullPath = resolve(pathStr);
  if (!existsSync(fullPath) || !statSync(fullPath).isDirectory()) {
    p.log.error(t("projectCmd.pathInvalid"));
    return false;
  }

  const name = await p.text({
    message: t("projectCmd.nameMessage"),
    initialValue: basename(fullPath),
    validate(value) {
      if (!value || !value.trim()) return t("projectCmd.nameRequired");
      if (config.projects.some((proj) => proj.name === value.trim()))
        return t("projectCmd.nameDuplicate");
    },
  });

  if (p.isCancel(name)) return false;

  const trimmedName = (name as string).trim();
  config.projects.push({ name: trimmedName, path: fullPath });
  ConfigManager.save(config);
  p.log.success(t("setup.projectAdded", { name: trimmedName, path: fullPath }));
  return true;
}
