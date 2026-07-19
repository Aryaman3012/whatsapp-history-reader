import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  afterHoursLeadShare,
  afterHoursRevenueAtRisk,
  afterHoursTimeBuckets,
  firstResponseTime,
  instantReplyRecoverable,
  nextBusinessOpenTimestamp,
  nextMorningReplyRate,
  groupMessagesIntoConversations,
  repeatQuestionFrequency,
  responseDelayDropoff,
  responseTimeBuckets,
  responseTimeVariance,
  revenueAtRisk,
  zeroReplyRate,
  type AuditMessage,
} from '../src/auditor/index.js';

const MIN = 60;

// Monday 2026-01-05 10:00 local time — a working day inside 9am-7pm hours.
const BASE = new Date(2026, 0, 5, 10, 0, 0).getTime() / 1000;

function msg(
  offsetMinutes: number,
  fromMe: 0 | 1,
  text = 'hello',
  chatJid = 'lead@s.whatsapp.net'
): AuditMessage {
  return {
    timestamp: BASE + offsetMinutes * MIN,
    is_from_me: fromMe,
    message_text: text,
    chat_jid: chatJid,
  };
}

function chatMsg(chatJid: string, offsetMinutes: number, fromMe: 0 | 1): AuditMessage {
  return msg(offsetMinutes, fromMe, 'hello', chatJid);
}

function conv(messages: AuditMessage[], gapThresholdMinutes = 180) {
  const convs = groupMessagesIntoConversations(messages, gapThresholdMinutes);
  assert.equal(convs.length, 1);
  return convs[0];
}

test('firstResponseTime: correct when reply exists', () => {
  const c = conv([msg(0, 0), msg(12, 1)]);
  assert.equal(firstResponseTime(c), 12);
});

test('firstResponseTime: null when no reply', () => {
  const c = conv([msg(0, 0), msg(5, 0)]);
  assert.equal(firstResponseTime(c), null);
});

test('firstResponseTime: reply in a later session still counts (never = literally never)', () => {
  // Lead messages, clinic replies 20h later — past the 18h gap, so two sessions.
  const convs = groupMessagesIntoConversations([msg(0, 0), msg(20 * 60, 1)]);
  assert.equal(convs.length, 2);
  assert.equal(convs[0].isLeadConversation, true);
  assert.equal(firstResponseTime(convs[0]), 20 * 60);
});

test('sessions split on the 18h default gap', () => {
  const oneSession = groupMessagesIntoConversations([msg(0, 0), msg(17 * 60, 0)]);
  assert.equal(oneSession.length, 1);
  const twoSessions = groupMessagesIntoConversations([msg(0, 0), msg(19 * 60, 0)]);
  assert.equal(twoSessions.length, 2);
});

test('zeroReplyRate: 0% when all leads replied', () => {
  const convs = [
    conv([chatMsg('a@lid', 0, 0), chatMsg('a@lid', 3, 1)]),
    conv([chatMsg('b@lid', 0, 0), chatMsg('b@lid', 8, 1)]),
  ];
  const rate = zeroReplyRate(convs);
  assert.equal(rate.neverReplied, 0);
  assert.equal(rate.percentage, 0);
});

test('zeroReplyRate: 50% when half the leads replied', () => {
  const convs = [
    conv([chatMsg('a@lid', 0, 0), chatMsg('a@lid', 3, 1)]),
    conv([chatMsg('b@lid', 0, 0), chatMsg('b@lid', 5, 0)]),
  ];
  const rate = zeroReplyRate(convs);
  assert.equal(rate.neverReplied, 1);
  assert.equal(rate.total, 2);
  assert.equal(rate.percentage, 50);
});

test('zeroReplyRate: lead-level across sessions — one replied session clears the lead', () => {
  // Same lead: session 1 replied, session 2 (>18h later) unanswered.
  const convs = groupMessagesIntoConversations([
    chatMsg('a@lid', 0, 0),
    chatMsg('a@lid', 10, 1),
    chatMsg('a@lid', 48 * 60, 0),
  ]);
  assert.equal(convs.length, 2);
  const rate = zeroReplyRate(convs);
  assert.equal(rate.total, 1);
  assert.equal(rate.neverReplied, 0);
});

