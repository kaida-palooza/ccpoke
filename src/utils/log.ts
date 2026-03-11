import { statSync, writeFileSync } from "node:fs";

import pino, { type TransportTargetOptions } from "pino";

export const LOG_FILE = "/tmp/ccpoke-debug.log";
const MAX_LOG_SIZE = 2 * 1024 * 1024;

const fileOnly = process.env.LOG_FILE_ONLY === "1";
const level = process.env.LOG_LEVEL ?? "info";

function truncateIfOversized(): void {
  try {
    if (statSync(LOG_FILE).size > MAX_LOG_SIZE) {
      writeFileSync(LOG_FILE, "");
    }
  } catch {
    return;
  }
}

truncateIfOversized();

const targets: TransportTargetOptions[] = [
  {
    target: "pino/file",
    options: { destination: LOG_FILE, mkdir: false, append: true },
    level: "debug",
  },
];

if (!fileOnly) {
  targets.push({
    target: "pino-pretty",
    options: { colorize: true, translateTime: "SYS:HH:mm:ss" },
    level,
  });
}

export const logger = pino({ level: "debug", transport: { targets } });

export function flushLogger(cb?: () => void): void {
  logger.flush(cb);
}
