import { CrawlManager } from "./crawl/tree";
import { PageInterpretation } from "./llm/provider";
import { executeChoice, ExecutionDeps } from "./auto/executor";

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

// ===================================================================
// Mock helpers
// ===================================================================

function makeMockPage(opts: {
  snapshotResult?: any;
  snapshotThrows?: boolean;
  hasSnapshotMethod?: boolean;
  locatorClickFails?: boolean;
} = {}): any {
  let currentUrl = "https://example.com";
  let lastFilled = "";
  let lastClicked = "";
  let lastLocatorRef = "";

  const mockLocator = (ref: string) => {
    lastLocatorRef = ref;
    return {
      fill: async (val: string) => {
        if (opts.locatorClickFails) throw new Error("locator fill failed");
        lastFilled = `${ref}=${val}`;
      },
      press: async (_key: string) => {
        if (opts.locatorClickFails) throw new Error("locator press failed");
      },
      click: async () => {
        if (opts.locatorClickFails) throw new Error("locator click failed");
        lastClicked = ref;
      },
      getAttribute: async (attr: string) => {
        if (attr === "href") return null;
        return null;
      },
    };
  };

  return {
    _url: () => currentUrl,
    _setUrl: (u: string) => { currentUrl = u; },
    _lastFilled: () => lastFilled,
    _lastClicked: () => lastClicked,
    _lastLocatorRef: () => lastLocatorRef,
    fill: async (sel: string, val: string) => { lastFilled = `${sel}=${val}`; },
    press: async (_sel: string, _key: string) => {},
    click: async (sel: string) => { lastClicked = sel; },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    getAttribute: async (_sel: string, attr: string) => {
      if (attr === "href") return null;
      return null;
    },
    evaluate: async (fn: Function, ...args: any[]) => fn(...args),
    locator: (selector: string) => {
      // Extract ref from "aria-ref=s1e5" pattern
      const ref = selector.replace("aria-ref=", "");
      return mockLocator(ref);
    },
    _snapshotForAI: opts.hasSnapshotMethod === false ? undefined : async (config?: any) => {
      if (opts.snapshotThrows) throw new Error("snapshot failed");
      return opts.snapshotResult ?? { full: "- navigation \"Main\":\n  - link \"Home\" [ref=s1e1]\n  - link \"About\" [ref=s1e2]" };
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
    extractAriaSnapshot: async () => null,
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
// Inline AriaSnapshot extraction logic (mirrors PageNavigator)
// ===================================================================

interface AriaSnapshot {
  yaml: string;
  timestamp: number;
}

async function extractAriaSnapshot(page: any, timeoutMs = 10_000): Promise<AriaSnapshot | null> {
  try {
    const result = await page._snapshotForAI({ timeout: timeoutMs });
    if (!result?.full) return null;
    return { yaml: result.full, timestamp: Date.now() };
  } catch {
    return null;
  }
}

// ===================================================================
// Inline buildPageText logic (mirrors Repl.buildPageText)
// ===================================================================

interface PageContent {
  title: string;
  url: string;
  text: string;
  links: Array<{ text: string; href: string }>;
  forms: Array<{ id: string; action: string; inputs: Array<{ name: string; type: string }> }>;
}

function buildPageText(content: PageContent, ariaYaml?: string | null): string {
  const sections = [
    `Title: ${content.title}`,
    `URL: ${content.url}`,
    `\nVisible text:\n${content.text}`,
    `\nLinks:`,
    ...content.links.map((l) => `  - "${l.text}" → ${l.href}`),
    `\nForms:`,
    ...content.forms.map(
      (f) =>
        `  - Form(id="${f.id}", action="${f.action}", inputs: ${f.inputs.map((i) => i.name || i.type).join(", ")})`
    ),
  ];
  if (ariaYaml) {
    const truncated = ariaYaml.length > 6000
      ? ariaYaml.slice(0, 6000) + "\n... (truncated)"
      : ariaYaml;
    sections.push(`\nAccessibility tree:\n${truncated}`);
  }
  return sections.join("\n");
}

// ===================================================================
// Tests
// ===================================================================

async function main() {
  console.log("=== A11y Tree Extraction Test Suite ===\n");

  // ---------------------------------------------------------------
  // GROUP 1: Snapshot extraction (8 assertions)
  // ---------------------------------------------------------------
  console.log("--- Snapshot extraction ---\n");

  console.log("1. Valid snapshot returns AriaSnapshot...");
  {
    const page = makeMockPage({ snapshotResult: { full: "- link \"Home\" [ref=s1e1]" } });
    const snap = await extractAriaSnapshot(page);
    assert(snap !== null, "snapshot not null");
    assert(snap!.yaml === "- link \"Home\" [ref=s1e1]", "yaml matches");
    assert(typeof snap!.timestamp === "number", "timestamp is number");
  }

  console.log("2. _snapshotForAI throwing returns null...");
  {
    const page = makeMockPage({ snapshotThrows: true });
    const snap = await extractAriaSnapshot(page);
    assert(snap === null, "returns null on throw");
  }

  console.log("3. _snapshotForAI returning no full field returns null...");
  {
    const page = makeMockPage({ snapshotResult: { other: "data" } });
    const snap = await extractAriaSnapshot(page);
    assert(snap === null, "returns null when no full field");
  }

  console.log("4. _snapshotForAI returning empty full returns null...");
  {
    const page = makeMockPage({ snapshotResult: { full: "" } });
    const snap = await extractAriaSnapshot(page);
    assert(snap === null, "returns null for empty full");
  }

  console.log("5. Page without _snapshotForAI method returns null...");
  {
    const page = makeMockPage({ hasSnapshotMethod: false });
    const snap = await extractAriaSnapshot(page);
    assert(snap === null, "returns null when method missing");
  }

  // ---------------------------------------------------------------
  // GROUP 2: buildPageText integration (6 assertions)
  // ---------------------------------------------------------------
  console.log("\n--- buildPageText with a11y tree ---\n");

  const baseContent: PageContent = {
    title: "Test Page",
    url: "https://example.com",
    text: "Hello world",
    links: [{ text: "Link 1", href: "https://example.com/1" }],
    forms: [],
  };

  console.log("6. Without ariaYaml, no accessibility section...");
  {
    const text = buildPageText(baseContent);
    assert(!text.includes("Accessibility tree:"), "no a11y section without yaml");
  }

  console.log("7. With null ariaYaml, no accessibility section...");
  {
    const text = buildPageText(baseContent, null);
    assert(!text.includes("Accessibility tree:"), "no a11y section with null");
  }

  console.log("8. With ariaYaml, accessibility section present...");
  {
    const yaml = "- link \"Home\" [ref=s1e1]\n- link \"About\" [ref=s1e2]";
    const text = buildPageText(baseContent, yaml);
    assert(text.includes("Accessibility tree:"), "a11y section present");
    assert(text.includes("[ref=s1e1]"), "contains ref identifier");
  }

  console.log("9. Large ariaYaml gets truncated at 6000 chars...");
  {
    const bigYaml = "x".repeat(7000);
    const text = buildPageText(baseContent, bigYaml);
    assert(text.includes("... (truncated)"), "truncation marker present");
    // The a11y section should contain at most 6000 chars of yaml + truncation marker
    const a11ySection = text.split("Accessibility tree:\n")[1];
    assert(a11ySection.indexOf("x".repeat(6001)) === -1, "yaml truncated before 6001 chars");
  }

  // ---------------------------------------------------------------
  // GROUP 3: Ref-based click execution (12 assertions)
  // ---------------------------------------------------------------
  console.log("\n--- Ref-based execution ---\n");

  console.log("10. Choice with ref only uses aria-ref locator...");
  {
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    const deps = makeMockExecDeps(mockPage, mockNav, cm);

    const choice: PageInterpretation["choices"][number] = {
      index: 1, label: "Click me", action: "click", ref: "s1e5",
    };

    const result = await executeChoice(choice, deps);
    assert(result.navigated === true, "navigated via ref");
    assert(mockPage._lastClicked() === "s1e5", "clicked via ref locator");
  }

  console.log("11. Choice with ref + selector tries ref first...");
  {
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    const deps = makeMockExecDeps(mockPage, mockNav, cm);

    const choice: PageInterpretation["choices"][number] = {
      index: 1, label: "Click me", action: "click", ref: "s1e3", selector: "a.link",
    };

    const result = await executeChoice(choice, deps);
    assert(result.navigated === true, "navigated");
    assert(mockPage._lastClicked() === "s1e3", "used ref, not selector");
  }

  console.log("12. Choice with failing ref falls back to selector...");
  {
    const mockPage = makeMockPage({ locatorClickFails: true });
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    const deps = makeMockExecDeps(mockPage, mockNav, cm);

    const choice: PageInterpretation["choices"][number] = {
      index: 1, label: "Click me", action: "click", ref: "s1e3", selector: "a.fallback",
    };

    const result = await executeChoice(choice, deps);
    assert(result.navigated === true, "navigated via fallback");
    assert(mockPage._lastClicked() === "a.fallback", "fell back to CSS selector");
  }

  console.log("13. Choice with failing ref and no selector/url returns error...");
  {
    const mockPage = makeMockPage({ locatorClickFails: true });
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    const deps = makeMockExecDeps(mockPage, mockNav, cm);

    const choice: PageInterpretation["choices"][number] = {
      index: 1, label: "Click me", action: "click", ref: "s1e3",
    };

    const result = await executeChoice(choice, deps);
    assert(result.navigated === false, "did not navigate");
    assert(result.error === "ref click failed and no fallback", "correct error message");
  }

  console.log("14. URL choice ignores ref (navigate path unchanged)...");
  {
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    const deps = makeMockExecDeps(mockPage, mockNav, cm);

    const choice: PageInterpretation["choices"][number] = {
      index: 1, label: "Go there", action: "navigate", ref: "s1e1", url: "https://example.com/page2",
    };

    const result = await executeChoice(choice, deps);
    assert(result.navigated === true, "navigated via URL");
    assert(result.newUrl === "https://example.com/page2", "used URL path, not ref");
  }

  console.log("15. Ref click on anchor link returns anchorSkipped...");
  {
    const mockPage = makeMockPage();
    // Override locator to return anchor href
    const origLocator = mockPage.locator;
    mockPage.locator = (selector: string) => {
      const loc = origLocator(selector);
      loc.getAttribute = async (attr: string) => {
        if (attr === "href") return "#section";
        return null;
      };
      return loc;
    };
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    const deps = makeMockExecDeps(mockPage, mockNav, cm);

    const choice: PageInterpretation["choices"][number] = {
      index: 1, label: "Jump", action: "click", ref: "s1e7",
    };

    const result = await executeChoice(choice, deps);
    assert(result.navigated === false, "did not navigate");
    assert(result.anchorSkipped === true, "anchor was skipped");
  }

  // ---------------------------------------------------------------
  // GROUP 4: Ref-based fill execution (4 assertions)
  // ---------------------------------------------------------------
  console.log("\n--- Ref-based fill execution ---\n");

  console.log("16. Fill with fillPlan.ref uses ref locator...");
  {
    const mockPage = makeMockPage();
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    const deps = makeMockExecDeps(mockPage, mockNav, cm);

    const choice: PageInterpretation["choices"][number] = {
      index: 1, label: "Search", action: "fill",
      fillPlan: {
        inputSelector: "input#search",
        ref: "s1e10",
        submitAction: "enter",
      },
    };

    const result = await executeChoice(choice, deps, "test query");
    assert(result.navigated === true, "fill navigated");
    assert(mockPage._lastFilled() === "s1e10=test query", "used ref for fill");
  }

  console.log("17. Fill with failing ref falls back to CSS...");
  {
    const mockPage = makeMockPage({ locatorClickFails: true });
    const mockNav = makeMockNav(mockPage);
    const cm = new CrawlManager();
    const deps = makeMockExecDeps(mockPage, mockNav, cm);

    const choice: PageInterpretation["choices"][number] = {
      index: 1, label: "Search", action: "fill",
      fillPlan: {
        inputSelector: "input#search",
        ref: "s1e10",
        submitAction: "enter",
      },
    };

    const result = await executeChoice(choice, deps, "test query");
    assert(result.navigated === true, "fill navigated via fallback");
    assert(mockPage._lastFilled() === "input#search=test query", "fell back to CSS selector for fill");
  }

  // ---------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------
  console.log(`\n=== Results: ${passed} passed, ${failed} failed (${passed + failed} total) ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test suite crashed:", err);
  process.exit(1);
});
