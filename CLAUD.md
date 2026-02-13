# CLAUDE.md — Clawmium (clm)

> The web is a text adventure and your agent has the walkthrough.

## What is Clawmium?

Clawmium is an agent-first, human-second browser. It decomposes the traditional browser into its essential parts — identity vault, network stream, renderer (on-demand), and agent runtime — controlled through a CLI. The human interacts via a terminal, the agent drives a headless Chromium instance, and rendering is only invoked when the human needs to see something.

This repo is a working demo that demonstrates the core thesis: **browsers should be built for agents first, and render pixels only when you ask.**

## Tech Stack

- **Language:** TypeScript (Node.js)
- **Browser Engine:** Playwright (controlling Chromium via CDP)
- **CLI Framework:** `@inquirer/prompts` for interactive prompts, `chalk` for colored output, `ora` for spinners
- **Mock Website:** Express + vanilla HTML/CSS/JS (Tailwind via CDN for modern styling). The site is a simple SPA that makes `fetch()` calls to Express API endpoints — this is critical because it enables the network interception demo.
- **LLM Integration:** Passthrough model — user provides their own API key. Support two providers:
  - **Anthropic Claude** (via `@anthropic-ai/sdk`)
  - **OpenAI** (via `openai` SDK)
- **Config:** `.env` file for API keys and provider selection

## Project Structure

```
clawmium/
├── CLAUDE.md                 # This file
├── package.json              # Monorepo root
├── .env.example              # API key template
├── tsconfig.json
│
├── src/                      # CLM agent + CLI
│   ├── index.ts              # Entry point — parses initial command
│   ├── cli/
│   │   ├── repl.ts           # Interactive REPL loop (the text adventure)
│   │   ├── renderer.ts       # Terminal output formatting (numbered choices, status lines, permission prompts)
│   │   └── commands.ts       # Built-in commands: show, continue, save, quit
│   ├── browser/
│   │   ├── engine.ts         # Playwright browser lifecycle (launch, headless/headed toggle)
│   │   ├── navigator.ts      # Page navigation, element interaction, screenshot
│   │   └── network.ts        # Network interception via CDP — captures API responses
│   ├── llm/
│   │   ├── provider.ts       # Abstract provider interface
│   │   ├── anthropic.ts      # Claude implementation
│   │   ├── openai.ts         # OpenAI implementation
│   │   └── prompts.ts        # System prompts for page interpretation, action planning, data extraction
│   ├── auth/
│   │   ├── detector.ts       # Detects login pages (form heuristics, URL patterns)
│   │   └── handoff.ts        # Switches to headed mode, waits for human login, captures session
│   └── output/
│       └── writer.ts         # Writes extracted data to ~/clm/ as JSON/markdown
│
├── cityserve/                # Mock government website
│   ├── package.json
│   ├── server.ts             # Express server — serves pages + JSON API
│   ├── public/
│   │   ├── index.html        # Landing page — links to services
│   │   ├── login.html        # Login page
│   │   ├── dashboard.html    # Post-auth dashboard
│   │   ├── water-bill.html   # Water bill detail page (fetches from API)
│   │   ├── styles.css        # Tailwind via CDN + custom styles
│   │   └── app.js            # Client-side JS — makes fetch() calls to API endpoints
│   ├── api/
│   │   ├── auth.ts           # POST /api/login, GET /api/session — cookie-based auth
│   │   ├── services.ts       # GET /api/services — returns available services as JSON
│   │   ├── water-bill.ts     # GET /api/water-bill — returns billing data as JSON
│   │   └── account.ts        # GET /api/account — returns account profile as JSON
│   └── data/
│       └── fixtures.ts       # Mock data for the demo (user profile, bills, etc.)
│
└── demo/
    └── scenario.md           # The scripted demo walkthrough
```

## Architecture Overview

### The Core Loop

```
Human (terminal)  →  CLM CLI  →  LLM (interpret page, plan action)
                         ↕
                    Playwright (headless Chromium)
                         ↕
                    CityServe (mock website)
```

1. Human types a natural language command in the terminal
2. CLM launches headless Chromium, navigates to the target
3. For each page:
   a. Intercept all network responses (capture JSON API data)
   b. Extract page content (text, links, forms) via DOM access
   c. Send page content to LLM with the user's goal
   d. LLM returns one of: a set of choices to present, an action to take, a data extraction, or "need human input"
   e. CLI renders the LLM's decision as numbered choices, status updates, or permission prompts
