export function buildLatestScreenshotUrl(sessionId: string): string {
  return `/api/browser/latest?sessionId=${encodeURIComponent(sessionId)}`;
}

const SCREENSHOT_FILENAME_PATTERN = /^session-([A-Za-z0-9:_-]+)-step-\d+\.png$/i;
const SCREENSHOT_FILENAME_GLOBAL_PATTERN = /session-[A-Za-z0-9:_-]+-step-\d+\.png/gi;

export function buildScreenshotImageUrl(filename: string): string {
  return `/api/browser/image?filename=${encodeURIComponent(filename)}`;
}

export function parseScreenshotFilenameFromHref(
  href: string
): { filename: string; sessionId: string } | null {
  const trimmed = href.trim();
  if (!trimmed) {
    return null;
  }

  // Ignore fully-qualified URLs and browser-native URI schemes.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !trimmed.startsWith('session-')) {
    return null;
  }

  const withoutQuery = trimmed.split('#', 1)[0]?.split('?', 1)[0] ?? '';
  if (!withoutQuery) {
    return null;
  }

  const candidateRaw = withoutQuery.split('/').filter((part) => part.length > 0).at(-1) ?? withoutQuery;
  const candidate = safeDecodeURIComponent(candidateRaw);
  if (!candidate) {
    return null;
  }

  const match = candidate.match(SCREENSHOT_FILENAME_PATTERN);
  if (!match) {
    return null;
  }

  return {
    filename: candidate,
    sessionId: match[1]!,
  };
}

export function extractScreenshotFilenamesFromText(
  content: string
): Array<{ filename: string; sessionId: string }> {
  const results: Array<{ filename: string; sessionId: string }> = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null = null;
  SCREENSHOT_FILENAME_GLOBAL_PATTERN.lastIndex = 0;

  while ((match = SCREENSHOT_FILENAME_GLOBAL_PATTERN.exec(content)) !== null) {
    const parsed = parseScreenshotFilenameFromHref(match[0] ?? '');
    if (!parsed) {
      continue;
    }

    const key = parsed.filename.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(parsed);
  }

  return results;
}

export function shouldResetLatestScreenshotPreview(
  previousSessionId: string | null,
  nextSessionId: string | null
): boolean {
  return previousSessionId !== nextSessionId;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