test('afterHoursLeadShare: counts messages outside business hours correctly', () => {
  const hours = { startHour: 9, endHour: 19, daysOfWeek: [1, 2, 3, 4, 5, 6] };
  const inHours = conv([msg(0, 0)]); // Monday 10:00
  const lateNight = conv([
    { ...msg(0, 0), timestamp: new Date(2026, 0, 5, 22, 0, 0).getTime() / 1000 }, // Monday 22:00
  ]);
  const sunday = conv([
    { ...msg(0, 0), timestamp: new Date(2026, 0, 4, 11, 0, 0).getTime() / 1000 }, // Sunday 11:00
  ]);
  const share = afterHoursLeadShare([inHours, lateNight, sunday], hours);
  assert.equal(share.afterHoursCount, 2);
  assert.equal(share.total, 3);
  assert.ok(Math.abs(share.percentage - (200 / 3)) < 1e-9);
});

test('responseDelayDropoff: correctly classifies silent vs. re-engaged leads', () => {
  // Waited 30min, then sent another message → re-engaged.
  const reEngaged = conv([msg(0, 0), msg(30, 1), msg(40, 0)]);
  // Waited 45min, never wrote again → silent.
  const silent = conv([msg(0, 0), msg(45, 1)]);
  // Fast reply (5min) → excluded from the delayed cohort entirely.
  const fast = conv([msg(0, 0), msg(5, 1), msg(10, 0)]);
  const result = responseDelayDropoff([reEngaged, silent, fast]);
  assert.equal(result.delayedConversations, 2);
  assert.equal(result.reEngaged, 1);
  assert.equal(result.wentSilent, 1);
  assert.equal(result.reEngagedPercentage, 50);
  assert.equal(result.wentSilentPercentage, 50);
});

test('revenueAtRisk: arithmetic check with known inputs', () => {
  const zero = conv([chatMsg('a@lid', 0, 0)]); // never replied — at risk
  const slow = conv([chatMsg('b@lid', 0, 0), chatMsg('b@lid', 20, 1)]); // 20min reply — not at risk
  const fast = conv([chatMsg('c@lid', 0, 0), chatMsg('c@lid', 2, 1)]); // 2min reply — not at risk
  const result = revenueAtRisk([zero, slow, fast], 0.1, 1000);
  assert.equal(result.zeroReplyLeads, 1);
  assert.equal(result.atRiskLeads, 1);
  assert.equal(result.estimatedRevenueAtRisk, 1 * 0.1 * 1000);
});

test('groupMessagesIntoConversations: correctly splits on gap threshold', () => {
  const messages = [
    msg(0, 0, 'hi'),
    msg(10, 1, 'hello'),
    // 181-minute gap from the previous message → new conversation
    msg(10 + 181, 1, 'outreach follow-up'),
    msg(10 + 181 + 5, 0, 'reply'),
  ];
  const convs = groupMessagesIntoConversations(messages, 180);
  assert.equal(convs.length, 2);
  assert.equal(convs[0].messages.length, 2);
  assert.equal(convs[0].isLeadConversation, true);
  assert.equal(convs[1].messages.length, 2);
  // Second session starts with a clinic message → not a lead conversation.
  assert.equal(convs[1].isLeadConversation, false);
  // A gap exactly at the threshold does NOT split.
  const noSplit = groupMessagesIntoConversations([msg(0, 0), msg(180, 1)], 180);
  assert.equal(noSplit.length, 1);
});

test('repeatQuestionFrequency: matches common patterns correctly', () => {
  const c = conv([
    msg(0, 0, 'How much does a cleaning cost?'), // price
    msg(1, 0, 'Where is your clinic located?'), // location
    msg(2, 0, 'Are you open on Sunday?'), // hours
    msg(3, 0, 'Any slot tomorrow?'), // availability
    msg(4, 0, 'Do you offer whitening treatment?'), // services
    msg(5, 0, 'ok thanks'), // no category
    msg(6, 1, 'Our price list is attached'), // clinic message — ignored
  ]);
  const freq = repeatQuestionFrequency([c]);
  assert.equal(freq.categories.price, 1);
  assert.equal(freq.categories.location, 1);
  assert.equal(freq.categories.hours, 1);
  assert.equal(freq.categories.availability, 1);
  assert.ok(freq.categories.services >= 1);
  assert.equal(freq.total, 5);
});

