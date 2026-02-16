import { CrawlManager } from "./crawl/tree";
import { deriveCrawlName } from "./crawl/namer";
import { formatAncestorContext, breadcrumbFromTree } from "./crawl/context";
import { formatGoalWithCrawl, formatGoal, addBreadcrumb } from "./cli/goals";
import { GoalContext } from "./llm/provider";

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

async function main() {
  console.log("=== Crawl Phase 3: LLM Integration Test Suite ===\n");

  // ---------------------------------------------------------------
  // GROUP 1: deriveCrawlName (5 tests)
  // ---------------------------------------------------------------
  console.log("--- deriveCrawlName ---\n");

  console.log("1. specific goal — uses baseGoal directly...");
  {
    const name = deriveCrawlName("https://example.com", "Some summary.", "check my water bill");
    assert(name === "check my water bill", `expected 'check my water bill', got '${name}'`);
  }
  console.log();

  console.log("2. auto goal + summary — uses first clause of summary...");
  {
    const name = deriveCrawlName("https://news.ycombinator.com", "Hacker News is a social news website, focusing on computer science.", "browsing news.ycombinator.com");
    assert(name === "hacker News is a social news website", `expected first clause lowercased, got '${name}'`);
  }
  console.log();

  console.log("3. long summary — caps at 50 chars...");
  {
    const name = deriveCrawlName("https://example.com", "This is a very long summary that goes on and on and on and keeps going forever.", "browsing example.com");
    assert(name.length <= 50, `name length ${name.length} <= 50`);
  }
  console.log();

  console.log("4. empty summary — falls back to hostname + date...");
  {
    const name = deriveCrawlName("https://news.ycombinator.com", "", "browsing news.ycombinator.com");
    assert(name.startsWith("news.ycombinator.com"), `starts with hostname, got '${name}'`);
    assert(/\d{4}-\d{2}-\d{2}/.test(name), `contains date, got '${name}'`);
  }
  console.log();

  console.log("5. invalid URL fallback...");
  {
    const name = deriveCrawlName("not-a-url", "", "browsing something");
    assert(name.startsWith("crawl "), `starts with 'crawl ', got '${name}'`);
    assert(/\d{4}-\d{2}-\d{2}/.test(name), `contains date, got '${name}'`);
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 2: formatAncestorContext (5 tests)
  // ---------------------------------------------------------------
  console.log("--- formatAncestorContext ---\n");

  console.log("6. no crawl — returns empty string...");
  {
    const m = new CrawlManager();
    const ctx = formatAncestorContext(m);
    assert(ctx === "", `expected empty string, got '${ctx}'`);
  }
  console.log();

  console.log("7. single node — returns empty string (no navigation path yet)...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Example", "goto");
    const ctx = formatAncestorContext(m);
    assert(ctx === "", `expected empty string for single node, got '${ctx}'`);
  }
  console.log();

  console.log("8. 2 nodes — shows root and current page...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://hn.com", "HN Front Page", "goto");
    m.setNodeMetadata(m.currentNodeId!, { summary: "Top stories on HN today." });
    m.addNavigation("https://hn.com/item?id=1", "Show HN: Project", "choice");
    const ctx = formatAncestorContext(m);
    assert(ctx.includes("Navigation path:"), `has header, got '${ctx}'`);
    assert(ctx.includes('"HN Front Page"'), `includes root title`);
    assert(ctx.includes('"Show HN: Project"'), `includes current page title`);
    assert(ctx.includes("(current page)"), `marks current page`);
    assert(ctx.includes("Top stories on HN today"), `includes root summary`);
  }
  console.log();

  console.log("9. 4 nodes — caps at 3 ancestors (default)...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://a.com", "A", "goto");
    m.addNavigation("https://b.com", "B", "choice");
    m.addNavigation("https://c.com", "C", "choice");
    m.addNavigation("https://d.com", "D", "choice");
    const ctx = formatAncestorContext(m);
    // Should show B, C, D (last 3), not A
    assert(!ctx.includes('"A"'), `A excluded (only last 3)`);
    assert(ctx.includes('"B"'), `B included`);
    assert(ctx.includes('"C"'), `C included`);
    assert(ctx.includes('"D"'), `D included`);
  }
  console.log();

  console.log("10. node with summary shows summary clause...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://root.com", "Root Page", "goto");
    m.setNodeMetadata(m.currentNodeId!, { summary: "This is the root page. It has lots of content." });
    m.addNavigation("https://child.com", "Child Page", "choice");
    const ctx = formatAncestorContext(m);
    assert(ctx.includes("This is the root page"), `summary clause for root`);
    assert(!ctx.includes("It has lots of content"), `only first sentence`);
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 3: breadcrumbFromTree (4 tests)
  // ---------------------------------------------------------------
  console.log("--- breadcrumbFromTree ---\n");

  console.log("11. no crawl — returns empty array...");
  {
    const m = new CrawlManager();
    const bc = breadcrumbFromTree(m);
    assert(bc.length === 0, `expected empty array, got ${bc.length}`);
  }
  console.log();

  console.log("12. single node — returns empty array...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://a.com", "A", "goto");
    const bc = breadcrumbFromTree(m);
    assert(bc.length === 0, `expected empty array for single node, got ${bc.length}`);
  }
  console.log();

  console.log("13. 3 nodes — returns first 2 titles (excludes current)...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://a.com", "A", "goto");
    m.addNavigation("https://b.com", "B", "choice");
    m.addNavigation("https://c.com", "C", "choice");
    const bc = breadcrumbFromTree(m);
    assert(bc.length === 2, `expected 2, got ${bc.length}`);
    assert(bc[0] === "A", `first is A, got '${bc[0]}'`);
    assert(bc[1] === "B", `second is B, got '${bc[1]}'`);
  }
  console.log();

  console.log("14. 5 nodes — caps at 3 (last 3 excluding current)...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://a.com", "A", "goto");
    m.addNavigation("https://b.com", "B", "choice");
    m.addNavigation("https://c.com", "C", "choice");
    m.addNavigation("https://d.com", "D", "choice");
    m.addNavigation("https://e.com", "E", "choice");
    const bc = breadcrumbFromTree(m);
    assert(bc.length === 3, `expected 3, got ${bc.length}`);
    assert(bc[0] === "B", `first is B, got '${bc[0]}'`);
    assert(bc[1] === "C", `second is C, got '${bc[1]}'`);
    assert(bc[2] === "D", `third is D, got '${bc[2]}'`);
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 4: formatGoalWithCrawl (4 tests)
  // ---------------------------------------------------------------
  console.log("--- formatGoalWithCrawl ---\n");

  console.log("15. with active crawl — uses tree breadcrumb...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://hn.com", "HN Front Page", "goto");
    m.addNavigation("https://hn.com/item?id=1", "AI Article", "choice");
    const gc: GoalContext = { baseGoal: "browsing hn.com", activeIntent: "reading about AI", breadcrumb: ["manual crumb"] };
    const goal = formatGoalWithCrawl(gc, m);
    assert(goal.includes("path: HN Front Page"), `uses tree breadcrumb, got '${goal}'`);
    assert(!goal.includes("manual crumb"), `does NOT use manual breadcrumb`);
    assert(goal.includes("currently: reading about AI"), `includes activeIntent`);
  }
  console.log();

  console.log("16. without active crawl — falls back to GoalContext.breadcrumb...");
  {
    const m = new CrawlManager();
    const gc: GoalContext = { baseGoal: "browsing example.com", activeIntent: "", breadcrumb: ["Page A", "Page B"] };
    const goal = formatGoalWithCrawl(gc, m);
    assert(goal.includes("path: Page A \u2192 Page B"), `uses gc.breadcrumb, got '${goal}'`);
  }
  console.log();

  console.log("17. with active crawl + no ancestors — no path in output...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://a.com", "A", "goto");
    const gc: GoalContext = { baseGoal: "browsing a.com", activeIntent: "", breadcrumb: [] };
    const goal = formatGoalWithCrawl(gc, m);
    assert(!goal.includes("path:"), `no path when only root, got '${goal}'`);
    assert(goal === "browsing a.com", `just base goal, got '${goal}'`);
  }
  console.log();

  console.log("18. formatGoal unchanged — still works without crawl manager...");
  {
    const gc: GoalContext = { baseGoal: "test goal", activeIntent: "searching", breadcrumb: ["step1"] };
    const goal = formatGoal(gc);
    assert(goal === "test goal \u2014 currently: searching (path: step1)", `formatGoal works, got '${goal}'`);
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 5: setNodeMetadata + appendConversationSnippet (4 tests)
  // ---------------------------------------------------------------
  console.log("--- setNodeMetadata + appendConversationSnippet ---\n");

  console.log("19. setNodeMetadata — sets summary on node...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Example", "goto");
    m.setNodeMetadata(m.currentNodeId!, { summary: "A great page about examples." });
    const node = m.getNode(m.currentNodeId!)!;
    assert(node.metadata?.summary === "A great page about examples.", `summary set correctly`);
  }
  console.log();

  console.log("20. appendConversationSnippet — appends and caps at maxSnippets...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Example", "goto");
    for (let i = 0; i < 7; i++) {
      m.appendConversationSnippet(m.currentNodeId!, `snippet ${i}`);
    }
    const node = m.getNode(m.currentNodeId!)!;
    assert(node.metadata?.conversationSnippets?.length === 5, `capped at 5, got ${node.metadata?.conversationSnippets?.length}`);
    assert(node.metadata!.conversationSnippets![0] === "snippet 2", `oldest is snippet 2 (first 2 shifted off)`);
    assert(node.metadata!.conversationSnippets![4] === "snippet 6", `newest is snippet 6`);
  }
  console.log();

  console.log("21. appendConversationSnippet — truncates long snippets...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Example", "goto");
    const longSnippet = "A".repeat(200);
    m.appendConversationSnippet(m.currentNodeId!, longSnippet);
    const node = m.getNode(m.currentNodeId!)!;
    assert(node.metadata!.conversationSnippets![0].length === 120, `truncated to 120 chars, got ${node.metadata!.conversationSnippets![0].length}`);
    assert(node.metadata!.conversationSnippets![0].endsWith("..."), `ends with '...'`);
  }
  console.log();

  console.log("22. setNodeMetadata — non-existent node is no-op...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Example", "goto");
    m.setNodeMetadata("nonexistent-id", { summary: "won't crash" });
    // Should not throw
    assert(true, "setNodeMetadata on invalid ID is a no-op");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 6: maybeNameCrawl pattern (4 tests)
  // ---------------------------------------------------------------
  console.log("--- maybeNameCrawl pattern ---\n");

  console.log("23. default timestamp name replaced by derived name...");
  {
    const m = new CrawlManager();
    const crawl = m.createCrawl("https://example.com", "Example", "goto");
    assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(crawl.name), `default name is timestamp`);

    // Simulate maybeNameCrawl logic
    const rootNode = m.nodes.get(crawl.rootId)!;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(crawl.name)) {
      crawl.name = deriveCrawlName(rootNode.url, "This page has cool content.", "browsing example.com");
    }
    assert(crawl.name === "this page has cool content", `name derived from summary, got '${crawl.name}'`);
  }
  console.log();

  console.log("24. non-default name preserved (already named)...");
  {
    const m = new CrawlManager();
    const crawl = m.createCrawl("https://example.com", "Example", "goto");
    crawl.name = "my custom name";
    // maybeNameCrawl pattern: regex won't match, so name unchanged
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(crawl.name)) {
      crawl.name = deriveCrawlName("https://example.com", "New summary.", "browsing example.com");
    }
    assert(crawl.name === "my custom name", `custom name preserved, got '${crawl.name}'`);
  }
  console.log();

  console.log("25. specific goal used for naming...");
  {
    const m = new CrawlManager();
    const crawl = m.createCrawl("https://cityserve.com", "CityServe", "goto");
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(crawl.name)) {
      crawl.name = deriveCrawlName("https://cityserve.com", "Welcome to CityServe.", "check my water bill");
    }
    assert(crawl.name === "check my water bill", `specific goal used, got '${crawl.name}'`);
  }
  console.log();

  console.log("26. empty-page summary triggers hostname fallback...");
  {
    const name = deriveCrawlName("https://news.ycombinator.com", "Page content is empty (possible anti-bot protection)", "browsing news.ycombinator.com");
    assert(name.startsWith("news.ycombinator.com"), `hostname fallback, got '${name}'`);
  }
  console.log();

  // ---------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------
  const total = passed + failed;
  console.log(`=== ${passed} passed, ${failed} failed (${total} total) ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
