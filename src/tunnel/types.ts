// TODO: re-add `https://${string}` when custom URL tunnel is implemented
export type TunnelType = "cloudflare" | "ngrok" | /* `https://${string}` | */ false;

export interface TunnelProvider {
  start(port: number): Promise<string>;
  stop(): Promise<void>;
  getPublicUrl(): string | null;
  onExit?: () => void;
}

export function validateTunnelPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid tunnel port: ${port}`);
  }
}

export const TUNNEL_TIMEOUT_MS = 30_000;
export const MAX_RETRIES = 3;
export const RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;

export const DEFAULT_TUNNEL_TYPE: TunnelType = "cloudflare";
