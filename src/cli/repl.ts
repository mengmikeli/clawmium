import * as readline from "readline";
import { BrowserEngine } from "../browser/engine";
import { PageNavigator, PageContent } from "../browser/navigator";
import { NetworkInterceptor } from "../browser/network";
import { detectLoginPage } from "../auth/detector";
import { performCLIAuth } from "../auth/handoff";
import { LLMProvider, PageInterpretation, ConversationContext, ExtractedData } from "../llm/provider";
import * as render from "./renderer";
import { saveData, saveSessionLog } from "../output/writer";

const LLM_TIMEOUT = 30_000; // 30s timeout for LLM calls

class CancelledError extends Error {
  constructor() { super("cancelled"); }
}

interface PageSnapshot {
  url: string;
  pageTitle: string;
  interpretation: PageInterpretation;
  userGoal: string;
}

interface SessionState {
  userGoal: string;
  currentInterpretation: PageInterpretation | null;
  previousInterpretation: PageInterpretation | null;
  lastExtracted: ExtractedData | null;
  lastPageTitle: string;
  history: Array<{ role: "user" | "agent"; content: string }>;
  log: Array<{ role: string; content: string; timestamp: number }>;
  site: string;
  pageStack: PageSnapshot[];
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }

    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (val) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(val); },
      (err) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(err); }
    );
  });
}

export class Repl {
  private engine: BrowserEngine;
  private nav!: PageNavigator;
  private interceptor: NetworkInterceptor;
  private llm: LLMProvider;
  private rl!: readline.Interface;
  private state: SessionState;
  private muteInterceptor = false;
  private closingForAuth = false;
  private shuttingDown = false;
  private abortController: AbortController | null = null;

  constructor(engine: BrowserEngine, llm: LLMProvider, userGoal: string, site: string) {
    this.engine = engine;
    this.llm = llm;
    this.interceptor = new NetworkInterceptor();
    this.state = {
      userGoal,
      currentInterpretation: null,
      previousInterpretation: null,
      lastExtracted: null,
      lastPageTitle: "",
      history: [{ role: "user", content: userGoal }],
      log: [{ role: "user", content: userGoal, timestamp: Date.now() }],
      site,
      pageStack: [],
    };
  }

  async start(baseUrl: string): Promise<void> {
    render.status("launching headless browser...");
    await this.engine.launch(baseUrl);

    const page = this.engine.getPage();
    this.nav = new PageNavigator(page);

    this.interceptor.attach(page, baseUrl);
    this.interceptor.onIntercept = (resp) => {
      if (!this.muteInterceptor) {
        render.intercepted(resp.method, resp.url, resp.status, resp.size);
      }
    };

    // Navigate to initial page
    render.status(`navigating to ${baseUrl}`);
    await this.nav.goto(baseUrl);

    // Process the first page
    await this.processCurrentPage();

    // Start the input loop
    this.startReadline();
  }