4. Human selects choices or provides input via the terminal
5. Loop until goal is complete
6. Save extracted data to local filesystem

### Network Interception (The Key Demo Moment)

Playwright's CDP integration lets us listen to all network responses:

```typescript
page.on('response', async (response) => {
  if (response.url().includes('/api/') && response.headers()['content-type']?.includes('json')) {
    const data = await response.json();
    // Store this — the agent reads structured data, not DOM
  }
});
```

When the CityServe SPA makes `fetch('/api/water-bill')`, we capture the raw JSON response. The agent works from this structured data rather than parsing rendered HTML. The demo should visually contrast: "here's what the browser renders" vs "here's what the agent actually reads."

### Auth Handoff Flow

```
Agent hits login page
  → CLI prints: "⚠ LOGIN REQUIRED — opening browser..."
  → Playwright switches from headless to headed (visible window)
  → Human sees the login form, types credentials directly
  → Agent watches for navigation away from login page (indicates success)
  → Playwright switches back to headless
  → CLI prints: "→ session captured, resuming..."
  → Agent continues with the now-authenticated session
```

Critical: the agent NEVER sees the password. It only detects:
- "This looks like a login page" (via heuristics: password input field present, URL contains /login, etc.)
- "The human has completed login" (via URL change or session cookie appearing)

### LLM Integration

The LLM is used for three tasks:

1. **Page Interpretation** — given the page's text content, links, and forms, understand what the page offers and how it relates to the user's goal.

2. **Action Planning** — decide what to do next: present choices to the human, fill a form, click a link, or extract data.

3. **Data Extraction** — from intercepted API responses or page content, extract the relevant information in a structured format.

Each task has a dedicated system prompt in `src/llm/prompts.ts`. The prompts should instruct the LLM to respond in structured JSON so the CLI can parse and render the output predictably.

#### Provider Abstraction

```typescript
interface LLMProvider {
  interpret(pageContent: string, userGoal: string): Promise<PageInterpretation>;
  planAction(interpretation: PageInterpretation, context: ConversationContext): Promise<AgentAction>;
  extractData(rawData: string, userGoal: string): Promise<ExtractedData>;
}
```

Configured via `.env`:
```
LLM_PROVIDER=anthropic  # or "openai"
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

## Mock Website: CityServe

### Design Requirements

- **Modern but institutional.** Think a well-designed city government website circa 2025. Clean, uses a system font stack, muted blue/gray color palette, proper spacing. NOT ugly, but clearly functional/bureaucratic rather than consumer-friendly.
- **Single-page app behavior.** The HTML pages load, then use `fetch()` to call API endpoints for dynamic data. This is essential — it means JSON is flowing over the network for the agent to intercept.
- **Simple cookie-based auth.** `POST /api/login` with username/password, returns a session cookie. Protected routes check the cookie. No JWT complexity needed.
- **Realistic data.** The mock data should feel real: a water bill with account number, usage history, amount due, due date. An account profile with name and address. Service listings with descriptions.

### Pages

**Landing Page (`/`)**
- City logo/name: "CityServe — Bay Area Municipal Services"
- Navigation cards/links to services:
  - Water & Sewer Bill
  - Vehicle Registration
  - Park Permits
  - Report an Issue
- Only Water & Sewer Bill needs to be functional for the demo

**Login Page (`/login`)**
- Simple form: username + password
- Demo credentials shown in a subtle hint (for the person running the demo)
- POST to `/api/login`
- On success: set session cookie, redirect to `/dashboard`

**Dashboard (`/dashboard`)**
- Welcome message with user's name
- Quick summary cards:
  - Water bill: amount due, due date
  - Other services: placeholder cards
- Sidebar navigation

**Water Bill Page (`/water-bill`)**
- Account details (account #, service address)
- Current bill: amount, due date, billing period
- Usage chart (simple bar chart or table of last 6 months)
- Payment button (non-functional, just present for demo)
- All data fetched via `fetch('/api/water-bill')` on page load

### API Endpoints

```
POST /api/login        → { success: true, user: { name, email } }
GET  /api/session      → { authenticated: true, user: { name, email } }  (or 401)
GET  /api/services     → [{ id, name, description, url }]
GET  /api/water-bill   → { account: {...}, currentBill: {...}, usageHistory: [...] }
GET  /api/account      → { name, email, address, accountNumber }
```

All API responses return clean JSON. This is the data the agent intercepts.

### Mock Data

```typescript
const mockUser = {
  username: "mike.chen",
  password: "cityserve2025",
  profile: {
    name: "Mike Chen",
    email: "mike.chen@email.com",
    address: "1234 Oak Street, Bay Area, CA 94102",
    accountNumber: "CS-2025-84291"
  }
};

