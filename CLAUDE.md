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
├── package.json, .env.example, tsconfig.json
├── src/                     # CLM agent + CLI
│   ├── index.ts             # Entry point — CLI arg parsing, provider setup
│   ├── browser/             # engine.ts (launch/show/hide/recover), navigator.ts (goto/extract/a11y), network.ts (JSON capture)
│   ├── llm/                 # provider.ts (interfaces), openai.ts, anthropic.ts, prompts.ts (content-first)
│   ├── auth/                # detector.ts (login heuristics), handoff.ts (CLI auth, raw stdin)
│   ├── sites/hn.ts          # HN comment extraction + LLM formatting
│   ├── forms/detector.ts    # Interactive form detection (search, filter)
│   ├── crawl/               # tree.ts (CrawlManager), persistence.ts, context.ts, namer.ts
│   ├── session/persistence.ts # SessionEnvelope v3 — JSON sidecar for full session resume
│   ├── cli/
│   │   ├── repl.ts          # REPL core — dispatch map, choice execution, navigateAndProcess()
│   │   ├── handler-types.ts # SessionState, ReplContext, CommandHandler types
│   │   ├── handlers/        # navigation.ts (8 cmds), session.ts (8 cmds), crawl.ts (4 cmds)
│   │   ├── renderer.ts      # ANSI terminal output (banner, contentBox, navSummary, etc.)
│   │   └── goals.ts         # formatGoal(), addBreadcrumb()
│   ├── output/writer.ts     # Save data + session logs to ~/clm/{site}/
│   ├── auto/                # executor.ts (shared executeChoice), runner.ts (autonomous loop)
│   └── __test__*.ts         # 11 test suites (see Running section)
├── cityserve/               # Mock government website — server.ts, public/, api/, data/
└── learnings/               # Session learnings, design specs, TODO.md
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
   a. Network interceptor passively captures same-origin JSON responses + markdown responses
   b. DOM content extracted (title, visible text, links, forms)
   b2. A11y tree extracted via Playwright's `_snapshotForAI()` — YAML with `[ref=...]` identifiers (graceful fallback to null)
   c. Content pipeline: markdown (from `text/markdown` response) → DOM text → network JSON → scroll-to-load
   d. Page content + a11y tree sent to LLM with user's goal and conversation context
   e. LLM returns content-first interpretation: summary + navigation choices with `ref` identifiers (CSS selectors as fallback)
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

Three-tier capture: (1) **Markdown** — `context.route()` overrides Accept header on document requests to prefer `text/markdown`; `NetworkInterceptor` stores the longest response (>200 chars, cap 8000). (2) `/api/` routes (same-origin) — logged, used for data extraction. (3) All same-origin JSON — captured silently for `findRichContent()` (skips analytics/config, requires sentence-like text 30+ words, recursively walks JSON prioritizing `body`/`content`/`text`/`article` fields).

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

Navigation fallback chain: `networkidle` (15s) → `domcontentloaded` (15s) → continue with whatever loaded.

**The REPL owns position, not the browser.** `state.currentUrl` is the single source of truth for "where we are." The browser is a servant that syncs on demand:

- `syncBrowser()` runs before any operation that needs the browser: checks alive → responsive → correct URL. Recovers or navigates as needed.
- `/back` and `/forward` are pure stack mutations — they update `state.currentUrl` and the page/forward stacks without touching the browser. `syncBrowser()` navigates to the correct URL on the next operation.
- `state.currentUrl` is set explicitly after every `nav.goto()` call. **Never** read from `page.url()` to set state — after `/show`, the old page object is dead but still returns its stale URL.
- `recoverBrowser()` encapsulates crash recovery (kill remnants, relaunch, reattach interceptor + navigator).

### State Management

State interfaces defined in `src/cli/handler-types.ts` — `GoalContext` (baseGoal + activeIntent + breadcrumb trail) and `SessionState` (current URL, interpretations, conversation history, forms, etc.). See `learnings/architecture-reference.md` for full interface definitions.

**Cursor history**: `CrawlManager.cursorHistory` is a linear `CursorEntry[]` log; `cursorIndex` tracks position for back/forward. New navigation truncates forward entries. Capped at 200.

**Crawl stash**: External `/goto` stashes the active crawl onto `CrawlManager.stash[]` instead of destroying it. `/back` at crawl start pops the stash. `/history` shows combined entries. Capped at 10. `SessionEnvelope` v3 serializes the full stash.

Key state behaviors:
- **REPL owns position**: `state.currentUrl` is set after every `nav.goto()`, never read from `page.url()`. All operations use `currentUrl`.
- **Crawl node as source of truth**: `PageInterpretation` and `GoalContext` stored on `CrawlNode.metadata` via `storeStateOnNode()`. `/back` and `/forward` restore from the node. URL-deduplicated nodes get metadata overwritten on revisit.
- **Goal reset**: External `/goto` stashes crawl and resets `GoalContext`. Relative paths keep current goal.
- **Previous interpretation**: Old choices preserved; stale number entry asks "did you mean [N] label? (y/n)"
- **Conversation context**: Free-text follow-ups pass `"Previous summary: ...\nUser asks: ..."` to the LLM.
- **Form detection**: `detectInteractiveForms(page)` runs on each page load. Detected forms become fill choices via `appendSystemChoices()`, deduped by `inputSelector`. Ordering: LLM choices → detected forms → login.
- **Session persistence**: `.session.json` sidecar written on shutdown + every 60s. Contains full `SessionEnvelope` v3. On startup, recent session (< 7 days) prompts resume. `--new` bypasses.

