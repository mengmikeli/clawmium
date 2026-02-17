import * as crypto from "crypto";
import { PageInterpretation, GoalContext } from "../llm/provider";

// ===================================================================
// Types
// ===================================================================

export type ReachedBy = "choice" | "goto" | "back" | "forward" | "auto" | "history";

export interface CrawlNode {
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
  };
}

export interface Crawl {
  id: string;
  rootId: string;
  name: string;
  created: number;
  lastAccessed: number;
}

export interface CursorEntry {
  nodeId: string;      // References a CrawlNode
  timestamp: number;
  reachedBy: ReachedBy;
}

export interface FullCursorEntry extends CursorEntry {
  crawlName: string;
  crawlId: string;
  stashIndex: number;  // -1 for active crawl, 0..N for stash (0 = oldest)
}

export interface StashedCrawl {
  activeCrawl: Crawl;
  nodes: Map<string, CrawlNode>;
  nodeIndex: Map<string, CrawlNode>;
  currentNodeId: string | null;
  cursorHistory: CursorEntry[];
  cursorIndex: number;
}

// ===================================================================
// CrawlManager
// ===================================================================

export class CrawlManager {
  activeCrawl: Crawl | null = null;
  currentNodeId: string | null = null;
  nodes: Map<string, CrawlNode> = new Map();
  nodeIndex: Map<string, CrawlNode> = new Map(); // URL -> node (runtime cache)
  cursorHistory: CursorEntry[] = [];
  cursorIndex: number = -1;
  stash: StashedCrawl[] = [];
  static readonly MAX_STASH = 10;

  // ---------------------------------------------------------------
  // Core operations
  // ---------------------------------------------------------------

  createCrawl(url: string, title: string, reachedBy: ReachedBy = "goto"): Crawl {
    const now = Date.now();
    const crawlId = crypto.randomUUID();
    const rootNode: CrawlNode = {
      id: crypto.randomUUID(),
      url,
      title,
      timestamp: now,
      parentId: null,
      reachedBy,
      children: [],
    };

    this.nodes.clear();
    this.nodeIndex.clear();
    this.nodes.set(rootNode.id, rootNode);
    this.nodeIndex.set(rootNode.url, rootNode);

    const crawl: Crawl = {
      id: crawlId,
      rootId: rootNode.id,
      name: new Date(now).toISOString().slice(0, 19).replace("T", " "),
      created: now,
      lastAccessed: now,
    };

    this.activeCrawl = crawl;
    this.currentNodeId = rootNode.id;
    return crawl;
  }

  addNavigation(url: string, title: string, reachedBy: ReachedBy): CrawlNode {
    // 1. No activeCrawl? Create one, return root node
    if (!this.activeCrawl) {
      this.createCrawl(url, title, reachedBy);
      return this.nodes.get(this.currentNodeId!)!;
    }

    // 2. URL already exists? Move position to existing node
    const existing = this.findNodeByUrl(url);
    if (existing) {
      this.currentNodeId = existing.id;
      this.activeCrawl.lastAccessed = Date.now();
      return existing;
    }

    // 3. New URL: create node as child of currentNodeId
    const parentId = this.currentNodeId;
    const node: CrawlNode = {
      id: crypto.randomUUID(),
      url,
      title,
      timestamp: Date.now(),
      parentId,
      reachedBy,
      children: [],
    };

    this.nodes.set(node.id, node);
    this.nodeIndex.set(node.url, node);

    // Update parent's children
    if (parentId) {
      const parent = this.nodes.get(parentId);
      if (parent) {
        parent.children.push(node.id);
      }
    }

    this.currentNodeId = node.id;
    this.activeCrawl.lastAccessed = Date.now();
    return node;
  }

  findNodeByUrl(url: string): CrawlNode | null {
    return this.nodeIndex.get(url) ?? null;
  }

  getNode(nodeId: string): CrawlNode | null {
    return this.nodes.get(nodeId) ?? null;
  }

  getAncestors(nodeId: string): CrawlNode[] {
    const ancestors: CrawlNode[] = [];
    let current = this.nodes.get(nodeId);
    while (current) {
      ancestors.push(current);
      if (!current.parentId) break;
      current = this.nodes.get(current.parentId);
    }
    return ancestors; // leaf-to-root order
  }

