import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function configDir(): string {
  const dir = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode");
  return join(dir, "graphiti-extractor.log");
}

const LOG_PATH = configDir();
const MAX_BYTES = 1_000_000;

/** Append one line to the plugin log file. Never throws. */
export function fileLog(msg: string): void {
  try {
    let size = 0;
    try {
      size = statSync(LOG_PATH).size;
    } catch {
      size = 0;
    }
    if (size > MAX_BYTES) writeFileSync(LOG_PATH, "");
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* ignore */
  }
}

export { LOG_PATH };
