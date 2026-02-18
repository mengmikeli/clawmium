# CLAUDE.md — Clawmium (clm)

> The web is a text adventure and your agent has the walkthrough.

## What is Clawmium?

Clawmium is an agent-first, human-second browser. It decomposes the traditional browser into its essential parts — identity vault, network stream, renderer (on-demand), and agent runtime — controlled through a CLI. The human interacts via a terminal, the agent drives a headless Chromium instance, and rendering is only invoked when the human needs to see something.

**Core thesis: browsers should be built for agents first, and render pixels only when you ask.**

Works on real websites (Hacker News, blogs, news sites) and includes a CityServe mock government site for demo purposes.

## Tech Stack

- **Language:** TypeScript (Node.js), run via `tsx`
- **Browser Engine:** Playwright (controlling Chromium, headless by default)
- **CLI:** Node `readline` for REPL, raw `process.stdin` for auth input. No external CLI frameworks — all terminal output uses raw ANSI escape codes.
- **Mock Website:** Express + vanilla HTML/CSS/JS (Tailwind via CDN). SPA that makes `fetch()` calls to Express API endpoints — enables network interception.
- **LLM Integration:** User provides their own API key. Two providers:
  - **OpenAI** (via `openai` SDK) — primary, stress-tested on real sites
  - **Anthropic Claude** (via `@anthropic-ai/sdk`) — functional, less tested
- **Config:** `.env` file for API keys, provider selection, and LLM token limits

## Project Structure

