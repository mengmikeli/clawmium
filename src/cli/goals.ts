import { GoalContext } from "../llm/provider";
import { CrawlManager } from "../crawl/tree";
import { breadcrumbFromTree } from "../crawl/context";

/**
 * Format the GoalContext into a string for LLM calls.
 */
export function formatGoal(gc: GoalContext): string {
  let goal = gc.baseGoal;
  if (gc.activeIntent) {
    goal += ` — currently: ${gc.activeIntent}`;
  }
  if (gc.breadcrumb.length > 0) {
    goal += ` (path: ${gc.breadcrumb.join(" → ")})`;
  }
  return goal;
}

/**
 * Add a navigation step to the breadcrumb trail (caps at 3).
 */
export function addBreadcrumb(gc: GoalContext, label: string): void {
  gc.breadcrumb.push(label);
  if (gc.breadcrumb.length > 3) {
    gc.breadcrumb.shift();
  }
}

/**
 * Format goal with tree-derived breadcrumb when crawl is active.
 * Falls back to GoalContext.breadcrumb when no crawl.
 */
export function formatGoalWithCrawl(gc: GoalContext, crawlManager: CrawlManager): string {
  let goal = gc.baseGoal;
  if (gc.activeIntent) {
    goal += ` — currently: ${gc.activeIntent}`;
  }
  const crumbs = crawlManager.activeCrawl
    ? breadcrumbFromTree(crawlManager)
    : gc.breadcrumb;
  if (crumbs.length > 0) {
    goal += ` (path: ${crumbs.join(" → ")})`;
  }
  return goal;
}
