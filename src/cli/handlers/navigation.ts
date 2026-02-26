import { ReplContext, HandlerResult } from "../handler-types";
import * as render from "../renderer";
import { saveConfig } from "../../output/writer";
import { saveCrawl } from "../../crawl/persistence";
import { buildHomepage, renderHomepage, homepageTotal } from "../homepage";

// ===================================================================
// /show
// ===================================================================

export async function handleShow(ctx: ReplContext): Promise<void> {
  await ctx.syncBrowser();
  if (ctx.engine.isShowing()) {
    render.status("bringing browser window to focus...");
  } else {
    render.status("opening browser window...");
  }
  const created = await ctx.engine.show();
  if (created) {
    ctx.reattach();
    try {
      await ctx.engine.getPage().waitForLoadState("domcontentloaded", { timeout: 5_000 });
    } catch { /* page may already be loaded */ }
  }
  ctx.logCommand("/show");
}

// ===================================================================
// /hide
// ===================================================================

export async function handleHide(ctx: ReplContext): Promise<void> {
  await ctx.syncBrowser();
  render.status("hiding browser window...");
  await ctx.engine.hide();
  ctx.reattach();
  ctx.logCommand("/hide");
}

// ===================================================================
// /goto
// ===================================================================

export async function handleGoto(ctx: ReplContext, arg: string): Promise<void> {
  if (!arg) {
    render.error("usage: /goto <url>");
    return;
  }
  let url = arg;
  // Resolve to a full URL first
  if (/^https?:\/\//.test(url)) {
    // already absolute
  } else if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(url)) {
    url = `https://${url}`;
  } else {
    url = `${ctx.engine.getBaseUrl()}${url.startsWith("/") ? "" : "/"}${url}`;
  }
  // Compare origins to decide whether to stash the current crawl
  const currentOrigin = ctx.engine.getBaseUrl();
  let newOrigin: string;
  try { newOrigin = new URL(url).origin; } catch { newOrigin = ""; }
  const isExternal = newOrigin !== currentOrigin;
  if (isExternal) {
    ctx.stashCrawl();
    ctx.state.goalContext = { baseGoal: `browsing ${new URL(url).hostname}`, activeIntent: "", breadcrumb: [] };
    const origin = new URL(url).origin;
    ctx.engine.setBaseUrl(origin);
    ctx.state.site = new URL(url).hostname.replace(/^www\./, "").split(".")[0];
  }
  render.status(`navigating to ${url}...`);
  await ctx.navigateAndProcess(url, "goto");
  ctx.logCommand(`/goto ${arg}`);
}

// ===================================================================
// /back
// ===================================================================

export async function handleBack(ctx: ReplContext): Promise<void> {
  const entry = ctx.crawlManager.cursorBack();
  if (entry) {
    // Check if the node is in the active crawl or a stashed one
    const node = ctx.crawlManager.getNode(entry.nodeId);
    if (node) {
      // Node is in active crawl — simple case
      ctx.crawlManager.navigateToNode(node.id);
      ctx.restoreFromNode(node);
      render.hint(["/refresh to update content"]);
    } else {
      // Node not in active crawl — check stash for cross-crawl navigation
      const owner = ctx.crawlManager.findOwnerCrawl(entry.nodeId);
      if (owner && owner.stashIndex >= 0) {
        // Save current crawl before swapping
        if (ctx.crawlManager.activeCrawl) {
          try {
            saveCrawl(ctx.crawlManager, ctx.state.log);
            ctx.saveSessionSidecar();
          } catch { /* save failed — continue */ }
        }
        ctx.crawlManager.swapToStash(owner.stashIndex);
        const swappedNode = ctx.crawlManager.getNode(entry.nodeId);
        if (swappedNode) {
          ctx.crawlManager.navigateToNode(swappedNode.id);
          try {
            const hostname = new URL(swappedNode.url).hostname;
            ctx.state.site = hostname.replace(/^www\./, "").split(".")[0];
            ctx.engine.setBaseUrl(new URL(swappedNode.url).origin);
          } catch { /* invalid URL */ }
          ctx.restoreFromNode(swappedNode);
          render.status(`returned to crawl: "${ctx.crawlManager.activeCrawl?.name}"`);
          render.hint(["/refresh to update content"]);
        }
      } else {
        render.warn("node not found in any crawl");
      }
    }
  } else {
    if (ctx.crawlManager.cursorHistory.length > 0) {
      render.warn("already at start of history");
    } else {
      render.warn("no history to go back to");
    }
  }
  ctx.logCommand("/back");
}

// ===================================================================
// /forward
// ===================================================================

