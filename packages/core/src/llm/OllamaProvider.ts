
import { Ollama } from 'ollama';
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
    const response = await this.client.chat({
      model: this.model,
      messages: this.convertMessages(messages),
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
    const stream = await this.client.chat({
      model: this.model,
      messages: this.convertMessages(messages),
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

  private convertMessages(messages: Message[]): { role: string; content: string; tool_calls?: any[] }[] {
    return messages.map(msg => {
        if (msg.role === 'tool') {
             // Ollama expects tool outputs in a specific way within chat history.
             // Currently, the official JS SDK maps roles: system, user, assistant, tool.
             // For 'tool' role, content is the result.
             return {
                 role: 'tool',
                 content: msg.content,
             };
        }
        
        // Handle assistant tool calls in history
        if (msg.role === 'assistant' && msg.toolCalls) {
             return {
                 role: 'assistant',
                 content: msg.content || '',
                 tool_calls: msg.toolCalls.map(tc => ({
                     function: {
                         name: tc.name,
                         arguments: tc.arguments,
                     }
                 }))
             }
        }

        return {
            role: msg.role,
            content: msg.content,
        };
    });
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
