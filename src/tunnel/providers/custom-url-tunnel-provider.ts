import { t } from "../../i18n/index.js";
import type { TunnelProvider } from "../types.js";

export class CustomUrlTunnelProvider implements TunnelProvider {
  private url: string;
  onExit?: () => void;

  constructor(url: string) {
    if (url.startsWith("http://")) {
      throw new Error(t("tunnel.customUrlMustBeHttps"));
    }
    if (!url.startsWith("https://")) {
      throw new Error(t("tunnel.customUrlInvalid"));
    }
    this.url = url.replace(/\/+$/, "");
  }

  async start(_port: number): Promise<string> {
    return this.url;
  }

  async stop(): Promise<void> {}

  getPublicUrl(): string | null {
    return this.url;
  }
}
