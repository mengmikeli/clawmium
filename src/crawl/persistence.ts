import * as fs from "fs";
import * as path from "path";
import { CrawlManager, CrawlNode, Crawl, ReachedBy } from "./tree";

// ===================================================================
// Paths
// ===================================================================

const CLM_DIR = path.join(process.env.HOME || "~", "clm");
const CRAWL_DIR = path.join(CLM_DIR, "crawls");

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Override crawl directory for testing */
let crawlDirOverride: string | null = null;
export function setCrawlDir(dir: string | null): void {
  crawlDirOverride = dir;
}
function getCrawlDir(): string {
  return crawlDirOverride || CRAWL_DIR;
}

// ===================================================================
// Save
// ===================================================================

export function saveCrawl(manager: CrawlManager): string {
  if (!manager.activeCrawl) throw new Error("No active crawl to save");

  const dir = getCrawlDir();
  ensureDir(dir);

  const crawl = manager.activeCrawl;
  const rootNode = manager.nodes.get(crawl.rootId)!;
  const lines: string[] = [];

  // Header
  lines.push(`# ${crawl.name}`);
  lines.push("");
  lines.push(`**Created:** ${new Date(crawl.created).toISOString()}`);
  lines.push(`**Last Accessed:** ${new Date(crawl.lastAccessed).toISOString()}`);
  lines.push(`**Root:** ${rootNode.url}`);
  lines.push(`**Crawl ID:** ${crawl.id}`);
  lines.push(`**Root ID:** ${crawl.rootId}`);
  lines.push("");

  // Tree section
  lines.push("## Tree");
  lines.push("");
  const buildTreeLines = (nodeId: string, depth: number): void => {
    const node = manager.nodes.get(nodeId);
    if (!node) return;
    const indent = "  ".repeat(depth);
    lines.push(`${indent}- [${node.title}](${node.url}) \`${node.id}\` \`${node.reachedBy}\``);
    for (const childId of node.children) {
      buildTreeLines(childId, depth + 1);
    }
  };
  buildTreeLines(crawl.rootId, 0);
  lines.push("");

  // Nodes section
  lines.push("## Nodes");
  lines.push("");

  // Serialize in tree order (BFS from root) for deterministic output
  const queue = [crawl.rootId];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const node = manager.nodes.get(nodeId);
    if (!node) continue;

    lines.push(`### ${node.id}`);
    lines.push(`- **URL:** ${node.url}`);
    lines.push(`- **Title:** ${node.title}`);
    lines.push(`- **Timestamp:** ${new Date(node.timestamp).toISOString()}`);
    lines.push(`- **Parent:** ${node.parentId || "(root)"}`);
    lines.push(`- **Reached By:** ${node.reachedBy}`);
    lines.push(`- **Children:** ${node.children.length > 0 ? node.children.join(", ") : "(none)"}`);
    if (node.metadata) {
      if (node.metadata.summary) {
        lines.push(`- **Summary:** ${node.metadata.summary}`);
      }
      if (node.metadata.conversationSnippets && node.metadata.conversationSnippets.length > 0) {
        lines.push(`- **Snippets:** ${node.metadata.conversationSnippets.join(" | ")}`);
      }
    }
    lines.push("");

    queue.push(...node.children);
  }

  const filepath = path.join(dir, `${crawl.id}.md`);
  fs.writeFileSync(filepath, lines.join("\n"));
  return filepath;
}

// ===================================================================
// Load
// ===================================================================

export function loadCrawl(crawlId: string, manager: CrawlManager): boolean {
  const dir = getCrawlDir();
  const filepath = path.join(dir, `${crawlId}.md`);
  if (!fs.existsSync(filepath)) return false;

  const content = fs.readFileSync(filepath, "utf-8");

  try {
    // Split into header+tree and nodes sections
    const nodesSplit = content.split("## Nodes");
    if (nodesSplit.length < 2) return false;

    const headerSection = nodesSplit[0];
    const nodesSection = nodesSplit[1];

    // Parse header
    const nameMatch = headerSection.match(/^# (.+)$/m);
    const createdMatch = headerSection.match(/\*\*Created:\*\* (.+)$/m);
    const lastAccessedMatch = headerSection.match(/\*\*Last Accessed:\*\* (.+)$/m);
    const crawlIdMatch = headerSection.match(/\*\*Crawl ID:\*\* (.+)$/m);
    const rootIdMatch = headerSection.match(/\*\*Root ID:\*\* (.+)$/m);

    if (!nameMatch || !createdMatch || !lastAccessedMatch || !crawlIdMatch || !rootIdMatch) {
      return false;
    }

    const crawl: Crawl = {
      id: crawlIdMatch[1].trim(),
      rootId: rootIdMatch[1].trim(),
      name: nameMatch[1].trim(),
      created: new Date(createdMatch[1].trim()).getTime(),
      lastAccessed: new Date(lastAccessedMatch[1].trim()).getTime(),
    };

    // Parse nodes
    const nodeBlocks = nodesSection.split(/^### /m).filter((b) => b.trim().length > 0);
    const nodes = new Map<string, CrawlNode>();

    for (const block of nodeBlocks) {
      const blockLines = block.trim().split("\n");
      const id = blockLines[0].trim();

      const urlMatch = block.match(/- \*\*URL:\*\* (.+)$/m);
      const titleMatch = block.match(/- \*\*Title:\*\* (.+)$/m);
      const timestampMatch = block.match(/- \*\*Timestamp:\*\* (.+)$/m);
      const parentMatch = block.match(/- \*\*Parent:\*\* (.+)$/m);
      const reachedByMatch = block.match(/- \*\*Reached By:\*\* (.+)$/m);
      const childrenMatch = block.match(/- \*\*Children:\*\* (.+)$/m);
      const summaryMatch = block.match(/- \*\*Summary:\*\* (.+)$/m);
      const snippetsMatch = block.match(/- \*\*Snippets:\*\* (.+)$/m);

      if (!urlMatch || !titleMatch || !timestampMatch || !parentMatch || !reachedByMatch || !childrenMatch) {
        continue;
      }

      const parentRaw = parentMatch[1].trim();
      const childrenRaw = childrenMatch[1].trim();

      const node: CrawlNode = {
        id,
        url: urlMatch[1].trim(),
        title: titleMatch[1].trim(),
        timestamp: new Date(timestampMatch[1].trim()).getTime(),
        parentId: parentRaw === "(root)" ? null : parentRaw,
        reachedBy: reachedByMatch[1].trim() as ReachedBy,
        children: childrenRaw === "(none)" ? [] : childrenRaw.split(",").map((s) => s.trim()),
      };

      if (summaryMatch || snippetsMatch) {
        node.metadata = {};
        if (summaryMatch) node.metadata.summary = summaryMatch[1].trim();
        if (snippetsMatch) node.metadata.conversationSnippets = snippetsMatch[1].trim().split(" | ");
      }

      nodes.set(id, node);
    }

    // Apply to manager
    manager.activeCrawl = crawl;
    manager.nodes = nodes;
    manager.currentNodeId = crawl.rootId;
    manager.rebuildIndex();

    return true;
  } catch {
    return false;
  }
}

// ===================================================================
// List
// ===================================================================

export function listCrawls(): string[] {
  const dir = getCrawlDir();
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(".md", ""));
}