```
clawmium/
├── CLAUDE.md                # This file — project spec + architecture
├── package.json
├── .env.example             # API key template + LLM token limits
├── .gitignore
├── tsconfig.json
│
├── src/                     # CLM agent + CLI
│   ├── index.ts             # Entry point — CLI arg parsing, provider setup, default URL
│   ├── browser/
│   │   ├── engine.ts        # BrowserEngine — launch/show/hide (cookie transfer), isAlive/recover
│   │   ├── navigator.ts     # PageNavigator — goto (timeout fallback), extractContent, goBack
│   │   ├── network.ts       # NetworkInterceptor — same-origin JSON capture, findRichContent
│   │   ├── __test__.ts      # Manual browser integration test
│   │   └── __test__recover.ts # Automated recovery + detection tests (14 tests, no deps)
│   ├── llm/
│   │   ├── provider.ts      # Interfaces: LLMProvider, PageInterpretation, AgentAction, ExtractedData
│   │   ├── openai.ts        # OpenAI provider (configurable token limits)
│   │   ├── anthropic.ts     # Anthropic provider (configurable token limits)
│   │   ├── prompts.ts       # System prompts (interpret, plan, extract) — content-first, page-type-aware summaries
│   │   └── __test__.ts      # LLM integration test
│   ├── auth/
│   │   ├── detector.ts      # Login page detection (weighted heuristics, threshold 0.5)
│   │   └── handoff.ts       # CLI auth — raw stdin, password masked, retry loop (3 attempts)
│   ├── sites/
│   │   └── hn.ts            # HN domain detection, comment extraction, LLM formatting
│   ├── forms/
│   │   └── detector.ts      # Interactive form detection (search, filter)
│   ├── crawl/
│   │   ├── tree.ts          # CrawlManager — node tree, cursor history, navigation tracking, enriched display
│   │   ├── persistence.ts   # Save/load/list/peek crawls as markdown to ~/clm/crawls/ (JSON sidecar fallback)
│   │   ├── context.ts       # Ancestor chain formatting for LLM context, tree-derived breadcrumbs
│   │   └── namer.ts         # Derive crawl names from page summary + user goal
│   ├── session/
│   │   └── persistence.ts   # SessionEnvelope, saveSession/loadSession/findLastSession — JSON sidecar for full session resume
│   ├── cli/
│   │   ├── repl.ts          # REPL core — dispatch map, choice execution, free-text follow-up, navigateAndProcess()
│   │   ├── handler-types.ts # SessionState, ReplContext, CommandHandler, HandlerResult types
│   │   ├── handlers/
│   │   │   ├── navigation.ts # /show, /hide, /goto, /back, /forward, /refresh, /home, /demo (8 commands)
│   │   │   ├── session.ts   # /save, /quit, /url, /help, /login, /auto, /clear (7 commands)
│   │   │   └── crawl.ts     # /tree, /stack, /history, /crawl (4 commands with subcommands)
│   │   ├── renderer.ts      # ANSI terminal output (banner, contentBox, navSummary, progress, dataTable, commentThread, choices, status lines)
│   │   └── goals.ts         # Pure functions: formatGoal(), addBreadcrumb()
│   ├── output/
│   │   └── writer.ts        # Save data + session logs to ~/clm/{site}/
│   ├── auto/
│   │   ├── executor.ts      # executeChoice() — shared choice execution for human + auto paths
│   │   └── runner.ts        # runAuto() — autonomous browsing loop with step/loop/error limits
│   ├── __test__auto.ts          # Auto mode unit tests (63 assertions)
│   ├── __test__auto_e2e.ts      # Auto mode E2E test (CityServe + real LLM, not counted in unit total)
│   ├── __test__crawl.ts         # Crawl tree + persistence + stash (152 assertions)
│   ├── __test__crawl_llm.ts     # Crawl LLM integration (48 assertions)
│   ├── __test__crawl_phase4.ts  # Crawl command layer + display (31 assertions)
│   ├── __test__repl.ts          # REPL command handler tests — mock factories, 43 assertions
│   ├── __test__session.ts       # Session persistence — cursor, metadata, stash, save/load (149 assertions)
│   └── __test__stash_eval.ts    # Stash eval — cross-domain stash correctness (86 assertions)
│
├── cityserve/               # Mock government website (CityServe)
│   ├── server.ts            # Express server
│   ├── public/              # HTML pages (index, login, dashboard, water-bill)
│   ├── api/                 # JSON API endpoints (auth, services, water-bill, account)
│   └── data/
│       └── fixtures.ts      # Mock data (user profile, water bill)
│
└── learnings/               # Session learnings + original design spec
    ├── 2026-02-13-0.md      # Original CLAUD.md (pre-implementation design spec)
    ├── 2026-02-13-1.md      # Learnings from first build session
    ├── 2026-02-14-0.md      # REPL stack refactor — who owns the current URL?
    ├── 2026-02-14-1.md      # Rewriting CLAUD.md from design spec to implementation reference
    ├── 2026-02-15-0.md      # Phase 5: HN comments, forms, goals, reflection ritual
    ├── 2026-02-16-0.md      # Architecture alignment — eight design decisions
    ├── 2026-02-16-1.md      # Crawls design review — GoalContext feedback loop
    ├── 2026-02-16-2.md      # Form detection wiring + navigator error handling
    ├── 2026-02-16-3.md      # Crawl Phase 4 — command layer, enriched display, session log persistence
    ├── 2026-02-17-0.md      # Session persistence + main view polish — trail representations compound
    ├── 2026-02-17-1.md      # Meta-learnings — five principles from the Feb 16-17 sprint
    ├── 2026-02-17-2.md      # Session, crawl, memory — three layers of browsing state
    ├── 2026-02-17-3.md      # Banner fix + strategic checkpoint — LLM intelligence focus
    ├── 2026-02-17-4.md      # REPL risk review + refactor plan (phase proposal)
    ├── 2026-02-17-5.md      # /auto mode spike — extraction boundary discovery
    ├── 2026-02-18-0.md      # REPL refactor Phases 0–2 — reflection + scorecard vs plan
    └── TODO.md              # Persistent todo list, updated daily via /reflect
```

## Architecture

### The Core Loop

```
Human (terminal)  →  CLM REPL  →  LLM (interpret page, extract data)
                         ↕
                    Playwright (headless Chromium)
                         ↕
                    Any website (HN, blogs, CityServe, etc.)
```

