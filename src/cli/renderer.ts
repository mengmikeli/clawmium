// ANSI color helpers — no chalk dependency needed
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[37m";
const BOLD = "\x1b[1m";

export function status(msg: string): void {
  console.log(`${DIM}→ ${msg}${RESET}`);
}

export function progress(msg: string): void {
  process.stdout.write(`\r${DIM}⋯ ${msg}${RESET}\x1b[K`);
}

export function progressDone(): void {
  process.stdout.write(`\r\x1b[K`);
}

export function navSummary(title: string, summary: string, url?: string): void {
  const innerWidth = 72;

  console.log();
  console.log(`  ${BOLD}${title}${RESET}`);
  if (summary) {
    // Word-wrap summary at innerWidth chars, indented 2 spaces
    const lines: string[] = [];
    for (const paragraph of summary.split("\n")) {
      const words = paragraph.split(/\s+/);
      let line = "";
      for (const word of words) {
        if (line.length + word.length + 1 > innerWidth) {
          lines.push(line);
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      }
      if (line) lines.push(line);
    }
    for (const line of lines) {
      console.log(`  ${WHITE}${line}${RESET}`);
    }
  }
  if (url) {
    try {
      const hostname = new URL(url).hostname;
      console.log(`  ${DIM}${hostname}${RESET}`);
    } catch {
      console.log(`  ${DIM}${url}${RESET}`);
    }
  }
  console.log();
}

export function success(msg: string): void {
  console.log(`${GREEN}✓ ${msg}${RESET}`);
}

export function warn(msg: string): void {
  console.log(`${YELLOW}⚠ ${msg}${RESET}`);
}

export function error(msg: string): void {
  console.log(`${RED}✗ ${msg}${RESET}`);
}

export function choices(items: Array<{ index: number; label: string }>): void {
  console.log();
  for (const item of items) {
    console.log(`  ${CYAN}[${item.index}]${RESET} ${WHITE}${item.label}${RESET}`);
  }
  console.log();
}

export function dataTable(title: string, fields: Record<string, unknown>): void {
  const entries = Object.entries(fields);
  const maxKeyLen = Math.max(...entries.map(([k]) => k.length));
  const maxValLen = Math.max(...entries.map(([, v]) => String(v).length));
  const innerWidth = Math.max(maxKeyLen + maxValLen + 4, title.length + 2);

  console.log();
  console.log(`${GREEN}${BOLD}✓ ${title}:${RESET}`);
  console.log(`  ┌${"─".repeat(innerWidth + 2)}┐`);
  for (const [key, value] of entries) {
    const padding = " ".repeat(innerWidth - key.length - String(value).length - 4);
    console.log(`  │ ${BOLD}${key}:${RESET}  ${String(value)}${padding} │`);
  }
  console.log(`  └${"─".repeat(innerWidth + 2)}┘`);
  console.log();
}

export function intercepted(method: string, url: string, statusCode: number, size: number): void {
  // Strip base URL, show just the path
  const path = url.replace(/^https?:\/\/[^/]+/, "");
  console.log(`${DIM}→ intercepted: ${method} ${path} (${statusCode}, ${size} bytes)${RESET}`);
}

export function banner(provider: string): Promise<void> {
  const BRIGHT_RED = "\x1b[91m";
  const DIM_RED = "\x1b[2m\x1b[31m";
  const HIDE_CURSOR = "\x1b[?25l";
  const SHOW_CURSOR = "\x1b[?25h";

  const providerLabel = provider === "openai" ? "GPT-4o (openai)" : "Claude (anthropic)";

  // Text lines and their visible lengths (without ANSI codes)
  const textLines = [
    { ansi: `${BOLD}Clawmium v0.2${RESET}`, len: "Clawmium v0.2".length },
    { ansi: "Agent-first browser", len: "Agent-first browser".length },
    { ansi: `Provider: ${providerLabel}`, len: `Provider: ${providerLabel}`.length },
  ];

  // Claw animation frames — art only, no trailing padding
  // open → closing → closed → opening → open
  // len = actual visible character count (no embedded trailing spaces)
  // The render loop pads with plain spaces: clawWidth - len
  const frames = [
    // Frame 0: open — " /\    /|" (9), "/  \__/ |" (9), "/   /___/" (9)
    [
      { ansi: `${DIM_RED} /\\${RESET}${RED}    ${RESET}${BRIGHT_RED}/|${RESET}`, len: 9 },
      { ansi: `${DIM_RED}/  \\${RESET}${RED}__${RESET}${BRIGHT_RED}/ |${RESET}`, len: 9 },
      { ansi: `${DIM_RED}/   /${RESET}${BRIGHT_RED}___/${RESET}`, len: 9 },
    ],
    // Frame 1: closing — " /\  /|" (7), "/  \/ |" (7), "/  /__/" (7)
    [
      { ansi: `${DIM_RED} /\\${RESET}${RED}  ${RESET}${BRIGHT_RED}/|${RESET}`, len: 7 },
      { ansi: `${DIM_RED}/  \\${RESET}${BRIGHT_RED}/ |${RESET}`, len: 7 },
      { ansi: `${DIM_RED}/  /${RESET}${BRIGHT_RED}__/${RESET}`, len: 7 },
    ],
    // Frame 2: closed — " /\/|" (5), "/  \|" (5), "/ /__/" (6)
    [
      { ansi: `${DIM_RED} /\\${RESET}${BRIGHT_RED}/|${RESET}`, len: 5 },
      { ansi: `${DIM_RED}/  ${RESET}${BRIGHT_RED}\\|${RESET}`, len: 5 },
      { ansi: `${DIM_RED}/ /${RESET}${BRIGHT_RED}__/${RESET}`, len: 6 },
    ],
    // Frame 3: opening (same as closing)
    [
      { ansi: `${DIM_RED} /\\${RESET}${RED}  ${RESET}${BRIGHT_RED}/|${RESET}`, len: 7 },
      { ansi: `${DIM_RED}/  \\${RESET}${BRIGHT_RED}/ |${RESET}`, len: 7 },
      { ansi: `${DIM_RED}/  /${RESET}${BRIGHT_RED}__/${RESET}`, len: 7 },
    ],
    // Frame 4: back to open
    [
      { ansi: `${DIM_RED} /\\${RESET}${RED}    ${RESET}${BRIGHT_RED}/|${RESET}`, len: 9 },
      { ansi: `${DIM_RED}/  \\${RESET}${RED}__${RESET}${BRIGHT_RED}/ |${RESET}`, len: 9 },
      { ansi: `${DIM_RED}/   /${RESET}${BRIGHT_RED}___/${RESET}`, len: 9 },
    ],
  ];

  const gap = 3;
  const textWidth = Math.max(...textLines.map(l => l.len));
  const clawWidth = 9;
  const innerWidth = textWidth + gap + clawWidth;

  // Render a single frame (3 content lines) at a fixed position
  const renderFrame = (clawArt: typeof frames[0]) => {
    // Move cursor up 4 lines (3 content + bottom border)
    process.stdout.write(`\x1b[4A`);
    for (let i = 0; i < textLines.length; i++) {
      const clawPad = " ".repeat(clawWidth - clawArt[i].len);
      const textPad = " ".repeat(textWidth - textLines[i].len);
      process.stdout.write(`  │ ${clawArt[i].ansi}${clawPad}${" ".repeat(gap)}${textLines[i].ansi}${textPad} │\n`);
    }
    process.stdout.write(`  ╰${"─".repeat(innerWidth + 2)}╯\n`);
  };

  // Draw initial frame
  process.stdout.write(HIDE_CURSOR);
  console.log();
  console.log(`  ╭${"─".repeat(innerWidth + 2)}╮`);
  const firstFrame = frames[0];
  for (let i = 0; i < textLines.length; i++) {
    const clawPad = " ".repeat(clawWidth - firstFrame[i].len);
    const textPad = " ".repeat(textWidth - textLines[i].len);
    console.log(`  │ ${firstFrame[i].ansi}${clawPad}${" ".repeat(gap)}${textLines[i].ansi}${textPad} │`);
  }
  console.log(`  ╰${"─".repeat(innerWidth + 2)}╯`);

  // Animate: cycle through frames twice (open→closed→open→closed→open)
  const sequence = [...frames.slice(1), ...frames.slice(1)];
  return new Promise<void>((resolve) => {
    let idx = 0;
    const interval = setInterval(() => {
      renderFrame(sequence[idx]);
      idx++;
      if (idx >= sequence.length) {
        clearInterval(interval);
        process.stdout.write(SHOW_CURSOR);
        console.log();
        resolve();
      }
    }, 200);
  });
}

export function help(): void {
  console.log();
  console.log(`  ${BOLD}Commands:${RESET}`);
  console.log(`  ${CYAN}/show${RESET}          Open browser window`);
  console.log(`  ${CYAN}/hide${RESET}          Close browser window`);
  console.log(`  ${CYAN}/goto <url>${RESET}    Navigate to a URL`);
  console.log(`  ${CYAN}/back${RESET}          Navigate back`);
  console.log(`  ${CYAN}/forward${RESET}       Navigate forward`);
  console.log(`  ${CYAN}/home${RESET}          Go to home URL (set with /home <url>)`);
  console.log(`  ${CYAN}/refresh${RESET}       Re-analyze current page`);
  console.log(`  ${CYAN}/login${RESET}         Log in to current site`);
  console.log(`  ${CYAN}/save${RESET}          Save data to disk`);
  console.log(`  ${CYAN}/url${RESET}           Show current URL`);
  console.log(`  ${CYAN}/stack${RESET}         Show navigation stack`);
  console.log(`  ${CYAN}/history${RESET}       Show visit history (/history N to jump)`);
  console.log(`  ${CYAN}/tree${RESET}          Show crawl navigation tree`);
  console.log(`  ${CYAN}/crawl${RESET}         Manage crawls (list, load, rename, end, info)`);
  console.log(`  ${CYAN}/clear${RESET}         Reset state (repl, crawl, browser, all)`);
  console.log(`  ${CYAN}/demo${RESET}          Run CityServe demo`);
  console.log(`  ${CYAN}/quit${RESET}          End session`);
  console.log(`  ${CYAN}/help${RESET}          Show this help`);
  console.log();
  console.log(`  ${DIM}Numbers select choices. Free text is sent to the LLM.${RESET}`);
  console.log(`  ${DIM}Ctrl+C cancels the current operation.${RESET}`);
  console.log();
}

export function hint(commands: string[]): void {
  console.log(`${DIM}  tip: ${commands.join(", ")}${RESET}`);
}

export function contentBox(title: string, text: string, width = 76): void {
  const innerWidth = width - 4; // account for "  │ " and " │"

  // Word-wrap text to fit inside the box
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/);
    let line = "";
    for (const word of words) {
      if (line.length + word.length + 1 > innerWidth) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) lines.push(line);
  }

  console.log();
  console.log(`  ${BOLD}${title}${RESET}`);
  console.log(`  ┌${"─".repeat(innerWidth + 2)}┐`);
  for (const line of lines) {
    const padding = " ".repeat(Math.max(0, innerWidth - line.length));
    console.log(`  │ ${WHITE}${line}${RESET}${padding} │`);
  }
  console.log(`  └${"─".repeat(innerWidth + 2)}┘`);
  console.log();
}

