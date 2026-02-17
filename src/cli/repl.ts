import * as readline from "readline";
import { BrowserEngine } from "../browser/engine";
import { PageNavigator, PageContent } from "../browser/navigator";
import { NetworkInterceptor } from "../browser/network";
import { detectLoginPage } from "../auth/detector";
import { DetectedForm, detectInteractiveForms } from "../forms/detector";
import { performCLIAuth } from "../auth/handoff";
import { LLMProvider, PageInterpretation, ConversationContext, ExtractedData, GoalContext } from "../llm/provider";
import { isHNItemPage, extractHNComments, formatHNPageForLLM } from "../sites/hn";
import { formatGoal, addBreadcrumb, formatGoalWithCrawl } from "./goals";
import * as render from "./renderer";
import { saveData, saveSessionLog, loadConfig, saveConfig } from "../output/writer";
import { CrawlManager, CrawlNode, ReachedBy, FullCursorEntry } from "../crawl/tree";
import { saveCrawl, loadCrawl, listCrawls, peekCrawl } from "../crawl/persistence";
import { deriveCrawlName } from "../crawl/namer";
import { formatAncestorContext } from "../crawl/context";
import { saveSession, restoreManagerFromEnvelope, SessionEnvelope } from "../session/persistence";

const LLM_TIMEOUT = 30_000; // 30s timeout for LLM calls

// ANSI color helpers (duplicated from renderer for inline use)
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";

class CancelledError extends Error {
  constructor() { super("cancelled"); }
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
  loginAvailable: boolean;
  detectedForms: DetectedForm[];
  homeUrl: string;
  currentUrl: string;  // REPL's current page URL — source of truth
  pendingReachedBy: ReachedBy;
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
  private crawlManager = new CrawlManager();
  private autoSaveTimer: ReturnType<typeof setInterval> | null = null;

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
      loginAvailable: false,
      detectedForms: [],
      homeUrl: config.homeUrl || "",
      currentUrl: "",
      pendingReachedBy: "auto",
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
      this.state.pendingReachedBy = "auto";

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

