import { Page, Response } from "playwright";

export interface InterceptedResponse {
  url: string;
  method: string;
  status: number;
  contentType: string;
  body: unknown;
  timestamp: number;
  size: number;
}

export class NetworkInterceptor {
  private responses: InterceptedResponse[] = [];
  private allowedOrigin: string | null = null;
  private markdownContent: string | null = null;
  onIntercept: ((resp: InterceptedResponse) => void) | null = null;

  attach(page: Page, baseUrl?: string): void {
    if (baseUrl) {
      try {
        this.allowedOrigin = new URL(baseUrl).origin;
      } catch {
        this.allowedOrigin = null;
      }
    }

    page.on("response", async (response: Response) => {
      const url = response.url();

      const contentType = response.headers()["content-type"] || "";

      // Capture markdown responses (from servers that honor Accept: text/markdown)
      if (contentType.includes("text/markdown")) {
        try {
          const body = await response.text();
          if (body && body.length > 0) {
            this.markdownContent = body.length > 8000 ? body.slice(0, 8000) : body;
          }
        } catch { /* body may be disposed */ }
      }

      if (!contentType.includes("application/json")) return;

      // For /api/ routes, only capture from our target origin
      const isApi = url.includes("/api/");
      if (isApi && this.allowedOrigin) {
        try {
          const responseOrigin = new URL(url).origin;
          if (responseOrigin !== this.allowedOrigin) return;
        } catch {
          return;
        }
      }

      // For non-api routes, capture same-page-origin JSON (article data, etc.)
      if (!isApi) {
        try {
          const pageOrigin = page.url() ? new URL(page.url()).origin : null;
          const responseOrigin = new URL(url).origin;
          if (!pageOrigin || responseOrigin !== pageOrigin) return;
        } catch {
          return;
        }
      }

      let body: unknown = null;
      let size = 0;
      try {
        const buffer = await response.body();
        size = buffer.length;
        body = JSON.parse(buffer.toString());
      } catch {
        // Body may be disposed if page navigated away
      }

      const entry: InterceptedResponse = {
        url,
        method: response.request().method(),
        status: response.status(),
        contentType,
        body,
        timestamp: Date.now(),
        size,
      };

      this.responses.push(entry);
      // Only notify (log) for /api/ routes — non-api captures are silent
      if (isApi) {
        this.onIntercept?.(entry);
      }
    });
  }

  getResponses(): InterceptedResponse[] {
    return [...this.responses];
  }

  getLatest(urlPattern: string): InterceptedResponse | undefined {
    for (let i = this.responses.length - 1; i >= 0; i--) {
      if (this.responses[i].url.includes(urlPattern)) {
        return this.responses[i];
      }
    }
    return undefined;
  }

  clear(): void {
    this.responses = [];
    this.markdownContent = null;
  }

  getMarkdownContent(): string | null {
    return this.markdownContent;
  }

  /**
   * Find intercepted JSON responses that contain rich text content
   * (article bodies, long descriptions, etc.). Returns the largest
   * text blob found, or null if nothing substantial was captured.
   *
   * Filters out config/messaging/analytics blobs by:
   * - Skipping URLs that look like analytics, messaging, config endpoints
   * - Requiring extracted text to have sentence-like structure
   */
  findRichContent(): string | null {
    const skipPatterns = [
      /statsig/i, /analytics/i, /messaging/i, /tracking/i,
      /config/i, /rgstr/i, /beacon/i, /telemetry/i, /log/i,
    ];

    let best: string | null = null;
    let bestLen = 0;

    for (const resp of this.responses) {
      if (resp.status !== 200 || !resp.body) continue;
      // Skip analytics/config endpoints
      if (skipPatterns.some((p) => p.test(resp.url))) continue;
      // Skip very large blobs (likely config, not article content)
      if (resp.size > 50_000) continue;

      const text = this.extractTextFromJson(resp.body);
      // Require sentence-like content (has periods, multiple words)
      if (text.length > 200 && /\.\s/.test(text) && text.split(/\s+/).length > 30) {
        if (text.length > bestLen) {
          best = text;
          bestLen = text.length;
        }
      }
    }

    return best;
  }

  /**
   * Recursively walk a JSON value and extract all string fields
   * that look like readable text content (> 100 chars, not URLs/tokens).
   */
  private extractTextFromJson(value: unknown, depth = 0): string {
    if (depth > 10) return "";

    if (typeof value === "string") {
      // Skip URLs, tokens, hashes, base64, etc.
      if (/^https?:\/\//.test(value)) return "";
      if (/^[A-Za-z0-9+/=]{40,}$/.test(value)) return "";
      if (value.length > 100) return value;
      return "";
    }

    if (Array.isArray(value)) {
      const parts = value.map((v) => this.extractTextFromJson(v, depth + 1)).filter(Boolean);
      return parts.join("\n\n");
    }

    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      // Prioritize fields that commonly hold article content
      const priorityKeys = ["body", "content", "text", "article", "html", "abstract", "summary", "description", "lead_paragraph", "paragraph"];
      const parts: string[] = [];

      for (const key of priorityKeys) {
        if (key in obj) {
          const text = this.extractTextFromJson(obj[key], depth + 1);
          if (text) parts.push(text);
        }
      }

      if (parts.length === 0) {
        // Fall back to scanning all values
        for (const v of Object.values(obj)) {
          const text = this.extractTextFromJson(v, depth + 1);
          if (text) parts.push(text);
        }
      }

      return parts.join("\n\n");
    }

    return "";
  }
}
