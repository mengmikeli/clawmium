import { CrawlManager } from "./crawl/tree";
import {
  formatCrawlForClassification,
  classifyCrawlLLM,
  classifyCrawlHeuristic,
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

function makeMockLLM(response: { summary: string }): any {
  return {
    interpret: async () => ({
      pageType: "content",
      summary: response.summary,
      choices: [],
      dataFound: null,
      requiresAuth: false,
      requiresHumanInput: false,
    }),
    planAction: async () => ({}),
    planAutoAction: async () => ({}),
    extractData: async () => ({}),
  };
}

async function main() {
  console.log("=== Crawl Classify LLM Test Suite ===\n");

  // ---------------------------------------------------------------
  // GROUP 1: formatCrawlForClassification (8 tests)
  // ---------------------------------------------------------------
  console.log("--- formatCrawlForClassification ---\n");

  console.log("1. Returns empty for no active crawl...");
  {
    const m = new CrawlManager();
    const result = formatCrawlForClassification(m);
    assert(result === "", "empty string for no crawl");
  }
  console.log();

  console.log("2. Includes crawl name...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.activeCrawl!.name = "water bill research";
    const result = formatCrawlForClassification(m);
    assert(result.includes("water bill research"), "contains crawl name");
  }
  console.log();

  console.log("3. Includes goal...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    const goal = { baseGoal: "check my water bill", activeIntent: "", breadcrumb: [] as string[] };
    const result = formatCrawlForClassification(m, goal);
    assert(result.includes("check my water bill"), "contains goal");
  }
  console.log();

  console.log("4. Includes node count...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.addNavigation("https://example.com/p1", "P1", "choice");
    const result = formatCrawlForClassification(m);
    assert(result.includes("Nodes: 2"), "contains node count");
  }
  console.log();

  console.log("5. Includes tree structure...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.addNavigation("https://example.com/p1", "P1", "choice");
    const result = formatCrawlForClassification(m);
    assert(result.includes("Tree:"), "contains Tree header");
    assert(result.includes("Root"), "contains root title");
    assert(result.includes("P1"), "contains child title");
  }
  console.log();

  console.log("6. Includes node summaries...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.setNodeMetadata(m.currentNodeId!, { summary: "A page about weather" });
    const result = formatCrawlForClassification(m);
    assert(result.includes("A page about weather"), "contains summary");
  }
  console.log();

  console.log("7. Includes dead node status...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    const n1 = m.addNavigation("https://example.com/dead", "Dead", "choice");
    m.setNodeMetadata(n1.id, {
      classification: { status: "dead", deadReason: "404" },
    });
    const result = formatCrawlForClassification(m);
    assert(result.includes("dead: 404"), "contains dead status");
  }
  console.log();

  console.log("8. Includes page type...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.setNodeMetadata(m.currentNodeId!, {
      interpretation: {
        pageType: "navigation",
        summary: "Nav page",
        choices: [],
        dataFound: null,
        requiresAuth: false,
        requiresHumanInput: false,
      },
    });
    const result = formatCrawlForClassification(m);
    assert(result.includes("[navigation]"), "contains page type");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 2: classifyCrawlLLM (6 tests)
  // ---------------------------------------------------------------
  console.log("--- classifyCrawlLLM ---\n");

  console.log("9. Parses valid LLM JSON response...");
  {
    const mockLLM = makeMockLLM({
      summary: '{"lifecycle": "done", "lifecycleReason": "data was extracted", "tags": ["task"], "suggestMerge": false, "suggestPrune": false}',
    });
    const heuristic: ClassificationResult = {
      lifecycle: "open",
      lifecycleReason: "default",
      tags: [],
      noise: false,
      sensitive: false,
      confidence: 0.5,
    };
    const result = await classifyCrawlLLM(mockLLM, "crawl summary", undefined, heuristic);
    assert(result.lifecycle === "done", "lifecycle from LLM");
    assert(result.lifecycleReason === "data was extracted", "reason from LLM");
    assert(result.tags.includes("task"), "tags from LLM");
    assert(result.confidence === 0.9, "confidence boosted to 0.9");
  }
  console.log();

  console.log("10. Falls back to heuristic on parse error...");
  {
    const mockLLM = makeMockLLM({
      summary: "This is not valid JSON at all",
    });
    const heuristic: ClassificationResult = {
      lifecycle: "overdue",
      lifecycleReason: "test",
      tags: ["research"],
      noise: false,
      sensitive: false,
      confidence: 0.4,
    };
    const result = await classifyCrawlLLM(mockLLM, "crawl summary", undefined, heuristic);
    assert(result.lifecycle === "overdue", "falls back to heuristic lifecycle");
    assert(result.tags.includes("research"), "falls back to heuristic tags");
  }
  console.log();

  console.log("11. Falls back on LLM error...");
  {
    const mockLLM = {
      interpret: async () => { throw new Error("API error"); },
      planAction: async () => ({}),
      planAutoAction: async () => ({}),
      extractData: async () => ({}),
    };
    const heuristic: ClassificationResult = {
      lifecycle: "open",
      lifecycleReason: "default",
      tags: [],
      noise: false,
      sensitive: false,
      confidence: 0.5,
    };
    const result = await classifyCrawlLLM(mockLLM as any, "summary", undefined, heuristic);
    assert(result.lifecycle === "open", "falls back on error");
  }
  console.log();

  console.log("12. Preserves noise/sensitive from heuristic...");
  {
    const mockLLM = makeMockLLM({
      summary: '{"lifecycle": "done", "lifecycleReason": "found data", "tags": ["task"]}',
    });
    const heuristic: ClassificationResult = {
      lifecycle: "open",
      lifecycleReason: "default",
      tags: [],
      noise: true,
      sensitive: true,
      confidence: 0.5,
    };
    const result = await classifyCrawlLLM(mockLLM, "summary", undefined, heuristic);
    assert(result.noise === true, "noise preserved from heuristic");
    assert(result.sensitive === true, "sensitive preserved from heuristic");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 3: Confidence threshold gating (4 tests)
  // ---------------------------------------------------------------
  console.log("--- Confidence threshold ---\n");

  console.log("13. High confidence (>= 0.7) does not need LLM...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      sessionDurationMs: 60000,
    });
    assert(result.confidence >= 0.7, "default confidence is >= 0.7");
  }
  console.log();

  console.log("14. Overdue classification has low confidence...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    m.activeCrawl!.created = Date.now() - 26 * 3600000;
    m.activeCrawl!.lastAccessed = Date.now() - 25 * 3600000;
    const root = m.getNode(m.currentNodeId!)!;
    root.timestamp = Date.now() - 26 * 3600000;

    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      goalContext: { baseGoal: "check water bill", activeIntent: "", breadcrumb: [] },
      sessionDurationMs: 300000,
    });
    assert(result.confidence < 0.7, "overdue has low confidence (triggers LLM)");
  }
  console.log();

  console.log("15. Done with confirmation has high confidence...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    const n = m.addNavigation("https://example.com/confirm", "Confirm", "choice");
    m.setNodeMetadata(n.id, {
      interpretation: {
        pageType: "confirmation",
        summary: "Done",
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
    assert(result.confidence >= 0.7, "confirmation gives high confidence");
  }
  console.log();

  console.log("16. Noise has high confidence...");
  {
    const m = new CrawlManager();
    m.createCrawl("https://example.com", "Root", "goto");
    const result = classifyCrawlHeuristic({
      crawl: m.activeCrawl!,
      nodes: m.nodes,
      sessionDurationMs: 15000,
    });
    assert(result.noise === true, "is noise");
    assert(result.confidence >= 0.7, "noise has high confidence");
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
