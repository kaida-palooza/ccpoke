import { rmSync } from "node:fs";

import * as p from "@clack/prompts";

import { createDefaultRegistry } from "../agent/agent-registry.js";
import { t } from "../i18n/index.js";
import { InstallMethod } from "../utils/constants.js";
import { detectInstallMethod } from "../utils/install-detection.js";
import { paths } from "../utils/paths.js";
import { removeShellCompletion } from "../utils/shell-completion.js";

export function runUninstall(): void {
  p.intro(t("uninstall.intro"));

  removeAllAgentHooks();
  removeShellCompletion();
  removeConfigDirectory();

  printPostUninstallHint();

  p.outro(t("uninstall.done"));
}

function removeAllAgentHooks(): void {
  const registry = createDefaultRegistry();

  for (const provider of registry.all()) {
    try {
      provider.uninstallHook();
      p.log.success(t("uninstall.agentHookRemoved", { agent: provider.displayName }));
    } catch {
      // hook may not exist for this agent
    }
  }
}

function removeConfigDirectory(): void {
  const ccpokeDir = paths.ccpokeDir;
  try {
    rmSync(ccpokeDir, { recursive: true, force: true });
    p.log.success(t("uninstall.configRemoved"));
  } catch {
    p.log.warn(t("uninstall.configNotFound"));
  }
}

function printPostUninstallHint(): void {
  const method = detectInstallMethod();

  if (method === InstallMethod.Global) {
    p.log.info(t("uninstall.removeGlobal"));
  } else if (method === InstallMethod.GitClone) {
    p.log.info(t("uninstall.removeGitClone"));
  }
}
