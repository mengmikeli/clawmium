import * as fs from "fs";
import * as path from "path";
import { ExtractedData } from "../llm/provider";

const CLM_DIR = path.join(process.env.HOME || "~", "clm");
const CONFIG_PATH = path.join(CLM_DIR, "config.json");

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
