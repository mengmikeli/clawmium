import { chromium } from "playwright";
import { isHNDomain, isHNItemPage, extractHNComments, formatHNPageForLLM, HNItemPage } from "./sites/hn";
import { detectInteractiveForms, DetectedForm } from "./forms/detector";
import { formatGoal, addBreadcrumb } from "./cli/goals";
import { GoalContext, PageInterpretation } from "./llm/provider";

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  PASS: ${msg}`);
    passed++;
  }
}

function skip(msg: string): void {
  console.log(`  SKIP: ${msg}`);
  skipped++;
}

// Check if browser can launch (system deps may be missing)
let browserAvailable = true;
async function checkBrowser(): Promise<void> {
  try {
    const b = await chromium.launch({ headless: true });
    await b.close();
  } catch {
    browserAvailable = false;
  }
}

// 1x1 transparent GIF (base64) — used for HN indent images so width attribute is respected
const PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

async function withServer(
  pages: Record<string, string>,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const { createServer } = await import("http");
  const server = createServer((req, res) => {
    const path = req.url || "/";
    // Serve pixel GIF for image requests (HN indent images)
    if (path.endsWith(".gif")) {
      res.writeHead(200, { "Content-Type": "image/gif", "Content-Length": String(PIXEL_GIF.length) });
      res.end(PIXEL_GIF);
      return;
    }
    const html = pages[path];
    if (html) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://localhost:${addr.port}`;
  try {
    await fn(baseUrl);
  } finally {
    server.close();
  }
}

// --- Inline HTML fixtures ---

const HN_ITEM_PAGE = `<!DOCTYPE html>
<html><head><title>Test Article | Hacker News</title></head>
<body>
<table>
  <tr class="athing">
    <td class="title"><span class="titleline"><a href="https://example.com/article">Test Article</a></span></td>
  </tr>
  <tr>
    <td class="subtext">
      <span class="score">142 points</span> by <a class="hnuser">testuser</a>
      <span class="age"><a>3 hours ago</a></span>
    </td>
  </tr>
</table>
<table class="comment-tree">
  <tr class="comtr" id="111">
    <td><table><tr>
      <td class="ind"><img src="s.gif" width="0"></td>
      <td class="default">
        <div class="comhead">
          <a class="hnuser">alice</a> <span class="age"><a>2 hours ago</a></span>
        </div>
        <div class="comment"><span class="commtext">Top-level comment about the article</span></div>
      </td>
    </tr></table></td>
  </tr>
  <tr class="comtr" id="222">
    <td><table><tr>
      <td class="ind"><img src="s.gif" width="40"></td>
      <td class="default">
        <div class="comhead">
          <a class="hnuser">bob</a> <span class="age"><a>1 hour ago</a></span>
        </div>
        <div class="comment"><span class="commtext">Reply to alice with more detail</span></div>
      </td>
    </tr></table></td>
  </tr>
  <tr class="comtr" id="333">
    <td><table><tr>
      <td class="ind"><img src="s.gif" width="80"></td>
      <td class="default">
        <div class="comhead">
          <a class="hnuser">carol</a> <span class="age"><a>30 minutes ago</a></span>
        </div>
        <div class="comment"><span class="commtext">Nested reply to bob</span></div>
      </td>
    </tr></table></td>
  </tr>
</table>
</body></html>`;

const HN_SELF_POST_PAGE = `<!DOCTYPE html>
<html><head><title>Ask HN: Best practices? | Hacker News</title></head>
<body>
<table>
  <tr class="athing">
    <td class="title"><span class="titleline"><a href="https://news.ycombinator.com/item?id=99999">Ask HN: Best practices?</a></span></td>
  </tr>
  <tr>
    <td class="subtext">
      <span class="score">85 points</span> by <a class="hnuser">asker</a>
      <span class="age"><a>5 hours ago</a></span>
    </td>
  </tr>
</table>
<table class="comment-tree">
  <tr class="comtr" id="444">
    <td><table><tr>
      <td class="ind"><img src="s.gif" width="0"></td>
      <td class="default">
        <div class="comhead">
          <a class="hnuser">responder</a> <span class="age"><a>4 hours ago</a></span>
        </div>
        <div class="comment"><span class="commtext">Here is my advice on best practices</span></div>
      </td>
    </tr></table></td>
  </tr>
</table>
</body></html>`;

