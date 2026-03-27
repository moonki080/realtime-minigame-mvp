export const presenceTimeoutMs = Number(process.env.PRESENCE_TIMEOUT_MS || 15000);
export const bootstrapTimeoutMs = Number(process.env.BOOTSTRAP_TIMEOUT_MS || 1200);
export const practiceLeadInMs = Number(process.env.PRACTICE_LEAD_IN_MS || 1800);
export const mainIntroMs = Number(process.env.MAIN_INTRO_MS || 3500);
export const scoringDelayMs = Number(process.env.SCORING_DELAY_MS || 700);
export const roomTtlSeconds = Number(process.env.ROOM_TTL_SECONDS || 60 * 60 * 12);

export function now() {
  return Date.now();
}

export function isViewerOnline(lastSeenAt, timestamp = now()) {
  return Number(lastSeenAt || 0) > 0 && timestamp - Number(lastSeenAt || 0) <= presenceTimeoutMs;
}
