/**
 * Picks the next free consultation slot. Pure and deterministic (no clock, no network): everything is passed in.
 * India has no daylight saving, so IST arithmetic is a fixed +05:30 offset from UTC.
 */
export const IST_OFFSET_MIN = 330;

export interface SlotPolicy {
  durationMin: number;
  /** First and last wall-clock hour (IST) a consultation may occupy: slots must start >= dayStartHour and end <= dayEndHour. */
  dayStartHour: number;
  dayEndHour: number;
  /** Spacing between candidate start times. */
  stepMin: number;
  /** Days of week the studio holds consultations (0 = Sunday … 6 = Saturday). */
  daysOpen: number[];
  /** Never schedule sooner than this many hours from now. */
  minLeadHours: number;
  /** How many days ahead to look. */
  searchDays: number;
}

/**
 * Defaults taken from the case: front desk 10 AM–7 PM; consultations also happen on Saturdays (PDF W03). Sundays closed.
 * 24 h lead time and a 14-day horizon are DEFAULTS awaiting Nikhil's confirmation (docs/business-rules.md).
 */
export const DEFAULT_SLOT_POLICY: SlotPolicy = { durationMin: 60, dayStartHour: 10, dayEndHour: 19, stepMin: 60, daysOpen: [1, 2, 3, 4, 5, 6], minLeadHours: 24, searchDays: 14 };

export interface Interval { start: Date; end: Date }

const istMidnightUtc = (d: Date): number => {
  const ist = d.getTime() + IST_OFFSET_MIN * 60_000;
  return Math.floor(ist / 86_400_000) * 86_400_000 - IST_OFFSET_MIN * 60_000; // UTC instant of 00:00 IST on that IST date
};

export function findNextSlot(busy: Interval[], now: Date, policy: SlotPolicy = DEFAULT_SLOT_POLICY): { start: Date; end: Date } | null {
  const earliest = now.getTime() + policy.minLeadHours * 3_600_000;
  const day0 = istMidnightUtc(now);
  for (let d = 0; d <= policy.searchDays; d++) {
    const midnight = day0 + d * 86_400_000;
    const dow = new Date(midnight + IST_OFFSET_MIN * 60_000).getUTCDay();
    if (!policy.daysOpen.includes(dow)) continue;
    for (let m = policy.dayStartHour * 60; m + policy.durationMin <= policy.dayEndHour * 60; m += policy.stepMin) {
      const start = midnight + m * 60_000;
      const end = start + policy.durationMin * 60_000;
      if (start < earliest) continue;
      if (busy.some((b) => b.start.getTime() < end && b.end.getTime() > start)) continue;
      return { start: new Date(start), end: new Date(end) };
    }
  }
  return null;
}
