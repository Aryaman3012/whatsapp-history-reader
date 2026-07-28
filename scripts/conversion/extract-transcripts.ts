/**
 * Step 1 of the conversion-rate pipeline.
 *
 * Pulls lead-initiated chats out of a session database, renders each one as a
 * compact transcript an LLM can classify, and writes them out in batches.
 * Also precomputes the non-LLM facts (reply speed, after-hours, never-replied)
 * so the aggregation step can cross-tab verdicts without re-deriving them.
 *
 * Usage:
 *   npx tsx scripts/conversion/extract-transcripts.ts <db-path> <out-dir> [sampleSize] [batchSize]
 */
import fs from 'node:fs';
import path from 'node:path';
import { Store, type MessageRow } from '../../src/store.js';
import {
  groupMessagesIntoConversations,
  filterLeadConversations,
} from '../../src/auditor/conversations.js';
import {
  buildTemplateTextSet,
  isWithinBusinessHours,
  DEFAULT_OPTIONS,
} from '../../src/auditor/metrics.js';

const dbPath = process.argv[2];
const outDir = process.argv[3];
const sampleSize = parseInt(process.argv[4] ?? '300', 10);
const batchSize = parseInt(process.argv[5] ?? '20', 10);

if (!dbPath || !outDir) {
  console.error('Usage: extract-transcripts.ts <db-path> <out-dir> [sampleSize] [batchSize]');
  process.exit(1);
}

/** Deterministic PRNG so a re-run samples the same chats. */
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_MESSAGES = 40; // keep first/last 20 when a chat is longer
const MAX_CHARS = 300; // per message

function renderLine(m: MessageRow): string {
  const who = m.is_from_me === 1 ? 'CLINIC' : 'PATIENT';
  const when = new Date(m.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ');
  let text = (m.message_text ?? '').replace(/\s+/g, ' ').trim();
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '…';
  if (!text) {
    // Media/deleted carry meaning even without text — label the type.
    const kind =
      m.message_type === 'deleted'
        ? 'deleted message'
        : m.message_type.replace(/Message$/, '').toLowerCase();
    text = `[${kind}]`;
  }
  return `${when} ${who}: ${text}`;
}

const store = new Store(dbPath);
const chats = store.getChats();
const allMessages = chats.flatMap((c) => store.getMessages(c.id, 200000, 0));
const templates = buildTemplateTextSet(allMessages, 10);
const substantive = (m: { is_from_me: number; message_text: string | null }) =>
  m.is_from_me === 1 && (!m.message_text || !templates.has(m.message_text));

const hours = DEFAULT_OPTIONS.businessHours;

interface ChatRecord {
  id: string;
  label: string;
  transcript: string;
  facts: {
    messageCount: number;
    firstContact: string;
    /** Minutes to the first substantive reply; null = never got one. */
    firstResponseMinutes: number | null;
    neverReplied: boolean;
    afterHours: boolean;
    leadEpisodes: number;
  };
}

const records: ChatRecord[] = [];

for (const chat of chats) {
  const msgs = store.getMessages(chat.id, 200000, 0);
  if (msgs.length === 0) continue;
  const sorted = [...msgs].sort((a, b) => a.timestamp - b.timestamp);

  const leadEpisodes = filterLeadConversations(
    groupMessagesIntoConversations(sorted, DEFAULT_OPTIONS.gapThresholdMinutes, substantive as any)
  );
  // Denominator population: people who messaged the clinic first at least once.
  if (leadEpisodes.length === 0) continue;

  const firstLead = leadEpisodes[0].firstLeadMessage!;
  const firstReply = sorted.find((m) => substantive(m) && m.timestamp >= firstLead.timestamp);

  const kept =
    sorted.length <= MAX_MESSAGES
      ? sorted.map(renderLine)
      : [
          ...sorted.slice(0, MAX_MESSAGES / 2).map(renderLine),
          `… [${sorted.length - MAX_MESSAGES} messages omitted] …`,
          ...sorted.slice(-MAX_MESSAGES / 2).map(renderLine),
        ];

  records.push({
    id: chat.id,
    label: chat.display_name ?? (chat.chat_pn ? `+${chat.chat_pn}` : chat.id),
    transcript: kept.join('\n'),
    facts: {
      messageCount: sorted.length,
      firstContact: new Date(firstLead.timestamp * 1000).toISOString().slice(0, 10),
      firstResponseMinutes: firstReply
        ? Math.round(((firstReply.timestamp - firstLead.timestamp) / 60) * 10) / 10
        : null,
      neverReplied: !firstReply,
      afterHours: !isWithinBusinessHours(firstLead.timestamp, hours),
      leadEpisodes: leadEpisodes.length,
    },
  });
}

// Seeded shuffle → stable sample across re-runs.
const rand = mulberry32(20260727);
const shuffled = [...records];
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
const sample = shuffled.slice(0, Math.min(sampleSize, shuffled.length));

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.join(outDir, 'batches'), { recursive: true });

let batchCount = 0;
for (let i = 0; i < sample.length; i += batchSize) {
  const batch = sample.slice(i, i + batchSize);
  const file = path.join(outDir, 'batches', `batch-${String(batchCount).padStart(2, '0')}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      batch.map((r) => ({ id: r.id, label: r.label, transcript: r.transcript })),
      null,
      1
    )
  );
  batchCount++;
}

// Facts are kept separately so the classifier can't see reply speed and let it
// bias the booking verdict.
fs.writeFileSync(
  path.join(outDir, 'facts.json'),
  JSON.stringify(Object.fromEntries(sample.map((r) => [r.id, r.facts])), null, 1)
);

console.log(`population (lead-initiated contacts): ${records.length}`);
console.log(`sampled: ${sample.length} into ${batchCount} batches of ${batchSize}`);
console.log(`never-replied in sample: ${sample.filter((r) => r.facts.neverReplied).length}`);
console.log(`after-hours first contact: ${sample.filter((r) => r.facts.afterHours).length}`);
console.log(`out: ${outDir}`);
