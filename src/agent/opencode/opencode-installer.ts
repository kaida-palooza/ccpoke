import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { ApiRoute } from "../../utils/constants.js";
import { getPackageVersion, paths } from "../../utils/paths.js";
import { AgentName } from "../types.js";

const PLUGIN_FILENAME = "ccpoke-notify.js";
const VERSION_HEADER_PATTERN = /^\/\/\s*ccpoke-version:\s*(\S+)/;
const AGENT_PARAM = `?agent=${AgentName.OpenCode}`;

export class OpencodeInstaller {
  static isInstalled(): boolean {
    return existsSync(paths.opencodePluginFile);
  }

  static verifyIntegrity(): { complete: boolean; missing: string[] } {
    const missing: string[] = [];

    if (!existsSync(paths.opencodePluginFile)) {
      missing.push(`${PLUGIN_FILENAME} in plugins dir`);
    } else {
      const version = readPluginVersion(paths.opencodePluginFile);
      if (version !== getPackageVersion()) {
        missing.push(`outdated ${PLUGIN_FILENAME}`);
      }
    }

    return { complete: missing.length === 0, missing };
  }

  static install(hookPort: number, hookSecret: string): void {
    OpencodeInstaller.uninstall();

    mkdirSync(paths.opencodePluginsDir, { recursive: true });

    const version = getPackageVersion();
    const route = ApiRoute.HookStop + AGENT_PARAM;
    const permissionRoute = ApiRoute.HookPermissionRequest + AGENT_PARAM;
    const askRoute = ApiRoute.HookAskUserQuestion + AGENT_PARAM;

    const plugin = `// ccpoke-version: ${version}
export default async function({ $, client, directory, worktree }) {
  const ccpokeHost = process.env.CCPOKE_HOST || "localhost";
  let cachedTmuxTarget = null;
  async function detectTmuxTarget() {
    if (cachedTmuxTarget !== null) return cachedTmuxTarget;
    try {
      const result = await $\`tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}'\`.nothrow().quiet();
      cachedTmuxTarget = result.stdout?.toString().trim() || "";
    } catch { cachedTmuxTarget = ""; }
    return cachedTmuxTarget;
  }

  async function fetchSessionContext(sessionID) {
    if (!sessionID || !client) return { summary: "", model: "" };
    try {
      const res = await client.session.messages({ path: { id: sessionID }, query: { limit: 2 } });
      const messages = res.data ?? [];
      let summary = "";
      let model = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.info?.role !== "assistant") continue;
        model = msg.info.modelID ? msg.info.providerID + "/" + msg.info.modelID : "";
        const texts = (msg.parts ?? []).filter(p => p.type === "text").map(p => p.text ?? "");
        summary = texts.join("\\n").slice(0, 500);
        break;
      }
      return { summary, model };
    } catch { return { summary: "", model: "" }; }
  }

  return {
    event: async ({ event }) => {
      if (event.type === "question.asked") {
        const props = event.properties || {};
        const tmuxTarget = await detectTmuxTarget();
        const payload = JSON.stringify({
          session_id: props.sessionID || "",
          tool_input: { questions: props.questions || [] },
          cwd: worktree || directory,
          tmux_target: tmuxTarget
        });
        try {
          await $\`echo \${payload} | curl -s -X POST "http://\${ccpokeHost}:${hookPort}${askRoute}" -H "Content-Type: application/json" -H "X-CCPoke-Secret: ${hookSecret}" --data-binary @- --max-time 5\`.nothrow().quiet();
        } catch {}
        return;
      }

      if (event.type === "permission.asked") {
        const props = event.properties || {};
        const tmuxTarget = await detectTmuxTarget();
        const payload = JSON.stringify({
          session_id: props.sessionID || "",
          tool_name: props.permission || "unknown",
          tool_input: { patterns: props.patterns || [], metadata: props.metadata || {} },
          cwd: worktree || directory,
          tmux_target: tmuxTarget
        });
        try {
          await $\`echo \${payload} | curl -s -X POST "http://\${ccpokeHost}:${hookPort}${permissionRoute}" -H "Content-Type: application/json" -H "X-CCPoke-Secret: ${hookSecret}" --data-binary @- --max-time 5\`.nothrow().quiet();
        } catch {}
        return;
      }

      if (event.type !== "session.idle" && event.type !== "session.error") return;
      const sessionID = event.properties?.sessionID || "";
      const cwd = worktree || directory;
      const ctx = await fetchSessionContext(sessionID);
      const tmuxTarget = await detectTmuxTarget();
      const payload = JSON.stringify({
        session_id: sessionID,
        prompt_response: ctx.summary,
        cwd,
        model: ctx.model,
        event_type: event.type,
        tmux_target: tmuxTarget
      });
      try {
        await $\`echo \${payload} | curl -s -X POST "http://\${ccpokeHost}:${hookPort}${route}" -H "Content-Type: application/json" -H "X-CCPoke-Secret: ${hookSecret}" --data-binary @- --max-time 5\`.nothrow().quiet();
      } catch {}
    }
  };
}
`;

    const tmp = `${paths.opencodePluginFile}.tmp`;
    writeFileSync(tmp, plugin, { mode: 0o600 });
    renameSync(tmp, paths.opencodePluginFile);
  }

  static uninstall(): void {
    try {
      unlinkSync(paths.opencodePluginFile);
    } catch {
      /* may not exist */
    }
  }
}

function readPluginVersion(filePath: string): string | null {
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n");
    for (const line of lines.slice(0, 3)) {
      const match = line.match(VERSION_HEADER_PATTERN);
      if (match) return match[1] ?? null;
    }
    return null;
  } catch {
    return null;
  }
}
