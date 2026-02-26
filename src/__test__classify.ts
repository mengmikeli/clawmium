import { CrawlManager, CrawlNode, CursorEntry } from "./crawl/tree";
import {
  classifyNodeHeuristic,
  classifyCrawlHeuristic,
  extractKeywords,
  defaultCrawlMeta,
  CrawlMeta,
  NodeClassification,
  ClassificationResult,
} from "./crawl/classify";

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

function makeNode(overrides: Partial<CrawlNode> & { id: string; url: string }): CrawlNode {
  return {
    title: "Test Page",
    timestamp: Date.now(),
    parentId: null,
    reachedBy: "goto",
    children: [],
    ...overrides,
  };
}

async function main() {
  console.log("=== Classification Test Suite ===\n");

  // ---------------------------------------------------------------
  // GROUP 1: Node classification (18 tests)
  // ---------------------------------------------------------------
  console.log("--- Node classification ---\n");

  console.log("1. Live node — default...");
  {
    const node = makeNode({ id: "n1", url: "https://example.com" });
    node.metadata = { summary: "A normal page" };
    const nodes = new Map([["n1", node]]);
    const result = classifyNodeHeuristic(node, nodes, []);
    assert(result.status === "live", "default node is live");
    assert(result.deadReason === undefined, "no dead reason");
  }
  console.log();

  console.log("2. Dead node — HTTP 404 via httpStatus...");
  {
    const node = makeNode({ id: "n1", url: "https://example.com/missing" });
    node.metadata = { httpStatus: 404 };
    const nodes = new Map([["n1", node]]);
    const result = classifyNodeHeuristic(node, nodes, []);
    assert(result.status === "dead", "node is dead");
    assert(result.deadReason === "404", "dead reason is 404");
  }
  console.log();

  console.log("3. Dead node — HTTP 500 via httpStatus...");
  {
    const node = makeNode({ id: "n1", url: "https://example.com/error" });
    node.metadata = { httpStatus: 500 };
    const nodes = new Map([["n1", node]]);
    const result = classifyNodeHeuristic(node, nodes, []);
    assert(result.status === "dead", "node is dead for 500");
    assert(result.deadReason === "404", "dead reason is 404 (covers all >= 400)");
  }
  console.log();

  console.log("4. Dead node — error in summary (could not reach)...");
  {
    const node = makeNode({ id: "n1", url: "https://example.com" });
    node.metadata = { summary: "could not reach https://example.com — site may be down" };
    const nodes = new Map([["n1", node]]);
    const result = classifyNodeHeuristic(node, nodes, []);
    assert(result.status === "dead", "node is dead");
    assert(result.deadReason === "error", "dead reason is error");
  }
  console.log();

  console.log("5. Dead node — error in summary (returned HTTP)...");
  {
    const node = makeNode({ id: "n1", url: "https://example.com" });
    node.metadata = { summary: "returned HTTP 403 — access denied" };
    const nodes = new Map([["n1", node]]);
    const result = classifyNodeHeuristic(node, nodes, []);
    assert(result.status === "dead", "node is dead");
    assert(result.deadReason === "error", "dead reason is error");
  }
  console.log();

  console.log("6. Dead node — empty content...");
  {
    const node = makeNode({ id: "n1", url: "https://example.com" });
    node.metadata = { summary: "content is empty" };
    const nodes = new Map([["n1", node]]);
    const result = classifyNodeHeuristic(node, nodes, []);
    assert(result.status === "dead", "node is dead");
    assert(result.deadReason === "empty", "dead reason is empty");
  }
  console.log();

  console.log("7. Dead node — immediate back (leaf, visit then back within 5s)...");
  {
    const now = Date.now();
    const node = makeNode({ id: "n1", url: "https://example.com/page", children: [] });
    node.metadata = { summary: "some content" };
    const parentNode = makeNode({ id: "n0", url: "https://example.com", children: ["n1"] });
    const nodes = new Map([["n0", parentNode], ["n1", node]]);
    const cursor: CursorEntry[] = [
      { nodeId: "n0", timestamp: now - 10000, reachedBy: "goto" },
      { nodeId: "n1", timestamp: now - 3000, reachedBy: "choice" },
      { nodeId: "n0", timestamp: now - 1000, reachedBy: "back" },
    ];
    const result = classifyNodeHeuristic(node, nodes, cursor);
    assert(result.status === "dead", "node is dead from immediate back");
    assert(result.deadReason === "immediate_back", "dead reason is immediate_back");
  }
  console.log();

  console.log("8. NOT immediate back — back after 10s...");
  {
    const now = Date.now();
    const node = makeNode({ id: "n1", url: "https://example.com/page", children: [] });
    node.metadata = { summary: "some content" };
    const parentNode = makeNode({ id: "n0", url: "https://example.com", children: ["n1"] });
    const nodes = new Map([["n0", parentNode], ["n1", node]]);
    const cursor: CursorEntry[] = [
      { nodeId: "n0", timestamp: now - 20000, reachedBy: "goto" },
      { nodeId: "n1", timestamp: now - 15000, reachedBy: "choice" },
      { nodeId: "n0", timestamp: now - 4000, reachedBy: "back" },
    ];
    const result = classifyNodeHeuristic(node, nodes, cursor);
    assert(result.status === "live", "node is live when back is slow");
  }
  console.log();

  console.log("9. Dead node — abandoned leaf (no summary, >1h old)...");
  {
    const node = makeNode({ id: "n1", url: "https://example.com/page", children: [] });
    node.timestamp = Date.now() - 7200000; // 2h ago
    // No metadata at all
    const nodes = new Map([["n1", node]]);
    const result = classifyNodeHeuristic(node, nodes, []);
    assert(result.status === "dead", "node is dead from abandonment");
    assert(result.deadReason === "abandoned", "dead reason is abandoned");
  }
  console.log();

  console.log("10. NOT abandoned — has summary...");
  {
    const node = makeNode({ id: "n1", url: "https://example.com/page", children: [] });
    node.timestamp = Date.now() - 7200000;
    node.metadata = { summary: "A page with content" };
    const nodes = new Map([["n1", node]]);
    const result = classifyNodeHeuristic(node, nodes, []);
    assert(result.status === "live", "node is live when it has summary");
  }
  console.log();

  console.log("11. NOT abandoned — non-leaf node...");
  {
    const node = makeNode({ id: "n1", url: "https://example.com", children: ["n2"] });
    node.timestamp = Date.now() - 7200000;
    const child = makeNode({ id: "n2", url: "https://example.com/page", parentId: "n1" });
    const nodes = new Map([["n1", node], ["n2", child]]);
    const result = classifyNodeHeuristic(node, nodes, []);
    assert(result.status === "live", "non-leaf is live even if old and no summary");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 2: Crawl lifecycle classification (16 tests)
  // ---------------------------------------------------------------
  console.log("--- Crawl lifecycle classification ---\n");

  console.log("12. Default — open lifecycle...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      sessionDurationMs: 60000,
    });
    assert(result.lifecycle === "open", "default lifecycle is open");
    assert(result.confidence >= 0.7, "confidence is >= 0.7");
  }
  console.log();

  console.log("13. Done — confirmation page in tree...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    const node = m.addNavigation("https://example.com/confirm", "Confirm", "choice");
    m.setNodeMetadata(node.id, {
      interpretation: {
        pageType: "confirmation",
        summary: "Your payment has been processed",
        choices: [],
        dataFound: null,
        requiresAuth: false,
        requiresHumanInput: false,
      },
    });
    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      sessionDurationMs: 120000,
    });
    assert(result.lifecycle === "done", "lifecycle is done with confirmation");
    assert(result.lifecycleReason.includes("confirmation"), "reason mentions confirmation");
    assert(result.confidence >= 0.8, "high confidence for confirmation");
  }
  console.log();

  console.log("14. Done — data extracted...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    const node = m.addNavigation("https://example.com/data", "Data", "choice");
    m.setNodeMetadata(node.id, {
      interpretation: {
        pageType: "data",
        summary: "Account balance",
        choices: [],
        dataFound: { balance: "$150.00" },
        requiresAuth: false,
        requiresHumanInput: false,
      },
    });
    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      sessionDurationMs: 60000,
    });
    assert(result.lifecycle === "done", "lifecycle is done with data extraction");
    assert(result.lifecycleReason.includes("data"), "reason mentions data");
  }
  console.log();

  console.log("15. Overdue — old crawl, explicit goal, no recent activity...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    // Make it 25h old, session ended 25h ago
    m.activeCrawl!.created = Date.now() - 26 * 3600000;
    m.activeCrawl!.lastAccessed = Date.now() - 25 * 3600000;
    // Root node was created at session start, well before the last 10 min of session
    const root = m.getNode(m.currentNodeId!)!;
    root.timestamp = Date.now() - 26 * 3600000;

    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      goalContext: { baseGoal: "check my water bill", activeIntent: "", breadcrumb: [] },
      sessionDurationMs: 300000,
    });
    assert(result.lifecycle === "overdue", "lifecycle is overdue");
    assert(result.lifecycleReason.includes("24h"), "reason mentions 24h");
  }
  console.log();

  console.log("16. NOT overdue — generic goal (browsing X)...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.activeCrawl!.created = Date.now() - 25 * 3600000;
    m.activeCrawl!.lastAccessed = Date.now() - 25 * 3600000;
    const root = m.getNode(m.currentNodeId!)!;
    root.timestamp = Date.now() - 25 * 3600000;

    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      goalContext: { baseGoal: "browsing example.com", activeIntent: "", breadcrumb: [] },
      sessionDurationMs: 300000,
    });
    assert(result.lifecycle !== "overdue", "not overdue for generic goal");
  }
  console.log();

  console.log("17. Stale — lastAccessed > 48h ago...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.activeCrawl!.lastAccessed = Date.now() - 49 * 3600000;
    m.activeCrawl!.created = Date.now() - 50 * 3600000;
    const root = m.getNode(m.currentNodeId!)!;
    root.timestamp = Date.now() - 50 * 3600000;

    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      sessionDurationMs: 60000,
    });
    assert(result.lifecycle === "stale", "lifecycle is stale");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 3: Crawl tags (14 tests)
  // ---------------------------------------------------------------
  console.log("--- Crawl tags ---\n");

  console.log("18. Tag: lookup — ≤3 nodes, <2min...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.addNavigation("https://example.com/page", "Page", "choice");

    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      sessionDurationMs: 90000, // 1.5 min
    });
    assert(result.tags.includes("lookup"), "tagged as lookup");
  }
  console.log();

  console.log("19. NOT lookup — >3 nodes...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.addNavigation("https://example.com/p1", "P1", "choice");
    m.addNavigation("https://example.com/p2", "P2", "choice");
    m.addNavigation("https://example.com/p3", "P3", "choice");

    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      sessionDurationMs: 90000,
    });
    assert(!result.tags.includes("lookup"), "not tagged as lookup with 4 nodes");
  }
  console.log();

  console.log("20. Tag: task — explicit goal...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");

    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      goalContext: { baseGoal: "check my water bill", activeIntent: "", breadcrumb: [] },
      sessionDurationMs: 300000,
    });
    assert(result.tags.includes("task"), "tagged as task");
  }
  console.log();

  console.log("21. NOT task — generic browsing goal...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");

    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      goalContext: { baseGoal: "browsing example.com", activeIntent: "", breadcrumb: [] },
      sessionDurationMs: 300000,
    });
    assert(!result.tags.includes("task"), "not tagged as task for generic goal");
  }
  console.log();

  console.log("22. Tag: research — ≥5 nodes, depth ≥ 3...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    const rootId = m.currentNodeId!;
    // Build a deep tree: root -> p1 -> p2 -> p3 -> p4
    const n1 = m.addNavigation("https://example.com/p1", "P1", "choice");
    const n2 = m.addNavigation("https://example.com/p2", "P2", "choice");
    const n3 = m.addNavigation("https://example.com/p3", "P3", "choice");
    const n4 = m.addNavigation("https://example.com/p4", "P4", "choice");

    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      sessionDurationMs: 600000,
    });
    assert(result.tags.includes("research"), "tagged as research");
  }
  console.log();

  console.log("23. NOT research — shallow tree...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    // Add 5 children at depth 1 (flat)
    m.addNavigation("https://example.com/p1", "P1", "choice");
    m.navigateToNode(m.activeCrawl!.rootId);
    m.addNavigation("https://example.com/p2", "P2", "choice");
    m.navigateToNode(m.activeCrawl!.rootId);
    m.addNavigation("https://example.com/p3", "P3", "choice");
    m.navigateToNode(m.activeCrawl!.rootId);
    m.addNavigation("https://example.com/p4", "P4", "choice");
    m.navigateToNode(m.activeCrawl!.rootId);
    m.addNavigation("https://example.com/p5", "P5", "choice");

    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      sessionDurationMs: 600000,
    });
    // depth is 1, not >= 3, so no research tag
    assert(!result.tags.includes("research"), "not tagged as research for shallow tree");
  }
  console.log();

  console.log("24. Tag: exploration — generic browsing with ≥3 nodes...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://hn.com", "Root", "goto");
    m.addNavigation("https://hn.com/p1", "P1", "choice");
    m.addNavigation("https://hn.com/p2", "P2", "choice");

    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      goalContext: { baseGoal: "browsing hn.com", activeIntent: "", breadcrumb: [] },
      sessionDurationMs: 300000,
    });
    assert(result.tags.includes("exploration"), "tagged as exploration");
  }
  console.log();

  console.log("25. Tag: sensitive — URL with billing path...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.addNavigation("https://example.com/billing/invoices", "Billing", "choice");

    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      sessionDurationMs: 300000,
    });
    assert(result.tags.includes("sensitive"), "tagged as sensitive");
    assert(result.sensitive === true, "sensitive flag is true");
  }
  console.log();

  console.log("26. Tag: sensitive — URL with payment path...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://shop.com", "Root", "goto");
    m.addNavigation("https://shop.com/checkout/payment", "Payment", "choice");

    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      sessionDurationMs: 300000,
    });
    assert(result.sensitive === true, "sensitive for payment URL");
  }
  console.log();

  console.log("27. NOT sensitive — normal URLs...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://news.com", "Root", "goto");
    m.addNavigation("https://news.com/articles/123", "Article", "choice");

    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      sessionDurationMs: 300000,
    });
    assert(result.sensitive === false, "not sensitive for normal URLs");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 4: Noise detection (4 tests)
  // ---------------------------------------------------------------
  console.log("--- Noise detection ---\n");

  console.log("28. Noise — ≤2 nodes, <30s, no summary on root...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    // No summary on root
    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      sessionDurationMs: 15000, // 15s
    });
    assert(result.noise === true, "detected as noise");
  }
  console.log();

  console.log("29. NOT noise — has summary on root...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.setNodeMetadata(m.currentNodeId!, { summary: "A useful page" });
    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      sessionDurationMs: 15000,
    });
    assert(result.noise === false, "not noise when root has summary");
  }
  console.log();

  console.log("30. NOT noise — session >30s...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      sessionDurationMs: 60000, // 1 min
    });
    assert(result.noise === false, "not noise when session >30s");
  }
  console.log();

  console.log("31. NOT noise — >2 nodes...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.addNavigation("https://example.com/p1", "P1", "choice");
    m.addNavigation("https://example.com/p2", "P2", "choice");
    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      sessionDurationMs: 15000,
    });
    assert(result.noise === false, "not noise when >2 nodes");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 5: CrawlManager new methods (10 tests)
  // ---------------------------------------------------------------
  console.log("--- CrawlManager new methods ---\n");

  console.log("32. getLeafNodes...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.addNavigation("https://example.com/p1", "P1", "choice");
    m.navigateToNode(m.activeCrawl!.rootId);
    m.addNavigation("https://example.com/p2", "P2", "choice");
    const leaves = m.getLeafNodes();
    assert(leaves.length === 2, "two leaf nodes");
    assert(leaves.every((n) => n.children.length === 0), "all leaves have no children");
  }
  console.log();

  console.log("33. findNodes — by URL pattern...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.addNavigation("https://example.com/p1", "P1", "choice");
    m.addNavigation("https://example.com/p2", "P2", "choice");
    const found = m.findNodes((n) => n.url.includes("/p"));
    assert(found.length === 2, "found 2 nodes matching /p");
  }
  console.log();

  console.log("34. getNodeStats...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    const n1 = m.addNavigation("https://example.com/p1", "P1", "choice");
    const n2 = m.addNavigation("https://example.com/p2", "P2", "choice");
    m.setNodeMetadata(n1.id, { classification: { status: "dead", deadReason: "404" } });
    const stats = m.getNodeStats();
    assert(stats.total === 3, "total is 3");
    assert(stats.dead === 1, "dead is 1");
    assert(stats.live === 2, "live is 2");
    assert(stats.pruned === 0, "pruned is 0");
  }
  console.log();

  console.log("35. removeSubtree — removes node and descendants...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    const n1 = m.addNavigation("https://example.com/p1", "P1", "choice");
    const n2 = m.addNavigation("https://example.com/p2", "P2", "choice");
    const removed = m.removeSubtree(n1.id);
    assert(removed.length === 2, "removed 2 nodes (p1 + p2)");
    assert(m.nodes.size === 1, "only root remains");
    assert(m.getNode(n1.id) === null, "n1 is gone");
    assert(m.getNode(n2.id) === null, "n2 is gone");
    // Check parent's children updated
    const root = m.getNode(m.activeCrawl!.rootId)!;
    assert(!root.children.includes(n1.id), "root no longer references n1");
  }
  console.log();

  console.log("36. removeSubtree — refuses to remove root...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    const removed = m.removeSubtree(m.activeCrawl!.rootId);
    assert(removed.length === 0, "cannot remove root");
    assert(m.nodes.size === 1, "root still exists");
  }
  console.log();

  console.log("37. setCrawlMeta + getCrawlMeta...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.setCrawlMeta({ lifecycle: "done", tags: ["task"], pinned: true });
    const meta = m.getCrawlMeta();
    assert(meta.lifecycle === "done", "lifecycle is done");
    assert(meta.tags.includes("task"), "tags includes task");
    assert(meta.pinned === true, "pinned is true");
  }
  console.log();

  console.log("38. getCrawlMeta — defaults when no meta...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    const meta = m.getCrawlMeta();
    assert(meta.lifecycle === "open", "default lifecycle is open");
    assert(meta.tags.length === 0, "default tags empty");
    assert(meta.pinned === false, "default pinned is false");
  }
  console.log();

  console.log("39. setCrawlMeta — partial merge...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.setCrawlMeta({ lifecycle: "done", tags: ["task"] });
    m.setCrawlMeta({ pinned: true });
    const meta = m.getCrawlMeta();
    assert(meta.lifecycle === "done", "lifecycle preserved");
    assert(meta.tags.includes("task"), "tags preserved");
    assert(meta.pinned === true, "pinned updated");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 6: extractKeywords (4 tests)
  // ---------------------------------------------------------------
  console.log("--- extractKeywords ---\n");

  console.log("40. Extracts non-stopword keywords...");
  {
    const kw = extractKeywords("check my water bill");
    assert(kw.includes("water"), "includes water");
    assert(kw.includes("bill"), "includes bill");
    assert(!kw.includes("my"), "excludes my");
    assert(!kw.includes("check"), "excludes check");
  }
  console.log();

  console.log("41. Filters short words...");
  {
    const kw = extractKeywords("I am an AI");
    assert(kw.length === 0, "all short words filtered");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 7: Edge cases (5 tests)
  // ---------------------------------------------------------------
  console.log("--- Edge cases ---\n");

  console.log("42. Empty crawl — single root, no metadata...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      sessionDurationMs: 60000,
    });
    assert(result.lifecycle === "open", "open with single root");
    assert(!result.noise, "not noise with 60s session");
  }
  console.log();

  console.log("43. Node classification — no metadata at all...");
  {
    const node = makeNode({ id: "n1", url: "https://example.com" });
    // New node, no metadata, recent
    const nodes = new Map([["n1", node]]);
    const result = classifyNodeHeuristic(node, nodes, []);
    assert(result.status === "live", "live when no metadata and recent");
  }
  console.log();

  console.log("44. defaultCrawlMeta returns correct defaults...");
  {
    const meta = defaultCrawlMeta();
    assert(meta.lifecycle === "open", "default lifecycle");
    assert(meta.tags.length === 0, "default tags empty");
    assert(meta.pinned === false, "default not pinned");
    assert(meta.lifecycleUpdatedAt > 0, "has timestamp");
  }
  console.log();

  console.log("45. removeSubtree clears nodeIndex...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    const n1 = m.addNavigation("https://example.com/p1", "P1", "choice");
    assert(m.findNodeByUrl("https://example.com/p1") !== null, "p1 in index before removal");
    m.removeSubtree(n1.id);
    assert(m.findNodeByUrl("https://example.com/p1") === null, "p1 removed from index");
  }
  console.log();

  console.log("46. Done status overrides stale (confirmation on old crawl)...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.activeCrawl!.lastAccessed = Date.now() - 49 * 3600000;
    m.activeCrawl!.created = Date.now() - 50 * 3600000;
    const root = m.getNode(m.currentNodeId!)!;
    root.timestamp = Date.now() - 50 * 3600000;
    // Add confirmation page
    const n1 = m.addNavigation("https://example.com/confirm", "Confirm", "choice");
    n1.timestamp = Date.now() - 49 * 3600000;
    m.setNodeMetadata(n1.id, {
      interpretation: {
        pageType: "confirmation",
        summary: "Done!",
        choices: [],
        dataFound: null,
        requiresAuth: false,
        requiresHumanInput: false,
      },
    });

    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      sessionDurationMs: 60000,
    });
    assert(result.lifecycle === "done", "done overrides stale");
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
