import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { CrawlManager } from "./crawl/tree";
import { saveCrawl, loadCrawl, listCrawls, peekCrawl, setCrawlDir } from "./crawl/persistence";

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

const TEST_DIR = path.join(os.tmpdir(), `clm-crawl-phase4-test-${Date.now()}`);

function cleanup(): void {
  try {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  } catch { /* best effort */ }
}

async function main() {
  console.log("=== Crawl Phase 4 Test Suite ===\n");

  setCrawlDir(TEST_DIR);

  // ---------------------------------------------------------------
  // GROUP 1: peekCrawl (5 tests)
  // ---------------------------------------------------------------
  console.log("--- peekCrawl ---\n");

  console.log("1. peekCrawl returns correct metadata for a saved crawl...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Example Root", "goto");
    m.addNavigation("https://example.com/page1", "Page 1", "choice");
    m.addNavigation("https://example.com/page2", "Page 2", "choice");
    m.activeCrawl!.name = "test peek crawl";

    const filepath = saveCrawl(m);
    const crawlId = m.activeCrawl!.id;

    const peek = peekCrawl(crawlId);
    assert(peek !== null, "peekCrawl returns non-null");
    assert(peek!.id === crawlId, "peekCrawl id matches");
    assert(peek!.name === "test peek crawl", "peekCrawl name matches");
    assert(peek!.rootUrl === "https://example.com", "peekCrawl rootUrl matches");
    assert(peek!.nodeCount === 3, "peekCrawl nodeCount = 3 (root + 2 children)");
  }
  console.log();

  console.log("2. peekCrawl returns null for missing file...");
  {
    const peek = peekCrawl("nonexistent-id-12345");
    assert(peek === null, "peekCrawl returns null for missing crawl");
  }
  console.log();

  console.log("3. peekCrawl returns null for corrupt file...");
  {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(path.join(TEST_DIR, "corrupt.md"), "this is not a valid crawl file\njust garbage");
    const peek = peekCrawl("corrupt");
    assert(peek === null, "peekCrawl returns null for corrupt file");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 2: saveCrawl with sessionLog (5 tests)
  // ---------------------------------------------------------------
  console.log("--- saveCrawl with sessionLog ---\n");

  console.log("4. saveCrawl includes session log section when provided...");
  {
    const m = new CrawlManager();
    const crawl = m.createCrawl("https://example.com", "Root", "goto");
    const now = crawl.created;

    const sessionLog = [
      { role: "user", content: "browsing example.com", timestamp: now },
      { role: "agent", content: "Page loaded: Example Root", timestamp: now + 1000 },
      { role: "user", content: "/goto https://example.com/page1", timestamp: now + 2000 },
    ];

    // Update lastAccessed so filter range includes all entries
    m.activeCrawl!.lastAccessed = now + 5000;

    const filepath = saveCrawl(m, sessionLog);
    const content = fs.readFileSync(filepath, "utf-8");
    assert(content.includes("## Session Log"), "session log section present");
    assert(content.includes("user: browsing example.com"), "first log entry present");
    assert(content.includes("agent: Page loaded: Example Root"), "second log entry present");
  }
  console.log();

  console.log("5. saveCrawl filters session log entries to crawl time range...");
  {
    const m = new CrawlManager();
    const crawl = m.createCrawl("https://example.com", "Root", "goto");
    const now = crawl.created;

    const sessionLog = [
      { role: "user", content: "before crawl", timestamp: now - 10000 },
      { role: "user", content: "during crawl", timestamp: now + 1000 },
      { role: "user", content: "after crawl", timestamp: now + 100000 },
    ];

    // Set narrow lastAccessed
    m.activeCrawl!.lastAccessed = now + 5000;

    const filepath = saveCrawl(m, sessionLog);
    const content = fs.readFileSync(filepath, "utf-8");
    assert(content.includes("during crawl"), "entry within range is included");
    assert(!content.includes("before crawl"), "entry before range is excluded");
    assert(!content.includes("after crawl"), "entry after range is excluded");
  }
  console.log();

  console.log("6. saveCrawl without sessionLog has no Session Log section...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    const filepath = saveCrawl(m);
    const content = fs.readFileSync(filepath, "utf-8");
    assert(!content.includes("## Session Log"), "no session log section when not provided");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 3: getEnrichedDisplayTree (6 tests)
  // ---------------------------------------------------------------
  console.log("--- getEnrichedDisplayTree ---\n");

  console.log("7. enriched tree marks current node...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root Page", "goto");
    m.addNavigation("https://example.com/child", "Child Page", "choice");
    // currentNodeId is now child
    const tree = m.getEnrichedDisplayTree();
    // Current node should have → prefix (ANSI codes around it)
    assert(tree.includes("→"), "current node has → marker");
    assert(tree.includes("Child Page"), "current node title present");
  }
  console.log();

  console.log("8. enriched tree shows summaries truncated...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    const rootId = m.currentNodeId!;
    m.setNodeMetadata(rootId, { summary: "This is a very long summary that should be truncated to fifty characters max for display" });
    // Navigate to child so root gets the summary display
    m.addNavigation("https://example.com/page", "Page", "choice");
    const tree = m.getEnrichedDisplayTree();
    assert(tree.includes("..."), "long summary is truncated with ...");
    // The original summary is 88 chars; truncated should be 50 (47 + ...)
    assert(!tree.includes("for display"), "end of long summary is not shown");
  }
  console.log();

  console.log("9. enriched tree handles nodes without summaries...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "No Summary Node", "goto");
    const tree = m.getEnrichedDisplayTree();
    assert(tree.includes("No Summary Node"), "node without summary shows title");
    // Should not crash
    assert(tree.length > 0, "tree is non-empty");
  }
  console.log();

  console.log("10. enriched tree shows reachedBy icons...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.addNavigation("https://example.com/a", "Page A", "choice");
    m.addNavigation("https://example.com/b", "Page B", "goto");
    const tree = m.getEnrichedDisplayTree();
    // Root is "goto" → ⇒, Page A is "choice" → ↗, Page B is "goto" → ⇒
    assert(tree.includes("⇒"), "goto icon present");
    assert(tree.includes("↗"), "choice icon present");
  }
  console.log();

  console.log("11. enriched tree returns empty for no crawl...");
  {
    const m = new CrawlManager();
    const tree = m.getEnrichedDisplayTree();
    assert(tree === "", "empty string when no active crawl");
  }
  console.log();

  console.log("12. enriched tree shows crawl name...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.activeCrawl!.name = "my named crawl";
    const tree = m.getEnrichedDisplayTree();
    assert(tree.includes("my named crawl"), "crawl name shown in tree header");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 4: peekCrawl + session log round-trip (3 tests)
  // ---------------------------------------------------------------
  console.log("--- peekCrawl with session log ---\n");

  console.log("13. peekCrawl nodeCount ignores session log section...");
  {
    const m = new CrawlManager();
    const crawl = m.createCrawl("https://example.com", "Root", "goto");
    m.addNavigation("https://example.com/p1", "P1", "choice");

    const now = crawl.created;
    const log = [
      { role: "user", content: "### this looks like a node heading", timestamp: now },
    ];
    m.activeCrawl!.lastAccessed = now + 5000;

    saveCrawl(m, log);
    const peek = peekCrawl(m.activeCrawl!.id);
    assert(peek !== null, "peekCrawl returns non-null with session log");
    assert(peek!.nodeCount === 2, "nodeCount is 2 (not fooled by ### in session log)");
  }
  console.log();

  console.log("14. loadCrawl still works with session log section present...");
  {
    const m = new CrawlManager();
    const crawl = m.createCrawl("https://example.com", "Root", "goto");
    m.addNavigation("https://example.com/p1", "P1", "choice");
    m.activeCrawl!.name = "session log crawl";

    const now = crawl.created;
    const log = [{ role: "agent", content: "loaded page", timestamp: now }];
    m.activeCrawl!.lastAccessed = now + 5000;

    saveCrawl(m, log);
    const crawlId = m.activeCrawl!.id;

    // Load into fresh manager
    const m2 = new CrawlManager();
    const loaded = loadCrawl(crawlId, m2);
    assert(loaded === true, "loadCrawl succeeds with session log");
    assert(m2.nodes.size === 2, "loaded 2 nodes");
    assert(m2.activeCrawl!.name === "session log crawl", "loaded correct name");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 5: listCrawls + peekCrawl integration (2 tests)
  // ---------------------------------------------------------------
  console.log("--- listCrawls + peekCrawl integration ---\n");

  console.log("15. listCrawls returns all saved crawl IDs...");
  {
    // We've already saved several crawls above
    const ids = listCrawls();
    assert(ids.length >= 3, `listCrawls returns at least 3 crawls (got ${ids.length})`);

    // Peek all of them
    let allValid = true;
    for (const id of ids) {
      if (id === "corrupt") continue; // skip our corrupt test file
      const peek = peekCrawl(id);
      if (!peek) { allValid = false; break; }
    }
    assert(allValid, "all non-corrupt listed crawls have valid peek data");
  }
  console.log();

  // ---------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------
  cleanup();
  setCrawlDir(null);

  // ---------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------
  const total = passed + failed;
  console.log(`\n=== ${passed} passed, ${failed} failed (${total} total) ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  cleanup();
  setCrawlDir(null);
  console.error("Test failed:", err);
  process.exit(1);
});
