import { CrawlManager } from "./tree";

/**
 * Format the ancestor chain of the current crawl node as context for the LLM.
 * Returns empty string if no crawl or only the root node.
 */
export function formatAncestorContext(manager: CrawlManager, maxAncestors = 3): string {
  if (!manager.activeCrawl || !manager.currentNodeId) return "";

  const ancestors = manager.getAncestors(manager.currentNodeId);
  if (ancestors.length <= 1) return "";

  // ancestors is leaf-to-root — reverse to root-to-leaf
  const rootToLeaf = [...ancestors].reverse();

  // Take the last maxAncestors entries (closest to current page)
  const slice = rootToLeaf.slice(-maxAncestors);

  const lines: string[] = ["Navigation path:"];
  for (let i = 0; i < slice.length; i++) {
    const node = slice[i];
    const num = i + 1;
    const isCurrentPage = node.id === manager.currentNodeId;

    if (isCurrentPage) {
      lines.push(`${num}. "${node.title}" (current page)`);
    } else {
      const summaryClause = node.metadata?.summary
        ? " \u2014 " + (node.metadata.summary.split(/[.]/)[0] || "").trim()
        : "";
      lines.push(`${num}. "${node.title}"${summaryClause}`);
    }
  }

  return lines.join("\n");
}

/**
 * Derive breadcrumb trail from the crawl tree's ancestors.
 * Returns ancestor titles (root-to-leaf, excluding current node), last `max` entries.
 * Returns [] if no crawl.
 */
export function breadcrumbFromTree(manager: CrawlManager, max = 3): string[] {
  if (!manager.activeCrawl || !manager.currentNodeId) return [];

  const ancestors = manager.getAncestors(manager.currentNodeId);
  if (ancestors.length <= 1) return [];

  // ancestors is leaf-to-root — reverse to root-to-leaf, exclude current node (first in original array)
  const rootToLeaf = [...ancestors].reverse();
  // Exclude the current page (last element)
  const withoutCurrent = rootToLeaf.slice(0, -1);

  return withoutCurrent.slice(-max).map((n) => n.title);
}
