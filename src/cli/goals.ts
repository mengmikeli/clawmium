import { GoalContext } from "../llm/provider";

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