  navigateToNode(nodeId: string): boolean {
    if (!this.nodes.has(nodeId)) return false;
    this.currentNodeId = nodeId;
    if (this.activeCrawl) {
      this.activeCrawl.lastAccessed = Date.now();
    }
    return true;
  }

  clear(): void {
    this.activeCrawl = null;
    this.currentNodeId = null;
    this.nodes.clear();
    this.nodeIndex.clear();
    this.cursorHistory = [];
    this.cursorIndex = -1;
    this.stash = [];
  }

  /**
   * Clear only the active crawl state, preserving the stash.
   * Used by /crawl end — user can still /back into stashed crawls.
   */
  clearActive(): void {
    this.activeCrawl = null;
    this.currentNodeId = null;
    this.nodes.clear();
    this.nodeIndex.clear();
    this.cursorHistory = [];
    this.cursorIndex = -1;
  }

  // ---------------------------------------------------------------
  // Stash operations (preserve crawls across domain changes)
  // ---------------------------------------------------------------

  /**
   * Push the current active crawl onto the stash stack.
   * Moves references (O(1)), then clears active state.
   * Caps stash at MAX_STASH — oldest entry dropped when exceeded.
   */
  pushStash(): boolean {
    if (!this.activeCrawl) return false;
    this.stash.push({
      activeCrawl: this.activeCrawl,
      nodes: this.nodes,
      nodeIndex: this.nodeIndex,
      currentNodeId: this.currentNodeId,
      cursorHistory: this.cursorHistory,
      cursorIndex: this.cursorIndex,
    });
    // Reset active state with fresh maps (moved old ones to stash)
    this.activeCrawl = null;
    this.currentNodeId = null;
    this.nodes = new Map();
    this.nodeIndex = new Map();
    this.cursorHistory = [];
    this.cursorIndex = -1;
    // Enforce cap
    if (this.stash.length > CrawlManager.MAX_STASH) {
      this.stash.shift(); // drop oldest
    }
    return true;
  }

  /**
   * Pop the most recent stashed crawl and make it active.
   * Returns the restored crawl, or null if stash is empty.
   */
  popStash(): Crawl | null {
    if (this.stash.length === 0) return null;
    const entry = this.stash.pop()!;
    this.activeCrawl = entry.activeCrawl;
    this.nodes = entry.nodes;
    this.nodeIndex = entry.nodeIndex;
    this.currentNodeId = entry.currentNodeId;
    this.cursorHistory = entry.cursorHistory;
    this.cursorIndex = entry.cursorIndex;
    return this.activeCrawl;
  }

  hasStash(): boolean {
    return this.stash.length > 0;
  }

  getStashDepth(): number {
    return this.stash.length;
  }

  /**
   * Get a combined cursor history across stash (oldest first) + active crawl.
   * Returns FullCursorEntry[] with crawl attribution for cross-crawl display.
   */
  getFullCursorHistory(): FullCursorEntry[] {
    const result: FullCursorEntry[] = [];
    for (let si = 0; si < this.stash.length; si++) {
      const s = this.stash[si];
      for (const entry of s.cursorHistory) {
        result.push({
          ...entry,
          crawlName: s.activeCrawl.name,
          crawlId: s.activeCrawl.id,
          stashIndex: si,
        });
      }
    }
    const activeName = this.activeCrawl?.name || "(active)";
    const activeId = this.activeCrawl?.id || "";
    for (const entry of this.cursorHistory) {
      result.push({
        ...entry,
        crawlName: activeName,
        crawlId: activeId,
        stashIndex: -1,
      });
    }
    return result;
  }

  /**
   * Look up a node by ID across the active crawl and all stashed crawls.
   */
  getNodeAcrossStash(nodeId: string): CrawlNode | null {
    // Check active crawl first
    const active = this.nodes.get(nodeId);
    if (active) return active;
    // Check stash (most recent first for faster lookup)
    for (let i = this.stash.length - 1; i >= 0; i--) {
      const node = this.stash[i].nodes.get(nodeId);
      if (node) return node;
    }
    return null;
  }

  // ---------------------------------------------------------------
  // Metadata helpers
  // ---------------------------------------------------------------