1. Human launches CLM — headless Chromium navigates to target URL
2. For each page:
   a. Network interceptor passively captures same-origin JSON responses
   b. DOM content extracted (title, visible text, links, forms)
   c. If sparse DOM content (<500 chars), try network JSON for article text, then scroll-to-load
   d. Page content sent to LLM with user's goal and conversation context
   e. LLM returns content-first interpretation: summary of what the page *says*, plus navigation choices
   f. CLI renders summary (content box for articles, navSummary for navigation pages) then numbered choices
3. Human selects choices, types free-text questions, or uses slash commands
4. Free-text input gets answered as a follow-up using previous summary as conversation context
5. Data automatically saved to `~/clm/{site}/` on extraction

### Content-First Philosophy

The LLM prompt prioritizes content over navigation. Page types:

| Type | Rendering | Choices |
|------|-----------|---------|
| `content` | Summary in ASCII content box (3-6 sentences) | Only links to other content (no navbar chrome) |
| `navigation` | Summary in navSummary block (bold title, 1-3 sentences, dim hostname) | Main content links as choices (max 10) |
| `login` | Auth prompt in CLI | N/A — triggers CLI auth flow |
| `data` | Structured data table | "Show rendered page", "Save and quit" |
| `form` | Form fields | N/A |

Key prompt rules:
- Content pages: 3-6 sentence summary with specifics (names, numbers, dates, key claims)
- Navigation pages: 1-3 sentence description of what the listing contains and what stands out
- Summary captures what the page *says*, not just its structure
- Empty/sparse pages get "content is empty" — no hallucination from URL alone
- Follow-up questions answered in context, not re-described
- Content pages exclude navbar chrome (Home, About, Archives) from choices

### Network Interception

Two-tier capture strategy:

1. **`/api/` routes** (same-origin only) — logged to terminal, used for structured data extraction
2. **All same-origin JSON** — captured silently for rich content extraction via `findRichContent()`

`findRichContent()` filters:
- Skips analytics/messaging/config URLs
- Skips blobs > 50KB
- Requires sentence-like text (periods, 30+ words)
- Recursively walks JSON prioritizing `body`, `content`, `text`, `article` fields

### Auth Handoff

Credentials entered in the CLI terminal — browser window never opens.

```
Agent detects login page (weighted heuristics, confidence ≥ 0.5)
  → REPL pauses readline, switches to raw stdin
  → Form fields detected from DOM, prompted one-by-one
  → Password input masked with * characters
  → Form submitted via Playwright, waits for URL to leave /login
  → On failure: retry up to 3 times
  → On success: resume REPL with authenticated session
```

The agent never sees credentials. It detects "login page" and "URL changed after submit."

### Browser Lifecycle

```
launch() → headless Chromium
show()   → close headless, relaunch headed, transfer cookies, navigate to same URL
hide()   → close headed, relaunch headless, transfer cookies
```

Navigation uses a fallback chain:
- `networkidle` (15s timeout) → `domcontentloaded` (15s) → continue with whatever loaded

**The REPL owns position, not the browser.** `state.currentUrl` is the single source of truth for "where we are." The browser is a servant that syncs on demand:

- `syncBrowser()` runs before any operation that needs the browser: checks alive → responsive → correct URL. Recovers or navigates as needed.
- `/back` and `/forward` are pure stack mutations — they update `state.currentUrl` and the page/forward stacks without touching the browser. `syncBrowser()` navigates to the correct URL on the next operation.
- `state.currentUrl` is set explicitly after every `nav.goto()` call. **Never** read from `page.url()` to set state — after `/show`, the old page object is dead but still returns its stale URL.
- `recoverBrowser()` encapsulates crash recovery (kill remnants, relaunch, reattach interceptor + navigator).

### State Management

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

**Cursor history** (replaces pageStack/forwardStack/visitHistory): The crawl tree now owns all navigation state. `CrawlManager.cursorHistory` is a linear `CursorEntry[]` log of node visits; `cursorIndex` tracks the current position for back/forward. `/back` decrements the index, `/forward` increments it, `/history N` jumps to an entry. New navigation truncates forward entries (same as browser behavior). Capped at 200 entries.

