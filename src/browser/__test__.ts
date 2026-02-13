import { BrowserEngine } from "./engine";
import { PageNavigator } from "./navigator";
import { NetworkInterceptor } from "./network";
import { detectLoginPage } from "../auth/detector";
import { performCLIAuth } from "../auth/handoff";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  PASS: ${msg}`);
}

async function main() {
  const engine = new BrowserEngine();
  const interceptor = new NetworkInterceptor();

  console.log("=== Browser Engine Test Suite ===\n");

  // --- Step 1: Launch browser & attach interceptor ---
  console.log("1. Launching browser (headless)...");
  await engine.launch(BASE_URL);
  const page = engine.getPage();
  interceptor.attach(page, BASE_URL);
  interceptor.onIntercept = (resp) => {
    console.log(`  [NET] ${resp.method} ${resp.url} → ${resp.status} (${resp.size}B)`);
  };
  assert(!engine.isShowing(), "Browser is headless");
  console.log("  Browser launched, interceptor attached.\n");

  // --- Step 2: Navigate to home, verify /api/services intercepted ---
  console.log("2. Navigating to home page...");
  const nav = new PageNavigator(page);
  await nav.goto(BASE_URL);
  const homeContent = await nav.extractContent();
  console.log(`  Title: ${homeContent.title}`);
  console.log(`  Links: ${homeContent.links.length}`);
  console.log(`  Forms: ${homeContent.forms.length}`);

  // Wait a moment for async API responses to be captured
  await page.waitForTimeout(1000);

  const servicesResp = interceptor.getLatest("/api/services");
  assert(servicesResp !== undefined, "/api/services was intercepted");
  if (servicesResp) {
    const services = servicesResp.body as Array<unknown>;
    assert(Array.isArray(services) && services.length === 4, `/api/services returned 4 items`);
  }
  console.log();

  // --- Step 3: Navigate to login, verify detection ---
  console.log("3. Navigating to login page...");
  await nav.goto(`${BASE_URL}/login.html`);
  const loginResult = await detectLoginPage(page);
  console.log(`  Confidence: ${loginResult.confidence}`);
  console.log(`  Signals:`, loginResult.signals);
  assert(loginResult.isLoginPage, "Login page detected");
  assert(loginResult.confidence >= 0.9, `Confidence >= 0.9 (got ${loginResult.confidence})`);

  const loginContent = await nav.extractContent();
  assert(loginContent.forms.length > 0, "Login form found");
  if (loginContent.forms.length > 0) {
    const form = loginContent.forms[0];
    const inputTypes = form.inputs.map((i) => i.type);
    assert(inputTypes.includes("password"), "Password input in form");
  }
  console.log();

  // --- Step 4: CLI auth — type credentials in terminal ---
  console.log("4. CLI auth — enter credentials below:");
  console.log("   (username: mike.chen, password: cityserve2025)");
  const authResult = await performCLIAuth(page);
  assert(authResult.success, "CLI auth succeeded");
  assert(authResult.cookies.length > 0, `Got ${authResult.cookies.length} cookies`);
  console.log(`  Redirected to: ${authResult.redirectedTo}`);
  assert(authResult.redirectedTo.includes("dashboard"), "Redirected to dashboard");
  console.log();

  // --- Step 5: Navigate to water bill, verify /api/water-bill ---
  console.log("5. Navigating to water bill page...");
  interceptor.clear();
  await nav.goto(`${BASE_URL}/water-bill.html`);
  await page.waitForTimeout(1000);

  const waterResp = interceptor.getLatest("/api/water-bill");
  assert(waterResp !== undefined, "/api/water-bill was intercepted");
  if (waterResp) {
    const bill = waterResp.body as Record<string, unknown>;
    assert(bill.accountNumber === "CS-2025-84291", `Account number is CS-2025-84291`);
    const currentBill = bill.currentBill as Record<string, unknown>;
    assert(currentBill.amount === 84.5, `Amount is $84.50`);
  }
  console.log();

  // --- Step 6: Show/hide toggle test ---
  console.log("6. Show/hide toggle test...");
  assert(!engine.isShowing(), "Initially headless");
  await engine.show();
  assert(engine.isShowing(), "Now headed/visible");
  await engine.hide();
  assert(!engine.isShowing(), "Back to headless");
  console.log();

  // --- Step 7: Close browser ---
  console.log("7. Closing browser...");
  await engine.close();
  console.log("  Browser closed.\n");

  console.log("=== All tests passed! ===");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
