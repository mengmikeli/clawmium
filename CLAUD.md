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
- **Config:** `.env` file for API keys and provider selection

## Project Structure

```
clawmium/
├── CLAUD.md                 # This file — project spec + architecture
├── package.json
├── .env.example             # API key template
├── .gitignore
├── tsconfig.json
│
├── src/                     # CLM agent + CLI
│   ├── index.ts             # Entry point — CLI arg parsing, provider setup, default URL
│   ├── cli/
│   │   ├── repl.ts          # Main REPL loop — slash commands, choice selection, free-text LLM conversation
│   │   └── renderer.ts      # ANSI terminal output (banner, contentBox, dataTable, choices, status lines)
│   ├── browser/
│   │   ├── engine.ts        # BrowserEngine — launch/show/hide (cookie transfer), isAlive/recover
│   │   ├── navigator.ts     # PageNavigator — goto (timeout fallback), extractContent, goBack
│   │   ├── network.ts       # NetworkInterceptor — same-origin JSON capture, findRichContent
│   │   ├── __test__.ts      # Manual browser integration test
│   │   └── __test__recover.ts # Automated recovery + detection tests (14 tests, no deps)
│   ├── llm/
│   │   ├── provider.ts      # Interfaces: LLMProvider, PageInterpretation, AgentAction, ExtractedData
│   │   ├── openai.ts        # OpenAI provider
│   │   ├── anthropic.ts     # Anthropic provider
│   │   ├── prompts.ts       # System prompts (interpret, plan, extract) — content-first philosophy
│   │   └── __test__.ts      # LLM integration test
│   ├── auth/
│   │   ├── detector.ts      # Login page detection (weighted heuristics, threshold 0.5)
│   │   └── handoff.ts       # CLI auth — raw stdin, password masked, retry loop (3 attempts)
│   └── output/
│       └── writer.ts        # Save data + session logs to ~/clm/{site}/
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
    └── 2026-02-14-1.md      # Rewriting CLAUD.md from design spec to implementation reference
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
   f. CLI renders summary (content box for articles, inline for navigation) then numbered choices
3. Human selects choices, types free-text questions, or uses slash commands
4. Free-text input gets answered as a follow-up using previous summary as conversation context
5. Data automatically saved to `~/clm/{site}/` on extraction

### Content-First Philosophy

The LLM prompt prioritizes content over navigation. Page types:

| Type | Rendering | Choices |
|------|-----------|---------|
| `content` | Summary in ASCII content box | Only links to other content (no navbar chrome) |
| `navigation` | Summary inline | Main content links as choices (max 10) |
| `login` | Auth prompt in CLI | N/A — triggers CLI auth flow |
| `data` | Structured data table | "Show rendered page", "Save and quit" |
| `form` | Form fields | N/A |

Key prompt rules:
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
interface SessionState {
  userGoal: string;                          // Reset on external navigation
  currentUrl: string;                        // REPL's canonical position — source of truth
  currentInterpretation: PageInterpretation; // Current page's LLM output
  previousInterpretation: PageInterpretation; // For stale choice "did you mean?"
  lastExtracted: ExtractedData;              // Most recent data extraction
  lastPageTitle: string;                     // Page title (not summary)
  history: Array<{ role; content }>;         // Conversation context for LLM
  log: Array<{ role; content; timestamp }>;  // Full session log for saving
  site: string;                              // Current site name
  pageStack: PageSnapshot[];                 // For /back — exact state restoration
  forwardStack: PageSnapshot[];              // For /forward — restored on /back
}
```

Key state behaviors:
- **REPL owns position**: `state.currentUrl` is set after every `nav.goto()`, never read from `page.url()`. All stack operations, `inferResource()`, `currentSite()`, and anchor detection use `currentUrl`.
- **Goal reset**: `/goto` to external URL resets goal to `"browsing {hostname}"`. Relative paths keep current goal.
- **Previous interpretation**: When LLM produces new choices, old ones preserved. If user enters a number matching old choices, asks "did you mean [N] label? (y/n)"
- **Page stack**: Pushed before forward navigation, popped on `/back`. Restores exact interpretation, choices, goal, and page title without re-running the LLM. `/back` pushes to `forwardStack`; `/forward` pops from it.
- **Conversation context**: Free-text follow-ups pass `"Previous summary: ...\nUser asks: ..."` to the LLM so it answers the question rather than re-describing the page.

