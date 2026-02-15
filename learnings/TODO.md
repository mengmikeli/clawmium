# TODO — Clawmium

> Updated: 2026-02-15 (after Phase 5 session)

1. **[high]** Commit Phase 5 changes — HN comments, forms, goals, reflection ritual, tests (all uncommitted)
2. **[high]** Anthropic provider testing — third session deferred; test with `conversationContext`, HN pages, form-heavy sites
3. **[high]** Real-site HN testing — run `clm browse news.ycombinator.com`, navigate to item pages, verify comment extraction + LLM summary quality
4. **[medium]** `max_tokens` tuning — 1024 may truncate long HN discussions and article summaries; consider scaling with input length
5. **[medium]** Form detection integration — `detectInteractiveForms()` is built but not yet called from REPL; wire it into `_processCurrentPage()` to auto-detect and append fill choices
6. **[medium]** Real-site form testing — test search on npmjs.com, Google, GitHub to verify `fillPlan` selectors work in practice
7. **[low]** Trail-based navigation tree — replace linear page stack with branching tree; LLM interpretations annotate nodes (see MEMORY.md "Future Exploration")
8. **[low]** Session persistence — save/restore state across runs (currently lost on exit)
