import { execSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { AgentName } from "../agent/types.js";
import { isWindows } from "../utils/constants.js";
import { escapeShellArg } from "../utils/shell.js";
import { getTmuxBinary } from "./tmux-bridge.js";

export interface TmuxPaneInfo {
  target: string;
  paneTitle: string;
  cwd: string;
  panePid: string;
}

export interface AgentPaneInfo extends TmuxPaneInfo {
  agentName: AgentName;
}

const FORMAT_STRING =
  "#{session_name}:#{window_index}.#{pane_index}|#{pane_title}|#{pane_current_path}|#{pane_pid}";
const MAX_DESCENDANT_DEPTH = 8;

interface ProcessEntry {
  pid: string;
  ppid: string;
  command: string;
}

export type ProcessTree = Map<string, ProcessEntry[]>;

interface AgentProcessPattern {
  name: AgentName;
  processPattern: RegExp;
  idleExcludePattern?: RegExp;
}

const AGENT_PATTERNS: AgentProcessPattern[] = [
  {
    name: AgentName.ClaudeCode,
    processPattern: /\bclaude\b/i,
    idleExcludePattern: /shell-snapshots\/snapshot-/,
  },
  {
    name: AgentName.Cursor,
    processPattern: /\bcursor\b/i,
  },
  {
    name: AgentName.Codex,
    processPattern: /\bcodex\b/i,
  },
  {
    name: AgentName.GeminiCli,
    processPattern: /\bgemini\b/i,
  },
  {
    name: AgentName.OpenCode,
    processPattern: /\bopencode\b/i,
  },
];

export function buildProcessTree(): ProcessTree {
  return isWindows() ? buildProcessTreeWindows() : buildProcessTreeUnix();
}

function buildProcessTreeUnix(): ProcessTree {
  try {
    const output = execSync("ps -e -o pid=,ppid=,command=", {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 3000,
    });
    return parseProcessLines(output, /^(\d+)\s+(\d+)\s+(.+)$/);
  } catch {
    return new Map();
  }
}

function buildProcessTreeWindows(): ProcessTree {
  try {
    const output = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"',
      { encoding: "utf-8", stdio: "pipe", timeout: 10000 }
    );
    const raw = JSON.parse(output) as
      | { ProcessId: number; ParentProcessId: number; CommandLine: string | null }[]
      | { ProcessId: number; ParentProcessId: number; CommandLine: string | null };
    const processes = Array.isArray(raw) ? raw : [raw];
    const tree: ProcessTree = new Map();
    for (const proc of processes) {
      if (proc.ProcessId == null || proc.ParentProcessId == null) continue;
      const entry: ProcessEntry = {
        pid: String(proc.ProcessId),
        ppid: String(proc.ParentProcessId),
        command: proc.CommandLine ?? "",
      };
      const siblings = tree.get(entry.ppid) ?? [];
      siblings.push(entry);
      tree.set(entry.ppid, siblings);
    }
    return tree;
  } catch {
    return new Map();
  }
}

function parseProcessLines(output: string, pattern: RegExp): ProcessTree {
  const tree: ProcessTree = new Map();
  for (const line of output.trim().split("\n")) {
    const match = line.trim().match(pattern);
    if (!match) continue;
    const entry: ProcessEntry = { pid: match[1]!, ppid: match[2]!, command: match[3]! };
    const siblings = tree.get(entry.ppid) ?? [];
    siblings.push(entry);
    tree.set(entry.ppid, siblings);
  }
  return tree;
}

export function findAgentDescendant(panePid: string, tree?: ProcessTree): AgentName | null {
  const processTree = tree ?? buildProcessTree();

  function search(pid: string, depth: number): AgentName | null {
    if (depth >= MAX_DESCENDANT_DEPTH) return null;
    const children = processTree.get(pid);
    if (!children) return null;
    for (const child of children) {
      for (const pattern of AGENT_PATTERNS) {
        if (pattern.processPattern.test(child.command)) return pattern.name;
      }
      const found = search(child.pid, depth + 1);
      if (found) return found;
    }
    return null;
  }

  return search(panePid, 0);
}

/** @deprecated Use findAgentDescendant instead */
export function hasClaudeDescendant(panePid: string, tree?: ProcessTree): boolean {
  return findAgentDescendant(panePid, tree) !== null;
}

const SHELL_PATTERN = /\b(bash|zsh|sh|fish|powershell|pwsh|cmd)\b/;

