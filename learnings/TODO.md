# TODO — Clawmium

> Updated: 2026-02-17 (Strategic shift — infrastructure solid, focus on LLM intelligence)

## High

1. ~~Commit Phase 5 changes~~ — done (`ee22326`)
2. ~~Wire form detection into REPL~~ — done (`ff96989`). Includes textarea support for Google, tautological label fix, navigator error handling, and 25 new test assertions.
3. ~~**Crawl tree — Phase 1 (data structures + persistence)**~~ — done. `CrawlNode`, `Crawl`, `CrawlManager` in `src/crawl/`. Tree operations: create, find (dedup via nodeIndex), attach, detach, ancestors, display. Markdown persistence to `~/clm/crawls/`. All 113 tests passing.
4. ~~**Crawl tree — Phase 2 (REPL hooks + /tree + /clear)**~~ — done. Hooked `addNavigation()` into all 10 REPL navigation paths via `pendingReachedBy` + `trackNavigation()`. Added `/tree` display command, `/clear` command with scopes (repl, crawl, browser, all) and auto-save.
5. ~~**Split `/url` into `/url` + `/stack`**~~ — done (`e3b1fe4`). `/url` now prints just the current URL (one line). Old debug view (browser URL, sync status, back/forward stacks) moved to `/stack`.
6. **`/auto` mode spike** — wire up `planAction()` behind `/auto <goal>`. Loop: `interpret -> planAction -> execute`, human interrupts with Ctrl+C or agent hands off auth. Test on CityServe demo first. Autonomous navigation should build crawl nodes as it goes.
7. **MCP server — design + prototype** — Clawmium is agent-first; agents need a programmatic interface. Design which tools to expose (browse, extract, click, fill, screenshot, tree context?). Build a minimal MCP server.

## Medium

8. ~~**Crawl tree — Phase 3 (LLM integration)**~~ — done. LLM-driven naming via `deriveCrawlName()`. Feed crawl ancestor context into `interpret()` calls via `formatAncestorContext()`. GoalContext breadcrumb derived from tree when crawl is active. All 48 crawl-llm tests passing.
9. **Site quirks registry** — formalize the `sites/hn.ts` pattern. Generic HTML-standard core + site-specific overrides activated on demand (like browser extensions).
10. ~~**`max_tokens` tuning**~~ — done. Configurable via `MAX_TOKENS_INTERPRET` / `MAX_TOKENS_PLAN` / `MAX_TOKENS_EXTRACT` env vars. Default interpret raised from 1024→2048. Both providers use shared `tokenLimit()` helper. Prompt updated: content pages get 3-6 sentence summaries, navigation 1-3 sentences.
11. **Anthropic provider parity** — test with `conversationContext`, HN pages, form-heavy sites. Fix when it naturally comes up.

## Next Up — LLM Intelligence Focus

> Strategic checkpoint (2026-02-17): Infrastructure layer is solid. Shifting focus to LLM intelligence — richer interpret output, /auto mode, content extraction for hostile sites.

15. ~~**Crawl stash — preserve history across domains**~~ — done. Cross-domain `/goto` stashes active crawl. `/back` at crawl start pops stash. `/history` shows unified timeline. `SessionEnvelope` v3 persists stash. 86 stash eval assertions.
16. **Persistent crawl artifacts — folder structure + LLM curation** — Evolve crawl persistence from flat `.md` files to named folders: `~/clm/crawls/{crawl-name}/README.md` (LLM-generated front page with summary, TODOs, directory) + per-page `.md` files. At persist time, LLM judges stashed crawls: **prune** (dead-end, no content → discard), **preserve** (standalone topic → own folder), **merge** (related crawls → combined folder, rewritten README). Session layer (stash) remains ephemeral; this is the durable knowledge layer.
17. **Richer `interpret()` prompts** — Tune per page type: news articles extract claims/sources, HN threads surface consensus vs debate, documentation extracts key APIs. Current summaries are adequate but generic.
18. **Content extraction for hostile sites** — Anti-bot sites return empty. Strategies: readability-style extraction, screenshot + vision model fallback.

## Low / Parked

12. ~~**Crawl tree — Phase 4 (polish)**~~ — done. `/crawl` command with subcommands (list, load, rename, end, info). `peekCrawl()` for fast header-only reads. Enriched `/tree` display with summaries, ANSI colors, and reachedBy icons. Session log section in saved crawl markdown.
13. **Crawl tree — Layer 3 (LLM reorganization)** — drift pruning, sub-tree detach/reattach, convergence detection. Future.
14. ~~**Session persistence (REPL state)**~~ — done. `SessionEnvelope` JSON sidecar, auto-resume on startup, periodic auto-save (60s), 118 assertions.
