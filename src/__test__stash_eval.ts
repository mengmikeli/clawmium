import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { CrawlManager, CrawlNode, CursorEntry, ReachedBy } from "./crawl/tree";
import { PageInterpretation, GoalContext } from "./llm/provider";
import {
  saveSession,
  loadSession,
  restoreManagerFromEnvelope,
  setSessionDir,
} from "./session/persistence";
import { saveCrawl, loadCrawl, setCrawlDir } from "./crawl/persistence";

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

const TEST_DIR = path.join(os.tmpdir(), `clm-stash-eval-${Date.now()}`);

function cleanup(): void {
  try {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  } catch { /* best effort */ }
}

function makeInterpretation(summary: string, pageType: "navigation" | "content" = "navigation"): PageInterpretation {
  return {
    pageType,
    summary,
    choices: [
      { index: 1, label: "Link A", action: "navigate", url: "https://a.com" },
      { index: 2, label: "Link B", action: "navigate", url: "https://b.com" },
    ],
    dataFound: null,
    requiresAuth: false,
    requiresHumanInput: false,
  };
}

function makeGoalContext(base: string, intent = "", breadcrumb: string[] = []): GoalContext {
  return { baseGoal: base, activeIntent: intent, breadcrumb: [...breadcrumb] };
}

async function main() {
  console.log("=== Stash Evaluation Suite — Cross-Domain Navigation ===\n");

  setSessionDir(TEST_DIR);
  setCrawlDir(TEST_DIR);

  // ---------------------------------------------------------------
  // TEST 1: HN -> Stratechery -> /back restores HN
  // ---------------------------------------------------------------
  console.log("--- Test 1: HN -> Stratechery -> /back restores HN ---\n");

  console.log("1. Cross-domain navigation with global cursor back triggers tree swap...");
  {
    const m = new CrawlManager();

    // Step 1: Browse HN — front page
    m.createCrawl("https://news.ycombinator.com", "Hacker News", "goto");
    const hnRootId = m.currentNodeId!;
    m.appendCursor(hnRootId, "goto");
    m.setNodeMetadata(hnRootId, {
      summary: "HN front page with 30 stories",
      interpretation: makeInterpretation("HN front page with 30 stories"),
      goalContext: makeGoalContext("browsing HN", "AI articles", ["front page"]),
    });

    // Step 2: Navigate to an article
    const hnArticle = m.addNavigation("https://news.ycombinator.com/item?id=99999", "Show HN: AI Agent Browser", "choice");
    m.appendCursor(hnArticle.id, "choice");
    m.setNodeMetadata(hnArticle.id, {
      summary: "Discussion about an AI-powered browser with 42 comments",
      interpretation: makeInterpretation("Discussion about an AI-powered browser with 42 comments", "content"),
      goalContext: makeGoalContext("browsing HN", "reading AI article", ["front page", "AI Agent Browser"]),
    });

    const hnCrawlId = m.activeCrawl!.id;

    // Step 3: pushStash (simulates /goto stratechery.com)
    m.pushStash();

    // Step 4: Create new crawl for Stratechery
    m.createCrawl("https://stratechery.com", "Stratechery", "goto");
    const stratRootId = m.currentNodeId!;
    m.appendCursor(stratRootId, "goto");
    m.setNodeMetadata(stratRootId, {
      summary: "Stratechery homepage with latest analysis",
      interpretation: makeInterpretation("Stratechery homepage with latest analysis"),
      goalContext: makeGoalContext("browsing stratechery.com"),
    });

    // Step 5: Verify full history spans both crawls (global cursor)
    const fullHistory = m.getFullCursorHistory();
    assert(fullHistory.length === 3, `full history has 3 entries (got ${fullHistory.length})`);
    assert(fullHistory[0].stashIndex === 0, "entry 0 is from stash (HN root)");
    assert(fullHistory[1].stashIndex === 0, "entry 1 is from stash (HN article)");
    assert(fullHistory[2].stashIndex === -1, "entry 2 is from active crawl (Stratechery)");

    // Step 6: getNodeAcrossStash finds HN article from Stratechery context
    const hnArticleNode = m.getNodeAcrossStash(hnArticle.id);
    assert(hnArticleNode !== null, "HN article found across stash");
    assert(hnArticleNode!.url === "https://news.ycombinator.com/item?id=99999", "HN article URL correct");

    // Step 7: Simulate /back — cursorBack returns HN article entry (cross-crawl)
    const backResult = m.cursorBack();
    assert(backResult !== null, "cursorBack returns HN article entry");
    assert(backResult!.nodeId === hnArticle.id, "cursorBack points to HN article");

    // Node is not in active crawl — need to swap
    const node = m.getNode(backResult!.nodeId);
    assert(node === null, "HN article not found in active (Stratechery) crawl");

    // findOwnerCrawl locates it in stash
    const owner = m.findOwnerCrawl(backResult!.nodeId);
    assert(owner !== null, "findOwnerCrawl finds the node");
    assert(owner!.stashIndex === 0, "node is in stash at index 0");

    // swapToStash makes HN active
    m.swapToStash(owner!.stashIndex);
    assert(m.activeCrawl!.id === hnCrawlId, "HN crawl is now active");
    assert(m.nodes.size === 2, "2 nodes restored (HN root + article)");
    assert(m.stash.length === 1, "Stratechery now in stash");

    // Verify metadata on restored node
    const restoredArticle = m.getNode(hnArticle.id)!;
    assert(restoredArticle.metadata?.summary === "Discussion about an AI-powered browser with 42 comments",
      "article summary restored");
    assert(restoredArticle.metadata?.interpretation?.pageType === "content", "interpretation restored");
    assert(restoredArticle.metadata?.goalContext?.baseGoal === "browsing HN", "goalContext baseGoal restored");
    assert(restoredArticle.metadata?.goalContext?.activeIntent === "reading AI article", "goalContext intent restored");

    // Step 8: cursorBack within HN crawl works (goes to HN root)
    const backToRoot = m.cursorBack();
    assert(backToRoot !== null, "cursorBack within HN works");
    assert(backToRoot!.nodeId === hnRootId, "back goes to HN front page");

    // Step 9: cursorForward goes back to article, then to Stratechery
    const fwdToArticle = m.cursorForward();
    assert(fwdToArticle !== null, "cursorForward works");
    assert(fwdToArticle!.nodeId === hnArticle.id, "forward goes back to article");

    const fwdToStrat = m.cursorForward();
    assert(fwdToStrat !== null, "cursorForward to Stratechery works");
    assert(fwdToStrat!.nodeId === stratRootId, "forward goes to Stratechery root");
  }
  console.log();

  // ---------------------------------------------------------------
  // TEST 2: Multiple cross-domain jumps, global cursor continuity
  // ---------------------------------------------------------------
  console.log("--- Test 2: Multiple cross-domain jumps, global cursor ---\n");

  console.log("2. Three crawls stacked, global cursor has all entries, back/forward work across boundaries...");
  {
    const m = new CrawlManager();

    // Crawl A (HN) — 2 pages
    m.createCrawl("https://news.ycombinator.com", "Hacker News", "goto");
    m.appendCursor(m.currentNodeId!, "goto");
    const hnArticle = m.addNavigation("https://news.ycombinator.com/item?id=111", "HN Article", "choice");
    m.appendCursor(hnArticle.id, "choice");
    m.pushStash();

    // Crawl B (BBC) — 2 pages
    m.createCrawl("https://bbc.com", "BBC News", "goto");
    m.appendCursor(m.currentNodeId!, "goto");
    const bbcArticle = m.addNavigation("https://bbc.com/news/tech-123", "BBC Tech Article", "choice");
    m.appendCursor(bbcArticle.id, "choice");
    m.pushStash();

    // Crawl C (Wikipedia) — 1 page
    m.createCrawl("https://en.wikipedia.org/wiki/Browser", "Wikipedia: Browser", "goto");
    m.appendCursor(m.currentNodeId!, "goto");

    // Verify stash state
    assert(m.stash.length === 2, "stash depth is 2");
    assert(m.activeCrawl!.name.length > 0, "active crawl (Wikipedia) has name");

    // Global cursor has all entries
    assert(m.cursorHistory.length === 5, `global cursor has 5 entries (got ${m.cursorHistory.length})`);

    // Full history annotated correctly
    const fullHistory = m.getFullCursorHistory();
    assert(fullHistory.length === 5, `full history has 5 entries (got ${fullHistory.length})`);

    // cursorBack from Wikipedia → BBC article (cross-crawl via global cursor)
    const back1 = m.cursorBack();
    assert(back1 !== null, "back from Wikipedia returns entry");
    assert(back1!.nodeId === bbcArticle.id, "back goes to BBC article");

    // cursorBack → BBC root
    const back2 = m.cursorBack();
    assert(back2 !== null, "second back returns entry");

    // cursorBack → HN article
    const back3 = m.cursorBack();
    assert(back3 !== null, "third back returns entry");
    assert(back3!.nodeId === hnArticle.id, "third back goes to HN article");

    // cursorBack → HN root
    const back4 = m.cursorBack();
    assert(back4 !== null, "fourth back returns entry");

    // cursorBack at start → null
    const noMoreBack = m.cursorBack();
    assert(noMoreBack === null, "cursorBack null at start of history");
  }
  console.log();

  // ---------------------------------------------------------------
  // TEST 3: Session resume with stash (v5 global cursor)
  // ---------------------------------------------------------------
  console.log("--- Test 3: Session resume with stash ---\n");

  console.log("3. Save session with stash, restore on fresh manager, global cursor intact...");
  {
    const m1 = new CrawlManager();

    // Create HN crawl with pages + metadata, stash it
    m1.createCrawl("https://news.ycombinator.com", "Hacker News", "goto");
    const hnRootId = m1.currentNodeId!;
    m1.appendCursor(hnRootId, "goto");
    m1.setNodeMetadata(hnRootId, {
      summary: "HN front page",
      interpretation: makeInterpretation("HN front page"),
      goalContext: makeGoalContext("browsing HN"),
    });
    const hnArticle = m1.addNavigation("https://news.ycombinator.com/item?id=555", "Interesting Article", "choice");
    m1.appendCursor(hnArticle.id, "choice");
    m1.setNodeMetadata(hnArticle.id, {
      summary: "Article about AI agents",
      interpretation: makeInterpretation("Article about AI agents", "content"),
      goalContext: makeGoalContext("browsing HN", "reading", ["front page", "AI agents"]),
    });
    m1.pushStash();

    // Create Stratechery crawl (active)
    m1.createCrawl("https://stratechery.com", "Stratechery", "goto");
    const stratRootId = m1.currentNodeId!;
    m1.appendCursor(stratRootId, "goto");
    m1.setNodeMetadata(stratRootId, {
      summary: "Stratechery home",
      interpretation: makeInterpretation("Stratechery home"),
      goalContext: makeGoalContext("browsing stratechery"),
    });

    // Global cursor has 3 entries (2 HN + 1 Stratechery)
    assert(m1.cursorHistory.length === 3, "global cursor has 3 entries before save");
    const fullHistoryBefore = m1.getFullCursorHistory();

    // Save session
    const filepath = saveSession({
      manager: m1,
      currentUrl: "https://stratechery.com",
      site: "stratechery",
      homeUrl: "",
      goalContext: makeGoalContext("browsing stratechery"),
      history: [{ role: "user", content: "browsing" }],
      log: [{ role: "user", content: "browsing", timestamp: Date.now() }],
    });
    assert(filepath !== null, "session saved");

    // Restore on fresh manager
    const envelope = loadSession(m1.activeCrawl!.id)!;
    assert(envelope.version === 5, "saved as v5 envelope");
    const m2 = new CrawlManager();
    restoreManagerFromEnvelope(envelope, m2);

    // Verify active crawl is Stratechery
    assert(m2.activeCrawl !== null, "active crawl restored");
    assert(m2.findNodeByUrl("https://stratechery.com") !== null, "Stratechery node present");
    assert(m2.nodes.size === 1, "active crawl has 1 node (Stratechery)");

    // Verify stash has HN
    assert(m2.stash.length === 1, "stash has 1 entry (HN)");
    assert(m2.stash[0].nodes.size === 2, "stashed HN has 2 nodes");

    // Global cursor preserved across save/restore
    assert(m2.cursorHistory.length === 3, "global cursor has 3 entries after restore");
    assert(m2.cursorIndex === 2, "cursorIndex at end after restore");

    // Pop stash — HN restored with correct metadata
    m2.popStash();
    assert(m2.activeCrawl !== null, "HN crawl restored from stash");
    assert(m2.nodes.size === 2, "2 HN nodes restored");
    const restoredArticle = m2.findNodeByUrl("https://news.ycombinator.com/item?id=555");
    assert(restoredArticle !== null, "HN article node found");
    assert(restoredArticle!.metadata?.summary === "Article about AI agents", "article metadata survived save/load/pop");

    // Full history on restored manager matches pre-save
    const m3 = new CrawlManager();
    restoreManagerFromEnvelope(envelope, m3);
    const fullHistoryAfter = m3.getFullCursorHistory();
    assert(fullHistoryAfter.length === fullHistoryBefore.length,
      `full history length matches pre-save (${fullHistoryAfter.length} vs ${fullHistoryBefore.length})`);
  }
  console.log();

  // ---------------------------------------------------------------
  // TEST 4: /clear crawl nukes everything
  // ---------------------------------------------------------------
  console.log("--- Test 4: /clear crawl nukes everything ---\n");

  console.log("4. clear() removes active crawl and all stashed crawls...");
  {
    const m = new CrawlManager();

    // Create and stash two crawls, keep a third active
    m.createCrawl("https://site-a.com", "Site A", "goto");
    m.appendCursor(m.currentNodeId!, "goto");
    m.pushStash();

    m.createCrawl("https://site-b.com", "Site B", "goto");
    m.appendCursor(m.currentNodeId!, "goto");
    m.pushStash();

    m.createCrawl("https://site-c.com", "Site C", "goto");
    m.appendCursor(m.currentNodeId!, "goto");

    assert(m.stash.length === 2, "stash has 2 entries before clear");
    assert(m.activeCrawl !== null, "active crawl exists before clear");

    // Clear everything
    m.clear();
    assert(m.activeCrawl === null, "activeCrawl null after clear");
    assert(m.stash.length === 0, "stash empty after clear");
    assert(m.nodes.size === 0, "nodes empty after clear");
    assert(m.cursorBack() === null, "cursorBack null after clear");
    assert(m.hasStash() === false, "hasStash false after clear");
    assert(m.cursorHistory.length === 0, "cursor history empty after clear");
  }
  console.log();

  // ---------------------------------------------------------------
  // TEST 5: /crawl end preserves stash
  // ---------------------------------------------------------------
  console.log("--- Test 5: /crawl end preserves stash ---\n");

  console.log("5. clearActive() ends current crawl but stash and cursor survive...");
  {
    const m = new CrawlManager();

    // Create HN crawl and stash it
    m.createCrawl("https://news.ycombinator.com", "Hacker News", "goto");
    const hnRootId = m.currentNodeId!;
    m.appendCursor(hnRootId, "goto");
    m.setNodeMetadata(hnRootId, {
      summary: "HN front page",
      interpretation: makeInterpretation("HN front page"),
    });
    m.pushStash();

    // Create Stratechery crawl (active)
    m.createCrawl("https://stratechery.com", "Stratechery", "goto");
    m.appendCursor(m.currentNodeId!, "goto");

    // Save the active crawl to disk before ending (simulates what REPL does)
    saveCrawl(m);

    // clearActive (simulates /crawl end)
    m.clearActive();
    assert(m.activeCrawl === null, "active crawl null after clearActive");
    assert(m.nodes.size === 0, "active nodes cleared");
    // Cursor is session-level — preserved after clearActive
    assert(m.cursorHistory.length === 2, "global cursor preserved after clearActive");

    // Stash survives!
    assert(m.hasStash() === true, "stash survives clearActive");
    assert(m.stash.length === 1, "stash has 1 entry");

    // Pop stash restores HN
    const restored = m.popStash();
    assert(restored !== null, "popStash returns HN crawl");
    assert(m.findNodeByUrl("https://news.ycombinator.com") !== null, "HN root found");
    assert(m.getNode(hnRootId)!.metadata?.summary === "HN front page", "HN metadata intact");
  }
  console.log();

  // ---------------------------------------------------------------
  // TEST 6: /crawl load stashes current
  // ---------------------------------------------------------------
  console.log("--- Test 6: /crawl load stashes current ---\n");

  console.log("6. Loading a saved crawl stashes current, global cursor preserved...");
  {
    const m = new CrawlManager();

    // Create crawl A, save to disk
    m.createCrawl("https://site-a.com", "Site A", "goto");
    m.appendCursor(m.currentNodeId!, "goto");
    const aPage = m.addNavigation("https://site-a.com/page1", "A Page 1", "choice");
    m.appendCursor(aPage.id, "choice");
    m.setNodeMetadata(aPage.id, {
      summary: "Page 1 of site A",
      interpretation: makeInterpretation("Page 1 of site A"),
    });
    saveCrawl(m);
    saveSession({
      manager: m,
      currentUrl: "https://site-a.com/page1",
      site: "site-a",
      homeUrl: "",
      goalContext: makeGoalContext("browsing site A"),
      history: [],
      log: [],
    });
    const crawlAId = m.activeCrawl!.id;

    // Create crawl B (active) — simulates a /goto to a new domain
    m.pushStash(); // stash A
    m.createCrawl("https://site-b.com", "Site B", "goto");
    m.appendCursor(m.currentNodeId!, "goto");
    const bPage = m.addNavigation("https://site-b.com/page1", "B Page 1", "choice");
    m.appendCursor(bPage.id, "choice");

    // Global cursor now has 4 entries (2 A + 2 B)
    assert(m.cursorHistory.length === 4, "global cursor has 4 entries before load");

    // Simulate /crawl load: stash B, save full state, loadCrawl, restore cursor+stash
    m.pushStash(); // stash B — stash now [A, B]
    const savedCursor = [...m.cursorHistory.map(e => ({ ...e }))];
    const savedCursorIndex = m.cursorIndex;
    const savedStash = [...m.stash]; // [A, B]

    // loadCrawl replaces everything on the manager
    loadCrawl(crawlAId, m);

    // Restore global cursor and stash
    m.cursorHistory = savedCursor;
    m.cursorIndex = savedCursorIndex;
    m.stash = [...savedStash, ...m.stash];

    // Active crawl is A (loaded from disk)
    assert(m.activeCrawl !== null, "active crawl loaded");
    assert(m.activeCrawl!.id === crawlAId, "active crawl is A");
    assert(m.findNodeByUrl("https://site-a.com") !== null, "A root present");
    assert(m.findNodeByUrl("https://site-a.com/page1") !== null, "A page1 present");

    // Stash has [original-A, B]
    assert(m.stash.length === 2, `stash has 2 entries (got ${m.stash.length})`);

    // Global cursor preserved
    assert(m.cursorHistory.length === 4, "global cursor preserved at 4 entries");

    // Pop stash — should get B (LIFO: B was pushed last)
    m.popStash();
    assert(m.findNodeByUrl("https://site-b.com") !== null, "B root found after pop");
    assert(m.findNodeByUrl("https://site-b.com/page1") !== null, "B page1 found after pop");

    // Pop again — should get original A
    m.popStash();
    assert(m.findNodeByUrl("https://site-a.com") !== null, "original A found after second pop");
  }
  console.log();

  // ---------------------------------------------------------------
  // TEST 7: /history N jump to stashed entry
  // ---------------------------------------------------------------
  console.log("--- Test 7: /history N jump to stashed entry ---\n");

  console.log("7. Full cursor history shows entries from stashed crawls, jump across boundary...");
  {
    const m = new CrawlManager();

    // Crawl A — 2 pages
    m.createCrawl("https://site-a.com", "Site A", "goto");
    const aRoot = m.currentNodeId!;
    m.appendCursor(aRoot, "goto");
    const aPage2 = m.addNavigation("https://site-a.com/page2", "A Page 2", "choice");
    m.appendCursor(aPage2.id, "choice");
    m.setNodeMetadata(aRoot, { summary: "A root" });
    m.setNodeMetadata(aPage2.id, { summary: "A page 2" });
    m.pushStash();

    // Crawl B — 1 page
    m.createCrawl("https://site-b.com", "Site B", "goto");
    const bRoot = m.currentNodeId!;
    m.appendCursor(bRoot, "goto");
    m.setNodeMetadata(bRoot, { summary: "B root" });

    // Full history should have 3 entries (global cursor)
    const full = m.getFullCursorHistory();
    assert(full.length === 3, `full history has 3 entries (got ${full.length})`);
    assert(full[0].stashIndex === 0, "entry 0 from stash (A root)");
    assert(full[1].stashIndex === 0, "entry 1 from stash (A page 2)");
    assert(full[2].stashIndex === -1, "entry 2 from active (B root)");

    // Verify crawl attribution on entries
    assert(full[0].crawlName !== undefined && full[0].crawlName.length > 0, "stash entry has crawlName");
    assert(full[0].crawlId !== undefined && full[0].crawlId.length > 0, "stash entry has crawlId");

    // Jump to entry 0 (A root) using cursorJump + swapToStash
    m.cursorJump(0);
    assert(m.cursorIndex === 0, "cursor jumped to index 0");

    // Node is in stash — find owner and swap
    const entry = m.cursorHistory[0];
    const owner = m.findOwnerCrawl(entry.nodeId);
    assert(owner !== null, "findOwnerCrawl found the node");
    assert(owner!.stashIndex === 0, "node is in stash[0]");

    m.swapToStash(owner!.stashIndex);

    // Verify state after swap
    assert(m.activeCrawl !== null, "active crawl is A");
    assert(m.findNodeByUrl("https://site-a.com") !== null, "A root present");
    assert(m.cursorIndex === 0, "cursor at position 0 (A root)");
    assert(m.stash.length === 1, "stash has 1 entry (B)");
    assert(m.stash[0].nodes.get(bRoot) !== undefined, "B root in stash");
  }
  console.log();

  // ---------------------------------------------------------------
  // TEST 8: Goal context and site restoration on stash pop
  // ---------------------------------------------------------------
  console.log("--- Test 8: Goal context and site restoration on stash pop ---\n");

  console.log("8. Stash pop restores the correct goal context and interpretation per crawl...");
  {
    const m = new CrawlManager();

    // HN crawl with specific goal context
    m.createCrawl("https://news.ycombinator.com", "Hacker News", "goto");
    const hnRootId = m.currentNodeId!;
    m.appendCursor(hnRootId, "goto");
    const hnGoal = makeGoalContext("browsing HN", "AI articles", ["front page"]);
    const hnInterp = makeInterpretation("HN front page with 30 stories");
    m.setNodeMetadata(hnRootId, {
      summary: "HN front page with 30 stories",
      interpretation: hnInterp,
      goalContext: hnGoal,
    });

    const hnArticle = m.addNavigation("https://news.ycombinator.com/item?id=777", "AI Research Paper", "choice");
    m.appendCursor(hnArticle.id, "choice");
    const hnArticleGoal = makeGoalContext("browsing HN", "reading AI research", ["front page", "AI Research Paper"]);
    const hnArticleInterp = makeInterpretation("Discussion of a new AI research paper", "content");
    m.setNodeMetadata(hnArticle.id, {
      summary: "Discussion of a new AI research paper",
      interpretation: hnArticleInterp,
      goalContext: hnArticleGoal,
    });

    // Stash HN
    m.pushStash();

    // Stratechery crawl with different goal context
    m.createCrawl("https://stratechery.com", "Stratechery", "goto");
    const stratRootId = m.currentNodeId!;
    m.appendCursor(stratRootId, "goto");
    const stratGoal = makeGoalContext("browsing stratechery.com", "tech analysis", ["homepage"]);
    const stratInterp = makeInterpretation("Stratechery — latest analysis on tech industry");
    m.setNodeMetadata(stratRootId, {
      summary: "Stratechery — latest analysis on tech industry",
      interpretation: stratInterp,
      goalContext: stratGoal,
    });

    // Verify Stratechery context is active
    const stratNode = m.getNode(stratRootId)!;
    assert(stratNode.metadata?.goalContext?.baseGoal === "browsing stratechery.com",
      "Stratechery goal is active before pop");

    // Pop stash — should restore HN
    m.popStash();

    // Verify HN goal context on the restored node (cursor was at article)
    const restoredArticle = m.getNode(hnArticle.id)!;
    assert(restoredArticle.metadata?.goalContext?.baseGoal === "browsing HN",
      "HN baseGoal restored (not Stratechery's)");
    assert(restoredArticle.metadata?.goalContext?.activeIntent === "reading AI research",
      "HN activeIntent restored");
    assert(restoredArticle.metadata?.goalContext?.breadcrumb.length === 2,
      "HN breadcrumb length restored");
    assert(restoredArticle.metadata?.goalContext?.breadcrumb[1] === "AI Research Paper",
      "HN breadcrumb content restored");

    // Verify interpretation
    assert(restoredArticle.metadata?.interpretation?.pageType === "content",
      "HN article interpretation pageType restored");
    assert(restoredArticle.metadata?.interpretation?.summary === "Discussion of a new AI research paper",
      "HN article interpretation summary restored");

    // Also verify root node metadata
    const restoredRoot = m.getNode(hnRootId)!;
    assert(restoredRoot.metadata?.goalContext?.baseGoal === "browsing HN",
      "HN root goalContext restored");
    assert(restoredRoot.metadata?.interpretation?.summary === "HN front page with 30 stories",
      "HN root interpretation restored");
  }
  console.log();

  // ---------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------
  cleanup();
  setSessionDir(null);
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
  setSessionDir(null);
  setCrawlDir(null);
  console.error("Test failed:", err);
  process.exit(1);
});
