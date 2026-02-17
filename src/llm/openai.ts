import OpenAI from "openai";
import {
  LLMProvider,
  PageInterpretation,
  AgentAction,
  ExtractedData,
  ConversationContext,
} from "./provider";
import {
  INTERPRET_SYSTEM_PROMPT,
  PLAN_ACTION_SYSTEM_PROMPT,
  EXTRACT_DATA_SYSTEM_PROMPT,
} from "./prompts";

function tokenLimit(envVar: string, fallback: number): number {
  const val = parseInt(process.env[envVar] || "", 10);
  return val > 0 ? val : fallback;
}

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model = "gpt-4o") {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async interpret(pageContent: string, userGoal: string, conversationContext?: string): Promise<PageInterpretation> {
    let userMessage = `User's goal: "${userGoal}"\n\nPage content:\n${pageContent}`;
    if (conversationContext) {
      userMessage += `\n\nConversation context (previous exchange on this page):\n${conversationContext}`;
    }

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: tokenLimit("MAX_TOKENS_INTERPRET", 2048),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: INTERPRET_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
    });

    const text = response.choices[0].message.content;
    if (!text) throw new Error("Empty response from OpenAI");
    return JSON.parse(text) as PageInterpretation;
  }

  async planAction(
    interpretation: PageInterpretation,
    context: ConversationContext
  ): Promise<AgentAction> {
    const lastUserMsg = context.history.filter((h) => h.role === "user").pop();

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: tokenLimit("MAX_TOKENS_PLAN", 512),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: PLAN_ACTION_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Page interpretation:\n${JSON.stringify(interpretation, null, 2)}\n\nUser's goal: "${context.userGoal}"\nCurrent URL: ${context.currentUrl}\nLast user input: "${lastUserMsg?.content || ""}"`,
        },
      ],
    });

    const text = response.choices[0].message.content;
    if (!text) throw new Error("Empty response from OpenAI");
    return JSON.parse(text) as AgentAction;
  }

  async extractData(rawData: string, userGoal: string): Promise<ExtractedData> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: tokenLimit("MAX_TOKENS_EXTRACT", 1024),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EXTRACT_DATA_SYSTEM_PROMPT },
        {
          role: "user",
          content: `User's goal: "${userGoal}"\n\nRaw API data:\n${rawData}`,
        },
      ],
    });

    const text = response.choices[0].message.content;
    if (!text) throw new Error("Empty response from OpenAI");
    return JSON.parse(text) as ExtractedData;
  }
}
