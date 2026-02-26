import * as crypto from "crypto";
import { CrawlManager, CrawlNode, Crawl } from "./tree";
import { CrawlPeek, loadCrawl } from "./persistence";
import { extractKeywords } from "./classify";
import { GoalContext } from "../llm/provider";

// ===================================================================
// Types
// ===================================================================

export interface MergeCandidate {
  crawlId: string;
  crawlName: string;
  similarity: number;
  reason: string;
}

export interface GraftResult {
  graftedNodeCount: number;
  newRootId: string;
}

// ===================================================================
// Merge candidate detection
// ===================================================================

export function findMergeCandidates(
  targetId: string,
  allCrawls: CrawlPeek[],
  targetNodes: Map<string, CrawlNode>,
  targetGoal?: GoalContext,
): MergeCandidate[] {
  const targetUrls = new Set<string>();
  let targetDomain = "";
  for (const node of targetNodes.values()) {
    targetUrls.add(node.url);
    if (!targetDomain) {
      try { targetDomain = new URL(node.url).hostname; } catch { /* ignore */ }
    }
  }

  const targetKeywords = targetGoal?.baseGoal ? extractKeywords(targetGoal.baseGoal) : [];
  const candidates: MergeCandidate[] = [];

  for (const peek of allCrawls) {
    if (peek.id === targetId) continue;

    let score = 0;
    const reasons: string[] = [];

    // Same root domain
    let peekDomain = "";
    try { peekDomain = new URL(peek.rootUrl).hostname; } catch { /* ignore */ }
    if (peekDomain && targetDomain && peekDomain === targetDomain) {
      score += 0.6;
      reasons.push("same domain");
    }

    // To check shared URLs, we'd need to load the crawl — skip for now, just use URL hostname
    // Shared root URL check (lightweight)
    if (targetUrls.has(peek.rootUrl)) {
      score += 0.3;
      reasons.push("shared root URL");
    }

    // Related goal keywords
    if (targetKeywords.length > 0 && peek.name) {
      const peekKeywords = extractKeywords(peek.name);
      let matches = 0;
      for (const kw of targetKeywords) {
        if (peekKeywords.includes(kw)) matches++;
      }
      const keywordScore = Math.min(0.6, matches * 0.2);
      if (keywordScore > 0) {
        score += keywordScore;
        reasons.push(`${matches} shared keyword(s)`);
      }
    }

    if (score >= 0.5) {
      candidates.push({
        crawlId: peek.id,
        crawlName: peek.name,
        similarity: Math.min(1, score),
        reason: reasons.join(", "),
      });
    }
  }

  // Sort by similarity descending
  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates;
}

// ===================================================================
// Graft operation
// ===================================================================

/**
 * Graft all nodes from sourceManager into targetManager.
 * Re-IDs all source nodes (new UUIDs), attaches source root under attachToNodeId (or target root).
 * Updates target meta.mergedFrom[].
 */
export function graftCrawl(
  targetManager: CrawlManager,
  sourceManager: CrawlManager,
  attachToNodeId?: string,
): GraftResult {
  if (!targetManager.activeCrawl || !sourceManager.activeCrawl) {
    return { graftedNodeCount: 0, newRootId: "" };
  }

  const attachTo = attachToNodeId || targetManager.activeCrawl.rootId;
  if (!targetManager.nodes.has(attachTo)) {
    return { graftedNodeCount: 0, newRootId: "" };
  }

  // Build ID remapping
  const idMap = new Map<string, string>();
  for (const nodeId of sourceManager.nodes.keys()) {
    idMap.set(nodeId, crypto.randomUUID());
  }

  const sourceRootId = sourceManager.activeCrawl.rootId;
  const newRootId = idMap.get(sourceRootId) || "";

  // Copy nodes with new IDs
  let graftedCount = 0;
  for (const [oldId, node] of sourceManager.nodes) {
    const newId = idMap.get(oldId)!;
    const newNode: CrawlNode = {
      id: newId,
      url: node.url,
      title: node.title,
      timestamp: node.timestamp,
      parentId: oldId === sourceRootId ? attachTo : (node.parentId ? idMap.get(node.parentId) || null : null),
      reachedBy: node.reachedBy,
      children: node.children.map((cid) => idMap.get(cid) || cid),
    };
    if (node.metadata) {
      newNode.metadata = { ...node.metadata };
      if (node.metadata.conversationSnippets) {
        newNode.metadata.conversationSnippets = [...node.metadata.conversationSnippets];
      }
    }

    // Skip if URL already exists in target (dedup)
    if (targetManager.findNodeByUrl(newNode.url)) continue;

    targetManager.nodes.set(newId, newNode);
    targetManager.nodeIndex.set(newNode.url, newNode);
    graftedCount++;
  }

  // Wire source root as child of attach point
  const attachNode = targetManager.nodes.get(attachTo);
  if (attachNode && newRootId && targetManager.nodes.has(newRootId)) {
    attachNode.children.push(newRootId);
  }

  // Update meta
  const meta = targetManager.getCrawlMeta();
  const mergedFrom = meta.mergedFrom || [];
  mergedFrom.push(sourceManager.activeCrawl.id);
  targetManager.setCrawlMeta({ mergedFrom });

  return { graftedNodeCount: graftedCount, newRootId };
}

// ===================================================================
// Branch move
// ===================================================================

/**
 * Move a subtree from sourceManager to targetManager.
 * Detaches from source, re-IDs, attaches to target.
 */
export function moveBranch(
  sourceManager: CrawlManager,
  targetManager: CrawlManager,
  branchRootId: string,
  attachToNodeId?: string,
): boolean {
  if (!sourceManager.activeCrawl || !targetManager.activeCrawl) return false;

  const branchNode = sourceManager.nodes.get(branchRootId);
  if (!branchNode) return false;

  // Can't move root
  if (branchRootId === sourceManager.activeCrawl.rootId) return false;

  const attachTo = attachToNodeId || targetManager.activeCrawl.rootId;
  if (!targetManager.nodes.has(attachTo)) return false;

  // Get all nodes in subtree
  const subtreeIds = sourceManager.getSubtreeIds(branchRootId);
  const subtreeNodes = new Map<string, CrawlNode>();
  for (const id of subtreeIds) {
    const node = sourceManager.nodes.get(id);
    if (node) subtreeNodes.set(id, node);
  }

  // Build temp manager for graft
  const tempManager = new CrawlManager();
  tempManager.activeCrawl = {
    id: crypto.randomUUID(),
    rootId: branchRootId,
    name: "temp",
    created: Date.now(),
    lastAccessed: Date.now(),
  };
  tempManager.nodes = subtreeNodes;
  tempManager.rebuildIndex();

  // Graft into target
  const result = graftCrawl(targetManager, tempManager, attachTo);

  if (result.graftedNodeCount > 0) {
    // Detach from source
    sourceManager.detachSubtree(branchRootId);
    // Remove nodes from source
    for (const id of subtreeIds) {
      const node = sourceManager.nodes.get(id);
      if (node) {
        sourceManager.nodeIndex.delete(node.url);
        sourceManager.nodes.delete(id);
      }
    }
    return true;
  }

  return false;
}
