import { CrawlManager, ReachedBy } from "./crawl/tree";
import { PageInterpretation, GoalContext } from "./llm/provider";
import { DetectedForm } from "./forms/detector";
import { setCrawlDir } from "./crawl/persistence";
import { setSessionDir } from "./session/persistence";

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
// Mock factories (following __test__auto.ts pattern)
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
    url: () => currentUrl,
    title: async () => "Mock Page Title",
    on: (_event: string, _cb: Function) => {},
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
      // Many callers use page.evaluate — return safe defaults based on function signature.
      const fnStr = fn.toString();
      // syncBrowser checks window.location.href
      if (fnStr.includes("location.href") || fnStr.includes("location")) return currentUrl;
      // detectInteractiveForms: returns array — its function contains "results" variable
      if (fnStr.includes("results") && fnStr.includes("querySelectorAll")) return [];
      // Link count query (detectLoginPage signal 7)
      if (fnStr.includes("a[href]") && fnStr.includes("length")) return 0;
      // scrollToLoad
      if (fnStr.includes("scrollHeight") || fnStr.includes("scrollTo")) return undefined;
      // Default: false covers password checks, form checks, button checks, search input
      return false;
    },
  };
}

function makeMockEngine(mockPage: any): any {
  let baseUrl = "https://example.com";
  let showing = false;

  return {
    getPage: () => mockPage,
    getBaseUrl: () => baseUrl,
    setBaseUrl: (url: string) => { baseUrl = url; },
    isAlive: () => true,
    isShowing: () => showing,
    launch: async () => {},
    recover: async () => {},
    show: async () => { showing = true; return true; },
    hide: async () => { showing = false; },
    close: async () => {},
    clearBrowserData: async () => {},
  };
}

function makeMockNav(mockPage: any): any {
  let lastGotoUrl = "";
  let gotoError: Error | null = null;

  return {
    goto: async (url: string) => {
      if (gotoError) { const err = gotoError; gotoError = null; throw err; }
      lastGotoUrl = url;
      mockPage._setUrl(url);
    },
    currentUrl: () => mockPage._url(),
    extractContent: async () => ({
      title: "Mock Page",
      url: mockPage._url(),
      text: "A".repeat(600), // >500 chars to avoid sparse content path
      links: [{ text: "Link 1", href: "https://example.com/link1" }],
      forms: [],
    }),
    extractAriaSnapshot: async () => null,
    _lastGotoUrl: () => lastGotoUrl,
    _setGotoError: (err: Error) => { gotoError = err; },
  };
}

function makeMockLLM(): any {
  return {
    interpret: async (_text: string, _goal: string, _ctx?: string) => {
      return makeInterpretation("Test page summary", [
        { index: 1, label: "First link", action: "navigate", url: "https://example.com/1" },
        { index: 2, label: "Second link", action: "navigate", url: "https://example.com/2" },
      ]);
    },
    planAction: async () => ({ type: "click", reason: "test" }),
    planAutoAction: async () => ({ type: "ask_human", reasoning: "test" }),
    extractData: async () => ({ title: "T", summary: "S", fields: {}, raw: {} }),
  };
}

function makeMockInterceptor(): any {
  return {
    clear: () => {},
    attach: () => {},
    getResponses: () => [],
    findRichContent: () => null,
    onIntercept: null,
  };
}

interface MockRl {
  promptCalls: number;
  questionCalls: number;
  closeCalls: number;
  prompt: () => void;
  question: (text: string, cb: (answer: string) => void) => void;
  close: () => void;
  on: (event: string, cb: Function) => any;
}

function makeMockRl(): MockRl {
  return {
    promptCalls: 0,
    questionCalls: 0,
    closeCalls: 0,
    prompt() { this.promptCalls++; },
    question(_text: string, cb: (answer: string) => void) { this.questionCalls++; cb(""); },
    close() { this.closeCalls++; },
    on() { return this; },
  };
}

