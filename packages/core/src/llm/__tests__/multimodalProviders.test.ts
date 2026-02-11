import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OpenAIProvider } from '../OpenAIProvider.js';
import { GeminiProvider } from '../GeminiProvider.js';
import { OllamaProvider } from '../OllamaProvider.js';
import type { MessageAttachment } from '../../types.js';

async function createAttachmentFixture(): Promise<MessageAttachment> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-llm-attachment-'));
  const imagePath = path.join(root, 'sample.png');
  await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  return {
    id: 'att-1',
    filename: 'sample.png',
    contentType: 'image/png',
    sizeBytes: 4,
    path: imagePath,
    url: '/api/uploads/image?sessionId=web%3Atest&id=att-1',
  };
}

describe('multimodal provider conversions', () => {
  it('converts OpenAI user attachments to image_url content parts', async () => {
    const attachment = await createAttachmentFixture();
    const provider = new OpenAIProvider('test-key', 'gpt-4o');

    const converted = await (provider as any).convertMessages([
      {
        role: 'user',
        content: 'what is in this image?',
        attachments: [attachment],
      },
    ]);

    expect(converted).toHaveLength(1);
    expect(converted[0]).toMatchObject({ role: 'user' });
    expect(Array.isArray(converted[0].content)).toBe(true);
    const parts = converted[0].content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'text', text: 'what is in this image?' });
    expect(parts[1]?.['type']).toBe('image_url');
    const imageUrl = (parts[1]?.['image_url'] as Record<string, unknown> | undefined)?.['url'];
    expect(String(imageUrl)).toBe('data:image/png;base64,iVBORw==');
  });

  it('converts Gemini user attachments to inlineData parts', async () => {
    const attachment = await createAttachmentFixture();
    const provider = new GeminiProvider('test-key', 'gemini-1.5-pro');

    const converted = await (provider as any).convertMessages([
      {
        role: 'user',
        content: 'describe image',
        attachments: [attachment],
      },
    ]);

    expect(converted.systemInstruction).toBe('');
    expect(converted.contents).toHaveLength(1);
    expect(converted.contents[0]?.role).toBe('user');
    expect(converted.contents[0]?.parts[0]).toEqual({ text: 'describe image' });
    expect(converted.contents[0]?.parts[1]).toEqual({
      inlineData: {
        data: 'iVBORw==',
        mimeType: 'image/png',
      },
    });
  });

  it('converts Ollama user attachments to base64 images array', async () => {
    const attachment = await createAttachmentFixture();
    const provider = new OllamaProvider('llava');

    const converted = await (provider as any).convertMessages([
      {
        role: 'user',
        content: 'summarize',
        attachments: [attachment],
      },
    ]);

    expect(converted).toHaveLength(1);
    expect(converted[0]).toMatchObject({
      role: 'user',
      content: 'summarize',
      images: ['iVBORw=='],
    });
  });
});
