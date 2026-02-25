import { chromium, Browser, BrowserContext, Page, CDPSession } from "playwright";

/** Prefer markdown from servers that support it; graceful fallback for all others. */
const EXTRA_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/markdown;q=0.8,*/*;q=0.7',
};

export class BrowserEngine {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private showing = false;
  private baseUrl = "";
  private headed = false;

  async launch(baseUrl: string): Promise<void> {
    this.baseUrl = baseUrl;
    this.browser = await chromium.launch({ headless: true });
    this.listenForDisconnect();
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: EXTRA_HEADERS,
    });
    this.page = await this.context.newPage();
    this.headed = false;
    this.showing = false;
  }

  /**
   * Relaunch browser in headed mode, transferring cookies and navigating
   * to the current URL so the user sees the live page.
   */
  async show(): Promise<boolean> {
    if (this.showing) {
      // Already headed — try to bring window to focus
      if (this.cdp) {
        try {
          const { windowId } = await this.cdp.send("Browser.getWindowForTarget") as { windowId: number };
          await this.cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
        } catch { /* CDP focus failed — window is still open */ }
      }
      return false; // no new browser instance created
    }

    const page = this.getPage();
    const currentUrl = page.url();
    const cookies = await page.context().cookies();

    // Close headless browser
    await this.browser!.close();

    // Relaunch headed
    this.browser = await chromium.launch({
      headless: false,
      args: ["--window-size=1280,900"],
    });
    this.listenForDisconnect();
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: EXTRA_HEADERS,
    });

    // Restore cookies
    if (cookies.length > 0) {
      await this.context.addCookies(cookies);
    }

    this.page = await this.context.newPage();
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.headed = true;
    this.showing = true;

    // Navigate to where we were
    if (currentUrl && currentUrl !== "about:blank") {
      try {
        await this.page.goto(currentUrl, { waitUntil: "networkidle", timeout: 15_000 });
      } catch {
        try {
          await this.page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
        } catch {
          // Continue — page may partially load and that's OK
        }
      }
    }

    return true; // new browser instance created
  }

  /**
   * Relaunch browser in headless mode, transferring cookies.
   */
  async hide(): Promise<void> {
    if (!this.showing) return;

    const page = this.getPage();
    const currentUrl = page.url();
    const cookies = await page.context().cookies();

    // Close headed browser
    await this.browser!.close();

    // Relaunch headless
    this.browser = await chromium.launch({ headless: true });
    this.listenForDisconnect();
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: EXTRA_HEADERS,
    });

    // Restore cookies
    if (cookies.length > 0) {
      await this.context.addCookies(cookies);
    }

    this.page = await this.context.newPage();
    this.cdp = null;
    this.headed = false;
    this.showing = false;

    // Navigate to where we were
    if (currentUrl && currentUrl !== "about:blank") {
      try {
        await this.page.goto(currentUrl, { waitUntil: "networkidle", timeout: 15_000 });
      } catch {
        try {
          await this.page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
        } catch {
          // Continue — page may partially load and that's OK
        }
      }
    }
  }

  getPage(): Page {
    if (!this.page) throw new Error("Browser not launched");
    return this.page;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  isShowing(): boolean {
    return this.showing;
  }

  /**
   * Check if the browser is still alive and responsive.
   */
  isAlive(): boolean {
    if (!this.browser || !this.page) return false;
    try {
      // Accessing browser.isConnected() is synchronous and cheap
      return this.browser.isConnected();
    } catch {
      return false;
    }
  }

  /**
   * Clear cookies, localStorage, and sessionStorage.
   */
  async clearBrowserData(): Promise<void> {
    if (!this.context || !this.page) return;
    await this.context.clearCookies();
    try {
      await this.page.evaluate(() => {
        try { localStorage.clear(); } catch {}
        try { sessionStorage.clear(); } catch {}
      });
    } catch { /* about:blank or unresponsive — skip */ }
  }

  /**
   * Recover from a crashed browser by relaunching headless.
   * Launches to about:blank — caller navigates to the correct URL.
   */
  async recover(): Promise<void> {
    // Clean up any remnants
    try { await this.browser?.close(); } catch { /* already dead */ }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.cdp = null;
    this.showing = false;
    this.headed = false;

    // Relaunch headless — caller will navigate
    this.browser = await chromium.launch({ headless: true });
    this.listenForDisconnect();
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: EXTRA_HEADERS,
    });
    this.page = await this.context.newPage();
  }

  private listenForDisconnect(): void {
    const browser = this.browser;
    browser?.on("disconnected", () => {
      // Only null out if this is still the active browser instance
      if (this.browser === browser) {
        this.browser = null;
        this.context = null;
        this.page = null;
        this.cdp = null;
        this.showing = false;
        this.headed = false;
      }
    });
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      this.cdp = null;
      this.showing = false;
    }
  }
}
