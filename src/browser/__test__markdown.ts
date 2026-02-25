import { BrowserEngine } from "./engine";
import { PageNavigator } from "./navigator";
import { NetworkInterceptor } from "./network";

const MARKDOWN_URL = "https://blog.cloudflare.com/markdown-for-agents/";
const NON_MARKDOWN_URL = "https://news.ycombinator.com/";

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

async function main() {
  console.log("=== Markdown Content Pipeline Integration Test ===\n");

  const engine = new BrowserEngine();

  // ---------------------------------------------------------------
  // 1. Cloudflare blog — should return text/markdown
  // ---------------------------------------------------------------
  console.log("1. Launching browser and navigating to Cloudflare blog...");
  await engine.launch(MARKDOWN_URL);
  let page = engine.getPage();
  const interceptor1 = new NetworkInterceptor();
  interceptor1.attach(page, MARKDOWN_URL);
  const nav1 = new PageNavigator(page);

  await nav1.goto(MARKDOWN_URL);
  // Give the response listener time to process
  await page.waitForTimeout(1000);

  const md = interceptor1.getMarkdownContent();
  console.log(`  Markdown content: ${md ? `${md.length} chars` : "null"}`);

  assert(md !== null, "Cloudflare blog returned markdown content");
  if (md) {
    assert(md.includes("# "), "Markdown contains heading (# )");
    assert(md.includes("Markdown for Agents") || md.includes("markdown"), "Markdown contains expected topic text");
    assert(md.length > 500, `Markdown is substantial (${md.length} chars > 500)`);
    assert(md.length <= 8000, `Markdown capped at 8000 chars (got ${md.length})`);
  }

  // DOM text still extracted (may be sparse since response is markdown, not HTML)
  const content1 = await nav1.extractContent();
  assert(content1.text.length > 0, "DOM text extracted (browser renders markdown as plaintext)");

  // A11y tree should still work
  const aria1 = await nav1.extractAriaSnapshot();
  assert(aria1 !== null, "A11y tree extracted alongside markdown");

  console.log();

  // ---------------------------------------------------------------
  // 2. Route override delivers text/markdown from server
  // ---------------------------------------------------------------
  console.log("2. Verifying route override delivers markdown...");

  // The proof that the Accept header was correctly overridden is that
  // the server responded with text/markdown (verified by interceptor).
  // Playwright's request.headers() shows pre-route headers, so we
  // verify via the server's response content-type instead.
  let responseContentType: string | null = null;
  page.on("response", async (resp) => {
    if (resp.url() === MARKDOWN_URL && resp.request().resourceType() === "document") {
      responseContentType = resp.headers()["content-type"] || null;
    }
  });
  interceptor1.clear();
  await nav1.goto(MARKDOWN_URL);
  await page.waitForTimeout(500);

  assert(responseContentType !== null, "Got response for document request");
  if (responseContentType) {
    assert(responseContentType.includes("text/markdown"), `Server responded with text/markdown (got "${responseContentType}")`);
  }

  console.log();

  // ---------------------------------------------------------------
  // 3. Non-markdown site — should return null markdown
  // ---------------------------------------------------------------
  console.log("3. Navigating to non-markdown site (Hacker News)...");

  // Close and relaunch for clean interceptor state
  await engine.close();
  await engine.launch(NON_MARKDOWN_URL);
  page = engine.getPage();
  const interceptor2 = new NetworkInterceptor();
  interceptor2.attach(page, NON_MARKDOWN_URL);
  const nav2 = new PageNavigator(page);

  await nav2.goto(NON_MARKDOWN_URL);
  await page.waitForTimeout(1000);

  const md2 = interceptor2.getMarkdownContent();
  assert(md2 === null, "HN did not return markdown (as expected)");

  const content2 = await nav2.extractContent();
  assert(content2.title.includes("Hacker News"), `HN title correct: "${content2.title}"`);
  assert(content2.text.length > 100, "HN DOM text extracted normally");

  console.log();

  // ---------------------------------------------------------------
  // 4. Interceptor.clear() resets markdown
  // ---------------------------------------------------------------
  console.log("4. Interceptor.clear() resets markdown...");
  // Navigate to cloudflare to capture markdown
  await nav2.goto(MARKDOWN_URL);
  await page.waitForTimeout(1000);
  const mdBefore = interceptor2.getMarkdownContent();
  assert(mdBefore !== null, "Markdown captured before clear");
  interceptor2.clear();
  const mdAfter = interceptor2.getMarkdownContent();
  assert(mdAfter === null, "Markdown null after clear()");

  console.log();

  // ---------------------------------------------------------------
  // 5. Show/hide preserves markdown route (cookie transfer path)
  // ---------------------------------------------------------------
  console.log("5. Show/hide preserves markdown route...");
  await engine.close();
  await engine.launch(MARKDOWN_URL);
  page = engine.getPage();

  // Show (headed) — new context should still have markdown route
  const showResult = await engine.show();
  assert(showResult === true, "Browser switched to headed mode");

  // Reattach interceptor to new page after show
  const headedPage = engine.getPage();
  const interceptor4 = new NetworkInterceptor();
  interceptor4.attach(headedPage, MARKDOWN_URL);

  const headedNav = new PageNavigator(headedPage);
  await headedNav.goto(MARKDOWN_URL);
  await headedPage.waitForTimeout(1000);

  const mdHeaded = interceptor4.getMarkdownContent();
  assert(mdHeaded !== null, "Markdown captured in headed mode");
  if (mdHeaded) {
    assert(mdHeaded.length > 500, `Headed markdown is substantial (${mdHeaded.length} chars)`);
  }

  // ---------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------
  await engine.close();

  console.log("\n==================================================");
  console.log(`  ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log("==================================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test suite crashed:", err);
  process.exit(1);
});
