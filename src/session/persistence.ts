import * as fs from "fs";
import * as path from "path";
import { CrawlManager, CrawlNode, Crawl, CursorEntry, ReachedBy, StashedCrawl } from "../crawl/tree";
import { PageInterpretation, GoalContext } from "../llm/provider";
import { CrawlMeta } from "../crawl/classify";

// ===================================================================
// Types
// ===================================================================

export interface SerializedCrawlNode {
  id: string;
  url: string;
  title: string;
  timestamp: number;
  parentId: string | null;
  reachedBy: ReachedBy;
  children: string[];
  metadata?: {
    summary?: string;
    conversationSnippets?: string[];
    interpretation?: PageInterpretation;
    goalContext?: GoalContext;
    classification?: import("../crawl/classify").NodeClassification;
    httpStatus?: number;
  };
}

export interface SerializedStashedCrawl {
  id: string;
  name: string;
  created: number;
  lastAccessed: number;
  rootId: string;
  currentNodeId: string;
  nodes: SerializedCrawlNode[];
  cursorHistory: CursorEntry[];
  cursorIndex: number;
}

export interface SessionEnvelope {
  version: 2 | 3 | 4;
  savedAt: number;
  crawl: {
    id: string;
    name: string;
    created: number;
    lastAccessed: number;
    rootId: string;
    currentNodeId: string;
    nodes: SerializedCrawlNode[];
    cursorHistory: CursorEntry[];
    cursorIndex: number;
    meta?: CrawlMeta;
  };
  stash?: SerializedStashedCrawl[];
  repl: {
    currentUrl: string;
    site: string;
    homeUrl: string;
    goalContext: GoalContext;
    history: Array<{ role: "user" | "agent"; content: string }>;
  };
  log: Array<{ role: string; content: string; timestamp: number }>;
}

// ===================================================================
// Paths
// ===================================================================

const CLM_DIR = process.env.CLM_DIR || path.join(process.env.HOME || "~", "clm");
const CRAWL_DIR = path.join(CLM_DIR, "crawls");