export function commentThread(
  title: string,
  comments: Array<{ author: string; age: string; text: string; depth: number }>,
  maxDisplay = 15,
  width = 76,
): void {
  const innerWidth = width - 4;

  console.log();
  console.log(`  ${BOLD}${title}${RESET}`);
  console.log(`  ${"─".repeat(innerWidth)}`);

  const shown = comments.slice(0, maxDisplay);
  for (const comment of shown) {
    const indent = "  ".repeat(comment.depth);
    const prefix = `  ${indent}`;

    // Author + age header
    console.log(`${prefix}${CYAN}${comment.author}${RESET} ${DIM}${comment.age}${RESET}`);

    // Word-wrap comment text
    const availWidth = innerWidth - indent.length * 2 - 2;
    const words = comment.text.split(/\s+/);
    let line = "";
    for (const word of words) {
      if (line.length + word.length + 1 > availWidth) {
        console.log(`${prefix}${WHITE}${line}${RESET}`);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) console.log(`${prefix}${WHITE}${line}${RESET}`);
    console.log();
  }

  if (comments.length > maxDisplay) {
    console.log(`  ${DIM}... and ${comments.length - maxDisplay} more comments${RESET}`);
  }
  console.log(`  ${"─".repeat(innerWidth)}`);
  console.log();
}

export function promptString(): string {
  return `${CYAN}> ${RESET}`;
}

export function prompt(): void {
  process.stdout.write(promptString());
}

export function clearSummary(items: string[]): void {
  console.log();
  console.log(`  ${BOLD}Will be cleared:${RESET}`);
  for (const item of items) {
    console.log(`  ${YELLOW}•${RESET} ${item}`);
  }
  console.log();
}

export function crawlList(crawls: Array<{ index: number; name: string; rootUrl: string; nodeCount: number; created: number }>): void {
  console.log();
  console.log(`  ${BOLD}Saved crawls:${RESET}`);
  console.log();
  for (const c of crawls) {
    const date = new Date(c.created);
    const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    console.log(`  ${CYAN}[${c.index}]${RESET} ${WHITE}${c.name}${RESET}`);
    let hostname: string;
    try {
      hostname = new URL(c.rootUrl).hostname;
    } catch {
      hostname = c.rootUrl;
    }
    console.log(`      ${DIM}${hostname} · ${c.nodeCount} node${c.nodeCount !== 1 ? "s" : ""} · ${dateStr}${RESET}`);
  }
  console.log();
}

export function crawlInfo(name: string, created: number, nodeCount: number, rootUrl: string, currentNodeTitle: string): void {
  const date = new Date(created);
  const dateStr = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  let hostname: string;
  try {
    hostname = new URL(rootUrl).hostname;
  } catch {
    hostname = rootUrl;
  }

  const fields: Record<string, string> = {
    Created: dateStr,
    Root: hostname,
    Nodes: String(nodeCount),
    Current: currentNodeTitle || "(unknown)",
  };

  const entries = Object.entries(fields);
  const maxKeyLen = Math.max(...entries.map(([k]) => k.length));
  const maxValLen = Math.max(...entries.map(([, v]) => v.length));
  const innerWidth = Math.max(maxKeyLen + maxValLen + 4, name.length + 2, 36);

  console.log();
  console.log(`  ${BOLD}Active crawl: "${name}"${RESET}`);
  console.log(`  ┌${"─".repeat(innerWidth + 2)}┐`);
  for (const [key, value] of entries) {
    const padding = " ".repeat(Math.max(0, innerWidth - key.length - value.length - 4));
    console.log(`  │ ${BOLD}${key}:${RESET}  ${value}${padding} │`);
  }
  console.log(`  └${"─".repeat(innerWidth + 2)}┘`);
  console.log();
}

// ---------------------------------------------------------------
// Private helpers for history/stack display
// ---------------------------------------------------------------

function formatRelativeTime(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function truncateUrl(url: string, maxLen = 50): string {
  if (url.length <= maxLen) return url;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const path = parsed.pathname;
    const available = maxLen - host.length - 3; // 3 for "..."
    if (available <= 0) return host.slice(0, maxLen - 3) + "...";
    // Show hostname + tail of path
    if (path.length <= available) return `${host}${path}`;
    return `${host}...${path.slice(-(available))}`;
  } catch {
    return url.slice(0, maxLen - 3) + "...";
  }
}

// ---------------------------------------------------------------
// History display
// ---------------------------------------------------------------

export interface HistoryEntry {
  index: number;
  title: string;
  url: string;
  reachedBy: string;
  timestamp: number;
  summary?: string;
  isCurrent: boolean;
  crawlName?: string;
}

const reachedByIcon: Record<string, string> = {
  choice: "↗",
  goto: "⇒",
  back: "←",
  forward: "→",
  auto: "·",
  history: "⏎",
};

export function historyList(entries: HistoryEntry[]): void {
  console.log();
  console.log(`  ${BOLD}Visit history (${entries.length} page${entries.length !== 1 ? "s" : ""})${RESET}`);
  console.log();

  // Show last 30 entries, with overflow indicator
  const maxShow = 30;
  const startIdx = Math.max(0, entries.length - maxShow);
  if (startIdx > 0) {
    console.log(`  ${DIM}... ${startIdx} earlier entr${startIdx !== 1 ? "ies" : "y"} ...${RESET}`);
  }

  const shown = entries.slice(startIdx);
  let lastCrawlName: string | undefined;
  for (const entry of shown) {
    // Crawl boundary separator
    if (entry.crawlName && entry.crawlName !== lastCrawlName) {
      if (lastCrawlName !== undefined) {
        console.log(`  ${DIM}${"─".repeat(52)}${RESET}`);
      }
      console.log(`  ${DIM}▸ ${entry.crawlName}${RESET}`);
      lastCrawlName = entry.crawlName;
    }

    const icon = reachedByIcon[entry.reachedBy] || "·";
    const time = formatRelativeTime(entry.timestamp);
    const prefix = entry.isCurrent ? `${CYAN}→${RESET}` : " ";
    const titleStr = entry.isCurrent
      ? `${BOLD}${WHITE}${entry.title}${RESET}`
      : entry.title;

    // Pad between title and time
    const titleVisible = entry.title;
    const timeCol = 52;
    const gap = Math.max(1, timeCol - titleVisible.length - 6); // 6 = "[N] i "
    const padding = " ".repeat(gap);

    console.log(`  ${prefix} ${CYAN}[${entry.index}]${RESET} ${icon} ${titleStr}${padding}${DIM}${time}${RESET}`);

    // Show summary as dim second line if available
    if (entry.summary) {
      const truncated = entry.summary.length > 60
        ? entry.summary.slice(0, 57) + "..."
        : entry.summary;
      console.log(`         ${DIM}${truncated}${RESET}`);
    }
  }
  console.log();
}

// ---------------------------------------------------------------
// Stack display
// ---------------------------------------------------------------

export interface StackEntry {
  url: string;
  title: string;
}

export function stackView(
  current: StackEntry,
  browserUrl: string,
  synced: boolean,
  backStack: StackEntry[],
  forwardStack: StackEntry[],
): void {
  console.log();
  console.log(`  ${BOLD}Navigation stack${RESET}`);
  console.log();

  // Current position
  console.log(`  ${CYAN}→${RESET} ${BOLD}${WHITE}${current.title || "(untitled)"}${RESET}`);
  console.log(`    ${DIM}${current.url || "(no URL)"}${RESET}`);
  console.log();

  // Browser sync status
  if (synced) {
    console.log(`  ${DIM}browser: synced${RESET}`);
  } else {
    console.log(`  ${YELLOW}browser: not synced${RESET} ${DIM}(${truncateUrl(browserUrl)})${RESET}`);
  }
  console.log();

  // Back stack (most recent first)
  console.log(`  ${DIM}← Back (${backStack.length}):${RESET}`);
  if (backStack.length === 0) {
    console.log(`    ${DIM}(empty)${RESET}`);
  } else {
    const reversed = [...backStack].reverse();
    for (const entry of reversed) {
      let host: string;
      try { host = new URL(entry.url).hostname; } catch { host = entry.url; }
      console.log(`    ${DIM}←${RESET} ${entry.title || "(untitled)"}  ${DIM}${host}${RESET}`);
    }
  }
  console.log();

  // Forward stack
  console.log(`  ${DIM}→ Forward (${forwardStack.length}):${RESET}`);
  if (forwardStack.length === 0) {
    console.log(`    ${DIM}(empty)${RESET}`);
  } else {
    for (const entry of forwardStack) {
      let host: string;
      try { host = new URL(entry.url).hostname; } catch { host = entry.url; }
      console.log(`    ${DIM}→${RESET} ${entry.title || "(untitled)"}  ${DIM}${host}${RESET}`);
    }
  }
  console.log();
}

export function stashIndicator(depth: number, names: string[]): void {
  if (depth === 0) return;
  console.log(`  ${DIM}Stash (${depth} crawl${depth !== 1 ? "s" : ""}):${RESET}`);
  for (let i = names.length - 1; i >= 0; i--) {
    console.log(`    ${DIM}▸${RESET} ${names[i]}`);
  }
  console.log(`  ${DIM}(/back at start of crawl pops the stash)${RESET}`);
  console.log();
}
