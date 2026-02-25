# Architecture Reference — Clawmium

> Detailed architectural documentation moved from CLAUDE.md to keep the main file concise.
> For operational rules and key invariants, see CLAUDE.md.

## State Management — Full Interfaces

Canonical source: `src/cli/handler-types.ts`

```typescript
interface GoalContext {
  baseGoal: string;      // "browsing HN", "check my water bill"
  activeIntent: string;  // "looking for AI articles"
  breadcrumb: string[];  // last 3 nav steps: ["HN front page", "AI article title"]
}

// Defined in src/cli/handler-types.ts — shared by repl.ts and all command handlers
interface SessionState {
  goalContext: GoalContext;                   // Replaces flat userGoal string
  currentUrl: string;                        // REPL's canonical position — source of truth
  currentInterpretation: PageInterpretation; // Current page's LLM output
  previousInterpretation: PageInterpretation; // For stale choice "did you mean?"
  lastExtracted: ExtractedData;              // Most recent data extraction
  lastPageTitle: string;                     // Page title (not summary)
  history: Array<{ role; content }>;         // Conversation context for LLM
  log: Array<{ role; content; timestamp }>;  // Full session log for saving
  site: string;                              // Current site name
  loginAvailable: boolean;                   // True when login page detected
  detectedForms: DetectedForm[];             // Interactive forms found on current page
  homeUrl: string;                           // Persisted home URL, saved/restored via saveConfig()
  pendingReachedBy: ReachedBy | null;        // Set before navigation, consumed by trackNavigation()
}
```

## Command Handler Architecture — Full ReplContext

```typescript
// src/cli/handler-types.ts
type CommandHandler = (args: string, ctx: ReplContext) => Promise<HandlerResult | void>;

interface ReplContext {
  state: SessionState;           // Mutable session state
  engine: BrowserEngine;         // Browser lifecycle
  nav: PageNavigator;            // Navigation + content extraction
  interceptor: NetworkInterceptor;
  llm: LLMProvider;
  crawlManager: CrawlManager;
  rl: readline.Interface;
  render: typeof import('./renderer');
  // ... 22 bound methods (navigateAndProcess, restoreFromNode, stashCrawl, etc.)
}
```

**`navigateAndProcess()`**: Private method on `Repl` that owns the single navigation transaction — syncBrowser → truncateCursorForward → interceptor.clear → pendingReachedBy → preNavigate hook → nav.goto (try/catch) → currentUrl → settle → processCurrentPage. All navigation handlers call this instead of duplicating the sequence. Accepts an optional `preNavigate` callback for pre-navigation state changes (e.g., `/home` resets goalContext).

**`handleInput()` flow**: Slash commands → dispatch map lookup → handler function. Numbered input → choice execution (still inline). Free text → LLM follow-up (still inline). Handlers return `void` (normal) or `{ promptHandled: true }` (for `/quit` and `/login` which manage their own readline lifecycle).

## CrawlManager — Method-Level API

Source: `src/crawl/tree.ts`

**CrawlManager**:
- Auto-creates a new crawl on first navigation (no explicit "start crawl" step)
- Each node stores: URL, title, timestamp, `reachedBy` (choice/goto/back/forward/auto), parent ID, children
- Deduplicates by URL — navigating to an already-visited URL moves the cursor without creating a new node
- `getDisplayTree()` returns plain text tree for markdown persistence; `getEnrichedDisplayTree()` adds ANSI colors, current-node marker (`→`), reachedBy icons, and inline summaries
- **Cursor history**: `cursorHistory: CursorEntry[]` + `cursorIndex: number` — linear visit log with back/forward navigation. Methods: `appendCursor()`, `cursorBack()`, `cursorForward()`, `cursorJump()`, `truncateCursorForward()`, `resetCursor()`
- **Crawl stash**: `stash: StashedCrawl[]` — stack of previous crawls preserved across domain changes. `pushStash()` moves active crawl onto stash (O(1), reference move). `popStash()` restores most recent. `clearActive()` clears active only (stash preserved). `clear()` clears everything including stash. `getFullCursorHistory()` returns combined `FullCursorEntry[]` across stash + active. `getNodeAcrossStash()` finds nodes in any crawl. Capped at 10 entries (oldest dropped).

**Node metadata**: After each `interpret()` call, `storeStateOnNode()` populates the current node's `metadata.summary`, `metadata.interpretation` (full `PageInterpretation`), `metadata.goalContext`, and `metadata.conversationSnippets`. Interpretation and goal context enable full state restoration on `/back`, `/forward`, `/history`, and session resume.

