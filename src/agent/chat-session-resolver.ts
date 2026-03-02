export interface ChatSessionResolver {
  resolveSessionId(
    agentSessionId: string,
    projectName: string,
    cwd?: string,
    tmuxTarget?: string
  ): string | undefined;

  resolveOrRegister(
    agentSessionId: string,
    projectName: string,
    cwd: string | undefined,
    tmuxTarget: string
  ): string;

  onStopHook(sessionId: string, model?: string): void;
}
