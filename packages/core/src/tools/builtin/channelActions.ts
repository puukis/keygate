import type { Tool, ToolResult } from '../../types.js';
import { getChannelActionRegistry } from '../../channels/actions.js';

function baseActionParameters() {
  return {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Target channel id (webchat, discord, slack, telegram, whatsapp).' },
      sessionId: { type: 'string', description: 'Target session id.' },
      messageId: { type: 'string', description: 'Target external or internal message id.' },
      threadId: { type: 'string', description: 'Target thread id when relevant.' },
      content: { type: 'string', description: 'Message or edit content.' },
      emoji: { type: 'string', description: 'Reaction emoji.' },
      question: { type: 'string', description: 'Poll question.' },
      options: { type: 'array', items: { type: 'string' }, description: 'Poll options.' },
      optionIds: { type: 'array', items: { type: 'string' }, description: 'Selected poll option ids.' },
      multiple: { type: 'boolean', description: 'Allow multiple poll choices.' },
      payload: { type: 'object', description: 'Arbitrary adapter payload.' },
    },
    required: ['channel', 'sessionId'],
  };
}

async function dispatchAction(
  action: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const channel = typeof args['channel'] === 'string' ? args['channel'].trim() : '';
  const sessionId = typeof args['sessionId'] === 'string' ? args['sessionId'].trim() : '';
  if (!channel || !sessionId) {
    return { success: false, output: '', error: 'channel and sessionId are required.' };
  }

  const payload: Record<string, unknown> = {
    messageId: args['messageId'],
    threadId: args['threadId'],
    content: args['content'],
    emoji: args['emoji'],
    question: args['question'],
    options: args['options'],
    optionIds: args['optionIds'],
    multiple: args['multiple'],
    payload: args['payload'],
  };

  const result = await getChannelActionRegistry().dispatch(channel as never, {
    sessionId,
    action: action as never,
    params: payload,
  });
  return {
    success: result.ok,
    output: JSON.stringify(result, null, 2),
    ...(result.ok ? {} : { error: result.error ?? `${action} failed` }),
  };
}

export const channelActionTool: Tool = {
  name: 'channel_action',
  description: 'Dispatch a normalized channel-native action through the shared registry.',
  parameters: {
    ...baseActionParameters(),
    properties: {
      ...baseActionParameters().properties,
      action: {
        type: 'string',
        enum: ['send', 'read', 'edit', 'delete', 'react', 'reactions', 'poll', 'poll-vote', 'reply', 'thread-create', 'thread-list', 'thread-reply', 'topic-create'],
        description: 'Normalized action to execute.',
      },
    },
    required: ['channel', 'sessionId', 'action'],
  },
  requiresConfirmation: false,
  type: 'other',
  handler: async (args) => {
    const action = typeof args['action'] === 'string' ? args['action'].trim() : '';
    if (!action) {
      return { success: false, output: '', error: 'action is required.' };
    }
    return dispatchAction(action, args);
  },
};

export const channelPollTool: Tool = {
  name: 'channel_poll',
  description: 'Create a channel-native poll.',
  parameters: {
    ...baseActionParameters(),
    required: ['channel', 'sessionId', 'question', 'options'],
  },
  requiresConfirmation: false,
  type: 'other',
  handler: async (args) => dispatchAction('poll', args),
};

export const channelReactTool: Tool = {
  name: 'channel_react',
  description: 'React to a message in a channel.',
  parameters: {
    ...baseActionParameters(),
    required: ['channel', 'sessionId', 'messageId', 'emoji'],
  },
  requiresConfirmation: false,
  type: 'other',
  handler: async (args) => dispatchAction('react', args),
};

export const channelEditTool: Tool = {
  name: 'channel_edit',
  description: 'Edit a message through the shared channel action registry.',
  parameters: {
    ...baseActionParameters(),
    required: ['channel', 'sessionId', 'messageId', 'content'],
  },
  requiresConfirmation: false,
  type: 'other',
  handler: async (args) => dispatchAction('edit', args),
};

export const channelDeleteTool: Tool = {
  name: 'channel_delete',
  description: 'Delete a message through the shared channel action registry.',
  parameters: {
    ...baseActionParameters(),
    required: ['channel', 'sessionId', 'messageId'],
  },
  requiresConfirmation: false,
  type: 'other',
  handler: async (args) => dispatchAction('delete', args),
};

export const channelThreadCreateTool: Tool = {
  name: 'channel_thread_create',
  description: 'Create a thread or topic through the shared channel action registry.',
  parameters: {
    ...baseActionParameters(),
    required: ['channel', 'sessionId', 'content'],
  },
  requiresConfirmation: false,
  type: 'other',
  handler: async (args) => dispatchAction('thread-create', args),
};

export const channelThreadReplyTool: Tool = {
  name: 'channel_thread_reply',
  description: 'Reply to a thread through the shared channel action registry.',
  parameters: {
    ...baseActionParameters(),
    required: ['channel', 'sessionId', 'threadId', 'content'],
  },
  requiresConfirmation: false,
  type: 'other',
  handler: async (args) => dispatchAction('thread-reply', args),
};

export const channelActionTools: Tool[] = [
  channelActionTool,
  channelPollTool,
  channelReactTool,
  channelEditTool,
  channelDeleteTool,
  channelThreadCreateTool,
  channelThreadReplyTool,
];
