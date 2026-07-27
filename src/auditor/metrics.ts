/**
 * Metrics engine for the lead conversion audit. All functions are pure and
 * operate on Conversation sessions (see conversations.ts). Times are in
 * minutes unless noted; timestamps are Unix seconds.
 */
import {
  type AuditMessage,
  type Conversation,
  filterLeadConversations,
  groupMessagesIntoConversations,
} from './conversations.js';

export type { IsSubstantiveReply } from './conversations.js';

export interface BusinessHours {
  /** Hour of day (0-23) business opens, inclusive. */
  startHour: number;
  /** Hour of day (0-23) business closes, exclusive. */
  endHour: number;
  /** Days of week considered working days (0 = Sunday .. 6 = Saturday). */
  daysOfWeek: number[];
}

export interface MetricOptions {
  businessHours?: Partial<BusinessHours>;
  conversionRate?: number;
  avgTicketValue?: number;
  secondsPerMessage?: number;
  gapThresholdMinutes?: number;
  /**
   * An outbound text sent verbatim to at least this many distinct chats is
   * treated as a template/auto-greeting and does NOT count as a real reply.
   * Set very high to disable template filtering.
   */
  templateMinChats?: number;
}

export interface ResolvedMetricOptions {
  businessHours: BusinessHours;
  conversionRate: number;
  avgTicketValue: number;
  secondsPerMessage: number;
  gapThresholdMinutes: number;
  templateMinChats: number;
}

export const DEFAULT_OPTIONS: ResolvedMetricOptions = {
  businessHours: { startHour: 9, endHour: 19, daysOfWeek: [1, 2, 3, 4, 5, 6] },
  conversionRate: 0.2,
  avgTicketValue: 1300,
  secondsPerMessage: 75,
  gapThresholdMinutes: 18 * 60,
  templateMinChats: 10,
};

export function resolveOptions(options: MetricOptions = {}): ResolvedMetricOptions {
  return {
    businessHours: { ...DEFAULT_OPTIONS.businessHours, ...options.businessHours },
    conversionRate: options.conversionRate ?? DEFAULT_OPTIONS.conversionRate,
    avgTicketValue: options.avgTicketValue ?? DEFAULT_OPTIONS.avgTicketValue,
    secondsPerMessage: options.secondsPerMessage ?? DEFAULT_OPTIONS.secondsPerMessage,
    gapThresholdMinutes: options.gapThresholdMinutes ?? DEFAULT_OPTIONS.gapThresholdMinutes,
    templateMinChats: options.templateMinChats ?? DEFAULT_OPTIONS.templateMinChats,
  };
}

/**
 * Identify templated outbound texts: exact text sent from the clinic across at
 * least `minChats` distinct chats. Auto-greetings and canned lines are the same
 * verbatim string blasted to many people; genuine replies are near-unique. This
 * is account-agnostic — it needs no keyword list.
 */
export function buildTemplateTextSet(messages: AuditMessage[], minChats: number): Set<string> {
  if (minChats <= 1) return new Set();
  const chatsByText = new Map<string, Set<string>>();
  for (const m of messages) {
    if (m.is_from_me !== 1) continue;
    const text = m.message_text;
    if (!text || text.trim().length === 0) continue;
    let chats = chatsByText.get(text);
    if (!chats) chatsByText.set(text, (chats = new Set()));
    chats.add(m.chat_jid ?? '');
  }
  const templates = new Set<string>();
  for (const [text, chats] of chatsByText) {
    if (chats.size >= minChats) templates.add(text);
  }
  return templates;
}

// ---------------------------------------------------------------------------
// firstResponseTime
// ---------------------------------------------------------------------------

/**
 * Minutes from the lead's first inbound message to the clinic's first reply.
 * Null when the clinic never replied (or the session has no lead message).
 */
export function firstResponseTime(conversation: Conversation): number | null {
  if (!conversation.firstLeadMessage || !conversation.firstClinicReply) return null;
  return (conversation.firstClinicReply.timestamp - conversation.firstLeadMessage.timestamp) / 60;
}

// ---------------------------------------------------------------------------
// responseTimeBuckets
// ---------------------------------------------------------------------------

export interface ResponseTimeBuckets {
  '<5min': number;
  '5-15min': number;
  '15-60min': number;
  '1-24hr': number;
  '>24hr': number;
  'never-replied': number;
}

