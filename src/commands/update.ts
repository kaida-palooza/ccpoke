import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import * as p from "@clack/prompts";

import { createDefaultRegistry } from "../agent/agent-registry.js";
import { ConfigManager } from "../config-manager.js";
import { HookEnvWriter } from "../hooks/hook-env-writer.js";
import { t } from "../i18n/index.js";
import { InstallMethod, PackageManager } from "../utils/constants.js";
import {
  detectGlobalPackageManager,
  detectInstallMethod,
  getGitRepoRoot,
} from "../utils/install-detection.js";
import { getPackageVersion } from "../utils/paths.js";

export function runUpdate(): void {
  const method = detectInstallMethod();

  switch (method) {
    case InstallMethod.Npx:
      p.intro(t("update.intro"));
      p.log.step(t("update.npxAlreadyLatest"));
      p.outro(t("update.npxDone"));
      break;

    case InstallMethod.Global:
      updateGlobal();
      break;

    case InstallMethod.GitClone:
      updateGitClone();
      break;
  }
}

function updateGlobal(): void {
  const pm = detectGlobalPackageManager();
  const pkg = "ccpoke";

  p.intro(t("update.intro"));

  const s = p.spinner();
  s.start(t("update.checking"));

  const currentVersion = getPackageVersion();
  let latestVersion = "unknown";
  try {
    const cmd =
      pm === PackageManager.Yarn ? `yarn info ${pkg} version --silent` : `npm view ${pkg} version`;
    latestVersion = execSync(cmd, { stdio: "pipe" }).toString().trim();
  } catch {
    // registry may be unreachable
  }

  if (
    currentVersion !== "unknown" &&
    latestVersion !== "unknown" &&
    currentVersion === latestVersion
  ) {
    s.stop(t("update.alreadyLatestNpm", { version: currentVersion }));
    p.outro(t("update.noUpdateNeeded"));
    return;
  }

  const updateMsg =
    currentVersion !== "unknown" && latestVersion !== "unknown"
      ? t("update.updatingNpm", { pm, from: currentVersion, to: latestVersion })
      : t("update.updating", { pm });

  s.message(updateMsg);

  const cmd =
    pm === PackageManager.Yarn ? `yarn global add ${pkg}` : `${pm} install -g ${pkg}@latest`;

  try {
    execSync(cmd, { stdio: "pipe" });
    s.stop(t("update.updateSuccess", { from: currentVersion, to: latestVersion }));
    refreshHooks();
    p.outro(t("update.updateComplete"));
  } catch {
    s.stop(t("update.updateFailed"));
    p.log.error(t("update.updateManualGlobal", { cmd }));
    process.exit(1);
  }
}

function updateGitClone(): void {
  const scriptPath = process.argv[1] ?? "";
  const scriptDir = dirname(scriptPath);
  const repoRoot = getGitRepoRoot(scriptDir);

  if (!repoRoot) {
    p.log.error(t("update.gitRepoNotFound"));
    process.exit(1);
  }

  p.intro(t("update.intro"));

  const s = p.spinner();

  try {
    let currentHash = "unknown";
    try {
      currentHash = execSync("git rev-parse --short HEAD", { cwd: repoRoot, stdio: "pipe" })
        .toString()
        .trim();
    } catch {
      // git command may fail if not a clean repo
    }

    s.start(t("update.pulling"));
    execSync("git pull", { cwd: repoRoot, stdio: "pipe" });

    let latestHash = "unknown";
    try {
      latestHash = execSync("git rev-parse --short HEAD", { cwd: repoRoot, stdio: "pipe" })
        .toString()
        .trim();
    } catch {
      // git command may fail
    }

    if (currentHash !== "unknown" && currentHash === latestHash) {
      s.stop(t("update.alreadyLatestGit", { hash: currentHash }));
      p.outro(t("update.noUpdateNeeded"));
      return;
    }

    if (currentHash !== "unknown" && latestHash !== "unknown" && currentHash !== latestHash) {
      s.stop(t("update.pulledGit", { from: currentHash, to: latestHash }));
    } else {
      s.stop(t("update.pulled"));
    }

    const pm: PackageManager = existsSync(join(repoRoot, "pnpm-lock.yaml"))
      ? PackageManager.Pnpm
      : existsSync(join(repoRoot, "yarn.lock"))
        ? PackageManager.Yarn
        : existsSync(join(repoRoot, "bun.lockb"))
          ? PackageManager.Bun
          : PackageManager.Npm;

    s.start(t("update.installingDeps"));
    execSync(`${pm} install`, { cwd: repoRoot, stdio: "pipe" });
    s.stop(t("update.depsInstalled"));

    s.start(t("update.building"));
    execSync(`${pm} run build`, { cwd: repoRoot, stdio: "pipe" });
    s.stop(t("update.buildComplete"));

    refreshHooks();

    p.outro(t("update.updateComplete"));
  } catch {
    s.stop(t("update.updateFailed"));
    p.log.error(t("update.updateManualGit"));
    process.exit(1);
  }
}

function refreshHooks(): void {
  try {
    const config = ConfigManager.load();
    const registry = createDefaultRegistry();
    HookEnvWriter.write(config.hook_port, config.hook_secret);
    for (const agentName of config.agents) {
      const provider = registry.resolve(agentName);
      if (!provider?.detect()) continue;
      provider.installHook();
    }
    p.log.success(t("update.hooksRefreshed"));
  } catch {
    // config may not exist yet
  }
}