  private startReadline(): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: render.promptString(),
    });

    // Handle Ctrl+C: first cancels operation, second exits
    let lastSigint = 0;
    this.rl.on("SIGINT", () => {
      const now = Date.now();
      if (now - lastSigint < 2000) {
        // Double Ctrl+C within 2 seconds — exit
        process.stdout.write("\n");
        this.shutdown();
        return;
      }
      lastSigint = now;

      process.stdout.write("\n");
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
        render.status("cancelled (Ctrl+C again to quit)");
      } else {
        render.status("Ctrl+C again to quit");
      }
      this.rl.prompt();
    });

    this.rl.prompt();

    this.rl.on("line", async (line) => {
      const input = line.trim();
      if (!input) {
        this.rl.prompt();
        return;
      }

      this.abortController = new AbortController();
      try {
        await this.handleInput(input);
      } catch (err) {
        if (err instanceof CancelledError) {
          // Already handled by SIGINT handler
        } else {
          render.error((err as Error).message);
          this.rl.prompt();
        }
      }
      this.abortController = null;
    });

    this.rl.on("close", async () => {
      if (!this.closingForAuth) {
        await this.shutdown();
      }
    });
  }

  private get signal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }

  /**
   * Ensure browser is alive before running a browser operation.
   * If crashed, recover and reattach.
   */
  private async ensureBrowser(): Promise<void> {
    if (!this.engine.isAlive()) {
      render.warn("browser crashed — recovering...");
      await this.engine.recover();
      this.reattach();
      render.success("browser recovered");
    }
  }

  private async processCurrentPage(): Promise<void> {
    await this.ensureBrowser();
    const page = this.engine.getPage();

    // Check for login page
    const loginCheck = await detectLoginPage(page);
    if (loginCheck.isLoginPage) {
      render.status("login required — detected login form");
      render.warn("LOGIN REQUIRED");
      render.status(`Site: ${this.state.site} (${this.nav.currentUrl()})`);
      render.status("Enter credentials below:");

      this.logAgent("Login page detected — prompting for credentials in CLI");

      // Pause readline and mute interceptor during auth
      this.muteInterceptor = true;
      this.closingForAuth = true;
      if (this.rl) {
        this.rl.close();
      }
      this.closingForAuth = false;

      const authResult = await performCLIAuth(page);

      // Unmute interceptor
      this.muteInterceptor = false;

      if (authResult.success) {
        render.success("login successful — session captured");
        this.logAgent(`Login successful — redirected to ${authResult.redirectedTo}`);

        // Process the post-login page
        await this.processCurrentPage();
        return;
      } else {
        render.error("login failed");
        this.logAgent("Login failed");
        this.startReadline();
        return;
      }
    }

    // Extract page content
    const content = await this.nav.extractContent();
    this.state.lastPageTitle = content.title;
    render.status(`page loaded: "${content.title}"`);
    this.logAgent(`Page loaded: "${content.title}" at ${content.url}`);

    // Check for intercepted API data relevant to the user's goal
    const apiData = this.findRelevantApiData();
    if (apiData) {
      render.status("structured data captured (skipping page render)");
      await this.extractAndDisplay(JSON.stringify(apiData));
      return;
    }

    // Agent-first: if DOM content is sparse, check intercepted network
    // responses for rich text content (article bodies, etc.)
    let pageText = this.buildPageText(content);
    const visibleTextLen = content.text.trim().length;

    if (visibleTextLen < 500) {
      const richContent = this.interceptor.findRichContent();
      if (richContent) {
        render.status("content extracted from network data (lazy-load bypass)");
        pageText = [
          `Title: ${content.title}`,
          `URL: ${content.url}`,
          `\nContent (from network):`,
          richContent.slice(0, 8000),
        ].join("\n");
      } else {
        // Fallback: scroll to trigger lazy loading
        await this.scrollToLoad();
        const reloaded = await this.nav.extractContent();
        if (reloaded.text.trim().length > visibleTextLen) {
          pageText = this.buildPageText(reloaded);
          render.status("content loaded after scroll");
        }
      }
    }
    render.status("analyzing page...");
    const interpretation = await withTimeout(
      this.llm.interpret(pageText, this.state.userGoal),
      LLM_TIMEOUT,
      "LLM interpret",
      this.signal
    );
    this.setInterpretation(interpretation);

    // Render based on interpretation
    if (interpretation.dataFound) {
      await this.extractAndDisplay(JSON.stringify(interpretation.dataFound));
    } else {
      // Show content summary in a box for content pages, inline for navigation
      if (interpretation.summary) {
        if (interpretation.pageType === "content") {
          render.contentBox(content.title, interpretation.summary);
        } else {
          render.status(interpretation.summary);
        }
        this.logAgent(interpretation.summary);
      }

      // Show navigation choices if any
      if (interpretation.choices.length > 0) {
        render.choices(interpretation.choices.map((c) => ({ index: c.index, label: c.label })));
        this.logAgent(`Presented ${interpretation.choices.length} choices: ${interpretation.choices.map((c) => c.label).join(", ")}`);
      } else {
        this.suggestCommands();
      }
    }
  }

  private async handleInput(input: string): Promise<void> {
    // Slash commands
    if (input.startsWith("/")) {
      const parts = input.slice(1).trim().split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const arg = parts.slice(1).join(" ");
      switch (cmd) {
        case "show":
          await this.ensureBrowser();
          render.status("opening browser window...");
          await this.engine.show();
          this.reattach();
          this.rl.prompt();
          return;

        case "hide":
          await this.ensureBrowser();
          render.status("hiding browser window...");
          await this.engine.hide();
          this.reattach();
          this.rl.prompt();
          return;

        case "goto": {
          if (!arg) {
            render.error("usage: /goto <url>");
            this.rl.prompt();
            return;
          }
          let url = arg;
          let isExternal = false;
          if (/^https?:\/\//.test(url)) {
            // Already a full URL
            isExternal = true;
          } else if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(url)) {
            // Bare domain like "nytimes.com" or "sub.example.com/path"
            url = `https://${url}`;
            isExternal = true;
          } else {
            // Relative path on current site
            url = `${this.engine.getBaseUrl()}${url.startsWith("/") ? "" : "/"}${url}`;
          }
          // Reset goal when navigating to an external site
          if (isExternal) {
            this.state.userGoal = `browsing ${new URL(url).hostname}`;
          }
          render.status(`navigating to ${url}...`);
          await this.ensureBrowser();
          this.pushPageState();
          this.interceptor.clear();
          await this.nav.goto(url);
          await this.engine.getPage().waitForTimeout(500);
          await this.processCurrentPage();
          this.rl.prompt();
          return;
        }

        case "back":
          await this.ensureBrowser();
          render.status("navigating back...");
          await this.nav.goBack();
          if (!this.popPageState()) {
            // No cached state — re-interpret from scratch
            await this.processCurrentPage();
          }
          this.rl.prompt();
          return;

        case "save":
          this.forceSave();
          this.rl.prompt();
          return;

        case "quit":
          await this.shutdown();
          return;

        case "help":
          render.help();
          this.rl.prompt();
          return;

        case "demo": {
          const demoUrl = process.env.BASE_URL || "http://localhost:3000";
          this.state.userGoal = "check my water bill";
          render.status(`starting CityServe demo at ${demoUrl}...`);
          await this.ensureBrowser();
          this.pushPageState();
          this.interceptor.clear();
          await this.nav.goto(demoUrl);
          await this.engine.getPage().waitForTimeout(500);
          await this.processCurrentPage();
          this.rl.prompt();
          return;
        }

        default:
          render.error(`unknown command: /${cmd}`);
          render.help();
          this.rl.prompt();
          return;
      }
    }

    this.state.log.push({ role: "user", content: input, timestamp: Date.now() });

    // Numbered choice selection
    const choiceNum = parseInt(input, 10);
    if (!isNaN(choiceNum) && this.state.currentInterpretation) {
      const choice = this.state.currentInterpretation.choices.find((c) => c.index === choiceNum);
      if (choice) {
        this.state.history.push({ role: "user", content: `Selected: ${choice.label}` });
        this.logAgent(`User selected [${choice.index}] ${choice.label}`);

        // Handle synthetic follow-up choices
        if (/show rendered page/i.test(choice.label)) {
          render.status("opening browser window...");
          await this.engine.show();
          this.reattach();
          this.rl.prompt();
          return;
        }
        if (/save and quit/i.test(choice.label)) {
          await this.shutdown();
          return;
        }

        if (choice.url) {
          // Skip anchor-only links (e.g. #site-content)
          if (choice.url.startsWith("#") || (choice.url.includes("#") && new URL(choice.url).pathname === new URL(this.nav.currentUrl()).pathname)) {
            render.status("anchor link — staying on current page");
          } else {
            this.pushPageState();
            render.status(`navigating to ${choice.label}...`);
            await this.nav.goto(choice.url);
          }
        } else if (choice.selector) {
          render.status(`navigating to ${choice.label}...`);
          this.pushPageState();
          try {
            // Check if it's an anchor link before clicking
            const href = await this.engine.getPage().getAttribute(choice.selector, "href").catch(() => null);
            if (href && (href.startsWith("#") || href === "")) {
              render.status("anchor link — staying on current page");
            } else {
              await this.engine.getPage().click(choice.selector);
              await this.engine.getPage().waitForLoadState("networkidle").catch(() => {});
            }
          } catch {
            render.status("click failed, trying navigation...");
            const href = await this.engine.getPage().getAttribute(choice.selector, "href").catch(() => null);
            if (href && !href.startsWith("#")) {
              const url = href.startsWith("http") ? href : `${this.engine.getBaseUrl()}${href}`;
              await this.nav.goto(url);
            }
          }
        }

        // Wait briefly for API responses
        await this.engine.getPage().waitForTimeout(500);
        await this.processCurrentPage();
        this.rl.prompt();
        return;
      }
    }

    // Check if number matches a previous (stale) choice set
    if (!isNaN(choiceNum) && this.state.previousInterpretation) {
      const staleChoice = this.state.previousInterpretation.choices.find((c) => c.index === choiceNum);
      if (staleChoice) {
        render.status(`[${staleChoice.index}] ${staleChoice.label} — from previous suggestions`);
        const confirmed = await this.confirmAction(`execute [${staleChoice.index}] ${staleChoice.label}?`);
        if (confirmed) {
          // Restore as current and re-handle
          this.state.currentInterpretation = this.state.previousInterpretation;
          this.state.previousInterpretation = null;
          await this.handleInput(input);
          return;
        }
        // User declined — fall through to free text
      }
    }

    // Free text — send to LLM as a follow-up question with context
    this.state.history.push({ role: "user", content: input });

    const content = await this.nav.extractContent();
    const pageText = this.buildPageText(content);
    render.status("thinking...");

    // Build conversation context from previous summary + user question
    let conversationContext: string | undefined;
    if (this.state.currentInterpretation) {
      conversationContext = `Previous summary: ${this.state.currentInterpretation.summary}\nUser asks: ${input}`;
    }

    const interpretation = await withTimeout(
      this.llm.interpret(pageText, this.state.userGoal, conversationContext),
      LLM_TIMEOUT,
      "LLM interpret",
      this.signal
    );
    this.setInterpretation(interpretation);

    if (interpretation.summary) {
      if (interpretation.pageType === "content") {
        render.contentBox(content.title, interpretation.summary);
      } else {
        render.status(interpretation.summary);
      }
    }

    if (interpretation.choices.length > 0) {
      render.choices(interpretation.choices.map((c) => ({ index: c.index, label: c.label })));
      this.logAgent(`Presented ${interpretation.choices.length} choices`);
    } else {
      this.suggestCommands();
    }

    this.rl.prompt();
  }

  /**
   * Suggest relevant slash commands based on current state.
   */
  private suggestCommands(): void {
    const hints: string[] = [];

    if (this.state.lastExtracted) {
      hints.push("/show to view page", "/save to save data");
    } else if (this.engine.isShowing()) {
      hints.push("/hide to go headless", "/back to go back");
    } else {
      hints.push("/show to open browser", "/back to go back");
    }

    render.hint(hints);
  }

  /**
   * Update the current interpretation, preserving the previous one
   * so stale numbered choices can still be offered to the user.
   */
  private setInterpretation(interpretation: PageInterpretation): void {
    if (this.state.currentInterpretation && this.state.currentInterpretation.choices.length > 0) {
      this.state.previousInterpretation = this.state.currentInterpretation;
    }
    this.state.currentInterpretation = interpretation;
  }

  /**
   * Ask the user a y/n confirmation question inline.
   */
  private confirmAction(question: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.rl.question(`  ${question} (y/n) `, (answer) => {
        resolve(answer.trim().toLowerCase().startsWith("y"));
      });
    });
  }

  /**
   * Push current page state onto the stack before navigating away.
   */
  private pushPageState(): void {
    if (this.state.currentInterpretation) {
      this.state.pageStack.push({
        url: this.nav.currentUrl(),
        pageTitle: this.state.lastPageTitle,
        interpretation: this.state.currentInterpretation,
        userGoal: this.state.userGoal,
      });
    }
  }

  /**
   * Pop and restore the previous page state (for /back).
   * Returns true if a snapshot was restored, false if stack is empty.
   */
  private popPageState(): boolean {
    const snapshot = this.state.pageStack.pop();
    if (!snapshot) return false;

    this.state.userGoal = snapshot.userGoal;
    this.state.lastPageTitle = snapshot.pageTitle;
    this.setInterpretation(snapshot.interpretation);

    render.status(`page loaded: "${snapshot.pageTitle}"`);
    if (snapshot.interpretation.summary) {
      if (snapshot.interpretation.pageType === "content") {
        render.contentBox(snapshot.pageTitle, snapshot.interpretation.summary);
      } else {
        render.status(snapshot.interpretation.summary);
      }
    }
    if (snapshot.interpretation.choices.length > 0) {
      render.choices(snapshot.interpretation.choices.map((c) => ({ index: c.index, label: c.label })));
    }

    return true;
  }

  private findRelevantApiData(): unknown | null {
    const responses = this.interceptor.getResponses();
    const skipPatterns = ["/api/login", "/api/session", "/api/services", "/api/logout"];
    for (let i = responses.length - 1; i >= 0; i--) {
      const resp = responses[i];
      // Only consider /api/ routes — non-api JSON is for content extraction
      if (!resp.url.includes("/api/")) continue;
      if (skipPatterns.some((p) => resp.url.includes(p))) continue;
      if (resp.status === 200 && resp.body && typeof resp.body === "object" && !Array.isArray(resp.body)) {
        return resp.body;
      }
    }
    return null;
  }

  private async extractAndDisplay(rawData: string): Promise<void> {
    render.status("extracting data...");
    const extracted = await withTimeout(
      this.llm.extractData(rawData, this.state.userGoal),
      LLM_TIMEOUT,
      "LLM extract",
      this.signal
    );
    this.state.lastExtracted = extracted;

    render.dataTable(extracted.title, extracted.fields);
    this.logAgent(`Extracted: ${extracted.summary}`);

    const filepath = saveData(this.currentSite(), this.inferResource(), extracted);
    render.status(`saved to ${filepath}`);
    this.logAgent(`Saved to ${filepath}`);

    render.choices([
      { index: 1, label: "Show rendered page" },
      { index: 2, label: "Save and quit" },
    ]);

    this.setInterpretation({
      pageType: "data",
      summary: extracted.summary,
      choices: [
        { index: 1, label: "Show rendered page", action: "click" },
        { index: 2, label: "Save and quit", action: "click" },
      ],
      dataFound: extracted.fields,
      requiresAuth: false,
      requiresHumanInput: false,
    });
  }

  private inferResource(): string {
    const url = this.nav.currentUrl();
    const parsed = new URL(url);
    // Flatten path to a safe filename: /us/politics/article → us-politics-article
    const path = parsed.pathname
      .replace(/\.html?$/, "")
      .replace(/^\//, "")
      .replace(/\/$/,  "")
      // Strip date segments (e.g. 2026/02/12) to avoid redundancy with datestamp
      .replace(/\d{4}\/\d{2}\/\d{2}\/?/, "")
      .replace(/^\//, "")
      .replace(/\//g,  "-");
    return path || "page";
  }

  /**
   * Derive site name from the current page URL.
   */
  private currentSite(): string {
    try {
      const url = this.nav.currentUrl();
      return new URL(url).hostname.replace(/^www\./, "").split(".")[0];
    } catch {
      return this.state.site;
    }
  }

  /**
   * Scroll the page incrementally to trigger lazy-loaded content.
   */
  private async scrollToLoad(): Promise<void> {
    const page = this.engine.getPage();
    try {
      await page.evaluate(async () => {
        const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const height = document.body.scrollHeight;
        const step = window.innerHeight;
        for (let y = 0; y < height; y += step) {
          window.scrollTo(0, y);
          await delay(300);
        }
        window.scrollTo(0, 0);
      });
      // Wait for any triggered network requests to settle
      await page.waitForTimeout(1000);
    } catch {
      // Scroll failed — continue with what we have
    }
  }

  private buildPageText(content: PageContent): string {
    return [
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
    ].join("\n");
  }

  private logAgent(msg: string): void {
    this.state.history.push({ role: "agent", content: msg });
    this.state.log.push({ role: "agent", content: msg, timestamp: Date.now() });
  }

  private reattach(): void {
    const page = this.engine.getPage();
    this.nav = new PageNavigator(page);
    this.interceptor = new NetworkInterceptor();
    this.interceptor.attach(page, this.engine.getBaseUrl());
    this.interceptor.onIntercept = (resp) => {
      if (!this.muteInterceptor) {
        render.intercepted(resp.method, resp.url, resp.status, resp.size);
      }
    };
  }

  private forceSave(): void {
    if (this.state.lastExtracted) {
      const filepath = saveData(this.currentSite(), this.inferResource(), this.state.lastExtracted);
      render.success(`data saved to ${filepath}`);
    }
    const logpath = saveSessionLog(this.currentSite(), this.state.log);
    render.success(`session log saved to ${logpath}`);
  }

  private async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.forceSave();
    render.status("session ended. browser closed.");
    await this.engine.close();
    this.rl.close();
    process.exit(0);
  }
}
