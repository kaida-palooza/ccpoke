import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import { isMacOS, isWindows } from "../../utils/constants.js";

export interface CursorComposerData {
  durationMs: number;
  model: string;
}

const EMPTY_COMPOSER_DATA: CursorComposerData = {
  durationMs: 0,
  model: "",
};

function getCursorStateDbPath(): string {
  const base = isMacOS()
    ? join(homedir(), "Library", "Application Support", "Cursor")
    : isWindows()
      ? join(process.env.APPDATA ?? "", "Cursor")
      : join(homedir(), ".config", "Cursor");

  return join(base, "User", "globalStorage", "state.vscdb");
}

const COMPOSER_QUERY = `
  SELECT
    json_extract(value, '$.createdAt') as createdAt,
    json_extract(value, '$.lastUpdatedAt') as lastUpdatedAt,
    json_extract(value, '$.modelConfig.modelName') as modelName
  FROM cursorDiskKV
  WHERE key = ?
`;

interface ComposerRow {
  createdAt: number | null;
  lastUpdatedAt: number | null;
  modelName: string | null;
}

export function readComposerData(conversationId: string): CursorComposerData {
  const dbPath = getCursorStateDbPath();
  if (!existsSync(dbPath)) return EMPTY_COMPOSER_DATA;

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });

    const row = db.prepare(COMPOSER_QUERY).get(`composerData:${conversationId}`) as
      | ComposerRow
      | undefined;

    if (!row) return EMPTY_COMPOSER_DATA;

    const created = row.createdAt ?? 0;
    const updated = row.lastUpdatedAt ?? 0;
    const durationMs = created > 0 && updated > created ? updated - created : 0;

    return {
      durationMs,
      model: row.modelName ?? "",
    };
  } catch {
    return EMPTY_COMPOSER_DATA;
  } finally {
    db?.close();
  }
}