test('responseTimeVariance: effective percentiles treat never-replied as never', () => {
  // 8 replied fast (1..8 min) + 2 never-replied → 20% never-replied (>10%).
  const convs = [
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((m) => conv([msg(0, 0), msg(m, 1)])),
    conv([msg(0, 0)]),
    conv([msg(0, 0), msg(5, 0)]),
  ];
  const v = responseTimeVariance(convs);

  assert.equal(v.totalCount, 10);
  assert.equal(v.repliedCount, 8);
  assert.equal(v.effective.neverRepliedCount, 2);
  assert.equal(v.effective.neverRepliedPercent, 20);

  // Effective p90 index (9 * 0.9 = 8.1) lands in the never-replied bucket.
  assert.equal(v.effective.p90, 'never');
  // Effective p50 (index 4.5 over all 10) still falls among replied
  // conversations: interpolates between the 5-min and 6-min replies.
  assert.equal(v.effective.p50, 5.5);

  // Conditional (replied-only) percentiles still compute over the 8 replies.
  assert.equal(v.repliedOnly.p50, 4.5);
  assert.ok(Math.abs((v.repliedOnly.p90 as number) - 7.3) < 1e-9);
  assert.equal(v.repliedOnly.min, 1);
  assert.equal(v.repliedOnly.max, 8);
});

// ---------------------------------------------------------------------------
// After-hours deep-dive metrics
// ---------------------------------------------------------------------------

const HOURS = { startHour: 9, endHour: 19, daysOfWeek: [1, 2, 3, 4, 5, 6] };

// January 2026: the 4th is a Sunday, the 5th a Monday.
function at(day: number, hour: number, minute = 0): number {
  return new Date(2026, 0, day, hour, minute, 0).getTime() / 1000;
}

function msgAt(ts: number, fromMe: 0 | 1, text = 'hello'): AuditMessage {
  return { timestamp: ts, is_from_me: fromMe, message_text: text, chat_jid: 'lead@s.whatsapp.net' };
}

test('afterHoursRevenueAtRisk: only after-hours zero-reply leads count', () => {
  const ahNoReply = conv([msgAt(at(5, 22), 0)]); // Monday 22:00, never replied
  const ahReplied = conv([msgAt(at(5, 20), 0), msgAt(at(5, 20, 10), 1)]); // Monday 20:00, replied
  const inHoursNoReply = conv([msgAt(at(5, 10), 0)]); // Monday 10:00, never replied — excluded
  const result = afterHoursRevenueAtRisk([ahNoReply, ahReplied, inHoursNoReply], 0.2, 1000, HOURS);
  assert.equal(result.afterHoursZeroReply, 1);
  assert.equal(result.afterHoursTotal, 2);
  assert.equal(result.conversionRate, 0.2);
  assert.equal(result.avgTicketValue, 1000);
  assert.equal(result.revenueAtRisk, 1 * 0.2 * 1000);
});

test('nextBusinessOpenTimestamp: same-day, next-day, and closed-day openings', () => {
  // Monday 07:00 — business day before opening → 09:00 the same day.
  assert.equal(nextBusinessOpenTimestamp(at(5, 7), HOURS), at(5, 9));
  // Monday 22:00 — after close → Tuesday 09:00.
  assert.equal(nextBusinessOpenTimestamp(at(5, 22), HOURS), at(6, 9));
  // Sunday 11:00 — closed day → Monday 09:00.
  assert.equal(nextBusinessOpenTimestamp(at(4, 11), HOURS), at(5, 9));
});

test('nextMorningReplyRate: replied before/after 1hr of opening', () => {
  const hours = { startHour: 10, endHour: 19, daysOfWeek: [1, 2, 3, 4, 5, 6] };
  const wide = 24 * 60; // overnight replies must stay in one session
  // Monday 22:00 lead, replied Tuesday 10:30 — within 1hr of the 10:00 open.
  const onTime = conv([msgAt(at(5, 22), 0), msgAt(at(6, 10, 30), 1)], wide);
  // Monday 22:00 lead, replied Tuesday 13:00 — 3 hours after open.
  const late = conv([msgAt(at(5, 22), 0), msgAt(at(6, 13), 1)], wide);
  // Never-replied after-hours lead is excluded from the replied cohort.
  const never = conv([msgAt(at(5, 23), 0)]);
  const result = nextMorningReplyRate([onTime, late, never], hours);
  assert.equal(result.repliedWithin1hr, 1);
  assert.equal(result.totalReplied, 2);
  assert.equal(result.rate, 0.5);
  // Minutes from open: 30 and 180 → median 105.
  assert.equal(result.medianMinutesFromOpen, 105);
});