Guard flags:
- `shuttingDown` — prevents double shutdown (rl.close fires close event)
- `closingForAuth` — prevents shutdown when closing readline for auth handoff
- `muteInterceptor` — suppresses network logs during auth

### Crawl System

Every navigation is recorded as a node in a tree. The tree persists to markdown at `~/clm/crawls/`, capturing the browsing path with LLM summaries. CrawlManager auto-creates crawls, deduplicates by URL, supports cursor history and cross-domain stash. See `learnings/architecture-reference.md` for method-level API details.

**`pendingReachedBy` pattern**: The REPL sets `state.pendingReachedBy` before navigation (e.g., "choice", "goto"). `trackNavigation()` consumes it after the page loads to record how the user reached the new page. This decouples navigation intent from navigation execution.

### Command Handler Architecture

Slash commands dispatched through `COMMAND_HANDLERS` map in `repl.ts`. Each handler receives a `ReplContext` dependency bag (state, engine, nav, interceptor, llm, crawlManager, rl, render, + 22 bound methods). Handler files in `src/cli/handlers/`: `navigation.ts` (8 cmds), `session.ts` (8 cmds), `crawl.ts` (4 cmds with subcommands). See `learnings/architecture-reference.md` for full `ReplContext` interface.

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
MAX_TOKENS_INTERPRET=2048    # optional, defaults shown
MAX_TOKENS_PLAN=512
MAX_TOKENS_EXTRACT=1024
AUTO_MAX_STEPS=10            # optional, default: 10
# DEBUG=1                    # inline diagnostic output
```

Token limits configurable per method via env vars. Both providers use shared `tokenLimit(envVar, fallback)` helper.

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
| `/auto <goal> [--max-steps N]` | Autonomous browsing loop — interpret → plan → execute until goal met or limit hit |
| `/debug` | Toggle inline debug output (LLM I/O, a11y, execution paths) |
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
```

Choices: `[N]` cyan number, white text. Hints: dim, context-aware, max 3. Content pages: bordered `contentBox()`. Navigation pages: `navSummary()` (bold title, wrapped text, dim hostname). See `learnings/architecture-reference.md` for full layout examples.

## Running

```bash
# Install
npm install
npx playwright install chromium

# Configure
cp .env.example .env    # Edit with your API key

# Run (defaults to Hacker News)
npm run clm
npm run clm -- browse nytimes.com         # Specific URL
npm run clm -- --new                       # Skip session resume

# CityServe demo
npm run cityserve       # Start mock site on :3000, then /demo in REPL

# Tests (11 suites)
npm run test:repl          # REPL command handlers
npm run test:auto          # Auto mode runner + executor
npm run test:crawl         # Crawl tree + persistence + stash
npm run test:session       # Session persistence
npm run test:stash-eval    # Cross-domain stash correctness
npm run test:crawl-phase4  # Crawl command layer + display
npm run test:crawl-llm     # Crawl LLM integration
npm run test:phase5        # Form detection, HN, goals
npm run test:aria          # A11y tree extraction
npm run test:recover       # Browser crash recovery
npm run test:markdown      # Markdown content pipeline (needs network)
npm run test:browser       # Browser integration (needs CityServe)
npm run test:llm           # LLM provider test
```

## File Output

Saved to `~/clm/{site}/{resource}-{date}.json`:

```
~/clm/
  config.json                  # homeUrl + lastSessionId
  crawls/
    {crawl-id}.md              # Saved crawl tree + session log (human-readable)
    {crawl-id}.session.json    # Full session state (machine-readable, for resume)
  {site}/
    {resource}-{date}.json     # Extracted data
    session-log-{date}.md      # Session log
```

## Resilience Patterns

Every async operation has a fallback chain:
- **Page load**: `networkidle` (15s) → `domcontentloaded` (15s) → continue with whatever loaded
- **Navigation errors**: Network (`net::`/`NS_ERROR_`) → "could not reach"; HTTP ≥ 400 → "returned HTTP {status}"; all paths use `navigateAndProcess()`
- **Content extraction**: Intercepted network JSON → scroll-to-load + re-extract DOM → sparse content warning
- **Browser state**: `syncBrowser()` 3-point check → `recoverBrowser()` relaunch → error message
- **Click navigation**: `aria-ref` locator → `page.click(selector)` / `href` + `nav.goto()` → anchor link detection, skip
- **Auth handoff**: CLI credential entry → retry up to 3 times → cancel and return
- **LLM calls**: 30s timeout + AbortController → CancelledError on Ctrl+C → error message

## Known Limitations

- Anti-bot sites (NYT, some news sites) may return empty content
- No stealth mode (no `playwright-extra` / puppeteer-stealth)
- HN comment threads rendered as content with `commentThread()` display — top 30 comments extracted
- Anthropic provider less tested than OpenAI
- No OAuth/SSO/2FA flows
- Google and other sites may trigger CAPTCHA in headless mode

## Design History

See `learnings/architecture-reference.md` for detailed implementation history. Individual session learnings at `learnings/2026-02-*.md`.