const MIXED_FORMS_PAGE = `<!DOCTYPE html>
<html><head><title>Mixed Forms</title></head>
<body>
  <form id="search-form" action="/search">
    <input type="search" name="q" placeholder="Search packages" id="search-input">
    <button type="submit">Search</button>
  </form>
  <form id="login-form" action="/api/login">
    <input type="email" name="email" id="login-email" placeholder="Email">
    <input type="password" name="password" id="login-pass" placeholder="Password">
    <button type="submit">Sign In</button>
  </form>
  <form id="filter-form" action="/filter">
    <input type="text" name="category" placeholder="Filter by category">
  </form>
</body></html>`;

const SEARCH_ONLY_PAGE = `<!DOCTYPE html>
<html><head><title>Search</title></head>
<body>
  <form action="/search">
    <input type="search" name="q" placeholder="Search...">
    <button type="submit">Go</button>
  </form>
</body></html>`;

const STANDALONE_SEARCH = `<!DOCTYPE html>
<html><head><title>Standalone Search</title></head>
<body>
  <h1>Welcome</h1>
  <input type="search" name="q" placeholder="Search everything" id="solo-search">
  <p>Some other content here.</p>
</body></html>`;

const NO_FORMS_PAGE = `<!DOCTYPE html>
<html><head><title>Plain Page</title></head>
<body>
  <h1>Just Text</h1>
  <p>No forms, no inputs, no nothing.</p>
</body></html>`;

const FIVE_FORMS_PAGE = `<!DOCTYPE html>
<html><head><title>Many Forms</title></head>
<body>
  <form id="f1" action="/s1"><input type="search" name="q" placeholder="Search 1"></form>
  <form id="f2" action="/s2"><input type="search" name="q" placeholder="Search 2"></form>
  <form id="f3" action="/s3"><input type="search" name="q" placeholder="Search 3"></form>
  <form id="f4" action="/s4"><input type="search" name="q" placeholder="Search 4"></form>
  <form id="f5" action="/s5"><input type="search" name="q" placeholder="Search 5"></form>
</body></html>`;

// ===================================================================
// Test runner
// ===================================================================