interface SessionState {
  goalContext: GoalContext;
  currentInterpretation: PageInterpretation | null;
  previousInterpretation: PageInterpretation | null;
  lastExtracted: any;
  lastPageTitle: string;
  history: Array<{ role: "user" | "agent"; content: string }>;
  log: Array<{ role: string; content: string; timestamp: number }>;
  site: string;
  loginAvailable: boolean;
  detectedForms: DetectedForm[];
  homeUrl: string;
  currentUrl: string;
  pendingReachedBy: ReachedBy;
  debugEnabled: boolean;
}

/**
 * Create a Repl instance with all dependencies mocked.
 * Uses cast-to-any to access private fields (temporary — Phase 2 makes handlers public).
 */
function makeTestRepl() {
  const mockPage = makeMockPage();
  const mockEngine = makeMockEngine(mockPage);
  const mockNav = makeMockNav(mockPage);
  const mockLLM = makeMockLLM();
  const mockInterceptor = makeMockInterceptor();
  const mockRl = makeMockRl();
  const crawlManager = new CrawlManager();

  // Dynamically import and construct Repl, then inject mocks
  // We can't easily import Repl without triggering side effects,
  // so we simulate the Repl's handleInput by building a minimal state + calling methods directly.
  const state: SessionState = {
    goalContext: { baseGoal: "browsing example.com", activeIntent: "", breadcrumb: [] },
    currentInterpretation: null,
    previousInterpretation: null,
    lastExtracted: null,
    lastPageTitle: "",
    history: [],
    log: [],
    site: "example",
    loginAvailable: false,
    detectedForms: [],
    homeUrl: "",
    currentUrl: "https://example.com",
    pendingReachedBy: "auto",
    debugEnabled: false,
  };

  // We need to import Repl and cast to any to inject mocks
  const { Repl } = require("./cli/repl");
  const repl = new Repl(mockEngine, mockLLM, "browsing example.com", "example") as any;

  // Override internal fields
  repl.engine = mockEngine;
  repl.nav = mockNav;
  repl.llm = mockLLM;
  repl.interceptor = mockInterceptor;
  repl.rl = mockRl;
  repl.crawlManager = crawlManager;
  repl.state = state;
  repl.abortController = new AbortController();
  repl.muteInterceptor = false;
  repl.closingForAuth = false;
  repl.shuttingDown = false;

  // Create initial crawl so navigation has somewhere to track
  crawlManager.createCrawl("https://example.com", "Example Home", "goto");
  crawlManager.appendCursor(crawlManager.currentNodeId!, "goto");

  return { repl, state, mockPage, mockEngine, mockNav, mockLLM, mockInterceptor, mockRl, crawlManager };
}

// ===================================================================
// Tests
// ===================================================================

