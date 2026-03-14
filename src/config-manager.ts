import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { isValidLocale, Locale, setLocale, t } from "./i18n/index.js";
import { DEFAULT_TUNNEL_TYPE, type TunnelType } from "./tunnel/types.js";
import { ChannelName, DEFAULT_HOOK_PORT } from "./utils/constants.js";
import { paths } from "./utils/paths.js";

export interface ProjectEntry {
  name: string;
  path: string;
}

export interface Config {
  channel: string;
  telegram_bot_token: string;
  user_id: number;
  discord_bot_token?: string;
  discord_user_id?: string;
  slack_bot_token?: string;
  slack_channel_id?: string;
  hook_port: number;
  hook_secret: string;
  tunnel: TunnelType;
  ngrok_authtoken?: string;
  locale: Locale;
  agents: string[];
  projects: ProjectEntry[];
}

export interface ChatState {
  chat_id: number | null;
  discord_dm_id?: string | null;
}

export class ConfigManager {
  static load(): Config {
    let data: string;
    try {
      data = readFileSync(paths.configFile, "utf-8");
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        throw new Error(t("config.notFound"), { cause: err });
      }
      throw err;
    }

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(data);
    } catch (err: unknown) {
      throw new Error(t("config.invalidJson"), { cause: err });
    }
    const cfg = ConfigManager.validate(raw);
    if (cfg.hook_secret !== raw.hook_secret || !raw.agents || !raw.projects || !raw.channel) {
      ConfigManager.save(cfg);
    }
    setLocale(cfg.locale);
    return cfg;
  }

  static save(cfg: Config): void {
    mkdirSync(paths.ccpokeDir, { recursive: true });
    chmodSync(paths.ccpokeDir, 0o700);
    const tmpPath = `${paths.configFile}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    renameSync(tmpPath, paths.configFile);
  }

  static isOwner(cfg: Config, userId: number): boolean {
    return cfg.user_id === userId;
  }

  static generateSecret(): string {
    return randomBytes(32).toString("hex");
  }

  static loadChatState(): ChatState {
    try {
      const data = readFileSync(paths.stateFile, "utf-8");
      return JSON.parse(data);
    } catch {
      return { chat_id: null };
    }
  }

  static saveChatState(state: ChatState): void {
    mkdirSync(paths.ccpokeDir, { recursive: true });
    chmodSync(paths.ccpokeDir, 0o700);
    const tmpPath = `${paths.stateFile}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmpPath, paths.stateFile);
  }

  private static validate(data: Record<string, unknown>): Config {
    if (typeof data !== "object" || data === null) {
      throw new Error(t("config.mustBeObject"));
    }

    const validChannelNames = new Set(Object.values(ChannelName) as string[]);
    let channel: string;
    if (typeof data.channel === "string" && validChannelNames.has(data.channel)) {
      channel = data.channel;
    } else if (Array.isArray(data.channels) && data.channels.length > 0) {
      const first = data.channels.find(
        (c): c is string => typeof c === "string" && validChannelNames.has(c)
      );
      channel = first ?? ChannelName.Telegram;
    } else {
      channel = ChannelName.Telegram;
    }

    if (channel === ChannelName.Telegram) {
      if (typeof data.telegram_bot_token !== "string" || !data.telegram_bot_token.includes(":")) {
        throw new Error(t("config.invalidToken"));
      }
      if (typeof data.user_id !== "number" || !Number.isInteger(data.user_id)) {
        throw new Error(t("config.invalidUserId"));
      }
    }

    if (channel === ChannelName.Discord) {
      if (typeof data.discord_bot_token !== "string" || data.discord_bot_token.length === 0) {
        throw new Error(t("config.invalidToken"));
      }
      if (typeof data.discord_user_id !== "string" || data.discord_user_id.length === 0) {
        throw new Error(t("config.invalidUserId"));
      }
    }

    if (channel === ChannelName.Slack) {
      if (typeof data.slack_bot_token !== "string" || !data.slack_bot_token.startsWith("xoxb-")) {
        throw new Error(t("config.invalidToken"));
      }
      if (typeof data.slack_channel_id !== "string" || data.slack_channel_id.length === 0) {
        throw new Error(t("config.invalidUserId"));
      }
    }

    let hookPort = DEFAULT_HOOK_PORT;
    if (data.hook_port !== undefined) {
      if (
        typeof data.hook_port !== "number" ||
        !Number.isInteger(data.hook_port) ||
        data.hook_port < 1 ||
        data.hook_port > 65535
      ) {
        throw new Error(t("config.invalidPort"));
      }
      hookPort = data.hook_port;
    }

    let hookSecret: string;
    if (typeof data.hook_secret === "string" && data.hook_secret.length > 0) {
      if (!/^[a-f0-9]+$/i.test(data.hook_secret)) {
        throw new Error(t("config.invalidSecret"));
      }
      hookSecret = data.hook_secret;
    } else {
      hookSecret = ConfigManager.generateSecret();
    }

    const locale: Locale = isValidLocale(data.locale) ? data.locale : Locale.EN;

    let tunnel: TunnelType = DEFAULT_TUNNEL_TYPE;
    if (data.tunnel === false) {
      tunnel = false;
    } else if (data.tunnel === "cloudflare" || data.tunnel === "ngrok") {
      tunnel = data.tunnel;
    }
    // TODO: re-add custom HTTPS URL validation when custom tunnel is implemented
    // else if (typeof data.tunnel === "string" && data.tunnel.startsWith("https://")) {
    //   tunnel = data.tunnel as `https://${string}`;
    // }

    let agents: string[] = ["claude-code"];
    if (Array.isArray(data.agents) && data.agents.length > 0) {
      agents = data.agents.filter((a): a is string => typeof a === "string");
    }

    let projects: ProjectEntry[] = [];
    if (Array.isArray(data.projects)) {
      projects = data.projects.filter(
        (p): p is ProjectEntry =>
          typeof p === "object" &&
          p !== null &&
          typeof (p as Record<string, unknown>).name === "string" &&
          typeof (p as Record<string, unknown>).path === "string"
      );
    }

    const cfg: Config = {
      channel,
      telegram_bot_token:
        typeof data.telegram_bot_token === "string" ? data.telegram_bot_token : "",
      user_id: typeof data.user_id === "number" ? data.user_id : 0,
      hook_port: hookPort,
      hook_secret: hookSecret,
      tunnel,
      locale,
      agents,
      projects,
    };

    if (typeof data.discord_bot_token === "string") cfg.discord_bot_token = data.discord_bot_token;
    if (typeof data.discord_user_id === "string") cfg.discord_user_id = data.discord_user_id;
    if (typeof data.slack_bot_token === "string") cfg.slack_bot_token = data.slack_bot_token;
    if (typeof data.slack_channel_id === "string") cfg.slack_channel_id = data.slack_channel_id;
    if (typeof data.ngrok_authtoken === "string" && data.ngrok_authtoken.length > 0) {
      cfg.ngrok_authtoken = data.ngrok_authtoken;
    }

    return cfg;
  }
}
