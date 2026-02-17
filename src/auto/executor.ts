import { Page } from "playwright";
import { PageNavigator } from "../browser/navigator";
import { BrowserEngine } from "../browser/engine";
import { NetworkInterceptor } from "../browser/network";
import { CrawlManager } from "../crawl/tree";
import { PageInterpretation } from "../llm/provider";

// ===================================================================
// Types
// ===================================================================

export interface ExecutionDeps {
  page: () => Page;           // lazy getter (syncBrowser called by caller)
  nav: PageNavigator;
  engine: BrowserEngine;
  currentUrl: () => string;
  setCurrentUrl: (url: string) => void;
  setPendingReachedBy: (reachedBy: string) => void;
  crawlManager: CrawlManager;
  interceptor: NetworkInterceptor;
}

export interface ExecuteResult {
  navigated: boolean;
  newUrl?: string;
  error?: string;
  anchorSkipped?: boolean;
}

type Choice = PageInterpretation["choices"][number];

// ===================================================================
// executeChoice — shared between human and auto paths
// ===================================================================

/**
 * Execute a single choice from the LLM interpretation.
 * Handles: url navigation, selector clicks (with href fallback),
 * fill (with value param), anchor detection, 500ms wait, currentUrl sync.
 *
 * Does NOT handle synthetic choices (show rendered page, save and quit, login).
 * Those are REPL-specific and handled by the caller.
 *
 * @param choice - The choice to execute
 * @param deps - Execution dependencies
 * @param fillValue - Value to fill for fill choices (from readline or auto planner)
 * @returns ExecuteResult indicating what happened
 */
export async function executeChoice(
  choice: Choice,
  deps: ExecutionDeps,
  fillValue?: string,
): Promise<ExecuteResult> {
  const page = deps.page();

  // Handle fill choices (search, filter)
  if (choice.action === "fill" && choice.fillPlan) {
    if (!fillValue) {
      return { navigated: false, error: "no fill value provided" };
    }

    const plan = choice.fillPlan;
    deps.crawlManager.truncateCursorForward();

    try {
      await page.fill(plan.inputSelector, fillValue);
      if (plan.submitAction === "click" && plan.submitSelector) {
        await page.click(plan.submitSelector);
      } else {
        await page.press(plan.inputSelector, "Enter");
      }
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(500);
    } catch {
      // Fallback: try form.submit() on the closest form
      try {
        await page.evaluate((sel: string) => {
          const el = document.querySelector(sel);
          const form = el?.closest("form") as HTMLFormElement | null;
          form?.submit();
        }, plan.inputSelector);
        await page.waitForLoadState("networkidle").catch(() => {});
      } catch { /* give up on submit — continue */ }
    }

    let newUrl: string;
    try { newUrl = deps.nav.currentUrl(); } catch { newUrl = deps.currentUrl(); }
    deps.setCurrentUrl(newUrl);
    deps.setPendingReachedBy("choice");
    return { navigated: true, newUrl };
  }

  // Handle URL navigation
  if (choice.url) {
    const currentUrl = deps.currentUrl();

    // Skip anchor-only links (e.g. #site-content)
    if (choice.url.startsWith("#") || (choice.url.includes("#") && (() => {
      try { return new URL(choice.url).pathname === new URL(currentUrl).pathname; } catch { return false; }
    })())) {
      return { navigated: false, anchorSkipped: true };
    }

    deps.crawlManager.truncateCursorForward();
    await deps.nav.goto(choice.url);
    await page.waitForTimeout(500);

    let newUrl: string;
    try { newUrl = deps.nav.currentUrl(); } catch { newUrl = choice.url; }
    deps.setCurrentUrl(newUrl);
    deps.setPendingReachedBy("choice");
    return { navigated: true, newUrl };
  }

  // Handle selector click
  if (choice.selector) {
    deps.crawlManager.truncateCursorForward();

    try {
      // Check if it's an anchor link before clicking
      const href = await page.getAttribute(choice.selector, "href").catch(() => null);
      if (href && (href.startsWith("#") || href === "")) {
        return { navigated: false, anchorSkipped: true };
      }

      await page.click(choice.selector);
      await page.waitForLoadState("networkidle").catch(() => {});
    } catch {
      // Click failed — fallback to href + goto
      const href = await page.getAttribute(choice.selector, "href").catch(() => null);
      if (href && !href.startsWith("#")) {
        const url = href.startsWith("http") ? href : `${deps.engine.getBaseUrl()}${href}`;
        await deps.nav.goto(url);
      } else {
        return { navigated: false, error: "click failed and no fallback href" };
      }
    }

    await page.waitForTimeout(500);

    let newUrl: string;
    try { newUrl = deps.nav.currentUrl(); } catch { newUrl = deps.currentUrl(); }
    deps.setCurrentUrl(newUrl);
    deps.setPendingReachedBy("choice");
    return { navigated: true, newUrl };
  }

  return { navigated: false, error: "choice has no url, selector, or fillPlan" };
}