async function main() {
  console.log("=== Phase 5 Test Suite ===\n");

  // Pre-check: can we launch a browser?
  await checkBrowser();
  if (!browserAvailable) {
    console.log("⚠  Browser unavailable (missing system deps) — browser tests will be skipped\n");
  }

  // ---------------------------------------------------------------
  // GROUP 1: Pure function tests (no browser)
  // ---------------------------------------------------------------
  console.log("--- HN URL detection ---\n");

  console.log("1. isHNDomain...");
  assert(isHNDomain("https://news.ycombinator.com") === true, "news.ycombinator.com is HN");
  assert(isHNDomain("https://news.ycombinator.com/newest") === true, "HN subpath is HN domain");
  assert(isHNDomain("https://google.com") === false, "google.com is not HN");
  assert(isHNDomain("https://ycombinator.com") === false, "ycombinator.com (no news.) is not HN");
  console.log();

  console.log("2. isHNItemPage...");
  assert(isHNItemPage("https://news.ycombinator.com/item?id=12345") === true, "item?id=12345 is HN item page");
  assert(isHNItemPage("https://news.ycombinator.com/item?id=99999") === true, "item?id=99999 is HN item page");
  assert(isHNItemPage("https://news.ycombinator.com/newest") === false, "/newest is not item page");
  assert(isHNItemPage("https://news.ycombinator.com/") === false, "HN root is not item page");
  assert(isHNItemPage("not-a-url") === false, "invalid URL returns false (no crash)");
  assert(isHNItemPage("") === false, "empty string returns false");
  console.log();

  // ---------------------------------------------------------------
  console.log("--- formatHNPageForLLM ---\n");

  console.log("3. formatHNPageForLLM with article link...");
  {
    const item: HNItemPage = {
      title: "Test Article",
      articleUrl: "https://example.com/article",
      points: "142 points",
      author: "testuser",
      commentCount: 2,
      comments: [
        { author: "alice", age: "2 hours ago", text: "Great article!", depth: 0 },
        { author: "bob", age: "1 hour ago", text: "I agree with alice", depth: 1 },
      ],
    };
    const output = formatHNPageForLLM(item);
    assert(output.includes("=== Comments ==="), "Output contains === Comments ===");
    assert(output.includes("Article URL: https://example.com/article"), "Output contains Article URL");
    assert(output.includes("Title: Test Article"), "Output contains title");
    assert(output.includes("142 points"), "Output contains points");
    assert(output.includes("[alice]"), "Output contains comment author");
    assert(output.includes("[bob]"), "Output contains reply author");
  }
  console.log();

  console.log("4. formatHNPageForLLM self-post (no article URL)...");
  {
    const item: HNItemPage = {
      title: "Ask HN: Best practices?",
      articleUrl: "",
      points: "85 points",
      author: "asker",
      commentCount: 1,
      comments: [
        { author: "responder", age: "4 hours ago", text: "Here is my advice", depth: 0 },
      ],
    };
    const output = formatHNPageForLLM(item);
    assert(!output.includes("Article URL:"), "Self-post omits Article URL line");
    assert(output.includes("=== Comments ==="), "Still has comments section");
  }
  console.log();

  console.log("5. formatHNPageForLLM comment indentation...");
  {
    const item: HNItemPage = {
      title: "Indentation Test",
      articleUrl: "",
      points: "10 points",
      author: "tester",
      commentCount: 3,
      comments: [
        { author: "a", age: "1h", text: "depth 0", depth: 0 },
        { author: "b", age: "1h", text: "depth 1", depth: 1 },
        { author: "c", age: "1h", text: "depth 2", depth: 2 },
      ],
    };
    const output = formatHNPageForLLM(item);
    const lines = output.split("\n");
    // depth 0 → no indent, depth 1 → 2 spaces, depth 2 → 4 spaces
    const depth0Line = lines.find(l => l.includes("[a]"));
    const depth1Line = lines.find(l => l.includes("[b]"));
    const depth2Line = lines.find(l => l.includes("[c]"));
    assert(depth0Line !== undefined && !depth0Line.startsWith("  "), "Depth 0: no indent");
    assert(depth1Line !== undefined && depth1Line.startsWith("  ") && !depth1Line.startsWith("    "), "Depth 1: 2 spaces indent");
    assert(depth2Line !== undefined && depth2Line.startsWith("    "), "Depth 2: 4 spaces indent");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 2: HN Comment Extraction (browser + inline HTML)
  // ---------------------------------------------------------------
  console.log("--- HN comment extraction (browser) ---\n");

  if (!browserAvailable) {
    skip("6. extractHNComments: article page (browser unavailable)");
    skip("7. extractHNComments: self-post (browser unavailable)");
    console.log();
  } else {
  console.log("6. extractHNComments: article page...");
  await withServer({ "/": HN_ITEM_PAGE }, async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    await page.goto(baseUrl, { waitUntil: "networkidle" });

    const result = await extractHNComments(page);
    assert(result !== null, "extractHNComments returns non-null");
    if (result) {
      assert(result.title === "Test Article", `Title: "${result.title}"`);
      assert(result.articleUrl === "https://example.com/article", `Article URL: "${result.articleUrl}"`);
      assert(result.points === "142 points", `Points: "${result.points}"`);
      assert(result.author === "testuser", `Author: "${result.author}"`);
      assert(result.commentCount === 3, `Comment count: ${result.commentCount} (expected 3)`);

      // Depth from indent width: 0 → depth 0, 40 → depth 1, 80 → depth 2
      assert(result.comments[0].depth === 0, `Comment 1 depth: ${result.comments[0].depth} (expected 0)`);
      assert(result.comments[1].depth === 1, `Comment 2 depth: ${result.comments[1].depth} (expected 1)`);
      assert(result.comments[2].depth === 2, `Comment 3 depth: ${result.comments[2].depth} (expected 2)`);

      assert(result.comments[0].author === "alice", "Comment 1 author: alice");
      assert(result.comments[1].author === "bob", "Comment 2 author: bob");
    }
    await browser.close();
  });
  console.log();

  console.log("7. extractHNComments: self-post (articleUrl empty)...");
  await withServer({ "/": HN_SELF_POST_PAGE }, async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    const result = await extractHNComments(page);
    assert(result !== null, "extractHNComments returns non-null");
    if (result) {
      assert(result.articleUrl === "", `Self-post articleUrl is empty ("${result.articleUrl}")`);
      assert(result.title === "Ask HN: Best practices?", `Title: "${result.title}"`);
      assert(result.commentCount === 1, `Comment count: ${result.commentCount}`);
    }
    await browser.close();
  });
  console.log();
  } // end browserAvailable GROUP 2

  // ---------------------------------------------------------------
  // GROUP 3: Form Detection (browser + inline HTML)
  // ---------------------------------------------------------------
  console.log("--- Form detection (browser) ---\n");

  if (!browserAvailable) {
    skip("8. detectInteractiveForms: mixed forms page (browser unavailable)");
    skip("9. detectInteractiveForms: search-only page (browser unavailable)");
    skip("10. detectInteractiveForms: standalone search input (browser unavailable)");
    skip("11. detectInteractiveForms: no forms page (browser unavailable)");
    skip("12. detectInteractiveForms: cap at 3 forms (browser unavailable)");
    console.log();
  } else {
  console.log("8. detectInteractiveForms: mixed forms page...");
  await withServer({ "/": MIXED_FORMS_PAGE }, async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    const forms = await detectInteractiveForms(page);
    console.log(`  Detected ${forms.length} forms: ${forms.map(f => `${f.type}(${f.label})`).join(", ")}`);

    // Should find search form, skip login form, and find filter form (plain text input)
    assert(forms.some(f => f.type === "search"), "Search form detected");
    assert(!forms.some(f => f.label.toLowerCase().includes("login") || f.label.toLowerCase().includes("sign")), "Login form NOT returned");
    // The filter form has a plain text input but no search indicators — it may or may not be detected
    // The key assertion is that login is excluded and search is found
    assert(forms.length >= 1, "At least 1 form detected (search)");
    await browser.close();
  });
  console.log();

  console.log("9. detectInteractiveForms: search-only page...");
  await withServer({ "/": SEARCH_ONLY_PAGE }, async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    const forms = await detectInteractiveForms(page);
    assert(forms.length === 1, `Exactly 1 form (got ${forms.length})`);
    assert(forms[0].type === "search", "Form type is search");
    assert(forms[0].selector.includes("q") || forms[0].selector.includes("search"), `Selector targets search input: "${forms[0].selector}"`);
    await browser.close();
  });
  console.log();

  console.log("10. detectInteractiveForms: standalone search input...");
  await withServer({ "/": STANDALONE_SEARCH }, async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    const forms = await detectInteractiveForms(page);
    assert(forms.length === 1, `Exactly 1 form (got ${forms.length})`);
    assert(forms[0].type === "search", "Standalone input detected as search");
    assert(forms[0].formSelector === "", "formSelector empty for bare input");
    await browser.close();
  });
  console.log();

  console.log("11. detectInteractiveForms: no forms page...");
  await withServer({ "/": NO_FORMS_PAGE }, async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    const forms = await detectInteractiveForms(page);
    assert(forms.length === 0, "No forms detected on plain page");
    await browser.close();
  });
  console.log();

  console.log("12. detectInteractiveForms: cap at 3 forms...");
  await withServer({ "/": FIVE_FORMS_PAGE }, async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    const forms = await detectInteractiveForms(page);
    assert(forms.length <= 3, `Capped at 3 (got ${forms.length})`);
    await browser.close();
  });
  console.log();
  } // end browserAvailable GROUP 3

  // ---------------------------------------------------------------
  // GROUP 4: Goal Context (pure function tests)
  // ---------------------------------------------------------------
  console.log("--- Goal context lifecycle ---\n");

  console.log("13. formatGoal: base goal only...");
  {
    const gc: GoalContext = { baseGoal: "browsing news.ycombinator.com", activeIntent: "", breadcrumb: [] };
    assert(formatGoal(gc) === "browsing news.ycombinator.com", `formatGoal base: "${formatGoal(gc)}"`);
  }
  console.log();

  console.log("14. formatGoal: with activeIntent and breadcrumb...");
  {
    const gc: GoalContext = { baseGoal: "browsing news.ycombinator.com", activeIntent: "looking for AI articles", breadcrumb: ["front page", "AI article"] };
    const result = formatGoal(gc);
    assert(result.includes("currently: looking for AI articles"), `Has activeIntent: "${result}"`);
    assert(result.includes("path: front page → AI article"), `Has breadcrumb path: "${result}"`);
    assert(result.startsWith("browsing news.ycombinator.com"), "Starts with baseGoal");
  }
  console.log();

  console.log("15. addBreadcrumb: caps at 3...");
  {
    const gc: GoalContext = { baseGoal: "test", activeIntent: "", breadcrumb: [] };
    addBreadcrumb(gc, "step 1");
    addBreadcrumb(gc, "step 2");
    addBreadcrumb(gc, "step 3");
    assert(gc.breadcrumb.length === 3, `3 breadcrumbs: ${gc.breadcrumb.length}`);
    assert(gc.breadcrumb[0] === "step 1", `First is step 1`);

    addBreadcrumb(gc, "step 4");
    assert(gc.breadcrumb.length === 3, `Still 3 after adding 4th: ${gc.breadcrumb.length}`);
    assert(gc.breadcrumb[0] === "step 2", `First shifted to step 2: "${gc.breadcrumb[0]}"`);
    assert(gc.breadcrumb[2] === "step 4", `Last is step 4: "${gc.breadcrumb[2]}"`);
  }
  console.log();

  console.log("16. Goal context: snapshot capture/restore preserves deep copy...");
  {
    const gc: GoalContext = { baseGoal: "browsing HN", activeIntent: "AI articles", breadcrumb: ["front page", "article"] };

    // Simulate snapshot capture (deep copy, same as Repl.captureSnapshot)
    const snapshot: GoalContext = { ...gc, breadcrumb: [...gc.breadcrumb] };

    // Mutate original
    gc.activeIntent = "changed intent";
    gc.breadcrumb.push("new step");

    // Snapshot should be unaffected
    assert(snapshot.activeIntent === "AI articles", `Snapshot intent unchanged: "${snapshot.activeIntent}"`);
    assert(snapshot.breadcrumb.length === 2, `Snapshot breadcrumb unchanged: ${snapshot.breadcrumb.length}`);
    assert(!snapshot.breadcrumb.includes("new step"), "Snapshot does not contain new step");

    // Simulate restore (deep copy back)
    const restored: GoalContext = { ...snapshot, breadcrumb: [...snapshot.breadcrumb] };
    assert(restored.activeIntent === "AI articles", "Restored intent correct");
    assert(restored.breadcrumb.length === 2, "Restored breadcrumb length correct");
  }
  console.log();

  console.log("17. Goal context: external navigation resets goal...");
  {
    const gc: GoalContext = { baseGoal: "browsing news.ycombinator.com", activeIntent: "looking for AI", breadcrumb: ["front page", "article"] };

    // Simulate /goto google.com — reset goal entirely
    const newGc: GoalContext = { baseGoal: "browsing google.com", activeIntent: "", breadcrumb: [] };
    assert(newGc.baseGoal === "browsing google.com", "Reset baseGoal to new site");
    assert(newGc.activeIntent === "", "Reset activeIntent to empty");
    assert(newGc.breadcrumb.length === 0, "Reset breadcrumb to empty");

    // Old goal should be unaffected (not mutated)
    assert(gc.baseGoal === "browsing news.ycombinator.com", "Old goal unchanged");
    assert(gc.activeIntent === "looking for AI", "Old intent unchanged");
  }
  console.log();

  // ---------------------------------------------------------------
  // GROUP 5: REPL Integration — appendSystemChoices form wiring (no browser)
  // ---------------------------------------------------------------
  console.log("--- REPL appendSystemChoices: form detection wiring ---\n");

  // Helper: simulates the appendSystemChoices logic from repl.ts
  // (We test the logic directly rather than importing the Repl class,
  //  which has heavy dependencies on BrowserEngine, LLMProvider, etc.)
  function appendSystemChoices(
    interpretation: PageInterpretation,
    detectedForms: DetectedForm[],
    loginAvailable: boolean
  ): void {
    for (const form of detectedForms) {
      const alreadyPresent = interpretation.choices.some(
        c => c.action === "fill" && c.fillPlan?.inputSelector === form.selector
      );
      if (alreadyPresent) continue;

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

    if (loginAvailable) {
      interpretation.choices.push({
        index: interpretation.choices.length + 1,
        label: "Log in to this site",
        action: "click",
      });
    }
  }

  function makeInterpretation(choices: PageInterpretation["choices"] = []): PageInterpretation {
    return {
      pageType: "navigation",
      summary: "Test page",
      choices,
      dataFound: null,
      requiresAuth: false,
      requiresHumanInput: false,
    };
  }

  console.log("18. appendSystemChoices: detected search form becomes fill choice...");
  {
    const interp = makeInterpretation();
    const forms: DetectedForm[] = [{
      type: "search",
      label: 'Search: "Search packages"',
      selector: "#search-input",
      formSelector: "#search-form",
      action: "/search",
    }];
    appendSystemChoices(interp, forms, false);

    assert(interp.choices.length === 1, `1 choice added (got ${interp.choices.length})`);
    assert(interp.choices[0].action === "fill", "Choice action is fill");
    assert(interp.choices[0].label === 'Search: "Search packages"', `Label: "${interp.choices[0].label}"`);
    assert(interp.choices[0].fillPlan?.inputSelector === "#search-input", `Selector: "${interp.choices[0].fillPlan?.inputSelector}"`);
    assert(interp.choices[0].fillPlan?.submitAction === "enter", "Submit action is enter");
    assert(interp.choices[0].index === 1, `Index: ${interp.choices[0].index}`);
  }
  console.log();

  console.log("19. appendSystemChoices: multiple forms appended in order...");
  {
    const interp = makeInterpretation([
      { index: 1, label: "Click something", action: "click", selector: "#btn" },
    ]);
    const forms: DetectedForm[] = [
      { type: "search", label: "Search this site", selector: "#q", formSelector: "#sf", action: "/s" },
      { type: "filter", label: "Filter results", selector: "#filter-form", formSelector: "#filter-form", action: "/f" },
    ];
    appendSystemChoices(interp, forms, false);

    assert(interp.choices.length === 3, `3 choices total (got ${interp.choices.length})`);
    assert(interp.choices[0].label === "Click something", "First choice is original LLM choice");
    assert(interp.choices[1].label === "Search this site", "Second choice is search form");
    assert(interp.choices[2].label === "Filter results", "Third choice is filter form");
    assert(interp.choices[1].index === 2, `Search form index: ${interp.choices[1].index}`);
    assert(interp.choices[2].index === 3, `Filter form index: ${interp.choices[2].index}`);
  }
  console.log();

  console.log("20. appendSystemChoices: dedup — skips form when LLM already has same selector...");
  {
    const interp = makeInterpretation([
      {
        index: 1,
        label: "Search packages",
        action: "fill",
        fillPlan: { inputSelector: "#search-input", submitAction: "enter" },
      },
    ]);
    const forms: DetectedForm[] = [{
      type: "search",
      label: 'Search: "Search packages"',
      selector: "#search-input",
      formSelector: "#search-form",
      action: "/search",
    }];
    appendSystemChoices(interp, forms, false);

    assert(interp.choices.length === 1, `Still 1 choice — deduped (got ${interp.choices.length})`);
    assert(interp.choices[0].label === "Search packages", "Original LLM label preserved");
  }
  console.log();

  console.log("21. appendSystemChoices: no dedup when selectors differ...");
  {
    const interp = makeInterpretation([
      {
        index: 1,
        label: "Search articles",
        action: "fill",
        fillPlan: { inputSelector: "#article-search", submitAction: "enter" },
      },
    ]);
    const forms: DetectedForm[] = [{
      type: "search",
      label: "Search this site",
      selector: "#global-search",
      formSelector: "#search-form",
      action: "/search",
    }];
    appendSystemChoices(interp, forms, false);

    assert(interp.choices.length === 2, `2 choices — different selectors (got ${interp.choices.length})`);
  }
  console.log();

  console.log("22. appendSystemChoices: login comes after forms...");
  {
    const interp = makeInterpretation();
    const forms: DetectedForm[] = [
      { type: "search", label: "Search this site", selector: "#q", formSelector: "#sf", action: "/s" },
    ];
    appendSystemChoices(interp, forms, true);

    assert(interp.choices.length === 2, `2 choices: form + login (got ${interp.choices.length})`);
    assert(interp.choices[0].action === "fill", "First is fill (form)");
    assert(interp.choices[1].label === "Log in to this site", "Last is login");
    assert(interp.choices[0].index === 1, "Form index is 1");
    assert(interp.choices[1].index === 2, "Login index is 2");
  }
  console.log();

  console.log("23. appendSystemChoices: no forms, no login — choices untouched...");
  {
    const interp = makeInterpretation([
      { index: 1, label: "Go somewhere", action: "navigate", url: "/page" },
    ]);
    appendSystemChoices(interp, [], false);

    assert(interp.choices.length === 1, `Still 1 choice (got ${interp.choices.length})`);
    assert(interp.choices[0].label === "Go somewhere", "Original choice unchanged");
  }
  console.log();

  console.log("24. appendSystemChoices: only non-fill LLM choices don't dedup...");
  {
    // LLM has a click action targeting the same selector — should NOT dedup
    const interp = makeInterpretation([
      { index: 1, label: "Click search box", action: "click", selector: "#search-input" },
    ]);
    const forms: DetectedForm[] = [{
      type: "search",
      label: 'Search: "Search packages"',
      selector: "#search-input",
      formSelector: "#search-form",
      action: "/search",
    }];
    appendSystemChoices(interp, forms, false);

    assert(interp.choices.length === 2, `2 choices — click doesn't dedup fill (got ${interp.choices.length})`);
    assert(interp.choices[0].action === "click", "First is original click");
    assert(interp.choices[1].action === "fill", "Second is detected form fill");
  }
  console.log();

  // ---------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------
  const total = passed + failed + skipped;
  const skipMsg = skipped > 0 ? `, ${skipped} skipped` : "";
  console.log(`=== ${passed} passed, ${failed} failed${skipMsg} (${total} total) ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
