import OpenAI from 'openai';
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
 * OpenAI LLM Provider
 */
export class OpenAIProvider implements LLMProvider {
  name = 'openai';
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: this.convertMessages(messages),
      tools: options?.tools ? this.convertTools(options.tools) : undefined,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens,
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error('No response from OpenAI');
    }

    const toolCalls = choice.message.tool_calls?.map((tc): ToolCall => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    return {
      content: choice.message.content ?? '',
      toolCalls,
      finishReason: this.mapFinishReason(choice.finish_reason),
    };
  }

  async *stream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: this.convertMessages(messages),
      tools: options?.tools ? this.convertTools(options.tools) : undefined,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens,
      stream: true,
    });

    const toolCallsAccumulator: Map<number, { id: string; name: string; arguments: string }> = new Map();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      // Accumulate tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallsAccumulator.get(tc.index);
          if (existing) {
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments;
            }
          } else {
            toolCallsAccumulator.set(tc.index, {
              id: tc.id ?? '',
              name: tc.function?.name ?? '',
              arguments: tc.function?.arguments ?? '',
            });
          }
        }
      }

      yield {
        content: delta.content ?? undefined,
        done: chunk.choices[0]?.finish_reason !== null,
      };
    }

    // Emit final tool calls if any
    if (toolCallsAccumulator.size > 0) {
      const toolCalls: ToolCall[] = Array.from(toolCallsAccumulator.values()).map(tc => ({
        id: tc.id,
        name: tc.name,
        arguments: JSON.parse(tc.arguments || '{}') as Record<string, unknown>,
      }));

      yield {
        toolCalls,
        done: true,
      };
    }
  }

  private convertMessages(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
    return messages.map((m): OpenAI.ChatCompletionMessageParam => {
      if (m.role === 'tool') {
        return {
          role: 'tool',
          content: m.content,
          tool_call_id: m.toolCallId ?? '',
        };
      }
      if (m.role === 'assistant' && m.toolCalls) {
        return {
          role: 'assistant',
          content: m.content,
          tool_calls: m.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        };
      }
      return {
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
      };
    });
  }

  private convertTools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
    return tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as OpenAI.FunctionParameters,
      },
    }));
  }

  private mapFinishReason(reason: string | null): LLMResponse['finishReason'] {
    switch (reason) {
      case 'stop': return 'stop';
      case 'tool_calls': return 'tool_calls';
      case 'length': return 'length';
      default: return 'stop';
    }
  }
}
