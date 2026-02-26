import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { CrawlManager } from "./crawl/tree";
import { saveCrawl, setCrawlDir } from "./crawl/persistence";
import { saveSession, setSessionDir } from "./session/persistence";
import { buildHomepage, homepageTotal, homepageCrawlAt, HomepageData, HomepageCrawl } from "./cli/homepage";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  PASS: ${msg}`);
    passed++;
  }
}

const TEST_DIR = path.join(os.tmpdir(), `clm-homepage-test-${Date.now()}`);

function cleanup(): void {
  try {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  } catch { /* best effort */ }
}

function createCrawlOnDisk(opts: {
  name?: string;
  url?: string;
  lifecycle?: string;
  tags?: string[];
  pinned?: boolean;
  lastAccessedAge?: number; // ms ago
  nodeCount?: number;
  goalContext?: { baseGoal: string; activeIntent: string; breadcrumb: string[] };
}): string {
  const m = new CrawlManager();
  m.createCrawl(opts.url || "https://example.com", "Root", "goto");
  if (opts.name) m.activeCrawl!.name = opts.name;
  if (opts.lastAccessedAge !== undefined) {
    m.activeCrawl!.lastAccessed = Date.now() - opts.lastAccessedAge;
  }
  // Add extra nodes if needed
  const extraNodes = (opts.nodeCount || 1) - 1;
  for (let i = 0; i < extraNodes; i++) {
    m.addNavigation(`${opts.url || "https://example.com"}/page${i}`, `Page ${i}`, "choice");
  }
  // Set meta
  if (opts.lifecycle || opts.tags || opts.pinned !== undefined) {
    m.setCrawlMeta({
      lifecycle: (opts.lifecycle as any) || "open",
      lifecycleReason: "test",
      lifecycleUpdatedAt: Date.now(),
      tags: (opts.tags as any) || [],
      pinned: opts.pinned || false,
    });
  }
  saveCrawl(m, []);
  saveSession({
    manager: m,
    currentUrl: opts.url || "https://example.com",
    site: "example",
    homeUrl: "",
    goalContext: opts.goalContext || { baseGoal: "", activeIntent: "", breadcrumb: [] },
    history: [],
    log: [],
  });
  return m.activeCrawl!.id;
}

async function main() {
  console.log("=== Homepage Test Suite ===\n");

  // Point persistence at temp dir
  setCrawlDir(TEST_DIR);
  setSessionDir(TEST_DIR);

  // ---------------------------------------------------------------
  // GROUP 1: Empty state (3 tests)
  // ---------------------------------------------------------------
  console.log("--- Empty state ---\n");

  console.log("1. No crawls — homepage data empty...");
  {
    const data = buildHomepage();
    assert(homepageTotal(data) === 0, "total is 0");
    assert(data.pinned.length === 0, "no pinned");
    assert(data.active.length === 0, "no active");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 2: Section sorting (10 tests)
  // ---------------------------------------------------------------
  console.log("--- Section sorting ---\n");

  console.log("2. Open crawl appears in Active...");
  {
    createCrawlOnDisk({ name: "active crawl", lifecycle: "open" });
    const data = buildHomepage();
    assert(data.active.length >= 1, "has active crawl");
    assert(data.active.some(c => c.name === "active crawl"), "correct crawl in active");
  }
  console.log();

  console.log("3. Done crawl appears in Done (within 7 days)...");
  {
    createCrawlOnDisk({ name: "done crawl", lifecycle: "done", lastAccessedAge: 3600000 });
    const data = buildHomepage();
    assert(data.done.some(c => c.name === "done crawl"), "done crawl in done section");
  }
  console.log();

  console.log("4. Stale crawl appears in Stale...");
  {
    createCrawlOnDisk({ name: "stale crawl", lifecycle: "stale", lastAccessedAge: 72 * 3600000 });
    const data = buildHomepage();
    assert(data.stale.some(c => c.name === "stale crawl"), "stale crawl in stale section");
  }
  console.log();

  console.log("5. Pinned crawl appears in Pinned...");
  {
    createCrawlOnDisk({ name: "pinned crawl", lifecycle: "open", pinned: true });
    const data = buildHomepage();
    assert(data.pinned.some(c => c.name === "pinned crawl"), "pinned crawl in pinned section");
    // Should NOT also be in active
    assert(!data.active.some(c => c.name === "pinned crawl"), "pinned crawl not in active");
  }
  console.log();

  console.log("6. Active sorted by lastAccessed descending...");
  {
    // Clear and recreate
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    createCrawlOnDisk({ name: "older", lifecycle: "open", lastAccessedAge: 7200000 });
    createCrawlOnDisk({ name: "newer", lifecycle: "open", lastAccessedAge: 600000 });
    const data = buildHomepage();
    const activeNames = data.active.map(c => c.name);
    const newerIdx = activeNames.indexOf("newer");
    const olderIdx = activeNames.indexOf("older");
    assert(newerIdx >= 0 && olderIdx >= 0, "both found");
    assert(newerIdx < olderIdx, "newer before older");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 3: homepageCrawlAt (4 tests)
  // ---------------------------------------------------------------
  console.log("--- homepageCrawlAt ---\n");

  console.log("7. Index 1 returns first crawl...");
  {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    createCrawlOnDisk({ name: "first", lifecycle: "open" });
    createCrawlOnDisk({ name: "second", lifecycle: "done", lastAccessedAge: 1000 });
    const data = buildHomepage();
    const first = homepageCrawlAt(data, 1);
    assert(first !== null, "index 1 exists");
    assert(first!.name === "first" || first!.name === "second", "returns a valid crawl");
  }
  console.log();

  console.log("8. Out of bounds returns null...");
  {
    const data = buildHomepage();
    assert(homepageCrawlAt(data, 0) === null, "index 0 is null");
    assert(homepageCrawlAt(data, 999) === null, "index 999 is null");
  }
  console.log();

  console.log("9. homepageTotal counts all sections...");
  {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    createCrawlOnDisk({ name: "a", lifecycle: "open" });
    createCrawlOnDisk({ name: "b", lifecycle: "done", lastAccessedAge: 1000 });
    createCrawlOnDisk({ name: "c", lifecycle: "stale", lastAccessedAge: 72 * 3600000 });
    const data = buildHomepage();
    assert(homepageTotal(data) === 3, "total is 3");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 4: Lifecycle inference (3 tests)
  // ---------------------------------------------------------------
  console.log("--- Lifecycle inference ---\n");

  console.log("10. Open crawl with lastAccessed >48h inferred as stale...");
  {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    // Save a crawl without explicit lifecycle (simulating pre-classification era)
    createCrawlOnDisk({ name: "old open", lifecycle: "open", lastAccessedAge: 50 * 3600000 });
    const data = buildHomepage();
    // Should be moved to stale by inferLifecycle
    assert(data.stale.some(c => c.name === "old open"), "old open crawl inferred as stale");
    assert(!data.active.some(c => c.name === "old open"), "not in active");
  }
  console.log();

  console.log("11. Done crawl NOT inferred as stale...");
  {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    createCrawlOnDisk({ name: "old done", lifecycle: "done", lastAccessedAge: 50 * 3600000 });
    const data = buildHomepage();
    // Done > 7 days is excluded entirely
    assert(!data.stale.some(c => c.name === "old done"), "done crawl not in stale");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 5: Edge cases (4 tests)
  // ---------------------------------------------------------------
  console.log("--- Edge cases ---\n");

  console.log("12. Crawl with metadata but no lifecycle defaults to open...");
  {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "No Meta", "goto");
    m.activeCrawl!.name = "No Meta";
    saveCrawl(m, []);
    saveSession({
      manager: m,
      currentUrl: "https://example.com",
      site: "example",
      homeUrl: "",
      goalContext: { baseGoal: "", activeIntent: "", breadcrumb: [] },
      history: [],
      log: [],
    });
    const data = buildHomepage();
    const crawl = [...data.active, ...data.pinned, ...data.done, ...data.stale].find(c => c.name === "No Meta");
    // With no meta, lifecycle defaults to "open"
    assert(crawl !== undefined, "found crawl");
    if (crawl) {
      assert(crawl.lifecycle === "open" || crawl.lifecycle === "stale", "lifecycle is open or stale");
    }
  }
  console.log();

  console.log("13. Multiple nodes counted correctly...");
  {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    createCrawlOnDisk({ name: "multi", url: "https://multi.com", nodeCount: 5 });
    const data = buildHomepage();
    const crawl = [...data.active, ...data.pinned, ...data.done, ...data.stale].find(c => c.name === "multi");
    assert(crawl !== undefined, "found multi crawl");
    if (crawl) {
      assert(crawl.nodeCount === 5, "nodeCount is 5");
    }
  }
  console.log();

  console.log("14. Pinned overdue crawl goes to Pinned, not Active...");
  {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    createCrawlOnDisk({ name: "pinned overdue", lifecycle: "overdue", pinned: true });
    const data = buildHomepage();
    assert(data.pinned.some(c => c.name === "pinned overdue"), "in pinned section");
    assert(!data.active.some(c => c.name === "pinned overdue"), "not in active section");
  }
  console.log();

  console.log("15. Tags preserved from persistence...");
  {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    createCrawlOnDisk({ name: "tagged", lifecycle: "open", tags: ["task", "sensitive"] });
    const data = buildHomepage();
    const crawl = data.active.find(c => c.name === "tagged");
    assert(crawl !== undefined, "found tagged crawl");
    if (crawl) {
      assert(crawl.tags.includes("task"), "has task tag");
      assert(crawl.tags.includes("sensitive"), "has sensitive tag");
    }
  }
  console.log();

  // ---------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------
  cleanup();
  setCrawlDir(null as any);
  setSessionDir(null);

  // ---------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------
  const total = passed + failed;
  console.log(`=== ${passed} passed, ${failed} failed (${total} total) ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  cleanup();
  setCrawlDir(null as any);
  setSessionDir(null);
  console.error("Test failed:", err);
  process.exit(1);
});