export async function handleForward(ctx: ReplContext): Promise<void> {
  const entry = ctx.crawlManager.cursorForward();
  if (entry) {
    const node = ctx.crawlManager.getNode(entry.nodeId);
    if (node) {
      // Node is in active crawl
      ctx.crawlManager.navigateToNode(node.id);
      ctx.restoreFromNode(node);
      render.hint(["/refresh to update content"]);
    } else {
      // Node not in active crawl — check stash for cross-crawl navigation
      const owner = ctx.crawlManager.findOwnerCrawl(entry.nodeId);
      if (owner && owner.stashIndex >= 0) {
        ctx.crawlManager.swapToStash(owner.stashIndex);
        const swappedNode = ctx.crawlManager.getNode(entry.nodeId);
        if (swappedNode) {
          ctx.crawlManager.navigateToNode(swappedNode.id);
          try {
            const hostname = new URL(swappedNode.url).hostname;
            ctx.state.site = hostname.replace(/^www\./, "").split(".")[0];
            ctx.engine.setBaseUrl(new URL(swappedNode.url).origin);
          } catch { /* invalid URL */ }
          ctx.restoreFromNode(swappedNode);
          render.status(`returned to crawl: "${ctx.crawlManager.activeCrawl?.name}"`);
          render.hint(["/refresh to update content"]);
        }
      } else {
        render.warn("node not found in any crawl");
      }
    }
  } else {
    render.warn("no forward history");
  }
  ctx.logCommand("/forward");
}

// ===================================================================
// /refresh
// ===================================================================

export async function handleRefresh(ctx: ReplContext): Promise<void> {
  await ctx.syncBrowser();
  render.status("refreshing page...");
  ctx.interceptor.clear();
  ctx.state.pendingForceRefresh = true;
  await ctx.processCurrentPage();
  ctx.logCommand("/refresh");
}

// ===================================================================
// /home
// ===================================================================

export async function handleHome(ctx: ReplContext, arg: string): Promise<HandlerResult | void> {
  if (arg === "clear") {
    ctx.state.homeUrl = "";
    saveConfig({ homeUrl: "" });
    render.success("home URL cleared");
    ctx.logCommand("/home clear");
    return;
  }
  if (arg) {
    // /home set <url> or /home <url>
    let url = arg.replace(/^set\s+/, "");
    if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(url)) {
      url = `https://${url}`;
    }
    ctx.state.homeUrl = url;
    saveConfig({ homeUrl: url });
    render.success(`home URL set to ${url}`);
    ctx.logCommand(`/home ${arg}`);
    return;
  }
  if (ctx.state.homeUrl) {
    render.status(`navigating to ${ctx.state.homeUrl}...`);
    const homeHostname = new URL(ctx.state.homeUrl).hostname;
    await ctx.navigateAndProcess(ctx.state.homeUrl, "goto", {
      preNavigate: () => {
        ctx.state.goalContext = { baseGoal: `browsing ${homeHostname}`, activeIntent: "", breadcrumb: [] };
      },
    });
    ctx.logCommand("/home");
    return;
  }
  // No home URL set — show homepage dashboard if crawls exist
  const homepage = buildHomepage();
  if (homepageTotal(homepage) > 0) {
    renderHomepage(homepage);
    ctx.logCommand("/home");
    return;
  }
  // No crawls either — prompt user to set home URL
  const answer = await new Promise<string>((resolve) => {
    ctx.rl.question("  enter home URL (or 'cancel'): ", resolve);
  });
  const trimmed = answer.trim();
  if (!trimmed || trimmed.toLowerCase() === "cancel") {
    return;
  }
  let homeUrl = trimmed;
  if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(homeUrl)) {
    homeUrl = `https://${homeUrl}`;
  }
  ctx.state.homeUrl = homeUrl;
  saveConfig({ homeUrl });
  render.success(`home URL set to ${homeUrl}`);
  render.status(`navigating to ${homeUrl}...`);
  const promptHostname = new URL(homeUrl).hostname;
  await ctx.navigateAndProcess(homeUrl, "goto", {
    preNavigate: () => {
      ctx.state.goalContext = { baseGoal: `browsing ${promptHostname}`, activeIntent: "", breadcrumb: [] };
    },
  });
  ctx.logCommand("/home");
}

// ===================================================================
// /demo
// ===================================================================

export async function handleDemo(ctx: ReplContext): Promise<void> {
  const demoUrl = process.env.BASE_URL || "http://localhost:3000";
  ctx.state.goalContext = { baseGoal: "check my water bill", activeIntent: "", breadcrumb: [] };
  render.progress("checking if CityServe is running...");
  const serverReady = await ctx.ensureCityServe();
  if (!serverReady) {
    render.progressDone();
    render.error("could not start CityServe — try running `npm run cityserve` in another terminal");
    return;
  }
  render.progressDone();
  render.status(`starting CityServe demo at ${demoUrl}...`);
  await ctx.navigateAndProcess(demoUrl, "goto");
  ctx.logCommand("/demo");
}
