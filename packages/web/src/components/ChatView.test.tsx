import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  CHAT_MARKDOWN_COMPONENTS,
  buildNextPendingAttachments,
  deriveAssistantAvatar,
  removePendingComposerAttachment,
  validateComposerAttachmentFile,
  type PendingComposerAttachment,
} from './ChatView';

interface FakeFile {
  name: string;
  size: number;
  lastModified: number;
  type: string;
}

function makeFile(overrides: Partial<FakeFile> = {}): FakeFile {
  return {
    name: 'image.png',
    size: 128,
    lastModified: 1,
    type: 'image/png',
    ...overrides,
  };
}

describe('ChatView attachment helpers', () => {
  it('adds valid images and deduplicates by filename+size+mtime', () => {
    const file = makeFile();

    const first = buildNextPendingAttachments([], [file], {
      createId: () => 'one',
      createPreviewUrl: (input) => `blob:${input.name}`,
    });

    expect(first.error).toBeNull();
    expect(first.next).toHaveLength(1);
    expect(first.next[0]).toMatchObject({
      id: 'one',
      dedupeKey: 'image.png:128:1',
      previewUrl: 'blob:image.png',
    });

    const second = buildNextPendingAttachments(first.next, [file], {
      createId: () => 'two',
      createPreviewUrl: (input) => `blob:${input.name}`,
    });

    expect(second.error).toBeNull();
    expect(second.next).toHaveLength(1);
  });

  it('returns validation errors for unsupported or oversized files', () => {
    expect(validateComposerAttachmentFile({ type: 'application/pdf', size: 1 })).toBe(
      'Only PNG, JPEG, WEBP, and GIF images are supported.'
    );

    expect(validateComposerAttachmentFile({ type: 'image/png', size: 11 * 1024 * 1024 })).toBe(
      'Each image must be 10MB or smaller.'
    );
  });

  it('enforces max image count when building pending attachments', () => {
    const previous: PendingComposerAttachment<FakeFile>[] = Array.from({ length: 5 }, (_, index) => ({
      id: `id-${index}`,
      dedupeKey: `file-${index}`,
      previewUrl: `blob:file-${index}`,
      file: makeFile({ name: `file-${index}.png`, lastModified: index }),
    }));

    const result = buildNextPendingAttachments(previous, [makeFile({ name: 'overflow.png' })], {
      createId: () => 'overflow',
      createPreviewUrl: () => 'blob:overflow',
    });

    expect(result.next).toHaveLength(5);
    expect(result.error).toBe('You can attach up to 5 images per message.');
  });

  it('removes a pending attachment by id', () => {
    const previous: PendingComposerAttachment<FakeFile>[] = [{
      id: 'first',
      dedupeKey: 'first',
      previewUrl: 'blob:first',
      file: makeFile(),
    }];

    const result = removePendingComposerAttachment(previous, 'first');
    expect(result.removed?.id).toBe('first');
    expect(result.next).toEqual([]);
  });
});

describe('ChatView markdown image rendering', () => {
  it('applies markdown image class and wraps images in external links', () => {
    const html = renderToStaticMarkup(
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={CHAT_MARKDOWN_COMPONENTS}>
        {'![diagram](https://example.com/diagram.png)'}
      </ReactMarkdown>
    );

    expect(html).toContain('class="message-markdown-image"');
    expect(html).toContain('href="https://example.com/diagram.png"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });
});

describe('ChatView assistant avatar derivation', () => {
  function makeMessage(
    id: string,
    role: 'user' | 'assistant',
    content: string
  ): Parameters<typeof deriveAssistantAvatar>[0][number] {
    return {
      id,
      role,
      content,
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    };
  }

  it('defaults to K when no signature emoji is present', () => {
    const avatar = deriveAssistantAvatar([
      makeMessage('a1', 'assistant', 'Hello there'),
      makeMessage('u1', 'user', 'Can you help me?'),
    ]);

    expect(avatar).toBe('K');
  });

  it('uses explicit signature emoji from a user message', () => {
    const avatar = deriveAssistantAvatar([
      makeMessage('u1', 'user', 'Name: Keygate\nSignature emoji: 🤖'),
      makeMessage('a1', 'assistant', 'Configured.'),
    ]);

    expect(avatar).toBe('🤖');
  });

  it('uses a standalone emoji sent by the user as signature emoji', () => {
    const avatar = deriveAssistantAvatar([
      makeMessage('a1', 'assistant', 'Choose an emoji.'),
      makeMessage('u1', 'user', '🔥'),
    ]);

    expect(avatar).toBe('🔥');
  });

  it('prefers the latest user signature emoji', () => {
    const avatar = deriveAssistantAvatar([
      makeMessage('u1', 'user', 'Signature emoji: 😺'),
      makeMessage('a1', 'assistant', 'Saved.'),
      makeMessage('u2', 'user', 'Signature emoji: 🧠'),
    ]);

    expect(avatar).toBe('🧠');
  });
});
