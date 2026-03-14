import { t } from "../i18n/index.js";
import { logger } from "../utils/log.js";
import type { TunnelProvider, TunnelType } from "./types.js";

export async function createTunnelProvider(
  tunnelType: TunnelType,
  ngrokAuthtoken?: string
): Promise<TunnelProvider | null> {
  if (tunnelType === false) {
    logger.info(t("tunnel.disabled"));
    return null;
  }

  if (tunnelType === "cloudflare") {
    logger.info(t("tunnel.usingProvider", { provider: "cloudflare" }));
    const { CloudflareTunnelProvider } = await import("./providers/cloudflare-tunnel-provider.js");
    return new CloudflareTunnelProvider();
  }

  if (tunnelType === "ngrok") {
    logger.info(t("tunnel.usingProvider", { provider: "ngrok" }));
    const { NgrokTunnelProvider } = await import("./providers/ngrok-tunnel-provider.js");
    return new NgrokTunnelProvider(ngrokAuthtoken ?? "");
  }

  // TODO: re-enable custom URL tunnel provider
  // if (typeof tunnelType === "string" && tunnelType.startsWith("https://")) {
  //   const { CustomUrlTunnelProvider } = await import("./providers/custom-url-tunnel-provider.js");
  //   return new CustomUrlTunnelProvider(tunnelType);
  // }

  throw new Error(t("tunnel.invalidTunnelType", { type: String(tunnelType) }));
}
