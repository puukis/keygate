const CAPABILITY_LIMIT_CONTEXT_PATTERN = /(capabilit|limit|safe mode)/i;
const INLINE_BULLET_PATTERN = /:[ \t]*-\s+/;
const INLINE_COLON_LIST_PATTERN = /:[ \t]*-\s+/g;
const HEADING_KEYWORD_PATTERN = /\b(?:capabilit\w*|limit\w*|safe mode)\b/gi;

interface InlineSection {
  start: number;
  bodyStart: number;
  heading: string;
}

export function formatCapabilitiesAndLimitsForReadability(content: string): string {
  if (!CAPABILITY_LIMIT_CONTEXT_PATTERN.test(content) || !INLINE_BULLET_PATTERN.test(content)) {
    return content;
  }

  const sections: InlineSection[] = [];
  let match: RegExpExecArray | null = null;
  INLINE_COLON_LIST_PATTERN.lastIndex = 0;

  while ((match = INLINE_COLON_LIST_PATTERN.exec(content)) !== null) {
    const colonIndex = match.index;
    const headingStart = findHeadingStart(content, colonIndex);
    if (headingStart === null) {
      continue;
    }

    const heading = content.slice(headingStart, colonIndex).trim();
    if (heading.length === 0 || !CAPABILITY_LIMIT_CONTEXT_PATTERN.test(heading)) {
      continue;
    }

    sections.push({
      start: headingStart,
      bodyStart: INLINE_COLON_LIST_PATTERN.lastIndex,
      heading,
    });
  }

  if (sections.length === 0) {
    return content;
  }

  let rewritten = '';
  let cursor = 0;

  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    const nextStart = sections[index + 1]?.start ?? content.length;
    const rawBody = content.slice(section.bodyStart, nextStart).trim();
    const items = rawBody
      .split(/\s+-\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    rewritten += content.slice(cursor, section.start);

    if (items.length === 0) {
      rewritten += content.slice(section.start, nextStart);
    } else {
      const formattedSection = `${section.heading}:\n${items.map((item) => `- ${item}`).join('\n')}`;
      const hasNextSection = index < sections.length - 1;
      rewritten += hasNextSection ? `${formattedSection}\n` : formattedSection;
    }

    cursor = nextStart;
  }

  rewritten += content.slice(cursor);
  return rewritten;
}

function findHeadingStart(content: string, colonIndex: number): number | null {
  const windowStart = Math.max(0, colonIndex - 180);
  const segment = content.slice(windowStart, colonIndex);
  HEADING_KEYWORD_PATTERN.lastIndex = 0;

  let keywordMatch: RegExpExecArray | null = null;
  let lastKeywordIndex: number | null = null;

  while ((keywordMatch = HEADING_KEYWORD_PATTERN.exec(segment)) !== null) {
    lastKeywordIndex = keywordMatch.index;
  }

  if (lastKeywordIndex === null) {
    return null;
  }

  let start = windowStart + lastKeywordIndex;
  while (start > 0) {
    const current = content[start];
    const previous = content[start - 1];
    const previousPrevious = start > 1 ? content[start - 2] : '';

    if (previous === '\n' || previous === '\r') {
      break;
    }

    if (previous === '-' && previousPrevious === ' ') {
      break;
    }

    if (previous === ':' || previous === ';') {
      break;
    }

    if (
      previous === ' ' &&
      /[A-Z]/.test(current) &&
      /[a-z0-9)/]/.test(previousPrevious)
    ) {
      break;
    }

    start -= 1;
  }

  return start;
}
