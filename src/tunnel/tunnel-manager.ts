import { t } from "../i18n/index.js";
import { logger } from "../utils/log.js";
import { createTunnelProvider } from "./tunnel-provider-factory.js";
import { MAX_RETRIES, RETRY_DELAYS_MS, type TunnelProvider, type TunnelType } from "./types.js";

export class TunnelManager {
  private provider: TunnelProvider | null = null;
  private port: number | null = null;
  private stopped = false;
  private retrying = false;
  private tunnelType: TunnelType;
  private ngrokAuthtoken?: string;

  constructor(tunnelType: TunnelType = "cloudflare", ngrokAuthtoken?: string) {
    this.tunnelType = tunnelType;
    this.ngrokAuthtoken = ngrokAuthtoken;
  }

  async start(port: number): Promise<string | null> {
    this.port = port;
    this.stopped = false;
    return this.connectWithRetry();
  }

  getPublicUrl(): string | null {
    return this.provider?.getPublicUrl() ?? null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.provider) {
      await this.provider.stop().catch(() => {});
      this.provider = null;
    }
  }

  private wireOnExit(provider: TunnelProvider): void {
    provider.onExit = () => {
      if (this.provider !== provider) return;
      this.provider = null;
      if (this.stopped || this.retrying || !this.port) return;
      logger.info(t("tunnel.autoRestart"));
      this.connectWithRetry()
        .then((url) => {
          if (url) logger.info(t("tunnel.started", { url }));
        })
        .catch(() => logger.warn(t("tunnel.failed")));
    };
  }

  private async connectWithRetry(): Promise<string | null> {
    if (!this.port) return null;
    this.retrying = true;
    let lastError: Error | null = null;

    try {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (this.stopped) throw new Error("tunnel stopped");

        if (attempt > 0) {
          const delay = RETRY_DELAYS_MS[attempt - 1]!;
          logger.info(t("tunnel.retrying", { attempt, max: MAX_RETRIES, seconds: delay / 1000 }));
          await this.sleep(delay);
          if (this.stopped) throw new Error("tunnel stopped");
        }

        const provider = await createTunnelProvider(this.tunnelType, this.ngrokAuthtoken);
        if (!provider) return null;
        this.provider = provider;
        this.wireOnExit(provider);

        try {
          return await provider.start(this.port);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          logger.warn(
            t("tunnel.attemptFailed", { attempt: attempt + 1, error: lastError.message })
          );
          provider.onExit = undefined;
          await provider.stop().catch(() => {});
          this.provider = null;
        }
      }
    } finally {
      this.retrying = false;
    }

    throw lastError ?? new Error("tunnel failed");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
