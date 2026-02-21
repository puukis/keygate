import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool, ToolResult } from '../../types.js';

/**
 * Edit a file by replacing an exact string match with new content.
 * Safer than write_file because it only changes the targeted section.
 */
export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Edit a file by replacing an exact occurrence of old_text with new_text. ' +
    'The old_text must appear exactly once in the file. ' +
    'Use this instead of write_file when you only need to change part of a file.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path to the file to edit',
      },
      old_text: {
        type: 'string',
        description:
          'The exact text to find and replace. Must match exactly once in the file (including whitespace and indentation).',
      },
      new_text: {
        type: 'string',
        description: 'The replacement text',
      },
    },
    required: ['path', 'old_text', 'new_text'],
  },
  requiresConfirmation: true,
  type: 'filesystem',
  handler: async (args): Promise<ToolResult> => {
    const filePath = args['path'] as string;
    const oldText = args['old_text'] as string;
    const newText = args['new_text'] as string;

    try {
      const content = await fs.readFile(filePath, 'utf-8');

      const occurrences = countOccurrences(content, oldText);

      if (occurrences === 0) {
        const suggestion = findClosestMatch(content, oldText);
        const hint = suggestion
          ? `\n\nClosest match found:\n${suggestion}`
          : '';
        return {
          success: false,
          output: '',
          error: `old_text not found in ${filePath}. Make sure it matches the file content exactly (including whitespace and indentation).${hint}`,
        };
      }

      if (occurrences > 1) {
        return {
          success: false,
          output: '',
          error: `old_text appears ${occurrences} times in ${filePath}. It must appear exactly once. Add more surrounding context to make the match unique.`,
        };
      }

      const updated = content.replace(oldText, newText);
      await fs.writeFile(filePath, updated, 'utf-8');

      const oldLines = oldText.split('\n').length;
      const newLines = newText.split('\n').length;
      const delta = newLines - oldLines;
      const deltaStr = delta > 0 ? `+${delta}` : String(delta);

      return {
        success: true,
        output: `File edited: ${filePath} (${oldLines} lines replaced with ${newLines} lines, ${deltaStr} net)`,
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Failed to edit file',
      };
    }
  },
};

/**
 * Apply a unified diff patch to a file.
 */
export const applyPatchTool: Tool = {
  name: 'apply_patch',
  description:
    'Apply a unified diff patch to a file. The patch should be in standard unified diff format ' +
    '(lines starting with --- +++ @@ - +). Use this for complex multi-region edits.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path to the file to patch',
      },
      patch: {
        type: 'string',
        description: 'The unified diff patch to apply',
      },
    },
    required: ['path', 'patch'],
  },
  requiresConfirmation: true,
  type: 'filesystem',
  handler: async (args): Promise<ToolResult> => {
    const filePath = args['path'] as string;
    const patch = args['patch'] as string;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const hunks = parseUnifiedDiff(patch);

      if (hunks.length === 0) {
        return {
          success: false,
          output: '',
          error: 'No valid hunks found in the patch. Use unified diff format with @@ markers.',
        };
      }

      const result = applyHunks(content, hunks);

      if (!result.success) {
        return {
          success: false,
          output: '',
          error: result.error ?? 'Failed to apply patch',
        };
      }

      await fs.writeFile(filePath, result.content, 'utf-8');

      return {
        success: true,
        output: `Patch applied to ${filePath} (${hunks.length} hunk${hunks.length > 1 ? 's' : ''})`,
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Failed to apply patch',
      };
    }
  },
};

// ==================== Helpers ====================

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count++;
    pos = idx + 1;
  }
  return count;
}

/**
 * Find a close match by trimming leading/trailing whitespace from each line
 * and checking if a normalized version matches.
 */
