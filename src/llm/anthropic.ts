import Anthropic from "@anthropic-ai/sdk";
import {
  LLMProvider,
  PageInterpretation,
  AgentAction,
  AutoPlanResult,
  ExtractedData,
  ConversationContext,
} from "./provider";
import {
  INTERPRET_SYSTEM_PROMPT,
  PLAN_ACTION_SYSTEM_PROMPT,
  AUTO_PLAN_SYSTEM_PROMPT,
  EXTRACT_DATA_SYSTEM_PROMPT,
} from "./prompts";

function tokenLimit(envVar: string, fallback: number): number {
  const val = parseInt(process.env[envVar] || "", 10);
  return val > 0 ? val : fallback;
}

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model = "claude-sonnet-4-20250514") {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async interpret(pageContent: string, userGoal: string, conversationContext?: string): Promise<PageInterpretation> {
    let userMessage = `User's goal: "${userGoal}"\n\nPage content:\n${pageContent}`;
    if (conversationContext) {
      userMessage += `\n\nConversation context (previous exchange on this page):\n${conversationContext}`;
    }

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: tokenLimit("MAX_TOKENS_INTERPRET", 2048),
      system: INTERPRET_SYSTEM_PROMPT(),
      messages: [
        { role: "user", content: userMessage },
      ],
    });

    const text = response.content[0];
    if (text.type !== "text") throw new Error("Unexpected response type");
    return JSON.parse(text.text) as PageInterpretation;
  }

  async planAction(
    interpretation: PageInterpretation,
    context: ConversationContext
  ): Promise<AgentAction> {
    const lastUserMsg = context.history.filter((h) => h.role === "user").pop();

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: tokenLimit("MAX_TOKENS_PLAN", 512),
      system: PLAN_ACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Page interpretation:\n${JSON.stringify(interpretation, null, 2)}\n\nUser's goal: "${context.userGoal}"\nCurrent URL: ${context.currentUrl}\nLast user input: "${lastUserMsg?.content || ""}"`,
        },
      ],
    });

    const text = response.content[0];
    if (text.type !== "text") throw new Error("Unexpected response type");
    return JSON.parse(text.text) as AgentAction;
  }

  async planAutoAction(formattedContext: string): Promise<AutoPlanResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: tokenLimit("MAX_TOKENS_PLAN", 512),
      system: AUTO_PLAN_SYSTEM_PROMPT,
      messages: [
        { role: "user", content: formattedContext },
      ],
    });

    const text = response.content[0];
    if (text.type !== "text") throw new Error("Unexpected response type");
    return JSON.parse(text.text) as AutoPlanResult;
  }

  async extractData(rawData: string, userGoal: string): Promise<ExtractedData> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: tokenLimit("MAX_TOKENS_EXTRACT", 1024),
      system: EXTRACT_DATA_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `User's goal: "${userGoal}"\n\nRaw API data:\n${rawData}`,
        },
      ],
    });

    const text = response.content[0];
    if (text.type !== "text") throw new Error("Unexpected response type");
    return JSON.parse(text.text) as ExtractedData;
  }
}
