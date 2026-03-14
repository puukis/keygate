import type { Tool, ToolResult } from '../../types.js';
import { getCanvasRuntime } from '../../canvas/index.js';

const canvasSurfaceSchema = {
  type: 'object',
  properties: {
    sessionId: { type: 'string', description: 'Target session id.' },
    surfaceId: { type: 'string', description: 'Stable canvas surface id.' },
    path: { type: 'string', description: 'Canvas route or built-in A2UI path.' },
    state: { type: 'object', description: 'Canvas state payload.' },
    statusText: { type: 'string', description: 'Optional operator-visible status text.' },
    mode: { type: 'string', enum: ['replace', 'patch'], description: 'Whether state replaces or patches the existing payload.' },
  },
  required: ['sessionId', 'surfaceId'],
};

export const canvasOpenTool: Tool = {
  name: 'canvas_open',
  description: 'Open a canvas or A2UI surface for a session and publish its initial state.',
  parameters: {
    ...canvasSurfaceSchema,
    required: ['sessionId', 'surfaceId', 'path'],
  },
  requiresConfirmation: false,
  type: 'other',
  handler: async (args): Promise<ToolResult> => {
    const sessionId = typeof args['sessionId'] === 'string' ? args['sessionId'].trim() : '';
    const surfaceId = typeof args['surfaceId'] === 'string' ? args['surfaceId'].trim() : '';
    const surfacePath = typeof args['path'] === 'string' ? args['path'].trim() : '';
    if (!sessionId || !surfaceId || !surfacePath) {
      return { success: false, output: '', error: 'sessionId, surfaceId, and path are required.' };
    }

    await getCanvasRuntime().open({
      sessionId,
      surfaceId,
      path: surfacePath,
      state: args['state'],
      statusText: typeof args['statusText'] === 'string' ? args['statusText'] : undefined,
    });
    return { success: true, output: JSON.stringify({ ok: true, sessionId, surfaceId, path: surfacePath }, null, 2) };
  },
};

export const canvasUpdateTool: Tool = {
  name: 'canvas_update',
  description: 'Update a live canvas surface for a session.',
  parameters: canvasSurfaceSchema,
  requiresConfirmation: false,
  type: 'other',
  handler: async (args): Promise<ToolResult> => {
    const sessionId = typeof args['sessionId'] === 'string' ? args['sessionId'].trim() : '';
    const surfaceId = typeof args['surfaceId'] === 'string' ? args['surfaceId'].trim() : '';
    if (!sessionId || !surfaceId) {
      return { success: false, output: '', error: 'sessionId and surfaceId are required.' };
    }

    await getCanvasRuntime().update({
      sessionId,
      surfaceId,
      path: typeof args['path'] === 'string' ? args['path'] : undefined,
      mode: args['mode'] === 'patch' ? 'patch' : 'replace',
      state: args['state'],
      statusText: typeof args['statusText'] === 'string' ? args['statusText'] : undefined,
    });
    return { success: true, output: JSON.stringify({ ok: true, sessionId, surfaceId }, null, 2) };
  },
};

export const canvasCloseTool: Tool = {
  name: 'canvas_close',
  description: 'Close a live canvas surface for a session.',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Target session id.' },
      surfaceId: { type: 'string', description: 'Stable canvas surface id.' },
    },
    required: ['sessionId', 'surfaceId'],
  },
  requiresConfirmation: false,
  type: 'other',
  handler: async (args): Promise<ToolResult> => {
    const sessionId = typeof args['sessionId'] === 'string' ? args['sessionId'].trim() : '';
    const surfaceId = typeof args['surfaceId'] === 'string' ? args['surfaceId'].trim() : '';
    if (!sessionId || !surfaceId) {
      return { success: false, output: '', error: 'sessionId and surfaceId are required.' };
    }

    await getCanvasRuntime().close({ sessionId, surfaceId });
    return { success: true, output: JSON.stringify({ ok: true, sessionId, surfaceId }, null, 2) };
  },
};

export const canvasTools: Tool[] = [canvasOpenTool, canvasUpdateTool, canvasCloseTool];
