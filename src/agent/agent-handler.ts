import type { NotificationChannel, NotificationData } from "../channel/types.js";
import { t } from "../i18n/index.js";
import { MINI_APP_BASE_URL } from "../utils/constants.js";
import { log, logDebug, logError } from "../utils/log.js";
import { responseStore } from "../utils/response-store.js";
import type { TunnelManager } from "../utils/tunnel.js";
import type { AgentRegistry } from "./agent-registry.js";
import type { ChatSessionResolver } from "./chat-session-resolver.js";

export interface NotificationEvent {
  sessionId: string;
  tmuxTarget?: string;
  notificationType: string;
  message: string;
  title?: string;
  cwd?: string;
}

export interface AskUserQuestionOption {
  label: string;
  description: string;
}

export interface AskUserQuestionItem {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskUserQuestionOption[];
}

export interface AskUserQuestionEvent {
  sessionId: string;
  tmuxTarget?: string;
  cwd?: string;
  questions: AskUserQuestionItem[];
}

export interface PermissionRequestEvent {
  sessionId: string;
  tmuxTarget?: string;
  cwd?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  permissionMode?: string;
}

export class AgentHandler {
  constructor(
    private registry: AgentRegistry,
    private channel: NotificationChannel,
    private hookPort: number,
    private tunnelManager: TunnelManager,
    private chatResolver?: ChatSessionResolver
  ) {}

