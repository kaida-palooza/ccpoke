import { existsSync } from "node:fs";

import { t } from "../i18n/index.js";
import { logger } from "./log.js";

const TUNNEL_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

export class TunnelManager {
  private tunnel: { stop: () => boolean } | null = null;
  private url: string | null = null;
  private port: number | null = null;
  private stopped = false;

  async start(port: number): Promise<string> {
    this.port = port;
    this.stopped = false;
    return this.connectWithRetry();
  }

  getPublicUrl(): string | null {
    return this.url;
  }

  stop(): void {
    this.stopped = true;
    this.cleanup();
  }

  private async connectWithRetry(): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (this.stopped) throw new Error("tunnel stopped");

      if (attempt > 0) {
        const delay = RETRY_DELAYS_MS[attempt - 1]!;
        logger.info(t("tunnel.retrying", { attempt, max: MAX_RETRIES, seconds: delay / 1000 }));
        await this.sleep(delay);
        if (this.stopped) throw new Error("tunnel stopped");
      }

      try {
        return await this.connect();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logger.warn(t("tunnel.attemptFailed", { attempt: attempt + 1, error: lastError.message }));
      }
    }

    throw lastError ?? new Error("tunnel failed");
  }

  private async connect(): Promise<string> {
    const { Tunnel, bin, install } = await import("cloudflared");

    if (!existsSync(bin)) {
      logger.info(t("tunnel.installing"));
      await install(bin);
      logger.info(t("tunnel.installed"));
    }

    this.cleanup();
    const tunnel = Tunnel.quick(`http://localhost:${this.port}`);

    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        tunnel.stop();
        reject(new Error(t("tunnel.timeout", { seconds: TUNNEL_TIMEOUT_MS / 1000 })));
      }, TUNNEL_TIMEOUT_MS);

      tunnel.once("url", (url: string) => {
        clearTimeout(timeout);
        resolve(url);
      });

      tunnel.once("error", (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    this.tunnel = tunnel;
    this.url = url;

    tunnel.on("disconnected", () => {
      logger.warn(t("tunnel.disconnected"));
    });

    tunnel.on("exit", (code: number | null) => {
      logger.info(t("tunnel.exited", { code: code ?? 0 }));
      this.tunnel = null;
      this.url = null;

      if (!this.stopped && this.port) {
        logger.info(t("tunnel.autoRestart"));
        this.connectWithRetry()
          .then((newUrl) => logger.info(t("tunnel.started", { url: newUrl })))
          .catch(() => logger.warn(t("tunnel.failed")));
      }
    });

    return url;
  }

  private cleanup(): void {
    if (this.tunnel) {
      this.tunnel.stop();
      this.tunnel = null;
      this.url = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
