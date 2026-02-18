import * as readline from "readline";
import { BrowserEngine } from "../browser/engine";
import { PageNavigator } from "../browser/navigator";
import { NetworkInterceptor } from "../browser/network";
import { LLMProvider, PageInterpretation, GoalContext } from "../llm/provider";
import { CrawlManager, CrawlNode, ReachedBy } from "../crawl/tree";
import { DetectedForm } from "../forms/detector";
import { ExtractedData } from "../llm/provider";

// ===================================================================
// SessionState — exported for handler access
// ===================================================================

export interface SessionState {
  goalContext: GoalContext;
  currentInterpretation: PageInterpretation | null;
  previousInterpretation: PageInterpretation | null;
  lastExtracted: ExtractedData | null;
  lastPageTitle: string;
  history: Array<{ role: "user" | "agent"; content: string }>;
  log: Array<{ role: string; content: string; timestamp: number }>;
  site: string;
  loginAvailable: boolean;
  detectedForms: DetectedForm[];
  homeUrl: string;
  currentUrl: string;
  pendingReachedBy: ReachedBy;
}

// ===================================================================
// NavigateOpts — options for navigateAndProcess
// ===================================================================

export interface NavigateOpts {
  settleMs?: number;
  preNavigate?: () => void | Promise<void>;
}

// ===================================================================
// HandlerResult — returned by command handlers
// ===================================================================

export interface HandlerResult {
  /** true = handler already managed rl.prompt() or shutdown */
  promptHandled?: boolean;
}

// ===================================================================
// CommandHandler — function signature for all slash command handlers
// ===================================================================

export type CommandHandler = (
  ctx: ReplContext,
  arg: string,
  parts: string[],
) => Promise<HandlerResult | void>;

// ===================================================================
// ReplContext — dependency bag passed to command handlers
// ===================================================================

export interface ReplContext {
  state: SessionState;
  engine: BrowserEngine;
  nav: PageNavigator;
  interceptor: NetworkInterceptor;
  crawlManager: CrawlManager;
  llm: LLMProvider;
  signal: AbortSignal | undefined;
  rl: readline.Interface;

  // Bound operations from Repl
  syncBrowser: () => Promise<void>;
  processCurrentPage: () => Promise<void>;
  navigateAndProcess: (url: string, reachedBy: ReachedBy, opts?: NavigateOpts) => Promise<boolean>;
  reattach: () => void;
  buildExecDeps: () => import("../auto/executor").ExecutionDeps;
  restoreFromNode: (node: CrawlNode) => void;
  stashCrawl: () => void;
  clearRepl: () => void;
  clearCrawl: () => void;
  clearBrowser: () => Promise<void>;
  runLoginFlow: () => Promise<void>;
  runAutoMode: (goal: string, maxSteps?: number) => Promise<void>;
  confirmAction: (question: string) => Promise<boolean>;
  jumpToHistory: (n: number) => Promise<void>;
  suggestCommands: () => void;
  setInterpretation: (interpretation: PageInterpretation) => void;
  forceSave: () => void;
  saveSessionSidecar: () => string | null;
  ensureCityServe: () => Promise<boolean>;
  shutdown: () => Promise<void>;
  logAgent: (msg: string) => void;
  logCommand: (cmd: string) => void;
}
