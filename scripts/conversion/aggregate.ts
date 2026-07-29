/**
 * Step 3 of the conversion-rate pipeline: merge the per-batch LLM verdicts with
 * the precomputed facts and report the conversion rate plus the cuts that
 * matter (response speed, after-hours, treatment).
 *
 * Usage: npx tsx scripts/conversion/aggregate.ts <work-dir> [populationSize]
 */
import fs from 'node:fs';
import path from 'node:path';

const workDir = process.argv[2];
const population = parseInt(process.argv[3] ?? '0', 10);
if (!workDir) {
  console.error('Usage: aggregate.ts <work-dir> [populationSize]');
  process.exit(1);
}

interface Verdict {
  id: string;
  state: string;
  booked: string;
  treatment: string | null;
  appointment_time: string | null;
  evidence: string;
  confidence: string;
}
interface Facts {
  messageCount: number;
  firstContact: string;
  firstResponseMinutes: number | null;
  neverReplied: boolean;
  afterHours: boolean;
  leadEpisodes: number;
}

const verdictDir = path.join(workDir, 'verdicts');
const verdicts: Verdict[] = [];
for (const f of fs.readdirSync(verdictDir).sort()) {
  if (!f.endsWith('.json')) continue;
  const parsed = JSON.parse(fs.readFileSync(path.join(verdictDir, f), 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${f} is not a JSON array`);
  verdicts.push(...parsed);
}
const facts: Record<string, Facts> = JSON.parse(
  fs.readFileSync(path.join(workDir, 'facts.json'), 'utf8')
);

// --- integrity: every sampled chat classified exactly once -----------------
const sampledIds = new Set(Object.keys(facts));
const seen = new Set<string>();
let dupes = 0;
let unknown = 0;
for (const v of verdicts) {
  if (seen.has(v.id)) dupes++;
  seen.add(v.id);
  if (!sampledIds.has(v.id)) unknown++;
}
const missing = [...sampledIds].filter((id) => !seen.has(id));
console.log('=== integrity ===');
console.log(`sampled: ${sampledIds.size}  classified: ${verdicts.length}  duplicates: ${dupes}  unknown ids: ${unknown}  missing: ${missing.length}`);

/** Wilson score interval — honest for small counts, unlike normal approximation. */
function wilson(successes: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [((centre - spread) / d) * 100, ((centre + spread) / d) * 100];
}

// insufficient_history is excluded from the denominator: we can't tell whether
// those chats were even patients, so counting them either way would be a guess.
const NON_ENQUIRY = new Set(['not_patient', 'existing_patient', 'insufficient_history']);
const enquiries = verdicts.filter((v) => !NON_ENQUIRY.has(v.state));
const booked = enquiries.filter((v) => v.state === 'booked');

console.log('\n=== funnel (' + verdicts.length + ' chats) ===');
const byState = new Map<string, number>();
for (const v of verdicts) byState.set(v.state, (byState.get(v.state) ?? 0) + 1);
const order = [
  'not_patient',
  'existing_patient',
  'insufficient_history',
  'enquiry_ignored',
  'enquiry_no_intent',
  'quoted_then_silent',
  'booking_attempted',
  'booked',
];
for (const s of order) {
  const n = byState.get(s) ?? 0;
  const pct = ((n / verdicts.length) * 100).toFixed(1);
  console.log(`  ${s.padEnd(20)} ${String(n).padStart(4)}  ${pct.padStart(5)}%`);
}

const [lo, hi] = wilson(booked.length, enquiries.length);
const unjudgeable = byState.get('insufficient_history') ?? 0;
console.log('\n=== conversion rate ===');
console.log(`genuine new-patient enquiries: ${enquiries.length}`);
console.log(`booked: ${booked.length}`);
console.log(
  `CONVERSION RATE: ${((booked.length / enquiries.length) * 100).toFixed(1)}%  (95% CI ${lo.toFixed(1)}–${hi.toFixed(1)}%)`
);
if (unjudgeable > 0) {
  // Bound the answer by assuming the unknowable chats were all/none enquiries.
  const worst = (booked.length / (enquiries.length + unjudgeable)) * 100;
  const best = ((booked.length + unjudgeable) / (enquiries.length + unjudgeable)) * 100;
  console.log(
    `  ${unjudgeable} chats had too little history to judge — if all were enquiries that failed: ` +
      `${worst.toFixed(1)}%; if all booked: ${best.toFixed(1)}%`
  );
}
if (population > 0 && population !== verdicts.length) {
  const rate = booked.length / enquiries.length;
  const enquiryShare = enquiries.length / verdicts.length;
  console.log(
    `extrapolated: ~${Math.round(population * enquiryShare)} real enquiries in the full ${population}, ` +
      `~${Math.round(population * enquiryShare * rate)} booked`
  );
}

// --- conversion by first-response speed ------------------------------------
function speedBucket(f: Facts): string {
  if (f.neverReplied) return 'never replied';
  const m = f.firstResponseMinutes ?? 0;
  if (m < 5) return '<5 min';
  if (m < 15) return '5-15 min';
  if (m < 60) return '15-60 min';
  if (m < 1440) return '1-24 hr';
  return '>24 hr';
}
const SPEEDS = ['<5 min', '5-15 min', '15-60 min', '1-24 hr', '>24 hr', 'never replied'];
console.log('\n=== conversion by how fast the clinic replied ===');
for (const bucket of SPEEDS) {
  const inBucket = enquiries.filter((v) => facts[v.id] && speedBucket(facts[v.id]) === bucket);
  if (inBucket.length === 0) continue;
  const b = inBucket.filter((v) => v.state === 'booked').length;
  const [l, h] = wilson(b, inBucket.length);
  console.log(
    `  ${bucket.padEnd(14)} n=${String(inBucket.length).padStart(3)}  booked=${String(b).padStart(2)}  ` +
      `${((b / inBucket.length) * 100).toFixed(1).padStart(5)}%  (CI ${l.toFixed(0)}–${h.toFixed(0)}%)`
  );
}

// --- after hours ------------------------------------------------------------
console.log('\n=== conversion by when the patient first messaged ===');
for (const label of ['during hours', 'after hours']) {
  const want = label === 'after hours';
  const grp = enquiries.filter((v) => facts[v.id] && facts[v.id].afterHours === want);
  if (grp.length === 0) continue;
  const b = grp.filter((v) => v.state === 'booked').length;
  console.log(
    `  ${label.padEnd(14)} n=${String(grp.length).padStart(3)}  booked=${String(b).padStart(2)}  ${((b / grp.length) * 100).toFixed(1)}%`
  );
}

// --- treatments -------------------------------------------------------------
console.log('\n=== most-asked treatments (enquiries only) ===');
const byTreat = new Map<string, { n: number; booked: number }>();
for (const v of enquiries) {
  const t = (v.treatment ?? 'unspecified').toLowerCase().trim();
  const e = byTreat.get(t) ?? { n: 0, booked: 0 };
  e.n++;
  if (v.state === 'booked') e.booked++;
  byTreat.set(t, e);
}
[...byTreat.entries()]
  .sort((a, b) => b[1].n - a[1].n)
  .slice(0, 12)
  .forEach(([t, e]) =>
    console.log(`  ${t.padEnd(28)} n=${String(e.n).padStart(3)}  booked=${e.booked}`)
  );

// --- classifier confidence + independent cross-check ------------------------
console.log('\n=== classifier confidence ===');
const byConf = new Map<string, number>();
for (const v of verdicts) byConf.set(v.confidence, (byConf.get(v.confidence) ?? 0) + 1);
for (const [c, n] of [...byConf.entries()].sort()) {
  console.log(`  ${c.padEnd(8)} ${n} (${((n / verdicts.length) * 100).toFixed(1)}%)`);
}

// The LLM judged "was this ignored?" from the transcript; our code computed it
// from timestamps + template detection. Agreement is a free accuracy signal.
const ignoredByLLM = verdicts.filter((v) => v.state === 'enquiry_ignored').map((v) => v.id);
const ignoredByCode = Object.entries(facts)
  .filter(([, f]) => f.neverReplied)
  .map(([id]) => id);
const bothIgnored = ignoredByLLM.filter((id) => facts[id]?.neverReplied).length;
console.log('\n=== cross-check: "never got a real reply" ===');
console.log(`  code (timestamps + templates): ${ignoredByCode.length}`);
console.log(`  LLM (read the transcript):     ${ignoredByLLM.length}`);
console.log(`  agreed on:                     ${bothIgnored}`);

// --- per-number export ------------------------------------------------------
// The deliverable: one row per phone number with its outcome.
const labelsPath = path.join(workDir, 'labels.json');
if (fs.existsSync(labelsPath)) {
  const labels: Record<string, string> = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
  const esc = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  const rows = [
    [
      'number',
      'state',
      'booked',
      'treatment',
      'appointment_time',
      'first_contact',
      'first_reply_minutes',
      'never_replied',
      'after_hours',
      'messages',
      'confidence',
      'evidence',
    ].join(','),
  ];
  for (const v of verdicts) {
    const f = facts[v.id];
    rows.push(
      [
        esc(labels[v.id] ?? v.id),
        esc(v.state),
        esc(v.booked),
        esc(v.treatment),
        esc(v.appointment_time),
        esc(f?.firstContact),
        esc(f?.firstResponseMinutes ?? ''),
        esc(f?.neverReplied ? 'yes' : 'no'),
        esc(f?.afterHours ? 'yes' : 'no'),
        esc(f?.messageCount),
        esc(v.confidence),
        esc(v.evidence),
      ].join(',')
    );
  }
  const csvPath = path.join(workDir, 'numbers.csv');
  fs.writeFileSync(csvPath, rows.join('\n'));
  const jsonPath = path.join(workDir, 'numbers.json');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      verdicts.map((v) => ({ number: labels[v.id] ?? v.id, ...v, facts: facts[v.id] })),
      null,
      1
    )
  );
  console.log(`\n=== per-number export ===\n  ${csvPath}\n  ${jsonPath}`);
}
