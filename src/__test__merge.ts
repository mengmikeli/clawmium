import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { CrawlManager, CrawlNode } from "./crawl/tree";
import { saveCrawl, loadCrawl, setCrawlDir, CrawlPeek } from "./crawl/persistence";
import { setSessionDir, saveSession } from "./session/persistence";
import { findMergeCandidates, graftCrawl, moveBranch } from "./crawl/merge";

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

const TEST_DIR = path.join(os.tmpdir(), `clm-merge-test-${Date.now()}`);

function cleanup(): void {
  try {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  } catch { /* best effort */ }
}

function makePeek(id: string, name: string, rootUrl: string, nodeCount = 1): CrawlPeek {
  return { id, name, rootUrl, nodeCount, created: Date.now() };
}

async function main() {
  console.log("=== Merge Test Suite ===\n");

  setCrawlDir(TEST_DIR);
  setSessionDir(TEST_DIR);
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // ---------------------------------------------------------------
  // GROUP 1: Candidate detection (12 tests)
  // ---------------------------------------------------------------
  console.log("--- Merge candidate detection ---\n");

  console.log("1. Same domain gives high similarity...");
  {
    const target = new CrawlManager();
    target.createCrawl("https://example.com", "Root", "goto");
    const peeks: CrawlPeek[] = [
      makePeek("other", "other crawl", "https://example.com/page2"),
    ];
    const candidates = findMergeCandidates(target.activeCrawl!.id, peeks, target.nodes);
    assert(candidates.length === 1, "one candidate found");
    assert(candidates[0].similarity >= 0.6, "similarity >= 0.6 for same domain");
    assert(candidates[0].reason.includes("same domain"), "reason mentions domain");
  }
  console.log();

  console.log("2. Shared root URL adds to score...");
  {
    const target = new CrawlManager();
    target.createCrawl("https://example.com", "Root", "goto");
    target.addNavigation("https://example.com/shared", "Shared", "choice");
    const peeks: CrawlPeek[] = [
      makePeek("other", "other crawl", "https://example.com/shared"),
    ];
    const candidates = findMergeCandidates(target.activeCrawl!.id, peeks, target.nodes);
    assert(candidates.length === 1, "candidate found");
    assert(candidates[0].similarity >= 0.8, "high similarity with shared URL");
  }
  console.log();

  console.log("3. Different domain, no overlap gives low score...");
  {
    const target = new CrawlManager();
    target.createCrawl("https://example.com", "Root", "goto");
    const peeks: CrawlPeek[] = [
      makePeek("other", "unrelated stuff", "https://different.com"),
    ];
    const candidates = findMergeCandidates(target.activeCrawl!.id, peeks, target.nodes);
    assert(candidates.length === 0, "no candidates for different domain");
  }
  console.log();

  console.log("4. Self not included in candidates...");
  {
    const target = new CrawlManager();
    target.createCrawl("https://example.com", "Root", "goto");
    const peeks: CrawlPeek[] = [
      makePeek(target.activeCrawl!.id, "self", "https://example.com"),
    ];
    const candidates = findMergeCandidates(target.activeCrawl!.id, peeks, target.nodes);
    assert(candidates.length === 0, "self excluded");
  }
  console.log();

  console.log("5. Related goal keywords add to score...");
  {
    const target = new CrawlManager();
    target.createCrawl("https://example.com", "Root", "goto");
    const peeks: CrawlPeek[] = [
      makePeek("other", "water bill payment utility", "https://different.com"),
    ];
    const goal = { baseGoal: "check my water bill payment utility", activeIntent: "", breadcrumb: [] as string[] };
    const candidates = findMergeCandidates(target.activeCrawl!.id, peeks, target.nodes, goal);
    assert(candidates.length === 1, "candidate found from keyword match");
    assert(candidates[0].reason.includes("keyword"), "reason mentions keywords");
  }
  console.log();

  console.log("6. Candidates sorted by similarity descending...");
  {
    const target = new CrawlManager();
    target.createCrawl("https://example.com", "Root", "goto");
    const peeks: CrawlPeek[] = [
      makePeek("low", "unrelated water", "https://other.com"),
      makePeek("high", "example page", "https://example.com/p"),
    ];
    const goal = { baseGoal: "water research", activeIntent: "", breadcrumb: [] as string[] };
    const candidates = findMergeCandidates(target.activeCrawl!.id, peeks, target.nodes, goal);
    if (candidates.length >= 2) {
      assert(candidates[0].similarity >= candidates[1].similarity, "sorted descending");
    } else {
      assert(candidates.length >= 1, "at least one candidate");
    }
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 2: Graft operation (12 tests)
  // ---------------------------------------------------------------
  console.log("--- Graft operation ---\n");

  console.log("7. Basic graft — nodes copied with new IDs...");
  {
    const target = new CrawlManager();
    target.createCrawl("https://example.com", "Target Root", "goto");
    const targetSize = target.nodes.size;

    const source = new CrawlManager();
    source.createCrawl("https://source.com", "Source Root", "goto");
    source.addNavigation("https://source.com/p1", "Source P1", "choice");

    const result = graftCrawl(target, source);
    assert(result.graftedNodeCount === 2, "grafted 2 nodes");
    assert(target.nodes.size === targetSize + 2, "target grew by 2");
    assert(result.newRootId.length > 0, "new root ID assigned");
  }
  console.log();

  console.log("8. Grafted nodes have new UUIDs (no collision)...");
  {
    const target = new CrawlManager();
    target.createCrawl("https://example.com", "Target Root", "goto");

    const source = new CrawlManager();
    source.createCrawl("https://source.com", "Source Root", "goto");
    const sourceRootId = source.currentNodeId!;

    const result = graftCrawl(target, source);
    assert(result.newRootId !== sourceRootId, "new root ID differs from source");
    assert(!target.nodes.has(sourceRootId), "source ID not in target");
  }
  console.log();

  console.log("9. Grafted root attached to specified parent...");
  {
    const target = new CrawlManager();
    target.createCrawl("https://example.com", "Target Root", "goto");
    const parent = target.addNavigation("https://example.com/section", "Section", "choice");

    const source = new CrawlManager();
    source.createCrawl("https://source.com", "Source Root", "goto");

    const result = graftCrawl(target, source, parent.id);
    const graftedRoot = target.nodes.get(result.newRootId);
    assert(graftedRoot !== null, "grafted root exists");
    assert(graftedRoot!.parentId === parent.id, "grafted root's parent is the specified node");
    assert(parent.children.includes(result.newRootId), "parent's children includes grafted root");
  }
  console.log();

  console.log("10. Grafted root defaults to target root...");
  {
    const target = new CrawlManager();
    target.createCrawl("https://example.com", "Target Root", "goto");

    const source = new CrawlManager();
    source.createCrawl("https://source.com", "Source Root", "goto");

    const result = graftCrawl(target, source);
    const graftedRoot = target.nodes.get(result.newRootId);
    assert(graftedRoot!.parentId === target.activeCrawl!.rootId, "grafted to target root");
  }
  console.log();

  console.log("11. Metadata preserved on grafted nodes...");
  {
    const target = new CrawlManager();
    target.createCrawl("https://example.com", "Target Root", "goto");

    const source = new CrawlManager();
    source.createCrawl("https://source.com", "Source Root", "goto");
    source.setNodeMetadata(source.currentNodeId!, { summary: "Important content" });

    const result = graftCrawl(target, source);
    const graftedRoot = target.nodes.get(result.newRootId);
    assert(graftedRoot!.metadata?.summary === "Important content", "summary preserved");
  }
  console.log();

  console.log("12. mergedFrom updated on target...");
  {
    const target = new CrawlManager();
    target.createCrawl("https://example.com", "Target Root", "goto");

    const source = new CrawlManager();
    source.createCrawl("https://source.com", "Source Root", "goto");

    graftCrawl(target, source);
    const meta = target.getCrawlMeta();
    assert(meta.mergedFrom !== undefined, "mergedFrom exists");
    assert(meta.mergedFrom!.includes(source.activeCrawl!.id), "mergedFrom contains source ID");
  }
  console.log();

  console.log("13. Duplicate URLs skipped during graft...");
  {
    const target = new CrawlManager();
    target.createCrawl("https://shared.com", "Target Root", "goto");
    target.addNavigation("https://shared.com/page", "Shared Page", "choice");
    const targetSize = target.nodes.size;

    const source = new CrawlManager();
    source.createCrawl("https://shared.com", "Source Root", "goto");
    source.addNavigation("https://shared.com/page", "Same Page", "choice");

    const result = graftCrawl(target, source);
    assert(result.graftedNodeCount === 0, "no nodes grafted (all duplicates)");
    assert(target.nodes.size === targetSize, "target size unchanged");
  }
  console.log();

  console.log("14. No cycles after graft...");
  {
    const target = new CrawlManager();
    target.createCrawl("https://example.com", "Target Root", "goto");

    const source = new CrawlManager();
    source.createCrawl("https://source.com", "Source Root", "goto");
    source.addNavigation("https://source.com/p1", "P1", "choice");
    source.addNavigation("https://source.com/p2", "P2", "choice");

    graftCrawl(target, source);

    // Verify no cycles by walking from each node to root
    for (const node of target.nodes.values()) {
      const visited = new Set<string>();
      let current: CrawlNode | null = node;
      let hasCycle = false;
      while (current && current.parentId) {
        if (visited.has(current.id)) { hasCycle = true; break; }
        visited.add(current.id);
        current = target.nodes.get(current.parentId) || null;
      }
      assert(!hasCycle, `no cycle from ${node.url}`);
    }
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 3: Branch move (8 tests)
  // ---------------------------------------------------------------
  console.log("--- Branch move ---\n");

  console.log("15. Move branch from source to target...");
  {
    const source = new CrawlManager();
    source.createCrawl("https://source.com", "Source Root", "goto");
    const branch = source.addNavigation("https://source.com/branch", "Branch", "choice");
    source.addNavigation("https://source.com/branch/leaf", "Leaf", "choice");
    const sourceSize = source.nodes.size;

    const target = new CrawlManager();
    target.createCrawl("https://target.com", "Target Root", "goto");

    const moved = moveBranch(source, target, branch.id);
    assert(moved === true, "move succeeded");
    assert(source.nodes.size === sourceSize - 2, "source lost 2 nodes");
    assert(source.getNode(branch.id) === null, "branch removed from source");
    assert(target.nodes.size === 3, "target gained 2 nodes");
  }
  console.log();

  console.log("16. Cannot move root...");
  {
    const source = new CrawlManager();
    source.createCrawl("https://source.com", "Source Root", "goto");

    const target = new CrawlManager();
    target.createCrawl("https://target.com", "Target Root", "goto");

    const moved = moveBranch(source, target, source.activeCrawl!.rootId);
    assert(moved === false, "cannot move root");
  }
  console.log();

  console.log("17. Move to specific attach point...");
  {
    const source = new CrawlManager();
    source.createCrawl("https://source.com", "Source Root", "goto");
    const branch = source.addNavigation("https://source.com/branch", "Branch", "choice");

    const target = new CrawlManager();
    target.createCrawl("https://target.com", "Target Root", "goto");
    const section = target.addNavigation("https://target.com/section", "Section", "choice");

    const moved = moveBranch(source, target, branch.id, section.id);
    assert(moved === true, "move to specific point succeeded");
    // Find the new node in target
    const movedNode = target.findNodeByUrl("https://source.com/branch");
    assert(movedNode !== null, "moved node exists in target");
    if (movedNode) {
      assert(movedNode.parentId === section.id, "attached to correct parent");
    }
  }
  console.log();

  console.log("18. Move fails with no active crawls...");
  {
    const source = new CrawlManager();
    const target = new CrawlManager();
    const moved = moveBranch(source, target, "fake-id");
    assert(moved === false, "fails gracefully");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 4: Persistence round-trip (6 tests)
  // ---------------------------------------------------------------
  console.log("--- Persistence round-trip ---\n");

  console.log("19. Grafted tree saves and loads correctly...");
  {
    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const target = new CrawlManager();
    target.createCrawl("https://example.com", "Target Root", "goto");
    target.activeCrawl!.name = "merged target";

    const source = new CrawlManager();
    source.createCrawl("https://source.com", "Source Root", "goto");
    source.addNavigation("https://source.com/p1", "P1", "choice");

    graftCrawl(target, source);
    const sizeBefore = target.nodes.size;

    saveCrawl(target);
    saveSession({
      manager: target,
      currentUrl: "https://example.com",
      site: "example",
      homeUrl: "",
      goalContext: { baseGoal: "", activeIntent: "", breadcrumb: [] },
      history: [],
      log: [],
    });

    const loaded = new CrawlManager();
    const ok = loadCrawl(target.activeCrawl!.id, loaded);
    assert(ok === true, "load succeeded");
    assert(loaded.nodes.size === sizeBefore, "same node count after load");
    assert(loaded.findNodeByUrl("https://source.com") !== null, "source root URL in loaded tree");
    assert(loaded.findNodeByUrl("https://source.com/p1") !== null, "source child URL in loaded tree");
  }
  console.log();

  console.log("20. mergedFrom preserved across save/load...");
  {
    const target = new CrawlManager();
    target.createCrawl("https://example.com", "Root", "goto");
    target.setCrawlMeta({ mergedFrom: ["crawl-abc", "crawl-def"] });

    cleanup();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    saveCrawl(target);
    saveSession({
      manager: target,
      currentUrl: "https://example.com",
      site: "example",
      homeUrl: "",
      goalContext: { baseGoal: "", activeIntent: "", breadcrumb: [] },
      history: [],
      log: [],
    });

    const loaded = new CrawlManager();
    loadCrawl(target.activeCrawl!.id, loaded);
    const meta = loaded.getCrawlMeta();
    assert(meta.mergedFrom !== undefined, "mergedFrom exists after load");
    assert(meta.mergedFrom!.length === 2, "two entries in mergedFrom");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 5: Edge cases (4 tests)
  // ---------------------------------------------------------------
  console.log("--- Edge cases ---\n");

  console.log("21. Graft with no active target returns 0...");
  {
    const target = new CrawlManager();
    const source = new CrawlManager();
    source.createCrawl("https://source.com", "Source", "goto");
    const result = graftCrawl(target, source);
    assert(result.graftedNodeCount === 0, "no graft without active target");
  }
  console.log();

  console.log("22. Graft with no active source returns 0...");
  {
    const target = new CrawlManager();
    target.createCrawl("https://example.com", "Target", "goto");
    const source = new CrawlManager();
    const result = graftCrawl(target, source);
    assert(result.graftedNodeCount === 0, "no graft without active source");
  }
  console.log();

  console.log("23. Graft to invalid attach point returns 0...");
  {
    const target = new CrawlManager();
    target.createCrawl("https://example.com", "Target", "goto");
    const source = new CrawlManager();
    source.createCrawl("https://source.com", "Source", "goto");
    const result = graftCrawl(target, source, "nonexistent-id");
    assert(result.graftedNodeCount === 0, "no graft to invalid attach point");
  }
  console.log();

  console.log("24. Empty candidates list...");
  {
    const target = new CrawlManager();
    target.createCrawl("https://example.com", "Root", "goto");
    const candidates = findMergeCandidates(target.activeCrawl!.id, [], target.nodes);
    assert(candidates.length === 0, "no candidates from empty list");
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
