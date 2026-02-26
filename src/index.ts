import "dotenv/config";
import * as readline from "readline";
import { BrowserEngine } from "./browser/engine";
import { LLMProvider } from "./llm/provider";
import { AnthropicProvider } from "./llm/anthropic";
import { OpenAIProvider } from "./llm/openai";
import { Repl } from "./cli/repl";
import * as render from "./cli/renderer";
import { loadSession } from "./session/persistence";
import { buildHomepage, renderHomepage, homepageTotal, homepageCrawlAt } from "./cli/homepage";
import { listCrawlsWithMeta, loadCrawl, saveCrawl } from "./crawl/persistence";
import { classifyCrawlHeuristic, formatCrawlForClassification, classifyCrawlLLM } from "./crawl/classify";
import { CrawlManager } from "./crawl/tree";

function createProvider(): { provider: LLMProvider; name: string } {
  const providerName = process.env.LLM_PROVIDER || "anthropic";

  if (providerName === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key || key === "sk-ant-...") {
      render.error("Set ANTHROPIC_API_KEY in .env");
      process.exit(1);
    }
    return { provider: new AnthropicProvider(key), name: "anthropic" };
  }

  if (providerName === "openai") {
    const key = process.env.OPENAI_API_KEY;
    if (!key || key === "sk-...") {
      render.error("Set OPENAI_API_KEY in .env");
      process.exit(1);
    }
    return { provider: new OpenAIProvider(key), name: "openai" };
  }

  render.error(`Unknown LLM_PROVIDER: ${providerName}`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const hasNewFlag = args.includes("--new");

  const { provider, name } = createProvider();
  await render.banner(name);

  const engine = new BrowserEngine();

  if (command === "browse" && args[1]) {
    // clm browse <url> — start at a specific URL
    let url = args[1];
    if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(url)) {
      url = `https://${url}`;
    }
    const site = new URL(url).hostname.replace(/^www\./, "").split(".")[0];
    const repl = new Repl(engine, provider, `browsing ${site}`, site);
    await repl.start(url);
  } else {
    // clm (no args) — show homepage dashboard
    if (!hasNewFlag) {
      // Startup sweep: re-classify stale open crawls (up to 3)
      try {
        const allPeeks = listCrawlsWithMeta();
        const staleOpen = allPeeks.filter(
          (p) => (!p.lifecycle || p.lifecycle === "open") && p.lastAccessed && Date.now() - p.lastAccessed > 24 * 3600000,
        );
        for (const peek of staleOpen.slice(0, 3)) {
          const m = new CrawlManager();
          if (loadCrawl(peek.id, m)) {
            const sessionDurationMs = (m.activeCrawl?.lastAccessed || 0) - (m.activeCrawl?.created || 0);
            const result = classifyCrawlHeuristic({
              crawl: m.activeCrawl!,
              nodes: m.nodes,
              sessionDurationMs: Math.max(0, sessionDurationMs),
            });
            m.setCrawlMeta({
              lifecycle: result.lifecycle,
              lifecycleReason: result.lifecycleReason,
              lifecycleUpdatedAt: Date.now(),
              tags: result.tags,
              noise: result.noise,
              sensitive: result.sensitive,
            });
            saveCrawl(m);
            // NOTE: Do NOT call saveSession() here — it would overwrite the
            // real session sidecar with empty state. The .md file is sufficient
            // for updating lifecycle metadata.
          }
        }
      } catch {
        // Sweep failed — continue without it
      }

      const homepage = buildHomepage();
      const total = homepageTotal(homepage);

      if (total > 0) {
        renderHomepage(homepage);

        // Wait for user input: number to resume, /goto for new, empty for blank start
        const answer = await new Promise<string>((resolve) => {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          rl.question(`${"\x1b[36m"}> ${"\x1b[0m"}`, (ans) => {
            rl.close();
            resolve(ans.trim());
          });
        });

        // Number → resume that crawl's session
        const num = parseInt(answer, 10);
        if (!isNaN(num) && num >= 1) {
          const picked = homepageCrawlAt(homepage, num);
          if (picked) {
            const envelope = loadSession(picked.id);
            if (envelope) {
              const repl = new Repl(engine, provider, "", "");
              await repl.resumeSession(envelope);
              return;
            }
            render.warn(`could not load session for "${picked.name}" — starting fresh`);
          } else {
            render.warn(`no crawl at index ${num}`);
          }
        }

        // /goto <url> → pass through to normal startup with URL
        if (answer.startsWith("/goto ")) {
          let url = answer.slice(6).trim();
          if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(url)) {
            url = `https://${url}`;
          }
          const site = new URL(url).hostname.replace(/^www\./, "").split(".")[0];
          const repl = new Repl(engine, provider, `browsing ${site}`, site);
          await repl.start(url);
          return;
        }

        // Empty or unrecognized → fall through to blank start
      }
    }

    // Normal startup — blank prompt, navigate via /goto or /home
    const repl = new Repl(engine, provider, "", "");
    await repl.start();
  }
}

main().catch((err) => {
  render.error(`Fatal: ${err.message}`);
  process.exit(1);
});
