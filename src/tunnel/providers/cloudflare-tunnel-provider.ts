import { existsSync } from "node:fs";

import { t } from "../../i18n/index.js";
import { logger } from "../../utils/log.js";
import { TUNNEL_TIMEOUT_MS, validateTunnelPort, type TunnelProvider } from "../types.js";

export class CloudflareTunnelProvider implements TunnelProvider {
  private tunnel: { stop: () => boolean } | null = null;
  private url: string | null = null;
  onExit?: () => void;

  async start(port: number): Promise<string> {
    validateTunnelPort(port);
    const { Tunnel, bin, install } = await import("cloudflared");

    if (!existsSync(bin)) {
      logger.info(t("tunnel.installing"));
      await install(bin);
      logger.info(t("tunnel.installed"));
    }

    this.cleanup();
    const tunnel = Tunnel.quick(`http://localhost:${port}`);

    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        tunnel.stop();
        reject(new Error(t("tunnel.timeout", { seconds: TUNNEL_TIMEOUT_MS / 1000 })));
      }, TUNNEL_TIMEOUT_MS);

      tunnel.once("url", (u: string) => {
        clearTimeout(timeout);
        resolve(u);
      });
      tunnel.once("error", (e: Error) => {
        clearTimeout(timeout);
        reject(e);
      });
    });

    this.tunnel = tunnel;
    this.url = url;

    tunnel.on("disconnected", () => logger.warn(t("tunnel.disconnected")));
    tunnel.on("exit", (code: number | null) => {
      logger.info(t("tunnel.exited", { code: code ?? 0 }));
      this.tunnel = null;
      this.url = null;
      this.onExit?.();
    });

    return url;
  }

  async stop(): Promise<void> {
    this.cleanup();
  }

  getPublicUrl(): string | null {
    return this.url;
  }

  private cleanup(): void {
    if (this.tunnel) {
      this.tunnel.stop();
      this.tunnel = null;
      this.url = null;
    }
  }
}
