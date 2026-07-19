/** Express router exposing the lead conversion audit. */
import { Router } from 'express';
import { getChats, getMessages, type MessageRow } from '../store.js';
import { computeAllAuditMetrics, type MetricOptions } from './metrics.js';

const MAX_MESSAGES_PER_CHAT = 100_000;

const RANGE_SECONDS: Record<string, number> = {
  '30d': 30 * 86400,
  '90d': 90 * 86400,
  '1y': 365 * 86400,
};

function parseNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(String(value));
  return Number.isFinite(n) ? n : undefined;
}

function parseOptions(query: Record<string, unknown>): MetricOptions {
  const options: MetricOptions = {};
  const startHour = parseNumber(query.startHour);
  const endHour = parseNumber(query.endHour);
  const daysOfWeek =
    typeof query.daysOfWeek === 'string'
      ? query.daysOfWeek
          .split(',')
          .map((d) => parseInt(d, 10))
          .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : undefined;
  if (startHour !== undefined || endHour !== undefined || daysOfWeek !== undefined) {
    options.businessHours = {
      ...(startHour !== undefined ? { startHour } : {}),
      ...(endHour !== undefined ? { endHour } : {}),
      ...(daysOfWeek !== undefined && daysOfWeek.length > 0 ? { daysOfWeek } : {}),
    };
  }
  options.conversionRate = parseNumber(query.conversionRate);
  options.avgTicketValue = parseNumber(query.avgTicketValue);
  options.secondsPerMessage = parseNumber(query.secondsPerMessage);
  options.gapThresholdMinutes = parseNumber(query.gapThresholdMinutes);
  return options;
}

function loadChatMessages(chatJid: string, sinceTimestamp: number): MessageRow[] {
  // getMessages returns newest-first; the auditor sorts ascending itself.
  return getMessages(chatJid, MAX_MESSAGES_PER_CHAT, 0, sinceTimestamp);
}

export const auditRouter = Router();

auditRouter.get('/api/audit/:chatJid?', (req, res) => {
  const range = typeof req.query.range === 'string' ? req.query.range : '30d';
  const rangeSeconds = RANGE_SECONDS[range];
  if (rangeSeconds === undefined) {
    res.status(400).json({ error: `Invalid range '${range}'. Valid values: 30d, 90d, 1y` });
    return;
  }
  const cutoffTimestamp = Math.floor(Date.now() / 1000) - rangeSeconds;

  const options = parseOptions(req.query as Record<string, unknown>);
  const chats = getChats();
  const nameByJid = new Map(chats.map((c) => [c.id, c.display_name ?? c.chat_pn ?? c.id]));

  let messages: MessageRow[];
  if (req.params.chatJid) {
    const jid = req.params.chatJid;
    if (!nameByJid.has(jid)) {
      res.status(404).json({ error: 'Unknown chat' });
      return;
    }
    messages = loadChatMessages(jid, cutoffTimestamp);
  } else {
    messages = chats.flatMap((c) => loadChatMessages(c.id, cutoffTimestamp));
  }

  const report = computeAllAuditMetrics(messages, options, range);
  res.json({
    ...report,
    range,
    rangeCutoffTimestamp: cutoffTimestamp,
    conversations: report.conversations.map((c) => ({
      ...c,
      chatName: c.chatJid ? nameByJid.get(c.chatJid) ?? c.chatJid : null,
    })),
  });
});
