import "dotenv/config";
import { BrowserEngine } from "../browser/engine";
import { PageNavigator } from "../browser/navigator";
import { NetworkInterceptor } from "../browser/network";
import { LLMProvider } from "./provider";
import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider } from "./openai";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  PASS: ${msg}`);
}

function createProvider(): LLMProvider {
  const provider = process.env.LLM_PROVIDER || "anthropic";

  if (provider === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key || key === "sk-ant-...") {
      console.error("Set ANTHROPIC_API_KEY in .env");
      process.exit(1);
    }
    console.log("Using Anthropic provider");
    return new AnthropicProvider(key);
  }

  if (provider === "openai") {
    const key = process.env.OPENAI_API_KEY;
    if (!key || key === "sk-...") {
      console.error("Set OPENAI_API_KEY in .env");
      process.exit(1);
    }
    console.log("Using OpenAI provider");
    return new OpenAIProvider(key);
  }

  console.error(`Unknown LLM_PROVIDER: ${provider}`);
  process.exit(1);
}

async function main() {
  console.log("=== LLM Integration Test Suite ===\n");

  const llm = createProvider();
  const engine = new BrowserEngine();
  const interceptor = new NetworkInterceptor();

  // --- Step 1: Launch browser, navigate to home ---
  console.log("1. Launching browser and navigating to CityServe...");
  await engine.launch(BASE_URL);
  const page = engine.getPage();
  interceptor.attach(page, BASE_URL);

  const nav = new PageNavigator(page);
  await nav.goto(BASE_URL);
  const content = await nav.extractContent();

  // Build a text representation of the page for the LLM
  const pageText = [
    `Title: ${content.title}`,
    `URL: ${content.url}`,
    `\nVisible text:\n${content.text}`,
    `\nLinks:`,
    ...content.links.map((l) => `  - "${l.text}" → ${l.href}`),
    `\nForms:`,
    ...content.forms.map((f) => `  - Form(id="${f.id}", action="${f.action}", inputs: ${f.inputs.map((i) => i.name || i.type).join(", ")})`),
  ].join("\n");

  console.log(`  Page loaded: "${content.title}"`);
  console.log(`  ${content.links.length} links, ${content.forms.length} forms\n`);

  // --- Step 2: Test interpret() ---
  console.log("2. Testing interpret() — sending page content to LLM...");
  const interpretation = await llm.interpret(pageText, "check my water bill");
  console.log(`  pageType: ${interpretation.pageType}`);
  console.log(`  summary: ${interpretation.summary}`);
  console.log(`  choices: ${interpretation.choices.length}`);
  interpretation.choices.forEach((c) => {
    console.log(`    [${c.index}] ${c.label} (${c.action}: ${c.selector || c.url || "?"})`);
  });
  console.log(`  requiresAuth: ${interpretation.requiresAuth}`);

  assert(interpretation.pageType === "navigation", 'Page type is "navigation"');
  assert(interpretation.choices.length >= 2, "At least 2 choices returned");

  // Check that one of the choices relates to water
  const waterChoice = interpretation.choices.find(
    (c) => /water/i.test(c.label)
  );
  assert(waterChoice !== undefined, "A water-related choice exists");
  console.log();

  // --- Step 3: Test planAction() ---
  console.log("3. Testing planAction() — deciding what to do...");
  const action = await llm.planAction(interpretation, {
    userGoal: "check my water bill",
    history: [{ role: "user", content: "check my water bill" }],
    currentUrl: content.url,
    interceptedData: [],
  });
  console.log(`  action: ${action.type}`);
  console.log(`  reason: ${action.reason}`);
  if (action.selector) console.log(`  selector: ${action.selector}`);
  if (action.url) console.log(`  url: ${action.url}`);

  assert(
    action.type === "click" || action.type === "navigate",
    "Action is click or navigate"
  );
  console.log();

  // --- Step 4: Test extractData() with mock water bill ---
  console.log("4. Testing extractData() — extracting water bill data...");
  const mockWaterBill = JSON.stringify({
    accountNumber: "CS-2025-84291",
    serviceAddress: "1234 Oak Street, Bay Area, CA 94102",
    currentBill: {
      amount: 84.5,
      dueDate: "2026-03-01",
      billingPeriod: "Jan 15 – Feb 14, 2026",
      status: "unpaid",
    },
    usageHistory: [
      { month: "Feb 2026", gallons: 4200, amount: 84.5 },
      { month: "Jan 2026", gallons: 3800, amount: 76.0 },
    ],
  });

  const extracted = await llm.extractData(mockWaterBill, "check my water bill");
  console.log(`  title: ${extracted.title}`);
  console.log(`  summary: ${extracted.summary}`);
  console.log(`  fields:`, extracted.fields);

  assert(extracted.title.length > 0, "Title is non-empty");
  assert(extracted.summary.length > 0, "Summary is non-empty");
  assert(Object.keys(extracted.fields).length >= 2, "At least 2 fields extracted");
  console.log();

  // --- Cleanup ---
  console.log("5. Closing browser...");
  await engine.close();
  console.log("  Done.\n");

  console.log("=== All LLM tests passed! ===");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
