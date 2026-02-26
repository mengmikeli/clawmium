import * as fs from "fs";
import * as path from "path";
import { ExtractedData } from "../llm/provider";
import { ReachedBy } from "../crawl/tree";

const CLM_DIR = process.env.CLM_DIR || path.join(process.env.HOME || "~", "clm");
const CONFIG_PATH = path.join(CLM_DIR, "config.json");
const HISTORY_PATH = path.join(CLM_DIR, "history.json");

interface ClmConfig {
  homeUrl?: string;
  lastSessionId?: string;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadConfig(): ClmConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    }
  } catch { /* corrupt config — start fresh */ }
  return {};
}

export function saveConfig(config: ClmConfig): void {
  ensureDir(CLM_DIR);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function datestamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export function saveData(site: string, resource: string, data: ExtractedData): string {
  const dir = path.join(CLM_DIR, site);
  ensureDir(dir);

  const filename = `${resource}-${datestamp()}.json`;
  const filepath = path.join(dir, filename);

  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  return filepath;
}

export function saveSessionLog(
  site: string,
  entries: Array<{ role: string; content: string; timestamp: number }>
): string {
  const dir = path.join(CLM_DIR, site);
  ensureDir(dir);

  const filename = `session-log-${datestamp()}.md`;
  const filepath = path.join(dir, filename);

  const lines = [
    `# Session Log — ${site} — ${datestamp()}`,
    "",
  ];

  for (const entry of entries) {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    if (entry.role === "user") {
      lines.push(`**[${time}] User:** ${entry.content}`);
    } else {
      lines.push(`**[${time}] Agent:** ${entry.content}`);
    }
    lines.push("");
  }

  fs.writeFileSync(filepath, lines.join("\n"));
  return filepath;
}

// ===================================================================
// Global History (persistent across sessions)
// ===================================================================

export interface GlobalHistoryEntry {
  url: string;
  title: string;
  timestamp: number;
  reachedBy: ReachedBy;
  crawlId: string;
  crawlName: string;
}

interface GlobalHistory {
  version: 1;
  entries: GlobalHistoryEntry[];
}

const MAX_HISTORY_ENTRIES = 1000;

/** Override for testing */
let historyPathOverride: string | null = null;
export function setHistoryPath(p: string | null): void {
  historyPathOverride = p;
}
function getHistoryPath(): string {
  return historyPathOverride || HISTORY_PATH;
}

export function loadGlobalHistory(): GlobalHistoryEntry[] {
  const hp = getHistoryPath();
  try {
    if (fs.existsSync(hp)) {
      const data = JSON.parse(fs.readFileSync(hp, "utf-8")) as GlobalHistory;
      if (data.version === 1 && Array.isArray(data.entries)) {
        return data.entries;
      }
    }
  } catch { /* corrupt file — start fresh */ }
  return [];
}

export function appendGlobalHistory(newEntries: GlobalHistoryEntry[]): void {
  if (newEntries.length === 0) return;

  const hp = getHistoryPath();
  const existing = loadGlobalHistory();

  // Dedup by timestamp — if the same timestamp already exists, skip it
  const existingTimestamps = new Set(existing.map(e => e.timestamp));
  const toAdd = newEntries.filter(e => !existingTimestamps.has(e.timestamp));
  if (toAdd.length === 0) return;

  const merged = [...existing, ...toAdd];

  // Cap at MAX_HISTORY_ENTRIES, drop oldest
  const capped = merged.length > MAX_HISTORY_ENTRIES
    ? merged.slice(merged.length - MAX_HISTORY_ENTRIES)
    : merged;

  const history: GlobalHistory = { version: 1, entries: capped };
  ensureDir(path.dirname(hp));
  fs.writeFileSync(hp, JSON.stringify(history, null, 2));
}
