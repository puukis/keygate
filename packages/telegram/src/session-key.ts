/**
 * Build a session key for a Telegram chat.
 * Forum supergroups use a per-topic key so each topic gets its own session.
 */
export function buildSessionKey(chatId: number, topicId?: number): string {
  if (topicId !== undefined && topicId !== 0) {
    return `telegram:${chatId}:${topicId}`;
  }
  return `telegram:${chatId}`;
}