export function isAgentIdleByProcess(
  panePid: string,
  agentName?: AgentName,
  tree?: ProcessTree
): boolean {
  const processTree = tree ?? buildProcessTree();
  const patterns = agentName ? AGENT_PATTERNS.filter((p) => p.name === agentName) : AGENT_PATTERNS;

  function findAgentPid(
    pid: string,
    depth: number
  ): { agentPid: string; pattern: AgentProcessPattern } | undefined {
    if (depth >= MAX_DESCENDANT_DEPTH) return undefined;
    const children = processTree.get(pid);
    if (!children) return undefined;
    for (const child of children) {
      for (const pattern of patterns) {
        if (pattern.processPattern.test(child.command)) {
          return { agentPid: child.pid, pattern };
        }
      }
      const found = findAgentPid(child.pid, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  const result = findAgentPid(panePid, 0);
  if (!result) return false;

  const children = processTree.get(result.agentPid);
  if (!children) return true;

  const excludePattern = result.pattern.idleExcludePattern;
  return !children.some(
    (c) => SHELL_PATTERN.test(c.command) && (!excludePattern || !excludePattern.test(c.command))
  );
}

/** @deprecated Use isAgentIdleByProcess instead */
export function isClaudeIdleByProcess(panePid: string, tree?: ProcessTree): boolean {
  return isAgentIdleByProcess(panePid, AgentName.ClaudeCode, tree);
}

export interface AgentScanOutput {
  panes: AgentPaneInfo[];
  tree: ProcessTree;
}

export function scanAgentPanes(): AgentScanOutput {
  try {
    const output = execSync(
      `${getTmuxBinary()} list-panes -a -F ${escapeShellArg(FORMAT_STRING)}`,
      {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 5000,
      }
    );

    const tree = buildProcessTree();

    const panes: AgentPaneInfo[] = output
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line: string): AgentPaneInfo | null => {
        const parts = line.split("|");
        if (parts.length < 4) return null;
        const target = parts[0]!;
        const panePid = parts[parts.length - 1]!;
        const cwd = parts[parts.length - 2]!;
        const paneTitle = parts.slice(1, parts.length - 2).join("|");
        const agentName = findAgentDescendant(panePid, tree);
        if (!agentName) return null;
        return { target, paneTitle, cwd, panePid, agentName };
      })
      .filter((pane): pane is AgentPaneInfo => pane !== null);

    return { panes, tree };
  } catch {
    return { panes: [], tree: new Map() };
  }
}

/** @deprecated Use scanAgentPanes instead */
export function scanClaudePanes(): { panes: TmuxPaneInfo[]; tree: ProcessTree } {
  return scanAgentPanes();
}

export function isAgentAliveInPane(target: string, tree?: ProcessTree): boolean {
  const sessionName = target.split(":")[0];
  if (!sessionName) return false;
  try {
    execSync(`${getTmuxBinary()} has-session -t ${escapeShellArg(sessionName)}`, {
      stdio: "pipe",
      timeout: 3000,
    });
  } catch {
    return false;
  }

  try {
    const panePid = execSync(
      `${getTmuxBinary()} display-message -t ${escapeShellArg(target)} -p ${escapeShellArg("#{pane_pid}")}`,
      {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 3000,
      }
    ).trim();
    return findAgentDescendant(panePid, tree) !== null;
  } catch {
    return false;
  }
}

/** @deprecated Use isAgentAliveInPane instead */
export function isClaudeAliveInPane(target: string, tree?: ProcessTree): boolean {
  return isAgentAliveInPane(target, tree);
}

export function isPaneAlive(target: string): boolean {
  const sessionName = target.split(":")[0];
  if (!sessionName) return false;
  try {
    execSync(`${getTmuxBinary()} has-session -t ${escapeShellArg(sessionName)}`, {
      stdio: "pipe",
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

export function detectModelFromCwd(cwd: string): string {
  try {
    const encoded = cwd.replaceAll("\\", "-").replaceAll("/", "-");
    const projectDir = join(homedir(), ".claude", "projects", encoded);

    const jsonlFiles = readdirSync(projectDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const fullPath = join(projectDir, f);
        return { path: fullPath, mtime: statSync(fullPath).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (jsonlFiles.length === 0) return "";

    const TAIL_BYTES = 8192;
    const fd = openSync(jsonlFiles[0]!.path, "r");
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(Math.min(TAIL_BYTES, size));
      readSync(fd, buf, 0, buf.length, start);
      const tail = buf.toString("utf-8");
      const lines = tail.split("\n");

      for (let i = lines.length - 1; i >= 0; i--) {
        const match = lines[i]!.match(/"model":"([^"]*)"/);
        if (match) return match[1] ?? "";
      }
    } finally {
      closeSync(fd);
    }

    return "";
  } catch {
    return "";
  }
}
