export interface PageInterpretation {
  pageType: "navigation" | "content" | "login" | "form" | "data" | "confirmation";
  summary: string;
  choices: Array<{
    index: number;
    label: string;
    action: "click" | "navigate" | "fill";
    selector?: string;
    url?: string;
    // Fill plan — LLM specifies how to interact with this form
    fillPlan?: {
      inputSelector: string;        // CSS selector for the primary input to fill
      submitAction: "enter" | "click";  // press Enter on input, or click a button
      submitSelector?: string;      // CSS selector for submit button (when submitAction is "click")
    };
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

export interface AutoPlanResult {
  choiceIndex?: number;
  type?: "extract" | "fill" | "ask_human";
  value?: string;         // for fill actions
  reasoning: string;
}

export interface ExtractedData {
  title: string;
  summary: string;
  fields: Record<string, unknown>;
  raw: unknown;
}

export interface GoalContext {
  baseGoal: string;      // "browsing HN", "check my water bill"
  activeIntent: string;  // "looking for AI articles"
  breadcrumb: string[];  // last 3 nav steps: ["HN front page", "AI article title"]
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
  planAutoAction(formattedContext: string): Promise<AutoPlanResult>;
  extractData(rawData: string, userGoal: string): Promise<ExtractedData>;
}
