/**
 * Conversation detection: splits a chat's message stream into conversation
 * sessions based on inactivity gaps, and identifies lead-initiated sessions.
 */

/** Minimal message shape the auditor needs (compatible with MessageRow). */
export interface AuditMessage {
  timestamp: number; // Unix seconds
  is_from_me: number; // 1 = clinic sent it, 0 = lead sent it
  message_text: string | null;
  chat_jid?: string;
}

export interface Conversation {
  chatJid: string | null;
  startTime: number;
  endTime: number;
  messages: AuditMessage[];
  leadMessages: AuditMessage[];
  clinicMessages: AuditMessage[];
  firstLeadMessage: AuditMessage | null;
  firstClinicReply: AuditMessage | null;
  /** True when the FIRST message of the session is from the lead (is_from_me = 0). */
  isLeadConversation: boolean;
}

const DEFAULT_GAP_THRESHOLD_MINUTES = 18 * 60;

/**
 * Groups messages from a SINGLE chat into conversation sessions. A gap of more
 * than gapThresholdMinutes (default 18h) between consecutive messages starts a
 * new session.
 */
export function groupMessagesIntoConversations(
  messages: AuditMessage[],
  gapThresholdMinutes: number = DEFAULT_GAP_THRESHOLD_MINUTES
): Conversation[] {
  if (messages.length === 0) return [];

  const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  const gapSeconds = gapThresholdMinutes * 60;

  const sessions: AuditMessage[][] = [];
  let current: AuditMessage[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].timestamp - sorted[i - 1].timestamp > gapSeconds) {
      sessions.push(current);
      current = [];
    }
    current.push(sorted[i]);
  }
  sessions.push(current);

  return sessions.map((msgs) => buildConversation(msgs, sorted));
}

function buildConversation(msgs: AuditMessage[], allChatMessages: AuditMessage[]): Conversation {
  const leadMessages = msgs.filter((m) => m.is_from_me === 0);
  const clinicMessages = msgs.filter((m) => m.is_from_me === 1);
  const firstLeadMessage = leadMessages[0] ?? null;
  // First clinic message after the lead's first message ANYWHERE in the chat,
  // not just inside this session — "never replied" must mean literally never,
  // not "no reply before the session gap".
  const firstClinicReply = firstLeadMessage
    ? allChatMessages.find(
        (m) => m.is_from_me === 1 && m.timestamp >= firstLeadMessage.timestamp
      ) ?? null
    : null;
  return {
    chatJid: msgs[0].chat_jid ?? null,
    startTime: msgs[0].timestamp,
    endTime: msgs[msgs.length - 1].timestamp,
    messages: msgs,
    leadMessages,
    clinicMessages,
    firstLeadMessage,
    firstClinicReply,
    isLeadConversation: msgs[0].is_from_me === 0,
  };
}

/** Convenience: only the sessions that were initiated by the lead. */
export function filterLeadConversations(conversations: Conversation[]): Conversation[] {
  return conversations.filter((c) => c.isLeadConversation);
}
