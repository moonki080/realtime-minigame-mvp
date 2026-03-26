import { createRoomCode } from "../utils/ids.mjs";
import { roomTtlSeconds } from "../utils/timers.mjs";

const memoryRooms = new Map();
const memoryIndex = new Set();

function serializeSubmissionMap(entries) {
  return [...entries.values()].map((entry) => ({
    ...entry
  }));
}

function serializePlayer(player) {
  return {
    ...player
  };
}

function serializeRoom(room) {
  return {
    ...room,
    players: [...room.players.values()].map(serializePlayer),
    currentRound: room.currentRound
      ? {
          ...room.currentRound,
          practiceSubmissions: serializeSubmissionMap(room.currentRound.practiceSubmissions),
          mainSubmissions: serializeSubmissionMap(room.currentRound.mainSubmissions)
        }
      : null
  };
}

function reviveSubmissionMap(entries) {
  return new Map((entries || []).map((entry) => [entry.playerId, { ...entry }]));
}

function deserializeRoom(room) {
  if (!room) {
    return null;
  }

  return {
    ...room,
    players: new Map((room.players || []).map((player) => [player.id, { ...player }])),
    currentRound: room.currentRound
      ? {
          ...room.currentRound,
          practiceSubmissions: reviveSubmissionMap(room.currentRound.practiceSubmissions),
          mainSubmissions: reviveSubmissionMap(room.currentRound.mainSubmissions)
        }
      : null
  };
}

function getStoreConfig() {
  return {
    url: process.env.ROOM_STORE_URL || "",
    token: process.env.ROOM_STORE_TOKEN || "",
    prefix: process.env.ROOM_STORE_PREFIX || "realtime-minigame-mvp"
  };
}

function createStoreKey(prefix, key) {
  return `${prefix}:${key}`;
}

async function runExternalCommand(args) {
  const { url, token } = getStoreConfig();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(args)
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || "외부 room store 요청에 실패했습니다.");
  }

  if (payload.error) {
    throw new Error(typeof payload.error === "string" ? payload.error : "외부 room store 응답이 비정상입니다.");
  }

  return payload.result ?? null;
}

async function upstashGet(key) {
  const result = await runExternalCommand(["GET", key]);
  if (typeof result !== "string") {
    return result || null;
  }
  return result ? JSON.parse(result) : null;
}

async function upstashSet(key, value, ttlSeconds = roomTtlSeconds) {
  await runExternalCommand(["SET", key, JSON.stringify(value), "EX", String(ttlSeconds)]);
}

async function upstashDel(key) {
  await runExternalCommand(["DEL", key]);
}

function hasExternalStore() {
  const { url, token } = getStoreConfig();
  return Boolean(url && token);
}

async function loadIndex() {
  if (!hasExternalStore()) {
    return [...memoryIndex.values()];
  }

  const { prefix } = getStoreConfig();
  return (await upstashGet(createStoreKey(prefix, "index:rooms"))) || [];
}

async function saveIndex(index) {
  if (!hasExternalStore()) {
    memoryIndex.clear();
    index.forEach((code) => memoryIndex.add(code));
    return;
  }

  const { prefix } = getStoreConfig();
  await upstashSet(createStoreKey(prefix, "index:rooms"), index);
}

export async function getRoom(roomCode) {
  if (!roomCode) {
    return null;
  }

  if (!hasExternalStore()) {
    return deserializeRoom(memoryRooms.get(roomCode));
  }

  const { prefix } = getStoreConfig();
  return deserializeRoom(await upstashGet(createStoreKey(prefix, `room:${roomCode}`)));
}

export async function saveRoom(room) {
  const serialized = serializeRoom(room);
  if (!hasExternalStore()) {
    memoryRooms.set(room.code, serialized);
    memoryIndex.add(room.code);
    return room;
  }

  const { prefix } = getStoreConfig();
  await upstashSet(createStoreKey(prefix, `room:${room.code}`), serialized);
  const index = new Set(await loadIndex());
  index.add(room.code);
  await saveIndex([...index.values()]);
  return room;
}

export async function deleteRoom(roomCode) {
  if (!hasExternalStore()) {
    memoryRooms.delete(roomCode);
    memoryIndex.delete(roomCode);
    return;
  }

  const { prefix } = getStoreConfig();
  await upstashDel(createStoreKey(prefix, `room:${roomCode}`));
  const index = new Set(await loadIndex());
  index.delete(roomCode);
  await saveIndex([...index.values()]);
}

export async function listRooms() {
  const index = await loadIndex();
  const rooms = [];
  for (const roomCode of index) {
    const room = await getRoom(roomCode);
    if (room) {
      rooms.push(room);
    }
  }
  return rooms;
}

export async function generateUniqueRoomCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const next = createRoomCode();
    if (!(await getRoom(next))) {
      return next;
    }
  }
  throw new Error("방 코드를 생성하지 못했습니다. 다시 시도해 주세요.");
}
