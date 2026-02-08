import { describe, expect, it } from 'vitest';
import { parseMessageSegments } from './messageContent';

describe('parseMessageSegments', () => {
  it('returns plain text when no fenced code blocks are present', () => {
    expect(parseMessageSegments('Hello world')).toEqual([
      { type: 'text', content: 'Hello world' },
    ]);
  });

  it('parses fenced code blocks with language and surrounding text', () => {
    const content = 'Intro text\n```python\nprint("hi")\n```\nOutro';
    expect(parseMessageSegments(content)).toEqual([
      { type: 'text', content: 'Intro text\n' },
      { type: 'code', language: 'python', content: 'print("hi")' },
      { type: 'text', content: '\nOutro' },
    ]);
  });

  it('parses malformed single-line fences and still extracts code', () => {
    const content = '``` python name = "Master" print(name) ```';
    expect(parseMessageSegments(content)).toEqual([
      { type: 'code', language: 'python', content: 'name = "Master" print(name)' },
    ]);
  });

  it('keeps unmatched fences as text', () => {
    const content = '```python\nprint("broken")';
    expect(parseMessageSegments(content)).toEqual([
      { type: 'text', content },
    ]);
  });
});