**Crawl stash**: When `/goto` navigates to an external domain, the active crawl is **stashed** (pushed onto `CrawlManager.stash: StashedCrawl[]`) instead of destroyed. `/back` at the start of a new crawl pops the stash. `/history` shows combined entries across stash + active crawl. Capped at 10 stashed crawls. `/clear crawl` clears everything including stash. `/crawl end` clears active only, preserves stash. Session persistence (`SessionEnvelope` v3) serializes the full stash for resume.

Key state behaviors:
- **REPL owns position**: `state.currentUrl` is set after every `nav.goto()`, never read from `page.url()`. All operations, `inferResource()`, `currentSite()`, and anchor detection use `currentUrl`.
- **Crawl node as source of truth**: `PageInterpretation` and `GoalContext` are stored on `CrawlNode.metadata` via `storeStateOnNode()`. `/back` and `/forward` restore from the node (no separate snapshot copies). URL-deduplicated nodes get their metadata overwritten on revisit — the node always has the *latest* interpretation.
- **Goal reset**: `/goto` to external URL stashes the current crawl and resets `GoalContext` — `baseGoal` becomes `"browsing {hostname}"`, `activeIntent` cleared, `breadcrumb` reset. Relative paths keep current goal context.
- **Previous interpretation**: When LLM produces new choices, old ones preserved. If user enters a number matching old choices, asks "did you mean [N] label? (y/n)"
- **Conversation context**: Free-text follow-ups pass `"Previous summary: ...\nUser asks: ..."` to the LLM so it answers the question rather than re-describing the page.
- **Form detection**: `detectInteractiveForms(page)` runs on each page load. Detected forms become fill choices via `appendSystemChoices()`, deduped by `inputSelector` against LLM-generated fill choices. Ordering: LLM choices → detected forms → login.
- **Home URL persistence**: `homeUrl` saved to disk via `saveConfig()` on `/home set`, restored on startup. Used as default start URL when no explicit URL is given.
- **Session persistence**: On shutdown and periodically (60s), a `.session.json` sidecar is written alongside the crawl markdown. Contains full `SessionEnvelope` v3: crawl tree with interpretations, cursor history, stash, REPL state, conversation history. On startup, if a recent session exists (< 7 days), user is prompted to resume. `--new` flag bypasses the prompt.
- **Auto-save**: `setInterval(autoSave, 60_000)` writes `.session.json` only (lightweight). Cleared on shutdown.

Guard flags:
- `shuttingDown` — prevents double shutdown (rl.close fires close event)
- `closingForAuth` — prevents shutdown when closing readline for auth handoff
- `muteInterceptor` — suppresses network logs during auth

### Crawl System

Every navigation is recorded as a node in a tree. The tree persists to markdown files at `~/clm/crawls/`, capturing the user's browsing path with LLM summaries.

**CrawlManager** (`src/crawl/tree.ts`):
- Auto-creates a new crawl on first navigation (no explicit "start crawl" step)
- Each node stores: URL, title, timestamp, `reachedBy` (choice/goto/back/forward/auto), parent ID, children
- Deduplicates by URL — navigating to an already-visited URL moves the cursor without creating a new node
- `getDisplayTree()` returns plain text tree for markdown persistence; `getEnrichedDisplayTree()` adds ANSI colors, current-node marker (`→`), reachedBy icons, and inline summaries
- **Cursor history**: `cursorHistory: CursorEntry[]` + `cursorIndex: number` — linear visit log with back/forward navigation. Replaces the old `pageStack`/`forwardStack`/`visitHistory` arrays on SessionState. Methods: `appendCursor()`, `cursorBack()`, `cursorForward()`, `cursorJump()`, `truncateCursorForward()`, `resetCursor()`
- **Crawl stash**: `stash: StashedCrawl[]` — stack of previous crawls preserved across domain changes. `pushStash()` moves active crawl onto stash (O(1), reference move). `popStash()` restores most recent. `clearActive()` clears active only (stash preserved). `clear()` clears everything including stash. `getFullCursorHistory()` returns combined `FullCursorEntry[]` across stash + active. `getNodeAcrossStash()` finds nodes in any crawl. Capped at 10 entries (oldest dropped).

