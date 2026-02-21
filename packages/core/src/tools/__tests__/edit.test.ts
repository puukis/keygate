import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { editFileTool, applyPatchTool } from '../builtin/edit.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'keygate-edit-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('edit_file', () => {
  it('replaces a unique occurrence of old_text with new_text', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await fs.writeFile(filePath, 'hello world\nfoo bar\nbaz qux\n');

    const result = await editFileTool.handler({
      path: filePath,
      old_text: 'foo bar',
      new_text: 'FOO BAR',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('File edited');
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('hello world\nFOO BAR\nbaz qux\n');
  });

  it('replaces multi-line old_text', async () => {
    const filePath = path.join(tmpDir, 'multi.txt');
    await fs.writeFile(filePath, 'line1\nline2\nline3\nline4\n');

    const result = await editFileTool.handler({
      path: filePath,
      old_text: 'line2\nline3',
      new_text: 'REPLACED_A\nREPLACED_B\nREPLACED_C',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('+1 net');
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('line1\nREPLACED_A\nREPLACED_B\nREPLACED_C\nline4\n');
  });

  it('fails when old_text is not found', async () => {
    const filePath = path.join(tmpDir, 'missing.txt');
    await fs.writeFile(filePath, 'hello world\n');

    const result = await editFileTool.handler({
      path: filePath,
      old_text: 'does not exist',
      new_text: 'replacement',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('old_text not found');
  });

  it('fails when old_text appears multiple times', async () => {
    const filePath = path.join(tmpDir, 'dups.txt');
    await fs.writeFile(filePath, 'foo\nbar\nfoo\n');

    const result = await editFileTool.handler({
      path: filePath,
      old_text: 'foo',
      new_text: 'baz',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('appears 2 times');
  });

  it('suggests a close match when whitespace differs', async () => {
    const filePath = path.join(tmpDir, 'indent.txt');
    await fs.writeFile(filePath, '  function hello() {\n    return 1;\n  }\n');

    const result = await editFileTool.handler({
      path: filePath,
      old_text: 'function hello() {\nreturn 1;\n}',
      new_text: 'nope',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Closest match found');
    expect(result.error).toContain('function hello()');
  });

  it('fails when file does not exist', async () => {
    const result = await editFileTool.handler({
      path: path.join(tmpDir, 'nonexistent.txt'),
      old_text: 'a',
      new_text: 'b',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('apply_patch', () => {
  it('applies a simple single-hunk patch', async () => {
    const filePath = path.join(tmpDir, 'patch.txt');
    await fs.writeFile(filePath, 'line1\nline2\nline3\nline4\n');

    const patch = [
      '--- a/patch.txt',
      '+++ b/patch.txt',
      '@@ -2,2 +2,2 @@',
      '-line2',
      '-line3',
      '+LINE2',
      '+LINE3',
    ].join('\n');

    const result = await applyPatchTool.handler({ path: filePath, patch });

    expect(result.success).toBe(true);
    expect(result.output).toContain('1 hunk');
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('line1\nLINE2\nLINE3\nline4\n');
  });

  it('applies a patch that adds lines', async () => {
    const filePath = path.join(tmpDir, 'add.txt');
    await fs.writeFile(filePath, 'a\nb\nc\n');

    const patch = [
      '@@ -2,1 +2,3 @@',
      '-b',
      '+B',
      '+B2',
      '+B3',
    ].join('\n');

    const result = await applyPatchTool.handler({ path: filePath, patch });

    expect(result.success).toBe(true);
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('a\nB\nB2\nB3\nc\n');
  });

  it('applies a patch that removes lines', async () => {
    const filePath = path.join(tmpDir, 'remove.txt');
    await fs.writeFile(filePath, 'a\nb\nc\nd\n');

    const patch = [
      '@@ -2,2 +2,0 @@',
      '-b',
      '-c',
    ].join('\n');

    const result = await applyPatchTool.handler({ path: filePath, patch });

    expect(result.success).toBe(true);
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('a\nd\n');
  });

  it('applies a patch with context lines', async () => {
    const filePath = path.join(tmpDir, 'context.txt');
    await fs.writeFile(filePath, 'a\nb\nc\nd\ne\n');

    const patch = [
      '@@ -2,3 +2,3 @@',
      ' b',
      '-c',
      '+C',
      ' d',
    ].join('\n');

    const result = await applyPatchTool.handler({ path: filePath, patch });

    expect(result.success).toBe(true);
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('a\nb\nC\nd\ne\n');
  });

  it('fails when context lines do not match', async () => {
    const filePath = path.join(tmpDir, 'bad-context.txt');
    await fs.writeFile(filePath, 'a\nb\nc\n');

    const patch = [
      '@@ -1,2 +1,2 @@',
      ' x',
      '-b',
      '+B',
    ].join('\n');

    const result = await applyPatchTool.handler({ path: filePath, patch });

    expect(result.success).toBe(false);
    expect(result.error).toContain('context mismatch');
  });

  it('fails with no valid hunks', async () => {
    const filePath = path.join(tmpDir, 'empty.txt');
    await fs.writeFile(filePath, 'test\n');

    const result = await applyPatchTool.handler({
      path: filePath,
      patch: 'this is not a patch',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No valid hunks');
  });
});
