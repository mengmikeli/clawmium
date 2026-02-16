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

export function banner(provider: string): void {
  const providerLabel = provider === "openai" ? "GPT-4o (openai)" : "Claude (anthropic)";
  const lines = [
    `${BOLD}Clawmium v0.1${RESET}`,
    "Agent-first browser",
    `Provider: ${providerLabel}`,
  ];
  // Visible lengths (without ANSI codes)
  const visibleLengths = [
    "Clawmium v0.1".length,
    "Agent-first browser".length,
    `Provider: ${providerLabel}`.length,
  ];
  const innerWidth = Math.max(...visibleLengths) + 4;

  console.log();
  console.log(`  ╭${"─".repeat(innerWidth + 2)}╮`);
  for (let i = 0; i < lines.length; i++) {
    const padding = " ".repeat(innerWidth - visibleLengths[i]);
    console.log(`  │ ${lines[i]}${padding} │`);
  }
  console.log(`  ╰${"─".repeat(innerWidth + 2)}╯`);
  console.log();
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
  console.log(`  ${CYAN}/stack${RESET}         Show URL stack and sync status`);
  console.log(`  ${CYAN}/tree${RESET}          Show crawl navigation tree`);
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
