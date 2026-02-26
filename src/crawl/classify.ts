import { CrawlManager, CrawlNode, Crawl, CursorEntry } from "./tree";
import { GoalContext, LLMProvider } from "../llm/provider";
import { CLASSIFY_CRAWL_SYSTEM_PROMPT } from "../llm/prompts";

// ===================================================================
// Types
// ===================================================================

export type CrawlLifecycle = "open" | "done" | "overdue" | "stale";
export type CrawlTag = "research" | "lookup" | "task" | "exploration" | "reference" | "sensitive";
export type NodeStatus = "live" | "dead" | "pruned";

export interface CrawlMeta {
  lifecycle: CrawlLifecycle;
  lifecycleReason?: string;
  lifecycleUpdatedAt: number;
  tags: CrawlTag[];
  pinned: boolean;
  noise?: boolean;
  sensitive?: boolean;
  mergedFrom?: string[];
  mergedInto?: string;
}

export interface NodeClassification {
  status: NodeStatus;
  deadReason?: "404" | "error" | "empty" | "immediate_back" | "abandoned";
}

export interface ClassificationResult {
  lifecycle: CrawlLifecycle;
  lifecycleReason: string;
  tags: CrawlTag[];
  noise: boolean;
  sensitive: boolean;
  confidence: number;
}

// ===================================================================
// Default CrawlMeta
// ===================================================================

export function defaultCrawlMeta(): CrawlMeta {
  return {
    lifecycle: "open",
    lifecycleUpdatedAt: Date.now(),
    tags: [],
    pinned: false,
  };
}

// ===================================================================
// Sensitive URL patterns
// ===================================================================

const SENSITIVE_PATTERNS = [
  /\/auth\//i,
  /\/login/i,
  /\/signin/i,
  /\/billing/i,
  /\/payment/i,
  /\/account/i,
  /\/checkout/i,
  /\/password/i,
  /\/credentials/i,
];

function isSensitiveUrl(url: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(url));
}

// ===================================================================
// Node classification (heuristic)
// ===================================================================

export function classifyNodeHeuristic(
  node: CrawlNode,
  allNodes: Map<string, CrawlNode>,
  cursorHistory: CursorEntry[],
): NodeClassification {
  // Check HTTP status
  if (node.metadata?.httpStatus && node.metadata.httpStatus >= 400) {
    return { status: "dead", deadReason: "404" };
  }

  // Check summary for error indicators
  const summary = node.metadata?.summary || "";
  if (summary.includes("could not reach") || summary.includes("returned HTTP")) {
    return { status: "dead", deadReason: "error" };
  }
  if (summary.includes("content is empty")) {
    return { status: "dead", deadReason: "empty" };
  }

  // Immediate back: leaf node, cursor shows visit then back within 5s
  const isLeaf = node.children.length === 0;
  if (isLeaf) {
    const visitIdx = cursorHistory.findIndex((e) => e.nodeId === node.id);
    if (visitIdx >= 0 && visitIdx < cursorHistory.length - 1) {
      const visit = cursorHistory[visitIdx];
      const next = cursorHistory[visitIdx + 1];
      if (next.reachedBy === "back" && next.timestamp - visit.timestamp < 5000) {
        return { status: "dead", deadReason: "immediate_back" };
      }
    }

    // Abandoned: leaf, no summary, no interpretation, >1h old
    if (!node.metadata?.summary && !node.metadata?.interpretation && Date.now() - node.timestamp > 3600000) {
      return { status: "dead", deadReason: "abandoned" };
    }
  }

  return { status: "live" };
}

// ===================================================================
// Crawl classification (heuristic)
// ===================================================================

// Common stop words to filter out when comparing goal keywords
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "shall", "can", "need", "dare",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "both",
  "each", "few", "more", "most", "other", "some", "such", "no", "nor",
  "not", "only", "own", "same", "so", "than", "too", "very", "just",
  "because", "but", "and", "or", "if", "while", "about", "up", "down",
  "i", "me", "my", "we", "our", "you", "your", "it", "its", "they",
  "them", "their", "this", "that", "these", "those", "what", "which",
  "who", "whom", "browsing", "check", "find", "look", "get", "see",
]);

