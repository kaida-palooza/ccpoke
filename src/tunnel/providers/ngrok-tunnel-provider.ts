import ngrok from "@ngrok/ngrok";

import { t } from "../../i18n/index.js";
import { logger } from "../../utils/log.js";
import { validateTunnelPort, type TunnelProvider } from "../types.js";

export class NgrokTunnelProvider implements TunnelProvider {
  private listener: ngrok.Listener | null = null;
  private authtoken: string;
  onExit?: () => void;

  constructor(authtoken: string) {
    if (!authtoken || authtoken.trim().length === 0) {
      throw new Error(t("tunnel.ngrokAuthtokenRequired"));
    }
    this.authtoken = authtoken;
  }

  async start(port: number): Promise<string> {
    validateTunnelPort(port);

    this.listener = await ngrok.forward({
      addr: port,
      authtoken: this.authtoken,
    });

    const url = this.listener.url();
    if (!url) {
      await this.listener.close();
      this.listener = null;
      throw new Error(t("tunnel.ngrokNoUrl"));
    }

    logger.info(t("tunnel.ngrokNoAutoRestart"));

    return url;
  }

  async stop(): Promise<void> {
    if (!this.listener) return;
    const ref = this.listener;
    this.listener = null;
    try {
      await ref.close();
    } catch (err) {
      logger.warn({ err }, t("tunnel.ngrokCloseFailed"));
    }
  }

  getPublicUrl(): string | null {
    return this.listener?.url() ?? null;
  }
}