test('nextMorningReplyRate: empty replied cohort returns rate 0 and null median', () => {
  const never = conv([msgAt(at(5, 22), 0)]);
  const result = nextMorningReplyRate([never], HOURS);
  assert.equal(result.totalReplied, 0);
  assert.equal(result.rate, 0);
  assert.equal(result.medianMinutesFromOpen, null);
});

test('afterHoursTimeBuckets: classifies hours into the right buckets', () => {
  const evening = conv([msgAt(at(5, 20), 0)]); // Monday 20:00
  const lateNight = conv([msgAt(at(5, 3), 0)]); // Monday 03:00
  const earlyMorning = conv([msgAt(at(5, 7), 0)]); // Monday 07:00
  const closedDay = conv([msgAt(at(4, 11), 0)]); // Sunday 11:00
  const inHours = conv([msgAt(at(5, 10), 0)]); // Monday 10:00 — not after hours
  const result = afterHoursTimeBuckets([evening, lateNight, earlyMorning, closedDay, inHours], HOURS);
  assert.equal(result.total, 4);
  assert.deepEqual(
    result.buckets.map((b) => [b.label, b.count, b.percentage]),
    [
      ['Evening (7pm-midnight)', 1, 25],
      ['Late night (midnight-6am)', 1, 25],
      ['Early morning (6-9am)', 1, 25],
      ['Closed days', 1, 25],
    ]
  );
});

test('instantReplyRecoverable: arithmetic with the small-sample assumption', () => {
  // Two during-hours fast replies (sample < 5 → 0.80 benchmark assumed).
  const fast1 = conv([msgAt(at(5, 10), 0), msgAt(at(5, 10, 2), 1)]);
  const fast2 = conv([msgAt(at(5, 11), 0), msgAt(at(5, 11, 3), 1)]);
  // Two after-hours leads never replied → lost cohort.
  const lost1 = conv([msgAt(at(5, 22), 0)]);
  const lost2 = conv([msgAt(at(5, 23), 0)]);
  // After-hours lead replied instantly, no re-engagement → replied cohort, not lost.
  const ahReplied = conv([msgAt(at(5, 20), 0), msgAt(at(5, 20, 5), 1)]);
  const result = instantReplyRecoverable(
    [fast1, fast2, lost1, lost2, ahReplied],
    HOURS,
    0.2,
    1000
  );
  assert.equal(result.fastReplySampleSize, 2);
  assert.equal(result.assumptionUsed, true);
  assert.equal(result.fastReplyReEngagementRate, 0.8);
  assert.equal(result.lostCohort, 2);
  assert.equal(result.actualAfterHoursReEngagementRate, 0);
  // 2 lost × (0.80 − 0) = 1.6 leads → 0.32 bookings → AED 320.
  assert.ok(Math.abs(result.recoverableLeads - 1.6) < 1e-9);
  assert.ok(Math.abs(result.recoverableBookings - 0.32) < 1e-9);
  assert.ok(Math.abs(result.recoverableRevenue - 320) < 1e-9);
});

test('responseTimeBuckets: correct bucket assignment', () => {
  const convs = [
    conv([msg(0, 0), msg(2, 1)]), // <5min
    conv([msg(0, 0), msg(10, 1)]), // 5-15min
    conv([msg(0, 0), msg(30, 1)]), // 15-60min
    conv([msg(0, 0), msg(120, 1)]), // 1-24hr
    conv([msg(0, 0), msg(25 * 60, 1)], 26 * 60), // >24hr (wide gap threshold so it stays one session)
    conv([msg(0, 0)]), // never replied
  ];
  const buckets = responseTimeBuckets(convs);
  assert.equal(buckets['<5min'], 1);
  assert.equal(buckets['5-15min'], 1);
  assert.equal(buckets['15-60min'], 1);
  assert.equal(buckets['1-24hr'], 1);
  assert.equal(buckets['>24hr'], 1);
  assert.equal(buckets['never-replied'], 1);
});