export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

interface ClassifyCrawlInput {
  crawl: Crawl;
  nodes: Map<string, CrawlNode>;
  goalContext?: GoalContext;
  sessionDurationMs: number;
}

export function classifyCrawlHeuristic(input: ClassifyCrawlInput): ClassificationResult {
  const { crawl, nodes, goalContext, sessionDurationMs } = input;
  const nodeArray = Array.from(nodes.values());
  const nodeCount = nodeArray.length;

  // Defaults
  let lifecycle: CrawlLifecycle = "open";
  let lifecycleReason = "active crawl";
  const tags: CrawlTag[] = [];
  let noise = false;
  let sensitive = false;
  let confidence = 0.7;

  // Check for sensitive URLs
  for (const node of nodeArray) {
    if (isSensitiveUrl(node.url)) {
      sensitive = true;
      break;
    }
  }
  if (sensitive) tags.push("sensitive");

  // === Lifecycle ===

  // Done: confirmation pageType in node tree, or data extracted matching goal
  const hasConfirmation = nodeArray.some(
    (n) => n.metadata?.interpretation?.pageType === "confirmation",
  );
  const hasDataFound = nodeArray.some(
    (n) => n.metadata?.interpretation?.dataFound != null,
  );
  if (hasConfirmation) {
    lifecycle = "done";
    lifecycleReason = "confirmation page reached";
    confidence = 0.9;
  } else if (hasDataFound) {
    lifecycle = "done";
    lifecycleReason = "data extracted";
    confidence = 0.8;
  }

  // Overdue: crawl > 24h old, no visits in last 10 min of session, explicit goal
  if (lifecycle === "open") {
    const crawlAgeMs = Date.now() - crawl.created;
    const hasExplicitGoal = goalContext?.baseGoal && !goalContext.baseGoal.startsWith("browsing ");

    if (crawlAgeMs > 24 * 3600000 && hasExplicitGoal) {
      // Check if there were recent visits (within last 10 min of session)
      const sessionEnd = crawl.lastAccessed;
      const cutoff = sessionEnd - 10 * 60000;
      const recentVisits = nodeArray.filter((n) => n.timestamp > cutoff);
      if (recentVisits.length === 0) {
        lifecycle = "overdue";
        lifecycleReason = "crawl >24h old with no recent activity";
        confidence = 0.6;
      }
    }
  }

  // Stale: lastAccessed > 48h ago
  if (lifecycle === "open") {
    const staleCutoff = Date.now() - 48 * 3600000;
    if (crawl.lastAccessed < staleCutoff) {
      lifecycle = "stale";
      lifecycleReason = "no access in 48+ hours";
      confidence = 0.8;
    }
  }

  // === Tags ===

  // Lookup: ≤3 nodes, <2min session
  if (nodeCount <= 3 && sessionDurationMs < 120000) {
    tags.push("lookup");
  }

  // Task: non-generic baseGoal (not starting with "browsing ")
  if (goalContext?.baseGoal && !goalContext.baseGoal.startsWith("browsing ")) {
    tags.push("task");
  }

  // Research: ≥5 nodes, depth ≥ 3
  if (nodeCount >= 5) {
    const maxDepth = computeMaxDepth(crawl.rootId, nodes);
    if (maxDepth >= 3) {
      tags.push("research");
    }
  }

  // Exploration: generic goal (browsing X) with ≥3 nodes
  if (goalContext?.baseGoal?.startsWith("browsing ") && nodeCount >= 3) {
    if (!tags.includes("research")) {
      tags.push("exploration");
    }
  }

  // === Noise ===
  // ≤2 nodes, <30s, no summary on root
  const rootNode = nodes.get(crawl.rootId);
  if (nodeCount <= 2 && sessionDurationMs < 30000 && !rootNode?.metadata?.summary) {
    noise = true;
    confidence = 0.9;
  }

  return { lifecycle, lifecycleReason, tags, noise, sensitive, confidence };
}