export function responseTimeBuckets(conversations: Conversation[]): ResponseTimeBuckets {
  const buckets: ResponseTimeBuckets = {
    '<5min': 0,
    '5-15min': 0,
    '15-60min': 0,
    '1-24hr': 0,
    '>24hr': 0,
    'never-replied': 0,
  };
  for (const conv of conversations) {
    const frt = firstResponseTime(conv);
    if (frt === null) buckets['never-replied']++;
    else if (frt < 5) buckets['<5min']++;
    else if (frt < 15) buckets['5-15min']++;
    else if (frt < 60) buckets['15-60min']++;
    else if (frt < 24 * 60) buckets['1-24hr']++;
    else buckets['>24hr']++;
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// zeroReplyRate
// ---------------------------------------------------------------------------

export interface ZeroReplyRate {
  /** Unique leads (chats) that never got a clinic reply in ANY of their conversations. */
  neverReplied: number;
  /** Unique leads (chats) with at least one lead-initiated conversation. */
  total: number;
  percentage: number;
}

function chatKey(conv: Conversation): string {
  return conv.chatJid ?? '';
}

/** Chats that got a clinic reply in at least one of their lead conversations. */
export function chatsEverReplied(conversations: Conversation[]): Set<string> {
  const replied = new Set<string>();
  for (const c of conversations) {
    if (firstResponseTime(c) !== null) replied.add(chatKey(c));
  }
  return replied;
}

/**
 * Lead-level, across sessions: a lead counts as never-replied only when NONE
 * of their conversations ever got a clinic reply. A lead with one replied and
 * one unanswered conversation is not "never replied".
 */
export function zeroReplyRate(conversations: Conversation[]): ZeroReplyRate {
  const allChats = new Set(conversations.map(chatKey));
  const replied = chatsEverReplied(conversations);
  const total = allChats.size;
  const neverReplied = [...allChats].filter((jid) => !replied.has(jid)).length;
  return { neverReplied, total, percentage: total === 0 ? 0 : (neverReplied / total) * 100 };
}

// ---------------------------------------------------------------------------
// afterHoursLeadShare
// ---------------------------------------------------------------------------

export interface AfterHoursLeadShare {
  afterHoursCount: number;
  total: number;
  percentage: number;
  /** After-hours leads that eventually got a clinic reply. */
  repliedCount: number;
  /** repliedCount / afterHoursCount as a percentage (0 when no after-hours leads). */
  replyPercentage: number;
}

export function isWithinBusinessHours(timestamp: number, hours: BusinessHours): boolean {
  const d = new Date(timestamp * 1000);
  return (
    hours.daysOfWeek.includes(d.getDay()) &&
    d.getHours() >= hours.startHour &&
    d.getHours() < hours.endHour
  );
}

/** Share of lead conversations whose first inbound message arrived outside business hours. */
export function afterHoursLeadShare(
  conversations: Conversation[],
  hours: BusinessHours = DEFAULT_OPTIONS.businessHours
): AfterHoursLeadShare {
  const withLead = conversations.filter((c) => c.firstLeadMessage !== null);
  const afterHoursConvs = withLead.filter(
    (c) => !isWithinBusinessHours(c.firstLeadMessage!.timestamp, hours)
  );
  const afterHoursCount = afterHoursConvs.length;
  const repliedCount = afterHoursConvs.filter((c) => firstResponseTime(c) !== null).length;
  const total = withLead.length;
  return {
    afterHoursCount,
    total,
    percentage: total === 0 ? 0 : (afterHoursCount / total) * 100,
    repliedCount,
    replyPercentage: afterHoursCount === 0 ? 0 : (repliedCount / afterHoursCount) * 100,
  };
}

// ---------------------------------------------------------------------------
// responseDelayDropoff
// ---------------------------------------------------------------------------

export interface ResponseDelayDropoff {
  delayedConversations: number;
  reEngaged: number;
  wentSilent: number;
  reEngagedPercentage: number;
  wentSilentPercentage: number;
}

/**
 * For leads who waited > 15 minutes for the first reply: how many sent
 * another message after the clinic finally replied vs. went silent.
 */
export function responseDelayDropoff(conversations: Conversation[]): ResponseDelayDropoff {
  const delayed = conversations.filter((c) => {
    const frt = firstResponseTime(c);
    return frt !== null && frt > 15;
  });
  const reEngaged = delayed.filter((c) => c.reEngagedAfterReply).length;
  const wentSilent = delayed.length - reEngaged;
  const total = delayed.length;
  return {
    delayedConversations: total,
    reEngaged,
    wentSilent,
    reEngagedPercentage: total === 0 ? 0 : (reEngaged / total) * 100,
    wentSilentPercentage: total === 0 ? 0 : (wentSilent / total) * 100,
  };
}

// ---------------------------------------------------------------------------
// staffHoursConsumed
// ---------------------------------------------------------------------------

export interface StaffHoursConsumed {
  clinicMessageCount: number;
  secondsPerMessage: number;
  hours: number;
}

export function staffHoursConsumed(
  conversations: Conversation[],
  secondsPerMessage: number = DEFAULT_OPTIONS.secondsPerMessage
): StaffHoursConsumed {
  const clinicMessageCount = conversations.reduce((n, c) => n + c.clinicMessages.length, 0);
  return {
    clinicMessageCount,
    secondsPerMessage,
    hours: (clinicMessageCount * secondsPerMessage) / 3600,
  };
}

// ---------------------------------------------------------------------------
// meanReplyTime
// ---------------------------------------------------------------------------

export interface MeanReplyTime {
  /** Mean of per-lead total reply minutes; null when no lead was ever replied to. */
  meanMinutes: number | null;
  /** Number of lead conversations included (clinic replied at least once). */
  leadCount: number;
  /** The active date window this was computed over, e.g. '30d'. */
  windowLabel: string;
}

/**
 * Mean total reply time across leads the clinic actually replied to. For each
 * lead conversation, sums (clinic reply - preceding lead message) minutes over
 * every lead→clinic reply pair; conversations with no clinic reply are
 * excluded. Conversations must already be filtered to the active date window
 * (the route only loads messages after the range cutoff).
 */
export function meanReplyTime(conversations: Conversation[], windowLabel: string): MeanReplyTime {
  const totals: number[] = [];
  for (const conv of conversations) {
    if (!conv.firstLeadMessage || conv.clinicMessages.length === 0) continue;
    let total = 0;
    let lastLeadTs: number | null = null;
    for (const msg of conv.messages) {
      if (msg.is_from_me === 0) {
        lastLeadTs = msg.timestamp;
      } else if (lastLeadTs !== null) {
        total += (msg.timestamp - lastLeadTs) / 60;
        lastLeadTs = null;
      }
    }
    totals.push(total);
  }
  const leadCount = totals.length;
  return {
    meanMinutes: leadCount === 0 ? null : totals.reduce((a, b) => a + b, 0) / leadCount,
    leadCount,
    windowLabel,
  };
}

// ---------------------------------------------------------------------------
// backAndForthRounds
// ---------------------------------------------------------------------------

export const BOOKING_INTENT_REGEX = /book|appointment|slot|schedule|available|timings?|visit|consult/i;

export interface BackAndForthRounds {
  conversationsWithIntent: number;
  averageRounds: number | null;
  /** rounds value -> number of conversations that took that many rounds */
  distribution: Record<number, number>;
}

/**
 * Average lead→clinic exchanges from first contact until the lead shows
 * booking intent. Only conversations where intent appears are counted.
 */
export function backAndForthRounds(conversations: Conversation[]): BackAndForthRounds {
  const roundsList: number[] = [];
  for (const conv of conversations) {
    let rounds = 0;
    let pendingLead = false;
    let intentRounds: number | null = null;
    for (const msg of conv.messages) {
      if (msg.is_from_me === 0) {
        if (msg.message_text && BOOKING_INTENT_REGEX.test(msg.message_text)) {
          intentRounds = rounds;
          break;
        }
        pendingLead = true;
      } else if (pendingLead) {
        rounds++;
        pendingLead = false;
      }
    }
    if (intentRounds !== null) roundsList.push(intentRounds);
  }
  const distribution: Record<number, number> = {};
  for (const r of roundsList) distribution[r] = (distribution[r] ?? 0) + 1;
  return {
    conversationsWithIntent: roundsList.length,
    averageRounds:
      roundsList.length === 0
        ? null
        : roundsList.reduce((a, b) => a + b, 0) / roundsList.length,
    distribution,
  };
}

// ---------------------------------------------------------------------------
// responseTimeVariance
// ---------------------------------------------------------------------------

/**
 * Percentile of first response time over ALL lead conversations, treating
 * never-replied as slower than any reply. A number (minutes) when the
 * percentile falls within replied conversations; the string 'never' when it
 * falls into the never-replied bucket; null when there are no conversations.
 */
export type EffectivePercentile = number | 'never' | null;

export interface ResponseTimeVariance {
  /**
   * CONDITIONAL statistics: percentiles computed only over conversations that
   * received a reply. These say nothing about leads who were never answered —
   * always read them alongside `effective`.
   */
  repliedOnly: {
    p10: number | null;
    p50: number | null;
    p90: number | null;
    min: number | null;
    max: number | null;
  };
  /**
   * UNCONDITIONAL statistics: percentiles over every lead conversation, with
   * never-replied conversations treated as an infinite response time. This is
   * the honest "how long does a lead wait" metric.
   *
   * NOTE: session-level by design (a distribution over conversations), so
   * neverRepliedCount/Percent here will exceed the lead-level summary.zeroReply
   * numbers — do not present the two as the same statistic.
   */
  effective: {
    p50: EffectivePercentile;
    p90: EffectivePercentile;
    neverRepliedCount: number;
    neverRepliedPercent: number;
  };
  repliedCount: number;
  totalCount: number;
}

export function percentile(sortedValues: number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  const idx = (p / 100) * (sortedValues.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (idx - lo);
}

/**
 * Percentile over all conversations with never-replied treated as Infinity.
 * `sortedRepliedTimes` holds the replied conversations' times ascending;
 * indices >= sortedRepliedTimes.length conceptually hold Infinity.
 */
function effectivePercentile(
  sortedRepliedTimes: number[],
  totalCount: number,
  p: number
): EffectivePercentile {
  if (totalCount === 0) return null;
  const idx = (p / 100) * (totalCount - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo >= sortedRepliedTimes.length) return 'never';
  if (hi < sortedRepliedTimes.length) {
    if (lo === hi) return sortedRepliedTimes[lo];
    return (
      sortedRepliedTimes[lo] +
      (sortedRepliedTimes[hi] - sortedRepliedTimes[lo]) * (idx - lo)
    );
  }
  // lo is a replied time but hi is in the never-replied bucket: any
  // interpolation toward Infinity lands at 'never' unless idx is exactly lo.
  return idx === lo ? sortedRepliedTimes[lo] : 'never';
}

export function responseTimeVariance(conversations: Conversation[]): ResponseTimeVariance {
  const times = conversations
    .map(firstResponseTime)
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b);
  const totalCount = conversations.length;
  const neverRepliedCount = totalCount - times.length;
  return {
    repliedOnly: {
      p10: percentile(times, 10),
      p50: percentile(times, 50),
      p90: percentile(times, 90),
      min: times.length ? times[0] : null,
      max: times.length ? times[times.length - 1] : null,
    },
    effective: {
      p50: effectivePercentile(times, totalCount, 50),
      p90: effectivePercentile(times, totalCount, 90),
      neverRepliedCount,
      neverRepliedPercent: totalCount === 0 ? 0 : (neverRepliedCount / totalCount) * 100,
    },
    repliedCount: times.length,
    totalCount,
  };
}

// ---------------------------------------------------------------------------
// dayHourHeatmap
// ---------------------------------------------------------------------------

export interface HeatmapCell {
  day: number; // 0 = Sunday .. 6 = Saturday
  hour: number; // 0-23
  leadCount: number;
  medianResponseMinutes: number | null;
}

/**
 * Median first response time grouped by day-of-week and hour-of-day of when
 * the lead's first message arrived. Cells with no leads are omitted.
 */
export function dayHourHeatmap(conversations: Conversation[]): HeatmapCell[] {
  const cells = new Map<string, { day: number; hour: number; times: number[]; leads: number }>();
  for (const conv of conversations) {
    if (!conv.firstLeadMessage) continue;
    const d = new Date(conv.firstLeadMessage.timestamp * 1000);
    const day = d.getDay();
    const hour = d.getHours();
    const key = `${day}:${hour}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { day, hour, times: [], leads: 0 };
      cells.set(key, cell);
    }
    cell.leads++;
    const frt = firstResponseTime(conv);
    if (frt !== null) cell.times.push(frt);
  }
  return [...cells.values()]
    .sort((a, b) => a.day - b.day || a.hour - b.hour)
    .map((c) => ({
      day: c.day,
      hour: c.hour,
      leadCount: c.leads,
      medianResponseMinutes: percentile(
        c.times.sort((a, b) => a - b),
        50
      ),
    }));
}

// ---------------------------------------------------------------------------
// repeatQuestionFrequency
// ---------------------------------------------------------------------------

export const QUESTION_PATTERNS: Record<string, RegExp> = {
  price: /price|cost|how much|fee|rate/i,
  location: /where|location|address|direction/i,
  hours: /open|close|timing|hours/i,
  availability: /available|slot|appointment|book/i,
  services: /service|treatment|offer|do you/i,
};

export interface RepeatQuestionFrequency {
  categories: Record<string, number>;
  total: number;
}

/** Counts inbound (lead) messages matching common question patterns. */
export function repeatQuestionFrequency(conversations: Conversation[]): RepeatQuestionFrequency {
  const categories: Record<string, number> = {};
  for (const key of Object.keys(QUESTION_PATTERNS)) categories[key] = 0;
  let total = 0;
  for (const conv of conversations) {
    for (const msg of conv.leadMessages) {
      if (!msg.message_text) continue;
      let matched = false;
      for (const [key, re] of Object.entries(QUESTION_PATTERNS)) {
        if (re.test(msg.message_text)) {
          categories[key]++;
          matched = true;
        }
      }
      if (matched) total++;
    }
  }
  return { categories, total };
}

// ---------------------------------------------------------------------------
// revenueAtRisk
// ---------------------------------------------------------------------------

export interface RevenueAtRisk {
  zeroReplyLeads: number;
  atRiskLeads: number;
  conversionRate: number;
  avgTicketValue: number;
  estimatedRevenueAtRisk: number;
}

export function revenueAtRisk(
  conversations: Conversation[],
  conversionRate: number = DEFAULT_OPTIONS.conversionRate,
  avgTicketValue: number = DEFAULT_OPTIONS.avgTicketValue
): RevenueAtRisk {
  // Lead-level, consistent with zeroReplyRate: only leads never replied to at all.
  const zeroReplyLeads = zeroReplyRate(conversations).neverReplied;
  const atRiskLeads = zeroReplyLeads;
  return {
    zeroReplyLeads,
    atRiskLeads,
    conversionRate,
    avgTicketValue,
    estimatedRevenueAtRisk: atRiskLeads * conversionRate * avgTicketValue,
  };
}

// ---------------------------------------------------------------------------
// staffCost
// ---------------------------------------------------------------------------

/** AED 6,500/month receptionist salary spread over 160 working hours. */
export const STAFF_HOURLY_RATE_AED = 6500 / 160;

export interface StaffCost {
  hours: number;
  hourlyRate: number;
  cost: number;
}

export function staffCost(staffHours: StaffHoursConsumed): StaffCost {
  return {
    hours: staffHours.hours,
    hourlyRate: STAFF_HOURLY_RATE_AED,
    cost: Math.round(staffHours.hours * STAFF_HOURLY_RATE_AED),
  };
}

// ---------------------------------------------------------------------------
// dayBreakdown
// ---------------------------------------------------------------------------

export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export interface DayStats {
  day: string;
  medianResponseMinutes: number | null;
  leadCount: number;
}

export interface DayBreakdown {
  bestDay: { day: string; medianResponseMinutes: number } | null;
  worstDay: { day: string; medianResponseMinutes: number } | null;
  allDays: DayStats[];
}

/**
 * Aggregates heatmap cells by day-of-week: median of the cells' median
 * response times per day. Days with no leads are omitted; best/worst are
 * null when no day has any replied conversation.
 */
export function dayBreakdown(heatmap: HeatmapCell[]): DayBreakdown {
  const byDay = new Map<number, { medians: number[]; leads: number }>();
  for (const cell of heatmap) {
    let entry = byDay.get(cell.day);
    if (!entry) {
      entry = { medians: [], leads: 0 };
      byDay.set(cell.day, entry);
    }
    entry.leads += cell.leadCount;
    if (cell.medianResponseMinutes !== null) entry.medians.push(cell.medianResponseMinutes);
  }
  const allDays: DayStats[] = [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, entry]) => ({
      day: DAY_NAMES[day],
      medianResponseMinutes: percentile(
        entry.medians.sort((a, b) => a - b),
        50
      ),
      leadCount: entry.leads,
    }));
  const withMedian = allDays.filter(
    (d): d is DayStats & { medianResponseMinutes: number } => d.medianResponseMinutes !== null
  );
  let bestDay: DayBreakdown['bestDay'] = null;
  let worstDay: DayBreakdown['worstDay'] = null;
  for (const d of withMedian) {
    if (!bestDay || d.medianResponseMinutes < bestDay.medianResponseMinutes) {
      bestDay = { day: d.day, medianResponseMinutes: d.medianResponseMinutes };
    }
    if (!worstDay || d.medianResponseMinutes > worstDay.medianResponseMinutes) {
      worstDay = { day: d.day, medianResponseMinutes: d.medianResponseMinutes };
    }
  }
  return { bestDay, worstDay, allDays };
}

// ---------------------------------------------------------------------------
// After-hours deep-dive metrics
// ---------------------------------------------------------------------------

/** Lead conversations whose first inbound message arrived outside business hours. */
function afterHoursLeads(conversations: Conversation[], hours: BusinessHours): Conversation[] {
  return conversations.filter(
    (c) =>
      c.firstLeadMessage !== null && !isWithinBusinessHours(c.firstLeadMessage.timestamp, hours)
  );
}

export interface AfterHoursRevenueAtRisk {
  afterHoursZeroReply: number;
  afterHoursTotal: number;
  conversionRate: number;
  avgTicketValue: number;
  revenueAtRisk: number;
}

/**
 * Revenue at risk from after-hours leads that never got a reply. Lead-level
 * and consistent with zeroReplyRate: unique patients (chats) with at least one
 * after-hours-initiated conversation who were never replied to at all — one
 * patient messaging three times is one lost patient, not three.
 */
export function afterHoursRevenueAtRisk(
  conversations: Conversation[],
  conversionRate: number,
  avgTicketValue: number,
  businessHours: BusinessHours
): AfterHoursRevenueAtRisk {
  const afterHours = afterHoursLeads(conversations, businessHours);
  const everReplied = chatsEverReplied(conversations);
  const afterHoursChats = new Set(afterHours.map((c) => c.chatJid ?? ''));
  const afterHoursZeroReply = [...afterHoursChats].filter((jid) => !everReplied.has(jid)).length;
  return {
    afterHoursZeroReply,
    afterHoursTotal: afterHoursChats.size,
    conversionRate,
    avgTicketValue,
    revenueAtRisk: afterHoursZeroReply * conversionRate * avgTicketValue,
  };
}

/**
 * Next business opening time (Unix seconds) strictly relevant to a lead that
 * arrived at `timestamp`. If the timestamp falls on a business day before
 * opening, the open is that same day's startHour; otherwise the startHour of
 * the next day in daysOfWeek.
 */
export function nextBusinessOpenTimestamp(
  timestamp: number,
  businessHours: BusinessHours
): number {
  if (businessHours.daysOfWeek.length === 0) return timestamp;
  const d = new Date(timestamp * 1000);
  if (businessHours.daysOfWeek.includes(d.getDay()) && d.getHours() < businessHours.startHour) {
    return (
      new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate(),
        businessHours.startHour,
        0,
        0
      ).getTime() / 1000
    );
  }
  const cursor = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  do {
    cursor.setDate(cursor.getDate() + 1);
  } while (!businessHours.daysOfWeek.includes(cursor.getDay()));
  cursor.setHours(businessHours.startHour, 0, 0, 0);
  return cursor.getTime() / 1000;
}

export interface NextMorningReplyRate {
  repliedWithin1hr: number;
  totalReplied: number;
  /** Fraction 0-1 of replied after-hours leads answered within 1hr of opening. */
  rate: number;
  medianMinutesFromOpen: number | null;
}

/**
 * Of after-hours leads that eventually got a reply: how many heard back within
 * one hour of the next business opening.
 */
export function nextMorningReplyRate(
  conversations: Conversation[],
  businessHours: BusinessHours
): NextMorningReplyRate {
  const replied = afterHoursLeads(conversations, businessHours).filter(
    (c) => firstResponseTime(c) !== null
  );
  let repliedWithin1hr = 0;
  const minutesFromOpen: number[] = [];
  for (const conv of replied) {
    const open = nextBusinessOpenTimestamp(conv.firstLeadMessage!.timestamp, businessHours);
    const replyTs = conv.firstClinicReply!.timestamp;
    if (replyTs <= open + 3600) repliedWithin1hr++;
    minutesFromOpen.push((replyTs - open) / 60);
  }
  const totalReplied = replied.length;
  // Median wait is only meaningful for leads replied AFTER opening —
  // leads replied before opening (e.g. 6am msg → 8am reply, both before 9am)
  // were handled quickly and aren't part of the "morning backlog" story.
  const afterOpen = minutesFromOpen.filter((m) => m >= 0).sort((a, b) => a - b);
  return {
    repliedWithin1hr,
    totalReplied,
    rate: totalReplied === 0 ? 0 : repliedWithin1hr / totalReplied,
    medianMinutesFromOpen:
      afterOpen.length === 0 ? null : percentile(afterOpen, 50),
  };
}

export type AfterHoursBucketKey = 'evening' | 'lateNight' | 'earlyMorning' | 'closedDay';

export interface AfterHoursBucket {
  label: string;
  count: number;
  percentage: number;
}

export interface AfterHoursTimeBuckets {
  /** Chronological order: evening, lateNight, earlyMorning, closedDay. */
  buckets: AfterHoursBucket[];
  total: number;
}

const AFTER_HOURS_BUCKET_LABELS: Record<AfterHoursBucketKey, string> = {
  evening: 'Evening (7pm-midnight)',
  lateNight: 'Late night (midnight-6am)',
  earlyMorning: 'Early morning (6-9am)',
  closedDay: 'Closed days',
};

/** Classifies each after-hours lead's first message into a time-of-day bucket. */
export function afterHoursTimeBuckets(
  conversations: Conversation[],
  businessHours: BusinessHours
): AfterHoursTimeBuckets {
  const counts: Record<AfterHoursBucketKey, number> = {
    evening: 0,
    lateNight: 0,
    earlyMorning: 0,
    closedDay: 0,
  };
  const leads = afterHoursLeads(conversations, businessHours);
  for (const conv of leads) {
    const d = new Date(conv.firstLeadMessage!.timestamp * 1000);
    const hour = d.getHours();
    if (!businessHours.daysOfWeek.includes(d.getDay())) counts.closedDay++;
    else if (hour >= businessHours.endHour && hour < 24) counts.evening++;
    else if (hour >= 0 && hour < 6) counts.lateNight++;
    else if (hour >= 6 && hour < businessHours.startHour) counts.earlyMorning++;
  }
  const total = leads.length;
  const order: AfterHoursBucketKey[] = ['evening', 'lateNight', 'earlyMorning', 'closedDay'];
  return {
    buckets: order.map((key) => ({
      label: AFTER_HOURS_BUCKET_LABELS[key],
      count: counts[key],
      percentage: total === 0 ? 0 : (counts[key] / total) * 100,
    })),
    total,
  };
}

/** Default fast-reply re-engagement rate when the local sample is too small. */
export const DEFAULT_FAST_REPLY_RE_ENGAGEMENT_RATE = 0.8;

export interface InstantReplyRecoverable {
  /** Fraction 0-1 of fast-replied during-hours leads that re-engaged. */
  fastReplyReEngagementRate: number;
  fastReplySampleSize: number;
  assumptionUsed: boolean;
  lostCohort: number;
  /** Fraction 0-1 of replied after-hours leads that re-engaged. */
  actualAfterHoursReEngagementRate: number;
  recoverableLeads: number;
  recoverableBookings: number;
  recoverableRevenue: number;
}


/**
 * Estimates bookings/revenue an instant after-hours reply would recover, using
 * the clinic's own during-hours fast-reply re-engagement rate as the benchmark.
 */
export function instantReplyRecoverable(
  conversations: Conversation[],
  businessHours: BusinessHours,
  conversionRate: number,
  avgTicketValue: number
): InstantReplyRecoverable {
  const duringHoursFast = conversations.filter((c) => {
    if (!c.firstLeadMessage || !isWithinBusinessHours(c.firstLeadMessage.timestamp, businessHours))
      return false;
    const frt = firstResponseTime(c);
    return frt !== null && frt <= 5;
  });
  const fastReplySampleSize = duringHoursFast.length;
  const assumptionUsed = fastReplySampleSize < 5;
  const fastReplyReEngagementRate = assumptionUsed
    ? DEFAULT_FAST_REPLY_RE_ENGAGEMENT_RATE
    : duringHoursFast.filter((c) => c.reEngagedAfterReply).length / fastReplySampleSize;

  // Unique patients (chats): one lead with three slow after-hours sessions is
  // one recoverable lead, not three.
  const afterHours = afterHoursLeads(conversations, businessHours);
  const lostCohort = new Set(
    afterHours
      .filter((c) => {
        if (firstResponseTime(c) === null) return true;
        const open = nextBusinessOpenTimestamp(c.firstLeadMessage!.timestamp, businessHours);
        return c.firstClinicReply!.timestamp > open + 3600;
      })
      .map((c) => c.chatJid ?? '')
  ).size;

  const afterHoursReplied = afterHours.filter((c) => firstResponseTime(c) !== null);
  const actualAfterHoursReEngagementRate =
    afterHoursReplied.length === 0
      ? 0
      : afterHoursReplied.filter((c) => c.reEngagedAfterReply).length / afterHoursReplied.length;

  const recoverableLeads =
    lostCohort * Math.max(0, fastReplyReEngagementRate - actualAfterHoursReEngagementRate);
  const recoverableBookings = recoverableLeads * conversionRate;
  return {
    fastReplyReEngagementRate,
    fastReplySampleSize,
    assumptionUsed,
    lostCohort,
    actualAfterHoursReEngagementRate,
    recoverableLeads,
    recoverableBookings,
    recoverableRevenue: recoverableBookings * avgTicketValue,
  };
}

// ---------------------------------------------------------------------------
// computeAllAuditMetrics
// ---------------------------------------------------------------------------

export interface ConversationSummary {
  chatJid: string | null;
  startTime: number;
  firstLeadMessageTime: number | null;
  firstResponseMinutes: number | null;
  /**
   * 'never' = this lead got no reply in ANY conversation; 'unanswered' = this
   * conversation got no reply but the lead was replied to in another session.
   */
  status: 'replied' | 'delayed' | 'unanswered' | 'never';
  messageCount: number;
}

export interface AuditSummary {
  /** Percentage (0-100) of lead conversations that never got a reply. */
  zeroReplyRate: number;
  zeroReplyCount: number;
  totalLeads: number;
}

export interface AfterHoursLeadShareResponse {
  count: number;
  percentage: number;
  total: number;
  repliedCount: number;
  replyPercentage: number;
}

export interface AuditReport {
  options: ResolvedMetricOptions;
  totalConversations: number;
  leadConversations: number;
  /** Number of distinct templated/auto-greeting reply texts excluded from "real reply". */
  templatedReplyTexts: number;
  summary: AuditSummary;
  responseTimeBuckets: ResponseTimeBuckets;
  zeroReply: ZeroReplyRate;
  afterHours: AfterHoursLeadShare;
  afterHoursLeadShare: AfterHoursLeadShareResponse;
  delayDropoff: ResponseDelayDropoff;
  staffHours: StaffHoursConsumed;
  rounds: BackAndForthRounds;
  variance: ResponseTimeVariance;
  heatmap: HeatmapCell[];
  repeatQuestions: RepeatQuestionFrequency;
  revenueAtRisk: RevenueAtRisk;
  staffCost: StaffCost;
  meanReplyTime: MeanReplyTime;
  dayBreakdown: DayBreakdown;
  afterHoursRevenueAtRisk: AfterHoursRevenueAtRisk;
  nextMorningReplyRate: NextMorningReplyRate;
  afterHoursTimeBuckets: AfterHoursTimeBuckets;
  instantReplyRecoverable: InstantReplyRecoverable;
  conversations: ConversationSummary[];
}

function summarizeConversation(conv: Conversation, chatEverReplied: boolean): ConversationSummary {
  const frt = firstResponseTime(conv);
  return {
    chatJid: conv.chatJid,
    startTime: conv.startTime,
    firstLeadMessageTime: conv.firstLeadMessage?.timestamp ?? null,
    firstResponseMinutes: frt,
    status:
      frt !== null
        ? frt > 15
          ? 'delayed'
          : 'replied'
        : chatEverReplied
          ? 'unanswered'
          : 'never',
    messageCount: conv.messages.length,
  };
}

/**
 * Runs the full audit over a message set. Messages may span multiple chats —
 * they are grouped per chat_jid before conversation detection. Only
 * lead-initiated conversations feed the metrics.
 */
export function computeAllAuditMetrics(
  messages: AuditMessage[],
  options: MetricOptions = {},
  windowLabel = '30d'
): AuditReport {
  const resolved = resolveOptions(options);

  // Templates are identified globally (across all chats), then excluded from
  // what counts as a real reply. Media/empty-text replies are never templates.
  const templateTexts = buildTemplateTextSet(messages, resolved.templateMinChats);
  const isSubstantiveReply = (m: AuditMessage): boolean =>
    !m.message_text || !templateTexts.has(m.message_text);

  const byChat = new Map<string, AuditMessage[]>();
  for (const msg of messages) {
    const key = msg.chat_jid ?? '';
    let list = byChat.get(key);
    if (!list) {
      list = [];
      byChat.set(key, list);
    }
    list.push(msg);
  }

  const allConversations: Conversation[] = [];
  for (const chatMessages of byChat.values()) {
    allConversations.push(
      ...groupMessagesIntoConversations(
        chatMessages,
        resolved.gapThresholdMinutes,
        isSubstantiveReply
      )
    );
  }
  const leads = filterLeadConversations(allConversations);

  const zeroReply = zeroReplyRate(leads);
  const afterHours = afterHoursLeadShare(leads, resolved.businessHours);
  const staffHours = staffHoursConsumed(leads, resolved.secondsPerMessage);
  const repeatQuestions = repeatQuestionFrequency(leads);
  const heatmap = dayHourHeatmap(leads);

  return {
    options: resolved,
    totalConversations: allConversations.length,
    leadConversations: leads.length,
    templatedReplyTexts: templateTexts.size,
    summary: {
      zeroReplyRate: zeroReply.percentage,
      zeroReplyCount: zeroReply.neverReplied,
      totalLeads: zeroReply.total,
    },
    responseTimeBuckets: responseTimeBuckets(leads),
    zeroReply,
    afterHours,
    afterHoursLeadShare: {
      count: afterHours.afterHoursCount,
      percentage: afterHours.percentage,
      total: afterHours.total,
      repliedCount: afterHours.repliedCount,
      replyPercentage: afterHours.replyPercentage,
    },
    delayDropoff: responseDelayDropoff(leads),
    staffHours,
    rounds: backAndForthRounds(leads),
    variance: responseTimeVariance(leads),
    heatmap,
    repeatQuestions,
    revenueAtRisk: revenueAtRisk(leads, resolved.conversionRate, resolved.avgTicketValue),
    staffCost: staffCost(staffHours),
    meanReplyTime: meanReplyTime(leads, windowLabel),
    dayBreakdown: dayBreakdown(heatmap),
    afterHoursRevenueAtRisk: afterHoursRevenueAtRisk(
      leads,
      resolved.conversionRate,
      resolved.avgTicketValue,
      resolved.businessHours
    ),
    nextMorningReplyRate: nextMorningReplyRate(leads, resolved.businessHours),
    afterHoursTimeBuckets: afterHoursTimeBuckets(leads, resolved.businessHours),
    instantReplyRecoverable: instantReplyRecoverable(
      leads,
      resolved.businessHours,
      resolved.conversionRate,
      resolved.avgTicketValue
    ),
    conversations: (() => {
      const replied = chatsEverReplied(leads);
      return leads.map((c) => summarizeConversation(c, replied.has(c.chatJid ?? '')));
    })(),
  };
}
