import { CrawlLifecycle, CrawlTag } from "../crawl/classify";
import { listCrawlsWithMeta, CrawlPeek } from "../crawl/persistence";

// ===================================================================
// Types
// ===================================================================

export interface HomepageCrawl {
  id: string;
  name: string;
  lifecycle: CrawlLifecycle;
  rootUrl: string;
  nodeCount: number;
  lastAccessed: number;
  tags: CrawlTag[];
  pinned: boolean;
  lifecycleReason?: string;
}

export interface HomepageData {
  pinned: HomepageCrawl[];
  active: HomepageCrawl[];
  done: HomepageCrawl[];
  stale: HomepageCrawl[];
}

// ===================================================================
// Build homepage data from persisted crawls
// ===================================================================

function peekToHomepage(peek: CrawlPeek): HomepageCrawl {
  return {
    id: peek.id,
    name: peek.name,
    lifecycle: peek.lifecycle || "open",
    rootUrl: peek.rootUrl,
    nodeCount: peek.nodeCount,
    lastAccessed: peek.lastAccessed || peek.created,
    tags: peek.tags || [],
    pinned: peek.pinned || false,
  };
}

/**
 * Compute stale/overdue status for crawls that were saved before classification existed.
 * This re-applies the time-based heuristics to the peek data.
 */
function inferLifecycle(crawl: HomepageCrawl): void {
  if (crawl.lifecycle !== "open") return;
  const now = Date.now();
  if (now - crawl.lastAccessed > 48 * 3600000) {
    crawl.lifecycle = "stale";
  }
}

export function buildHomepage(): HomepageData {
  const peeks = listCrawlsWithMeta();
  const data: HomepageData = {
    pinned: [],
    active: [],
    done: [],
    stale: [],
  };

  for (const peek of peeks) {
    const crawl = peekToHomepage(peek);
    inferLifecycle(crawl);

    if (crawl.pinned) {
      data.pinned.push(crawl);
    } else if (crawl.lifecycle === "done") {
      // Only show done crawls from last 7 days
      if (Date.now() - crawl.lastAccessed < 7 * 24 * 3600000) {
        data.done.push(crawl);
      }
    } else if (crawl.lifecycle === "stale") {
      data.stale.push(crawl);
    } else {
      // open or overdue
      data.active.push(crawl);
    }
  }

  // Sort each section by lastAccessed descending
  const byRecent = (a: HomepageCrawl, b: HomepageCrawl) => b.lastAccessed - a.lastAccessed;
  data.pinned.sort(byRecent);
  data.active.sort(byRecent);
  data.done.sort(byRecent);
  data.stale.sort(byRecent);

  return data;
}

// ===================================================================
// Render homepage
// ===================================================================

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[37m";
const BOLD = "\x1b[1m";

const lifecycleIcon: Record<CrawlLifecycle, string> = {
  open: "○",
  done: `${GREEN}✓${RESET}`,
  overdue: `${YELLOW}⚠${RESET}`,
  stale: `${DIM}·${RESET}`,
};

function formatRelativeTime(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  // Show date for older
  const d = new Date(timestamp);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function renderCrawlLine(index: number, crawl: HomepageCrawl): void {
  const icon = lifecycleIcon[crawl.lifecycle] || "○";
  const tagsStr = crawl.tags.length > 0 ? ` ${DIM}(${crawl.tags[0]})${RESET}` : "";
  const time = formatRelativeTime(crawl.lastAccessed);
  const host = hostname(crawl.rootUrl);

  console.log(`  ${CYAN}[${index}]${RESET} ${icon} ${WHITE}${crawl.name}${RESET}${tagsStr}`);
  console.log(`      ${DIM}${host} · ${crawl.nodeCount} node${crawl.nodeCount !== 1 ? "s" : ""} · ${time}${RESET}`);
}

function renderSection(title: string, crawls: HomepageCrawl[], startIndex: number): number {
  if (crawls.length === 0) return startIndex;
  console.log();
  console.log(`  ${BOLD}${title}${RESET}`);
  let idx = startIndex;
  for (const crawl of crawls) {
    renderCrawlLine(idx, crawl);
    idx++;
  }
  return idx;
}

export function renderHomepage(data: HomepageData): void {
  const totalActive = data.pinned.length + data.active.length;
  const totalDone = data.done.length;
  const totalStale = data.stale.length;

  const parts: string[] = [];
  if (totalActive > 0) parts.push(`${totalActive} active`);
  if (totalDone > 0) parts.push(`${totalDone} done`);
  if (totalStale > 0) parts.push(`${totalStale} stale`);
  const statsStr = parts.length > 0 ? parts.join(", ") : "no crawls";

  // Header box
  const innerText = `Clawmium — ${statsStr}`;
  const innerWidth = Math.max(innerText.length + 2, 40);
  const padLeft = Math.floor((innerWidth - innerText.length) / 2);
  const padRight = innerWidth - innerText.length - padLeft;

  console.log();
  console.log(`  ╭${"─".repeat(innerWidth + 2)}╮`);
  console.log(`  │${" ".repeat(padLeft + 1)}${innerText}${" ".repeat(padRight + 1)}│`);
  console.log(`  ╰${"─".repeat(innerWidth + 2)}╯`);

  let idx = 1;
  idx = renderSection("Pinned", data.pinned, idx);
  idx = renderSection("Active", data.active, idx);
  idx = renderSection("Done", data.done, idx);
  idx = renderSection("Stale", data.stale, idx);

  console.log();
  console.log(`  ${DIM}Type a number to resume, /goto for new, /help for commands${RESET}`);
  console.log();
}

/**
 * Get the total number of crawls in the homepage data.
 */
export function homepageTotal(data: HomepageData): number {
  return data.pinned.length + data.active.length + data.done.length + data.stale.length;
}

/**
 * Get the crawl at a 1-indexed position in homepage order.
 */
export function homepageCrawlAt(data: HomepageData, index: number): HomepageCrawl | null {
  const all = [...data.pinned, ...data.active, ...data.done, ...data.stale];
  if (index < 1 || index > all.length) return null;
  return all[index - 1];
}