  async handleStopEvent(agentName: string, rawEvent: unknown): Promise<void> {
    const provider = this.registry.resolve(agentName);
    if (!provider) {
      log(t("agent.unknownAgent", { agent: agentName }));
      return;
    }

    if (provider.settleDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, provider.settleDelayMs));
    }

    const result = provider.parseEvent(rawEvent);
    logDebug(
      `[Stop:raw] agent=${agentName} agentSessionId=${result.agentSessionId ?? "NONE"} project=${result.projectName} tmuxTarget=${result.tmuxTarget ?? "NONE"} cwd=${result.cwd ?? "NONE"}`
    );

    let chatSessionId: string | undefined;
    if (this.chatResolver) {
      chatSessionId = this.chatResolver.resolveSessionId(
        result.agentSessionId ?? "",
        result.projectName,
        result.cwd,
        result.tmuxTarget
      );
      logDebug(`[Stop:resolved] chatSessionId=${chatSessionId ?? "NONE"}`);
    }

    if (!chatSessionId && result.tmuxTarget && this.chatResolver) {
      chatSessionId = this.chatResolver.resolveOrRegister(
        result.agentSessionId ?? "",
        result.projectName,
        result.cwd,
        result.tmuxTarget
      );
      logDebug(`[Stop:fallback] registered ${chatSessionId} from tmuxTarget=${result.tmuxTarget}`);
    }

    const data: NotificationData = {
      agent: provider.name,
      agentDisplayName: provider.displayName,
      sessionId: chatSessionId,
      ...result,
    };

    if (chatSessionId && this.chatResolver) {
      this.chatResolver.onStopHook(chatSessionId, result.model);
    }

    const responseUrl = this.buildResponseUrl(data);
    this.channel.sendNotification(data, responseUrl).catch((err: unknown) => {
      logError(t("hook.notificationFailed"), err);
    });
  }

  async handleSessionStart(rawEvent: unknown): Promise<void> {
    this.onSessionStart?.(rawEvent);
  }

  onSessionStart?: (rawEvent: unknown) => void;

  onNotification?: (event: NotificationEvent) => void;
  onAskUserQuestion?: (event: AskUserQuestionEvent) => void;
  onPermissionRequest?: (event: PermissionRequestEvent) => void;

  async handleAskUserQuestion(rawEvent: unknown): Promise<void> {
    const event = this.parseAskUserQuestionEvent(rawEvent);
    if (!event) return;

    logDebug(
      `[AskQ:raw] agentSessionId=${event.sessionId} tmuxTarget=${event.tmuxTarget ?? "NONE"} cwd=${event.cwd ?? "NONE"} questions=${event.questions.length}`
    );

    let sessionId: string | undefined;
    if (this.chatResolver) {
      sessionId = this.chatResolver.resolveSessionId(
        event.sessionId,
        "",
        event.cwd,
        event.tmuxTarget
      );
      logDebug(
        `[AskQ:resolved] agentSessionId=${event.sessionId} → resolvedSessionId=${sessionId ?? "NONE"}`
      );
    }

    const finalSessionId = sessionId ?? event.sessionId;
    logDebug(
      `[AskQ:forward] finalSessionId=${finalSessionId} tmuxTarget=${event.tmuxTarget ?? "NONE"}`
    );
    this.onAskUserQuestion?.({ ...event, sessionId: finalSessionId });
  }

  async handlePermissionRequest(rawEvent: unknown): Promise<void> {
    const event = this.parsePermissionRequestEvent(rawEvent);
    if (!event) return;

    logDebug(
      `[PermReq:raw] agentSessionId=${event.sessionId} tmuxTarget=${event.tmuxTarget ?? "NONE"} tool=${event.toolName}`
    );

    let sessionId: string | undefined;
    if (this.chatResolver) {
      sessionId = this.chatResolver.resolveSessionId(
        event.sessionId,
        "",
        event.cwd,
        event.tmuxTarget
      );
      logDebug(`[PermReq:resolved] ${event.sessionId} → ${sessionId ?? "NONE"}`);
    }

    const finalSessionId = sessionId ?? event.sessionId;
    logDebug(
      `[PermReq:forward] finalSessionId=${finalSessionId} tmuxTarget=${event.tmuxTarget ?? "NONE"}`
    );
    this.onPermissionRequest?.({ ...event, sessionId: finalSessionId });
  }

  async handleNotification(rawEvent: unknown): Promise<void> {
    const event = this.parseNotificationEvent(rawEvent);
    if (!event) return;

    logDebug(
      `[Notif:raw] agentSessionId=${event.sessionId} tmuxTarget=${event.tmuxTarget ?? "NONE"} type=${event.notificationType}`
    );

    let sessionId: string | undefined;
    if (this.chatResolver) {
      sessionId = this.chatResolver.resolveSessionId(
        event.sessionId,
        "",
        event.cwd,
        event.tmuxTarget
      );
      logDebug(`[Notif:resolved] ${event.sessionId} → ${sessionId ?? "NONE"}`);
    }

    if (!sessionId) {
      sessionId = event.sessionId;
    }

    logDebug(
      `[Notif:forward] finalSessionId=${sessionId} tmuxTarget=${event.tmuxTarget ?? "NONE"}`
    );
    this.onNotification?.({ ...event, sessionId });
  }

  private buildResponseUrl(data: NotificationData): string {
    const id = responseStore.save(data);

    const apiBase = this.tunnelManager.getPublicUrl() || `http://localhost:${this.hookPort}`;
    const params = new URLSearchParams({
      id,
      api: apiBase,
      p: data.projectName,
      d: String(data.durationMs),
      a: data.agent,
    });
    return `${MINI_APP_BASE_URL}/response/?${params.toString()}`;
  }

  private parseAskUserQuestionEvent(raw: unknown): AskUserQuestionEvent | null {
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;

    const sessionId = typeof obj.session_id === "string" ? obj.session_id : "";
    if (!sessionId) return null;

    const toolInput = (
      typeof obj.tool_input === "object" && obj.tool_input !== null ? obj.tool_input : obj
    ) as Record<string, unknown>;

    const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
    if (rawQuestions.length === 0) return null;

    const questions: AskUserQuestionItem[] = [];
    for (const q of rawQuestions) {
      if (!q || typeof q !== "object") continue;
      const qObj = q as Record<string, unknown>;
      const question = typeof qObj.question === "string" ? qObj.question : "";
      const header = typeof qObj.header === "string" ? qObj.header : "";
      const multiSelect = qObj.multiSelect === true;
      const opts = Array.isArray(qObj.options) ? qObj.options : [];
      const options: AskUserQuestionOption[] = [];
      for (const o of opts) {
        if (!o || typeof o !== "object") continue;
        const oObj = o as Record<string, unknown>;
        options.push({
          label: typeof oObj.label === "string" ? oObj.label : "",
          description: typeof oObj.description === "string" ? oObj.description : "",
        });
      }
      if (question && options.length > 0) {
        questions.push({ question, header, multiSelect, options });
      }
    }

    if (questions.length === 0) return null;

    return {
      sessionId,
      tmuxTarget: typeof obj.tmux_target === "string" ? obj.tmux_target : undefined,
      cwd: typeof obj.cwd === "string" ? obj.cwd : undefined,
      questions,
    };
  }

  private parseNotificationEvent(raw: unknown): NotificationEvent | null {
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;

    const sessionId = typeof obj.session_id === "string" ? obj.session_id : "";
    const message = typeof obj.message === "string" ? obj.message : "";

    if (!sessionId || !message) return null;

    const notificationType =
      typeof obj.notification_type === "string" && obj.notification_type
        ? obj.notification_type
        : "notification";

    return {
      sessionId,
      notificationType,
      message,
      title: typeof obj.title === "string" ? obj.title : undefined,
      cwd: typeof obj.cwd === "string" ? obj.cwd : undefined,
      tmuxTarget: typeof obj.tmux_target === "string" ? obj.tmux_target : undefined,
    };
  }

  private parsePermissionRequestEvent(raw: unknown): PermissionRequestEvent | null {
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;

    const sessionId = typeof obj.session_id === "string" ? obj.session_id : "";
    if (!sessionId) return null;

    const toolName = typeof obj.tool_name === "string" ? obj.tool_name : "";
    if (!toolName || toolName === "AskUserQuestion") return null;

    const toolInput =
      typeof obj.tool_input === "object" && obj.tool_input !== null
        ? (obj.tool_input as Record<string, unknown>)
        : {};

    return {
      sessionId,
      toolName,
      toolInput,
      permissionMode: typeof obj.permission_mode === "string" ? obj.permission_mode : undefined,
      cwd: typeof obj.cwd === "string" ? obj.cwd : undefined,
      tmuxTarget: typeof obj.tmux_target === "string" ? obj.tmux_target : undefined,
    };
  }
}
