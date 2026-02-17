import * as readline from "readline";
import { ChildProcess, spawn } from "child_process";
import * as path from "path";
import * as http from "http";
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
import { executeChoice, ExecutionDeps } from "../auto/executor";
import { runAuto, AutoResult } from "../auto/runner";
import { SessionState, ReplContext, CommandHandler, NavigateOpts } from "./handler-types";

// Command handler imports
import { handleShow, handleHide, handleGoto, handleBack, handleForward, handleRefresh, handleHome, handleDemo } from "./handlers/navigation";
import { handleSave, handleQuit, handleUrl, handleHelp, handleLogin, handleAuto, handleClear } from "./handlers/session";
import { handleTree, handleStack, handleHistory, handleCrawl } from "./handlers/crawl";

const LLM_TIMEOUT = 30_000; // 30s timeout for LLM calls

// Dispatch map for slash commands
const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  show: handleShow,
  hide: handleHide,
  goto: handleGoto,
  back: handleBack,
  forward: handleForward,
  refresh: handleRefresh,
  home: handleHome,
  demo: handleDemo,
  save: handleSave,
  quit: handleQuit,
  url: handleUrl,
  help: handleHelp,
  login: handleLogin,
  auto: handleAuto,
  clear: handleClear,
  tree: handleTree,
  stack: handleStack,
  history: handleHistory,
  crawl: handleCrawl,
};

