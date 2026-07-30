/**
 * Adapter: turns a Clinica/Anaya prod export (meta + reference + conversations)
 * into the same batches/facts/labels layout the conversion pipeline expects, so
 * the funnel classifier and aggregator work unchanged.
 *
 * Unlike the WhatsApp sync, this source has three roles — patient, AI bot and
 * human staff — plus the system's own stage/booked labels and real appointment
 * records, which we carry through as facts for cross-checking.
 *
 * Usage: npx tsx scripts/conversion/extract-clinica-export.ts <export.json> <out-dir> [batchSize]
 */
import fs from 'node:fs';
import path from 'node:path';

const src = process.argv[2];
const outDir = process.argv[3];
const batchSize = parseInt(process.argv[4] ?? '40', 10);
if (!src || !outDir) {
  console.error('Usage: extract-clinica-export.ts <export.json> <out-dir> [batchSize]');
  process.exit(1);
}

// Zyva actually works all 7 days, ~09:00-21:00 (verified from message traffic),
// not the Mon-Sat 9-19 default.
const BUSINESS = { startHour: 9, endHour: 21, days: [0, 1, 2, 3, 4, 5, 6] };
const MAX_MESSAGES = 40;
const MAX_CHARS = 300;

const ROLE_LABEL: Record<string, string> = {
  user: 'PATIENT',
  bot: 'AI',
  human: 'STAFF',
};

const data = JSON.parse(fs.readFileSync(src, 'utf8'));
const conversations: any[] = data.conversations ?? [];

function withinBusiness(ts: number): boolean {
  const d = new Date(ts * 1000);
  return (
    BUSINESS.days.includes(d.getDay()) &&
    d.getHours() >= BUSINESS.startHour &&
    d.getHours() < BUSINESS.endHour
  );
}

function line(m: any): string {
  const who = ROLE_LABEL[m.role] ?? m.role.toUpperCase();
  const when = new Date((m.ts ?? 0) * 1000).toISOString().slice(0, 16).replace('T', ' ');
  let text = String(m.text ?? '').replace(/\s+/g, ' ').trim();
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '…';
  if (!text) text = '[media]';
  return `${when} ${who}: ${text}`;
}

const records: any[] = [];
for (const c of conversations) {
  const msgs = [...(c.messages ?? [])].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  if (msgs.length === 0) continue;

  const firstPatient = msgs.find((m) => m.role === 'user');
  if (!firstPatient) continue; // clinic-initiated only — not a lead

  const firstAnyReply = msgs.find(
    (m) => (m.role === 'bot' || m.role === 'human') && (m.ts ?? 0) >= (firstPatient.ts ?? 0)
  );
  const firstHumanReply = msgs.find(
    (m) => m.role === 'human' && (m.ts ?? 0) >= (firstPatient.ts ?? 0)
  );

  const rendered =
    msgs.length <= MAX_MESSAGES
      ? msgs.map(line)
      : [
          ...msgs.slice(0, MAX_MESSAGES / 2).map(line),
          `… [${msgs.length - MAX_MESSAGES} messages omitted] …`,
          ...msgs.slice(-MAX_MESSAGES / 2).map(line),
        ];

  const lead = c.lead ?? {};
  const appts = c.appointments ?? [];
  const mins = (a?: any) =>
    a ? Math.round((((a.ts ?? 0) - (firstPatient.ts ?? 0)) / 60) * 10) / 10 : null;

  records.push({
    id: c.phoneKey ?? c.chatId ?? c.phone,
    label: c.phone ?? c.phoneKey,
    transcript: rendered.join('\n'),
    facts: {
      messageCount: msgs.length,
      firstContact: new Date((firstPatient.ts ?? 0) * 1000).toISOString().slice(0, 10),
      firstResponseMinutes: mins(firstAnyReply),
      firstHumanResponseMinutes: mins(firstHumanReply),
      neverReplied: !firstAnyReply,
      handledBy: firstHumanReply ? 'human' : firstAnyReply ? 'bot-only' : 'none',
      afterHours: !withinBusiness(firstPatient.ts ?? 0),
      // System's own view, for cross-checking the classifier:
      systemStage: lead.stage ?? null,
      systemBooked: Boolean(c.summary?.booked),
      systemLostReason: lead.lostReason ?? null,
      priceQuote: lead.priceQuote ?? c.summary?.priceQuote ?? null,
      appointmentCount: appts.length,
      appointmentStatus: appts.map((a: any) => a.status).join('|') || null,
    },
  });
}

fs.mkdirSync(path.join(outDir, 'batches'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'verdicts'), { recursive: true });

let n = 0;
for (let i = 0; i < records.length; i += batchSize) {
  const batch = records.slice(i, i + batchSize);
  fs.writeFileSync(
    path.join(outDir, 'batches', `batch-${String(n).padStart(2, '0')}.json`),
    JSON.stringify(
      batch.map((r) => ({ id: r.id, label: r.label, transcript: r.transcript })),
      null,
      1
    )
  );
  n++;
}
fs.writeFileSync(
  path.join(outDir, 'facts.json'),
  JSON.stringify(Object.fromEntries(records.map((r) => [r.id, r.facts])), null, 1)
);
fs.writeFileSync(
  path.join(outDir, 'labels.json'),
  JSON.stringify(Object.fromEntries(records.map((r) => [r.id, r.label])), null, 1)
);

console.log(`conversations in export: ${conversations.length}`);
console.log(`patient-initiated (kept): ${records.length} -> ${n} batches of ${batchSize}`);
console.log(`  bot-only handled: ${records.filter((r) => r.facts.handledBy === 'bot-only').length}`);
console.log(`  human involved:   ${records.filter((r) => r.facts.handledBy === 'human').length}`);
console.log(`  never replied:    ${records.filter((r) => r.facts.neverReplied).length}`);
console.log(`  system says booked: ${records.filter((r) => r.facts.systemBooked).length}`);
console.log(`out: ${outDir}`);
