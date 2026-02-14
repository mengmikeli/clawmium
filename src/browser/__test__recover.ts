import { chromium } from "playwright";
import { BrowserEngine } from "./engine";
import { detectLoginPage } from "../auth/detector";

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

/**
 * Serve inline HTML via a local HTTP server on a random port.
 */
async function withServer(
  pages: Record<string, string>,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const { createServer } = await import("http");
  const server = createServer((req, res) => {
    const path = req.url || "/";
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

/**
 * Simulate REPL-level recovery: engine.recover() + navigate to URL.
 * This is what forceRecover() / ensureBrowser() do in the REPL.
 */
async function recoverTo(engine: BrowserEngine, url: string): Promise<void> {
  await engine.recover();
  if (url && url !== "about:blank") {
    await engine.getPage().goto(url, { waitUntil: "domcontentloaded" });
  }
}

// --- Inline HTML fixtures ---

const PAGE_A = `<!DOCTYPE html>
<html><head><title>Page A (HN)</title></head>
<body><h1>A</h1><p>Hacker News homepage</p></body></html>`;

const PAGE_B = `<!DOCTYPE html>
<html><head><title>Page B (Article)</title></head>
<body><h1>B</h1><p>Cord Cutters article</p></body></html>`;

const PAGE_C = `<!DOCTYPE html>
<html><head><title>Page C</title></head>
<body><h1>C</h1><p>Third page</p></body></html>`;

const SIMPLE_PAGE = `<!DOCTYPE html>
<html><head><title>Test Page</title></head>
<body><h1>Hello</h1><p>Simple test page.</p></body></html>`;

const SECOND_PAGE = `<!DOCTYPE html>
<html><head><title>Second Page</title></head>
<body><h1>Page Two</h1></body></html>`;

const SEARCH_PAGE_WITH_HIDDEN_PASSWORD = `<!DOCTYPE html>
<html><head><title>npmx - Package Browser</title></head>
<body>
  <nav>
    ${Array.from({ length: 25 }, (_, i) => `<a href="/pkg/${i}">Package ${i}</a>`).join("\n    ")}
  </nav>
  <form action="/search"><input type="search" name="q" placeholder="Search packages"></form>
  <!-- SPA hydration injects a connect dropdown with password field -->
  <div class="dropdown" style="display:none">
    <form><input type="text" name="token"><input type="password" name="secret"></form>
  </div>
</body></html>`;

const REAL_LOGIN_PAGE = `<!DOCTYPE html>
<html><head><title>Sign In</title></head>
<body>
  <form action="/api/login" method="POST">
    <label for="email">Email</label>
    <input type="email" id="email" name="email">
    <label for="pass">Password</label>
    <input type="password" id="pass" name="password">
    <button type="submit">Sign In</button>
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

// ===================================================================
// Test runner
// ===================================================================

async function main() {
  console.log("=== Recovery, Detection & REPL Stack Test Suite ===\n");

  // ---------------------------------------------------------------
  // GROUP 1: Browser engine disconnect & recovery
  // ---------------------------------------------------------------
  console.log("--- Engine: disconnect & recovery ---\n");

  console.log("1. Disconnect listener scoping...");
  await withServer({ "/": SIMPLE_PAGE }, async (baseUrl) => {
    const engine = new BrowserEngine();
    await engine.launch(baseUrl);
    await engine.getPage().goto(baseUrl);

    const oldBrowser = (engine as any).browser;
    await oldBrowser.close();

    assert(!engine.isAlive(), "Engine detects dead browser after close");

    await engine.recover();
    assert(engine.isAlive(), "Engine alive after recovery");

    await new Promise((r) => setTimeout(r, 100));
    assert(engine.isAlive(), "Engine still alive (no stale disconnect event)");

    await engine.close();
  });
  console.log();

  console.log("2. recover() + caller navigates to currentUrl...");
  await withServer({ "/": SIMPLE_PAGE, "/page2": SECOND_PAGE }, async (baseUrl) => {
    const engine = new BrowserEngine();
    await engine.launch(baseUrl);
    await engine.getPage().goto(`${baseUrl}/page2`, { waitUntil: "domcontentloaded" });

    const browser = (engine as any).browser;
    await browser.close();
    await new Promise((r) => setTimeout(r, 50));
    assert(!engine.isAlive(), "Engine detects crash");

    await recoverTo(engine, `${baseUrl}/page2`);
    assert(engine.isAlive(), "Alive after recovery");
    assert(engine.getPage().url().includes("/page2"), "Recovered to /page2");

    await engine.close();
  });
  console.log();

  console.log("3. Closing headed browser window → isAlive() false...");
  await withServer({ "/": SIMPLE_PAGE }, async (baseUrl) => {
    const engine = new BrowserEngine();
    await engine.launch(baseUrl);
    await engine.getPage().goto(baseUrl, { waitUntil: "domcontentloaded" });

    const created = await engine.show();
    assert(created, "show() created headed browser");
    assert(engine.isShowing(), "isShowing() true");

    const headedBrowser = (engine as any).browser;
    await headedBrowser.close();
    await new Promise((r) => setTimeout(r, 50));

    assert(!engine.isAlive(), "isAlive() false after close");
    assert(!engine.isShowing(), "isShowing() false after close");

    await engine.recover();
    assert(engine.isAlive(), "Alive after recovery");
    await engine.close();
  });
  console.log();

  console.log("4. show → close → recover → show again...");
  await withServer({ "/": SIMPLE_PAGE }, async (baseUrl) => {
    const engine = new BrowserEngine();
    await engine.launch(baseUrl);
    await engine.getPage().goto(baseUrl, { waitUntil: "domcontentloaded" });

    await engine.show();
    const browser1 = (engine as any).browser;
    await browser1.close();
    await new Promise((r) => setTimeout(r, 50));
    assert(!engine.isAlive(), "Dead after close");

    await engine.recover();
    const created = await engine.show();
    assert(created, "Second show() created new headed browser");
    assert(engine.isShowing(), "Showing after second show()");
    await engine.close();
  });
  console.log();

  console.log("5. WSL2: page context dies but browser.isConnected() true...");
  await withServer({ "/": SIMPLE_PAGE, "/page2": SECOND_PAGE }, async (baseUrl) => {
    const engine = new BrowserEngine();
    await engine.launch(baseUrl);
    await engine.getPage().goto(`${baseUrl}/page2`, { waitUntil: "domcontentloaded" });

    const ctx = (engine as any).context;
    await ctx.close();

    assert(engine.isAlive(), "isAlive() true (browser connected, page dead)");

    let evalFailed = false;
    try { await engine.getPage().evaluate(() => document.title); }
    catch { evalFailed = true; }
    assert(evalFailed, "page.evaluate() throws on dead page");

    await recoverTo(engine, `${baseUrl}/page2`);
    assert(engine.isAlive(), "Alive after forced recovery");
    assert(engine.getPage().url().includes("/page2"), "Recovered to /page2");

    const title = await engine.getPage().evaluate(() => document.title);
    assert(title === "Second Page", `page.evaluate works (got "${title}")`);
    await engine.close();
  });
  console.log();

  // ---------------------------------------------------------------
  // GROUP 2: Login detection
  // ---------------------------------------------------------------
  console.log("--- Login detection ---\n");

  console.log("6. Search page with SPA password field → NOT login...");
  await withServer({ "/": SEARCH_PAGE_WITH_HIDDEN_PASSWORD }, async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    const result = await detectLoginPage(page);
    console.log(`  Signals: ${JSON.stringify(result.signals)}`);
    assert(!result.isLoginPage, `Not login (confidence ${result.confidence})`);
    assert(result.signals["search_input"] === -30, "Search penalty applied");
    assert(result.signals["many_links"] === -15, "Many links penalty applied");
    assert(result.signals["password_input"] === 40, "Password signal detected");
    await browser.close();
  });
  console.log();

  console.log("7. Real login page → detected correctly...");
  await withServer({ "/login": REAL_LOGIN_PAGE }, async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });

    const result = await detectLoginPage(page);
    console.log(`  Signals: ${JSON.stringify(result.signals)}`);
    assert(result.isLoginPage, "Login page detected");
    assert(result.confidence >= 0.5, `Confidence >= 0.5 (got ${result.confidence})`);
    assert(result.signals["password_input"] === 40, "Password signal present");
    assert(result.signals["url_pattern"] === 30, "URL pattern present");
    await browser.close();
  });
  console.log();

  console.log("8. detectFormFields: scoped to password-containing forms...");
  await withServer({ "/": MIXED_FORMS_PAGE }, async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    const fields = await page.evaluate(() => {
      const results: Array<{ name: string; type: string }> = [];
      const forms = document.querySelectorAll("form");
      for (const form of forms) {
        if (!form.querySelector('input[type="password"]')) continue;
        const inputs = form.querySelectorAll('input:not([type="hidden"]):not([type="submit"])');
        for (const el of inputs) {
          const input = el as HTMLInputElement;
          results.push({ name: input.name || input.id || "", type: input.type || "text" });
        }
      }
      return results;
    });

    console.log(`  Fields: ${fields.map(f => `${f.name}(${f.type})`).join(", ")}`);
    assert(fields.length === 2, `2 fields from login form (got ${fields.length})`);
    assert(fields.some(f => f.name === "email"), "Email field included");
    assert(fields.some(f => f.name === "password"), "Password field included");
    assert(!fields.some(f => f.name === "q"), "Search input NOT included");
    assert(!fields.some(f => f.name === "category"), "Filter input NOT included");
    await browser.close();
  });
  console.log();

  console.log("9. Search-only page (no password) → not login...");
  await withServer({ "/": SEARCH_ONLY_PAGE }, async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    const result = await detectLoginPage(page);
    assert(!result.isLoginPage, "Not a login page");
    assert(result.confidence <= 0, `Confidence <= 0 (got ${result.confidence})`);
    await browser.close();
  });
  console.log();

  // ---------------------------------------------------------------
  // GROUP 3: REPL state machine — currentUrl tracks stack position
  //
  // This single test simulates the full user session:
  //   Navigate A → B → C → /show → close window → /back /back
  //   through cached stack → recover → verify browser lands
  //   where the REPL stack says we are, not where the headed
  //   browser last was.
  //
  // The REPL stack is source of truth. currentUrl must update
  // on every /back and /forward, so recovery always goes to the
  // user's current stack position.
  // ---------------------------------------------------------------
  console.log("--- REPL: state machine ---\n");

  console.log("10. Full REPL lifecycle: navigate → /show → close → /back /back → /forward → recover...");
  await withServer({ "/hn": PAGE_A, "/article": PAGE_B, "/comments": PAGE_C }, async (baseUrl) => {
    const engine = new BrowserEngine();
    await engine.launch(baseUrl);

    // --- Simulate REPL state ---
    let currentUrl = "";
    const backStack: string[] = [];
    const fwdStack: string[] = [];

    // Helper: simulate REPL's pushPageState + navigate
    const navigateTo = async (url: string) => {
      if (currentUrl) backStack.push(currentUrl);
      fwdStack.length = 0; // new navigation clears forward stack
      await engine.getPage().goto(url, { waitUntil: "domcontentloaded" });
      currentUrl = url;
    };

    // Helper: simulate REPL's /back (update stacks, set currentUrl, best-effort nav)
    const goBack = async () => {
      const target = backStack.pop()!;
      fwdStack.push(currentUrl);
      currentUrl = target;
      try {
        await engine.getPage().goto(target, { waitUntil: "domcontentloaded", timeout: 3000 });
      } catch { /* dead page — fine, currentUrl is still correct */ }
    };

    // Helper: simulate REPL's /forward
    const goForward = async () => {
      const target = fwdStack.pop()!;
      backStack.push(currentUrl);
      currentUrl = target;
      try {
        await engine.getPage().goto(target, { waitUntil: "domcontentloaded", timeout: 3000 });
      } catch { /* dead page — fine */ }
    };

    // === Step 1: Navigate HN → article → comments ===
    await navigateTo(`${baseUrl}/hn`);
    assert(currentUrl.includes("/hn"), "Step 1a: currentUrl = /hn");
    assert(backStack.length === 0, "Step 1a: back stack empty");

    await navigateTo(`${baseUrl}/article`);
    assert(currentUrl.includes("/article"), "Step 1b: currentUrl = /article");
    assert(backStack.length === 1 && backStack[0].includes("/hn"), "Step 1b: back stack = [/hn]");

    await navigateTo(`${baseUrl}/comments`);
    assert(currentUrl.includes("/comments"), "Step 1c: currentUrl = /comments");
    assert(backStack.length === 2, "Step 1c: back stack has 2 entries");
    assert(fwdStack.length === 0, "Step 1c: forward stack empty");

    // === Step 2: /show — opens headed browser on /comments ===
    await engine.show();
    assert(engine.isShowing(), "Step 2: headed browser showing");
    assert(engine.getPage().url().includes("/comments"), "Step 2: headed page on /comments");
    // currentUrl unchanged by /show
    assert(currentUrl.includes("/comments"), "Step 2: currentUrl still /comments");

    // === Step 3: User closes headed browser window ===
    const headedBrowser = (engine as any).browser;
    await headedBrowser.close();
    await new Promise((r) => setTimeout(r, 50));
    assert(!engine.isAlive(), "Step 3: browser dead after close");

    // === Step 4: /back through stack with dead browser ===
    // Each /back updates currentUrl from stack — browser nav will fail, that's OK
    await goBack(); // /comments → /article
    assert(currentUrl.includes("/article"), "Step 4a: currentUrl = /article after first /back");
    assert(backStack.length === 1 && backStack[0].includes("/hn"), "Step 4a: back stack = [/hn]");
    assert(fwdStack.length === 1 && fwdStack[0].includes("/comments"), "Step 4a: fwd stack = [/comments]");

    await goBack(); // /article → /hn
    assert(currentUrl.includes("/hn"), "Step 4b: currentUrl = /hn after second /back");
    assert(backStack.length === 0, "Step 4b: back stack empty");
    assert(fwdStack.length === 2, "Step 4b: fwd stack has 2 entries");
    assert(fwdStack[0].includes("/comments"), "Step 4b: fwd[0] = /comments");
    assert(fwdStack[1].includes("/article"), "Step 4b: fwd[1] = /article");

    // === Step 5: /forward one step ===
    await goForward(); // /hn → /article
    assert(currentUrl.includes("/article"), "Step 5: currentUrl = /article after /forward");
    assert(backStack.length === 1 && backStack[0].includes("/hn"), "Step 5: back stack = [/hn]");
    assert(fwdStack.length === 1 && fwdStack[0].includes("/comments"), "Step 5: fwd stack = [/comments]");

    // === Step 6: Recover — browser should land on currentUrl (/article) ===
    await recoverTo(engine, currentUrl);
    assert(engine.isAlive(), "Step 6: alive after recovery");
    const finalUrl = engine.getPage().url();
    assert(finalUrl.includes("/article"), `Step 6: recovered to /article (got ${finalUrl})`);
    assert(!finalUrl.includes("/comments"), "Step 6: did NOT recover to /comments (last headed URL)");
    assert(!finalUrl.includes("/hn"), "Step 6: did NOT recover to /hn");

    // === Step 7: Verify stacks survived recovery ===
    assert(backStack.length === 1 && backStack[0].includes("/hn"), "Step 7: back stack intact after recovery");
    assert(fwdStack.length === 1 && fwdStack[0].includes("/comments"), "Step 7: fwd stack intact after recovery");

    await engine.close();
  });
  console.log();

  // ---------------------------------------------------------------
  // Test 14: Home URL persistence
  // ---------------------------------------------------------------
  console.log("11. Home URL: set → persist → clear...");
  {
    const fs = await import("fs");
    const pathMod = await import("path");
    const os = await import("os");
    const tmpDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "clm-test-"));

    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;

    const configPath = pathMod.join(tmpDir, "clm", "config.json");

    const { loadConfig: load1, saveConfig: save1 } = await reimportWriter();
    const empty = load1();
    assert(!empty.homeUrl, "No home URL before setting");

    save1({ homeUrl: "https://news.ycombinator.com/" });
    assert(fs.existsSync(configPath), "Config file created");

    const { loadConfig: load2 } = await reimportWriter();
    const loaded = load2();
    assert(loaded.homeUrl === "https://news.ycombinator.com/", `Persisted (got "${loaded.homeUrl}")`);

    const { saveConfig: save3 } = await reimportWriter();
    save3({ homeUrl: "" });
    const { loadConfig: load4 } = await reimportWriter();
    const cleared = load4();
    assert(!cleared.homeUrl || cleared.homeUrl === "", `Cleared (got "${cleared.homeUrl}")`);

    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log();

  // ---------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------
  console.log(`=== ${passed} passed, ${failed} failed (${passed + failed} total) ===`);
  if (failed > 0) process.exit(1);
}

async function reimportWriter() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes("output/writer")) {
      delete require.cache[key];
    }
  }
  return await import("../output/writer");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
