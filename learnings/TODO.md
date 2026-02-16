# TODO — Clawmium

> Updated: 2026-02-16 (split /url → /url + /stack)

## High

1. ~~Commit Phase 5 changes~~ — done (`ee22326`)
2. ~~Wire form detection into REPL~~ — done (`ff96989`). Includes textarea support for Google, tautological label fix, navigator error handling, and 25 new test assertions.
3. ~~**Crawl tree — Phase 1 (data structures + persistence)**~~ — done. `CrawlNode`, `Crawl`, `CrawlManager` in `src/crawl/`. Tree operations: create, find (dedup via nodeIndex), attach, detach, ancestors, display. Markdown persistence to `~/clm/crawls/`. All 113 tests passing.
4. ~~**Crawl tree — Phase 2 (REPL hooks + /tree + /clear)**~~ — done. Hooked `addNavigation()` into all 10 REPL navigation paths via `pendingReachedBy` + `trackNavigation()`. Added `/tree` display command, `/clear` command with scopes (repl, crawl, browser, all) and auto-save.
5. ~~**Split `/url` into `/url` + `/stack`**~~ — done (`e3b1fe4`). `/url` now prints just the current URL (one line). Old debug view (browser URL, sync status, back/forward stacks) moved to `/stack`.
6. **`/auto` mode spike** — wire up `planAction()` behind `/auto <goal>`. Loop: `interpret -> planAction -> execute`, human interrupts with Ctrl+C or agent hands off auth. Test on CityServe demo first. Autonomous navigation should build crawl nodes as it goes.
7. **MCP server — design + prototype** — Clawmium is agent-first; agents need a programmatic interface. Design which tools to expose (browse, extract, click, fill, screenshot, tree context?). Build a minimal MCP server.

## Medium

8. **Crawl tree — Phase 3 (LLM integration)** — Lifecycle LLM call: "extend current crawl or start new one?" LLM-driven naming. Feed crawl ancestor context into `interpret()` calls. GoalContext breadcrumb derived from tree when crawl is active.
9. **Site quirks registry** — formalize the `sites/hn.ts` pattern. Generic HTML-standard core + site-specific overrides activated on demand (like browser extensions).
10. **`max_tokens` tuning** — 1024 truncates long HN discussions and article summaries. Scale with input length or page type.
11. **Anthropic provider parity** — test with `conversationContext`, HN pages, form-heavy sites. Fix when it naturally comes up.

## Low / Parked

12. **Crawl tree — Phase 4 (polish)** — `/crawl` commands (rename, end, list, load). Display refinements. Session log integration into crawl.md.
13. **Crawl tree — Layer 3 (LLM reorganization)** — drift pruning, sub-tree detach/reattach, convergence detection. Future.
14. **Session persistence (REPL state)** — save/restore REPL state across runs. Separate from crawl persistence (which is built into the crawl system). Lower priority now that crawls handle their own persistence.
