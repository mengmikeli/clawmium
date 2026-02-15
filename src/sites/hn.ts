import type { Page } from "playwright";

export interface HNComment {
  author: string;
  age: string;
  text: string;
  depth: number;
}

export interface HNItemPage {
  title: string;
  articleUrl: string;   // external article link (or "" if self-post)
  points: string;
  author: string;
  commentCount: number;
  comments: HNComment[];
}

export function isHNDomain(url: string): boolean {
  try {
    return new URL(url).hostname === "news.ycombinator.com";
  } catch {
    return false;
  }
}

export function isHNItemPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "news.ycombinator.com" && parsed.pathname === "/item" && parsed.searchParams.has("id");
  } catch {
    return false;
  }
}

export async function extractHNComments(page: Page): Promise<HNItemPage | null> {
  try {
    return await page.evaluate(() => {
      // Title + external URL
      const titleEl = document.querySelector(".titleline > a") as HTMLAnchorElement | null;
      const title = titleEl?.textContent?.trim() || "";
      let articleUrl = titleEl?.href || "";
      // If article URL points back to HN item page, it's a self-post
      if (articleUrl.includes("news.ycombinator.com/item")) {
        articleUrl = "";
      }

      // Points/author from subtext
      const subtext = document.querySelector(".subtext");
      const points = subtext?.querySelector(".score")?.textContent?.trim() || "";
      const author = subtext?.querySelector(".hnuser")?.textContent?.trim() || "";

      // Comments
      const commentRows = document.querySelectorAll("tr.comtr");
      const comments: Array<{ author: string; age: string; text: string; depth: number }> = [];
      for (const row of commentRows) {
        if (comments.length >= 30) break;

        // Depth from indent image width
        const indentImg = row.querySelector("td.ind img") as HTMLImageElement | null;
        const depth = indentImg ? Math.round(indentImg.width / 40) : 0;

        const commentAuthor = row.querySelector(".comhead .hnuser")?.textContent?.trim() || "";
        const age = row.querySelector(".comhead .age a")?.textContent?.trim() || "";
        const textEl = row.querySelector(".commtext");
        const text = textEl?.textContent?.trim() || "";

        if (text) {
          comments.push({ author: commentAuthor, age, text, depth });
        }
      }

      return {
        title,
        articleUrl,
        points,
        author,
        commentCount: comments.length,
        comments,
      };
    });
  } catch {
    return null;
  }
}

export function formatHNPageForLLM(item: HNItemPage): string {
  const lines: string[] = [
    `Title: ${item.title}`,
    `Points: ${item.points} | Author: ${item.author}`,
  ];

  if (item.articleUrl) {
    lines.push(`Article URL: ${item.articleUrl}`);
  }

  lines.push("", "=== Comments ===");

  for (const comment of item.comments) {
    const indent = "  ".repeat(comment.depth);
    lines.push(`${indent}[${comment.author}] (${comment.age}):`);
    lines.push(`${indent}  ${comment.text}`);
    lines.push("");
  }

  return lines.join("\n");
}
