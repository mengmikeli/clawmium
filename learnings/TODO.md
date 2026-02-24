# TODO — Clawmium

> Updated: 2026-02-24 (landscape alignment — agentic web infrastructure stack)

## High Priority

1. **A11y tree extraction** — Add Playwright `ariaSnapshot()` as parallel extraction alongside DOM text. DOM for content understanding, a11y tree for element targeting. Choices reference `@ref` identifiers instead of CSS selectors. Highest-impact extraction improvement. See `learnings/2026-02-24-0.md` Decision 1.

2. **`Accept: text/markdown` header** — Add to Playwright requests. Cloudflare sites return clean markdown directly — skip DOM extraction when available. ~20 lines of code, large quality improvement. Content pipeline: markdown-first → DOM text → network JSON fallback. See Decision 4.

3. **Auth persistence architecture** — Dedicated design session for `storageState()` save/load per hostname. Questions: profile scoping (hostname vs origin), interaction with session resume, cookie expiry, security model, `/show`/`/hide` integration. Direction confirmed, details need review. See Decision 3.

## Medium Priority

4. **MCP server design** — Crawl artifacts as filesystem interface (tree/graph of markdown files), not a JSON API. External agents read curated markdown, not raw page content. Dedicated design session before implementation. See Decision 2.

5. **Persistent crawl artifacts** — Evolve flat `.md` to named folders: `~/clm/crawls/{crawl-name}/README.md` + per-page `.md` files. LLM judges at persist time: prune/preserve/merge. Prerequisite for MCP vision (artifacts ARE the interface).

6. **REPL refactor Phase 3** — Extract choice execution (~80 lines) and free-text follow-up (~50 lines) from `handleInput()`. Would reduce it to pure dispatch. Self-contained, no dependencies.

7. **Anthropic provider parity** — Test with conversationContext, HN pages, form-heavy sites. Fix when it naturally comes up.

## Low Priority

8. **Site skill files** — Reframe `sites/hn.ts` from hardcoded code to declarative domain skill files (like `.claude/skills/SKILL.md`). LLM reads skill file and adapts extraction. Scope depends on a11y tree adoption. See Decision 6.

9. **Richer `interpret()` prompts** — Per page type: news extracts claims/sources, HN surfaces consensus/debate, docs extract key APIs. May be superseded by site skill files.

10. **Content extraction for hostile sites** — Anti-bot sites return empty. Strategies: readability-style extraction, screenshot + vision model fallback.

11. **Crawl Layer 3 (LLM reorganization)** — Drift pruning, sub-tree detach/reattach, convergence detection. Future.

12. **REPL refactor Phases 4-5** — Session/crawl coordination boundary, prompt lifecycle normalization. Wait for feature pressure.

## Completed

- ~~Phase 5 changes~~ (HN, forms, goals)
- ~~Wire form detection into REPL~~ (textarea, navigator errors)
- ~~Crawl tree Phases 1-4~~ (data structures, REPL hooks, LLM integration, command layer)
- ~~Split `/url` into `/url` + `/stack`~~
- ~~`/auto` mode~~ (autonomous loop + configurable `--max-steps`)
- ~~REPL refactor Phases 0-2~~ (safety net tests, navigateAndProcess, command handlers)
- ~~`max_tokens` tuning~~ (configurable per method via env vars)
- ~~Session persistence~~ (SessionEnvelope v3, auto-resume, auto-save)
- ~~Crawl stash~~ (cross-domain history preservation)