const mockWaterBill = {
  accountNumber: "CS-2025-84291",
  serviceAddress: "1234 Oak Street, Bay Area, CA 94102",
  currentBill: {
    amount: 84.50,
    dueDate: "2026-03-01",
    billingPeriod: "Jan 15 – Feb 14, 2026",
    status: "unpaid"
  },
  usageHistory: [
    { month: "Feb 2026", gallons: 4200, amount: 84.50 },
    { month: "Jan 2026", gallons: 3800, amount: 76.00 },
    { month: "Dec 2025", gallons: 3500, amount: 70.00 },
    { month: "Nov 2025", gallons: 3900, amount: 78.00 },
    { month: "Oct 2025", gallons: 4100, amount: 82.00 },
    { month: "Sep 2025", gallons: 4800, amount: 96.00 }
  ]
};
```

## CLI Interaction Design

### Terminal Output Style

Use a consistent visual language:

```
→  status/progress messages (gray or dim)
✓  completed actions (green)
⚠  permission requests or warnings (yellow)
✗  errors (red)
#  numbered choices (cyan numbers, white text)

[1] First option
[2] Second option
[3] Third option

>  user input prompt
```

### Built-in Commands

These work at any `>` prompt during the session:

| Command | Action |
|---------|--------|
| `show` | Switch Chromium to headed mode — pop open the browser window |
| `hide` | Switch back to headless |
| `save` | Force-save current page data to filesystem |
| `back` | Navigate back |
| `quit` | End session, close browser |
| Number (1, 2, 3...) | Select a numbered choice |
| Free text | Sent to LLM as a new instruction or clarification |

### The Demo Scenario (Scripted Walkthrough)

```
$ clm browse "check my water bill on cityserve"

  ╭──────────────────────────────────────╮
  │  🦞 Clawmium v0.1                    │
  │  Agent-first browser                 │
  │  Provider: Claude (anthropic)        │
  ╰──────────────────────────────────────╯

→ launching headless browser...
→ navigating to cityserve.gov (localhost:3000)
→ page loaded: "CityServe — Bay Area Municipal Services"
→ found 4 service options:

  [1] Water & Sewer Bill
  [2] Vehicle Registration
  [3] Park Permits
  [4] Report an Issue

> 1

→ navigating to Water & Sewer Bill...
→ login required — detected login form

⚠ LOGIN REQUIRED
  Site: CityServe (localhost:3000/login)
  Opening browser for manual login...

  [browser window appears with login page]
  [human types credentials and submits]

✓ login successful — session captured
→ closing browser window, resuming headless...
→ navigating to water bill...

→ intercepted API response: GET /api/water-bill
→ structured data captured (skipping page render)

✓ Water Bill Summary:
  ┌────────────────────────────────────┐
  │ Account:  CS-2025-84291            │
  │ Address:  1234 Oak Street          │
  │ Amount:   $84.50                   │
  │ Due:      March 1, 2026            │
  │ Status:   Unpaid                   │
  │ Usage:    4,200 gal (Feb 2026)     │
  └────────────────────────────────────┘

→ saved to ~/clm/cityserve/water-bill-2026-02.json

  [1] View usage history
  [2] Show rendered page
  [3] Save and quit

> 2

→ opening browser window...

  [browser pops up showing the water bill page, fully rendered]

> 3

