import { execSync, spawn } from "node:child_process";

import * as p from "@clack/prompts";
import TelegramBot from "node-telegram-bot-api";
import qrcode from "qrcode-terminal";

import { createDefaultRegistry } from "../agent/agent-registry.js";
import { AgentName } from "../agent/types.js";
import { ConfigManager, type Config } from "../config-manager.js";
import { Locale, LOCALE_LABELS, setLocale, SUPPORTED_LOCALES, t } from "../i18n/index.js";
import { DEFAULT_HOOK_PORT, isMacOS, isWindows } from "../utils/constants.js";
import { detectCliPrefix } from "../utils/install-detection.js";
import { installShellCompletion } from "../utils/shell-completion.js";

const SETUP_WAIT_TIMEOUT_MS = 120_000;

export async function runSetup(): Promise<Config> {
  p.intro(t("setup.intro"));

  let existing: Config | null = null;
  try {
    existing = ConfigManager.load();
  } catch {
    // first-time setup
  }

  const locale = await promptLanguage(existing);
  setLocale(locale);

  const token = await promptToken(existing);

  const tokenUnchanged = existing !== null && token === existing.telegram_bot_token;
  let userId: number;

  if (tokenUnchanged) {
    userId = existing!.user_id;
    p.log.success(t("setup.tokenUnchanged"));
  } else {
    const botUsername = await verifyToken(token);
    userId = await waitForUserStart(token, botUsername);
  }

  const previousAgents = existing?.agents ?? [];
  const selectedAgents = await promptAgents(previousAgents);

  const config = buildConfig(token, userId, existing, locale, selectedAgents);

  saveConfig(config);
  syncAgentHooks(config, previousAgents);
  registerChatId(userId);
  await promptTmuxSetup();

  const startCommand = detectCliPrefix();
  installShellCompletion();
  p.outro(t("setup.complete", { command: startCommand }));

  return config;
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

async function promptToken(existing: Config | null): Promise<string> {
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

async function verifyToken(token: string): Promise<string> {
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

async function waitForUserStart(token: string, botUsername: string): Promise<number> {
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
    const label = installed ? provider.displayName : `${provider.displayName} ⚠️ not installed`;

    return {
      value: provider.name,
      label,
      hint: installed ? "detected" : "not found on this machine",
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
  token: string,
  userId: number,
  existing: Config | null,
  locale: Locale,
  agents: string[]
): Config {
  return {
    telegram_bot_token: token,
    user_id: userId,
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

function getTmuxVersion(): string | null {
  try {
    return execSync("tmux -V", { stdio: "pipe", encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

function detectTmuxInstallCommand(): string | null {
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

async function promptTmuxSetup(): Promise<void> {
  if (isWindows()) {
    p.log.warn(t("bot.windowsNoTwoWay"));
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

function runCommandAsync(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { stdio: "pipe" });

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
