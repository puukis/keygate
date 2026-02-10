import { describe, expect, it } from 'vitest';
import {
  buildLatestScreenshotUrl,
  buildScreenshotImageUrl,
  extractScreenshotFilenamesFromText,
  parseScreenshotFilenameFromHref,
  shouldResetLatestScreenshotPreview,
} from '../src/browserPreview';

describe('browser preview helpers', () => {
  it('builds latest screenshot URL per session id', () => {
    const first = buildLatestScreenshotUrl('web:session-a');
    const second = buildLatestScreenshotUrl('web:session-b');

    expect(first).toBe('/api/browser/latest?sessionId=web%3Asession-a');
    expect(second).toBe('/api/browser/latest?sessionId=web%3Asession-b');
    expect(first).not.toBe(second);
  });

  it('signals preview reset when active session changes', () => {
    expect(shouldResetLatestScreenshotPreview('web:1', 'web:2')).toBe(true);
    expect(shouldResetLatestScreenshotPreview('web:1', 'web:1')).toBe(false);
    expect(shouldResetLatestScreenshotPreview('web:1', null)).toBe(true);
  });

  it('builds screenshot image URL by filename', () => {
    expect(buildScreenshotImageUrl('session-web:abc-step-1.png'))
      .toBe('/api/browser/image?filename=session-web%3Aabc-step-1.png');
  });

  it('parses screenshot filenames from chat links', () => {
    expect(parseScreenshotFilenameFromHref('session-web:abc-step-1.png')).toEqual({
      filename: 'session-web:abc-step-1.png',
      sessionId: 'web:abc',
    });

    expect(parseScreenshotFilenameFromHref('./session-web:abc-step-2.png')).toEqual({
      filename: 'session-web:abc-step-2.png',
      sessionId: 'web:abc',
    });

    expect(parseScreenshotFilenameFromHref('https://example.com/session-web:abc-step-1.png')).toBeNull();
    expect(parseScreenshotFilenameFromHref('../etc/passwd')).toBeNull();
  });

  it('extracts screenshot filenames from plain assistant text', () => {
    expect(
      extractScreenshotFilenamesFromText(
        'Saved screenshot as `session-web:abc-step-1.png` and also session-web:abc-step-1.png'
      )
    ).toEqual([
      {
        filename: 'session-web:abc-step-1.png',
        sessionId: 'web:abc',
      },
    ]);
  });
});
