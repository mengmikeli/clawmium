import { CrawlManager, CrawlNode, CursorEntry } from "./crawl/tree";
import { classifyNodeHeuristic } from "./crawl/classify";
import { pruneCrawl, findDeadBranches } from "./crawl/prune";

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
  console.log("=== Prune Test Suite ===\n");

  // ---------------------------------------------------------------
  // GROUP 1: Dead branch detection (12 tests)
  // ---------------------------------------------------------------
  console.log("--- Dead branch detection ---\n");

  console.log("1. No dead branches in healthy tree...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    const n1 = m.addNavigation("https://example.com/p1", "P1", "choice");
    m.setNodeMetadata(n1.id, { summary: "A useful page" });
    const branches = findDeadBranches(m);
    assert(branches.length === 0, "no dead branches");
  }
  console.log();

  console.log("2. Dead leaf (404) detected as dead branch...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.setNodeMetadata(m.currentNodeId!, { summary: "Root page" });
    const n1 = m.addNavigation("https://example.com/missing", "Missing", "choice");
    m.setNodeMetadata(n1.id, { httpStatus: 404 });
    // Move cursor back to root so n1 is not current
    m.navigateToNode(m.activeCrawl!.rootId);
    m.appendCursor(m.activeCrawl!.rootId, "back");

    const branches = findDeadBranches(m);
    assert(branches.length === 1, "one dead branch");
    assert(branches[0].deadNodeIds.includes(n1.id), "includes the 404 node");
  }
  console.log();

  console.log("3. Dead leaf (empty content) detected...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.appendCursor(m.currentNodeId!, "goto");
    m.setNodeMetadata(m.currentNodeId!, { summary: "Root page" });
    const n1 = m.addNavigation("https://example.com/empty", "Empty", "choice");
    m.setNodeMetadata(n1.id, { summary: "content is empty" });
    m.navigateToNode(m.activeCrawl!.rootId);
    m.appendCursor(m.activeCrawl!.rootId, "back");

    const branches = findDeadBranches(m);
    assert(branches.length === 1, "one dead branch for empty page");
  }
  console.log();

  console.log("4. Protected node — current cursor position not pruned...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    const n1 = m.addNavigation("https://example.com/missing", "Missing", "choice");
    m.setNodeMetadata(n1.id, { httpStatus: 404 });
    // n1 is still the current position
    const branches = findDeadBranches(m);
    assert(branches.length === 0, "current position not in dead branches");
  }
  console.log();

  console.log("5. Protected node — in cursor history not pruned...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.appendCursor(m.currentNodeId!, "goto");
    const n1 = m.addNavigation("https://example.com/missing", "Missing", "choice");
    m.setNodeMetadata(n1.id, { httpStatus: 404 });
    m.appendCursor(n1.id, "choice");
    // n1 is in cursor history
    m.navigateToNode(m.activeCrawl!.rootId);

    const branches = findDeadBranches(m);
    assert(branches.length === 0, "node in cursor history not pruned");
  }
  console.log();

  console.log("6. Root never pruned even if all children dead...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    // Don't put root in cursor history - just navigate away
    const n1 = m.addNavigation("https://example.com/dead", "Dead", "choice");
    m.setNodeMetadata(n1.id, { httpStatus: 404 });
    m.navigateToNode(m.activeCrawl!.rootId);
    m.appendCursor(m.activeCrawl!.rootId, "back");

    const branches = findDeadBranches(m);
    // Root should survive, only n1 is dead
    const allDead = branches.flatMap(b => b.deadNodeIds);
    assert(!allDead.includes(m.activeCrawl!.rootId), "root not in dead set");
  }
  console.log();

  console.log("7. Upward propagation — all children dead → parent dead...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.appendCursor(m.currentNodeId!, "goto");
    m.setNodeMetadata(m.currentNodeId!, { summary: "Root page" });
    const parent = m.addNavigation("https://example.com/section", "Section", "choice");
    // No summary on parent (empty)
    const child1 = m.addNavigation("https://example.com/section/a", "A", "choice");
    m.setNodeMetadata(child1.id, { httpStatus: 404 });
    m.navigateToNode(parent.id);
    const child2 = m.addNavigation("https://example.com/section/b", "B", "choice");
    m.setNodeMetadata(child2.id, { summary: "content is empty" });
    m.navigateToNode(m.activeCrawl!.rootId);
    m.appendCursor(m.activeCrawl!.rootId, "back");

    const branches = findDeadBranches(m);
    const allDead = branches.flatMap(b => b.deadNodeIds);
    assert(allDead.includes(parent.id), "parent propagated as dead");
    assert(allDead.includes(child1.id), "child1 is dead");
    assert(allDead.includes(child2.id), "child2 is dead");
  }
  console.log();

  console.log("8. No upward propagation — parent has meaningful summary...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.appendCursor(m.currentNodeId!, "goto");
    const parent = m.addNavigation("https://example.com/section", "Section", "choice");
    m.setNodeMetadata(parent.id, { summary: "Useful section overview" });
    const child = m.addNavigation("https://example.com/section/dead", "Dead", "choice");
    m.setNodeMetadata(child.id, { httpStatus: 404 });
    m.navigateToNode(m.activeCrawl!.rootId);
    m.appendCursor(m.activeCrawl!.rootId, "back");

    const branches = findDeadBranches(m);
    const allDead = branches.flatMap(b => b.deadNodeIds);
    assert(allDead.includes(child.id), "child is dead");
    assert(!allDead.includes(parent.id), "parent is NOT dead (has meaningful summary)");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 2: Pruning execution (10 tests)
  // ---------------------------------------------------------------
  console.log("--- Pruning execution ---\n");

  console.log("9. Prune removes dead nodes from tree...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.appendCursor(m.currentNodeId!, "goto");
    m.setNodeMetadata(m.currentNodeId!, { summary: "Root" });
    const n1 = m.addNavigation("https://example.com/dead", "Dead", "choice");
    m.setNodeMetadata(n1.id, { httpStatus: 404 });
    m.navigateToNode(m.activeCrawl!.rootId);
    m.appendCursor(m.activeCrawl!.rootId, "back");
    const sizeBefore = m.nodes.size;

    const result = pruneCrawl(m);
    assert(result.prunedCount === 1, "pruned 1 node");
    assert(m.nodes.size === sizeBefore - 1, "tree size decreased by 1");
    assert(m.getNode(n1.id) === null, "dead node removed");
  }
  console.log();

  console.log("10. Prune dry-run does NOT modify tree...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.appendCursor(m.currentNodeId!, "goto");
    m.setNodeMetadata(m.currentNodeId!, { summary: "Root" });
    const n1 = m.addNavigation("https://example.com/dead", "Dead", "choice");
    m.setNodeMetadata(n1.id, { httpStatus: 404 });
    m.navigateToNode(m.activeCrawl!.rootId);
    m.appendCursor(m.activeCrawl!.rootId, "back");
    const sizeBefore = m.nodes.size;

    const result = pruneCrawl(m, { dryRun: true });
    assert(result.prunedCount === 1, "dry-run reports 1 node");
    assert(m.nodes.size === sizeBefore, "tree size unchanged");
    assert(m.getNode(n1.id) !== null, "node still exists");
  }
  console.log();

  console.log("11. Prune on empty crawl — returns 0...");
  {
    const m = new CrawlManager();
    const result = pruneCrawl(m);
    assert(result.prunedCount === 0, "no pruning on empty manager");
  }
  console.log();

  console.log("12. Prune on healthy tree — returns 0...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.addNavigation("https://example.com/p1", "P1", "choice");
    m.setNodeMetadata(m.currentNodeId!, { summary: "Good page" });
    const result = pruneCrawl(m);
    assert(result.prunedCount === 0, "nothing to prune");
  }
  console.log();

  console.log("13. Tree integrity after prune — no orphan children refs...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.appendCursor(m.currentNodeId!, "goto");
    m.setNodeMetadata(m.currentNodeId!, { summary: "Root" });
    const n1 = m.addNavigation("https://example.com/dead1", "Dead1", "choice");
    m.setNodeMetadata(n1.id, { httpStatus: 404 });
    m.navigateToNode(m.activeCrawl!.rootId);
    m.appendCursor(m.activeCrawl!.rootId, "back");
    const n2 = m.addNavigation("https://example.com/live", "Live", "choice");
    m.setNodeMetadata(n2.id, { summary: "A live page" });

    pruneCrawl(m);

    // Check all children references are valid
    for (const node of m.nodes.values()) {
      for (const childId of node.children) {
        assert(m.nodes.has(childId), `child ${childId.slice(0, 6)} of ${node.url} exists in tree`);
      }
    }
  }
  console.log();

  console.log("14. Prune removes subtree (parent + children)...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.appendCursor(m.currentNodeId!, "goto");
    m.setNodeMetadata(m.currentNodeId!, { summary: "Root" });
    const parent = m.addNavigation("https://example.com/section", "Section", "choice");
    // No summary
    const child = m.addNavigation("https://example.com/section/dead", "Dead", "choice");
    m.setNodeMetadata(child.id, { httpStatus: 404 });
    m.navigateToNode(m.activeCrawl!.rootId);
    m.appendCursor(m.activeCrawl!.rootId, "back");

    const result = pruneCrawl(m);
    assert(result.prunedCount === 2, "pruned 2 nodes (parent + child)");
    assert(m.getNode(parent.id) === null, "parent removed");
    assert(m.getNode(child.id) === null, "child removed");
  }
  console.log();

  console.log("15. Prune reasons populated...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.appendCursor(m.currentNodeId!, "goto");
    m.setNodeMetadata(m.currentNodeId!, { summary: "Root" });
    const n1 = m.addNavigation("https://example.com/dead", "Dead", "choice");
    m.setNodeMetadata(n1.id, { httpStatus: 404 });
    m.navigateToNode(m.activeCrawl!.rootId);
    m.appendCursor(m.activeCrawl!.rootId, "back");

    const result = pruneCrawl(m);
    assert(result.reasons.length > 0, "reasons populated");
    assert(result.reasons[0].includes("node"), "reason mentions nodes");
  }
  console.log();

  console.log("16. Multiple dead branches pruned in one pass...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.appendCursor(m.currentNodeId!, "goto");
    m.setNodeMetadata(m.currentNodeId!, { summary: "Root" });
    const n1 = m.addNavigation("https://example.com/dead1", "Dead1", "choice");
    m.setNodeMetadata(n1.id, { httpStatus: 404 });
    m.navigateToNode(m.activeCrawl!.rootId);
    const n2 = m.addNavigation("https://example.com/dead2", "Dead2", "choice");
    m.setNodeMetadata(n2.id, { summary: "content is empty" });
    m.navigateToNode(m.activeCrawl!.rootId);
    m.appendCursor(m.activeCrawl!.rootId, "back");

    const result = pruneCrawl(m);
    assert(result.prunedCount === 2, "pruned 2 dead branches");
  }
  console.log();

  console.log("17. Abandoned leaf pruned (>1h, no summary)...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.appendCursor(m.currentNodeId!, "goto");
    m.setNodeMetadata(m.currentNodeId!, { summary: "Root" });
    const n1 = m.addNavigation("https://example.com/abandoned", "Abandoned", "choice");
    // Make it old with no summary
    n1.timestamp = Date.now() - 7200000;
    m.navigateToNode(m.activeCrawl!.rootId);
    m.appendCursor(m.activeCrawl!.rootId, "back");

    const result = pruneCrawl(m);
    assert(result.prunedCount === 1, "abandoned node pruned");
  }
  console.log();

  console.log("18. NodeIndex cleaned after prune...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.appendCursor(m.currentNodeId!, "goto");
    m.setNodeMetadata(m.currentNodeId!, { summary: "Root" });
    const n1 = m.addNavigation("https://example.com/dead", "Dead", "choice");
    m.setNodeMetadata(n1.id, { httpStatus: 404 });
    m.navigateToNode(m.activeCrawl!.rootId);
    m.appendCursor(m.activeCrawl!.rootId, "back");

    assert(m.findNodeByUrl("https://example.com/dead") !== null, "in index before prune");
    pruneCrawl(m);
    assert(m.findNodeByUrl("https://example.com/dead") === null, "removed from index after prune");
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
