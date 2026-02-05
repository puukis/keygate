import {
  GoogleGenerativeAI,
  SchemaType,
  type Part,
  type Content,
  type FunctionDeclaration,
} from '@google/generative-ai';
import type {
  ChatOptions,
  LLMChunk,
  LLMProvider,
  LLMResponse,
  Message,
  ToolCall,
  ToolDefinition,
} from '../types.js';

/**
 * Google Gemini LLM Provider
 */
export class GeminiProvider implements LLMProvider {
  name = 'gemini';
  private client: GoogleGenerativeAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new GoogleGenerativeAI(apiKey);
    this.model = model;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    const { systemInstruction, contents } = this.convertMessages(messages);
    
    const geminiTools = options?.tools 
      ? [{ functionDeclarations: this.convertTools(options.tools) }] 
      : undefined;

    const model = this.client.getGenerativeModel({
      model: this.model,
      systemInstruction,
      tools: geminiTools as Parameters<typeof this.client.getGenerativeModel>[0]['tools'],
    });

    const result = await model.generateContent({
      contents,
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxTokens,
      },
    });

    const response = result.response;
    const text = response.text();
    
    // Extract function calls
    const functionCalls = response.functionCalls();
    const toolCalls: ToolCall[] | undefined = functionCalls?.map((fc, index) => ({
      id: `call_${index}`,
      name: fc.name,
      arguments: fc.args as Record<string, unknown>,
    }));

    return {
      content: text,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: toolCalls && toolCalls.length > 0 ? 'tool_calls' : 'stop',
    };
  }

  async *stream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk> {
    const { systemInstruction, contents } = this.convertMessages(messages);
    
    const geminiTools = options?.tools 
      ? [{ functionDeclarations: this.convertTools(options.tools) }] 
      : undefined;

    const model = this.client.getGenerativeModel({
      model: this.model,
      systemInstruction,
      tools: geminiTools as Parameters<typeof this.client.getGenerativeModel>[0]['tools'],
    });

    const result = await model.generateContentStream({
      contents,
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxTokens,
      },
    });

    let accumulatedToolCalls: ToolCall[] = [];

    for await (const chunk of result.stream) {
      const text = chunk.text();
      const functionCalls = chunk.functionCalls();

      if (functionCalls && functionCalls.length > 0) {
        accumulatedToolCalls = functionCalls.map((fc, index) => ({
          id: `call_${index}`,
          name: fc.name,
          arguments: fc.args as Record<string, unknown>,
        }));
      }

      yield {
        content: text || undefined,
        done: false,
      };
    }

    yield {
      toolCalls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
      done: true,
    };
  }

  private convertMessages(messages: Message[]): { systemInstruction: string; contents: Content[] } {
    let systemInstruction = '';
    const contents: Content[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = msg.content;
        continue;
      }

      if (msg.role === 'user') {
        contents.push({
          role: 'user',
          parts: [{ text: msg.content }],
        });
      } else if (msg.role === 'assistant') {
        const parts: Part[] = [{ text: msg.content }];
        
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            parts.push({
              functionCall: {
                name: tc.name,
                args: tc.arguments,
              },
            });
          }
        }
        
        contents.push({ role: 'model', parts });
      } else if (msg.role === 'tool') {
        // Find the corresponding function call to get the name
        let prevAssistant: Content | undefined;
        for (let i = contents.length - 1; i >= 0; i--) {
          if (contents[i]!.role === 'model') {
            prevAssistant = contents[i];
            break;
          }
        }
        const funcCallPart = prevAssistant?.parts.find(
          (p: Part): p is Part & { functionCall: { name: string } } => 'functionCall' in p
        );
        
        contents.push({
          role: 'function',
          parts: [{
            functionResponse: {
              name: funcCallPart?.functionCall?.name ?? 'unknown',
              response: { result: msg.content },
            },
          }],
        });
      }
    }

    return { systemInstruction, contents };
  }

  private convertTools(tools: ToolDefinition[]): FunctionDeclaration[] {
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: {
        type: SchemaType.OBJECT,
        properties: (t.parameters as Record<string, unknown>)['properties'] as Record<string, unknown> ?? {},
        required: (t.parameters as Record<string, unknown>)['required'] as string[] ?? [],
      },
    })) as FunctionDeclaration[];
  }
}
