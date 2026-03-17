import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import { AgentName } from "../agent/types.js";
import { logger } from "../utils/log.js";
import { paths } from "../utils/paths.js";
import type { TmuxBridge } from "./tmux-bridge.js";
import { detectModelFromCwd, scanAgentPanes } from "./tmux-scanner.js";

export const PaneState = {
  Idle: "idle",
  Busy: "busy",
  Blocked: "blocked",
  Launching: "launching",
  Unknown: "unknown",
} as const;
export type PaneState = (typeof PaneState)[keyof typeof PaneState];

export interface PaneMetadata {
  paneId: string;
  project: string;
  cwd: string;
  label: string;
  state: PaneState;
  model: string;
  agent: AgentName;
  lastActivity: Date;
}

export interface ScanResult {
  discovered: PaneMetadata[];
  removed: PaneMetadata[];
  reconciled: number;
  total: number;
}

interface PersistedPane {
  paneId: string;
  project: string;
  cwd: string;
  label: string;
  state: PaneState;
  model: string;
  agent: AgentName;
  lastActivity: string;
}

const SESSIONS_FILE = "sessions.json";

const MAX_SESSIONS = 200;

export class PaneRegistry {
  private panes = new Map<string, PaneMetadata>();
  private scanInterval: ReturnType<typeof setInterval> | null = null;

  register(
    paneId: string,
    project: string,
    cwd = "",
    label = "",
    agent: AgentName = AgentName.ClaudeCode
  ): void {
    if (this.panes.size >= MAX_SESSIONS && !this.panes.has(paneId)) {
      const oldest = [...this.panes.entries()].sort(
        (a, b) => a[1].lastActivity.getTime() - b[1].lastActivity.getTime()
      )[0];
      if (oldest) this.panes.delete(oldest[0]);
    }
    this.panes.set(paneId, {
      paneId,
      project,
      cwd,
      label,
      state: PaneState.Idle,
      model: "",
      agent,
      lastActivity: new Date(),
    });
  }

  unregister(paneId: string): void {
    this.panes.delete(paneId);
  }

  getByPaneId(paneId: string): PaneMetadata | undefined {
    return this.panes.get(paneId);
  }

  getByProject(project: string): PaneMetadata[] {
    return [...this.panes.values()].filter((p) => p.project === project);
  }

  getAllActive(): PaneMetadata[] {
    return [...this.panes.values()];
  }

  updateState(paneId: string, state: PaneState): void {
    const pane = this.panes.get(paneId);
    if (pane) {
      pane.state = state;
      pane.lastActivity = new Date();
    }
  }

  updateLabel(paneId: string, label: string): void {
    const pane = this.panes.get(paneId);
    if (pane) pane.label = label;
  }

  updateModel(paneId: string, model: string): void {
    const pane = this.panes.get(paneId);
    if (pane && model) pane.model = model;
  }

  touch(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (pane) pane.lastActivity = new Date();
  }

  save(): void {
    const data: PersistedPane[] = [...this.panes.values()].map((p) => ({
      ...p,
      lastActivity: p.lastActivity.toISOString(),
    }));

    mkdirSync(paths.ccpokeDir, { recursive: true });
    const tmpPath = `${paths.ccpokeDir}/${SESSIONS_FILE}.tmp`;
    const finalPath = `${paths.ccpokeDir}/${SESSIONS_FILE}`;
    writeFileSync(tmpPath, JSON.stringify({ sessions: data }, null, 2));
    renameSync(tmpPath, finalPath);
  }

  load(): void {
    try {
      const raw = readFileSync(`${paths.ccpokeDir}/${SESSIONS_FILE}`, "utf-8");
      const parsed = JSON.parse(raw) as { sessions: PersistedPane[] };
      for (const p of parsed.sessions) {
        if (!p.paneId || !p.project) continue;
        const date = new Date(p.lastActivity);
        if (isNaN(date.getTime())) continue;
        const agent = p.agent ?? AgentName.ClaudeCode;
        this.register(p.paneId, p.project, p.cwd, p.label, agent);
        const pane = this.panes.get(p.paneId)!;
        pane.lastActivity = date;
        this.updateModel(p.paneId, p.model);
      }
    } catch (e: unknown) {
      logger.debug(`[PaneRegistry:load] ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  refreshFromTmux(tmuxBridge: TmuxBridge): ScanResult {
    const { panes, allPaneIds, tree } = scanAgentPanes();
    const discovered: PaneMetadata[] = [];
    const removed: PaneMetadata[] = [];
    let agentUpdatedCount = 0;

    for (const [paneId, pane] of this.panes) {
      if (!allPaneIds.has(paneId)) {
        if (pane.state === PaneState.Launching) {
          const age = Date.now() - pane.lastActivity.getTime();
          if (age < 60_000) continue;
        }
        logger.debug(`[Scan:remove] paneId=${paneId} project=${pane.project}`);
        removed.push(pane);
        this.panes.delete(paneId);
      }
    }

    for (const pane of panes) {
      const existing = this.panes.get(pane.paneId);
      if (existing) {
        const currentProject = basename(pane.cwd) || "unknown";
        if (existing.project !== currentProject || existing.cwd !== pane.cwd) {
          logger.debug(
            `[Scan:update] paneId=${pane.paneId} project=${existing.project}→${currentProject}`
          );
          existing.project = currentProject;
          existing.cwd = pane.cwd;
        }
        const scannedAgent =
          "agentName" in pane ? (pane as { agentName: AgentName }).agentName : undefined;
        if (scannedAgent && scannedAgent !== existing.agent) {
          logger.debug(
            `[Scan:agent] paneId=${pane.paneId} agent=${existing.agent}→${scannedAgent}`
          );
          existing.agent = scannedAgent;
          agentUpdatedCount++;
        }
        continue;
      }

      const project = basename(pane.cwd) || "unknown";
      logger.debug(`[Scan:new] paneId=${pane.paneId} project=${project}`);
      const agentName =
        "agentName" in pane ? (pane as { agentName: AgentName }).agentName : AgentName.ClaudeCode;
      const state = tmuxBridge.isAgentIdle(pane.paneId, tree) ? PaneState.Idle : PaneState.Unknown;
      this.register(pane.paneId, project, pane.cwd, "", agentName);
      this.updateState(pane.paneId, state);
      this.updateModel(pane.paneId, detectModelFromCwd(pane.cwd));
      discovered.push(this.panes.get(pane.paneId)!);
    }

    let reconciled = 0;
    for (const pane of this.panes.values()) {
      if (pane.state !== PaneState.Busy) continue;
      if (tmuxBridge.isAgentIdle(pane.paneId, tree)) {
        logger.debug(`[Scan:reconcile] ${pane.paneId} Busy→Idle (process idle)`);
        pane.state = PaneState.Idle;
        pane.lastActivity = new Date();
        reconciled++;
      }
    }

    return {
      discovered,
      removed,
      reconciled: reconciled + agentUpdatedCount,
      total: this.panes.size,
    };
  }

  startPeriodicScan(
    tmuxBridge: TmuxBridge,
    intervalMs: number,
    onResult?: (result: ScanResult) => void
  ): void {
    this.stopPeriodicScan();
    this.scanInterval = setInterval(() => {
      try {
        const result = this.refreshFromTmux(tmuxBridge);
        if (result.discovered.length > 0 || result.removed.length > 0 || result.reconciled > 0) {
          this.save();
        }
        onResult?.(result);
      } catch (e: unknown) {
        logger.debug(`[PaneRegistry:scan] ${e instanceof Error ? e.message : String(e)}`);
      }
    }, intervalMs);
  }

  stopPeriodicScan(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
  }
}
