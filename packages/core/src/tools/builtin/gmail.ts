import type { Tool } from '../../types.js';

export const gmailSendEmailTool: Tool = {
  name: 'gmail_send_email',
  description: 'Send an email via the configured Gmail account.',
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Recipient email address (or comma-separated list)',
      },
      subject: {
        type: 'string',
        description: 'Email subject line',
      },
      body: {
        type: 'string',
        description: 'Plain text body of the email',
      },
      reply_to_message_id: {
        type: 'string',
        description: 'Optional Gmail message ID to reply to (sets In-Reply-To header)',
      },
      thread_id: {
        type: 'string',
        description: 'Optional Gmail thread ID to add the email to an existing thread',
      },
    },
    required: ['to', 'subject', 'body'],
  },
  requiresConfirmation: true,
  type: 'other',
  handler: async (args) => {
    const { GmailAutomationService } = await import('../../gmail/service.js');
    const { loadConfigFromEnv } = await import('../../config/env.js');

    const config = loadConfigFromEnv();
    const gmail = new GmailAutomationService(config);

    try {
      const result = await gmail.sendEmail({
        to: args['to'] as string,
        subject: args['subject'] as string,
        body: args['body'] as string,
        replyToMessageId: args['reply_to_message_id'] as string | undefined,
        threadId: args['thread_id'] as string | undefined,
      });
      return {
        success: true,
        output: `Email sent successfully. Message ID: ${result.messageId}${result.threadId ? `, Thread ID: ${result.threadId}` : ''}`,
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Failed to send email',
      };
    }
  },
};

export const gmailTools: Tool[] = [gmailSendEmailTool];