✓ data saved to ~/clm/cityserve/water-bill-2026-02.json
→ session ended. browser closed.
```

## Build Order

Build in this order so each step is testable independently:

### Phase 1: Mock Website (CityServe)
1. Set up Express server with TypeScript
2. Build landing page (HTML + Tailwind CDN)
3. Build login page + `/api/login` endpoint with cookie auth
4. Build dashboard page + `/api/session` and `/api/account` endpoints
5. Build water bill page + `/api/water-bill` endpoint
6. Add client-side JS that fetches from API endpoints (critical for network tap demo)
7. Test: you can open the site in a real browser, log in, see water bill

### Phase 2: Browser Engine
1. Set up Playwright with Chromium
2. Implement headless navigation to CityServe
3. Implement network interception — capture JSON responses from `/api/*`
4. Implement headless ↔ headed toggle (the `show`/`hide` functionality)
5. Implement auth detection (scan page for password input fields)
6. Implement auth handoff (switch to headed, wait for URL change after login, switch back)
7. Test: script that navigates to CityServe, detects login, lets human log in, captures water bill JSON

### Phase 3: LLM Integration
1. Build provider abstraction interface
2. Implement Anthropic provider
3. Implement OpenAI provider
4. Write system prompts for page interpretation, action planning, and data extraction
5. Build the page-content-to-LLM pipeline (extract text + links + forms from page, send to LLM, parse structured response)
6. Test: give LLM the CityServe landing page content, verify it returns correct choices

### Phase 4: CLI + REPL
1. Build the entry point (`clm browse "..."`)
2. Build the REPL loop — display choices, accept input, dispatch actions
3. Implement terminal formatting (status lines, choice lists, data tables, permission prompts)
4. Wire it all together: CLI → LLM → Browser → Network → Output
5. Implement `show`, `hide`, `save`, `quit` commands
6. Implement file output writer (JSON + markdown to `~/clm/`)
7. Test: full demo scenario end-to-end

### Phase 5: Polish
1. ASCII art banner on launch
2. Error handling and graceful failures
3. `.env.example` with setup instructions
4. `README.md` with install + run instructions
5. Demo scenario documentation

## Key Implementation Notes

### Playwright Headless ↔ Headed Toggle

Playwright doesn't support toggling a single browser between headless and headed. The workaround:

**Option A (Recommended):** Launch Chromium in headed mode but with the window minimized or hidden. "Show" brings the window to focus. "Hide" minimizes it. This avoids relaunching the browser and losing session state.

**Option B:** Use `browser.contexts()` to transfer cookies between a headless and headed instance. More complex but truly headless when not shown.

Go with Option A for the demo. Launch headed but minimized. Simpler, no session transfer issues.

### LLM Prompt Design

The page interpretation prompt should produce structured JSON:

```json
{
  "pageType": "navigation" | "login" | "form" | "data" | "confirmation",
  "summary": "Brief description of what this page shows",
  "choices": [
    { "index": 1, "label": "Water & Sewer Bill", "action": "click", "selector": "a[href='/water-bill']" }
  ],
  "dataFound": null | { ... extracted data ... },
  "requiresAuth": false,
  "requiresHumanInput": false
}
```

This makes the CLI rendering predictable regardless of which LLM provider is used.

### Network Tap Display

When showing the network interception, print both the URL and a truncated preview of the JSON:

```
→ intercepted: GET /api/water-bill (200, 482 bytes)
→ raw JSON:
  {
    "accountNumber": "CS-2025-84291",
    "currentBill": {
      "amount": 84.50,
      "dueDate": "2026-03-01",
      ...
    }
  }
→ agent reading from structured API data (renderer: OFF)
```

This is the moment the audience realizes: the data was always there in the network layer, the browser just hid it behind a UI.

### File Output Format

Save to `~/clm/{site}/{resource}-{date}.json`:

```
~/clm/
  cityserve/
    water-bill-2026-02-13.json
    session-log-2026-02-13.md
```

The JSON file is the raw extracted data. The session log (markdown) is the full CLI interaction transcript — what the agent did, what the human chose, timestamps. This becomes the "browsing history" in the new paradigm.

## Environment Setup

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your API key

# Start the mock website
npm run cityserve

# In another terminal, run the demo
npm run clm -- browse "check my water bill on cityserve"

# Or for development
npm run dev
```

## Non-Goals (What NOT to Build)

- No granular permission/delegation engine beyond login handoff
- No persistent workspace across sessions
- No multi-agent coordination
- No real website support (mock only)
- No OAuth/SSO/2FA flows
- No semantic history graph
- No browser extension — this is a standalone tool controlling its own Chromium instance
- No mobile support
