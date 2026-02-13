import "dotenv/config";
import { BrowserEngine } from "./browser/engine";
import { LLMProvider } from "./llm/provider";
import { AnthropicProvider } from "./llm/anthropic";
import { OpenAIProvider } from "./llm/openai";
import { Repl } from "./cli/repl";
import * as render from "./cli/renderer";

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

  const { provider, name } = createProvider();
  render.banner(name);

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
    // clm — start with default landing page (HN)
    const defaultUrl = "https://news.ycombinator.com";
    const repl = new Repl(engine, provider, "browsing hacker news", "hackernews");
    await repl.start(defaultUrl);
  }
}

main().catch((err) => {
  render.error(`Fatal: ${err.message}`);
  process.exit(1);
});
