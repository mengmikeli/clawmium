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
  debug?: (label: string, msg: string) => void;
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
    deps.debug?.("exec", `fill: ${plan.ref ? `ref=${plan.ref}` : `selector=${plan.inputSelector}`}  value="${fillValue}"`);
    deps.crawlManager.truncateCursorForward();

    try {
      // Prefer ref-based locator, fall back to CSS selector
      const inputLocator = plan.ref
        ? page.locator(`aria-ref=${plan.ref}`)
        : page.locator(plan.inputSelector);
      await inputLocator.fill(fillValue);
      if (plan.submitAction === "click" && (plan.submitRef || plan.submitSelector)) {
        const submitLocator = plan.submitRef
          ? page.locator(`aria-ref=${plan.submitRef}`)
          : page.locator(plan.submitSelector!);
        await submitLocator.click();
      } else {
        await inputLocator.press("Enter");
      }
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(500);
    } catch {
      // Ref failed or locator failed — fallback to raw CSS selectors
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

    deps.debug?.("exec", `navigating to url: ${choice.url.slice(0, 80)}`);
    deps.crawlManager.truncateCursorForward();
    await deps.nav.goto(choice.url);
    await page.waitForTimeout(500);

    let newUrl: string;
    try { newUrl = deps.nav.currentUrl(); } catch { newUrl = choice.url; }
    deps.setCurrentUrl(newUrl);
    deps.setPendingReachedBy("choice");
    return { navigated: true, newUrl };
  }

  // Handle ref-based click (preferred over CSS selector)
  if (choice.ref) {
    deps.debug?.("exec", `trying ref: aria-ref=${choice.ref}`);
    deps.crawlManager.truncateCursorForward();

    try {
      const loc = page.locator(`aria-ref=${choice.ref}`);
      const href = await loc.getAttribute("href").catch(() => null);
      if (href && (href.startsWith("#") || href === "")) {
        return { navigated: false, anchorSkipped: true };
      }

      await loc.click();
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(500);

      let newUrl: string;
      try { newUrl = deps.nav.currentUrl(); } catch { newUrl = deps.currentUrl(); }
      deps.setCurrentUrl(newUrl);
      deps.setPendingReachedBy("choice");
      deps.debug?.("exec", `ref click succeeded → ${newUrl.slice(0, 80)}`);
      return { navigated: true, newUrl };
    } catch {
      // Ref click failed — fall through to selector/url paths below
      deps.debug?.("exec", `ref click failed, falling back to ${choice.selector ? "selector" : choice.url ? "url" : "nothing"}`);
      if (!choice.selector && !choice.url) {
        return { navigated: false, error: "ref click failed and no fallback" };
      }
    }
  }

  // Handle selector click
  if (choice.selector) {
    deps.debug?.("exec", `trying selector: ${choice.selector.slice(0, 60)}`);
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
      deps.debug?.("exec", `selector click failed, trying href fallback`);
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

  return { navigated: false, error: "choice has no url, selector, ref, or fillPlan" };
}
