import { ReplContext } from "../handler-types";
import * as render from "../renderer";
import { FullCursorEntry } from "../../crawl/tree";
import { listCrawls, peekCrawl, loadCrawl, saveCrawl } from "../../crawl/persistence";

// ANSI color helpers
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";

// ===================================================================
// /tree
// ===================================================================

export async function handleTree(ctx: ReplContext): Promise<void> {
  const tree = ctx.crawlManager.getEnrichedDisplayTree();
  if (!tree) {
    render.status("no crawl tree yet — navigate to start recording");
  } else {
    console.log();
    console.log(tree);
    console.log();
  }
  ctx.logCommand("/tree");
}

// ===================================================================
// /stack
// ===================================================================

export async function handleStack(ctx: ReplContext): Promise<void> {
  let browserUrl = "(unknown)";
  try { browserUrl = ctx.engine.getPage().url(); } catch { /* dead page */ }
  const synced = browserUrl === ctx.state.currentUrl;

  const cursor = ctx.crawlManager.getCursorHistory();
  const cidx = ctx.crawlManager.cursorIndex;
  const backEntries: render.StackEntry[] = [];
  const fwdEntries: render.StackEntry[] = [];
  for (let i = 0; i < cidx; i++) {
    const node = ctx.crawlManager.getNode(cursor[i].nodeId);
    if (node) backEntries.push({ url: node.url, title: node.title });
  }
  for (let i = cidx + 1; i < cursor.length; i++) {
    const node = ctx.crawlManager.getNode(cursor[i].nodeId);
    if (node) fwdEntries.push({ url: node.url, title: node.title });
  }

  render.stackView(
    { url: ctx.state.currentUrl, title: ctx.state.lastPageTitle },
    browserUrl,
    synced,
    backEntries,
    fwdEntries,
  );
  if (ctx.crawlManager.hasStash()) {
    const stashNames = ctx.crawlManager.stash.map(s => s.activeCrawl.name);
    render.stashIndicator(ctx.crawlManager.getStashDepth(), stashNames);
  }
  ctx.logCommand("/stack");
}

// ===================================================================
// /history
// ===================================================================

export async function handleHistory(ctx: ReplContext, arg: string): Promise<void> {
  if (arg) {
    const n = parseInt(arg, 10);
    if (isNaN(n)) {
      render.error("usage: /history [N]");
      return;
    }
    await ctx.jumpToHistory(n);
    ctx.logCommand(`/history ${n}`);
    return;
  }
  const fullCursor = ctx.crawlManager.getFullCursorHistory();
  if (fullCursor.length === 0) {
    render.status("no visit history yet — navigate to start recording");
    return;
  }
  const stashEntryCount = fullCursor.length - ctx.crawlManager.cursorHistory.length;
  const activeCursorIdx = ctx.crawlManager.cursorIndex;
  const fullCurrentIdx = activeCursorIdx >= 0 ? stashEntryCount + activeCursorIdx : -1;

  const histEntries: render.HistoryEntry[] = fullCursor.map((entry, i) => {
    const node = ctx.crawlManager.getNodeAcrossStash(entry.nodeId);
    return {
      index: i + 1,
      title: node?.title || "(untitled)",
      url: node?.url || "",
      reachedBy: entry.reachedBy,
      timestamp: entry.timestamp,
      summary: node?.metadata?.summary,
      isCurrent: i === fullCurrentIdx,
      crawlName: (entry as FullCursorEntry).crawlName,
    };
  });
  render.historyList(histEntries);
  render.hint(["type /history N to jump to an entry"]);
  ctx.logCommand("/history");
}

// ===================================================================
// /crawl (with subcommands)
// ===================================================================

