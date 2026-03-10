/**
 * Convert Markdown to Telegram HTML.
 *
 * Telegram's HTML parse mode supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a>, <tg-spoiler>
 * All other HTML characters in non-code content must be escaped.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown) {
    return '';
  }

  const lines = markdown.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let codeLang = '';
  let codeBuffer: string[] = [];

  for (const line of lines) {
    // Fenced code block start/end
    const fenceMatch = line.match(/^```(\w*)$/);
    if (fenceMatch) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = fenceMatch[1] ?? '';
        codeBuffer = [];
      } else {
        // Close code block
        inCodeBlock = false;
        const codeContent = escapeHtml(codeBuffer.join('\n'));
        const langAttr = codeLang ? ` class="language-${codeLang}"` : '';
        result.push(`<pre><code${langAttr}>${codeContent}</code></pre>`);
        codeLang = '';
        codeBuffer = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    // Process inline formatting
    let processed = processInlineLine(line);
    result.push(processed);
  }

  // Close unclosed code block
  if (inCodeBlock && codeBuffer.length > 0) {
    const codeContent = escapeHtml(codeBuffer.join('\n'));
    result.push(`<pre><code>${codeContent}</code></pre>`);
  }

  return result.join('\n');
}

function processInlineLine(line: string): string {
  // We process the line character by character to handle nested/adjacent patterns correctly.
  // Order matters: code spans first (to avoid processing their contents), then bold, italic, strikethrough.

  // 1. Extract and protect inline code spans
  const codeSpans: string[] = [];
  let protected_ = line.replace(/`([^`]+)`/g, (_match, code: string) => {
    const idx = codeSpans.length;
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00CODE${idx}\x00`;
  });

  // 2. Escape HTML in remaining text (non-code portions)
  protected_ = protected_.replace(/([^&<>\x00]+)/g, (segment) => {
    // Only escape if it doesn't contain our placeholders
    if (segment.includes('\x00')) return segment;
    return escapeHtml(segment);
  });

  // 3. Bold: **text** or __text__
  protected_ = protected_.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  protected_ = protected_.replace(/__([^_]+)__/g, '<b>$1</b>');

  // 4. Italic: *text* or _text_ (single, not part of bold)
  protected_ = protected_.replace(/\*([^*\n]+)\*/g, '<i>$1</i>');
  protected_ = protected_.replace(/_([^_\n]+)_/g, '<i>$1</i>');

  // 5. Strikethrough: ~~text~~
  protected_ = protected_.replace(/~~([^~]+)~~/g, '<s>$1</s>');

  // 6. Restore code spans
  protected_ = protected_.replace(/\x00CODE(\d+)\x00/g, (_match, idx: string) => codeSpans[Number(idx)] ?? '');

  return protected_;
}

/**
 * Split HTML content into chunks that fit within Telegram's 4096-char limit.
 * Tries to split at paragraph boundaries, then sentence boundaries, then hard cuts.
 */
export function chunkHtml(html: string, maxLen = 4000): string[] {
  if (html.length <= maxLen) {
    return [html];
  }

  const chunks: string[] = [];
  let remaining = html;

  while (remaining.length > maxLen) {
    // Try to split at a double newline (paragraph)
    let breakPoint = remaining.lastIndexOf('\n\n', maxLen);
    if (breakPoint > maxLen / 2) {
      chunks.push(remaining.slice(0, breakPoint));
      remaining = remaining.slice(breakPoint + 2).trimStart();
      continue;
    }

    // Try to split at a single newline
    breakPoint = remaining.lastIndexOf('\n', maxLen);
    if (breakPoint > maxLen / 2) {
      chunks.push(remaining.slice(0, breakPoint));
      remaining = remaining.slice(breakPoint + 1).trimStart();
      continue;
    }

    // Try to split at a sentence boundary
    breakPoint = remaining.lastIndexOf('. ', maxLen);
    if (breakPoint > maxLen / 2) {
      chunks.push(remaining.slice(0, breakPoint + 1));
      remaining = remaining.slice(breakPoint + 2).trimStart();
      continue;
    }

    // Hard cut
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
