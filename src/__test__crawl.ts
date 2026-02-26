import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { CrawlManager, CrawlNode } from "./crawl/tree";
import { saveCrawl, loadCrawl, listCrawls, setCrawlDir } from "./crawl/persistence";

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

// Temp directory for test crawl files
const TEST_DIR = path.join(os.tmpdir(), `clm-crawl-test-${Date.now()}`);

function cleanup(): void {
  try {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  } catch { /* best effort */ }
}

async function main() {
  console.log("=== Crawl Tree Test Suite ===\n");

  // Point persistence at temp dir
  setCrawlDir(TEST_DIR);

  // ---------------------------------------------------------------
  // GROUP 1: Core tree operations (6 tests)
  // ---------------------------------------------------------------
  console.log("--- Core tree operations ---\n");

  console.log("1. createCrawl — activeCrawl set, root node correct, currentNodeId set...");
  {
    const m = new CrawlManager();
    const crawl = m.createCrawl("https://example.com", "Example", "goto");
    assert(m.activeCrawl !== null, "activeCrawl is set");
    assert(m.activeCrawl!.id === crawl.id, "activeCrawl matches returned crawl");
    assert(m.currentNodeId !== null, "currentNodeId is set");
    const root = m.getNode(m.currentNodeId!);
    assert(root !== null, "root node exists");
    assert(root!.url === "https://example.com", "root URL correct");
    assert(root!.title === "Example", "root title correct");
    assert(root!.parentId === null, "root has no parent");
    assert(root!.reachedBy === "goto", "root reachedBy is goto");
    assert(crawl.rootId === root!.id, "crawl.rootId matches root node id");
  }
  console.log();

  console.log("2. addNavigation — child created with correct parentId, root's children updated...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    const rootId = m.currentNodeId!;
    const child = m.addNavigation("https://example.com/page1", "Page 1", "choice");
    assert(child.parentId === rootId, "child parentId is root");
    assert(child.reachedBy === "choice", "child reachedBy is choice");
    assert(child.url === "https://example.com/page1", "child URL correct");
    const root = m.getNode(rootId)!;
    assert(root.children.includes(child.id), "root's children includes child");
    assert(m.currentNodeId === child.id, "currentNodeId moved to child");
  }
  console.log();

  console.log("3. deduplication — navigate to existing URL moves position, no new node...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    const rootId = m.currentNodeId!;
    m.addNavigation("https://example.com/page1", "Page 1", "choice");
    const nodeCountBefore = m.nodes.size;

    // Navigate back to root URL
    const result = m.addNavigation("https://example.com", "Root", "goto");
    assert(m.nodes.size === nodeCountBefore, "no new node created on dedup");
    assert(result.id === rootId, "returned existing root node");
    assert(m.currentNodeId === rootId, "currentNodeId moved back to root");
  }
  console.log();

  console.log("4. currentNodeId tracking through navigation chain...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://a.com", "A", "goto");
    const aId = m.currentNodeId!;
    const b = m.addNavigation("https://b.com", "B", "choice");
    assert(m.currentNodeId === b.id, "after B: currentNodeId is B");
    const c = m.addNavigation("https://c.com", "C", "choice");
    assert(m.currentNodeId === c.id, "after C: currentNodeId is C");
    // C's parent should be B (we navigated A -> B -> C)
    assert(c.parentId === b.id, "C's parent is B");
    // B's parent should be A
    assert(b.parentId === aId, "B's parent is A");
  }
  console.log();

  console.log("5. getAncestors — leaf-to-root chain correct for 4-level tree...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://l0.com", "L0", "goto");
    m.addNavigation("https://l1.com", "L1", "choice");
    m.addNavigation("https://l2.com", "L2", "choice");
    const l3 = m.addNavigation("https://l3.com", "L3", "choice");

    const ancestors = m.getAncestors(l3.id);
    assert(ancestors.length === 4, `ancestors length is 4 (got ${ancestors.length})`);
    assert(ancestors[0].url === "https://l3.com", "first ancestor is leaf (L3)");
    assert(ancestors[1].url === "https://l2.com", "second ancestor is L2");
    assert(ancestors[2].url === "https://l1.com", "third ancestor is L1");
    assert(ancestors[3].url === "https://l0.com", "last ancestor is root (L0)");
  }
  console.log();

  console.log("6. navigateToNode — updates position, returns false for invalid ID...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://a.com", "A", "goto");
    const rootId = m.currentNodeId!;
    const b = m.addNavigation("https://b.com", "B", "choice");
    assert(m.currentNodeId === b.id, "starts at B");

    const ok = m.navigateToNode(rootId);
    assert(ok === true, "navigateToNode returns true for valid ID");
    assert(m.currentNodeId === rootId, "currentNodeId moved to root");

    const bad = m.navigateToNode("nonexistent-id");
    assert(bad === false, "navigateToNode returns false for invalid ID");
    assert(m.currentNodeId === rootId, "currentNodeId unchanged after bad navigate");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 2: Tree restructuring (3 tests)
  // ---------------------------------------------------------------
  console.log("--- Tree restructuring ---\n");

  console.log("7. detachSubtree — removes from parent's children, returns subtree IDs...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://root.com", "Root", "goto");
    const rootId = m.currentNodeId!;
    const a = m.addNavigation("https://a.com", "A", "choice");
    const b = m.addNavigation("https://b.com", "B", "choice"); // child of A

    const subtreeIds = m.detachSubtree(a.id);
    assert(subtreeIds.length === 2, `subtree has 2 nodes (got ${subtreeIds.length})`);
    assert(subtreeIds.includes(a.id), "subtree includes A");
    assert(subtreeIds.includes(b.id), "subtree includes B");

    const root = m.getNode(rootId)!;
    assert(!root.children.includes(a.id), "root no longer has A as child");
    assert(m.getNode(a.id)!.parentId === null, "A's parentId is now null");
  }
  console.log();

  console.log("8. attachSubtree — rewires parentId and children...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://root.com", "Root", "goto");
    const rootId = m.currentNodeId!;
    const a = m.addNavigation("https://a.com", "A", "choice");
    // Navigate back to root, then create B as sibling
    m.navigateToNode(rootId);
    const b = m.addNavigation("https://b.com", "B", "choice");

    // Detach A from root, attach under B
    m.detachSubtree(a.id);
    const ok = m.attachSubtree(a.id, b.id);
    assert(ok === true, "attachSubtree returns true");
    assert(m.getNode(a.id)!.parentId === b.id, "A's parent is now B");
    assert(m.getNode(b.id)!.children.includes(a.id), "B's children includes A");
    assert(!m.getNode(rootId)!.children.includes(a.id), "root no longer has A");
  }
  console.log();

  console.log("9. cycle detection — attachSubtree returns false for would-be cycle...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://root.com", "Root", "goto");
    const rootId = m.currentNodeId!;
    const a = m.addNavigation("https://a.com", "A", "choice");
    const b = m.addNavigation("https://b.com", "B", "choice"); // child of A

    // Try to attach root under B (would create cycle: root -> A -> B -> root)
    const ok = m.attachSubtree(rootId, b.id);
    assert(ok === false, "attachSubtree returns false for cycle");
    assert(m.getNode(rootId)!.parentId === null, "root parentId still null");

    // Try to attach A under B (B is child of A — would create cycle)
    const ok2 = m.attachSubtree(a.id, b.id);
    assert(ok2 === false, "attachSubtree returns false when parent is in subtree");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 3: Display (1 test)
  // ---------------------------------------------------------------
  console.log("--- Display ---\n");

  console.log("10. getDisplayTree — correct indentation levels, contains title + URL...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://root.com", "Root", "goto");
    m.addNavigation("https://a.com", "Page A", "choice");
    m.addNavigation("https://b.com", "Page B", "choice"); // child of A

    const tree = m.getDisplayTree();
    const lines = tree.split("\n");
    assert(lines.length === 3, `tree has 3 lines (got ${lines.length})`);
    assert(lines[0].startsWith("- [Root]"), "first line is root (no indent)");
    assert(lines[1].startsWith("  - [Page A]"), "second line is A (2-space indent)");
    assert(lines[2].startsWith("    - [Page B]"), "third line is B (4-space indent)");
    assert(tree.includes("https://root.com"), "tree contains root URL");
    assert(tree.includes("https://a.com"), "tree contains A URL");
    assert(tree.includes("choice"), "tree contains reachedBy");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 4: Persistence (3 tests)
  // ---------------------------------------------------------------
  console.log("--- Persistence ---\n");

  console.log("11. save/load — all fields match after round-trip...");
  {
    const m1 = new CrawlManager();
    m1.createCrawl("https://news.ycombinator.com", "Hacker News", "goto");
    m1.addNavigation("https://news.ycombinator.com/item?id=12345", "Show HN: My Project", "choice");
    m1.addNavigation("https://example.com", "Project Homepage", "choice");
    // Navigate back to root, add another child
    m1.navigateToNode(m1.activeCrawl!.rootId);
    m1.addNavigation("https://news.ycombinator.com/item?id=67890", "Ask HN: Best practices?", "choice");

    const filepath = saveCrawl(m1);
    assert(fs.existsSync(filepath), "saved file exists");

    const m2 = new CrawlManager();
    const loaded = loadCrawl(m1.activeCrawl!.id, m2);
    assert(loaded === true, "loadCrawl returns true");
    assert(m2.activeCrawl !== null, "loaded manager has activeCrawl");
    assert(m2.activeCrawl!.id === m1.activeCrawl!.id, "crawl ID matches");
    assert(m2.activeCrawl!.name === m1.activeCrawl!.name, "crawl name matches");
    assert(m2.activeCrawl!.rootId === m1.activeCrawl!.rootId, "rootId matches");
    assert(m2.nodes.size === m1.nodes.size, `node count matches (${m2.nodes.size} vs ${m1.nodes.size})`);

    // Check each node
    for (const [id, original] of m1.nodes) {
      const loaded = m2.getNode(id);
      assert(loaded !== null, `node ${id.slice(0, 6)} exists in loaded`);
      if (loaded) {
        assert(loaded.url === original.url, `node ${id.slice(0, 6)} URL matches`);
        assert(loaded.title === original.title, `node ${id.slice(0, 6)} title matches`);
        assert(loaded.parentId === original.parentId, `node ${id.slice(0, 6)} parentId matches`);
        assert(loaded.reachedBy === original.reachedBy, `node ${id.slice(0, 6)} reachedBy matches`);
        assert(loaded.children.length === original.children.length, `node ${id.slice(0, 6)} children count matches`);
      }
    }

    // Check URL index was rebuilt
    assert(m2.findNodeByUrl("https://news.ycombinator.com") !== null, "URL index has root");
    assert(m2.findNodeByUrl("https://example.com") !== null, "URL index has example.com");
  }
  console.log();

  console.log("12. round-trip — save → load → save produces equivalent markdown...");
  {
    const m1 = new CrawlManager();
    m1.createCrawl("https://a.com", "Site A", "goto");
    m1.addNavigation("https://b.com", "Site B", "choice");
    m1.addNavigation("https://c.com", "Site C", "auto");

    const path1 = saveCrawl(m1);
    const content1 = fs.readFileSync(path1, "utf-8");

    const m2 = new CrawlManager();
    loadCrawl(m1.activeCrawl!.id, m2);
    const path2 = saveCrawl(m2);
    const content2 = fs.readFileSync(path2, "utf-8");

    assert(content1 === content2, "save → load → save produces identical markdown");
  }
  console.log();

  console.log("13. listCrawls — returns correct crawl IDs...");
  {
    // We already have crawls saved from test 11 and 12
    const crawls = listCrawls();
    assert(crawls.length >= 2, `listCrawls returns >= 2 crawls (got ${crawls.length})`);
    assert(crawls.every((id) => id.length > 0), "all crawl IDs are non-empty");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 5: Edge cases (5 tests)
  // ---------------------------------------------------------------
  console.log("--- Edge cases ---\n");

  console.log("14. empty manager — getDisplayTree returns '', addNavigation auto-creates...");
  {
    const m = new CrawlManager();
    assert(m.getDisplayTree() === "", "empty manager getDisplayTree returns empty string");
    assert(m.activeCrawl === null, "no activeCrawl initially");

    const node = m.addNavigation("https://auto.com", "Auto Created", "goto");
    assert(m.activeCrawl !== null, "addNavigation auto-created crawl");
    assert(node.url === "https://auto.com", "auto-created node has correct URL");
    assert(m.currentNodeId === node.id, "currentNodeId set to auto-created node");
  }
  console.log();

  console.log("15. single-node crawl — save/load works...");
  {
    const m1 = new CrawlManager();
    m1.createCrawl("https://single.com", "Single Node", "goto");

    const filepath = saveCrawl(m1);
    assert(fs.existsSync(filepath), "single-node crawl saved");

    const m2 = new CrawlManager();
    const ok = loadCrawl(m1.activeCrawl!.id, m2);
    assert(ok === true, "single-node crawl loaded");
    assert(m2.nodes.size === 1, "loaded has exactly 1 node");
    assert(m2.getNode(m2.activeCrawl!.rootId)!.url === "https://single.com", "root URL correct");
  }
  console.log();

  console.log("16. deep tree (10 levels) — ancestors correct, persistence works...");
  {
    const m1 = new CrawlManager();
    m1.createCrawl("https://depth-0.com", "Depth 0", "goto");

    for (let i = 1; i < 10; i++) {
      m1.addNavigation(`https://depth-${i}.com`, `Depth ${i}`, "choice");
    }

    // Check ancestors from leaf
    const leaf = m1.getNode(m1.currentNodeId!)!;
    const ancestors = m1.getAncestors(leaf.id);
    assert(ancestors.length === 10, `deep tree has 10 ancestors (got ${ancestors.length})`);
    assert(ancestors[0].url === "https://depth-9.com", "leaf is depth-9");
    assert(ancestors[9].url === "https://depth-0.com", "root is depth-0");

    // Save and load
    const filepath = saveCrawl(m1);
    const m2 = new CrawlManager();
    loadCrawl(m1.activeCrawl!.id, m2);
    assert(m2.nodes.size === 10, `loaded deep tree has 10 nodes (got ${m2.nodes.size})`);

    // Verify ancestry in loaded tree
    const loadedLeafByUrl = m2.findNodeByUrl("https://depth-9.com");
    assert(loadedLeafByUrl !== null, "loaded tree has depth-9 node");
    const loadedAncestors = m2.getAncestors(loadedLeafByUrl!.id);
    assert(loadedAncestors.length === 10, `loaded ancestors length is 10 (got ${loadedAncestors.length})`);
  }
  console.log();

  console.log("17. wide tree (20 children) — persistence works...");
  {
    const m1 = new CrawlManager();
    m1.createCrawl("https://wide-root.com", "Wide Root", "goto");
    const rootId = m1.currentNodeId!;

    for (let i = 0; i < 20; i++) {
      m1.navigateToNode(rootId);
      m1.addNavigation(`https://child-${i}.com`, `Child ${i}`, "choice");
    }

    const root = m1.getNode(rootId)!;
    assert(root.children.length === 20, `root has 20 children (got ${root.children.length})`);

    // Save and load
    saveCrawl(m1);
    const m2 = new CrawlManager();
    loadCrawl(m1.activeCrawl!.id, m2);
    assert(m2.nodes.size === 21, `loaded wide tree has 21 nodes (got ${m2.nodes.size})`);
    const loadedRoot = m2.getNode(m2.activeCrawl!.rootId)!;
    assert(loadedRoot.children.length === 20, `loaded root has 20 children (got ${loadedRoot.children.length})`);
  }
  console.log();

  console.log("18. multiple navigations to same URL — dedup + tree structure correct...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://root.com", "Root", "goto");
    const rootId = m.currentNodeId!;

    // Root -> A -> B -> visit A again (dedup) -> C (should be child of A, not B)
    const a = m.addNavigation("https://a.com", "A", "choice");
    const b = m.addNavigation("https://b.com", "B", "choice");
    assert(m.nodes.size === 3, "3 nodes before dedup visit");

    // Revisit A
    const aAgain = m.addNavigation("https://a.com", "A", "choice");
    assert(m.nodes.size === 3, "still 3 nodes after dedup visit");
    assert(aAgain.id === a.id, "returned same A node");
    assert(m.currentNodeId === a.id, "currentNodeId is A");

    // Add C — should be child of A (current position)
    const c = m.addNavigation("https://c.com", "C", "choice");
    assert(c.parentId === a.id, "C's parent is A (not B)");
    assert(m.getNode(a.id)!.children.includes(c.id), "A's children includes C");
    assert(m.nodes.size === 4, "4 nodes total");

    // Verify tree structure: root -> A -> [B, C]
    const rootNode = m.getNode(rootId)!;
    assert(rootNode.children.length === 1, "root has 1 child (A)");
    assert(m.getNode(a.id)!.children.length === 2, "A has 2 children (B and C)");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 6: Stash operations (7 tests)
  // ---------------------------------------------------------------
  console.log("--- Stash operations ---\n");

  console.log("19. pushStash/popStash — round-trip preserves nodes (cursor is global)...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://hn.com", "HN", "goto");
    const rootId = m.currentNodeId!;
    const article = m.addNavigation("https://hn.com/item/1", "Article 1", "choice");
    m.appendCursor(rootId, "goto");
    m.appendCursor(article.id, "choice");
    const crawlId = m.activeCrawl!.id;
    const crawlName = m.activeCrawl!.name;

    // Push onto stash
    const pushed = m.pushStash();
    assert(pushed === true, "pushStash returns true");
    assert(m.activeCrawl === null, "active crawl is null after push");
    assert(m.nodes.size === 0, "nodes empty after push");
    // Cursor is global — NOT cleared by pushStash
    assert(m.cursorHistory.length === 2, "global cursor preserved after push");
    assert(m.stash.length === 1, "stash has 1 entry");

    // Pop back
    const restored = m.popStash();
    assert(restored !== null, "popStash returns crawl");
    assert(restored!.id === crawlId, "restored crawl ID matches");
    assert(restored!.name === crawlName, "restored crawl name matches");
    assert(m.nodes.size === 2, "nodes restored (2)");
    // Cursor still global — untouched by pop
    assert(m.cursorHistory.length === 2, "global cursor still 2 entries after pop");
    assert(m.cursorIndex === 1, "cursorIndex unchanged");
    assert(m.currentNodeId === article.id, "currentNodeId restored");
    assert(m.stash.length === 0, "stash empty after pop");
  }
  console.log();

  console.log("20. stash cap at 10 — oldest entry dropped...");
  {
    const m = new CrawlManager();
    for (let i = 0; i < 12; i++) {
      m.createCrawl(`https://site${i}.com`, `Site ${i}`, "goto");
      m.appendCursor(m.currentNodeId!, "goto");
      m.pushStash();
    }
    assert(m.stash.length === 10, `stash capped at 10 (got ${m.stash.length})`);
    // The oldest two (site0, site1) should be dropped
    const firstStashedNode = m.stash[0].nodes.values().next().value as CrawlNode | undefined;
    assert(firstStashedNode?.url === "https://site2.com",
      "oldest stash entry is site2 (0 and 1 dropped)");
  }
  console.log();

  console.log("21. clear() clears stash+cursor, clearActive() preserves both...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://a.com", "A", "goto");
    m.appendCursor(m.currentNodeId!, "goto");
    m.pushStash();
    m.createCrawl("https://b.com", "B", "goto");
    m.appendCursor(m.currentNodeId!, "goto");
    m.pushStash();
    m.createCrawl("https://c.com", "C", "goto");
    m.appendCursor(m.currentNodeId!, "goto");
    assert(m.stash.length === 2, "2 stashed crawls");

    // clearActive preserves stash AND cursor
    m.clearActive();
    assert(m.activeCrawl === null, "active crawl cleared");
    assert(m.stash.length === 2, "stash preserved after clearActive");
    assert(m.cursorHistory.length === 3, "cursor preserved after clearActive");

    // clear() clears everything including cursor
    m.clear();
    assert(m.stash.length === 0, "stash cleared after clear()");
    assert(m.cursorHistory.length === 0, "cursor cleared after clear()");
  }
  console.log();

  console.log("22. getFullCursorHistory — annotates global cursor with crawl ownership...");
  {
    const m = new CrawlManager();
    // First crawl: 2 pages
    m.createCrawl("https://a.com", "A", "goto");
    m.appendCursor(m.currentNodeId!, "goto");
    const a2 = m.addNavigation("https://a.com/page2", "A2", "choice");
    m.appendCursor(a2.id, "choice");
    m.pushStash();

    // Second crawl: 1 page
    m.createCrawl("https://b.com", "B", "goto");
    m.appendCursor(m.currentNodeId!, "goto");

    const full = m.getFullCursorHistory();
    assert(full.length === 3, `full history has 3 entries (got ${full.length})`);
    // First 2 entries reference nodes in the stash
    assert(full[0].stashIndex === 0, "first entry from stash (index 0)");
    assert(full[1].stashIndex === 0, "second entry from stash (index 0)");
    // Third entry references node in active crawl
    assert(full[2].stashIndex === -1, "third entry from active crawl");
    assert(full[0].crawlName !== undefined, "stash entries have crawlName");
  }
  console.log();

  console.log("23. getNodeAcrossStash — finds nodes in stash and active...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://stashed.com", "Stashed", "goto");
    const stashedNodeId = m.currentNodeId!;
    m.pushStash();

    m.createCrawl("https://active.com", "Active", "goto");
    const activeNodeId = m.currentNodeId!;

    const fromActive = m.getNodeAcrossStash(activeNodeId);
    assert(fromActive !== null, "found node in active crawl");
    assert(fromActive!.url === "https://active.com", "correct active node");

    const fromStash = m.getNodeAcrossStash(stashedNodeId);
    assert(fromStash !== null, "found node in stash");
    assert(fromStash!.url === "https://stashed.com", "correct stashed node");

    const missing = m.getNodeAcrossStash("nonexistent");
    assert(missing === null, "returns null for missing node");
  }
  console.log();

  console.log("24. multiple push/pop — LIFO ordering...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://first.com", "First", "goto");
    m.pushStash();
    m.createCrawl("https://second.com", "Second", "goto");
    m.pushStash();
    m.createCrawl("https://third.com", "Third", "goto");
    m.pushStash();

    assert(m.stash.length === 3, "3 stashed");
    const popped1 = m.popStash();
    assert(popped1 !== null, "pop 1 returns crawl");
    // Check the restored node URL
    assert(m.findNodeByUrl("https://third.com") !== null, "third popped first (LIFO)");

    const popped2 = m.popStash();
    assert(popped2 !== null, "pop 2 returns crawl");
    assert(m.findNodeByUrl("https://second.com") !== null, "second popped second");

    const popped3 = m.popStash();
    assert(popped3 !== null, "pop 3 returns crawl");
    assert(m.findNodeByUrl("https://first.com") !== null, "first popped third");

    const popped4 = m.popStash();
    assert(popped4 === null, "pop 4 returns null (empty stash)");
  }
  console.log();

  console.log("25. pushStash with no active crawl returns false...");
  {
    const m = new CrawlManager();
    const result = m.pushStash();
    assert(result === false, "pushStash returns false with no active crawl");
    assert(m.stash.length === 0, "stash still empty");
  }
  console.log();

  // ---------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------
  cleanup();
  setCrawlDir(null); // reset override

  // ---------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------
  const total = passed + failed;
  console.log(`=== ${passed} passed, ${failed} failed (${total} total) ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  cleanup();
  setCrawlDir(null);
  console.error("Test failed:", err);
  process.exit(1);
});
