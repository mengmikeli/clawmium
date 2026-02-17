import { ReplContext, HandlerResult } from "../handler-types";
import * as render from "../renderer";

// ===================================================================
// /save
// ===================================================================

export async function handleSave(ctx: ReplContext): Promise<void> {
  ctx.forceSave();
  ctx.logCommand("/save");
}

// ===================================================================
// /quit
// ===================================================================

export async function handleQuit(ctx: ReplContext): Promise<HandlerResult> {
  await ctx.shutdown();
  return { promptHandled: true };
}

// ===================================================================
// /url
// ===================================================================

export async function handleUrl(ctx: ReplContext): Promise<void> {
  console.log(ctx.state.currentUrl || "(no URL)");
}

// ===================================================================
// /help
// ===================================================================

export async function handleHelp(ctx: ReplContext): Promise<void> {
  render.help();
  ctx.logCommand("/help");
}

// ===================================================================
// /login
// ===================================================================

export async function handleLogin(ctx: ReplContext): Promise<HandlerResult> {
  await ctx.runLoginFlow();
  ctx.logCommand("/login");
  return { promptHandled: true };
}

// ===================================================================
// /auto
// ===================================================================

export async function handleAuto(ctx: ReplContext, arg: string): Promise<void> {
  if (!arg) {
    render.error("usage: /auto <goal>");
    return;
  }
  await ctx.runAutoMode(arg);
  ctx.logCommand(`/auto ${arg}`);
}

// ===================================================================
// /clear
// ===================================================================

export async function handleClear(ctx: ReplContext, arg: string): Promise<void> {
  const scope = arg.toLowerCase() || "all";
  const validScopes = ["repl", "crawl", "browser", "all"];
  if (!validScopes.includes(scope)) {
    render.error(`unknown scope: ${scope} (use repl, crawl, browser, or all)`);
    return;
  }

  const items: string[] = [];
  if (scope === "repl" || scope === "all") {
    items.push("REPL stacks, interpretations, history, log, goal");
  }
  if (scope === "crawl" || scope === "all") {
    const stashNote = ctx.crawlManager.hasStash() ? ` + ${ctx.crawlManager.getStashDepth()} stashed` : "";
    items.push("crawl tree" + stashNote + (ctx.crawlManager.activeCrawl ? " (will auto-save first)" : ""));
  }
  if (scope === "browser" || scope === "all") {
    items.push("browser cookies, localStorage, sessionStorage");
  }

  render.clearSummary(items);
  const confirmed = await ctx.confirmAction("proceed?");
  if (!confirmed) {
    render.status("cancelled");
    return;
  }

  if (scope === "repl" || scope === "all") {
    ctx.clearRepl();
  }
  if (scope === "crawl" || scope === "all") {
    ctx.clearCrawl();
  }
  if (scope === "browser" || scope === "all") {
    await ctx.clearBrowser();
  }

  render.success(`cleared: ${scope}`);
  ctx.logCommand(`/clear ${scope}`);
}
