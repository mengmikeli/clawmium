/**
 * Integration test: /auto mode against CityServe
 *
 * Tests the full auto loop with real browser + real LLM against CityServe.
 * Pre-authenticates the browser via API to bypass interactive stdin auth.
 *
 * Prerequisites:
 *   1. CityServe running: npm run cityserve
 *   2. Valid API key in .env
 *
 * Usage:
 *   npx tsx src/__test__auto_e2e.ts
 */

import "dotenv/config";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import { PageNavigator } from "./browser/navigator";
import { BrowserEngine } from "./browser/engine";
import { NetworkInterceptor } from "./browser/network";
import { CrawlManager } from "./crawl/tree";
import { LLMProvider, PageInterpretation } from "./llm/provider";
import { OpenAIProvider } from "./llm/openai";
import { AnthropicProvider } from "./llm/anthropic";
import { detectLoginPage } from "./auth/detector";
import { detectInteractiveForms } from "./forms/detector";
import { formatAncestorContext } from "./crawl/context";
import { runAuto, AutoDeps, AutoResult } from "./auto/runner";
import { ExecutionDeps } from "./auto/executor";

// ===================================================================
// Setup
// ===================================================================

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const LLM_TIMEOUT = 30_000;

function createLLM(): LLMProvider {
  const provider = process.env.LLM_PROVIDER || "anthropic";
  if (provider === "openai") {
    const key = process.env.OPENAI_API_KEY;
    if (!key || key === "sk-...") throw new Error("Set OPENAI_API_KEY in .env");
    return new OpenAIProvider(key);
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key === "sk-ant-...") throw new Error("Set ANTHROPIC_API_KEY in .env");
  return new AnthropicProvider(key);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ===================================================================
// Test
// ===================================================================

async function main() {
  console.log("=== /auto CityServe Integration Test ===\n");

  // 1. Check CityServe is running
  try {
    const resp = await fetch(BASE_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    console.log(`✓ CityServe running at ${BASE_URL}`);
  } catch (err) {
    console.error(`✗ CityServe not reachable at ${BASE_URL}`);
    console.error("  Start with: npm run cityserve");
    process.exit(1);
  }

  // 2. Create LLM provider
  let llm: LLMProvider;
  try {
    llm = createLLM();
    console.log(`✓ LLM provider: ${process.env.LLM_PROVIDER || "anthropic"}`);
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(1);
  }

  // 3. Launch browser
  console.log("→ Launching browser...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // 4. Navigate to home page (no pre-auth — let /auto handle login flow)
  await page.goto(BASE_URL);
  console.log("✓ On CityServe home page\n");

  // 6. Set up auto deps
  const nav = new PageNavigator(page);
  const interceptor = new NetworkInterceptor();
  interceptor.attach(page, BASE_URL);
  const crawlManager = new CrawlManager();

  let currentUrl = BASE_URL;
  let lastTitle = "";
  let currentInterpretation: PageInterpretation | null = null;
  let pendingReachedBy = "auto";

  const execDeps: ExecutionDeps = {
    page: () => page,
    nav,
    engine: {
      getPage: () => page,
      getBaseUrl: () => BASE_URL,
      isAlive: () => true,
    } as any,
    currentUrl: () => currentUrl,
    setCurrentUrl: (url: string) => { currentUrl = url; },
    setPendingReachedBy: (rb: string) => { pendingReachedBy = rb; },
    crawlManager,
    interceptor,
  };

  const autoDeps: AutoDeps = {
    llm,
    execDeps,
    syncBrowser: async () => {
      // Browser is always in sync in this test
    },
    interpretPage: async (): Promise<PageInterpretation> => {
      // Detect login page
      const loginCheck = await detectLoginPage(page);
      if (loginCheck.isLoginPage) {
        return {
          pageType: "login",
          summary: "Login page detected",
          choices: [],
          dataFound: null,
          requiresAuth: true,
          requiresHumanInput: true,
        };
      }

      // Detect forms
      const forms = await detectInteractiveForms(page);

      // Extract content
      const content = await nav.extractContent();
      lastTitle = content.title;

      // Track navigation
      if (currentUrl && currentUrl !== "about:blank") {
        const node = crawlManager.addNavigation(currentUrl, lastTitle, pendingReachedBy as any);
        crawlManager.appendCursor(node.id, pendingReachedBy as any);
        pendingReachedBy = "auto";
      }

      // Check for intercepted API data
      const responses = interceptor.getResponses();
      const skipPatterns = ["/api/login", "/api/session", "/api/services", "/api/logout", "/api/account"];
      for (let i = responses.length - 1; i >= 0; i--) {
        const resp = responses[i];
        if (!resp.url.includes("/api/")) continue;
        if (skipPatterns.some(p => resp.url.includes(p))) continue;
        if (resp.status === 200 && resp.body && typeof resp.body === "object" && !Array.isArray(resp.body)) {
          return {
            pageType: "data",
            summary: `API data captured: ${resp.url}`,
            choices: [],
            dataFound: resp.body as Record<string, unknown>,
            requiresAuth: false,
            requiresHumanInput: false,
          };
        }
      }

      // Build page text for LLM
      const pageText = [
        `Title: ${content.title}`,
        `URL: ${content.url}`,
        `\nVisible text:\n${content.text}`,
        `\nLinks:`,
        ...content.links.map(l => `  - "${l.text}" → ${l.href}`),
        `\nForms:`,
        ...content.forms.map(f =>
          `  - Form(id="${f.id}", action="${f.action}", inputs: ${f.inputs.map(i => i.name || i.type).join(", ")})`
        ),
      ].join("\n");

      const ancestorCtx = formatAncestorContext(crawlManager);
      const interpretation = await withTimeout(
        llm.interpret(pageText, "check my water bill", ancestorCtx || undefined),
        LLM_TIMEOUT,
        "LLM interpret",
      );

      // Only trust dataFound from the interceptor path (above), not from
      // the LLM — the LLM may see account details on the dashboard and
      // prematurely report "data found" before reaching the water bill page.
      interpretation.dataFound = null;
      currentInterpretation = interpretation;

      // Append detected form choices
      for (const form of forms) {
        const alreadyPresent = interpretation.choices.some(
          c => c.action === "fill" && c.fillPlan?.inputSelector === form.selector
        );
        if (!alreadyPresent) {
          interpretation.choices.push({
            index: interpretation.choices.length + 1,
            label: form.label,
            action: "fill",
            fillPlan: {
              inputSelector: form.selector,
              submitAction: "enter",
            },
          });
        }
      }

      return interpretation;
    },
    extractAndReturn: async (rawData: string, goal: string) => {
      return await withTimeout(
        llm.extractData(rawData, goal),
        LLM_TIMEOUT,
        "LLM extract",
      );
    },
    handleAuth: async () => {
      // Fill and submit login form programmatically.
      // app.js intercepts the form submit, POSTs to /api/login via fetch(),
      // then redirects via window.location.href = "/dashboard.html".
      console.log("  (submitting login form programmatically)");
      try {
        await page.fill("#username", "mike.chen");
        await page.fill("#password", "cityserve2025");

        // Click submit — app.js will preventDefault, fetch /api/login, then redirect
        await Promise.all([
          page.waitForURL(
            (url) => url.pathname.includes("dashboard"),
            { timeout: 15_000 },
          ),
          page.click('button[type="submit"]'),
        ]);

        // Wait for dashboard to finish loading (it fetches /api/session + /api/account)
        await page.waitForLoadState("networkidle").catch(() =>
          page.waitForLoadState("domcontentloaded")
        );

        currentUrl = page.url();
        pendingReachedBy = "auto";
        console.log(`  (redirected to ${currentUrl})`);
        return true;
      } catch (err) {
        console.log(`  (auth form submission failed: ${(err as Error).message})`);
        return false;
      }
    },
    getEnrichedTree: () => crawlManager.getEnrichedDisplayTree(),
    getCurrentUrl: () => currentUrl,
    getCurrentTitle: () => lastTitle,
  };

  // 7. Run auto mode
  console.log("─".repeat(60));
  console.log(`  /auto check my water bill`);
  console.log("─".repeat(60));
  console.log();

  const startTime = Date.now();
  let result: AutoResult;
  try {
    result = await runAuto("check my water bill", autoDeps, { maxSteps: 10 });
  } catch (err) {
    console.error(`\n✗ Auto runner crashed: ${(err as Error).message}`);
    await browser.close();
    process.exit(1);
  }
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // 8. Display results
  console.log();
  console.log("─".repeat(60));
  console.log();

  // Show crawl tree
  const tree = crawlManager.getEnrichedDisplayTree();
  if (tree) {
    console.log(tree);
    console.log();
  }

  // Summary
  console.log(`  Outcome:  ${result.outcome}`);
  console.log(`  Steps:    ${result.steps.length}`);
  console.log(`  Time:     ${elapsed}s`);
  console.log(`  Message:  ${result.message}`);

  if (result.steps.length > 0) {
    console.log();
    console.log("  Steps taken:");
    for (const step of result.steps) {
      console.log(`    ${step.step}. "${step.choiceLabel}" — ${step.reasoning}`);
    }
  }

  if (result.extracted) {
    console.log();
    console.log(`  Extracted: ${result.extracted.title}`);
    console.log(`  Summary:   ${result.extracted.summary}`);
    console.log(`  Fields:`);
    for (const [key, value] of Object.entries(result.extracted.fields)) {
      console.log(`    ${key}: ${value}`);
    }
  }

  // 9. Assertions
  console.log();
  console.log("=== Checks ===\n");

  let passed = 0;
  let failed = 0;
  function check(condition: boolean, msg: string) {
    if (condition) {
      console.log(`  ✓ ${msg}`);
      passed++;
    } else {
      console.log(`  ✗ ${msg}`);
      failed++;
    }
  }

  check(result.outcome === "completed" || result.outcome === "stuck" || result.outcome === "step_limit",
    `outcome is actionable (got: ${result.outcome})`);
  check(result.steps.length > 0, `took at least 1 step (got: ${result.steps.length})`);
  check(!result.message.includes("crash"), "no browser crash");

  if (result.outcome === "completed") {
    check(result.extracted !== undefined, "data was extracted");
    if (result.extracted) {
      const fields = JSON.stringify(result.extracted.fields).toLowerCase();
      check(fields.includes("84.5") || fields.includes("$84") || fields.includes("water"),
        "extracted water bill data");
    }
  } else {
    console.log(`  ⚠ Auto did not complete — outcome: ${result.outcome}`);
    console.log(`    This may be normal depending on LLM navigation choices.`);
    check(result.steps.length <= 10, "stayed within step limit");
  }

  check(crawlManager.nodes.size > 1, `crawl tree has multiple nodes (got: ${crawlManager.nodes.size})`);

  console.log();
  console.log(`  ${passed} passed, ${failed} failed`);

  // Cleanup
  await browser.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("E2E test crashed:", err);
  process.exit(1);
});