    // Periodic auto-save (every 60s, session JSON only — lightweight)
    if (this.autoSaveTimer) clearInterval(this.autoSaveTimer);
    this.autoSaveTimer = setInterval(() => {
      if (this.crawlManager.activeCrawl) {
        try { this.saveSessionSidecar(); } catch { /* silent */ }
      }
    }, 60_000);

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
    return formatGoalWithCrawl(this.state.goalContext, this.crawlManager);
  }

  private addBreadcrumb(label: string): void {
    addBreadcrumb(this.state.goalContext, label);
  }

  private trackNavigation(url: string, title: string, reachedBy: ReachedBy): void {
    if (!url || url === "about:blank") return;
    const node = this.crawlManager.addNavigation(url, title, reachedBy);
    this.crawlManager.appendCursor(node.id, reachedBy);
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
      this.state.pendingReachedBy = "auto";
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

    // Detect interactive forms (search, filter) — present as system choices
    this.state.detectedForms = await detectInteractiveForms(page);

    // HN item page — special handling for comment threads
    if (isHNItemPage(this.state.currentUrl)) {
      const hnItem = await extractHNComments(page);
      if (hnItem) {
        this.state.lastPageTitle = hnItem.title;
        this.trackNavigation(this.state.currentUrl, this.state.lastPageTitle, this.state.pendingReachedBy);
        this.state.pendingReachedBy = "auto";
        render.progress(`loading "${hnItem.title}"...`);
        this.logAgent(`HN discussion: "${hnItem.title}" (${hnItem.commentCount} comments)`);

        // Render comment thread in terminal
        render.commentThread(hnItem.title, hnItem.comments);

        // Send to LLM for summary
        const hnText = formatHNPageForLLM(hnItem);
        render.progress("analyzing discussion...");
        const hnAncestorCtx = formatAncestorContext(this.crawlManager);
        const hnConversationCtx = this.state.goalContext.activeIntent || undefined;
        const hnFullCtx = [hnAncestorCtx, hnConversationCtx].filter(Boolean).join("\n\n") || undefined;
        const interpretation = await withTimeout(
          this.llm.interpret(hnText, this.formatGoal(), hnFullCtx),
          LLM_TIMEOUT,
          "LLM interpret",
          this.signal
        );
        render.progressDone();
        this.setInterpretation(interpretation);
        this.storeStateOnNode(interpretation);
        this.maybeNameCrawl(interpretation.summary);

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
    this.trackNavigation(this.state.currentUrl, this.state.lastPageTitle, this.state.pendingReachedBy);
    this.state.pendingReachedBy = "auto";
    render.progress(`loading "${content.title}"...`);
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
        render.progress("extracting content...");
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
          render.progress("loading content...");
        }
      }
    }
    render.progress("analyzing page...");
    const ancestorCtx = formatAncestorContext(this.crawlManager);
    const conversationCtx = this.state.goalContext.activeIntent || undefined;
    const fullCtx = [ancestorCtx, conversationCtx].filter(Boolean).join("\n\n") || undefined;
    const interpretation = await withTimeout(
      this.llm.interpret(pageText, this.formatGoal(), fullCtx),
      LLM_TIMEOUT,
      "LLM interpret",
      this.signal
    );
    render.progressDone();
    this.setInterpretation(interpretation);
    this.storeStateOnNode(interpretation);
    this.maybeNameCrawl(interpretation.summary);

    // Render based on interpretation
    if (interpretation.dataFound) {
      await this.extractAndDisplay(JSON.stringify(interpretation.dataFound));
    } else {
      // Show content summary in a box for content pages, navSummary for navigation
      if (interpretation.summary) {
        if (interpretation.pageType === "content") {
          render.contentBox(content.title, interpretation.summary);
        } else {
          render.navSummary(content.title, interpretation.summary, this.state.currentUrl);
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
    // Append detected form choices (search, filter)
    for (const form of this.state.detectedForms) {
      // Skip if LLM already generated a fill choice with the same selector
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
            this.stashCrawl();  // stash current crawl for /back recovery across domains
            this.state.goalContext = { baseGoal: `browsing ${new URL(url).hostname}`, activeIntent: "", breadcrumb: [] };
            const origin = new URL(url).origin;
            this.engine.setBaseUrl(origin);
            this.state.site = new URL(url).hostname.replace(/^www\./, "").split(".")[0];
          }
          render.status(`navigating to ${url}...`);
          await this.syncBrowser();
          this.crawlManager.truncateCursorForward();
          this.interceptor.clear();
          this.state.pendingReachedBy = "goto";
          try {
            await this.nav.goto(url);
          } catch (err) {
            render.error((err as Error).message);
            this.rl.prompt();
            return;
          }
          this.state.currentUrl = url;
          await this.engine.getPage().waitForTimeout(500);
          await this.processCurrentPage();
          this.logCommand(`/goto ${arg}`);
          this.rl.prompt();
          return;
        }

        case "back": {
          const entry = this.crawlManager.cursorBack();
          if (entry) {
            const node = this.crawlManager.getNode(entry.nodeId);
            if (node) {
              this.crawlManager.navigateToNode(node.id);
              this.restoreFromNode(node);
              render.hint(["/refresh to update content"]);
            } else {
              render.warn("node not found in crawl tree");
            }
          } else if (this.crawlManager.hasStash()) {
            // At start of current crawl — pop stash to return to previous domain
            // Save current small crawl to disk first
            if (this.crawlManager.activeCrawl) {
              try {
                saveCrawl(this.crawlManager, this.state.log);
                this.saveSessionSidecar();
              } catch { /* save failed — continue */ }
            }
            const restored = this.crawlManager.popStash();
            if (restored) {
              const node = this.crawlManager.currentNodeId
                ? this.crawlManager.getNode(this.crawlManager.currentNodeId)
                : null;
              if (node) {
                // Restore REPL state from the stashed crawl's current node
                try {
                  const hostname = new URL(node.url).hostname;
                  this.state.site = hostname.replace(/^www\./, "").split(".")[0];
                  this.engine.setBaseUrl(new URL(node.url).origin);
                } catch { /* invalid URL */ }
                this.restoreFromNode(node);
                render.status(`returned to stashed crawl: "${restored.name}"`);
                render.hint(["/refresh to update content"]);
              }
            }
          } else {
            render.warn("no history to go back to");
          }
          this.logCommand("/back");
          this.rl.prompt();
          return;
        }

        case "forward": {
          const entry = this.crawlManager.cursorForward();
          if (entry) {
            const node = this.crawlManager.getNode(entry.nodeId);
            if (node) {
              this.crawlManager.navigateToNode(node.id);
              this.restoreFromNode(node);
              render.hint(["/refresh to update content"]);
            } else {
              render.warn("node not found in crawl tree");
            }
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
            this.crawlManager.truncateCursorForward();
            this.interceptor.clear();
            this.state.pendingReachedBy = "goto";
            this.state.goalContext = { baseGoal: `browsing ${new URL(this.state.homeUrl).hostname}`, activeIntent: "", breadcrumb: [] };
            try {
              await this.nav.goto(this.state.homeUrl);
            } catch (err) {
              render.error((err as Error).message);
              this.rl.prompt();
              return;
            }
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
          this.crawlManager.truncateCursorForward();
          this.interceptor.clear();
          this.state.pendingReachedBy = "goto";
          this.state.goalContext = { baseGoal: `browsing ${new URL(homeUrl).hostname}`, activeIntent: "", breadcrumb: [] };
          try {
            await this.nav.goto(homeUrl);
          } catch (err) {
            render.error((err as Error).message);
            this.rl.prompt();
            return;
          }
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
          console.log(this.state.currentUrl || "(no URL)");
          this.rl.prompt();
          return;
        }

        case "stack": {
          let browserUrl = "(unknown)";
          try { browserUrl = this.engine.getPage().url(); } catch { /* dead page */ }
          const synced = browserUrl === this.state.currentUrl;

          // Build back/forward stacks from cursor history
          const cursor = this.crawlManager.getCursorHistory();
          const cidx = this.crawlManager.cursorIndex;
          const backEntries: render.StackEntry[] = [];
          const fwdEntries: render.StackEntry[] = [];
          for (let i = 0; i < cidx; i++) {
            const node = this.crawlManager.getNode(cursor[i].nodeId);
            if (node) backEntries.push({ url: node.url, title: node.title });
          }
          for (let i = cidx + 1; i < cursor.length; i++) {
            const node = this.crawlManager.getNode(cursor[i].nodeId);
            if (node) fwdEntries.push({ url: node.url, title: node.title });
          }

          render.stackView(
            { url: this.state.currentUrl, title: this.state.lastPageTitle },
            browserUrl,
            synced,
            backEntries,
            fwdEntries,
          );
          // Show stash indicator if there are stashed crawls
          if (this.crawlManager.hasStash()) {
            const stashNames = this.crawlManager.stash.map(s => s.activeCrawl.name);
            render.stashIndicator(this.crawlManager.getStashDepth(), stashNames);
          }
          this.logCommand("/stack");
          this.rl.prompt();
          return;
        }

        case "history": {
          if (arg) {
            // /history N — jump to entry
            const n = parseInt(arg, 10);
            if (isNaN(n)) {
              render.error("usage: /history [N]");
              this.rl.prompt();
              return;
            }
            await this.jumpToHistory(n);
            this.logCommand(`/history ${n}`);
            this.rl.prompt();
            return;
          }
          // /history — show list (combined across stash + active crawl)
          const fullCursor = this.crawlManager.getFullCursorHistory();
          if (fullCursor.length === 0) {
            render.status("no visit history yet — navigate to start recording");
            this.rl.prompt();
            return;
          }
          // Compute the current entry index in the full history
          // Active crawl's cursorIndex maps to the last segment of fullCursor
          const stashEntryCount = fullCursor.length - this.crawlManager.cursorHistory.length;
          const activeCursorIdx = this.crawlManager.cursorIndex;
          const fullCurrentIdx = activeCursorIdx >= 0 ? stashEntryCount + activeCursorIdx : -1;

          const histEntries: render.HistoryEntry[] = fullCursor.map((entry, i) => {
            const node = this.crawlManager.getNodeAcrossStash(entry.nodeId);
            return {
              index: i + 1,
              title: node?.title || "(untitled)",
              url: node?.url || "",
              reachedBy: entry.reachedBy,
              timestamp: entry.timestamp,
              summary: node?.metadata?.summary,
              isCurrent: i === fullCurrentIdx,
              crawlName: (entry as FullCursorEntry).crawlName,
            };
          });
          render.historyList(histEntries);
          render.hint(["type /history N to jump to an entry"]);
          this.logCommand("/history");
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
          this.crawlManager.truncateCursorForward();
          this.interceptor.clear();
          this.state.pendingReachedBy = "goto";
          try {
            await this.nav.goto(demoUrl);
          } catch (err) {
            render.error((err as Error).message);
            this.rl.prompt();
            return;
          }
          this.state.currentUrl = demoUrl;
          await this.engine.getPage().waitForTimeout(500);
          await this.processCurrentPage();
          this.logCommand("/demo");
          this.rl.prompt();
          return;
        }

        case "tree": {
          const tree = this.crawlManager.getEnrichedDisplayTree();
          if (!tree) {
            render.status("no crawl tree yet — navigate to start recording");
          } else {
            console.log();
            console.log(tree);
            console.log();
          }
          this.logCommand("/tree");
          this.rl.prompt();
          return;
        }

        case "crawl": {
          const sub = parts[1]?.toLowerCase() || "";
          const subArg = parts.slice(2).join(" ");
          switch (sub) {
            case "list": {
              const ids = listCrawls();
              if (ids.length === 0) {
                render.status("no saved crawls");
                this.rl.prompt();
                return;
              }
              const crawls: Array<{ index: number; name: string; rootUrl: string; nodeCount: number; created: number }> = [];
              for (const id of ids) {
                const peek = peekCrawl(id);
                if (peek) crawls.push({ index: 0, ...peek });
              }
              // Sort by created date descending (newest first)
              crawls.sort((a, b) => b.created - a.created);
              crawls.forEach((c, i) => { c.index = i + 1; });
              render.crawlList(crawls);
              this.logCommand("/crawl list");
              this.rl.prompt();
              return;
            }

            case "load": {
              const ids = listCrawls();
              if (ids.length === 0) {
                render.status("no saved crawls to load");
                this.rl.prompt();
                return;
              }
              // Build peek list
              const crawls: Array<{ index: number; id: string; name: string; rootUrl: string; nodeCount: number; created: number }> = [];
              for (const id of ids) {
                const peek = peekCrawl(id);
                if (peek) crawls.push({ index: 0, ...peek });
              }
              crawls.sort((a, b) => b.created - a.created);
              crawls.forEach((c, i) => { c.index = i + 1; });

              let pickNum = parseInt(subArg, 10);
              if (isNaN(pickNum)) {
                // Show list and prompt
                render.crawlList(crawls);
                const answer = await new Promise<string>((resolve) => {
                  this.rl.question("  pick a crawl number: ", resolve);
                });
                pickNum = parseInt(answer.trim(), 10);
                if (isNaN(pickNum)) {
                  render.status("cancelled");
                  this.rl.prompt();
                  return;
                }
              }

              const picked = crawls.find((c) => c.index === pickNum);
              if (!picked) {
                render.error(`no crawl at index ${pickNum}`);
                this.rl.prompt();
                return;
              }

              // Stash current crawl if active (preserve history when loading old crawls)
              if (this.crawlManager.activeCrawl) {
                render.status("stashing active crawl...");
                this.stashCrawl();
              }

              const loaded = loadCrawl(picked.id, this.crawlManager);
              if (!loaded) {
                render.error("failed to load crawl");
                this.rl.prompt();
                return;
              }

              // Set REPL position to the loaded crawl's current node
              const currentNode = this.crawlManager.currentNodeId
                ? this.crawlManager.getNode(this.crawlManager.currentNodeId)
                : null;
              if (currentNode) {
                this.state.currentUrl = currentNode.url;
                this.state.lastPageTitle = currentNode.title;
                // Restore interpretation from node metadata if available
                if (currentNode.metadata?.interpretation) {
                  this.setInterpretation(currentNode.metadata.interpretation);
                }
                if (currentNode.metadata?.goalContext) {
                  this.state.goalContext = {
                    ...currentNode.metadata.goalContext,
                    breadcrumb: [...(currentNode.metadata.goalContext.breadcrumb || [])],
                  };
                }
              }

              render.success(`loaded crawl: "${this.crawlManager.activeCrawl?.name || picked.name}"`);
              this.logCommand(`/crawl load ${pickNum}`);
              this.rl.prompt();
              return;
            }

            case "rename": {
              if (!this.crawlManager.activeCrawl) {
                render.warn("no active crawl");
                this.rl.prompt();
                return;
              }
              if (!subArg) {
                render.error("usage: /crawl rename <name>");
                this.rl.prompt();
                return;
              }
              this.crawlManager.activeCrawl.name = subArg;
              render.success(`crawl renamed to: "${subArg}"`);
              this.logCommand(`/crawl rename ${subArg}`);
              this.rl.prompt();
              return;
            }

            case "end": {
              if (!this.crawlManager.activeCrawl) {
                render.warn("no active crawl to end");
                this.rl.prompt();
                return;
              }
              try {
                const filepath = saveCrawl(this.crawlManager, this.state.log);
                this.saveSessionSidecar();
                this.crawlManager.clearActive();  // preserve stash — user can still /back
                render.success(`crawl saved to: ${filepath}`);
              } catch (err) {
                render.error(`failed to save crawl: ${(err as Error).message}`);
              }
              this.logCommand("/crawl end");
              this.rl.prompt();
              return;
            }

            case "info": {
              if (!this.crawlManager.activeCrawl) {
                render.warn("no active crawl");
                this.rl.prompt();
                return;
              }
              const crawl = this.crawlManager.activeCrawl;
              const rootNode = this.crawlManager.nodes.get(crawl.rootId);
              const currentNode = this.crawlManager.currentNodeId
                ? this.crawlManager.getNode(this.crawlManager.currentNodeId)
                : null;
              render.crawlInfo(
                crawl.name,
                crawl.created,
                this.crawlManager.nodes.size,
                rootNode?.url || "(unknown)",
                currentNode?.title || "(unknown)",
              );
              this.logCommand("/crawl info");
              this.rl.prompt();
              return;
            }

            default: {
              // Show /crawl subcommand help
              console.log();
              console.log(`  ${BOLD}Crawl subcommands:${RESET}`);
              console.log(`  ${CYAN}/crawl list${RESET}           List saved crawls`);
              console.log(`  ${CYAN}/crawl load [N]${RESET}       Load a saved crawl by number`);
              console.log(`  ${CYAN}/crawl rename <name>${RESET}  Rename the active crawl`);
              console.log(`  ${CYAN}/crawl end${RESET}            Save and end the active crawl`);
              console.log(`  ${CYAN}/crawl info${RESET}           Show active crawl metadata`);
              console.log();
              this.rl.prompt();
              return;
            }
          }
        }

        case "clear": {
          const scope = arg.toLowerCase() || "all";
          const validScopes = ["repl", "crawl", "browser", "all"];
          if (!validScopes.includes(scope)) {
            render.error(`unknown scope: ${scope} (use repl, crawl, browser, or all)`);
            this.rl.prompt();
            return;
          }

          // Build summary of what will be cleared
          const items: string[] = [];
          if (scope === "repl" || scope === "all") {
            items.push("REPL stacks, interpretations, history, log, goal");
          }
          if (scope === "crawl" || scope === "all") {
            const stashNote = this.crawlManager.hasStash() ? ` + ${this.crawlManager.getStashDepth()} stashed` : "";
            items.push("crawl tree" + stashNote + (this.crawlManager.activeCrawl ? " (will auto-save first)" : ""));
          }
          if (scope === "browser" || scope === "all") {
            items.push("browser cookies, localStorage, sessionStorage");
          }

          render.clearSummary(items);
          const confirmed = await this.confirmAction("proceed?");
          if (!confirmed) {
            render.status("cancelled");
            this.rl.prompt();
            return;
          }

          if (scope === "repl" || scope === "all") {
            this.clearRepl();
          }
          if (scope === "crawl" || scope === "all") {
            this.clearCrawl();
          }
          if (scope === "browser" || scope === "all") {
            await this.clearBrowser();
          }

          render.success(`cleared: ${scope}`);
          this.logCommand(`/clear ${scope}`);
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
    const knownCommands = ["show", "hide", "goto", "back", "forward", "save", "quit", "help", "demo", "refresh", "login", "home", "url", "stack", "history", "tree", "clear", "crawl"];
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
          this.crawlManager.truncateCursorForward();
          try { this.state.currentUrl = this.nav.currentUrl(); } catch {}
          this.state.goalContext.activeIntent = trimmedQuery;
          if (!this.crawlManager.activeCrawl) {
            this.addBreadcrumb(`search: ${trimmedQuery}`);
          }
          this.state.pendingReachedBy = "choice";
          await this.processCurrentPage();
          this.rl.prompt();
          return;
        }

        // Add breadcrumb for navigation choices (only when no crawl — tree handles breadcrumbs)
        if (!this.crawlManager.activeCrawl) {
          this.addBreadcrumb(choice.label);
        }

        if (choice.url) {
          // Skip anchor-only links (e.g. #site-content)
          if (choice.url.startsWith("#") || (choice.url.includes("#") && new URL(choice.url).pathname === new URL(this.state.currentUrl).pathname)) {
            render.status("anchor link — staying on current page");
          } else {
            this.crawlManager.truncateCursorForward();
            render.status(`navigating to ${choice.label}...`);
            await this.nav.goto(choice.url);
          }
        } else if (choice.selector) {
          render.status(`navigating to ${choice.label}...`);
          this.crawlManager.truncateCursorForward();
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
        this.state.pendingReachedBy = "choice";
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
    render.progress("thinking...");

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
    render.progressDone();
    this.setInterpretation(interpretation);

    // Append conversation snippet to crawl node (don't overwrite summary for follow-ups)
    if (this.crawlManager.currentNodeId && interpretation.summary) {
      const snippet = `Q: ${input} → ${interpretation.summary.split(/\.\s/)[0] || ""}`;
      this.crawlManager.appendConversationSnippet(this.crawlManager.currentNodeId, snippet);
    }

    if (interpretation.summary) {
      if (interpretation.pageType === "content") {
        render.contentBox(content.title, interpretation.summary);
      } else {
        render.navSummary(content.title, interpretation.summary, this.state.currentUrl);
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
      hints.push("/save to save data");
    }
    if (this.crawlManager.cursorIndex > 0 || this.crawlManager.hasStash()) {
      hints.push("/back to go back");
    }
    if (this.state.loginAvailable) {
      hints.push("/login to sign in");
    }
    if (this.state.detectedForms.length > 0) {
      hints.push("type to search/filter");
    }

    // Ensure at least one general hint
    if (hints.length === 0) {
      if (this.engine.isShowing()) {
        hints.push("/hide to go headless");
      } else {
        hints.push("/show to open browser");
      }
      hints.push("/goto <url> to navigate");
    }

    // Cap at 3 hints
    render.hint(hints.slice(0, 3));
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
   * Store the full LLM interpretation and current goal context on the current crawl node.
   * Replaces the older storeSummaryOnNode — stores summary + full state for session persistence.
   */
  private storeStateOnNode(interpretation: PageInterpretation): void {
    if (!this.crawlManager.currentNodeId) return;
    const meta: { summary?: string; interpretation?: PageInterpretation; goalContext?: GoalContext } = {};
    if (interpretation.summary) meta.summary = interpretation.summary;
    meta.interpretation = interpretation;
    meta.goalContext = { ...this.state.goalContext, breadcrumb: [...this.state.goalContext.breadcrumb] };
    this.crawlManager.setNodeMetadata(this.crawlManager.currentNodeId, meta);
  }

  /**
   * Name the crawl after first interpret() if it still has a default timestamp name.
   */
  private maybeNameCrawl(summary: string): void {
    if (!this.crawlManager.activeCrawl) return;
    // Default name is ISO timestamp: "2026-02-16 14:30:00"
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(this.crawlManager.activeCrawl.name)) return;
    const rootNode = this.crawlManager.nodes.get(this.crawlManager.activeCrawl.rootId);
    const rootUrl = rootNode?.url || "";
    this.crawlManager.activeCrawl.name = deriveCrawlName(rootUrl, summary, this.state.goalContext.baseGoal);
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
   * Jump to a cursor history entry by 1-indexed number.
   * Works across stash boundaries — if the target is in a stashed crawl,
   * pushes current active onto stash, pops the target crawl, and jumps within it.
   */
  private async jumpToHistory(n: number): Promise<void> {
    const fullCursor = this.crawlManager.getFullCursorHistory();
    if (n < 1 || n > fullCursor.length) {
      render.error(`history entry ${n} out of range (1–${fullCursor.length})`);
      return;
    }
    const targetEntry = fullCursor[n - 1] as FullCursorEntry;

    if (targetEntry.stashIndex === -1) {
      // Target is in the active crawl — simple jump within active cursor
      const stashEntryCount = fullCursor.length - this.crawlManager.cursorHistory.length;
      const localIndex = (n - 1) - stashEntryCount;
      const ok = this.crawlManager.cursorJump(localIndex);
      if (!ok) {
        render.error(`failed to jump to history entry ${n}`);
        return;
      }
      const entry = this.crawlManager.cursorHistory[localIndex];
      const node = this.crawlManager.getNode(entry.nodeId);
      if (node) {
        this.crawlManager.navigateToNode(node.id);
        this.restoreFromNode(node);
      } else {
        render.warn("node not found in crawl tree");
      }
    } else {
      // Target is in a stashed crawl — need to swap crawls
      const stashIdx = targetEntry.stashIndex;
      if (stashIdx < 0 || stashIdx >= this.crawlManager.stash.length) {
        render.error("stash entry not found");
        return;
      }
      // Push current active onto stash
      if (this.crawlManager.activeCrawl) {
        this.crawlManager.pushStash();
      }
      // Extract the target crawl from stash (splice it out, don't pop from end)
      const [targetStash] = this.crawlManager.stash.splice(stashIdx, 1);
      // Restore it as active
      this.crawlManager.activeCrawl = targetStash.activeCrawl;
      this.crawlManager.nodes = targetStash.nodes;
      this.crawlManager.nodeIndex = targetStash.nodeIndex;
      this.crawlManager.currentNodeId = targetStash.currentNodeId;
      this.crawlManager.cursorHistory = targetStash.cursorHistory;
      this.crawlManager.cursorIndex = targetStash.cursorIndex;

      // Now jump within this restored crawl's cursor to the right entry
      // Find the local cursor index by matching nodeId + timestamp
      const localIdx = this.crawlManager.cursorHistory.findIndex(
        e => e.nodeId === targetEntry.nodeId && e.timestamp === targetEntry.timestamp
      );
      if (localIdx >= 0) {
        this.crawlManager.cursorJump(localIdx);
      }

      const node = this.crawlManager.getNodeAcrossStash(targetEntry.nodeId);
      if (node) {
        this.crawlManager.navigateToNode(node.id);
        // Restore site/base URL from the node
        try {
          const hostname = new URL(node.url).hostname;
          this.state.site = hostname.replace(/^www\./, "").split(".")[0];
          this.engine.setBaseUrl(new URL(node.url).origin);
        } catch { /* invalid URL */ }
        this.restoreFromNode(node);
        render.status(`jumped to stashed crawl: "${targetStash.activeCrawl.name}"`);
      } else {
        render.warn("node not found in stashed crawl");
      }
    }
    render.hint(["/refresh to update content"]);
  }

  /**
   * Restore REPL state from a crawl node and render cached content.
   * Pure data + display — no browser access.
   */
  private restoreFromNode(node: CrawlNode): void {
    this.state.currentUrl = node.url;
    this.state.lastPageTitle = node.title;

    // Restore goal context if available
    if (node.metadata?.goalContext) {
      this.state.goalContext = {
        ...node.metadata.goalContext,
        breadcrumb: [...(node.metadata.goalContext.breadcrumb || [])],
      };
    }

    // Restore interpretation if available
    if (node.metadata?.interpretation) {
      this.setInterpretation(node.metadata.interpretation);
      const interp = node.metadata.interpretation;

      if (interp.summary) {
        if (interp.pageType === "content") {
          render.contentBox(node.title, interp.summary);
        } else {
          render.navSummary(node.title, interp.summary, node.url);
        }
      }
      if (interp.choices.length > 0) {
        render.choices(interp.choices.map((c) => ({ index: c.index, label: c.label })));
      }
    } else {
      // No cached interpretation — show hint
      render.status(`restored: "${node.title}" (cached content unavailable)`);
      render.hint(["/refresh to load content"]);
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

  // ---------------------------------------------------------------
  // /clear helpers
  // ---------------------------------------------------------------

  private clearRepl(): void {
    this.crawlManager.resetCursor();
    this.state.currentInterpretation = null;
    this.state.previousInterpretation = null;
    this.state.lastExtracted = null;
    this.state.history = [];
    this.state.log = [];
    this.state.goalContext = { baseGoal: "", activeIntent: "", breadcrumb: [] };
    this.state.lastPageTitle = "";
    this.state.detectedForms = [];
    this.state.loginAvailable = false;
    // Keep: currentUrl, site, homeUrl, pendingReachedBy
  }

  private clearCrawl(): void {
    if (this.crawlManager.activeCrawl) {
      try {
        const filepath = saveCrawl(this.crawlManager, this.state.log);
        this.saveSessionSidecar();
        render.status(`crawl auto-saved to ${filepath}`);
      } catch {
        // No active crawl or save failed — continue
      }
    }
    this.crawlManager.clear();
  }

  /**
   * Stash the current crawl onto the stash stack instead of destroying it.
   * Saves to disk first, then pushes onto stash for /back recovery.
   */
  private stashCrawl(): void {
    if (this.crawlManager.activeCrawl) {
      try {
        const filepath = saveCrawl(this.crawlManager, this.state.log);
        this.saveSessionSidecar();
        render.status(`crawl auto-saved to ${filepath}`);
      } catch {
        // Save failed — continue with stash anyway
      }
      this.crawlManager.pushStash();
    }
  }

  private async clearBrowser(): Promise<void> {
    await this.syncBrowser();
    await this.engine.clearBrowserData();
  }

  /**
   * Save session JSON sidecar alongside crawl markdown.
   */
  private saveSessionSidecar(): string | null {
    return saveSession({
      manager: this.crawlManager,
      currentUrl: this.state.currentUrl,
      site: this.state.site,
      homeUrl: this.state.homeUrl,
      goalContext: this.state.goalContext,
      history: this.state.history,
      log: this.state.log,
    });
  }

  /**
   * Expose crawlManager for session resume (used by index.ts).
   */
  getCrawlManager(): CrawlManager {
    return this.crawlManager;
  }

  /**
   * Resume from a saved session envelope. Restores all state.
   */
  async resumeSession(envelope: SessionEnvelope): Promise<void> {
    restoreManagerFromEnvelope(envelope, this.crawlManager);

    // Restore REPL state
    this.state.currentUrl = envelope.repl.currentUrl;
    this.state.site = envelope.repl.site;
    this.state.homeUrl = envelope.repl.homeUrl;
    this.state.goalContext = {
      ...envelope.repl.goalContext,
      breadcrumb: [...(envelope.repl.goalContext.breadcrumb || [])],
    };
    this.state.history = envelope.repl.history.map(h => ({ ...h }));
    this.state.log = envelope.log.map(l => ({ ...l }));

    // Restore current interpretation from current cursor node
    const currentEntry = this.crawlManager.getCurrentCursorEntry();
    if (currentEntry) {
      const node = this.crawlManager.getNode(currentEntry.nodeId);
      if (node?.metadata?.interpretation) {
        this.state.currentInterpretation = node.metadata.interpretation;
        this.state.lastPageTitle = node.title;
      }
    }

    // Append resume marker to log
    this.state.log.push({ role: "agent", content: "Session resumed", timestamp: Date.now() });

    // Launch browser and navigate to current URL
    render.status("launching headless browser...");
    await this.engine.launch(this.state.currentUrl || "about:blank");

    const page = this.engine.getPage();
    this.nav = new PageNavigator(page);

    if (this.state.currentUrl) {
      try {
        const hostname = new URL(this.state.currentUrl).hostname;
        this.engine.setBaseUrl(new URL(this.state.currentUrl).origin);
      } catch { /* invalid URL */ }

      this.interceptor.attach(page, this.state.currentUrl);
      this.interceptor.onIntercept = (resp) => {
        if (!this.muteInterceptor) {
          render.intercepted(resp.method, resp.url, resp.status, resp.size);
        }
      };

      render.status(`navigating to ${this.state.currentUrl}...`);
      try {
        await this.nav.goto(this.state.currentUrl);
      } catch { /* navigation failed — will show cached content */ }

      // Render from cache (no LLM call)
      const currentNode = this.crawlManager.currentNodeId
        ? this.crawlManager.getNode(this.crawlManager.currentNodeId)
        : null;
      if (currentNode) {
        this.restoreFromNode(currentNode);
      }
    }

    render.success("session resumed");

    // Start the input loop
    this.startReadline();
  }

  private async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    this.forceSave();
    this.saveSessionSidecar();
    // Save lastSessionId to config
    if (this.crawlManager.activeCrawl) {
      const config = loadConfig();
      saveConfig({ ...config, lastSessionId: this.crawlManager.activeCrawl.id });
    }
    render.status("session ended. browser closed.");
    await this.engine.close();
    this.rl.close();
    process.exit(0);
  }
}
