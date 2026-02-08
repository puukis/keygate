export type MessageSegment =
  | { type: 'text'; content: string }
  | { type: 'code'; content: string; language: string | null };

const FENCED_CODE_BLOCK_PATTERN = /```(?:\s*([a-zA-Z0-9_+-]+))?[ \t]*\n?([\s\S]*?)```/g;

export function parseMessageSegments(content: string): MessageSegment[] {
  if (!content.includes('```')) {
    return [{ type: 'text', content }];
  }

  const segments: MessageSegment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null = null;
  FENCED_CODE_BLOCK_PATTERN.lastIndex = 0;

  while ((match = FENCED_CODE_BLOCK_PATTERN.exec(content)) !== null) {
    const start = match.index;
    const end = FENCED_CODE_BLOCK_PATTERN.lastIndex;
    const full = match[0];
    const language = match[1]?.trim() || null;
    const code = normalizeCodeBlockContent(match[2] ?? '', language, full);

    if (start > cursor) {
      segments.push({ type: 'text', content: content.slice(cursor, start) });
    }

    segments.push({
      type: 'code',
      content: code,
      language,
    });

    cursor = end;
  }

  if (segments.length === 0) {
    return [{ type: 'text', content }];
  }

  if (cursor < content.length) {
    segments.push({ type: 'text', content: content.slice(cursor) });
  }

  return segments;
}

function normalizeCodeBlockContent(raw: string, language: string | null, fullMatch: string): string {
  let normalized = raw;

  if (language) {
    // Handle malformed fences such as: ``` python code... ```
    // by stripping the optional language token from the first line.
    const normalizedOpening = fullMatch.slice(0, fullMatch.indexOf(raw));
    const openingHasLineBreak = normalizedOpening.includes('\n');
    if (!openingHasLineBreak) {
      normalized = normalized.replace(/^[ \t]+/, '');
    }
  }

  return normalized.replace(/\n$/, '').replace(/[ \t]+$/, '');
}
