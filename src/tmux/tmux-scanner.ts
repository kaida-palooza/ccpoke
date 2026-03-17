import { execSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { AgentName } from "../agent/types.js";
import { isWindows } from "../utils/constants.js";
import { escapeShellArg } from "../utils/shell.js";
import { getTmuxBinary } from "./tmux-bridge.js";

export interface TmuxPaneInfo {
  paneId: string;
  target: string;
  paneTitle: string;
  cwd: string;
  panePid: string;
}

export interface AgentPaneInfo extends TmuxPaneInfo {
  agentName: AgentName;
}

const FORMAT_STRING =
  "#{pane_id}|#{session_name}:#{window_index}.#{pane_index}|#{pane_title}|#{pane_current_path}|#{pane_pid}";
const FORMAT_STRING_WIN =
  "#{pane_id}|#{session_name}:#{window_index}.#{pane_index}|#{pane_current_path}|#{pane_pid}";
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
    const output = execSync("wmic process get CommandLine,ParentProcessId,ProcessId /format:csv", {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 10000,
    });
    return parseWmicCsv(output);
  } catch {
    return new Map();
  }
}

function parseWmicCsv(output: string): ProcessTree {
  const tree: ProcessTree = new Map();
  const lines = output.replace(/\r/g, "").trim().split("\n").filter(Boolean);
  if (lines.length < 2) return tree;

  const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  const cmdIdx = header.indexOf("commandline");
  const ppidIdx = header.indexOf("parentprocessid");
  const pidIdx = header.indexOf("processid");
  if (cmdIdx < 0 || ppidIdx < 0 || pidIdx < 0) return tree;

  const colCount = header.length;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const tailCols: string[] = [];
    let remaining = line;

    for (let c = colCount - 1; c > cmdIdx; c--) {
      const lastComma = remaining.lastIndexOf(",");
      if (lastComma < 0) break;
      tailCols.unshift(remaining.slice(lastComma + 1).trim());
      remaining = remaining.slice(0, lastComma);
    }

    if (tailCols.length < colCount - cmdIdx - 1) continue;

    const headCols = remaining.split(",", cmdIdx);
    const command = remaining.slice(headCols.join(",").length + (cmdIdx > 0 ? 1 : 0));

    const allCols = [...headCols, command, ...tailCols];
    const pid = allCols[pidIdx]?.trim();
    const ppid = allCols[ppidIdx]?.trim();
    if (!pid || !ppid) continue;

    const entry: ProcessEntry = { pid, ppid, command: command.trim() };
    const siblings = tree.get(entry.ppid) ?? [];
    siblings.push(entry);
    tree.set(entry.ppid, siblings);
  }
  return tree;
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

export interface AgentScanOutput {
  panes: AgentPaneInfo[];
  allPaneIds: Set<string>;
  tree: ProcessTree;
}

function listAllPanesRaw(): string {
  const bin = getTmuxBinary();
  const fmt = isWindows() ? FORMAT_STRING_WIN : FORMAT_STRING;
  const formatArg = escapeShellArg(fmt);

  if (!isWindows()) {
    return execSync(`${bin} list-panes -a -F ${formatArg}`, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5000,
    });
  }

  const sessionListOutput = execSync(`${bin} ls`, {
    encoding: "utf-8",
    stdio: "pipe",
    timeout: 5000,
  });

  const sessionNames = sessionListOutput
    .trim()
    .split("\n")
    .map((line) => line.match(/^(\S+?):/)?.[1])
    .filter((name): name is string => !!name);

  if (sessionNames.length === 0) return "";

  const results: string[] = [];
  for (const name of sessionNames) {
    try {
      const out = execSync(`${bin} list-panes -s -t ${escapeShellArg(name)} -F ${formatArg}`, {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 5000,
      });
      results.push(out.trim());
    } catch {
      // session may have been killed between ls and list-panes
    }
  }
  return results.join("\n");
}

export function scanAgentPanes(): AgentScanOutput {
  try {
    const output = listAllPanesRaw();

    const tree = buildProcessTree();

    const allLines = output
      .replace(/\r/g, "")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);

    const allPaneIds = new Set<string>();
    const panes: AgentPaneInfo[] = [];

    const winMode = isWindows();
    const minParts = winMode ? 4 : 5;

    for (const line of allLines) {
      const parts = line.split("|");
      if (parts.length < minParts) continue;
      const paneId = parts[0]!;
      const target = parts[1]!;
      allPaneIds.add(paneId);
      const panePid = parts[parts.length - 1]!;
      const cwd = parts[parts.length - 2]!;
      const paneTitle = winMode ? "" : parts.slice(2, parts.length - 2).join("|");
      const agentName = findAgentDescendant(panePid, tree);
      if (!agentName) continue;
      panes.push({ paneId, target, paneTitle, cwd, panePid, agentName });
    }

    return { panes, allPaneIds, tree };
  } catch {
    return { panes: [], allPaneIds: new Set(), tree: new Map() };
  }
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

export function isPaneAlive(target: string): boolean {
  try {
    execSync(
      `${getTmuxBinary()} display-message -t ${escapeShellArg(target)} -p ${escapeShellArg("#{pane_id}")}`,
      { stdio: "pipe", timeout: 3000 }
    );
    return true;
  } catch {
    return false;
  }
}

export function queryPanePid(target: string): string | undefined {
  try {
    return (
      execSync(
        `${getTmuxBinary()} display-message -t ${escapeShellArg(target)} -p ${escapeShellArg("#{pane_pid}")}`,
        { encoding: "utf-8", stdio: "pipe", timeout: 3000 }
      ).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

export type PaneHealth =
  | { status: "dead" }
  | { status: "no_agent"; panePid: string }
  | { status: "busy"; panePid: string }
  | { status: "idle"; panePid: string };

export function checkPaneHealth(target: string, tree?: ProcessTree): PaneHealth {
  const panePid = queryPanePid(target);
  if (!panePid) return { status: "dead" };

  const processTree = tree ?? buildProcessTree();
  if (!findAgentDescendant(panePid, processTree)) return { status: "no_agent", panePid };

  if (!isAgentIdleByProcess(panePid, undefined, processTree)) return { status: "busy", panePid };

  return { status: "idle", panePid };
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
