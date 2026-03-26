import { randomUUID } from "node:crypto";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function createClientId() {
  return randomUUID();
}

export function createTournamentId() {
  return randomUUID();
}

export function createPlayerId() {
  return randomUUID();
}

export function createRecoveryCode(length = 8) {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return value;
}

export function createRoomCode(length = 5) {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return value;
}
