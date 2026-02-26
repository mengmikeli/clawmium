import { CrawlManager, CrawlNode } from "./tree";
import { classifyNodeHeuristic } from "./classify";

// ===================================================================
// Types
// ===================================================================

export interface PruneResult {
  prunedNodeIds: string[];
  prunedCount: number;
  reasons: string[];
}

interface DeadBranch {
  rootNodeId: string;
  deadNodeIds: string[];
  reason: string;
}

// ===================================================================
// Find dead branches
// ===================================================================

/**
 * Walk leaves upward to find dead branches.
 * A branch is dead if:
 * 1. The leaf is dead (by classification)
 * 2. All siblings are also dead, and parent has no meaningful content → parent is dead too
 * 3. Propagate up until a live parent or root is found
 *
 * Never marks as dead: root, current cursor position, any node in cursor history.
 */
export function findDeadBranches(manager: CrawlManager): DeadBranch[] {
  if (!manager.activeCrawl) return [];

  // Build set of protected nodes
  const protectedIds = new Set<string>();
  protectedIds.add(manager.activeCrawl.rootId);
  if (manager.currentNodeId) protectedIds.add(manager.currentNodeId);
  for (const entry of manager.cursorHistory) {
    protectedIds.add(entry.nodeId);
  }

  // First pass: classify all unclassified nodes
  for (const node of manager.nodes.values()) {
    if (!node.metadata?.classification) {
      const classification = classifyNodeHeuristic(node, manager.nodes, manager.cursorHistory);
      if (!node.metadata) node.metadata = {};
      node.metadata.classification = classification;
    }
  }

  // Second pass: propagate dead status upward
  // A non-leaf is dead if all its children are dead AND it has no meaningful content
  const deadSet = new Set<string>();
  const markDead = (): boolean => {
    let changed = false;
    for (const node of manager.nodes.values()) {
      if (deadSet.has(node.id)) continue;
      if (protectedIds.has(node.id)) continue;

      // Leaf: check classification
      if (node.children.length === 0) {
        if (node.metadata?.classification?.status === "dead") {
          deadSet.add(node.id);
          changed = true;
        }
        continue;
      }

      // Non-leaf: all children must be dead
      const allChildrenDead = node.children.every((cid) => deadSet.has(cid));
      if (!allChildrenDead) continue;

      // Parent must have no meaningful content
      const hasMeaningfulContent = node.metadata?.summary &&
        !node.metadata.summary.includes("could not reach") &&
        !node.metadata.summary.includes("returned HTTP") &&
        !node.metadata.summary.includes("content is empty");
      if (hasMeaningfulContent) continue;

      deadSet.add(node.id);
      changed = true;
    }
    return changed;
  };

  // Iterate until no more changes (propagation converges)
  while (markDead()) { /* keep propagating */ }

  // Find the roots of dead subtrees (dead nodes whose parent is NOT dead)
  const deadBranches: DeadBranch[] = [];
  for (const nodeId of deadSet) {
    const node = manager.nodes.get(nodeId)!;
    if (!node.parentId || !deadSet.has(node.parentId)) {
      // This is a dead branch root
      const subtreeIds = manager.getSubtreeIds(nodeId).filter((id) => deadSet.has(id));
      const leafNode = manager.nodes.get(nodeId);
      const reason = leafNode?.metadata?.classification?.deadReason || "dead branch";
      deadBranches.push({
        rootNodeId: nodeId,
        deadNodeIds: subtreeIds,
        reason,
      });
    }
  }

  return deadBranches;
}

// ===================================================================
// Prune
// ===================================================================

export function pruneCrawl(manager: CrawlManager, opts?: { dryRun?: boolean }): PruneResult {
  const branches = findDeadBranches(manager);
  const result: PruneResult = {
    prunedNodeIds: [],
    prunedCount: 0,
    reasons: [],
  };

  if (branches.length === 0) return result;

  for (const branch of branches) {
    result.reasons.push(`${branch.deadNodeIds.length} node(s): ${branch.reason}`);
    if (!opts?.dryRun) {
      const removed = manager.removeSubtree(branch.rootNodeId);
      result.prunedNodeIds.push(...removed);
    } else {
      result.prunedNodeIds.push(...branch.deadNodeIds);
    }
  }

  result.prunedCount = result.prunedNodeIds.length;
  return result;
}
