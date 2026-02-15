import * as readline from "readline";
import { BrowserEngine } from "../browser/engine";
import { PageNavigator, PageContent } from "../browser/navigator";
import { NetworkInterceptor } from "../browser/network";
import { detectLoginPage } from "../auth/detector";
import { performCLIAuth } from "../auth/handoff";
import { LLMProvider, PageInterpretation, ConversationContext, ExtractedData, GoalContext } from "../llm/provider";
import { isHNItemPage, extractHNComments, formatHNPageForLLM } from "../sites/hn";
import { formatGoal, addBreadcrumb } from "./goals";
import * as render from "./renderer";
import { saveData, saveSessionLog, loadConfig, saveConfig } from "../output/writer";

const LLM_TIMEOUT = 30_000; // 30s timeout for LLM calls

class CancelledError extends Error {
  constructor() { super("cancelled"); }
}

interface PageSnapshot {
  url: string;
  pageTitle: string;
  interpretation: PageInterpretation;
  goalContext: GoalContext;
}

interface SessionState {
  goalContext: GoalContext;
  currentInterpretation: PageInterpretation | null;
  previousInterpretation: PageInterpretation | null;
  lastExtracted: ExtractedData | null;
  lastPageTitle: string;
  history: Array<{ role: "user" | "agent"; content: string }>;
  log: Array<{ role: string; content: string; timestamp: number }>;
  site: string;
  pageStack: PageSnapshot[];
  forwardStack: PageSnapshot[];
  loginAvailable: boolean;
  homeUrl: string;
  currentUrl: string;  // REPL stack's current page URL — source of truth
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
    const config = loadConfig();
    this.state = {
      goalContext: { baseGoal: userGoal, activeIntent: "", breadcrumb: [] },
      currentInterpretation: null,
      previousInterpretation: null,
      lastExtracted: null,
      lastPageTitle: "",
      history: [{ role: "user", content: userGoal }],
      log: [{ role: "user", content: userGoal, timestamp: Date.now() }],
      site,
      pageStack: [],
      forwardStack: [],
      loginAvailable: false,
      homeUrl: config.homeUrl || "",
      currentUrl: "",
    };
  }

  async start(baseUrl?: string): Promise<void> {
    // If no explicit URL given, use persisted home URL
    const startUrl = baseUrl || this.state.homeUrl || "";

    render.status("launching headless browser...");
    await this.engine.launch(startUrl || "about:blank");

    const page = this.engine.getPage();
    this.nav = new PageNavigator(page);

    if (startUrl) {
      // Set up site/goal if starting from persisted home URL (no baseUrl arg)
      if (!baseUrl && this.state.homeUrl) {
        try {
          const hostname = new URL(startUrl).hostname;
          this.state.site = hostname.replace(/^www\./, "").split(".")[0];
          this.state.goalContext = { baseGoal: `browsing ${hostname}`, activeIntent: "", breadcrumb: [] };
          this.engine.setBaseUrl(new URL(startUrl).origin);
        } catch { /* invalid home URL — will fail on navigation */ }
      }

      this.interceptor.attach(page, startUrl);
      this.interceptor.onIntercept = (resp) => {
        if (!this.muteInterceptor) {
          render.intercepted(resp.method, resp.url, resp.status, resp.size);
        }
      };

      // Navigate to initial page
      render.status(`navigating to ${startUrl}...`);
      await this.nav.goto(startUrl);
      this.state.currentUrl = startUrl;

      // Process the first page
      await this.processCurrentPage();
    } else {
      render.hint(["type /goto <url> to navigate, /home to set a home page, /help for commands"]);
    }

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
        } else if (/closed|destroyed|disposed|target/i.test((err as Error).message)) {
          // Page/browser died mid-operation — force recover and retry once
          try {
            await this.syncBrowser();
            await this.handleInput(input);
          } catch (retryErr) {
            render.error((retryErr as Error).message);
            this.rl.prompt();
          }
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

  private formatGoal(): string {
    return formatGoal(this.state.goalContext);
  }

  private addBreadcrumb(label: string): void {
    addBreadcrumb(this.state.goalContext, label);
  }

  /**
   * Sync browser to match REPL's current position (currentUrl).
   * Called before any operation that needs the browser.
   * Handles: dead browser, dead page (WSL2), wrong URL (after /back /forward).
   */
  private async syncBrowser(): Promise<void> {
    // 1. Is browser alive?
    if (!this.engine.isAlive()) {
      await this.recoverBrowser();
      return;
    }

    // 2. Is page responsive? (WSL2: browser connected but page dead)
    let browserUrl: string;
    try {
      browserUrl = await this.engine.getPage().evaluate(() => window.location.href);
    } catch {
      await this.recoverBrowser();
      return;
    }

    // 3. Is browser on the right URL?
    if (this.state.currentUrl && browserUrl !== this.state.currentUrl) {
      this.interceptor.clear();
      await this.nav.goto(this.state.currentUrl);
    }
  }

  /**
   * Relaunch headless browser and navigate to REPL's current position.
   */
  private async recoverBrowser(): Promise<void> {
    render.warn("browser disconnected — recovering...");
    await this.engine.recover();
    this.reattach();
    if (this.state.currentUrl && this.state.currentUrl !== "about:blank") {
      try {
        await this.nav.goto(this.state.currentUrl);
      } catch { /* recovery navigation failed — continue on about:blank */ }
    }
    render.success("browser recovered");
  }

  private async runLoginFlow(): Promise<void> {
    await this.syncBrowser();
    const page = this.engine.getPage();

    // Check for a password form before tearing down readline
    const hasPasswordForm = await page.evaluate(() => {
      const forms = document.querySelectorAll("form");
      for (const form of forms) {
        if (form.querySelector('input[type="password"]')) return true;
      }
      return false;
    });
    if (!hasPasswordForm) {
      render.warn("no login form found on this page");
      this.rl.prompt();
      return;
    }

    render.status("starting login flow...");

    // Pause readline and mute interceptor during auth
    this.muteInterceptor = true;
    this.closingForAuth = true;
    if (this.rl) {
      this.rl.close();
    }
    this.closingForAuth = false;

    const authResult = await performCLIAuth(page);
    this.muteInterceptor = false;

    if (authResult.success) {
      render.success("login successful — session captured");
      this.logAgent(`Login successful — redirected to ${authResult.redirectedTo}`);
      this.state.loginAvailable = false;
      this.state.currentUrl = authResult.redirectedTo;
      this.startReadline();
      await this.processCurrentPage();
      this.rl.prompt();
    } else {
      render.error("login failed or cancelled");
      this.logAgent("Login failed");
      this.startReadline();
      this.rl.prompt();
    }
  }

  private async processCurrentPage(): Promise<void> {
    await this.syncBrowser();
    try {
      await this._processCurrentPage();
    } catch (err) {
      if (/closed|destroyed|disposed|target/i.test((err as Error).message)) {
        await this.recoverBrowser();
        await this._processCurrentPage();
      } else {
        throw err;
      }
    }
  }

  private async _processCurrentPage(): Promise<void> {
    const page = this.engine.getPage();

    // Check for login page — present as optional choice, not automatic
    this.state.loginAvailable = false;
    const loginCheck = await detectLoginPage(page);
    if (loginCheck.isLoginPage) {
      this.state.loginAvailable = true;
      render.warn(`login form detected (confidence: ${Math.round(loginCheck.confidence * 100)}%)`);
      this.logAgent("Login page detected — available as optional choice");
    }

    // HN item page — special handling for comment threads
    if (isHNItemPage(this.state.currentUrl)) {
      const hnItem = await extractHNComments(page);
      if (hnItem) {
        this.state.lastPageTitle = hnItem.title;
        render.status(`page loaded: "${hnItem.title}"`);
        this.logAgent(`HN discussion: "${hnItem.title}" (${hnItem.commentCount} comments)`);

        // Render comment thread in terminal
        render.commentThread(hnItem.title, hnItem.comments);

        // Send to LLM for summary
        const hnText = formatHNPageForLLM(hnItem);
        render.status("analyzing discussion...");
        const interpretation = await withTimeout(
          this.llm.interpret(hnText, this.formatGoal(), this.state.goalContext.activeIntent || undefined),
          LLM_TIMEOUT,
          "LLM interpret",
          this.signal
        );
        this.setInterpretation(interpretation);

        if (interpretation.summary) {
          render.contentBox(hnItem.title, interpretation.summary);
          this.logAgent(interpretation.summary);
        }

        // Build choices: "Read linked article" if external URL exists
        const choices = interpretation.choices;
        if (hnItem.articleUrl) {
          choices.unshift({
            index: 0,
            label: "Read linked article",
            action: "navigate",
            url: hnItem.articleUrl,
          });
          // Re-index
          for (let i = 0; i < choices.length; i++) {
            choices[i].index = i + 1;
          }
        }

        this.appendSystemChoices(interpretation);
        if (interpretation.choices.length > 0) {
          render.choices(interpretation.choices.map((c) => ({ index: c.index, label: c.label })));
        }
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
    const conversationCtx = this.state.goalContext.activeIntent || undefined;
    const interpretation = await withTimeout(
      this.llm.interpret(pageText, this.formatGoal(), conversationCtx),
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

      this.appendSystemChoices(interpretation);

      // Show navigation choices if any
      if (interpretation.choices.length > 0) {
        render.choices(interpretation.choices.map((c) => ({ index: c.index, label: c.label })));
        this.logAgent(`Presented ${interpretation.choices.length} choices: ${interpretation.choices.map((c) => c.label).join(", ")}`);
      } else {
        this.suggestCommands();
      }
    }
  }

  /**
   * Append system-managed choices (forms, login) to an interpretation.
   */
  private appendSystemChoices(interpretation: PageInterpretation): void {
    // Append login choice if login form was detected
    if (this.state.loginAvailable) {
      interpretation.choices.push({
        index: interpretation.choices.length + 1,
        label: "Log in to this site",
        action: "click",
      });
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
          await this.syncBrowser();
          if (this.engine.isShowing()) {
            render.status("bringing browser window to focus...");
          } else {
            render.status("opening browser window...");
          }
          {
            const created = await this.engine.show();
            if (created) {
              this.reattach();
              // Wait for the headed page to be ready
              try {
                await this.engine.getPage().waitForLoadState("domcontentloaded", { timeout: 5_000 });
              } catch { /* page may already be loaded */ }
            }
          }
          this.logCommand("/show");
          this.rl.prompt();
          return;

        case "hide":
          await this.syncBrowser();
          render.status("hiding browser window...");
          await this.engine.hide();
          this.reattach();
          this.logCommand("/hide");
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
          // Reset goal and base URL when navigating to an external site
          if (isExternal) {
            this.state.goalContext = { baseGoal: `browsing ${new URL(url).hostname}`, activeIntent: "", breadcrumb: [] };
            const origin = new URL(url).origin;
            this.engine.setBaseUrl(origin);
            this.state.site = new URL(url).hostname.replace(/^www\./, "").split(".")[0];
          }
          render.status(`navigating to ${url}...`);
          await this.syncBrowser();
          this.pushPageState();
          this.interceptor.clear();
          await this.nav.goto(url);
          this.state.currentUrl = url;
          await this.engine.getPage().waitForTimeout(500);
          await this.processCurrentPage();
          this.logCommand(`/goto ${arg}`);
          this.rl.prompt();
          return;
        }

        case "back": {
          const backTarget = this.state.pageStack[this.state.pageStack.length - 1];
          if (backTarget) {
            // Pure stack mutation — no browser interaction
            const current = this.captureSnapshot();
            this.state.pageStack.pop();
            if (current) this.state.forwardStack.push(current);
            this.restoreSnapshot(backTarget);
            render.hint(["/refresh to update content"]);
          } else {
            render.warn("no history to go back to");
          }
          this.logCommand("/back");
          this.rl.prompt();
          return;
        }

        case "forward": {
          const fwdTarget = this.state.forwardStack[this.state.forwardStack.length - 1];
          if (fwdTarget) {
            // Pure stack mutation — no browser interaction
            const current = this.captureSnapshot();
            this.state.forwardStack.pop();
            if (current) this.state.pageStack.push(current);
            this.restoreSnapshot(fwdTarget);
            render.hint(["/refresh to update content"]);
          } else {
            render.warn("no forward history");
          }
          this.logCommand("/forward");
          this.rl.prompt();
          return;
        }

        case "refresh":
          await this.syncBrowser();
          render.status("refreshing page...");
          this.interceptor.clear();
          await this.processCurrentPage();
          this.logCommand("/refresh");
          this.rl.prompt();
          return;

        case "save":
          this.forceSave();
          this.logCommand("/save");
          this.rl.prompt();
          return;

        case "login":
          await this.runLoginFlow();
          this.logCommand("/login");
          return;

        case "home": {
          if (arg === "clear") {
            this.state.homeUrl = "";
            saveConfig({ homeUrl: "" });
            render.success("home URL cleared");
            this.logCommand("/home clear");
            this.rl.prompt();
            return;
          }
          if (arg) {
            // /home set <url> or /home <url>
            let url = arg.replace(/^set\s+/, "");
            if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(url)) {
              url = `https://${url}`;
            }
            this.state.homeUrl = url;
            saveConfig({ homeUrl: url });
            render.success(`home URL set to ${url}`);
            this.logCommand(`/home ${arg}`);
            this.rl.prompt();
            return;
          }
          if (this.state.homeUrl) {
            // Navigate to home
            render.status(`navigating to ${this.state.homeUrl}...`);
            await this.syncBrowser();
            this.pushPageState();
            this.interceptor.clear();
            this.state.goalContext = { baseGoal: `browsing ${new URL(this.state.homeUrl).hostname}`, activeIntent: "", breadcrumb: [] };
            await this.nav.goto(this.state.homeUrl);
            this.state.currentUrl = this.state.homeUrl;
            await this.engine.getPage().waitForTimeout(500);
            await this.processCurrentPage();
            this.logCommand("/home");
            this.rl.prompt();
            return;
          }
          // No home URL set — prompt user
          const answer = await new Promise<string>((resolve) => {
            this.rl.question("  enter home URL (or 'cancel'): ", resolve);
          });
          const trimmed = answer.trim();
          if (!trimmed || trimmed.toLowerCase() === "cancel") {
            this.rl.prompt();
            return;
          }
          let homeUrl = trimmed;
          if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(homeUrl)) {
            homeUrl = `https://${homeUrl}`;
          }
          this.state.homeUrl = homeUrl;
          saveConfig({ homeUrl });          render.success(`home URL set to ${homeUrl}`);
          render.status(`navigating to ${homeUrl}...`);
          await this.syncBrowser();
          this.pushPageState();
          this.interceptor.clear();
          this.state.goalContext = { baseGoal: `browsing ${new URL(homeUrl).hostname}`, activeIntent: "", breadcrumb: [] };
          await this.nav.goto(homeUrl);
          this.state.currentUrl = homeUrl;
          await this.engine.getPage().waitForTimeout(500);
          await this.processCurrentPage();
          this.logCommand("/home");
          this.rl.prompt();
          return;
        }

        case "quit":
          await this.shutdown();
          return;

        case "url": {
          let browserUrl = "(unknown)";
          try { browserUrl = this.engine.getPage().url(); } catch { /* dead page */ }
          const synced = browserUrl === this.state.currentUrl;
          console.log(`  current:  ${this.state.currentUrl || "(none)"}`);
          console.log(`  browser:  ${browserUrl}${synced ? "" : " (not synced)"}`);
          console.log(`  back:     [${this.state.pageStack.map(s => s.url).join(", ")}]`);
          console.log(`  forward:  [${this.state.forwardStack.map(s => s.url).join(", ")}]`);
          this.rl.prompt();
          return;
        }

        case "help":
          render.help();
          this.logCommand("/help");
          this.rl.prompt();
          return;

        case "demo": {
          const demoUrl = process.env.BASE_URL || "http://localhost:3000";
          this.state.goalContext = { baseGoal: "check my water bill", activeIntent: "", breadcrumb: [] };
          render.status(`starting CityServe demo at ${demoUrl}...`);
          await this.syncBrowser();
          this.pushPageState();
          this.interceptor.clear();
          await this.nav.goto(demoUrl);
          this.state.currentUrl = demoUrl;
          await this.engine.getPage().waitForTimeout(500);
          await this.processCurrentPage();
          this.logCommand("/demo");
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

    // Command-like input detection — prompt if user typed a bare command name
    const knownCommands = ["show", "hide", "goto", "back", "forward", "save", "quit", "help", "demo", "refresh", "login", "home", "url"];
    const lowerInput = input.toLowerCase();
    if (knownCommands.includes(lowerInput) || knownCommands.some(c => lowerInput.startsWith(c + " "))) {
      const confirmed = await this.confirmAction(`did you mean /${lowerInput}?`);
      if (confirmed) {
        await this.handleInput(`/${input}`);
        return;
      }
      // User said no — fall through to free text
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
          const created = await this.engine.show();
          if (created) {
            this.reattach();
          }
          this.rl.prompt();
          return;
        }
        if (/save and quit/i.test(choice.label)) {
          await this.shutdown();
          return;
        }
        if (/log in to this site/i.test(choice.label)) {
          await this.runLoginFlow();
          return;
        }

        // Handle fill choices (search, filter — LLM-generated fill plans)
        if (choice.action === "fill" && choice.fillPlan) {
          const plan = choice.fillPlan;
          const query = await new Promise<string>((resolve) => {
            this.rl.question("  search query: ", resolve);
          });
          const trimmedQuery = query.trim();
          if (!trimmedQuery) { this.rl.prompt(); return; }

          render.status(`searching for "${trimmedQuery}"...`);
          await this.syncBrowser();
          const page = this.engine.getPage();
          try {
            await page.fill(plan.inputSelector, trimmedQuery);
            if (plan.submitAction === "click" && plan.submitSelector) {
              await page.click(plan.submitSelector);
            } else {
              await page.press(plan.inputSelector, "Enter");
            }
            await page.waitForLoadState("networkidle").catch(() => {});
            await page.waitForTimeout(500);
          } catch {
            // Fallback: try form.submit() on the closest form
            render.warn("form submission failed — trying form.submit()");
            try {
              await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                const form = el?.closest("form") as HTMLFormElement | null;
                form?.submit();
              }, plan.inputSelector);
              await page.waitForLoadState("networkidle").catch(() => {});
            } catch { /* give up */ }
          }
          this.pushPageState();
          try { this.state.currentUrl = this.nav.currentUrl(); } catch {}
          this.state.goalContext.activeIntent = trimmedQuery;
          this.addBreadcrumb(`search: ${trimmedQuery}`);
          await this.processCurrentPage();
          this.rl.prompt();
          return;
        }

        // Add breadcrumb for navigation choices
        this.addBreadcrumb(choice.label);

        if (choice.url) {
          // Skip anchor-only links (e.g. #site-content)
          if (choice.url.startsWith("#") || (choice.url.includes("#") && new URL(choice.url).pathname === new URL(this.state.currentUrl).pathname)) {
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
        // Update currentUrl to wherever the browser ended up
        try { this.state.currentUrl = this.nav.currentUrl(); } catch { /* dead page */ }
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

    // Set user's free text as the active intent
    this.state.goalContext.activeIntent = input;

    await this.syncBrowser();
    const content = await this.nav.extractContent();
    const pageText = this.buildPageText(content);
    render.status("thinking...");

    // Build conversation context from previous summary + user question
    let conversationContext: string | undefined;
    if (this.state.currentInterpretation) {
      conversationContext = `Previous summary: ${this.state.currentInterpretation.summary}\nUser asks: ${input}`;
    }

    const interpretation = await withTimeout(
      this.llm.interpret(pageText, this.formatGoal(), conversationContext),
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
    const snapshot = this.captureSnapshot();
    if (snapshot) {
      this.state.pageStack.push(snapshot);
    }
    // New navigation invalidates forward history (same as real browsers)
    this.state.forwardStack = [];
  }

  /**
   * Capture current REPL state as a snapshot (pure data, no browser access).
   */
  private captureSnapshot(): PageSnapshot | null {
    if (!this.state.currentInterpretation) return null;
    return {
      url: this.state.currentUrl,
      pageTitle: this.state.lastPageTitle,
      interpretation: this.state.currentInterpretation,
      goalContext: { ...this.state.goalContext, breadcrumb: [...this.state.goalContext.breadcrumb] },
    };
  }

  /**
   * Restore a snapshot into current REPL state and render cached content.
   * Pure data + display — no browser access.
   */
  private restoreSnapshot(snapshot: PageSnapshot): void {
    this.state.currentUrl = snapshot.url;
    this.state.goalContext = { ...snapshot.goalContext, breadcrumb: [...snapshot.goalContext.breadcrumb] };
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
      this.llm.extractData(rawData, this.formatGoal()),
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
    const url = this.state.currentUrl || "about:blank";
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
      const url = this.state.currentUrl;
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

  private logCommand(cmd: string): void {
    this.state.log.push({ role: "user", content: cmd, timestamp: Date.now() });
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
    const logpath = saveSessionLog(this.state.site, this.state.log);
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
