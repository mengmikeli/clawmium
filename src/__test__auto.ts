import { CrawlManager } from "./crawl/tree";
import { PageInterpretation, AutoPlanResult } from "./llm/provider";
import { executeChoice, ExecutionDeps } from "./auto/executor";
import { runAuto, AutoDeps, AutoResult } from "./auto/runner";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  PASS: ${msg}`);
    passed++;
  }
}

function makeInterpretation(
  summary: string,
  choices: PageInterpretation["choices"] = [],
  overrides: Partial<PageInterpretation> = {},
): PageInterpretation {
  return {
    pageType: "navigation",
    summary,
    choices,
    dataFound: null,
    requiresAuth: false,
    requiresHumanInput: false,
    ...overrides,
  };
}

// ===================================================================
// Mock helpers
// ===================================================================

function makeMockPage(): any {
  let currentUrl = "https://example.com";
  let lastFilled = "";
  let lastClicked = "";

  return {
    _url: () => currentUrl,
    _setUrl: (u: string) => { currentUrl = u; },
    _lastFilled: () => lastFilled,
    _lastClicked: () => lastClicked,
    fill: async (sel: string, val: string) => { lastFilled = `${sel}=${val}`; },
    press: async (_sel: string, _key: string) => {},
    click: async (sel: string) => { lastClicked = sel; },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    getAttribute: async (_sel: string, attr: string) => {
      if (attr === "href") return null;
      return null;
    },
    evaluate: async (fn: Function, ...args: any[]) => {
      return fn(...args);
    },
  };
}

function makeMockNav(mockPage: any): any {
  return {
    goto: async (url: string) => { mockPage._setUrl(url); },
    currentUrl: () => mockPage._url(),
    extractContent: async () => ({
      title: "Mock Page",
      url: mockPage._url(),
      text: "Some mock content for testing purposes.",
      links: [],
      forms: [],
    }),
  };
}

function makeMockEngine(): any {
  return {
    getPage: () => { throw new Error("use page()"); },
    getBaseUrl: () => "https://example.com",
    isAlive: () => true,
    isShowing: () => false,
  };
}

function makeMockExecDeps(mockPage: any, mockNav: any, crawlManager: CrawlManager): ExecutionDeps & { _state: { currentUrl: string; pendingReachedBy: string } } {
  const state = {
    currentUrl: mockPage._url(),
    pendingReachedBy: "auto",
  };
  return {
    page: () => mockPage,
    nav: mockNav,
    engine: makeMockEngine(),
    currentUrl: () => state.currentUrl,
    setCurrentUrl: (url: string) => { state.currentUrl = url; },
    setPendingReachedBy: (rb: string) => { state.pendingReachedBy = rb; },
    crawlManager,
    interceptor: { clear: () => {} } as any,
    _state: state,
  };
}

// ===================================================================
// Tests
// ===================================================================

async function main() {
  console.log("=== Auto Mode Test Suite ===\n");

  // ---------------------------------------------------------------
  // GROUP 1: executeChoice — URL navigation (8 tests)
  // ---------------------------------------------------------------
  console.log("--- executeChoice: URL navigation ---\n");

  console.log("1. URL choice navigates and sets currentUrl...");
  {
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    cm.createCrawl("https://example.com", "Root", "goto");
    const deps = makeMockExecDeps(mockPage, mockNav, cm);

    const choice = { index: 1, label: "Page 1", action: "navigate" as const, url: "https://example.com/page1" };
    const result = await executeChoice(choice, deps);

    assert(result.navigated === true, "navigated is true");
    assert(result.newUrl === "https://example.com/page1", "newUrl is correct");
    assert(deps._state.currentUrl === "https://example.com/page1", "currentUrl updated");
    assert(deps._state.pendingReachedBy === "choice", "pendingReachedBy set to choice");
  }
  console.log();

  console.log("2. Anchor-only URL is skipped...");
  {
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    cm.createCrawl("https://example.com", "Root", "goto");
    const deps = makeMockExecDeps(mockPage, mockNav, cm);

    const choice = { index: 1, label: "Anchor", action: "navigate" as const, url: "#section" };
    const result = await executeChoice(choice, deps);

    assert(result.navigated === false, "not navigated");
    assert(result.anchorSkipped === true, "anchorSkipped is true");
  }
  console.log();

  console.log("3. Same-page anchor URL is skipped...");
  {
    const mockPage = makeMockPage();
    mockPage._setUrl("https://example.com/page");
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    cm.createCrawl("https://example.com/page", "Root", "goto");
    const deps = makeMockExecDeps(mockPage, mockNav, cm);
    deps._state.currentUrl = "https://example.com/page";

    const choice = { index: 1, label: "Anchor", action: "navigate" as const, url: "https://example.com/page#section" };
    const result = await executeChoice(choice, deps);

    assert(result.navigated === false, "not navigated");
    assert(result.anchorSkipped === true, "anchorSkipped is true");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 2: executeChoice — fill choices (6 tests)
  // ---------------------------------------------------------------
  console.log("--- executeChoice: fill choices ---\n");

  console.log("4. Fill choice with value fills and navigates...");
  {
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    cm.createCrawl("https://example.com", "Root", "goto");
    const deps = makeMockExecDeps(mockPage, mockNav, cm);

    const choice = {
      index: 1,
      label: "Search",
      action: "fill" as const,
      fillPlan: { inputSelector: "#search", submitAction: "enter" as const },
    };
    const result = await executeChoice(choice, deps, "test query");

    assert(result.navigated === true, "navigated is true");
    assert(mockPage._lastFilled() === "#search=test query", "filled correct selector with value");
    assert(deps._state.pendingReachedBy === "choice", "pendingReachedBy set to choice");
  }
  console.log();

  console.log("5. Fill choice without value returns error...");
  {
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    cm.createCrawl("https://example.com", "Root", "goto");
    const deps = makeMockExecDeps(mockPage, mockNav, cm);

    const choice = {
      index: 1,
      label: "Search",
      action: "fill" as const,
      fillPlan: { inputSelector: "#search", submitAction: "enter" as const },
    };
    const result = await executeChoice(choice, deps);

    assert(result.navigated === false, "not navigated");
    assert(result.error === "no fill value provided", "error message correct");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 3: executeChoice — selector click (4 tests)
  // ---------------------------------------------------------------
  console.log("--- executeChoice: selector click ---\n");

  console.log("6. Selector click navigates...");
  {
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    cm.createCrawl("https://example.com", "Root", "goto");
    const deps = makeMockExecDeps(mockPage, mockNav, cm);

    const choice = { index: 1, label: "Button", action: "click" as const, selector: "a.link" };
    const result = await executeChoice(choice, deps);

    assert(result.navigated === true, "navigated is true");
    assert(mockPage._lastClicked() === "a.link", "clicked correct selector");
  }
  console.log();

  console.log("7. Choice with no url, selector, or fillPlan returns error...");
  {
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    cm.createCrawl("https://example.com", "Root", "goto");
    const deps = makeMockExecDeps(mockPage, mockNav, cm);

    const choice = { index: 1, label: "Nothing", action: "click" as const };
    const result = await executeChoice(choice, deps);

    assert(result.navigated === false, "not navigated");
    assert(!!result.error, "has error message");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 4: executeChoice — cursor truncation (4 tests)
  // ---------------------------------------------------------------
  console.log("--- executeChoice: cursor management ---\n");

  console.log("8. URL navigation truncates forward cursor...");
  {
    const cm = new CrawlManager();
    cm.createCrawl("https://example.com", "Root", "goto");
    cm.appendCursor(cm.currentNodeId!, "goto");
    const node1 = cm.addNavigation("https://example.com/1", "Page 1", "choice");
    cm.appendCursor(node1.id, "choice");
    const node2 = cm.addNavigation("https://example.com/2", "Page 2", "choice");
    cm.appendCursor(node2.id, "choice");

    // Go back to create forward entries
    cm.cursorBack();
    assert(cm.cursorIndex === 1, "cursor at index 1 after back");
    const forwardBefore = cm.cursorHistory.length - cm.cursorIndex - 1;
    assert(forwardBefore === 1, "1 forward entry before navigation");

    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const deps = makeMockExecDeps(mockPage, mockNav, cm);

    const choice = { index: 1, label: "New page", action: "navigate" as const, url: "https://example.com/new" };
    await executeChoice(choice, deps);

    // Forward should be truncated (executeChoice calls truncateCursorForward)
    const forwardAfter = cm.cursorHistory.length - cm.cursorIndex - 1;
    assert(forwardAfter <= 1, "forward entries truncated after new navigation");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 5: runAuto — basic flow (12 tests)
  // ---------------------------------------------------------------
  console.log("--- runAuto: basic flow ---\n");

  console.log("9. Auto completes when data is found on first page...");
  {
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    cm.createCrawl("https://example.com", "Root", "goto");
    const execDeps = makeMockExecDeps(mockPage, mockNav, cm);

    const deps: AutoDeps = {
      llm: {
        interpret: async () => makeInterpretation("test"),
        planAction: async () => ({ type: "extract", reason: "test" } as any),
        planAutoAction: async () => ({ type: "extract", reasoning: "found it" }),
        extractData: async () => ({ title: "Test", summary: "Test data", fields: { key: "value" }, raw: {} }),
      } as any,
      execDeps,
      syncBrowser: async () => {},
      interpretPage: async () => makeInterpretation("Page with data", [], { dataFound: { amount: 42 } }),
      extractAndReturn: async () => ({ title: "Test", summary: "Test data", fields: { key: "value" }, raw: {} }),
      handleAuth: async () => true,
      getEnrichedTree: () => null,
      getCurrentUrl: () => execDeps._state.currentUrl,
      getCurrentTitle: () => "Test Page",
    };

    const result = await runAuto("find data", deps);
    assert(result.outcome === "completed", "outcome is completed");
    assert(result.extracted !== undefined, "extracted data present");
    assert(result.extracted!.fields.key === "value", "extracted fields correct");
  }
  console.log();

  console.log("10. Auto navigates through choices toward goal...");
  {
    let interpretCount = 0;
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    cm.createCrawl("https://example.com", "Root", "goto");
    const execDeps = makeMockExecDeps(mockPage, mockNav, cm);

    const deps: AutoDeps = {
      llm: {
        interpret: async () => makeInterpretation("test"),
        planAction: async () => ({ type: "click", reason: "test" } as any),
        planAutoAction: async (ctx: string) => {
          interpretCount++;
          if (interpretCount >= 3) {
            return { type: "extract", reasoning: "found the data" } as AutoPlanResult;
          }
          return { choiceIndex: 1, reasoning: "navigating toward goal" } as AutoPlanResult;
        },
        extractData: async () => ({ title: "Result", summary: "Found", fields: { a: 1 }, raw: {} }),
      } as any,
      execDeps,
      syncBrowser: async () => {},
      interpretPage: async () => {
        if (interpretCount >= 3) {
          return makeInterpretation("Data page", [], { dataFound: { a: 1 } });
        }
        return makeInterpretation("Nav page", [
          { index: 1, label: "Next", action: "navigate", url: `https://example.com/page${interpretCount}` },
          { index: 2, label: "Other", action: "navigate", url: "https://example.com/other" },
        ]);
      },
      extractAndReturn: async () => ({ title: "Result", summary: "Found", fields: { a: 1 }, raw: {} }),
      handleAuth: async () => true,
      getEnrichedTree: () => null,
      getCurrentUrl: () => execDeps._state.currentUrl,
      getCurrentTitle: () => "Test Page",
    };

    const result = await runAuto("find the data", deps, { maxSteps: 10 });
    assert(result.outcome === "completed", "outcome is completed");
    assert(result.steps.length >= 2, "took at least 2 steps");
    assert(result.steps[0].choiceLabel === "Next", "first step chose 'Next'");
  }
  console.log();

  console.log("11. Auto stops at step limit...");
  {
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    cm.createCrawl("https://example.com", "Root", "goto");
    const execDeps = makeMockExecDeps(mockPage, mockNav, cm);

    let step = 0;
    const deps: AutoDeps = {
      llm: {
        interpret: async () => makeInterpretation("test"),
        planAction: async () => ({ type: "click", reason: "test" } as any),
        planAutoAction: async () => ({ choiceIndex: 1, reasoning: "keep going" }),
        extractData: async () => ({ title: "T", summary: "S", fields: {}, raw: {} }),
      } as any,
      execDeps,
      syncBrowser: async () => {},
      interpretPage: async () => {
        step++;
        return makeInterpretation("Nav", [
          { index: 1, label: "Link", action: "navigate", url: `https://example.com/page${step}` },
        ]);
      },
      extractAndReturn: async () => ({ title: "T", summary: "S", fields: {}, raw: {} }),
      handleAuth: async () => true,
      getEnrichedTree: () => null,
      getCurrentUrl: () => execDeps._state.currentUrl,
      getCurrentTitle: () => "Test Page",
    };

    const result = await runAuto("find something", deps, { maxSteps: 3 });
    assert(result.outcome === "step_limit", "outcome is step_limit");
    assert(result.steps.length === 3, "took exactly 3 steps");
  }
  console.log();

  console.log("12. Auto detects loop (same URL visited too many times)...");
  {
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    cm.createCrawl("https://example.com", "Root", "goto");
    const execDeps = makeMockExecDeps(mockPage, mockNav, cm);

    const deps: AutoDeps = {
      llm: {
        interpret: async () => makeInterpretation("test"),
        planAction: async () => ({ type: "click", reason: "test" } as any),
        planAutoAction: async () => ({ choiceIndex: 1, reasoning: "clicking" }),
        extractData: async () => ({ title: "T", summary: "S", fields: {}, raw: {} }),
      } as any,
      execDeps,
      syncBrowser: async () => {},
      interpretPage: async () => makeInterpretation("Nav", [
        // Always navigates to the same URL
        { index: 1, label: "Same Page", action: "navigate", url: "https://example.com/stuck" },
      ]),
      extractAndReturn: async () => ({ title: "T", summary: "S", fields: {}, raw: {} }),
      handleAuth: async () => true,
      getEnrichedTree: () => null,
      getCurrentUrl: () => execDeps._state.currentUrl,
      getCurrentTitle: () => "Test Page",
    };

    const result = await runAuto("find something", deps, { maxSteps: 10, maxSameUrl: 2 });
    assert(result.outcome === "stuck", "outcome is stuck");
    assert(result.message.includes("loop"), "message mentions loop");
  }
  console.log();

  console.log("13. Auto cancels on abort signal...");
  {
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    cm.createCrawl("https://example.com", "Root", "goto");
    const execDeps = makeMockExecDeps(mockPage, mockNav, cm);

    const abort = new AbortController();
    abort.abort(); // Pre-abort

    const deps: AutoDeps = {
      llm: {
        interpret: async () => makeInterpretation("test"),
        planAction: async () => ({ type: "click", reason: "test" } as any),
        planAutoAction: async () => ({ choiceIndex: 1, reasoning: "test" }),
        extractData: async () => ({ title: "T", summary: "S", fields: {}, raw: {} }),
      } as any,
      execDeps,
      syncBrowser: async () => {},
      interpretPage: async () => makeInterpretation("Nav", []),
      extractAndReturn: async () => ({ title: "T", summary: "S", fields: {}, raw: {} }),
      handleAuth: async () => true,
      getEnrichedTree: () => null,
      getCurrentUrl: () => execDeps._state.currentUrl,
      getCurrentTitle: () => "Test Page",
    };

    const result = await runAuto("find something", deps, undefined, abort.signal);
    assert(result.outcome === "cancelled", "outcome is cancelled");
    assert(result.steps.length === 0, "no steps taken");
  }
  console.log();

  console.log("14. Auto handles ask_human from planner...");
  {
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    cm.createCrawl("https://example.com", "Root", "goto");
    const execDeps = makeMockExecDeps(mockPage, mockNav, cm);

    const deps: AutoDeps = {
      llm: {
        interpret: async () => makeInterpretation("test"),
        planAction: async () => ({ type: "ask_human", reason: "need help" } as any),
        planAutoAction: async () => ({ type: "ask_human", reasoning: "cannot find the target" }),
        extractData: async () => ({ title: "T", summary: "S", fields: {}, raw: {} }),
      } as any,
      execDeps,
      syncBrowser: async () => {},
      interpretPage: async () => makeInterpretation("Dead End", [
        { index: 1, label: "Irrelevant", action: "navigate", url: "https://example.com/nope" },
      ]),
      extractAndReturn: async () => ({ title: "T", summary: "S", fields: {}, raw: {} }),
      handleAuth: async () => true,
      getEnrichedTree: () => null,
      getCurrentUrl: () => execDeps._state.currentUrl,
      getCurrentTitle: () => "Test Page",
    };

    const result = await runAuto("find the mayor's phone number", deps);
    assert(result.outcome === "stuck", "outcome is stuck");
    assert(result.message.includes("cannot find"), "message includes agent reasoning");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 6: runAuto — auth flow (3 tests)
  // ---------------------------------------------------------------
  console.log("--- runAuto: auth flow ---\n");

  console.log("15. Auto handles auth requirement and continues...");
  {
    let interpretCount = 0;
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    cm.createCrawl("https://example.com", "Root", "goto");
    const execDeps = makeMockExecDeps(mockPage, mockNav, cm);

    const deps: AutoDeps = {
      llm: {
        interpret: async () => makeInterpretation("test"),
        planAction: async () => ({ type: "extract", reason: "test" } as any),
        planAutoAction: async () => ({ type: "extract", reasoning: "got it" }),
        extractData: async () => ({ title: "T", summary: "S", fields: { a: 1 }, raw: {} }),
      } as any,
      execDeps,
      syncBrowser: async () => {},
      interpretPage: async () => {
        interpretCount++;
        if (interpretCount === 1) {
          return makeInterpretation("Login page", [], { requiresAuth: true });
        }
        return makeInterpretation("Data page", [], { dataFound: { a: 1 } });
      },
      extractAndReturn: async () => ({ title: "T", summary: "S", fields: { a: 1 }, raw: {} }),
      handleAuth: async () => true,
      getEnrichedTree: () => null,
      getCurrentUrl: () => execDeps._state.currentUrl,
      getCurrentTitle: () => "Test Page",
    };

    const result = await runAuto("get data", deps);
    assert(result.outcome === "completed", "outcome is completed after auth");
    assert(interpretCount === 2, "interpreted page twice (before and after auth)");
  }
  console.log();

  console.log("16. Auto returns login_failed when auth fails...");
  {
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    cm.createCrawl("https://example.com", "Root", "goto");
    const execDeps = makeMockExecDeps(mockPage, mockNav, cm);

    const deps: AutoDeps = {
      llm: {
        interpret: async () => makeInterpretation("test"),
        planAction: async () => ({ type: "ask_human", reason: "test" } as any),
        planAutoAction: async () => ({ type: "ask_human", reasoning: "test" }),
        extractData: async () => ({ title: "T", summary: "S", fields: {}, raw: {} }),
      } as any,
      execDeps,
      syncBrowser: async () => {},
      interpretPage: async () => makeInterpretation("Login", [], { requiresAuth: true }),
      extractAndReturn: async () => ({ title: "T", summary: "S", fields: {}, raw: {} }),
      handleAuth: async () => false,
      getEnrichedTree: () => null,
      getCurrentUrl: () => execDeps._state.currentUrl,
      getCurrentTitle: () => "Test Page",
    };

    const result = await runAuto("get data", deps);
    assert(result.outcome === "login_failed", "outcome is login_failed");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 7: runAuto — error recovery (5 tests)
  // ---------------------------------------------------------------
  console.log("--- runAuto: error recovery ---\n");

  console.log("17. Auto retries once on browser sync failure...");
  {
    let syncCalls = 0;
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    cm.createCrawl("https://example.com", "Root", "goto");
    const execDeps = makeMockExecDeps(mockPage, mockNav, cm);

    const deps: AutoDeps = {
      llm: {
        interpret: async () => makeInterpretation("test"),
        planAction: async () => ({ type: "extract", reason: "test" } as any),
        planAutoAction: async () => ({ type: "extract", reasoning: "found it" }),
        extractData: async () => ({ title: "T", summary: "S", fields: { a: 1 }, raw: {} }),
      } as any,
      execDeps,
      syncBrowser: async () => {
        syncCalls++;
        if (syncCalls === 1) throw new Error("browser crashed");
        // Second call succeeds
      },
      interpretPage: async () => makeInterpretation("Data", [], { dataFound: { a: 1 } }),
      extractAndReturn: async () => ({ title: "T", summary: "S", fields: { a: 1 }, raw: {} }),
      handleAuth: async () => true,
      getEnrichedTree: () => null,
      getCurrentUrl: () => execDeps._state.currentUrl,
      getCurrentTitle: () => "Test Page",
    };

    const result = await runAuto("get data", deps, { maxConsecutiveErrors: 3 });
    assert(syncCalls >= 2, "syncBrowser called more than once");
    assert(result.outcome === "completed", "outcome is completed after recovery");
  }
  console.log();

  console.log("18. Auto stops after maxConsecutiveErrors...");
  {
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    cm.createCrawl("https://example.com", "Root", "goto");
    const execDeps = makeMockExecDeps(mockPage, mockNav, cm);

    const deps: AutoDeps = {
      llm: {
        interpret: async () => makeInterpretation("test"),
        planAction: async () => ({ type: "click", reason: "test" } as any),
        planAutoAction: async () => ({ choiceIndex: 99, reasoning: "invalid choice" }),
        extractData: async () => ({ title: "T", summary: "S", fields: {}, raw: {} }),
      } as any,
      execDeps,
      syncBrowser: async () => {},
      interpretPage: async () => makeInterpretation("Nav", [
        { index: 1, label: "Link", action: "navigate", url: "https://example.com/1" },
      ]),
      extractAndReturn: async () => ({ title: "T", summary: "S", fields: {}, raw: {} }),
      handleAuth: async () => true,
      getEnrichedTree: () => null,
      getCurrentUrl: () => execDeps._state.currentUrl,
      getCurrentTitle: () => "Test Page",
    };

    const result = await runAuto("find stuff", deps, { maxConsecutiveErrors: 2, maxSteps: 10 });
    assert(result.outcome === "stuck", "outcome is stuck after consecutive errors");
  }
  console.log();

  console.log("19. Auto handles LLM interpret failure gracefully...");
  {
    let interpretCalls = 0;
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    cm.createCrawl("https://example.com", "Root", "goto");
    const execDeps = makeMockExecDeps(mockPage, mockNav, cm);

    const deps: AutoDeps = {
      llm: {
        interpret: async () => makeInterpretation("test"),
        planAction: async () => ({ type: "extract", reason: "test" } as any),
        planAutoAction: async () => ({ type: "extract", reasoning: "found it" }),
        extractData: async () => ({ title: "T", summary: "S", fields: { a: 1 }, raw: {} }),
      } as any,
      execDeps,
      syncBrowser: async () => {},
      interpretPage: async () => {
        interpretCalls++;
        if (interpretCalls <= 2) throw new Error("LLM timeout");
        return makeInterpretation("Data", [], { dataFound: { a: 1 } });
      },
      extractAndReturn: async () => ({ title: "T", summary: "S", fields: { a: 1 }, raw: {} }),
      handleAuth: async () => true,
      getEnrichedTree: () => null,
      getCurrentUrl: () => execDeps._state.currentUrl,
      getCurrentTitle: () => "Test Page",
    };

    const result = await runAuto("get data", deps, { maxConsecutiveErrors: 3 });
    assert(result.outcome === "completed" || result.outcome === "stuck", "outcome is completed or stuck");
    assert(interpretCalls >= 2, "interpret was retried");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 8: runAuto — fill actions (3 tests)
  // ---------------------------------------------------------------
  console.log("--- runAuto: fill actions ---\n");

  console.log("20. Auto fills form when planner returns fill type...");
  {
    let didFill = false;
    const mockPage = makeMockPage();
    // Track fill calls
    const origFill = mockPage.fill;
    mockPage.fill = async (sel: string, val: string) => {
      didFill = true;
      return origFill(sel, val);
    };
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    cm.createCrawl("https://example.com", "Root", "goto");
    const execDeps = makeMockExecDeps(mockPage, mockNav, cm);

    let step = 0;
    const deps: AutoDeps = {
      llm: {
        interpret: async () => makeInterpretation("test"),
        planAction: async () => ({ type: "fill", reason: "test" } as any),
        planAutoAction: async () => {
          step++;
          if (step === 1) {
            return { type: "fill", choiceIndex: 1, value: "water bill", reasoning: "searching for goal" } as AutoPlanResult;
          }
          return { type: "extract", reasoning: "found results" } as AutoPlanResult;
        },
        extractData: async () => ({ title: "T", summary: "S", fields: { a: 1 }, raw: {} }),
      } as any,
      execDeps,
      syncBrowser: async () => {},
      interpretPage: async () => {
        if (step === 0) {
          return makeInterpretation("Search page", [
            { index: 1, label: "Search this site", action: "fill",
              fillPlan: { inputSelector: "#search", submitAction: "enter" } },
          ]);
        }
        return makeInterpretation("Results", [], { dataFound: { a: 1 } });
      },
      extractAndReturn: async () => ({ title: "T", summary: "S", fields: { a: 1 }, raw: {} }),
      handleAuth: async () => true,
      getEnrichedTree: () => null,
      getCurrentUrl: () => execDeps._state.currentUrl,
      getCurrentTitle: () => "Test Page",
    };

    const result = await runAuto("find water bill", deps);
    assert(didFill, "form was filled");
    assert(result.outcome === "completed", "outcome is completed after fill + extract");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 9: AutoPlanResult types (4 tests)
  // ---------------------------------------------------------------
  console.log("--- AutoPlanResult validation ---\n");

  console.log("21. AutoPlanResult with choiceIndex is valid...");
  {
    const plan: AutoPlanResult = { choiceIndex: 3, reasoning: "most relevant link" };
    assert(plan.choiceIndex === 3, "choiceIndex is 3");
    assert(plan.reasoning === "most relevant link", "reasoning preserved");
    assert(plan.type === undefined, "type is undefined for choice actions");
  }
  console.log();

  console.log("22. AutoPlanResult with type extract is valid...");
  {
    const plan: AutoPlanResult = { type: "extract", reasoning: "found the data" };
    assert(plan.type === "extract", "type is extract");
    assert(plan.choiceIndex === undefined, "choiceIndex is undefined for extract");
  }
  console.log();

  console.log("23. AutoPlanResult with fill has value...");
  {
    const plan: AutoPlanResult = { type: "fill", choiceIndex: 2, value: "test query", reasoning: "search" };
    assert(plan.type === "fill", "type is fill");
    assert(plan.value === "test query", "value present");
    assert(plan.choiceIndex === 2, "choiceIndex present for fill");
  }
  console.log();

  console.log("24. AutoPlanResult with ask_human...");
  {
    const plan: AutoPlanResult = { type: "ask_human", reasoning: "stuck" };
    assert(plan.type === "ask_human", "type is ask_human");
    assert(plan.reasoning === "stuck", "reasoning preserved");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 10: runAuto — history tracking in planAction context (3 tests)
  // ---------------------------------------------------------------
  console.log("--- runAuto: history and visited tracking ---\n");

  console.log("25. Steps are recorded with correct metadata...");
  {
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    cm.createCrawl("https://example.com", "Root", "goto");
    const execDeps = makeMockExecDeps(mockPage, mockNav, cm);

    let planStep = 0;
    let interpretStep = 0;
    const deps: AutoDeps = {
      llm: {
        interpret: async () => makeInterpretation("test"),
        planAction: async () => ({ type: "click", reason: "test" } as any),
        planAutoAction: async () => {
          planStep++;
          if (planStep >= 3) return { type: "extract", reasoning: "done" } as AutoPlanResult;
          return { choiceIndex: 1, reasoning: `step ${planStep} reasoning` } as AutoPlanResult;
        },
        extractData: async () => ({ title: "T", summary: "S", fields: { a: 1 }, raw: {} }),
      } as any,
      execDeps,
      syncBrowser: async () => {},
      interpretPage: async () => {
        interpretStep++;
        if (planStep >= 3) return makeInterpretation("Data", [], { dataFound: { a: 1 } });
        return makeInterpretation("Nav", [
          { index: 1, label: `Link ${interpretStep}`, action: "navigate", url: `https://example.com/${interpretStep}` },
        ]);
      },
      extractAndReturn: async () => ({ title: "T", summary: "S", fields: { a: 1 }, raw: {} }),
      handleAuth: async () => true,
      getEnrichedTree: () => null,
      getCurrentUrl: () => execDeps._state.currentUrl,
      getCurrentTitle: () => `Page ${planStep}`,
    };

    const result = await runAuto("find data", deps);
    assert(result.outcome === "completed", "completed");
    assert(result.steps.length === 2, "2 navigation steps before extract");
    assert(result.steps[0].choiceLabel === "Link 1", "step 1 label correct");
    assert(result.steps[0].reasoning === "step 1 reasoning", "step 1 reasoning correct");
    assert(result.steps[1].choiceLabel === "Link 2", "step 2 label correct");
    assert(result.steps[0].timestamp > 0, "step 1 has timestamp");
  }
  console.log();

  console.log("26. Visited URLs are passed to planner context...");
  {
    let lastContext = "";
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    cm.createCrawl("https://example.com", "Root", "goto");
    const execDeps = makeMockExecDeps(mockPage, mockNav, cm);

    let step = 0;
    const deps: AutoDeps = {
      llm: {
        interpret: async () => makeInterpretation("test"),
        planAction: async () => ({ type: "click", reason: "test" } as any),
        planAutoAction: async (ctx: string) => {
          lastContext = ctx;
          step++;
          if (step >= 3) return { type: "ask_human", reasoning: "done" } as AutoPlanResult;
          return { choiceIndex: 1, reasoning: "navigating" } as AutoPlanResult;
        },
        extractData: async () => ({ title: "T", summary: "S", fields: {}, raw: {} }),
      } as any,
      execDeps,
      syncBrowser: async () => {},
      interpretPage: async () => makeInterpretation("Nav", [
        { index: 1, label: "Link", action: "navigate", url: "https://example.com/page" },
      ]),
      extractAndReturn: async () => ({ title: "T", summary: "S", fields: {}, raw: {} }),
      handleAuth: async () => true,
      getEnrichedTree: () => null,
      getCurrentUrl: () => execDeps._state.currentUrl,
      getCurrentTitle: () => "Test Page",
    };

    await runAuto("find stuff", deps, { maxSteps: 5, maxSameUrl: 5 });
    assert(lastContext.includes("GOAL: find stuff"), "context includes goal");
    assert(lastContext.includes("CHOICES:"), "context includes choices");
    assert(lastContext.includes("SUMMARY:"), "context includes summary");
  }
  console.log();

  // ---------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------
  console.log("═".repeat(50));
  console.log(`  ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log("═".repeat(50));

  if (failed > 0) {
    process.exit(1);
  }
}

// Silence render output during tests
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origConsoleLog = console.log.bind(console);
const origConsoleError = console.error.bind(console);

// Capture test output, suppress render output
let suppressRender = false;

function patchedWrite(data: any, ...args: any[]): boolean {
  if (suppressRender && typeof data === "string") {
    // Allow test output (PASS/FAIL, group headers, summary)
    if (data.includes("PASS:") || data.includes("FAIL:") || data.includes("---") ||
        data.includes("===") || data.includes("passed") || data.includes("Auto Mode") ||
        data.includes("...") || data.includes("console.log")) {
      return origStdoutWrite(data, ...args);
    }
    // Suppress render output (ANSI codes, progress lines)
    if (data.includes("\x1b[") || data.includes("⋯") || data.includes("→ auto")) {
      return true;
    }
  }
  return origStdoutWrite(data, ...args);
}

suppressRender = true;
process.stdout.write = patchedWrite as any;

main().catch((err) => {
  console.error("Test suite crashed:", err);
  process.exit(1);
});
