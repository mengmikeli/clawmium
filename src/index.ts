import "dotenv/config";
import * as readline from "readline";
import { BrowserEngine } from "./browser/engine";
import { LLMProvider } from "./llm/provider";
import { AnthropicProvider } from "./llm/anthropic";
import { OpenAIProvider } from "./llm/openai";
import { Repl } from "./cli/repl";
import * as render from "./cli/renderer";
import { loadConfig } from "./output/writer";
import { findLastSession, loadSession, SessionEnvelope } from "./session/persistence";

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

/**
 * Prompt the user for y/n using raw readline (before REPL starts).
 */
function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith("y"));
    });
  });
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
    // clm (no args) — try to resume previous session
    if (!hasNewFlag) {
      // Check for last session: try config.lastSessionId first, then scan
      const config = loadConfig();
      let envelope: SessionEnvelope | null = null;

      if (config.lastSessionId) {
        envelope = loadSession(config.lastSessionId);
      }
      if (!envelope) {
        const found = findLastSession(7);
        if (found) envelope = found.envelope;
      }

      if (envelope) {
        const crawlName = envelope.crawl.name || "unnamed";
        const savedAgo = Math.round((Date.now() - envelope.savedAt) / 60000);
        const timeStr = savedAgo < 60
          ? `${savedAgo}m ago`
          : savedAgo < 1440
            ? `${Math.round(savedAgo / 60)}h ago`
            : `${Math.round(savedAgo / 1440)}d ago`;

        render.status(`found previous session: "${crawlName}" (saved ${timeStr})`);
        const resume = await askYesNo("  Resume previous session? (y/n) ");

        if (resume) {
          const repl = new Repl(engine, provider, "", "");
          await repl.resumeSession(envelope);
          return;
        }
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
