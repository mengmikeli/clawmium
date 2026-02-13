export interface PageInterpretation {
  pageType: "navigation" | "content" | "login" | "form" | "data" | "confirmation";
  summary: string;
  choices: Array<{
    index: number;
    label: string;
    action: "click" | "navigate";
    selector?: string;
    url?: string;
  }>;
  dataFound: Record<string, unknown> | null;
  requiresAuth: boolean;
  requiresHumanInput: boolean;
}

export interface AgentAction {
  type: "click" | "navigate" | "fill" | "extract" | "wait" | "ask_human";
  selector?: string;
  url?: string;
  value?: string;
  reason: string;
}

export interface ExtractedData {
  title: string;
  summary: string;
  fields: Record<string, unknown>;
  raw: unknown;
}

export interface ConversationContext {
  userGoal: string;
  history: Array<{ role: "user" | "agent"; content: string }>;
  currentUrl: string;
  interceptedData: unknown[];
}

export interface LLMProvider {
  interpret(pageContent: string, userGoal: string, conversationContext?: string): Promise<PageInterpretation>;
  planAction(interpretation: PageInterpretation, context: ConversationContext): Promise<AgentAction>;
  extractData(rawData: string, userGoal: string): Promise<ExtractedData>;
}
