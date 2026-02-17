import { PageInterpretation, AutoPlanResult, ExtractedData, LLMProvider } from "../llm/provider";
import { executeChoice, ExecutionDeps } from "./executor";
import * as render from "../cli/renderer";

// ===================================================================
// Types
// ===================================================================

export interface AutoConfig {
  maxSteps: number;              // default: 10
  maxSameUrl: number;            // same URL visited N times → stuck (default: 2)
  maxConsecutiveErrors: number;  // default: 2
}

export interface AutoStep {
  step: number;
  url: string;
  title: string;
  choiceLabel: string;      // what the agent picked
  reasoning: string;        // why (from planAction)
  timestamp: number;
}

export type AutoOutcome = "completed" | "cancelled" | "stuck" | "step_limit" | "login_failed";

export interface AutoResult {
  outcome: AutoOutcome;
  steps: AutoStep[];
  extracted?: ExtractedData;
  message: string;
}

export interface AutoDeps {
  llm: LLMProvider;
  execDeps: ExecutionDeps;
  syncBrowser: () => Promise<void>;
  interpretPage: () => Promise<PageInterpretation>;
  extractAndReturn: (rawData: string, goal: string) => Promise<ExtractedData>;
  handleAuth: () => Promise<boolean>;  // returns true if auth succeeded
  getEnrichedTree: () => string | null;
  getCurrentUrl: () => string;
  getCurrentTitle: () => string;
}

const DEFAULT_CONFIG: AutoConfig = {
  maxSteps: 10,
  maxSameUrl: 2,
  maxConsecutiveErrors: 2,
};

// ===================================================================
// Auto runner
// ===================================================================

/**
 * Run the autonomous browsing loop toward a goal.
 * The agent interprets pages, plans actions, and executes them
 * until it finds data, gets stuck, or reaches the step limit.
 */