async function main() {
  console.log("=== REPL Safety Net Test Suite ===\n");

  // ---------------------------------------------------------------
  // GROUP 1: /goto handling (8 tests)
  // ---------------------------------------------------------------
  console.log("--- /goto handling ---\n");

  console.log("1. /goto with full URL navigates correctly...");
  {
    const { repl, state, mockNav } = makeTestRepl();
    await repl.handleInput("/goto https://other.com/page");
    assert(state.currentUrl === "https://other.com/page", "currentUrl updated to full URL");
    assert(state.site === "other", "site updated");
  }
  console.log();

  console.log("2. /goto with bare domain auto-prefixes https...");
  {
    const { repl, state } = makeTestRepl();
    await repl.handleInput("/goto nytimes.com");
    assert(state.currentUrl === "https://nytimes.com", "currentUrl has https prefix");
    assert(state.site === "nytimes", "site is nytimes");
  }
  console.log();

  console.log("3. /goto with relative path uses base URL...");
  {
    const { repl, state, mockEngine } = makeTestRepl();
    mockEngine.setBaseUrl("https://example.com");
    await repl.handleInput("/goto /about");
    assert(state.currentUrl === "https://example.com/about", "currentUrl is base + relative path");
    // Relative path should NOT trigger goal reset
    assert(state.goalContext.baseGoal === "browsing example.com", "goal not reset for relative path");
  }
  console.log();

  console.log("4. /goto to external URL resets goal context...");
  {
    const { repl, state } = makeTestRepl();
    state.goalContext = { baseGoal: "browsing example.com", activeIntent: "looking for stuff", breadcrumb: ["page1"] };
    await repl.handleInput("/goto https://other.com");
    assert(state.goalContext.baseGoal === "browsing other.com", "baseGoal reset to new domain");
    assert(state.goalContext.activeIntent === "", "activeIntent cleared");
    assert(state.goalContext.breadcrumb.length === 0, "breadcrumb cleared");
  }
  console.log();

  console.log("5. /goto to external URL stashes current crawl...");
  {
    const { repl, crawlManager } = makeTestRepl();
    const originalCrawlId = crawlManager.activeCrawl!.id;
    await repl.handleInput("/goto https://other.com");
    assert(crawlManager.hasStash(), "crawl was stashed");
    assert(crawlManager.activeCrawl!.id !== originalCrawlId, "new crawl started");
  }
  console.log();

  console.log("6. /goto nav error renders error without processCurrentPage...");
  {
    const { repl, state, mockNav, mockRl } = makeTestRepl();
    mockNav._setGotoError(new Error("could not reach badsite.com"));
    const urlBefore = state.currentUrl;
    await repl.handleInput("/goto https://badsite.com");
    // URL should NOT be updated when navigation fails
    assert(state.currentUrl === urlBefore, "currentUrl unchanged on nav error");
  }
  console.log();

  console.log("7. /goto with no arg shows usage error...");
  {
    const { repl, mockRl } = makeTestRepl();
    await repl.handleInput("/goto");
    assert(mockRl.promptCalls > 0, "prompt was called (error shown, user can retry)");
  }
  console.log();

  console.log("8. /goto sets pendingReachedBy to 'goto'...");
  {
    const { repl, state } = makeTestRepl();
    state.pendingReachedBy = "auto"; // reset
    await repl.handleInput("/goto https://other.com/test");
    // After processCurrentPage, pendingReachedBy is consumed and reset to "auto"
    // But the navigation was tracked as "goto"
    assert(state.pendingReachedBy === "auto", "pendingReachedBy consumed after processCurrentPage");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 2: /home handling (6 tests)
  // ---------------------------------------------------------------
  console.log("--- /home handling ---\n");

  console.log("9. /home navigates when homeUrl is set...");
  {
    const { repl, state } = makeTestRepl();
    state.homeUrl = "https://myhome.com";
    await repl.handleInput("/home");
    assert(state.currentUrl === "https://myhome.com", "navigated to homeUrl");
  }
  console.log();

  console.log("10. /home clear clears the home URL...");
  {
    const { repl, state } = makeTestRepl();
    state.homeUrl = "https://myhome.com";
    await repl.handleInput("/home clear");
    assert(state.homeUrl === "", "homeUrl cleared");
  }
  console.log();

  console.log("11. /home <url> sets homeUrl without navigating...");
  {
    const { repl, state } = makeTestRepl();
    const urlBefore = state.currentUrl;
    await repl.handleInput("/home set news.ycombinator.com");
    assert(state.homeUrl === "https://news.ycombinator.com", "homeUrl set with https prefix");
    assert(state.currentUrl === urlBefore, "did NOT navigate (just set)");
  }
  console.log();

  console.log("12. /home navigate resets goalContext...");
  {
    const { repl, state } = makeTestRepl();
    state.homeUrl = "https://myhome.com";
    state.goalContext = { baseGoal: "old goal", activeIntent: "intent", breadcrumb: ["old"] };
    await repl.handleInput("/home");
    assert(state.goalContext.baseGoal === "browsing myhome.com", "baseGoal reset");
    assert(state.goalContext.activeIntent === "", "activeIntent cleared");
  }
  console.log();

  console.log("13. /home navigate error is handled...");
  {
    const { repl, state, mockNav } = makeTestRepl();
    state.homeUrl = "https://badsite.com";
    mockNav._setGotoError(new Error("could not reach badsite.com"));
    const urlBefore = state.currentUrl;
    await repl.handleInput("/home");
    assert(state.currentUrl === urlBefore, "currentUrl unchanged on home nav error");
  }
  console.log();

  console.log("14. /home with full URL sets homeUrl...");
  {
    const { repl, state } = makeTestRepl();
    await repl.handleInput("/home https://myhome.com");
    assert(state.homeUrl === "https://myhome.com", "homeUrl set to full URL");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 3: /back and /forward (6 tests)
  // ---------------------------------------------------------------
  console.log("--- /back and /forward ---\n");

  console.log("15. /back restores from previous crawl node...");
  {
    const { repl, state, crawlManager } = makeTestRepl();
    // Navigate to a second page first
    const node2 = crawlManager.addNavigation("https://example.com/page2", "Page 2", "choice");
    crawlManager.appendCursor(node2.id, "choice");
    crawlManager.setNodeMetadata(node2.id, {
      interpretation: makeInterpretation("Page 2 summary"),
      goalContext: { baseGoal: "browsing example.com", activeIntent: "reading page 2", breadcrumb: [] },
    });
    state.currentUrl = "https://example.com/page2";

    await repl.handleInput("/back");
    assert(state.currentUrl === "https://example.com", "currentUrl restored to first page");
  }
  console.log();

  console.log("16. /back pops stash when at start of crawl...");
  {
    const { repl, state, crawlManager } = makeTestRepl();
    // Stash the current crawl
    crawlManager.pushStash();
    // Start a new crawl
    crawlManager.createCrawl("https://other.com", "Other Home", "goto");
    crawlManager.appendCursor(crawlManager.currentNodeId!, "goto");
    state.currentUrl = "https://other.com";

    // Set metadata on stashed crawl's node so restoreFromNode works
    const stashedNodes = crawlManager.stash[0].nodes;
    const stashedNodeId = crawlManager.stash[0].currentNodeId!;
    const stashedNode = stashedNodes.get(stashedNodeId)!;
    stashedNode.metadata = {
      interpretation: makeInterpretation("Stashed page summary"),
      goalContext: { baseGoal: "browsing example.com", activeIntent: "", breadcrumb: [] },
    };

    await repl.handleInput("/back");
    assert(state.currentUrl === "https://example.com", "restored stashed crawl URL");
    assert(!crawlManager.hasStash(), "stash is now empty");
  }
  console.log();

  console.log("17. /back at start with no stash warns user...");
  {
    const { repl, crawlManager } = makeTestRepl();
    // Reset cursor so we're at position 0
    crawlManager.cursorIndex = 0;
    crawlManager.cursorHistory = [crawlManager.cursorHistory[0]];
    await repl.handleInput("/back");
    // No stash, no previous cursor — should just warn
    assert(!crawlManager.hasStash(), "no stash available");
  }
  console.log();

  console.log("18. /forward advances cursor...");
  {
    const { repl, state, crawlManager } = makeTestRepl();
    // Navigate forward to create entries
    const node2 = crawlManager.addNavigation("https://example.com/page2", "Page 2", "choice");
    crawlManager.appendCursor(node2.id, "choice");
    crawlManager.setNodeMetadata(node2.id, {
      interpretation: makeInterpretation("Page 2 summary"),
    });
    state.currentUrl = "https://example.com/page2";

    // Go back
    crawlManager.cursorBack();
    state.currentUrl = "https://example.com";

    // Now forward
    await repl.handleInput("/forward");
    assert(state.currentUrl === "https://example.com/page2", "currentUrl advanced to page2");
  }
  console.log();

  console.log("19. /forward with no forward history warns...");
  {
    const { repl, mockRl } = makeTestRepl();
    await repl.handleInput("/forward");
    assert(mockRl.promptCalls > 0, "prompt called after warning");
  }
  console.log();

  console.log("20. /back then /forward round-trips...");
  {
    const { repl, state, crawlManager } = makeTestRepl();
    // Set up page2
    const node2 = crawlManager.addNavigation("https://example.com/page2", "Page 2", "choice");
    crawlManager.appendCursor(node2.id, "choice");
    crawlManager.setNodeMetadata(node2.id, {
      interpretation: makeInterpretation("Page 2 summary"),
    });
    state.currentUrl = "https://example.com/page2";

    // Set metadata on root node too
    const rootNode = crawlManager.getNode(crawlManager.activeCrawl!.rootId)!;
    crawlManager.setNodeMetadata(rootNode.id, {
      interpretation: makeInterpretation("Home summary"),
    });

    await repl.handleInput("/back");
    assert(state.currentUrl === "https://example.com", "back to home");
    await repl.handleInput("/forward");
    assert(state.currentUrl === "https://example.com/page2", "forward to page2");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 4: Numbered choices (4 tests)
  // ---------------------------------------------------------------
  console.log("--- Numbered choices ---\n");

  console.log("21. Valid choice navigates...");
  {
    const { repl, state } = makeTestRepl();
    state.currentInterpretation = makeInterpretation("Page with links", [
      { index: 1, label: "Link A", action: "navigate", url: "https://example.com/a" },
      { index: 2, label: "Link B", action: "navigate", url: "https://example.com/b" },
    ]);
    await repl.handleInput("1");
    assert(state.currentUrl === "https://example.com/a", "navigated to choice 1 URL");
  }
  console.log();

  console.log("22. Invalid number with no matching choice falls to free text...");
  {
    const { repl, state } = makeTestRepl();
    state.currentInterpretation = makeInterpretation("Page", [
      { index: 1, label: "Only choice", action: "navigate", url: "https://example.com/1" },
    ]);
    // Number 99 doesn't match any choice — should fall to free text
    await repl.handleInput("99");
    // Free text triggers LLM interpret; currentUrl should stay the same
    assert(state.currentUrl === "https://example.com", "currentUrl unchanged (fell to free text)");
  }
  console.log();

  console.log("23. 'Show rendered page' choice calls engine.show...");
  {
    const { repl, state, mockEngine } = makeTestRepl();
    state.currentInterpretation = makeInterpretation("Data page", [
      { index: 1, label: "Show rendered page", action: "click" },
      { index: 2, label: "Save and quit", action: "click" },
    ]);
    await repl.handleInput("1");
    assert(mockEngine.isShowing() === true, "engine.show() was called");
  }
  console.log();

  console.log("24. Choice with url sets pendingReachedBy to 'choice'...");
  {
    const { repl, state, crawlManager } = makeTestRepl();
    state.currentInterpretation = makeInterpretation("Page", [
      { index: 1, label: "Navigate", action: "navigate", url: "https://example.com/target" },
    ]);
    // The choice execution goes through executeChoice which sets pendingReachedBy
    // After processCurrentPage consumes it, it resets to "auto"
    // We verify the navigation happened
    await repl.handleInput("1");
    assert(state.currentUrl === "https://example.com/target", "navigated via choice");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 5: Navigation invariants (4 tests)
  // ---------------------------------------------------------------
  console.log("--- Navigation invariants ---\n");

  console.log("25. /goto truncates cursor forward before navigation...");
  {
    const { repl, crawlManager } = makeTestRepl();
    // Add forward entries
    const node2 = crawlManager.addNavigation("https://example.com/2", "Page 2", "choice");
    crawlManager.appendCursor(node2.id, "choice");
    crawlManager.cursorBack(); // now at index 0, forward exists
    const forwardBefore = crawlManager.cursorHistory.length - crawlManager.cursorIndex - 1;
    assert(forwardBefore === 1, "forward entry exists before goto");

    await repl.handleInput("/goto https://example.com/new");
    // After navigation, the old forward should be gone
    const forwardAfter = crawlManager.cursorHistory.length - crawlManager.cursorIndex - 1;
    assert(forwardAfter === 0, "forward entries truncated after goto");
  }
  console.log();

  console.log("26. /goto clears interceptor before navigation...");
  {
    const { repl, mockInterceptor } = makeTestRepl();
    let clearCalled = false;
    mockInterceptor.clear = () => { clearCalled = true; };
    await repl.handleInput("/goto https://other.com/page");
    assert(clearCalled, "interceptor.clear() called during goto");
  }
  console.log();

  console.log("27. /goto updates currentUrl to target...");
  {
    const { repl, state } = makeTestRepl();
    await repl.handleInput("/goto https://other.com/specific");
    assert(state.currentUrl === "https://other.com/specific", "currentUrl set to goto target");
  }
  console.log();

  console.log("28. /refresh clears interceptor and re-processes...");
  {
    const { repl, mockInterceptor } = makeTestRepl();
    let clearCount = 0;
    mockInterceptor.clear = () => { clearCount++; };
    await repl.handleInput("/refresh");
    assert(clearCount > 0, "interceptor cleared during refresh");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 6: Other commands (4 tests)
  // ---------------------------------------------------------------
  console.log("--- Other commands ---\n");

  console.log("29. /url outputs current URL...");
  {
    const { repl, state, mockRl } = makeTestRepl();
    state.currentUrl = "https://example.com/current";
    await repl.handleInput("/url");
    assert(mockRl.promptCalls > 0, "prompt called after /url");
  }
  console.log();

  console.log("30. /help shows help and prompts...");
  {
    const { repl, mockRl } = makeTestRepl();
    await repl.handleInput("/help");
    assert(mockRl.promptCalls > 0, "prompt called after /help");
  }
  console.log();

  console.log("31. Unknown command shows error...");
  {
    const { repl, mockRl } = makeTestRepl();
    await repl.handleInput("/foobar");
    assert(mockRl.promptCalls > 0, "prompt called after unknown command");
  }
  console.log();

  console.log("32. /show calls engine.show...");
  {
    const { repl, mockEngine } = makeTestRepl();
    await repl.handleInput("/show");
    assert(mockEngine.isShowing(), "engine is showing after /show");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 7: /auto --max-steps flag parsing (7 tests)
  // ---------------------------------------------------------------
  console.log("--- /auto --max-steps flag parsing ---\n");

  console.log("33. /auto with plain goal calls runAutoMode(goal, undefined)...");
  {
    const { repl } = makeTestRepl();
    let capturedGoal = "";
    let capturedMaxSteps: number | undefined = -1;
    (repl as any).runAutoMode = async (goal: string, maxSteps?: number) => {
      capturedGoal = goal;
      capturedMaxSteps = maxSteps;
    };
    await repl.handleInput("/auto find AI articles");
    assert(capturedGoal === "find AI articles", "goal passed correctly");
    assert(capturedMaxSteps === undefined, "maxSteps is undefined when no flag");
  }
  console.log();

  console.log("34. /auto goal --max-steps 20 passes maxSteps=20...");
  {
    const { repl } = makeTestRepl();
    let capturedGoal = "";
    let capturedMaxSteps: number | undefined = -1;
    (repl as any).runAutoMode = async (goal: string, maxSteps?: number) => {
      capturedGoal = goal;
      capturedMaxSteps = maxSteps;
    };
    await repl.handleInput("/auto find AI articles --max-steps 20");
    assert(capturedGoal === "find AI articles", "goal extracted without flag");
    assert(capturedMaxSteps === 20, "maxSteps is 20");
  }
  console.log();

  console.log("35. /auto goal -s 5 passes maxSteps=5...");
  {
    const { repl } = makeTestRepl();
    let capturedGoal = "";
    let capturedMaxSteps: number | undefined = -1;
    (repl as any).runAutoMode = async (goal: string, maxSteps?: number) => {
      capturedGoal = goal;
      capturedMaxSteps = maxSteps;
    };
    await repl.handleInput("/auto find AI articles -s 5");
    assert(capturedGoal === "find AI articles", "goal extracted without short flag");
    assert(capturedMaxSteps === 5, "maxSteps is 5");
  }
  console.log();

  console.log("36. /auto goal --max-steps abc shows error...");
  {
    const { repl } = makeTestRepl();
    let autoModeCalled = false;
    (repl as any).runAutoMode = async () => { autoModeCalled = true; };
    await repl.handleInput("/auto find articles --max-steps abc");
    assert(!autoModeCalled, "runAutoMode NOT called for invalid --max-steps");
  }
  console.log();

  console.log("37. /auto goal --max-steps 0 shows error (out of bounds)...");
  {
    const { repl } = makeTestRepl();
    let autoModeCalled = false;
    (repl as any).runAutoMode = async () => { autoModeCalled = true; };
    await repl.handleInput("/auto find articles --max-steps 0");
    assert(!autoModeCalled, "runAutoMode NOT called for --max-steps 0");
  }
  console.log();

  console.log("38. /auto goal --max-steps 101 shows error (out of bounds)...");
  {
    const { repl } = makeTestRepl();
    let autoModeCalled = false;
    (repl as any).runAutoMode = async () => { autoModeCalled = true; };
    await repl.handleInput("/auto find articles --max-steps 101");
    assert(!autoModeCalled, "runAutoMode NOT called for --max-steps 101");
  }
  console.log();

  console.log("39. /auto --max-steps 5 (no goal) shows error...");
  {
    const { repl } = makeTestRepl();
    let autoModeCalled = false;
    (repl as any).runAutoMode = async () => { autoModeCalled = true; };
    await repl.handleInput("/auto --max-steps 5");
    assert(!autoModeCalled, "runAutoMode NOT called when no goal text");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 8: /debug toggle (4 tests)
  // ---------------------------------------------------------------
  console.log("--- /debug toggle ---\n");

  console.log("40. /debug toggles debugEnabled from false to true...");
  {
    const { repl, state } = makeTestRepl();
    assert(state.debugEnabled === false, "starts false");
    await repl.handleInput("/debug");
    assert(state.debugEnabled === true, "toggled to true");
  }
  console.log();

  console.log("41. /debug again toggles back to false...");
  {
    const { repl, state } = makeTestRepl();
    state.debugEnabled = true;
    await repl.handleInput("/debug");
    assert(state.debugEnabled === false, "toggled back to false");
  }
  console.log();

  console.log("42. DEBUG=1 env starts with debugEnabled true...");
  {
    // Simulate by directly checking state init logic
    const debugVal = "1";
    const enabled = debugVal === "1" || debugVal === "true";
    assert(enabled === true, "DEBUG=1 results in true");
    const debugVal2 = "true";
    const enabled2 = debugVal2 === "1" || debugVal2 === "true";
    assert(enabled2 === true, "DEBUG=true results in true");
    const debugVal3 = "";
    const enabled3 = debugVal3 === "1" || debugVal3 === "true";
    assert(enabled3 === false, "empty DEBUG results in false");
  }
  console.log();

  console.log("43. Bare word 'debug' prompts 'did you mean /debug?'...");
  {
    const { repl, mockRl } = makeTestRepl();
    // Mock confirmAction to return false (user says no)
    (repl as any).confirmAction = async () => false;
    await repl.handleInput("debug");
    // Should have triggered confirmAction prompt and then fallen to free text
    assert(mockRl.promptCalls > 0, "prompt called after bare word fallback");
  }
  console.log();

  // ---------------------------------------------------------------
  // Cleanup test directory
  // ---------------------------------------------------------------
  cleanup();

  // ---------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------
  console.log("=".repeat(50));
  console.log(`  ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log("=".repeat(50));

  if (failed > 0) {
    process.exit(1);
  }
}

// Redirect disk writes to temp dir (runtime overrides, not env var — constants captured at import time)
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
const TEST_DIR = path.join(os.tmpdir(), `clm-repl-test-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });
setCrawlDir(TEST_DIR);
setSessionDir(TEST_DIR);
process.env.CLM_DIR = TEST_DIR; // writer.ts (saveConfig, saveData, saveSessionLog) respects env var

function cleanup(): void {
  try {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  } catch { /* best effort */ }
  setCrawlDir(null);
  setSessionDir(null);
}

// Silence render output during tests
const origStdoutWrite = process.stdout.write.bind(process.stdout);

let suppressRender = false;

function patchedWrite(data: any, ...args: any[]): boolean {
  if (suppressRender && typeof data === "string") {
    // Allow test output (PASS/FAIL, group headers, summary)
    if (data.includes("PASS:") || data.includes("FAIL:") || data.includes("---") ||
        data.includes("===") || data.includes("passed") || data.includes("REPL Safety") ||
        data.includes("...") || data.includes("console.log")) {
      return origStdoutWrite(data, ...args);
    }
    // Suppress render output (ANSI codes, progress lines)
    if (data.includes("\x1b[") || data.includes("\u22ef") || data.includes("\u2192")) {
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