// ===================================================================
// Helpers
// ===================================================================

function computeMaxDepth(rootId: string, nodes: Map<string, CrawlNode>): number {
  let maxDepth = 0;
  const walk = (nodeId: string, depth: number): void => {
    if (depth > maxDepth) maxDepth = depth;
    const node = nodes.get(nodeId);
    if (!node) return;
    for (const childId of node.children) {
      walk(childId, depth + 1);
    }
  };
  walk(rootId, 0);
  return maxDepth;
}

// ===================================================================
// LLM Classification
// ===================================================================

/**
 * Format a crawl tree into a compact summary for LLM classification (~500 tokens).
 */
export function formatCrawlForClassification(
  manager: CrawlManager,
  goalContext?: GoalContext,
): string {
  if (!manager.activeCrawl) return "";

  const lines: string[] = [];
  const crawl = manager.activeCrawl;

  lines.push(`Crawl: "${crawl.name}"`);
  if (goalContext?.baseGoal) lines.push(`Goal: ${goalContext.baseGoal}`);
  if (goalContext?.activeIntent) lines.push(`Intent: ${goalContext.activeIntent}`);
  lines.push(`Nodes: ${manager.nodes.size}`);
  lines.push(`Duration: ${Math.round((crawl.lastAccessed - crawl.created) / 60000)}min`);
  lines.push(`Age: ${Math.round((Date.now() - crawl.lastAccessed) / 3600000)}h since last access`);
  lines.push("");
  lines.push("Tree:");

  const buildTree = (nodeId: string, depth: number): void => {
    const node = manager.nodes.get(nodeId);
    if (!node) return;
    const indent = "  ".repeat(depth);
    const summary = node.metadata?.summary
      ? ` — ${node.metadata.summary.slice(0, 80)}`
      : "";
    const pageType = node.metadata?.interpretation?.pageType
      ? ` [${node.metadata.interpretation.pageType}]`
      : "";
    const statusStr = node.metadata?.classification?.status === "dead"
      ? ` (dead: ${node.metadata.classification.deadReason})`
      : "";
    lines.push(`${indent}- ${node.title}${pageType}${statusStr}${summary}`);
    for (const childId of node.children) {
      buildTree(childId, depth + 1);
    }
  };
  buildTree(crawl.rootId, 0);

  return lines.join("\n");
}

/**
 * Use LLM to classify a crawl when heuristic confidence is low.
 */
export async function classifyCrawlLLM(
  llm: LLMProvider,
  crawlSummary: string,
  goalContext: GoalContext | undefined,
  heuristicResult: ClassificationResult,
): Promise<ClassificationResult> {
  const userMessage = `${crawlSummary}\n\nHeuristic classification: lifecycle=${heuristicResult.lifecycle}, tags=${heuristicResult.tags.join(",")}, confidence=${heuristicResult.confidence}`;

  try {
    const response = await llm.interpret(
      userMessage,
      CLASSIFY_CRAWL_SYSTEM_PROMPT,
    );
    // The LLM returns a PageInterpretation, but we're repurposing interpret()
    // We need to parse the summary field as JSON
    const text = response.summary || "";

    // Try to extract JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return heuristicResult;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      lifecycle: parsed.lifecycle || heuristicResult.lifecycle,
      lifecycleReason: parsed.lifecycleReason || heuristicResult.lifecycleReason,
      tags: Array.isArray(parsed.tags) ? parsed.tags : heuristicResult.tags,
      noise: heuristicResult.noise,
      sensitive: heuristicResult.sensitive,
      confidence: 0.9,
    };
  } catch {
    // LLM call failed — fall back to heuristic
    return heuristicResult;
  }
}