export async function runAuto(
  goal: string,
  deps: AutoDeps,
  config?: Partial<AutoConfig>,
  signal?: AbortSignal,
): Promise<AutoResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const steps: AutoStep[] = [];
  const urlVisitCounts = new Map<string, number>();
  let consecutiveErrors = 0;

  for (let step = 1; step <= cfg.maxSteps; step++) {
    // Check abort
    if (signal?.aborted) {
      return { outcome: "cancelled", steps, message: "cancelled by user" };
    }

    // 1. Sync browser
    try {
      await deps.syncBrowser();
    } catch (err) {
      consecutiveErrors++;
      if (consecutiveErrors >= cfg.maxConsecutiveErrors) {
        return { outcome: "stuck", steps, message: `browser recovery failed after ${consecutiveErrors} errors` };
      }
      continue;
    }

    // 2. Interpret page (no rendering)
    render.autoProgress(step, cfg.maxSteps, "analyzing page...");
    let interpretation: PageInterpretation;
    try {
      interpretation = await deps.interpretPage();
    } catch (err) {
      consecutiveErrors++;
      if (consecutiveErrors >= cfg.maxConsecutiveErrors) {
        return { outcome: "stuck", steps, message: `LLM interpret failed: ${(err as Error).message}` };
      }
      render.progressDone();
      continue;
    }
    render.progressDone();

    // 3. Check: login detected?
    if (interpretation.requiresAuth) {
      render.autoProgress(step, cfg.maxSteps, "login required — handing off...");
      render.progressDone();
      const authOk = await deps.handleAuth();
      if (!authOk) {
        return { outcome: "login_failed", steps, message: "authentication failed" };
      }
      // Auth succeeded — re-interpret on next loop iteration
      consecutiveErrors = 0;
      continue;
    }

    // 4. Check: data found?
    if (interpretation.dataFound) {
      render.autoProgress(step, cfg.maxSteps, "extracting data...");
      render.progressDone();
      try {
        const extracted = await deps.extractAndReturn(
          JSON.stringify(interpretation.dataFound),
          goal,
        );
        return {
          outcome: "completed",
          steps,
          extracted,
          message: `data found: ${extracted.summary}`,
        };
      } catch (err) {
        // Extraction failed — continue navigating
        consecutiveErrors++;
        if (consecutiveErrors >= cfg.maxConsecutiveErrors) {
          return { outcome: "stuck", steps, message: `data extraction failed: ${(err as Error).message}` };
        }
        continue;
      }
    }

    // 5. Build planAction context (choice-number format)
    const currentUrl = deps.getCurrentUrl();
    const currentTitle = deps.getCurrentTitle();

    const choiceList = interpretation.choices.map((c) => {
      let label = `[${c.index}] ${c.label}`;
      if (c.action === "fill") label += " (fill)";
      return label;
    }).join("\n  ");

    const historyStr = steps.map((s) =>
      `Step ${s.step}: clicked [${s.choiceLabel}]`
    ).join("\n  ");

    const visitedStr = Array.from(urlVisitCounts.entries())
      .filter(([, count]) => count > 1)
      .map(([url, count]) => `${url} (${count}x) <- avoid!`)
      .join("\n  ");

    const formattedContext = [
      `GOAL: ${goal}`,
      `CURRENT PAGE: ${currentTitle} (${currentUrl})`,
      `SUMMARY: ${interpretation.summary}`,
      `CHOICES:\n  ${choiceList || "(no choices available)"}`,
      historyStr ? `HISTORY:\n  ${historyStr}` : "",
      visitedStr ? `VISITED:\n  ${visitedStr}` : "",
    ].filter(Boolean).join("\n\n");

    // 6. planAutoAction
    render.autoProgress(step, cfg.maxSteps, "planning next action...");
    let plan: AutoPlanResult;
    try {
      plan = await deps.llm.planAutoAction(formattedContext);
    } catch (err) {
      consecutiveErrors++;
      render.progressDone();
      if (consecutiveErrors >= cfg.maxConsecutiveErrors) {
        return { outcome: "stuck", steps, message: `LLM plan failed: ${(err as Error).message}` };
      }
      continue;
    }
    render.progressDone();

    // 7. Handle plan result
    if (plan.type === "extract") {
      // Agent thinks current page has the data — try extraction from page content
      render.autoStep(step, cfg.maxSteps, "extract", plan.reasoning);
      try {
        const extracted = await deps.extractAndReturn(
          JSON.stringify(interpretation.dataFound || { summary: interpretation.summary }),
          goal,
        );
        return {
          outcome: "completed",
          steps,
          extracted,
          message: `data extracted: ${extracted.summary}`,
        };
      } catch (err) {
        consecutiveErrors++;
        if (consecutiveErrors >= cfg.maxConsecutiveErrors) {
          return { outcome: "stuck", steps, message: `extraction failed: ${(err as Error).message}` };
        }
        continue;
      }
    }

    if (plan.type === "ask_human") {
      render.autoStep(step, cfg.maxSteps, "ask human", plan.reasoning);
      return { outcome: "stuck", steps, message: plan.reasoning };
    }

    // Find the choice to execute
    const choiceIndex = plan.choiceIndex;
    if (choiceIndex === undefined || choiceIndex === null) {
      consecutiveErrors++;
      if (consecutiveErrors >= cfg.maxConsecutiveErrors) {
        return { outcome: "stuck", steps, message: "agent returned no valid action" };
      }
      continue;
    }

    const choice = interpretation.choices.find((c) => c.index === choiceIndex);
    if (!choice) {
      consecutiveErrors++;
      if (consecutiveErrors >= cfg.maxConsecutiveErrors) {
        return { outcome: "stuck", steps, message: `agent picked invalid choice [${choiceIndex}]` };
      }
      continue;
    }

    // 8. Display step
    const choiceLabel = choice.label;
    render.autoStep(step, cfg.maxSteps, choiceLabel, plan.reasoning);

    // 9. Execute choice
    const fillValue = plan.type === "fill" ? plan.value : undefined;
    try {
      await deps.syncBrowser();
      const result = await executeChoice(choice, deps.execDeps, fillValue);
      if (!result.navigated && !result.anchorSkipped) {
        consecutiveErrors++;
        if (result.error) {
          render.warn(`auto: ${result.error}`);
        }
      } else {
        consecutiveErrors = 0;
      }
    } catch (err) {
      consecutiveErrors++;
      if (consecutiveErrors >= cfg.maxConsecutiveErrors) {
        return { outcome: "stuck", steps, message: `navigation error: ${(err as Error).message}` };
      }
      continue;
    }

    // Record step
    const newUrl = deps.getCurrentUrl();
    steps.push({
      step,
      url: newUrl,
      title: deps.getCurrentTitle(),
      choiceLabel,
      reasoning: plan.reasoning,
      timestamp: Date.now(),
    });

    // 10. Loop detection
    const count = (urlVisitCounts.get(newUrl) || 0) + 1;
    urlVisitCounts.set(newUrl, count);
    if (count >= cfg.maxSameUrl) {
      return { outcome: "stuck", steps, message: `loop detected — visited ${newUrl} ${count}x` };
    }

    // Check consecutive errors
    if (consecutiveErrors >= cfg.maxConsecutiveErrors) {
      return { outcome: "stuck", steps, message: `${consecutiveErrors} consecutive errors` };
    }

    // 11. Brief delay for readability
    await new Promise((r) => setTimeout(r, 200));
  }

  return { outcome: "step_limit", steps, message: `reached ${cfg.maxSteps} step limit` };
}