function findClosestMatch(content: string, needle: string): string | null {
  const needleLines = needle.split('\n').map((l) => l.trim());
  const contentLines = content.split('\n');

  if (needleLines.length === 0) return null;

  const firstNeedleLine = needleLines[0]!;
  if (firstNeedleLine.length < 3) return null;

  for (let i = 0; i <= contentLines.length - needleLines.length; i++) {
    if (contentLines[i]!.trim() !== firstNeedleLine) continue;

    let match = true;
    for (let j = 1; j < needleLines.length; j++) {
      if (contentLines[i + j]!.trim() !== needleLines[j]!) {
        match = false;
        break;
      }
    }

    if (match) {
      return contentLines.slice(i, i + needleLines.length).join('\n');
    }
  }

  return null;
}

// ==================== Unified Diff Parser ====================

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  lines: DiffLine[];
}

interface DiffLine {
  type: 'context' | 'add' | 'remove';
  content: string;
}

function parseUnifiedDiff(patch: string): DiffHunk[] {
  const lines = patch.split('\n');
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;

  for (const line of lines) {
    // Skip --- and +++ header lines
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;

    const hunkHeader = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+\d+(?:,\d+)?\s+@@/);
    if (hunkHeader) {
      current = {
        oldStart: parseInt(hunkHeader[1]!, 10),
        oldCount: hunkHeader[2] !== undefined ? parseInt(hunkHeader[2], 10) : 1,
        lines: [],
      };
      hunks.push(current);
      continue;
    }

    if (!current) continue;

    if (line.startsWith('-')) {
      current.lines.push({ type: 'remove', content: line.slice(1) });
    } else if (line.startsWith('+')) {
      current.lines.push({ type: 'add', content: line.slice(1) });
    } else if (line.startsWith(' ')) {
      current.lines.push({ type: 'context', content: line.slice(1) });
    } else if (line === '\\ No newline at end of file') {
      // Ignore this marker
    }
  }

  return hunks;
}

function applyHunks(
  content: string,
  hunks: DiffHunk[]
): { success: boolean; content: string; error?: string } {
  const lines = content.split('\n');

  // Apply hunks in reverse order so earlier line numbers aren't shifted.
  const sorted = [...hunks].sort((a, b) => b.oldStart - a.oldStart);

  for (let hi = 0; hi < sorted.length; hi++) {
    const hunk = sorted[hi]!;
    // oldStart is 1-based in unified diffs
    const startIdx = hunk.oldStart - 1;

    // Verify context and remove lines match
    let lineIdx = startIdx;
    const removals: number[] = [];
    const additions: string[] = [];
    let contextOffset = 0;

    for (const dl of hunk.lines) {
      if (dl.type === 'context') {
        if (lineIdx >= lines.length || lines[lineIdx] !== dl.content) {
          return {
            success: false,
            content: '',
            error: `Hunk at line ${hunk.oldStart} failed: context mismatch at line ${lineIdx + 1}. Expected "${dl.content}", got "${lines[lineIdx] ?? '(EOF)'}".`,
          };
        }
        lineIdx++;
        contextOffset++;
      } else if (dl.type === 'remove') {
        if (lineIdx >= lines.length || lines[lineIdx] !== dl.content) {
          return {
            success: false,
            content: '',
            error: `Hunk at line ${hunk.oldStart} failed: expected to remove "${dl.content}" at line ${lineIdx + 1}, got "${lines[lineIdx] ?? '(EOF)'}".`,
          };
        }
        removals.push(lineIdx);
        lineIdx++;
      } else if (dl.type === 'add') {
        additions.push(dl.content);
      }
    }

    // Apply: remove old lines, insert new ones at the first removal/context position
    const spliceStart = removals.length > 0 ? removals[0]! : startIdx + contextOffset;
    const spliceCount = removals.length;
    lines.splice(spliceStart, spliceCount, ...additions);
  }

  return { success: true, content: lines.join('\n') };
}

/**
 * All edit tools
 */
export const editTools: Tool[] = [editFileTool, applyPatchTool];
