
import { Ollama } from 'ollama';
import { readAttachmentAsBase64 } from './attachments.js';
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
 * Local Ollama LLM Provider
 */
export class OllamaProvider implements LLMProvider {
  name = 'ollama';
  private client: Ollama;
  private model: string;

  constructor(model: string, host: string = 'http://127.0.0.1:11434') {
    this.client = new Ollama({ host });
    this.model = model;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    const convertedMessages = await this.convertMessages(messages);
    const response = await this.client.chat({
      model: this.model,
      messages: convertedMessages,
      stream: false,
      tools: options?.tools ? this.convertTools(options.tools) : undefined,
      options: {
        temperature: options?.temperature,
        num_predict: options?.maxTokens,
      },
    });

    // Handle tool calls if present
    const toolCalls: ToolCall[] | undefined = response.message.tool_calls?.map((tc, index) => ({
      id: `call_${index}`, // Ollama sometimes doesn't provide IDs, so we generate one
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));

    return {
      content: response.message.content,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: toolCalls && toolCalls.length > 0 ? 'tool_calls' : 'stop',
    };
  }

  async *stream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk> {
    const convertedMessages = await this.convertMessages(messages);
    const stream = await this.client.chat({
      model: this.model,
      messages: convertedMessages,
      stream: true,
      tools: options?.tools ? this.convertTools(options.tools) : undefined,
      options: {
        temperature: options?.temperature,
        num_predict: options?.maxTokens,
      },
    });

    for await (const part of stream) {
      if (part.message.tool_calls) {
        // Ollama streaming tool calls usually come in one chunk at the end or aggregated
        // We'll yield them as a final chunk
        const toolCalls: ToolCall[] = part.message.tool_calls.map((tc, index) => ({
            id: `call_${index}`,
            name: tc.function.name,
            arguments: tc.function.arguments,
        }));
        
        yield {
            toolCalls,
            done: part.done,
        };
      }
      
      yield {
        content: part.message.content,
        done: part.done,
      };
    }
  }

  private async convertMessages(
    messages: Message[]
  ): Promise<{ role: string; content: string; tool_calls?: any[]; images?: string[] }[]> {
    const converted: Array<{ role: string; content: string; tool_calls?: any[]; images?: string[] }> = [];

    for (const msg of messages) {
      if (msg.role === 'tool') {
        converted.push({
          role: 'tool',
          content: msg.content,
        });
        continue;
      }

      if (msg.role === 'assistant' && msg.toolCalls) {
        converted.push({
          role: 'assistant',
          content: msg.content || '',
          tool_calls: msg.toolCalls.map((tc) => ({
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          })),
        });
        continue;
      }

      const entry: { role: string; content: string; images?: string[] } = {
        role: msg.role,
        content: msg.content,
      };

      if (msg.role === 'user' && msg.attachments && msg.attachments.length > 0) {
        const images: string[] = [];
        for (const attachment of msg.attachments) {
          const payload = await readAttachmentAsBase64(attachment);
          if (!payload) {
            continue;
          }

          images.push(payload.base64);
        }

        if (images.length > 0) {
          entry.images = images;
        }
      }

      converted.push(entry);
    }

    return converted;
  }

  private convertTools(tools: ToolDefinition[]): any[] {
     return tools.map(t => ({
         type: 'function',
         function: {
             name: t.name,
             description: t.description,
             parameters: t.parameters,
         }
     }));
  }
}