Guard flags:
- `shuttingDown` — prevents double shutdown (rl.close fires close event)
- `closingForAuth` — prevents shutdown when closing readline for auth handoff
- `muteInterceptor` — suppresses network logs during auth

### LLM Provider Interface

```typescript
interface LLMProvider {
  interpret(pageContent: string, userGoal: string, conversationContext?: string): Promise<PageInterpretation>;
  planAction(interpretation: PageInterpretation, context: ConversationContext): Promise<AgentAction>;
  extractData(rawData: string, userGoal: string): Promise<ExtractedData>;
}
```

Configured via `.env`:
```
LLM_PROVIDER=openai  # or "anthropic"
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

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
| `/url` | Debug: show REPL URL vs browser URL with sync indicator |
| `/save` | Save extracted data + session log to disk |
| `/demo` | Run CityServe demo (localhost:3000, goal: "check my water bill") |
| `/quit` | Save and exit |
| `/help` | Show command list |
| Number (1, 2, 3...) | Select a numbered choice |
| Free text | Follow-up question answered with page context |
| Ctrl+C | Cancel current operation (double-press within 2s to quit) |

### Terminal Output Style

```
→  status/progress messages (dim gray)
✓  completed actions (green)
⚠  warnings (yellow)
✗  errors (red)

  [1] Choice one              (cyan number, white text)
  [2] Choice two

  tip: /show to open browser, /back to go back    (dim hints when no choices)

  ┌──────────────────────────────────────┐
  │ Content box for article text         │    (word-wrapped, white on bordered box)
  └──────────────────────────────────────┘

  ┌──────────────────────────────────────┐
  │ Key:    Value                        │    (data table, bold keys)
  └──────────────────────────────────────┘

>  user input prompt (cyan)
```

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

# CityServe demo (separate terminal)
npm run cityserve          # Start mock site on :3000
npm run clm                # Then type /demo in the REPL

# Tests
npm run test:browser       # Browser integration (needs CityServe running)
npm run test:llm           # LLM provider test
```

## File Output

Saved to `~/clm/{site}/{resource}-{date}.json`:

```
~/clm/
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
| Content extraction | Intercepted network JSON | Scroll-to-load + re-extract DOM | Sparse content warning |
| Browser state | `syncBrowser()` 3-point check (alive? responsive? correct URL?) | `recoverBrowser()` — relaunch headless | Error message to user |
| Click navigation | `page.click(selector)` | Get `href` and `nav.goto()` | Detect anchor link, skip |
| Auth handoff | CLI credential entry | Retry up to 3 times | Cancel and return to prompt |
| LLM calls | 30s timeout + AbortController | CancelledError on Ctrl+C | Error message to user |

## Known Limitations

- Anti-bot sites (NYT, some news sites) may return empty content
- No stealth mode (no `playwright-extra` / puppeteer-stealth)
- HN comment threads not yet rendered as content (clicks go to external link)
- Anthropic provider less tested than OpenAI
- `max_tokens` fixed at 1024 — long articles may get truncated summaries
- No session persistence / resume across runs
- No OAuth/SSO/2FA flows
- Goals don't carry across navigations — "Find AI articles" on HN → click article → agent forgets context

## Design History

The original design spec (pre-implementation) is preserved at `learnings/2026-02-13-0.md`. Key changes from spec to implementation:

- **CLI auth** replaced browser-popup auth handoff — credentials entered in terminal, browser never shown
- **Real website support** added — was originally "mock only"
- **Content-first prompts** — original prompts were navigation-biased, producing link directories instead of content summaries
- **No external CLI deps** — `chalk`, `ora`, `@inquirer/prompts` replaced with raw ANSI codes + readline
- **Headless-first with cookie transfer** — Option A (offscreen window) replaced with true headless + relaunch-with-cookies for show/hide
- **Fallback chains everywhere** — `networkidle` timeout, crash recovery, scroll-to-load, sparse content detection
- **REPL stack refactor (2026-02-14)** — `state.currentUrl` replaces `page.url()` as source of truth. `syncBrowser()` replaces `ensureBrowser()`/`isAlive()`. `/back` and `/forward` are pure stack mutations. Added `/home`, `/refresh`, `/forward`, `/url` commands. See `learnings/2026-02-14-0.md`.
- **`commands.ts` removed** — all command handling lives inline in `repl.ts`
