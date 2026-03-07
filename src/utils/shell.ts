import { isWindows } from "./constants.js";

export function escapeShellArg(arg: string): string {
  if (isWindows()) {
    const escaped = arg
      .replace(/%/g, "%%")
      .replace(/"/g, '""')
      .replace(/!/g, "^^!")
      .replace(/([&|<>^])/g, "^$1");
    return `"${escaped}"`;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export function busyWaitMs(ms: number): void {
  Atomics.wait(WAIT_BUFFER, 0, 0, ms);
}

export function shellSpawnArgs(command: string): { cmd: string; args: string[] } {
  if (isWindows()) {
    return { cmd: "cmd.exe", args: ["/c", command] };
  }
  return { cmd: "sh", args: ["-c", command] };
}
