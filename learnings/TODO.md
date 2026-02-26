# TODO — Clawmium

> Updated: 2026-02-25 (markdown-first content pipeline shipped)

## High Priority

1. **Auth persistence architecture** — Dedicated design session for `storageState()` save/load per hostname. Questions: profile scoping (hostname vs origin), interaction with session resume, cookie expiry, security model, `/show`/`/hide` integration. Direction confirmed, details need review.

## Medium Priority

2. **MCP server design** — Crawl artifacts as filesystem interface (tree/graph of markdown files), not a JSON API. External agents read curated markdown, not raw page content. Dedicated design session before implementation.

3. **Persistent crawl artifacts** — Evolve flat `.md` to named folders: `~/clm/crawls/{crawl-name}/README.md` + per-page `.md` files. LLM judges at persist time: prune/preserve/merge. Prerequisite for MCP vision (artifacts ARE the interface).

4. **REPL refactor Phase 3** — Extract choice execution (~80 lines) and free-text follow-up (~50 lines) from `handleInput()`. Would reduce it to pure dispatch. Self-contained, no dependencies.

5. **Anthropic provider parity** — Test with conversationContext, HN pages, form-heavy sites. Fix when it naturally comes up.

## Low Priority

6. **Site skill files** — Reframe `sites/hn.ts` from hardcoded code to declarative domain skill files (like `.claude/skills/SKILL.md`). LLM reads skill file and adapts extraction.

7. **Richer `interpret()` prompts** — Per page type: news extracts claims/sources, HN surfaces consensus/debate, docs extract key APIs. May be superseded by site skill files.

8. **Content extraction for hostile sites** — Anti-bot sites return empty. Strategies: readability-style extraction, screenshot + vision model fallback.

9. **Crawl Layer 3 (LLM reorganization)** — Drift pruning, sub-tree detach/reattach, convergence detection. Future.

10. **REPL refactor Phases 4-5** — Session/crawl coordination boundary, prompt lifecycle normalization. Wait for feature pressure.

## Completed

- ~~A11y tree extraction~~ (`extractAriaSnapshot()`, ref-based choices, `aria-ref=` locator fallback)
- ~~`Accept: text/markdown` header~~ (markdown-first content pipeline, `context.route()` override, live integration test)
- ~~Phase 5 changes~~ (HN, forms, goals)
- ~~Wire form detection into REPL~~ (textarea, navigator errors)
- ~~Crawl tree Phases 1-4~~ (data structures, REPL hooks, LLM integration, command layer)
- ~~Split `/url` into `/url` + `/stack`~~
- ~~`/auto` mode~~ (autonomous loop + configurable `--max-steps`)
- ~~REPL refactor Phases 0-2~~ (safety net tests, navigateAndProcess, command handlers)
- ~~`max_tokens` tuning~~ (configurable per method via env vars)
- ~~Session persistence~~ (SessionEnvelope v3, auto-resume, auto-save)
- ~~Crawl stash~~ (cross-domain history preservation)