export async function handleCrawl(ctx: ReplContext, arg: string, parts: string[]): Promise<void> {
  const sub = parts[0]?.toLowerCase() || "";
  const subArg = parts.slice(1).join(" ");

  switch (sub) {
    case "list": {
      const ids = listCrawls();
      if (ids.length === 0) {
        render.status("no saved crawls");
        return;
      }
      const crawls: Array<{ index: number; name: string; rootUrl: string; nodeCount: number; created: number }> = [];
      for (const id of ids) {
        const peek = peekCrawl(id);
        if (peek) crawls.push({ index: 0, ...peek });
      }
      crawls.sort((a, b) => b.created - a.created);
      crawls.forEach((c, i) => { c.index = i + 1; });
      render.crawlList(crawls);
      ctx.logCommand("/crawl list");
      return;
    }

    case "load": {
      const ids = listCrawls();
      if (ids.length === 0) {
        render.status("no saved crawls to load");
        return;
      }
      const crawls: Array<{ index: number; id: string; name: string; rootUrl: string; nodeCount: number; created: number }> = [];
      for (const id of ids) {
        const peek = peekCrawl(id);
        if (peek) crawls.push({ index: 0, ...peek });
      }
      crawls.sort((a, b) => b.created - a.created);
      crawls.forEach((c, i) => { c.index = i + 1; });

      let pickNum = parseInt(subArg, 10);
      if (isNaN(pickNum)) {
        render.crawlList(crawls);
        const answer = await new Promise<string>((resolve) => {
          ctx.rl.question("  pick a crawl number: ", resolve);
        });
        pickNum = parseInt(answer.trim(), 10);
        if (isNaN(pickNum)) {
          render.status("cancelled");
          return;
        }
      }

      const picked = crawls.find((c) => c.index === pickNum);
      if (!picked) {
        render.error(`no crawl at index ${pickNum}`);
        return;
      }

      if (ctx.crawlManager.activeCrawl) {
        render.status("stashing active crawl...");
        ctx.stashCrawl();
      }

      const loaded = loadCrawl(picked.id, ctx.crawlManager);
      if (!loaded) {
        render.error("failed to load crawl");
        return;
      }

      const currentNode = ctx.crawlManager.currentNodeId
        ? ctx.crawlManager.getNode(ctx.crawlManager.currentNodeId)
        : null;
      if (currentNode) {
        ctx.state.currentUrl = currentNode.url;
        ctx.state.lastPageTitle = currentNode.title;
        if (currentNode.metadata?.interpretation) {
          ctx.setInterpretation(currentNode.metadata.interpretation);
        }
        if (currentNode.metadata?.goalContext) {
          ctx.state.goalContext = {
            ...currentNode.metadata.goalContext,
            breadcrumb: [...(currentNode.metadata.goalContext.breadcrumb || [])],
          };
        }
      }

      render.success(`loaded crawl: "${ctx.crawlManager.activeCrawl?.name || picked.name}"`);
      ctx.logCommand(`/crawl load ${pickNum}`);
      return;
    }

    case "rename": {
      if (!ctx.crawlManager.activeCrawl) {
        render.warn("no active crawl");
        return;
      }
      if (!subArg) {
        render.error("usage: /crawl rename <name>");
        return;
      }
      ctx.crawlManager.activeCrawl.name = subArg;
      render.success(`crawl renamed to: "${subArg}"`);
      ctx.logCommand(`/crawl rename ${subArg}`);
      return;
    }

    case "end": {
      if (!ctx.crawlManager.activeCrawl) {
        render.warn("no active crawl to end");
        return;
      }
      try {
        const filepath = saveCrawl(ctx.crawlManager, ctx.state.log);
        ctx.saveSessionSidecar();
        ctx.crawlManager.clearActive();
        render.success(`crawl saved to: ${filepath}`);
      } catch (err) {
        render.error(`failed to save crawl: ${(err as Error).message}`);
      }
      ctx.logCommand("/crawl end");
      return;
    }

    case "info": {
      if (!ctx.crawlManager.activeCrawl) {
        render.warn("no active crawl");
        return;
      }
      const crawl = ctx.crawlManager.activeCrawl;
      const rootNode = ctx.crawlManager.nodes.get(crawl.rootId);
      const currentNode = ctx.crawlManager.currentNodeId
        ? ctx.crawlManager.getNode(ctx.crawlManager.currentNodeId)
        : null;
      render.crawlInfo(
        crawl.name,
        crawl.created,
        ctx.crawlManager.nodes.size,
        rootNode?.url || "(unknown)",
        currentNode?.title || "(unknown)",
      );
      ctx.logCommand("/crawl info");
      return;
    }

    default: {
      console.log();
      console.log(`  ${BOLD}Crawl subcommands:${RESET}`);
      console.log(`  ${CYAN}/crawl list${RESET}           List saved crawls`);
      console.log(`  ${CYAN}/crawl load [N]${RESET}       Load a saved crawl by number`);
      console.log(`  ${CYAN}/crawl rename <name>${RESET}  Rename the active crawl`);
      console.log(`  ${CYAN}/crawl end${RESET}            Save and end the active crawl`);
      console.log(`  ${CYAN}/crawl info${RESET}           Show active crawl metadata`);
      console.log();
      return;
    }
  }
}
