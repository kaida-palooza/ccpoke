import { spawn } from "node:child_process";

import * as p from "@clack/prompts";

import { t } from "../i18n/index.js";
import { InstallMethod, PackageManager } from "./constants.js";
import { detectGlobalPackageManager, detectInstallMethod } from "./install-detection.js";
import { getPackageVersion } from "./paths.js";

const NPM_REGISTRY_URL = "https://registry.npmjs.org/ccpoke/latest";
const VERSION_CHECK_TIMEOUT_MS = 5_000;

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
}

function isNewerVersion(current: string, latest: string): boolean {
  const currentParts = current.split(".").map(Number);
  const latestParts = latest.split(".").map(Number);

  for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
    const c = currentParts[i] ?? 0;
    const l = latestParts[i] ?? 0;
    if (l > c) return true;
    if (l < c) return false;
  }

  return false;
}

function getUpdateCommand(method: InstallMethod): string {
  switch (method) {
    case InstallMethod.Npx:
      return "npx -y ccpoke@latest";
    case InstallMethod.GitClone:
      return "git pull && npm run build";
    case InstallMethod.Global:
      return "ccpoke update";
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VERSION_CHECK_TIMEOUT_MS);

    const response = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = (await response.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

export async function fetchUpdateInfo(): Promise<UpdateInfo | null> {
  const currentVersion = getPackageVersion();
  if (currentVersion === "unknown") return null;

  const latestVersion = await fetchLatestVersion();
  if (!latestVersion) return null;

  if (isNewerVersion(currentVersion, latestVersion)) {
    return { currentVersion, latestVersion };
  }

  return null;
}

async function runUpdateInline(): Promise<
  { ok: true } | { ok: false; cmd: string; error: string }
> {
  const pm = detectGlobalPackageManager();
  const pkg = "ccpoke";
  const cmd =
    pm === PackageManager.Yarn ? `yarn global add ${pkg}` : `${pm} install -g ${pkg}@latest`;

  const [bin, ...args] = cmd.split(" ");

  return new Promise((resolve) => {
    const child = spawn(bin!, args, { stdio: "pipe" });
    const chunks: Buffer[] = [];

    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));

    child.on("error", (e) => resolve({ ok: false, cmd, error: e.message }));
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, cmd, error: Buffer.concat(chunks).toString().trim() });
      }
    });
  });
}

export async function promptUpdateOrContinue(info: UpdateInfo): Promise<void> {
  const method = detectInstallMethod();
  const versionRange = `v${info.currentVersion} → v${info.latestVersion}`;

  if (method === InstallMethod.Npx || method === InstallMethod.GitClone) {
    p.log.warn(
      t("versionCheck.updateAvailable", {
        current: info.currentVersion,
        latest: info.latestVersion,
      })
    );
    p.log.info(t("versionCheck.runToUpdate", { command: getUpdateCommand(method) }));
    return;
  }

  const shouldUpdate = await p.confirm({
    message: `${versionRange} — ${t("versionCheck.updateConfirm")}`,
  });

  if (p.isCancel(shouldUpdate) || !shouldUpdate) return;

  const s = p.spinner();
  s.start(t("versionCheck.updating"));

  const result = await runUpdateInline();

  if (result.ok) {
    s.stop(`✅ v${info.latestVersion} ${t("versionCheck.ready")}`);
    await respawnSelf();
  } else {
    s.stop("❌");
    if (result.error) {
      p.log.error(result.error);
    }
    p.log.warn(t("versionCheck.runToUpdate", { command: result.cmd }));
  }
}

function respawnSelf(): Promise<never> {
  const [execPath, scriptPath, ...rest] = process.argv;
  const child = spawn(execPath!, [scriptPath!, ...rest], {
    stdio: "inherit",
  });

  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.on("SIGTERM", forward);
  process.on("SIGHUP", forward);

  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", () => process.exit(1));
  return new Promise(() => {});
}

export async function checkForUpdates(): Promise<void> {
  const info = await fetchUpdateInfo();
  if (!info) return;
  await promptUpdateOrContinue(info);
}