**Ancestor context** (`src/crawl/context.ts`): `formatAncestorContext()` builds a "Navigation path" string from the current node's ancestors (up to 3 levels). Fed into LLM interpret calls so the model knows where the user has been.

**Naming** (`src/crawl/namer.ts`): `deriveCrawlName()` auto-names crawls from the first page summary via a priority chain: user-set goal → first clause of LLM summary → hostname + date. No extra LLM call.

**Persistence** (`src/crawl/persistence.ts`): Crawls saved as markdown at `~/clm/crawls/{id}.md`. Format has three sections: `## Tree` (ASCII tree), `## Nodes` (one `### heading` per node with URL/timestamp/summary), `## Session Log` (timestamped log entries filtered to crawl's time range). `peekCrawl()` reads header-only for listing without full parse. `loadCrawl()` tries `.session.json` first (full restore with interpretations, cursor, goal context), falls back to `.md` (tree-only).

**Session persistence** (`src/session/persistence.ts`): `SessionEnvelope` (v3) captures the full session state as JSON. Saved as `{crawl-id}.session.json` alongside the markdown file. Contains serialized crawl tree (with interpretations and goal context on each node), cursor history, stash (array of serialized crawls), REPL state (URL, site, goal, conversation history), and session log. `findLastSession()` scans for the most recent sidecar within a configurable age window. Backward-compatible with v2 envelopes (backfills empty stash).

## Terminal Output Style — Full Reference

### Icons and Symbols

```
⋯  overwriting progress line (dim gray, single-line, \r-based)
→  status/progress messages (dim gray)
✓  completed actions (green)
⚠  warnings (yellow)
✗  errors (red)
```

### Layout Examples

```
  [1] Choice one              (cyan number, white text)
  [2] Choice two

  tip: /show to open browser    (dim hints, context-aware, max 3)

  Bold Title                         (navigation page: navSummary)
  White summary text, word-wrapped   (no border, 72-char wrap)
  hostname.com                       (dim hostname)

  Bold Title                         (content page: contentBox)
  ┌──────────────────────────────────────┐
  │ Content box for article text         │    (word-wrapped, white on bordered box)
  └──────────────────────────────────────┘

  ┌──────────────────────────────────────┐
  │ Key:    Value                        │    (data table, bold keys)
  └──────────────────────────────────────┘

>  user input prompt (cyan)
```

### Rendering Behaviors

**Progress line behavior**: During page load, intermediate steps (loading, extracting, analyzing) are shown as a single overwriting `⋯` line via `render.progress()`. When the LLM returns, `render.progressDone()` clears the line before rendering content.

**Navigation vs content rendering**: Content pages get a bordered `contentBox()`. Navigation pages (listings, homepages) get `navSummary()` — bold title, word-wrapped white summary, dim hostname.

**Context-aware hints**: `suggestCommands()` checks cursor position (no `/back` at start), `loginAvailable`, `detectedForms`, and `lastExtracted` before suggesting commands. Capped at 3 hints.

## Design History

The original design spec (pre-implementation) is preserved at `learnings/2026-02-13-0.md`. Key changes from spec to implementation:

- **CLI auth** replaced browser-popup auth handoff — credentials entered in terminal, browser never shown
- **Real website support** added — was originally "mock only"
- **Content-first prompts** — original prompts were navigation-biased, producing link directories instead of content summaries
- **No external CLI deps** — `chalk`, `ora`, `@inquirer/prompts` replaced with raw ANSI codes + readline
- **Headless-first with cookie transfer** — Option A (offscreen window) replaced with true headless + relaunch-with-cookies for show/hide
- **Fallback chains everywhere** — `networkidle` timeout, crash recovery, scroll-to-load, sparse content detection
- **REPL stack refactor (2026-02-14)** — `state.currentUrl` replaces `page.url()` as source of truth. `syncBrowser()` replaces `ensureBrowser()`/`isAlive()`. `/back` and `/forward` are pure stack mutations. Added `/home`, `/refresh`, `/forward`, `/url` commands. See `learnings/2026-02-14-0.md`.
- **`commands.ts` removed** — command handling was inline in `repl.ts` until Phase 2 of the REPL refactor extracted it to `src/cli/handlers/`
- **Phase 5: HN, forms, goals (2026-02-15)** — HN comment thread extraction + rendering, interactive form detection (search/filter with `fillPlan`), `GoalContext` replaces flat `userGoal` string (baseGoal + activeIntent + breadcrumb trail). New files: `src/sites/hn.ts`, `src/forms/detector.ts`, `src/cli/goals.ts`. See `learnings/2026-02-15-0.md`.
- **Daily reflection ritual (2026-02-15)** — `/reflect` end-of-day and `/standup` start-of-day workflows via Claude Code skill. Persistent TODO at `learnings/TODO.md`.
- **Architecture alignment (2026-02-16)** — Eight design decisions: layered audience, intelligence inside, `/auto` spike, generic-core site extractors, CLI+MCP interfaces, LLM agnosticism. See `learnings/2026-02-16-0.md` and `2026-02-16-1.md`.
- **Form detection wiring + textarea fix (2026-02-16)** — `detectInteractiveForms()` wired into REPL, `appendSystemChoices()` dedup, `<textarea>` support for Google search, navigator error surfacing (`net::`/HTTP status). See `learnings/2026-02-16-2.md`.
- **`/url` split (2026-02-16)** — `/url` simplified to print just the current URL. Old debug view (browser URL, sync status, back/forward stacks) moved to new `/stack` command.
- **`CLAUD.md` renamed to `CLAUDE.md` (2026-02-16)** — The original filename was a typo carried since day one.
- **Crawl system (2026-02-16)** — Four-phase implementation: Phase 1 (tree data structure + markdown persistence), Phase 2 (REPL wiring across all 10 navigation paths), Phase 3 (LLM integration — auto-naming, ancestor context, tree-derived breadcrumbs), Phase 4 (command layer: `/crawl list|load|rename|end|info`, enriched `/tree` display, session log persistence). 4 new files in `src/crawl/`, 3 test suites, 192 total assertions. See `learnings/2026-02-16-3.md`.
- **`/history` command + `/stack` polish (2026-02-16)** — Flat `VisitEntry[]` on SessionState records every page transition (no dedup). `/history` displays chronological list enriched with crawl tree summaries and reachedBy icons. `/history N` jumps to an entry. `/stack` upgraded to polished ANSI display. `ReachedBy` extended with `"history"` + `⏎` icon. Capped at 200 entries.
- **Session persistence — crawl node as source of truth (2026-02-16)** — Six-phase refactor: (1) Enriched `CrawlNode.metadata` with `interpretation` and `goalContext`. (2) Added `cursorHistory[]` + `cursorIndex` to CrawlManager, replacing `pageStack`/`forwardStack`/`visitHistory` on SessionState. (3) Rewrote `/back`, `/forward`, `/history`, `/stack` to use cursor; `restoreFromNode()` replaces `restoreSnapshot()`. (4) New `src/session/persistence.ts` — `SessionEnvelope` JSON sidecar. (5) Auto-resume on startup. (6) Periodic auto-save (60s). See `learnings/2026-02-17-0.md`.
- **Main view polish + configurable max_tokens (2026-02-17)** — Single overwriting `render.progress()` line replaces noisy status cascade. Navigation pages use `render.navSummary()`. `max_tokens` configurable via env vars. `suggestCommands()` context-aware.
- **Crawl stash — cross-domain navigation history (2026-02-17)** — Cross-domain `/goto` stashes active crawl instead of destroying it. `/back` at start of new crawl pops stash. `/history` shows unified history across stash + active. `SessionEnvelope` v3 with stash serialization.
- **`/auto` mode — autonomous browsing (2026-02-17)** — `/auto <goal>` drives browser autonomously: interpret → `planAutoAction()` → `executeChoice()` → loop. Terminal conditions: data found, step limit, loop detection, consecutive errors, Ctrl+C, `ask_human`. See `learnings/2026-02-17-5.md`.
- **REPL refactor Phases 0–2 (2026-02-18)** — `repl.ts` 2134→1596 lines. Phase 0: test suite (53 assertions). Phase 1: `navigateAndProcess()` extraction. Phase 2: command handler extraction to 3 handler files. See `learnings/2026-02-18-0.md`.
- **`/auto` configurable step limit (2026-02-18)** — `--max-steps N` / `-s N` CLI flag + `AUTO_MAX_STEPS` env var. See `learnings/2026-02-18-2.md`.
- **A11y tree extraction (2026-02-24)** — `extractAriaSnapshot()` via Playwright `_snapshotForAI()`. YAML a11y tree with `[ref=...]` identifiers. `executeChoice()` tries `aria-ref=` locator first. New test suite: `__test__aria.ts` (29 assertions).
- **Debug mode (2026-02-24)** — `/debug` toggle + `DEBUG=1` env var. Labels: `[dbg:page]`, `[dbg:a11y]`, `[dbg:llm]`, `[dbg:exec]`, `[dbg:sync]`, `[dbg:auto]`.