class CancelledError extends Error {
  constructor() { super("cancelled"); }
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
  private cityserveProcess: ChildProcess | null = null;
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
   * Shared navigation transaction: sync browser, truncate forward cursor,
   * clear interceptor, set pendingReachedBy, run optional preNavigate hook,
   * navigate, update currentUrl, settle, and process page.
   *
   * Returns true on success, false on navigation error (renders error inline).
   */
  private async navigateAndProcess(
    url: string,
    reachedBy: ReachedBy,
    opts?: {
      settleMs?: number;
      preNavigate?: () => void | Promise<void>;
    },
  ): Promise<boolean> {
    await this.syncBrowser();
    this.crawlManager.truncateCursorForward();
    this.interceptor.clear();
    this.state.pendingReachedBy = reachedBy;
    if (opts?.preNavigate) {
      await opts.preNavigate();
    }
    try {
      await this.nav.goto(url);
    } catch (err) {
      render.error((err as Error).message);
      return false;
    }
    this.state.currentUrl = url;
    await this.engine.getPage().waitForTimeout(opts?.settleMs ?? 500);
    await this.processCurrentPage();
    return true;
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
      this.interceptor.clear();                                // wipe stale auth responses
      await this.engine.getPage().waitForTimeout(500);         // let SPA JS populate DOM
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
    // Slash commands — dispatch to extracted handlers
    if (input.startsWith("/")) {
      const parts = input.slice(1).trim().split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const arg = parts.slice(1).join(" ");
      const handler = COMMAND_HANDLERS[cmd];
      if (handler) {
        const result = await handler(this.buildContext(), arg, parts.slice(1));
        if (!result?.promptHandled) this.rl.prompt();
        return;
      }
      render.error(`unknown command: /${cmd}`);
      render.help();
      this.rl.prompt();
      return;
    }

    // Command-like input detection — prompt if user typed a bare command name
    const knownCommands = ["show", "hide", "goto", "back", "forward", "save", "quit", "help", "demo", "refresh", "login", "home", "url", "stack", "history", "tree", "clear", "crawl", "auto"];
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

        // Handle fill choices (search, filter — prompt for value then execute)
        if (choice.action === "fill" && choice.fillPlan) {
          const query = await new Promise<string>((resolve) => {
            this.rl.question("  search query: ", resolve);
          });
          const trimmedQuery = query.trim();
          if (!trimmedQuery) { this.rl.prompt(); return; }

          render.status(`searching for "${trimmedQuery}"...`);
          await this.syncBrowser();
          const result = await executeChoice(choice, this.buildExecDeps(), trimmedQuery);
          this.state.goalContext.activeIntent = trimmedQuery;
          if (!this.crawlManager.activeCrawl) {
            this.addBreadcrumb(`search: ${trimmedQuery}`);
          }
          if (result.navigated) {
            await this.processCurrentPage();
          }
          this.rl.prompt();
          return;
        }

        // Add breadcrumb for navigation choices (only when no crawl — tree handles breadcrumbs)
        if (!this.crawlManager.activeCrawl) {
          this.addBreadcrumb(choice.label);
        }

        render.status(`navigating to ${choice.label}...`);
        await this.syncBrowser();
        const result = await executeChoice(choice, this.buildExecDeps());
        if (result.anchorSkipped) {
          render.status("anchor link — staying on current page");
        } else if (result.navigated) {
          await this.processCurrentPage();
        }
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

  // ---------------------------------------------------------------
  // /auto mode
  // ---------------------------------------------------------------

  /**
   * Interpret the current page without rendering anything.
   * Same logic as _processCurrentPage() but returns the interpretation
   * instead of rendering it. Used by /auto mode.
   */
  private async interpretPageOnly(): Promise<PageInterpretation> {
    const page = this.engine.getPage();

    // Check for login page
    this.state.loginAvailable = false;
    const loginCheck = await detectLoginPage(page);
    if (loginCheck.isLoginPage) {
      this.state.loginAvailable = true;
    }

    // Detect interactive forms
    this.state.detectedForms = await detectInteractiveForms(page);

    // HN item page — special handling
    if (isHNItemPage(this.state.currentUrl)) {
      const hnItem = await extractHNComments(page);
      if (hnItem) {
        this.state.lastPageTitle = hnItem.title;
        this.trackNavigation(this.state.currentUrl, this.state.lastPageTitle, this.state.pendingReachedBy);
        this.state.pendingReachedBy = "auto";

        const hnText = formatHNPageForLLM(hnItem);
        const hnAncestorCtx = formatAncestorContext(this.crawlManager);
        const hnConversationCtx = this.state.goalContext.activeIntent || undefined;
        const hnFullCtx = [hnAncestorCtx, hnConversationCtx].filter(Boolean).join("\n\n") || undefined;
        const interpretation = await withTimeout(
          this.llm.interpret(hnText, this.formatGoal(), hnFullCtx),
          LLM_TIMEOUT,
          "LLM interpret",
          this.signal
        );
        this.setInterpretation(interpretation);
        this.storeStateOnNode(interpretation);
        this.maybeNameCrawl(interpretation.summary);

        // Add HN article URL as first choice
        const choices = interpretation.choices;
        if (hnItem.articleUrl) {
          choices.unshift({
            index: 0,
            label: "Read linked article",
            action: "navigate",
            url: hnItem.articleUrl,
          });
          for (let i = 0; i < choices.length; i++) {
            choices[i].index = i + 1;
          }
        }

        this.appendSystemChoices(interpretation);
        return interpretation;
      }
    }

    // Extract page content
    const content = await this.nav.extractContent();
    this.state.lastPageTitle = content.title;
    this.trackNavigation(this.state.currentUrl, this.state.lastPageTitle, this.state.pendingReachedBy);
    this.state.pendingReachedBy = "auto";

    // Check for intercepted API data
    const apiData = this.findRelevantApiData();
    if (apiData) {
      // Create a synthetic interpretation with dataFound
      const interpretation: PageInterpretation = {
        pageType: "data",
        summary: `Structured API data captured from ${this.state.currentUrl}`,
        choices: [],
        dataFound: apiData as Record<string, unknown>,
        requiresAuth: false,
        requiresHumanInput: false,
      };
      this.setInterpretation(interpretation);
      this.storeStateOnNode(interpretation);
      return interpretation;
    }

    // Build page text (with rich content fallback)
    let pageText = this.buildPageText(content);
    const visibleTextLen = content.text.trim().length;

    if (visibleTextLen < 500) {
      const richContent = this.interceptor.findRichContent();
      if (richContent) {
        pageText = [
          `Title: ${content.title}`,
          `URL: ${content.url}`,
          `\nContent (from network):`,
          richContent.slice(0, 8000),
        ].join("\n");
      } else {
        await this.scrollToLoad();
        const reloaded = await this.nav.extractContent();
        if (reloaded.text.trim().length > visibleTextLen) {
          pageText = this.buildPageText(reloaded);
        }
      }
    }

    const ancestorCtx = formatAncestorContext(this.crawlManager);
    const conversationCtx = this.state.goalContext.activeIntent || undefined;
    const fullCtx = [ancestorCtx, conversationCtx].filter(Boolean).join("\n\n") || undefined;
    const interpretation = await withTimeout(
      this.llm.interpret(pageText, this.formatGoal(), fullCtx),
      LLM_TIMEOUT,
      "LLM interpret",
      this.signal
    );
    this.setInterpretation(interpretation);
    this.storeStateOnNode(interpretation);
    this.maybeNameCrawl(interpretation.summary);
    this.appendSystemChoices(interpretation);

    return interpretation;
  }

  /**
   * Run auto mode: LLM drives the browser toward a goal.
   */
  private async runAutoMode(goal: string): Promise<void> {
    // Set goal context
    this.state.goalContext.activeIntent = goal;
    this.logAgent(`Auto mode started: "${goal}"`);

    // Create a dedicated AbortController for this auto session
    const autoAbort = new AbortController();
    const prevAbort = this.abortController;
    this.abortController = autoAbort;

    const deps: import("../auto/runner").AutoDeps = {
      llm: this.llm,
      execDeps: this.buildExecDeps(),
      syncBrowser: () => this.syncBrowser(),
      interpretPage: () => this.interpretPageOnly(),
      extractAndReturn: async (rawData: string, g: string) => {
        return await withTimeout(
          this.llm.extractData(rawData, g),
          LLM_TIMEOUT,
          "LLM extract",
          autoAbort.signal,
        );
      },
      handleAuth: async () => {
        // Run auth flow and return success
        await this.syncBrowser();
        const page = this.engine.getPage();
        const hasPasswordForm = await page.evaluate(() => {
          const forms = document.querySelectorAll("form");
          for (const form of forms) {
            if (form.querySelector('input[type="password"]')) return true;
          }
          return false;
        });
        if (!hasPasswordForm) return false;

        render.status("auto: login required — entering credentials...");
        this.muteInterceptor = true;
        this.closingForAuth = true;
        if (this.rl) this.rl.close();
        this.closingForAuth = false;

        const { performCLIAuth } = await import("../auth/handoff");
        const authResult = await performCLIAuth(page);
        this.muteInterceptor = false;

        if (authResult.success) {
          render.success("login successful");
          this.state.loginAvailable = false;
          this.state.currentUrl = authResult.redirectedTo;
          this.state.pendingReachedBy = "auto";
          this.startReadline();
          return true;
        } else {
          render.error("login failed");
          this.startReadline();
          return false;
        }
      },
      getEnrichedTree: () => this.crawlManager.getEnrichedDisplayTree(),
      getCurrentUrl: () => this.state.currentUrl,
      getCurrentTitle: () => this.state.lastPageTitle,
    };

    const result = await runAuto(goal, deps, undefined, autoAbort.signal);

    // Restore abort controller
    this.abortController = prevAbort;

    // Show the crawl tree
    const tree = this.crawlManager.getEnrichedDisplayTree();
    if (tree) {
      console.log();
      console.log(tree);
    }

    // Show result
    render.autoResult({
      outcome: result.outcome,
      steps: result.steps.map(s => ({ choiceLabel: s.choiceLabel, reasoning: s.reasoning })),
      message: result.message,
      extracted: result.extracted ? { title: result.extracted.title, fields: result.extracted.fields } : undefined,
    });

    this.logAgent(`Auto mode ended: ${result.outcome} — ${result.message}`);

    // If auto ended on a page with choices, show them so user can continue
    if (this.state.currentInterpretation?.choices.length) {
      render.choices(this.state.currentInterpretation.choices.map(c => ({ index: c.index, label: c.label })));
    }
    this.suggestCommands();
  }

  /**
   * Build execution dependencies for executeChoice().
   */
  private buildExecDeps(): ExecutionDeps {
    return {
      page: () => this.engine.getPage(),
      nav: this.nav,
      engine: this.engine,
      currentUrl: () => this.state.currentUrl,
      setCurrentUrl: (url: string) => { this.state.currentUrl = url; },
      setPendingReachedBy: (rb: string) => { this.state.pendingReachedBy = rb as ReachedBy; },
      crawlManager: this.crawlManager,
      interceptor: this.interceptor,
    };
  }

  /**
   * Build the ReplContext dependency bag for command handlers.
   */
  private buildContext(): ReplContext {
    return {
      state: this.state,
      engine: this.engine,
      nav: this.nav,
      interceptor: this.interceptor,
      crawlManager: this.crawlManager,
      llm: this.llm,
      signal: this.signal,
      rl: this.rl,

      syncBrowser: () => this.syncBrowser(),
      processCurrentPage: () => this.processCurrentPage(),
      navigateAndProcess: (url, reachedBy, opts) => this.navigateAndProcess(url, reachedBy, opts),
      reattach: () => this.reattach(),
      buildExecDeps: () => this.buildExecDeps(),
      restoreFromNode: (node) => this.restoreFromNode(node),
      stashCrawl: () => this.stashCrawl(),
      clearRepl: () => this.clearRepl(),
      clearCrawl: () => this.clearCrawl(),
      clearBrowser: () => this.clearBrowser(),
      runLoginFlow: () => this.runLoginFlow(),
      runAutoMode: (goal) => this.runAutoMode(goal),
      confirmAction: (q) => this.confirmAction(q),
      jumpToHistory: (n) => this.jumpToHistory(n),
      suggestCommands: () => this.suggestCommands(),
      setInterpretation: (interp) => this.setInterpretation(interp),
      forceSave: () => this.forceSave(),
      saveSessionSidecar: () => this.saveSessionSidecar(),
      ensureCityServe: () => this.ensureCityServe(),
      shutdown: () => this.shutdown(),
      logAgent: (msg) => this.logAgent(msg),
      logCommand: (cmd) => this.logCommand(cmd),
    };
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
      hints.push("/auto <goal> for agent mode");
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
    const skipPatterns = ["/api/login", "/api/session", "/api/services", "/api/logout", "/api/account", "/api/report-categories"];
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

  private async ensureCityServe(): Promise<boolean> {
    // Probe port first — if server is already running, skip spawn
    const isUp = await new Promise<boolean>((resolve) => {
      const req = http.get("http://localhost:3000/api/services", { timeout: 2000 }, (res) => {
        res.resume(); // drain
        resolve(res.statusCode !== undefined && res.statusCode < 500);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
    });
    if (isUp) return true;

    // Spawn CityServe
    const projectRoot = path.resolve(__dirname, "..", "..");
    const child = spawn("npx", ["tsx", "cityserve/server.ts"], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    // Wait for "CityServe running" on stdout (up to 10s)
    const ready = await new Promise<boolean>((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) { resolved = true; child.kill(); resolve(false); }
      }, 10_000);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (!resolved && chunk.toString().includes("CityServe running")) {
          resolved = true;
          clearTimeout(timeout);
          resolve(true);
        }
      });

      child.on("error", () => {
        if (!resolved) { resolved = true; clearTimeout(timeout); resolve(false); }
      });

      child.on("exit", () => {
        if (!resolved) { resolved = true; clearTimeout(timeout); resolve(false); }
      });
    });

    if (ready) {
      this.cityserveProcess = child;
      child.on("exit", (code) => {
        if (this.cityserveProcess === child) {
          render.status(`CityServe exited unexpectedly (code ${code})`);
          this.cityserveProcess = null;
        }
      });
      return true;
    }

    return false;
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
    if (this.cityserveProcess) {
      this.cityserveProcess.kill();
      this.cityserveProcess = null;
    }
    await this.engine.close();
    this.rl.close();
    process.exit(0);
  }
}
