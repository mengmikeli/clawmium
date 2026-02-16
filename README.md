# Clawmium

**The web is a text adventure and your agent has the walkthrough.**

Clawmium is an agent-first, human-second browser. It runs headless Chromium behind an LLM-powered CLI — you type goals in plain English, and the agent reads pages, presents choices, extracts data, and handles auth. The browser window never appears unless you ask for it.

## Quick start

```bash
git clone https://github.com/mengmikeli/clawmium.git
cd clawmium
npm install
npx playwright install chromium
cp .env.example .env   # then add your API key
npm run clm
```

## Usage

```bash
# Start with a blank prompt — navigate with /goto or /home
npm run clm

# Start at a specific site
npm run clm -- browse nytimes.com

# Run the CityServe demo (start the mock server first)
npm run cityserve &
npm run clm
# then type /demo
```

Once running, you interact through numbered choices and free-text questions:

```
→ page loaded: "The New York Times"
→ News homepage with today's top stories across politics, world, business...

  [1] U.S.
  [2] World
  [3] Business

> 2
→ navigating to World...
```

## Commands

| Command | Description |
|---|---|
| `/goto <url>` | Navigate to a URL (bare domains work: `nytimes.com`) |
| `/back` | Go back in page history |
| `/forward` | Go forward in page history |
| `/home` | Go to home URL (set with `/home <url>`) |
| `/show` | Open the browser window |
| `/hide` | Close the browser window |
| `/refresh` | Re-analyze current page |
| `/login` | Log in to current site (CLI auth — password masked) |
| `/save` | Save extracted data to disk |
| `/url` | Show current URL |
| `/stack` | Show URL stack and sync status |
| `/tree` | Show crawl navigation tree |
| `/crawl` | Manage crawls (list, load, rename, end, info) |
| `/clear` | Reset state (repl, crawl, browser, all) |
| `/demo` | Run CityServe demo |
| `/quit` | End session |
| `/help` | Show help |

Numbers select choices. Free text is sent to the LLM as a follow-up question.
Ctrl+C cancels the current operation; double Ctrl+C exits.

## How it works

```
          ┌─────────────┐
 You ───► │  CLI REPL    │ ◄─── free text / numbers / slash commands
          └──────┬───────┘
                 │
          ┌──────▼───────┐     ┌──────────────┐
          │  LLM Agent   │ ◄──►│  Headless     │
          │  (interpret,  │     │  Chromium     │
          │   extract,    │     │  (Playwright) │
          │   plan)       │     └──────┬────────┘
          └──────┬───────┘            │
                 │              ┌─────▼──────┐
          ┌──────▼───────┐     │  Network    │
          │  Choices /    │     │  Interceptor│
          │  Data Table   │     └────────────┘
          └──────────────┘
```

- **Headless by default** — Chromium runs invisibly. `/show` relaunches with a visible window (cookies transfer over). `/hide` goes back to headless.
- **LLM interprets every page** — extracts a summary, navigation choices, and structured data. You never parse HTML yourself.
- **Network interception** — captures same-origin JSON responses. When API data matches your goal, it's extracted directly (skipping the page render).
- **CLI auth** — login forms are detected automatically and offered as a choice. Credentials are entered in the terminal with masked passwords, never in a browser popup.
- **Page stack** — `/back` and `/forward` restore exact page state (summary + choices) without re-fetching.
- **Data extraction** — structured data is formatted as tables and saved to `~/clm/<site>/`.
- **Form detection** — Search boxes and filter forms are auto-detected and offered as numbered choices. Works with `<input>` and `<textarea>` elements (e.g. Google search).
- **HN threads** — Hacker News discussion pages get special handling: comments are extracted with threading/depth and summarized by the LLM.
- **Crawl tree** — every page visit becomes a node in a navigation tree. `/tree` shows your path with summaries; `/crawl list` shows saved crawls; `/crawl load` resumes a previous session.

## Crawl system

Navigation is automatically tracked as a tree — every page you visit becomes a node with URL, title, LLM summary, and conversation snippets. Crawl names are auto-derived from the first page's summary.

Saved to `~/clm/crawls/` as markdown files with tree, node details, and session log sections.

**`/crawl` subcommands:**

| Subcommand | Action |
|---|---|
| `/crawl list` | List all saved crawls |
| `/crawl load` | Load a saved crawl and navigate to its last position |
| `/crawl rename <name>` | Rename the active crawl |
| `/crawl end` | Save and end the active crawl (start fresh on next navigation) |
| `/crawl info` | Show details of the active crawl |

## LLM providers

Configured via `.env`:

```bash
# Use Anthropic (default)
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Or use OpenAI
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

Anthropic uses Claude. OpenAI uses GPT-4o.

## CityServe demo

CityServe is a mock government services website included in the repo for testing auth flows and data extraction.

```bash
npm run cityserve          # starts on localhost:3000
npm run clm                # in another terminal
# type /demo to navigate there
```

The demo goal is "check my water bill" — the agent navigates CityServe, detects the login form, you authenticate via CLI, and it extracts your billing data into a table.

## Project structure

```
src/
  index.ts              # Entry point, CLI arg parsing
  browser/
    engine.ts           # BrowserEngine (launch/show/hide/recover)
    navigator.ts        # PageNavigator (goto/extract)
    network.ts          # NetworkInterceptor (JSON capture)
  auth/
    detector.ts         # Login page detection (weighted heuristics)
    handoff.ts          # CLI auth (raw stdin, password masking)
  llm/
    provider.ts         # LLMProvider interface
    prompts.ts          # System prompts (interpret, plan, extract)
    openai.ts           # OpenAI provider (GPT-4o)
    anthropic.ts        # Anthropic provider (Claude)
  sites/
    hn.ts               # HN comment thread extraction
  forms/
    detector.ts         # Search/filter form detection
  crawl/
    tree.ts             # CrawlManager (node tree, navigation tracking)
    persistence.ts      # Save/load/list crawls as markdown
    context.ts          # Ancestor chain for LLM context
    namer.ts            # Auto-name crawls from page summary
  cli/
    renderer.ts         # ANSI terminal output
    repl.ts             # Main REPL loop
    goals.ts            # Goal context (breadcrumb tracking)
  output/
    writer.ts           # Save data/session logs to ~/clm/
cityserve/              # Mock government website
```

## Tests

```bash
npm run test:phase5    # Form detection, HN extraction, goals (91 assertions)
npm run test:recover   # Browser crash recovery (14 tests)
npm run test:crawl         # Crawl tree + persistence (113 assertions)
npm run test:crawl-llm     # Crawl LLM integration (48 assertions)
npm run test:crawl-phase4  # Crawl command layer + display (31 assertions)
npm run test:browser   # Browser integration (needs CityServe running)
npm run test:llm       # LLM provider test
```

## License

ISC
