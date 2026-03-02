import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import * as p from "@clack/prompts";

import { t } from "../i18n/index.js";
import { isWindows } from "./constants.js";
import { paths } from "./paths.js";

const ZSH_SCRIPT = `#compdef ccpoke

_ccpoke() {
  local -a commands
  commands=(
    'setup:Run the setup wizard'
    'project:Manage registered projects'
    'update:Update ccpoke to latest version'
    'uninstall:Remove ccpoke hooks and config'
    'help:Show help information'
  )
  _describe 'command' commands
}

_ccpoke "$@"
`;

const BASH_SCRIPT = `_ccpoke_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=( $(compgen -W "setup project update uninstall help" -- "$cur") )
}

complete -F _ccpoke_completions ccpoke
`;

const ShellConfig = {
  Zsh: ".zshrc",
  Bash: ".bashrc",
} as const;

const ZSH_SOURCE_LINE = `\nfpath=(${paths.completionsDir} $fpath); autoload -Uz compinit && compinit\n`;
const BASH_SOURCE_LINE = `\nsource ${paths.bashCompletion}\n`;

function readShellConfig(filename: string): string | null {
  try {
    return readFileSync(join(homedir(), filename), "utf-8");
  } catch {
    return null;
  }
}

function appendToShellConfig(filename: string, line: string): void {
  appendFileSync(join(homedir(), filename), line);
}

function writeCompletionScripts(): void {
  mkdirSync(paths.completionsDir, { recursive: true });
  writeFileSync(paths.zshCompletion, ZSH_SCRIPT);
  writeFileSync(paths.bashCompletion, BASH_SCRIPT);
}

function configureShellCompletions(): boolean {
  let added = false;

  const zshrc = readShellConfig(ShellConfig.Zsh);
  if (zshrc !== null && !zshrc.includes(paths.completionsDir)) {
    appendToShellConfig(ShellConfig.Zsh, ZSH_SOURCE_LINE);
    added = true;
  }

  const bashrc = readShellConfig(ShellConfig.Bash);
  if (bashrc !== null && !bashrc.includes(paths.bashCompletion)) {
    appendToShellConfig(ShellConfig.Bash, BASH_SOURCE_LINE);
    added = true;
  }

  return added;
}

export function installShellCompletion(): void {
  if (isWindows()) return;
  writeCompletionScripts();

  const added = configureShellCompletions();

  if (added) {
    p.log.success(t("setup.shellCompletionAdded"));
  } else {
    p.log.success(t("setup.shellCompletionAlreadyInstalled"));
  }
}

export function ensureShellCompletion(): void {
  if (isWindows()) return;
  if (existsSync(paths.zshCompletion) && existsSync(paths.bashCompletion)) return;
  writeCompletionScripts();
}

function removeLineFromShellConfig(filename: string, marker: string): void {
  const filepath = join(homedir(), filename);
  const content = readShellConfig(filename);
  if (!content?.includes(marker)) return;

  const filtered = content
    .split("\n")
    .filter((line) => !line.includes(marker))
    .join("\n");

  writeFileSync(filepath, filtered);
}

export function removeShellCompletion(): void {
  if (isWindows()) return;
  removeLineFromShellConfig(ShellConfig.Zsh, paths.completionsDir);
  removeLineFromShellConfig(ShellConfig.Bash, paths.bashCompletion);
}