/** Override for testing */
let sessionDirOverride: string | null = null;
export function setSessionDir(dir: string | null): void {
  sessionDirOverride = dir;
}
function getSessionDir(): string {
  return sessionDirOverride || CRAWL_DIR;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ===================================================================
// Serialize / Deserialize helpers
// ===================================================================

function serializeNodes(nodes: Map<string, CrawlNode>): SerializedCrawlNode[] {
  const result: SerializedCrawlNode[] = [];
  for (const node of nodes.values()) {
    const serialized: SerializedCrawlNode = {
      id: node.id,
      url: node.url,
      title: node.title,
      timestamp: node.timestamp,
      parentId: node.parentId,
      reachedBy: node.reachedBy,
      children: [...node.children],
    };
    if (node.metadata) {
      serialized.metadata = { ...node.metadata };
      // Deep-copy arrays
      if (node.metadata.conversationSnippets) {
        serialized.metadata.conversationSnippets = [...node.metadata.conversationSnippets];
      }
      if (node.metadata.goalContext) {
        serialized.metadata.goalContext = {
          ...node.metadata.goalContext,
          breadcrumb: [...(node.metadata.goalContext.breadcrumb || [])],
        };
      }
    }
    result.push(serialized);
  }
  return result;
}

function deserializeNodes(serialized: SerializedCrawlNode[]): Map<string, CrawlNode> {
  const nodes = new Map<string, CrawlNode>();
  for (const s of serialized) {
    const node: CrawlNode = {
      id: s.id,
      url: s.url,
      title: s.title,
      timestamp: s.timestamp,
      parentId: s.parentId,
      reachedBy: s.reachedBy,
      children: [...s.children],
    };
    if (s.metadata) {
      node.metadata = { ...s.metadata };
      if (s.metadata.conversationSnippets) {
        node.metadata.conversationSnippets = [...s.metadata.conversationSnippets];
      }
      if (s.metadata.goalContext) {
        node.metadata.goalContext = {
          ...s.metadata.goalContext,
          breadcrumb: [...(s.metadata.goalContext.breadcrumb || [])],
        };
      }
    }
    nodes.set(node.id, node);
  }
  return nodes;
}

// ===================================================================
// Save / Load
// ===================================================================

export interface SaveSessionOptions {
  manager: CrawlManager;
  currentUrl: string;
  site: string;
  homeUrl: string;
  goalContext: GoalContext;
  history: Array<{ role: "user" | "agent"; content: string }>;
  log: Array<{ role: string; content: string; timestamp: number }>;
}

/**
 * Save session state as a JSON sidecar file alongside the crawl markdown.
 * Returns the filepath, or null if no active crawl.
 */
export function saveSession(opts: SaveSessionOptions): string | null {
  const { manager } = opts;
  if (!manager.activeCrawl) return null;

  const dir = getSessionDir();
  ensureDir(dir);

  const envelope: SessionEnvelope = {
    version: 4,
    savedAt: Date.now(),
    crawl: {
      id: manager.activeCrawl.id,
      name: manager.activeCrawl.name,
      created: manager.activeCrawl.created,
      lastAccessed: manager.activeCrawl.lastAccessed,
      rootId: manager.activeCrawl.rootId,
      currentNodeId: manager.currentNodeId || manager.activeCrawl.rootId,
      nodes: serializeNodes(manager.nodes),
      cursorHistory: manager.cursorHistory.map(e => ({ ...e })),
      cursorIndex: manager.cursorIndex,
      meta: manager.activeCrawl.meta,
    },
    stash: manager.stash.map(s => ({
      id: s.activeCrawl.id,
      name: s.activeCrawl.name,
      created: s.activeCrawl.created,
      lastAccessed: s.activeCrawl.lastAccessed,
      rootId: s.activeCrawl.rootId,
      currentNodeId: s.currentNodeId || s.activeCrawl.rootId,
      nodes: serializeNodes(s.nodes),
      cursorHistory: s.cursorHistory.map(e => ({ ...e })),
      cursorIndex: s.cursorIndex,
    })),
    repl: {
      currentUrl: opts.currentUrl,
      site: opts.site,
      homeUrl: opts.homeUrl,
      goalContext: {
        ...opts.goalContext,
        breadcrumb: [...(opts.goalContext.breadcrumb || [])],
      },
      history: opts.history.map(h => ({ ...h })),
    },
    log: opts.log.map(l => ({ ...l })),
  };

  const filepath = path.join(dir, `${manager.activeCrawl.id}.session.json`);
  fs.writeFileSync(filepath, JSON.stringify(envelope, null, 2));
  return filepath;
}

/**
 * Load a session from a JSON sidecar file.
 * Returns the SessionEnvelope, or null if not found or corrupt.
 */
export function loadSession(crawlId: string): SessionEnvelope | null {
  const dir = getSessionDir();
  const filepath = path.join(dir, `${crawlId}.session.json`);
  if (!fs.existsSync(filepath)) return null;

  try {
    const content = fs.readFileSync(filepath, "utf-8");
    const envelope = JSON.parse(content) as SessionEnvelope;
    if (envelope.version !== 2 && envelope.version !== 3 && envelope.version !== 4) return null;
    // Backfill stash for v2 envelopes
    if (!envelope.stash) envelope.stash = [];
    // Backfill meta for v2/v3 envelopes
    if (!envelope.crawl.meta) envelope.crawl.meta = undefined;
    return envelope;
  } catch {
    return null;
  }
}

/**
 * Restore a CrawlManager from a SessionEnvelope.
 */
export function restoreManagerFromEnvelope(envelope: SessionEnvelope, manager: CrawlManager): void {
  const crawl: Crawl = {
    id: envelope.crawl.id,
    name: envelope.crawl.name,
    created: envelope.crawl.created,
    lastAccessed: envelope.crawl.lastAccessed,
    rootId: envelope.crawl.rootId,
    meta: envelope.crawl.meta,
  };

  manager.activeCrawl = crawl;
  manager.nodes = deserializeNodes(envelope.crawl.nodes);
  manager.currentNodeId = envelope.crawl.currentNodeId;
  manager.cursorHistory = envelope.crawl.cursorHistory.map(e => ({ ...e }));
  manager.cursorIndex = envelope.crawl.cursorIndex;
  manager.rebuildIndex();

  // Restore stash
  manager.stash = (envelope.stash || []).map(s => {
    const stashedCrawl: Crawl = {
      id: s.id,
      name: s.name,
      created: s.created,
      lastAccessed: s.lastAccessed,
      rootId: s.rootId,
    };
    const nodes = deserializeNodes(s.nodes);
    const nodeIndex = new Map<string, CrawlNode>();
    for (const node of nodes.values()) {
      nodeIndex.set(node.url, node);
    }
    return {
      activeCrawl: stashedCrawl,
      nodes,
      nodeIndex,
      currentNodeId: s.currentNodeId,
      cursorHistory: s.cursorHistory.map(e => ({ ...e })),
      cursorIndex: s.cursorIndex,
    } as StashedCrawl;
  });
}

/**
 * Find the most recent session file (< maxAge days old).
 * Returns the crawl ID and envelope, or null if none found.
 */
export function findLastSession(maxAgeDays = 7): { crawlId: string; envelope: SessionEnvelope } | null {
  const dir = getSessionDir();
  if (!fs.existsSync(dir)) return null;

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  let best: { crawlId: string; envelope: SessionEnvelope; savedAt: number } | null = null;

  const files = fs.readdirSync(dir).filter(f => f.endsWith(".session.json"));
  for (const file of files) {
    const crawlId = file.replace(".session.json", "");
    const envelope = loadSession(crawlId);
    if (!envelope) continue;
    if (envelope.savedAt < cutoff) continue;
    if (!best || envelope.savedAt > best.savedAt) {
      best = { crawlId, envelope, savedAt: envelope.savedAt };
    }
  }

  return best ? { crawlId: best.crawlId, envelope: best.envelope } : null;
}
