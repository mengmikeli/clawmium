import { chromium, Browser, BrowserContext, Page, CDPSession } from "playwright";

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
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    this.page = await this.context.newPage();
    this.headed = false;
    this.showing = false;
  }

  /**
   * Relaunch browser in headed mode, transferring cookies and navigating
   * to the current URL so the user sees the live page.
   */
  async show(): Promise<void> {
    if (this.showing) return;

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
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
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
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
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
   * Recover from a crashed browser by relaunching headless.
   * Returns to about:blank — caller should navigate as needed.
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

    // Relaunch headless
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    this.page = await this.context.newPage();
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