  setNodeMetadata(nodeId: string, metadata: Partial<{ summary: string; conversationSnippets: string[]; interpretation: PageInterpretation; goalContext: GoalContext }>): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    if (!node.metadata) node.metadata = {};
    if (metadata.summary !== undefined) node.metadata.summary = metadata.summary;
    if (metadata.conversationSnippets !== undefined) node.metadata.conversationSnippets = metadata.conversationSnippets;
    if (metadata.interpretation !== undefined) node.metadata.interpretation = metadata.interpretation;
    if (metadata.goalContext !== undefined) node.metadata.goalContext = metadata.goalContext;
  }

  appendConversationSnippet(nodeId: string, snippet: string, maxSnippets = 5): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    if (!node.metadata) node.metadata = {};
    if (!node.metadata.conversationSnippets) node.metadata.conversationSnippets = [];
    const truncated = snippet.length > 120 ? snippet.slice(0, 117) + "..." : snippet;
    node.metadata.conversationSnippets.push(truncated);
    if (node.metadata.conversationSnippets.length > maxSnippets) {
      node.metadata.conversationSnippets.shift();
    }
  }

  // ---------------------------------------------------------------
  // Cursor history (linear visit log with back/forward index)
  // ---------------------------------------------------------------

  /**
   * Append a cursor entry. Truncates forward history (entries after cursorIndex)
   * and advances the index. Caps at 200 entries.
   */
  appendCursor(nodeId: string, reachedBy: ReachedBy): void {
    // Truncate forward entries
    this.cursorHistory = this.cursorHistory.slice(0, this.cursorIndex + 1);
    this.cursorHistory.push({
      nodeId,
      timestamp: Date.now(),
      reachedBy,
    });
    this.cursorIndex = this.cursorHistory.length - 1;
    // Cap at 200
    if (this.cursorHistory.length > 200) {
      const excess = this.cursorHistory.length - 200;
      this.cursorHistory = this.cursorHistory.slice(excess);
      this.cursorIndex -= excess;
      if (this.cursorIndex < 0) this.cursorIndex = 0;
    }
  }

  /**
   * Move cursor back. Returns the entry at the new position, or null if at start.
   */
  cursorBack(): CursorEntry | null {
    if (this.cursorIndex <= 0) return null;
    this.cursorIndex--;
    return this.cursorHistory[this.cursorIndex] ?? null;
  }

  /**
   * Move cursor forward. Returns the entry at the new position, or null if at end.
   */
  cursorForward(): CursorEntry | null {
    if (this.cursorIndex >= this.cursorHistory.length - 1) return null;
    this.cursorIndex++;
    return this.cursorHistory[this.cursorIndex] ?? null;
  }

  /**
   * Jump cursor to a specific index. Returns true on success.
   */
  cursorJump(index: number): boolean {
    if (index < 0 || index >= this.cursorHistory.length) return false;
    this.cursorIndex = index;
    return true;
  }

  /**
   * Truncate cursor entries after the current index (forward history dies on new navigation).
   */
  truncateCursorForward(): void {
    this.cursorHistory = this.cursorHistory.slice(0, this.cursorIndex + 1);
  }

  /**
   * Get the cursor entry at the current index.
   */
  getCurrentCursorEntry(): CursorEntry | null {
    if (this.cursorIndex < 0 || this.cursorIndex >= this.cursorHistory.length) return null;
    return this.cursorHistory[this.cursorIndex];
  }

  /**
   * Get the full cursor history array.
   */
  getCursorHistory(): CursorEntry[] {
    return this.cursorHistory;
  }

  /**
   * Reset cursor state (used by /clear repl).
   */
  resetCursor(): void {
    this.cursorHistory = [];
    this.cursorIndex = -1;
  }

  // ---------------------------------------------------------------
  // Tree restructuring
  // ---------------------------------------------------------------

  detachSubtree(nodeId: string): string[] {
    const node = this.nodes.get(nodeId);
    if (!node || !node.parentId) return []; // can't detach root or nonexistent

    // Remove from parent's children
    const parent = this.nodes.get(node.parentId);
    if (parent) {
      parent.children = parent.children.filter((id) => id !== nodeId);
    }

    // Clear parentId
    node.parentId = null;

    return this.getSubtreeIds(nodeId);
  }

  attachSubtree(nodeId: string, newParentId: string): boolean {
    const node = this.nodes.get(nodeId);
    const newParent = this.nodes.get(newParentId);
    if (!node || !newParent) return false;

    // Cycle check: newParentId must not be in nodeId's subtree
    if (this.wouldCreateCycle(nodeId, newParentId)) return false;

    // If already has a parent, detach first
    if (node.parentId) {
      const oldParent = this.nodes.get(node.parentId);
      if (oldParent) {
        oldParent.children = oldParent.children.filter((id) => id !== nodeId);
      }
    }

    // Wire to new parent
    node.parentId = newParentId;
    newParent.children.push(nodeId);
    return true;
  }

  // ---------------------------------------------------------------
  // Display
  // ---------------------------------------------------------------

  getDisplayTree(): string {
    if (!this.activeCrawl) return "";
    const rootNode = this.nodes.get(this.activeCrawl.rootId);
    if (!rootNode) return "";

    const lines: string[] = [];
    const buildTree = (nodeId: string, depth: number): void => {
      const node = this.nodes.get(nodeId);
      if (!node) return;
      const indent = "  ".repeat(depth);
      const marker = nodeId === this.currentNodeId ? " <-- you are here" : "";
      lines.push(`${indent}- [${node.title}](${node.url}) \`${node.id.slice(0, 6)}\` \`${node.reachedBy}\`${marker}`);
      for (const childId of node.children) {
        buildTree(childId, depth + 1);
      }
    };
    buildTree(this.activeCrawl.rootId, 0);
    return lines.join("\n");
  }

  getEnrichedDisplayTree(): string {
    if (!this.activeCrawl) return "";
    const rootNode = this.nodes.get(this.activeCrawl.rootId);
    if (!rootNode) return "";

    const RESET = "\x1b[0m";
    const DIM = "\x1b[2m";
    const BOLD = "\x1b[1m";
    const CYAN = "\x1b[36m";
    const WHITE = "\x1b[37m";

    const reachedByIcon: Record<string, string> = {
      choice: "↗",
      goto: "⇒",
      back: "←",
      forward: "→",
      auto: "·",
      history: "⏎",
    };

    const lines: string[] = [];
    if (this.activeCrawl.name) {
      lines.push(`  ${BOLD}${this.activeCrawl.name}${RESET}`);
      lines.push("");
    }

    const buildTree = (nodeId: string, depth: number): void => {
      const node = this.nodes.get(nodeId);
      if (!node) return;
      const indent = "  ".repeat(depth + 1);
      const isCurrent = nodeId === this.currentNodeId;
      const prefix = isCurrent ? `${CYAN}→${RESET}` : " ";
      const icon = reachedByIcon[node.reachedBy] || "·";

      // Title — bold if current
      const title = isCurrent ? `${BOLD}${WHITE}${node.title}${RESET}` : node.title;

      // Summary — truncated, dim
      let summaryStr = "";
      if (node.metadata?.summary) {
        const truncated =
          node.metadata.summary.length > 50
            ? node.metadata.summary.slice(0, 47) + "..."
            : node.metadata.summary;
        summaryStr = ` ${DIM}— ${truncated}${RESET}`;
      }

      lines.push(`${indent}${prefix} ${icon} ${title}${summaryStr}`);
      for (const childId of node.children) {
        buildTree(childId, depth + 1);
      }
    };
    buildTree(this.activeCrawl.rootId, 0);
    return lines.join("\n");
  }

  // ---------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------

  rebuildIndex(): void {
    this.nodeIndex.clear();
    for (const node of this.nodes.values()) {
      this.nodeIndex.set(node.url, node);
    }
  }

  private wouldCreateCycle(nodeId: string, newParentId: string): boolean {
    // If newParentId is in nodeId's subtree, attaching would create a cycle
    const subtreeIds = this.getSubtreeIds(nodeId);
    return subtreeIds.includes(newParentId);
  }

  private getSubtreeIds(rootId: string): string[] {
    const ids: string[] = [];
    const queue = [rootId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      ids.push(current);
      const node = this.nodes.get(current);
      if (node) {
        queue.push(...node.children);
      }
    }
    return ids;
  }
}