**Node metadata**: After each `interpret()` call, `storeStateOnNode()` populates the current node's `metadata.summary`, `metadata.interpretation` (full `PageInterpretation`), `metadata.goalContext`, and `metadata.conversationSnippets`. Interpretation and goal context enable full state restoration on `/back`, `/forward`, `/history`, and session resume.

**Ancestor context** (`src/crawl/context.ts`): `formatAncestorContext()` builds a "Navigation path" string from the current node's ancestors (up to 3 levels). Fed into LLM interpret calls so the model knows where the user has been.

**Naming** (`src/crawl/namer.ts`): `deriveCrawlName()` auto-names crawls from the first page summary via a priority chain: user-set goal → first clause of LLM summary → hostname + date. No extra LLM call.

**Persistence** (`src/crawl/persistence.ts`): Crawls saved as markdown at `~/clm/crawls/{id}.md`. Format has three sections: `## Tree` (ASCII tree), `## Nodes` (one `### heading` per node with URL/timestamp/summary), `## Session Log` (timestamped log entries filtered to crawl's time range). `peekCrawl()` reads header-only for listing without full parse. `loadCrawl()` tries `.session.json` first (full restore with interpretations, cursor, goal context), falls back to `.md` (tree-only).

**Session persistence** (`src/session/persistence.ts`): `SessionEnvelope` (v3) captures the full session state as JSON. Saved as `{crawl-id}.session.json` alongside the markdown file. Contains serialized crawl tree (with interpretations and goal context on each node), cursor history, stash (array of serialized crawls), REPL state (URL, site, goal, conversation history), and session log. `findLastSession()` scans for the most recent sidecar within a configurable age window. Backward-compatible with v2 envelopes (backfills empty stash).

**`pendingReachedBy` pattern**: The REPL sets `state.pendingReachedBy` before navigation (e.g., "choice", "goto"). `trackNavigation()` consumes it after the page loads to record how the user reached the new page. This decouples navigation intent from navigation execution.

### Command Handler Architecture

Slash commands are dispatched through a `COMMAND_HANDLERS: Record<string, CommandHandler>` map in `repl.ts`. Each handler is a pure async function receiving a `ReplContext` dependency bag:

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

**Handler files** (`src/cli/handlers/`):
- `navigation.ts` — 8 commands: `/show`, `/hide`, `/goto`, `/back`, `/forward`, `/refresh`, `/home`, `/demo`
- `session.ts` — 7 commands: `/save`, `/quit`, `/url`, `/help`, `/login`, `/auto`, `/clear`
- `crawl.ts` — 4 commands with subcommands: `/tree`, `/stack`, `/history`, `/crawl`

**`navigateAndProcess()`**: Private method on `Repl` that owns the single navigation transaction — syncBrowser → truncateCursorForward → interceptor.clear → pendingReachedBy → preNavigate hook → nav.goto (try/catch) → currentUrl → settle → processCurrentPage. All navigation handlers call this instead of duplicating the sequence. Accepts an optional `preNavigate` callback for pre-navigation state changes (e.g., `/home` resets goalContext).

**`handleInput()` flow**: Slash commands → dispatch map lookup → handler function. Numbered input → choice execution (still inline). Free text → LLM follow-up (still inline). Handlers return `void` (normal) or `{ promptHandled: true }` (for `/quit` and `/login` which manage their own readline lifecycle).

### LLM Provider Interface

```typescript
interface LLMProvider {
  interpret(pageContent: string, userGoal: string, conversationContext?: string): Promise<PageInterpretation>;
  planAction(interpretation: PageInterpretation, context: ConversationContext): Promise<AgentAction>;
  planAutoAction(formattedContext: string): Promise<AutoPlanResult>;
  extractData(rawData: string, userGoal: string): Promise<ExtractedData>;
}
```

Configured via `.env`:
```
LLM_PROVIDER=openai  # or "anthropic"
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# LLM token limits (optional — defaults shown)
MAX_TOKENS_INTERPRET=2048
MAX_TOKENS_PLAN=512
MAX_TOKENS_EXTRACT=1024
```

Token limits are configurable per method via environment variables. Both providers read from `process.env` at call time via a shared `tokenLimit(envVar, fallback)` helper. The `interpret` default was raised from 1024 to 2048 to allow richer summaries; `plan` and `extract` keep their original defaults.

## CLI Commands

| Command | Action |
|---------|--------|
| `/show` | Relaunch browser headed (cookie transfer) |
| `/hide` | Relaunch browser headless |
| `/goto <url>` | Navigate to URL (bare domains auto-prefixed with `https://`) |
| `/back` | Restore previous page from stack (pure stack mutation, no browser access) |
| `/forward` | Restore next page from forward stack |
| `/home [url]` | Go to home URL, or set home URL if argument given |
| `/refresh` | Re-navigate to current URL and re-interpret |
| `/url` | Show current URL (one line, copy-pasteable) |
| `/stack` | Show navigation stack with titles, sync status, back/forward |
| `/history [N]` | Show visit history (with N: jump to entry N) |
| `/save` | Save extracted data + session log to disk |
| `/tree` | Show crawl navigation tree (enriched: summaries, icons, current marker) |
| `/crawl` | Manage crawls: list, load, rename, end, info |
| `/clear` | Reset state: repl, crawl, browser, or all (crawl auto-saves) |
| `/auto <goal>` | Autonomous browsing loop — interpret → plan → execute until goal met or limit hit |
| `/demo` | Run CityServe demo (localhost:3000, goal: "check my water bill") |
| `/quit` | Save and exit |
| `/help` | Show command list |
| Number (1, 2, 3...) | Select a numbered choice |
| Free text | Follow-up question answered with page context |
| Ctrl+C | Cancel current operation (double-press within 2s to quit) |

### Terminal Output Style

```
⋯  overwriting progress line (dim gray, single-line, \r-based)
→  status/progress messages (dim gray)
✓  completed actions (green)
⚠  warnings (yellow)
✗  errors (red)

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

**Progress line behavior**: During page load, intermediate steps (loading, extracting, analyzing) are shown as a single overwriting `⋯` line via `render.progress()`. When the LLM returns, `render.progressDone()` clears the line before rendering content. This replaces the old cascade of 3-4 stacked `render.status()` calls.

**Navigation vs content rendering**: Content pages get a bordered `contentBox()`. Navigation pages (listings, homepages) get `navSummary()` — bold title, word-wrapped white summary, dim hostname. Both are clearly visible; the old approach rendered navigation summaries as dim `render.status()` lines indistinguishable from progress messages.

**Context-aware hints**: `suggestCommands()` checks cursor position (no `/back` at start), `loginAvailable`, `detectedForms`, and `lastExtracted` before suggesting commands. Capped at 3 hints.

## Running

```bash
# Install
npm install
npx playwright install chromium

# Configure
cp .env.example .env
# Edit .env with your API key

# Run (defaults to Hacker News)
npm run clm

# Run with specific URL
npm run clm -- browse nytimes.com
npm run clm -- browse https://example.com/page

# Skip session resume prompt
npm run clm -- --new

# CityServe demo (separate terminal)
npm run cityserve          # Start mock site on :3000
npm run clm                # Then type /demo in the REPL

# Tests
npm run test:browser       # Browser integration (needs CityServe running)
npm run test:llm           # LLM provider test
npm run test:phase5        # Form detection, HN, goals, appendSystemChoices (91 assertions)
npm run test:recover       # Browser crash recovery (14 tests)
npm run test:crawl         # Crawl tree + persistence + stash (152 assertions)
npm run test:crawl-llm     # Crawl LLM integration (48 assertions)
npm run test:crawl-phase4  # Crawl command layer + display (31 assertions)
npm run test:session       # Session persistence — cursor, metadata, stash, save/load (149 assertions)
npm run test:stash-eval    # Stash eval — cross-domain stash correctness (86 assertions)
npm run test:auto          # Auto mode — runner, executor, plan parsing (63 assertions)
npm run test:repl          # REPL command handlers — mock factories, dispatch (43 assertions)
```

## File Output

Saved to `~/clm/{site}/{resource}-{date}.json`:

```
~/clm/
  config.json                  # homeUrl + lastSessionId
  crawls/
    {crawl-id}.md              # Saved crawl tree + session log (human-readable)
    {crawl-id}.session.json    # Full session state (machine-readable, for resume)
  hackernews/
    session-log-2026-02-13.md
  nytimes/
    us-politics-article-2026-02-13.json
    session-log-2026-02-13.md
  cityserve/
    water-bill-2026-02-13.json
    session-log-2026-02-13.md
```

Resource names derived from URL path (date segments stripped to avoid duplication).

## Resilience Patterns

Every async operation has a fallback chain:

| Component | Ideal | Fallback 1 | Fallback 2 |
|-----------|-------|------------|------------|
| Page load | `networkidle` (15s) | `domcontentloaded` (15s) | Continue with whatever loaded |
| Navigation errors | Network (`net::` / `NS_ERROR_`) → "could not reach" message | HTTP status ≥ 400 → "returned HTTP {status}" message | All nav paths use `navigateAndProcess()` which catches and displays |
| Content extraction | Intercepted network JSON | Scroll-to-load + re-extract DOM | Sparse content warning |
| Browser state | `syncBrowser()` 3-point check (alive? responsive? correct URL?) | `recoverBrowser()` — relaunch headless | Error message to user |
| Click navigation | `page.click(selector)` | Get `href` and `nav.goto()` | Detect anchor link, skip |
| Auth handoff | CLI credential entry | Retry up to 3 times | Cancel and return to prompt |
| LLM calls | 30s timeout + AbortController | CancelledError on Ctrl+C | Error message to user |

## Known Limitations

- Anti-bot sites (NYT, some news sites) may return empty content
- No stealth mode (no `playwright-extra` / puppeteer-stealth)
- HN comment threads rendered as content with `commentThread()` display — top 30 comments extracted, LLM summarizes discussion themes
- Anthropic provider less tested than OpenAI
- `max_tokens` defaults to 2048 for interpret (was 1024) — configurable via `MAX_TOKENS_INTERPRET` in `.env`
- No OAuth/SSO/2FA flows
- Google and other sites may trigger CAPTCHA in headless mode

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
- **`CLAUD.md` renamed to `CLAUDE.md` (2026-02-16)** — The original filename was a typo carried since day one. Earlier learnings files reference `CLAUD.md` — that was the correct name at the time; this is the same file.
- **Crawl system (2026-02-16)** — Four-phase implementation: Phase 1 (tree data structure + markdown persistence), Phase 2 (REPL wiring across all 10 navigation paths), Phase 3 (LLM integration — auto-naming, ancestor context, tree-derived breadcrumbs), Phase 4 (command layer: `/crawl list|load|rename|end|info`, enriched `/tree` display, session log persistence). 4 new files in `src/crawl/`, 3 test suites, 192 total assertions. See `learnings/2026-02-16-3.md`. Version bumped to 0.2.0.
- **`/history` command + `/stack` polish (2026-02-16)** — Flat `VisitEntry[]` on SessionState records every page transition (no dedup). `/history` displays chronological list enriched with crawl tree summaries and reachedBy icons. `/history N` jumps to an entry (pushes current to back stack, restores snapshot). `/stack` upgraded from raw `console.log` to polished ANSI display with titles, sync status, and structured back/forward stacks. `ReachedBy` extended with `"history"` + `⏎` icon. Capped at 200 entries.
- **Session persistence — crawl node as source of truth (2026-02-16)** — Six-phase refactor: (1) Enriched `CrawlNode.metadata` with `interpretation` and `goalContext`. (2) Added `cursorHistory[]` + `cursorIndex` to CrawlManager, replacing `pageStack`/`forwardStack`/`visitHistory` on SessionState. (3) Rewrote `/back`, `/forward`, `/history`, `/stack` to use cursor; `restoreFromNode()` replaces `restoreSnapshot()`. (4) New `src/session/persistence.ts` — `SessionEnvelope` JSON sidecar written alongside crawl markdown, enabling full session round-trip. `loadCrawl()` prefers JSON over markdown. (5) Auto-resume on startup: finds last session < 7 days, prompts to resume. `--new` flag bypasses. (6) Periodic auto-save (60s). New test suite: `__test__session.ts` with 118 assertions.
- **Main view polish + configurable max_tokens (2026-02-17)** — Three problems fixed: (1) Noisy cascade of dim status lines during page load replaced with single overwriting `render.progress()` line + `render.progressDone()`. (2) Navigation page summaries (previously dim `render.status()`, invisible) now use `render.navSummary()` — bold title, word-wrapped white text, dim hostname. (3) `max_tokens` for interpret raised from 1024→2048 default, all three LLM methods (`interpret`/`planAction`/`extractData`) configurable via `MAX_TOKENS_INTERPRET`/`MAX_TOKENS_PLAN`/`MAX_TOKENS_EXTRACT` env vars. Both providers use shared `tokenLimit()` helper. Prompt updated: content pages get 3-6 sentence summaries, navigation 1-3 sentences. `suggestCommands()` now context-aware (checks cursor position, login, forms, extracted data). 6 files changed, 0 test regressions (401 assertions across 5 suites).
- **Crawl stash — cross-domain navigation history (2026-02-17)** — Cross-domain `/goto` was destroying in-session navigation history. Fix: instead of `clearCrawl()` on external navigation, `stashCrawl()` pushes the active crawl onto `CrawlManager.stash: StashedCrawl[]`. `/back` at start of new crawl pops the stash. `/history` shows unified history across all stashed + active crawls via `getFullCursorHistory()`. `/stack` shows stash indicator. `SessionEnvelope` bumped to v3 with `stash: SerializedStashedCrawl[]` (backward-compatible with v2). `/crawl end` uses `clearActive()` (preserves stash), `/crawl load` stashes current crawl. `/clear crawl` still clears everything. Stash capped at 10 entries. New types: `StashedCrawl`, `FullCursorEntry`. 6 files changed, 0 test regressions (380 assertions across 4 suites).
- **`/auto` mode — autonomous browsing (2026-02-17)** — `/auto <goal>` drives the browser autonomously: interpret page → `planAutoAction()` (new LLM method, operates on numbered choices not selectors) → `executeChoice()` → loop. Terminal conditions: data found, step limit (10), loop detection (same URL visited twice), consecutive errors (2), Ctrl+C abort, or `ask_human`. New `src/auto/` module: `executor.ts` (shared `executeChoice()` extracted from REPL — first concrete REPL refactor step), `runner.ts` (autonomous loop as implicit state machine). CityServe SPA auth fix (interceptor clear + 500ms settle delay). New `AutoPlanResult` type + `planAutoAction()` on `LLMProvider` interface. 63 unit assertions + E2E integration test. See `learnings/2026-02-17-5.md`.
- **REPL refactor Phases 0–2 (2026-02-18)** — Three-phase structural refactor of `repl.ts` (2134→1596 lines). Phase 0: safety net test suite (`__test__repl.ts`, 43 assertions) with mock factories for Page, Engine, Navigator, LLM, Interceptor, readline. Phase 1: `navigateAndProcess()` extraction — single 30-line method owning the 8-step navigation transaction (syncBrowser → truncateCursorForward → interceptor.clear → pendingReachedBy → preNavigate hook → nav.goto → currentUrl → processCurrentPage), replacing 4 duplicated inline sequences. Phase 2: command handler extraction — `SessionState` moved to `handler-types.ts`, 19 switch/case branches replaced with dispatch map routing to 3 handler files (`handlers/navigation.ts` 226 lines/8 commands, `handlers/session.ts` 105 lines/7 commands, `handlers/crawl.ts` 263 lines/4 commands). `handleInput()` reduced from ~784 lines to ~10-line dispatcher + ~150 lines for choice/free-text. `rl.prompt()` calls reduced from 58→15. `ReplContext` dependency bag (22 bound methods + 8 field accesses) makes handler coupling explicit. 524 total assertions across 7 suites, 0 failures. See `learnings/2026-02-18-0.md`.
