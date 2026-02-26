/**
 * Derive a human-readable name for a crawl from the first page's summary.
 * No extra LLM call — uses what we already have.
 */
export function deriveCrawlName(rootUrl: string, summary: string, baseGoal: string): string {
  // 1. If user set a specific goal (not auto "browsing ..."), use it
  if (baseGoal && !baseGoal.startsWith("browsing ")) {
    return baseGoal.slice(0, 60);
  }

  // 2. If we have a meaningful summary, use first clause
  if (summary && !/content is empty|page content is empty/i.test(summary)) {
    // First clause = up to first comma, semicolon, period, or em-dash
    const firstClause = summary.split(/[,;.\u2014—]/)[0].trim();
    if (firstClause.length > 0) {
      const lowered = firstClause.charAt(0).toLowerCase() + firstClause.slice(1);
      if (lowered.length <= 50) return lowered;
      const truncated = lowered.slice(0, 50);
      const lastSpace = truncated.lastIndexOf(" ");
      return lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated;
    }
  }

  // 3. Fallback: hostname + date
  try {
    const hostname = new URL(rootUrl).hostname.replace(/^www\./, "");
    const date = new Date().toISOString().slice(0, 10);
    return `${hostname} ${date}`;
  } catch {
    const date = new Date().toISOString().slice(0, 10);
    return `crawl ${date}`;
  }
}
