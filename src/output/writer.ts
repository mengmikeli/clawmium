import * as fs from "fs";
import * as path from "path";
import { ExtractedData } from "../llm/provider";

const CLM_DIR = path.join(process.env.HOME || "~", "clm");

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
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
