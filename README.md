# Clawmium

```
    /\    /|
   /  \__/ |
  /   /___/
```

> The web is a text adventure and your agent has the walkthrough.

Clawmium (`clm`) is an agent-first browser. It runs a headless Chromium instance, feeds page content to an LLM, and gives you a terminal interface to navigate the web through numbered choices and natural language. The browser only renders pixels when you ask (`/show`). Works on real websites — Hacker News, blogs, news sites — not just demos.

## What it looks like

```
  ╭──────────────────────────────────╮
  │  /\    /|   Clawmium v0.2       │
  │ /  \__/ |   Agent-first browser  │
  │ /   /___/   Provider: GPT-4o    │
  ╰──────────────────────────────────╯

  Hacker News — Top Stories
  Listing of 30 stories. Top items include an AI model that outperforms
  GPT-4 on coding benchmarks, a Show HN for a Rust web framework, and
  a discussion about remote work policies at major tech companies.
  news.ycombinator.com

  [1] AI model outperforms GPT-4 on coding benchmarks
  [2] Show HN: A Rust web framework with zero-cost abstractions
  [3] Remote work policies are shifting again at Big Tech
  [4] The forgotten history of the telegraph network
  [5] Ask HN: What are you working on this weekend?

  tip: /show to open browser, /tree to see navigation path

> 1

  AI Model Outperforms GPT-4 on Coding Benchmarks
  ┌──────────────────────────────────────────────────────────────────┐
  │ Researchers at DeepCode Labs released Coder-7B, a 7-billion     │
  │ parameter model that scores 89.2% on HumanEval, surpassing      │
  │ GPT-4's 86.4%. The model was trained on a curated dataset of    │
  │ 2M verified code solutions with execution feedback. Key insight: │
  │ smaller models can match larger ones when training data quality  │
  │ is high enough. Available on HuggingFace under Apache 2.0.      │
  └──────────────────────────────────────────────────────────────────┘

  [1] Comments (342)
  [2] DeepCode Labs blog post
  [3] HuggingFace model card

> what programming languages does it support?

  Based on the article, Coder-7B was evaluated on Python, JavaScript,
  TypeScript, Go, and Rust. Python had the highest scores (89.2% on
  HumanEval), while Rust showed the most improvement over GPT-4.
```

## Quick start

```bash
# 1. Clone and install
git clone https://github.com/anthropics/clawmium && cd clawmium
npm install && npx playwright install chromium

# 2. Configure your LLM provider
cp .env.example .env
# Edit .env — add your OpenAI or Anthropic API key

# 3. Browse (defaults to Hacker News)
npm run clm

# Or start at a specific site
npm run clm -- browse nytimes.com
```

## How it works

```
You (terminal)  →  CLM REPL  →  LLM (interpret page, extract data)
                       ↕
                  Playwright (headless Chromium)
                       ↕
                  Any website
```

1. Headless Chromium navigates to a URL
2. DOM content extracted + any intercepted same-origin JSON API responses
3. LLM summarizes what the page *says* and offers numbered navigation choices
4. You pick a number, ask a question in plain English, or use slash commands
5. Repeat — data saved automatically to `~/clm/`

The LLM never sees your credentials. Auth is detected heuristically and handled via masked terminal input.

## Navigation model

v0.2 tracks every page visit in a **crawl tree** — showing where you've been and how you got there.

### Crawl tree

Every navigation creates a node. `/tree` shows your path:

```
hackernews  (Feb 17, 3:42pm)
├── news.ycombinator.com  [root]
│   ├── AI model outperforms GPT-4  [↗ choice]
│   │   └── Comments (342)  [↗ choice]
│   └── Show HN: Rust web framework  [↗ choice]
```

### Cursor history

`/back` and `/forward` move through your visit history — like a browser, but restoring the full LLM interpretation (summary + choices) without re-fetching. `/history` shows the chronological log; `/history N` jumps to any entry.

### Cross-domain stash

When you `/goto` a different domain, your current crawl is **stashed** — not destroyed. `/back` at the start of a new site pops the stash and returns you where you were. Up to 10 crawls preserved.

```
[stash]  hackernews crawl (5 nodes)
[stash]  nytimes crawl (3 nodes)
[active] github.com (2 nodes)  ← you are here

/back → pops nytimes from stash, restores position
```

### Session persistence

Sessions auto-save every 60 seconds. On next launch, you're prompted to resume — full crawl tree, cursor position, conversation history, and stash all restored. Use `--new` to skip.

## CLI commands

| Command | Action |
|---------|--------|
| `/show` | Open browser window (transfers cookies) |
| `/hide` | Close browser, return to headless |
| `/goto <url>` | Navigate to URL (bare domains auto-prefixed) |
| `/back` | Go back (pops stash across domains) |
| `/forward` | Go forward |
| `/home [url]` | Go to home URL, or set it |
| `/refresh` | Re-analyze current page |
| `/url` | Show current URL |
| `/stack` | Show back/forward stack + sync status |
| `/history [N]` | Visit history (N to jump) |
| `/tree` | Show crawl navigation tree |
| `/crawl` | Manage crawls: list, load, rename, end, info |
| `/save` | Save data to disk |
| `/clear` | Reset state: repl, crawl, browser, or all |
| `/demo` | Run CityServe mock government site demo |
| `/quit` | Save and exit |
| `/help` | Show command list |
| `1`, `2`, `3`... | Select a numbered choice |
| Free text | Ask a follow-up question about the current page |
| Ctrl+C | Cancel current operation (double-press to quit) |

## File output

```
~/clm/
  config.json                    # home URL + last session ID
  crawls/
    {id}.md                      # crawl tree + session log (human-readable)
    {id}.session.json            # full session state (for resume)
  hackernews/
    session-log-2026-02-17.md
  nytimes/
    article-2026-02-17.json
    session-log-2026-02-17.md
```

## Tests

| Suite | Command | Assertions |
|-------|---------|------------|
| Phase 5 | `npm run test:phase5` | 91 |
| Recovery | `npm run test:recover` | 14 |
| Crawl | `npm run test:crawl` | 152 |
| Crawl LLM | `npm run test:crawl-llm` | 48 |
| Crawl Phase 4 | `npm run test:crawl-phase4` | 31 |
| Session | `npm run test:session` | 149 |
| Stash eval | `npm run test:stash-eval` | 86 |
| Browser | `npm run test:browser` | manual |
| LLM | `npm run test:llm` | manual |

## Known limitations

- Anti-bot sites may return empty content (no stealth mode)
- Anthropic provider less tested than OpenAI
- No OAuth/SSO/2FA flows
- Google and similar sites may trigger CAPTCHAs in headless mode

## Tech stack

- **TypeScript** (Node.js) via `tsx`
- **Playwright** controlling headless Chromium
- **OpenAI** / **Anthropic** SDKs for LLM (bring your own key)
- **Express** for the CityServe mock site
- No external CLI frameworks — raw ANSI escape codes + readline

## License

ISC
