import { Page } from "playwright";

export interface PageContent {
  title: string;
  url: string;
  text: string;
  links: Array<{ text: string; href: string }>;
  forms: Array<{
    id: string;
    action: string;
    inputs: Array<{ name: string; type: string; label?: string }>;
  }>;
}

export class PageNavigator {
  constructor(private page: Page) {}

  async goto(url: string): Promise<void> {
    try {
      await this.page.goto(url, { waitUntil: "networkidle", timeout: 15_000 });
    } catch {
      // networkidle can hang on complex sites — fall back to domcontentloaded
      try {
        await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      } catch {
        // Page may have already navigated; continue with whatever loaded
      }
    }
  }

  async extractContent(): Promise<PageContent> {
    return this.page.evaluate(() => {
      const title = document.title;
      const url = window.location.href;
      const text = document.body.innerText;

      // De-duplicated links
      const seen = new Set<string>();
      const links: Array<{ text: string; href: string }> = [];
      for (const a of document.querySelectorAll("a[href]")) {
        const href = (a as HTMLAnchorElement).href;
        if (!seen.has(href)) {
          seen.add(href);
          links.push({ text: a.textContent?.trim() || "", href });
        }
      }

      // Forms with labeled inputs
      const forms = Array.from(document.querySelectorAll("form")).map((form) => {
        const inputs = Array.from(form.querySelectorAll("input, select, textarea")).map((el) => {
          const input = el as HTMLInputElement;
          const name = input.name || input.id || "";
          const type = input.type || el.tagName.toLowerCase();
          // Find associated label
          let label: string | undefined;
          if (input.id) {
            const labelEl = document.querySelector(`label[for="${input.id}"]`);
            if (labelEl) label = labelEl.textContent?.trim();
          }
          if (!label) {
            const parent = input.closest("label");
            if (parent) label = parent.textContent?.trim();
          }
          return { name, type, ...(label ? { label } : {}) };
        });

        return {
          id: form.id || "",
          action: form.action || "",
          inputs,
        };
      });

      return { title, url, text, links, forms };
    });
  }

  async click(selector: string): Promise<void> {
    await this.page.click(selector);
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.page.fill(selector, value);
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot();
  }

  async goBack(): Promise<void> {
    try {
      await this.page.goBack({ waitUntil: "networkidle", timeout: 10_000 });
    } catch {
      try {
        await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 10_000 });
      } catch {
        // Continue with whatever loaded
      }
    }
  }

  currentUrl(): string {
    return this.page.url();
  }
}
