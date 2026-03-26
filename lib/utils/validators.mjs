export function normalizeRoomCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

export function normalizeNickname(value, fallback = "참가자") {
  return String(value || "").trim() || fallback;
}

export function normalizeRoomName(value, fallback = "회식 미니게임") {
  return String(value || "").trim() || fallback;
}

export function normalizeRoundCount(value) {
  return Number(value) === 8 ? 8 : 5;
}

export function normalizePrizeList(prizes, roundCount) {
  return Array.from({ length: roundCount }, (_, index) => String(prizes?.[index] || "").trim() || "");
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
