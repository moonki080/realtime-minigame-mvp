import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_GAME_IDS,
  GAME_DEFINITIONS,
  PLAYER_STATES,
  ROOM_STATES,
  createRng,
  hashString,
  selectGames
} from "./shared/gameData.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const sharedDir = path.join(__dirname, "shared");
const defaultStateFile = path.join(__dirname, "data", "runtime-state.json");
const processStartedAt = Date.now();
const port = Number(process.env.PORT || 4310);
const host = process.env.HOST || "0.0.0.0";
const practiceLeadInMs = Number(process.env.PRACTICE_LEAD_IN_MS || 1800);
const mainIntroMs = Number(process.env.MAIN_INTRO_MS || 3500);
const scoringDelayMs = Number(process.env.SCORING_DELAY_MS || 700);
const eventLogLimit = Number(process.env.EVENT_LOG_LIMIT || 120);
const archiveLimit = Number(process.env.ARCHIVE_LIMIT || 80);
const shutdownGraceMs = Number(process.env.SHUTDOWN_GRACE_MS || 8000);
const stateFile = process.env.STATE_FILE || defaultStateFile;
const persistenceEnabled = process.env.PERSIST_STATE !== "0";
const resumableRoundStates = new Set(["ROUND_INTRO", "PRACTICE_RESULT", "MAIN_INTRO", "PRACTICE_PLAY", "MAIN_PLAY", "ROUND_RESULT"]);

const sessions = new Map();
const rooms = new Map();
const roomCodes = new Set();
const archives = [];
let shuttingDown = false;
let persistTimer = null;
let persistSequence = Promise.resolve();

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function buildHealthPayload() {
  const activeStreams = [...sessions.values()].filter((session) => Boolean(session.stream)).length;
  const onlinePlayers = [...rooms.values()].reduce(
    (count, room) => count + [...room.players.values()].filter((player) => player.connected).length,
    0
  );

  return {
    ok: !shuttingDown,
    shuttingDown,
    uptimeSec: Math.round((Date.now() - processStartedAt) / 1000),
    startedAt: processStartedAt,
    rooms: rooms.size,
    sessions: sessions.size,
    activeStreams,
    onlinePlayers,
    timestamp: Date.now()
  };
}

function cloneObjectArray(items) {
  return (items || []).map((item) => ({ ...item }));
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function serializeSubmissionEntry(entry) {
  return {
    playerId: entry.playerId,
    status: entry.status,
    score: entry.score,
    rankVector: [...(entry.rankVector || [])],
    completedAt: entry.completedAt,
    metrics: cloneMetrics(entry.metrics)
  };
}

function serializeRound(round) {
  if (!round) {
    return null;
  }

  return {
    roundIndex: round.roundIndex,
    gameId: round.gameId,
    title: round.title,
    description: round.description,
    intro: round.intro,
    prize: round.prize,
    practiceSeed: round.practiceSeed,
    mainSeed: round.mainSeed,
    practiceConfig: round.practiceConfig,
    mainConfig: round.mainConfig,
    practiceSubmissions: [...round.practiceSubmissions.values()].map(serializeSubmissionEntry),
    mainSubmissions: [...round.mainSubmissions.values()].map(serializeSubmissionEntry),
    practiceStartedAt: round.practiceStartedAt,
    practiceEndsAt: round.practiceEndsAt,
    mainIntroEndsAt: round.mainIntroEndsAt,
    mainStartedAt: round.mainStartedAt,
    mainEndsAt: round.mainEndsAt,
    practiceEnabled: round.practiceEnabled,
    results: round.results.map((entry) => ({
      ...entry,
      metrics: cloneMetrics(entry.metrics)
    }))
  };
}

function serializePlayer(player) {
  return {
    id: player.id,
    clientId: player.clientId,
    nickname: player.nickname,
    connected: player.connected,
    spectator: player.spectator,
    state: player.state,
    joinedAt: player.joinedAt,
    totalPoints: player.totalPoints,
    roundWins: player.roundWins,
    secondPlaces: player.secondPlaces,
    placements: [...player.placements],
    roundResults: player.roundResults.map((entry) => ({
      ...entry,
      metrics: cloneMetrics(entry.metrics)
    }))
  };
}

function serializeRoom(room) {
  return {
    code: room.code,
    name: room.name,
    createdAt: room.createdAt,
    tournamentId: room.tournamentId,
    roundCount: room.roundCount,
    prizes: [...room.prizes],
    state: room.state,
    mode: room.mode,
    adminClientId: room.adminClientId,
    adminRecoveryCode: room.adminRecoveryCode,
    players: [...room.players.values()].map(serializePlayer),
    selectedGameIds: [...room.selectedGameIds],
    currentRoundIndex: room.currentRoundIndex,
    currentRound: serializeRound(room.currentRound),
    paused: room.paused ? { ...room.paused } : null,
    lockedPlayerIds: [...room.lockedPlayerIds],
    top3: cloneObjectArray(room.top3),
    finalRanking: cloneObjectArray(room.finalRanking),
    roundHistory: (room.roundHistory || []).map((entry) => ({
      ...entry,
      results: entry.results.map((result) => ({
        ...result,
        metrics: cloneMetrics(result.metrics)
      })),
      standings: cloneObjectArray(entry.standings)
    })),
    eventLog: cloneObjectArray(room.eventLog)
  };
}

function serializeSession(session) {
  return {
    clientId: session.clientId,
    roomCode: session.roomCode,
    role: session.role,
    playerId: session.playerId,
    nickname: session.nickname,
    lastSeenAt: session.lastSeenAt
  };
}

function serializeArchive(archive) {
  return cloneJson(archive);
}

function buildPersistencePayload() {
  return {
    version: 2,
    persistedAt: Date.now(),
    rooms: [...rooms.values()].map(serializeRoom),
    archives: archives.map(serializeArchive),
    sessions: [...sessions.values()]
      .filter((session) => session.roomCode || session.role || session.nickname)
      .map(serializeSession)
  };
}

async function persistStateNow() {
  if (!persistenceEnabled || !stateFile) {
    return;
  }

  const payload = buildPersistencePayload();
  const nextPersist = async () => {
    const tempFile = `${stateFile}.tmp`;
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tempFile, stateFile);
  };

  persistSequence = persistSequence
    .catch(() => {})
    .then(nextPersist)
    .catch((error) => {
      console.error("Failed to persist runtime state:", error);
    });

  return persistSequence;
}

function scheduleStatePersist() {
  if (!persistenceEnabled || !stateFile || shuttingDown) {
    return;
  }

  if (persistTimer) {
    clearTimeout(persistTimer);
  }

  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistStateNow();
  }, 25);
  persistTimer.unref?.();
}

function reviveSubmissionEntry(entry) {
  return {
    playerId: entry.playerId,
    status: entry.status,
    score: Number(entry.score || 0),
    rankVector: Array.isArray(entry.rankVector) ? entry.rankVector.map((value) => Number(value || 0)) : [Number(entry.score || 0)],
    completedAt: Number(entry.completedAt || Date.now()),
    metrics: cloneMetrics(entry.metrics) || {}
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function createSession(clientIdInput) {
  const clientId = clientIdInput || randomUUID();
  const existing = sessions.get(clientId);
  if (existing) {
    existing.lastSeenAt = Date.now();
    return existing;
  }

  const session = {
    clientId,
    roomCode: null,
    role: null,
    playerId: null,
    nickname: null,
    stream: null,
    lastSeenAt: Date.now()
  };
  sessions.set(clientId, session);
  return session;
}

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  while (true) {
    let code = "";
    for (let index = 0; index < 5; index += 1) {
      const rng = createRng(`${Date.now()}-${Math.random()}-${index}`);
      code += alphabet[Math.floor(rng() * alphabet.length)];
    }
    if (!roomCodes.has(code)) {
      roomCodes.add(code);
      return code;
    }
  }
}

function generateRecoveryCode(length = 8) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let index = 0; index < length; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function createPlayer({ nickname, clientId, spectator = false }) {
  return {
    id: randomUUID(),
    clientId,
    nickname,
    connected: true,
    spectator,
    state: spectator ? "SPECTATING" : "WAITING",
    joinedAt: Date.now(),
    totalPoints: 0,
    roundWins: 0,
    secondPlaces: 0,
    placements: [],
    roundResults: []
  };
}

function clearRoomTimers(room) {
  room.timers.forEach((timer) => clearTimeout(timer));
  room.timers = [];
}

function scheduleRoom(room, delayMs, task) {
  const timer = setTimeout(task, delayMs);
  room.timers.push(timer);
  return timer;
}

function sortRankedEntries(entries) {
  return [...entries].sort((left, right) => {
    const leftVector = left.rankVector ?? [left.score ?? 0];
    const rightVector = right.rankVector ?? [right.score ?? 0];
    const maxLength = Math.max(leftVector.length, rightVector.length);
    for (let index = 0; index < maxLength; index += 1) {
      const leftValue = leftVector[index] ?? 0;
      const rightValue = rightVector[index] ?? 0;
      if (leftValue !== rightValue) {
        return rightValue - leftValue;
      }
    }
    return (left.completedAt ?? Number.MAX_SAFE_INTEGER) - (right.completedAt ?? Number.MAX_SAFE_INTEGER);
  });
}

function rankPlayersForFinal(room) {
  return [...room.lockedPlayerIds]
    .map((playerId) => room.players.get(playerId))
    .sort((left, right) => {
      if (left.totalPoints !== right.totalPoints) {
        return right.totalPoints - left.totalPoints;
      }
      if (left.roundWins !== right.roundWins) {
        return right.roundWins - left.roundWins;
      }
      if (left.secondPlaces !== right.secondPlaces) {
        return right.secondPlaces - left.secondPlaces;
      }
      const leftLastPlacement = left.placements[left.placements.length - 1] ?? Number.MAX_SAFE_INTEGER;
      const rightLastPlacement = right.placements[right.placements.length - 1] ?? Number.MAX_SAFE_INTEGER;
      if (leftLastPlacement !== rightLastPlacement) {
        return leftLastPlacement - rightLastPlacement;
      }
      return left.joinedAt - right.joinedAt;
    })
    .map((player, index) => ({
      playerId: player.id,
      nickname: player.nickname,
      totalPoints: player.totalPoints,
      rank: index + 1,
      roundWins: player.roundWins,
      secondPlaces: player.secondPlaces
    }));
}

function getModeConfig(gameId, mode, seed) {
  return GAME_DEFINITIONS[gameId].buildChallenge(seed, mode);
}

function buildRound(room, roundIndex) {
  const gameId = room.selectedGameIds[roundIndex];
  const game = GAME_DEFINITIONS[gameId];
  const practiceSeed = hashString(`${room.code}-${roundIndex}-${gameId}-practice`);
  const mainSeed = hashString(`${room.code}-${roundIndex}-${gameId}-main`);
  return {
    roundIndex,
    gameId,
    title: game.title,
    description: game.description,
    intro: game.intro,
    prize: room.prizes[roundIndex] || "",
    practiceSeed,
    mainSeed,
    practiceConfig: getModeConfig(gameId, "practice", practiceSeed),
    mainConfig: getModeConfig(gameId, "main", mainSeed),
    practiceSubmissions: new Map(),
    mainSubmissions: new Map(),
    practiceStartedAt: null,
    practiceEndsAt: null,
    mainIntroEndsAt: null,
    mainStartedAt: null,
    mainEndsAt: null,
    practiceEnabled: true,
    results: []
  };
}

function roomSummary(room) {
  return {
    code: room.code,
    name: room.name,
    createdAt: room.createdAt,
    roundCount: room.roundCount,
    prizes: room.prizes,
    state: room.state,
    mode: room.mode,
    pauseInfo: room.paused
      ? {
          phase: room.paused.phase,
          restartOnResume: room.paused.restartOnResume,
          pausedAt: room.paused.pausedAt
        }
      : null,
    currentRoundIndex: room.currentRoundIndex,
    lockedPlayerCount: room.lockedPlayerIds.length,
    viewerCount: [...room.players.values()].filter((player) => player.connected).length,
    top3: room.top3,
    selectedGames: room.selectedGameIds.map((gameId, index) => ({
      gameId,
      round: index + 1,
      title: GAME_DEFINITIONS[gameId].title,
      category: GAME_DEFINITIONS[gameId].category
    }))
  };
}

function roomDirectoryView(room) {
  const players = [...room.players.values()];
  const participants = players.filter((player) => !player.spectator);
  const spectators = players.filter((player) => player.spectator);
  const currentRoundNumber = room.currentRoundIndex >= 0 ? room.currentRoundIndex + 1 : 0;
  const currentRoundTitle =
    room.currentRound?.title ||
    (currentRoundNumber > 0 ? GAME_DEFINITIONS[room.selectedGameIds[currentRoundNumber - 1]]?.title || null : null);
  const updatedAt = room.eventLog[room.eventLog.length - 1]?.at || room.createdAt;

  return {
    code: room.code,
    name: room.name,
    state: room.state,
    createdAt: room.createdAt,
    updatedAt,
    roundCount: room.roundCount,
    currentRoundIndex: room.currentRoundIndex,
    currentRoundNumber,
    currentRoundTitle,
    participantCount: participants.length,
    connectedParticipantCount: participants.filter((player) => player.connected).length,
    spectatorCount: spectators.length,
    connectedSpectatorCount: spectators.filter((player) => player.connected).length,
    lockedPlayerCount: room.lockedPlayerIds.length,
    canRecoverAdmin: Boolean(room.adminRecoveryCode)
  };
}

function cloneMetrics(metrics) {
  return metrics
    ? {
        label: metrics.label,
        summary: metrics.summary
      }
    : null;
}

function buildRoundHistoryEntry(room, round, standings) {
  return {
    roundIndex: round.roundIndex,
    roundNumber: round.roundIndex + 1,
    gameId: round.gameId,
    title: round.title,
    description: round.description,
    intro: round.intro,
    prize: round.prize,
    practiceEnabled: round.practiceEnabled,
    practiceSubmittedCount: round.practiceSubmissions.size,
    mainSubmittedCount: round.mainSubmissions.size,
    results: round.results.map((entry) => ({
      rank: entry.rank,
      tournamentPoints: entry.tournamentPoints,
      playerId: entry.playerId,
      nickname: entry.nickname,
      score: entry.score,
      metrics: cloneMetrics(entry.metrics),
      prizeWinner: entry.prizeWinner
    })),
    standings: standings.map((entry) => ({
      playerId: entry.playerId,
      nickname: entry.nickname,
      totalPoints: entry.totalPoints,
      rank: entry.rank,
      roundWins: entry.roundWins,
      secondPlaces: entry.secondPlaces
    })),
    publishedAt: Date.now()
  };
}

function buildPlayerReport(player) {
  return {
    id: player.id,
    nickname: player.nickname,
    spectator: player.spectator,
    connected: player.connected,
    state: player.state,
    joinedAt: player.joinedAt,
    totalPoints: player.totalPoints,
    roundWins: player.roundWins,
    secondPlaces: player.secondPlaces,
    placements: [...player.placements],
    roundResults: player.roundResults.map((entry) => ({
      roundIndex: entry.roundIndex,
      gameId: entry.gameId,
      rank: entry.rank,
      tournamentPoints: entry.tournamentPoints,
      score: entry.score,
      metrics: cloneMetrics(entry.metrics)
    }))
  };
}

function buildTournamentReport(room) {
  const participants = room.lockedPlayerIds.length
    ? room.lockedPlayerIds.map((playerId) => room.players.get(playerId)).filter(Boolean)
    : [...room.players.values()].filter((player) => !player.spectator).sort((left, right) => left.joinedAt - right.joinedAt);
  const spectators = [...room.players.values()]
    .filter((player) => player.spectator)
    .sort((left, right) => left.joinedAt - right.joinedAt);

  return {
    exportedAt: Date.now(),
    room: {
      ...roomSummary(room),
      tournamentId: room.tournamentId
    },
    participants: participants.map((player) => buildPlayerReport(player)),
    spectators: spectators.map((player) => buildPlayerReport(player)),
    roundHistory: room.roundHistory.map((entry) => ({
      ...entry,
      results: entry.results.map((result) => ({
        ...result,
        metrics: cloneMetrics(result.metrics)
      })),
      standings: entry.standings.map((standing) => ({ ...standing }))
    })),
    finalRanking: room.finalRanking.map((entry) => ({ ...entry })),
    eventLog: room.eventLog.map((entry) => ({ ...entry })),
    currentRound: room.currentRound
      ? {
          roundIndex: room.currentRound.roundIndex,
          roundNumber: room.currentRound.roundIndex + 1,
          gameId: room.currentRound.gameId,
          title: room.currentRound.title,
          description: room.currentRound.description,
          prize: room.currentRound.prize,
          practiceEnabled: room.currentRound.practiceEnabled,
          state: room.state
        }
      : null
  };
}

function archiveSummaryView(archive) {
  const ranking = archive.report?.finalRanking || [];
  const winner = ranking[0] || null;
  return {
    id: archive.id,
    tournamentId: archive.tournamentId,
    roomCode: archive.roomCode,
    roomName: archive.roomName,
    archivedAt: archive.archivedAt,
    reason: archive.reason,
    state: archive.report?.room?.state || "ENDED",
    roundCount: archive.report?.room?.roundCount || 0,
    completedRoundCount: archive.report?.roundHistory?.length || 0,
    participantCount: archive.report?.participants?.length || 0,
    spectatorCount: archive.report?.spectators?.length || 0,
    winner: winner
      ? {
          nickname: winner.nickname,
          totalPoints: winner.totalPoints,
          roundWins: winner.roundWins
        }
      : null,
    top3: ranking.slice(0, 3).map((entry) => ({
      rank: entry.rank,
      nickname: entry.nickname,
      totalPoints: entry.totalPoints
    }))
  };
}

function archiveSearchText(archive) {
  const ranking = archive.report?.finalRanking || [];
  const participants = archive.report?.participants || [];
  return [
    archive.roomCode,
    archive.roomName,
    archive.report?.room?.name,
    ranking.map((entry) => entry.nickname).join(" "),
    participants.map((entry) => entry.nickname).join(" ")
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function listArchivedTournaments({ query = "", roomCode = "", limit = 24 } = {}) {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  const normalizedRoomCode = String(roomCode || "").trim().toUpperCase();

  return archives
    .filter((archive) => !normalizedRoomCode || archive.roomCode === normalizedRoomCode)
    .filter((archive) => !normalizedQuery || archiveSearchText(archive).includes(normalizedQuery))
    .slice(0, Math.max(1, Math.min(Number(limit) || 24, archiveLimit)))
    .map(archiveSummaryView);
}

function archiveRoomIfNeeded(room, reason = "completed") {
  if (!room?.tournamentId) {
    return null;
  }

  const existingIndex = archives.findIndex((archive) => archive.tournamentId === room.tournamentId);
  if (existingIndex >= 0) {
    return archives[existingIndex];
  }

  const hasMeaningfulProgress =
    room.currentRoundIndex >= 0 || room.roundHistory.some(Boolean) || Boolean(room.finalRanking.length) || room.state === "FINAL_RESULT" || room.state === "ENDED";
  if (!hasMeaningfulProgress) {
    return null;
  }

  const archive = {
    id: room.tournamentId,
    tournamentId: room.tournamentId,
    roomCode: room.code,
    roomName: room.name,
    archivedAt: Date.now(),
    reason,
    report: cloneJson(buildTournamentReport(room))
  };

  archives.unshift(archive);
  if (archives.length > archiveLimit) {
    archives.length = archiveLimit;
  }
  scheduleStatePersist();
  return archive;
}

function restorePlayer(player) {
  return {
    id: player.id,
    clientId: player.clientId || null,
    nickname: player.nickname || "참가자",
    connected: false,
    spectator: Boolean(player.spectator),
    state: player.spectator ? "SPECTATING" : "DISCONNECTED",
    joinedAt: Number(player.joinedAt || Date.now()),
    totalPoints: Number(player.totalPoints || 0),
    roundWins: Number(player.roundWins || 0),
    secondPlaces: Number(player.secondPlaces || 0),
    placements: Array.isArray(player.placements) ? player.placements.map((value) => Number(value || 0)) : [],
    roundResults: Array.isArray(player.roundResults)
      ? player.roundResults.map((entry) => ({
          roundIndex: Number(entry.roundIndex || 0),
          gameId: entry.gameId,
          rank: Number(entry.rank || 0),
          tournamentPoints: Number(entry.tournamentPoints || 0),
          score: Number(entry.score || 0),
          metrics: cloneMetrics(entry.metrics)
        }))
      : []
  };
}

function restoreRound(room, round) {
  if (!round) {
    return null;
  }

  const restored = buildRound(room, Number(round.roundIndex || 0));
  restored.gameId = round.gameId || restored.gameId;
  restored.title = round.title || restored.title;
  restored.description = round.description || restored.description;
  restored.intro = round.intro || restored.intro;
  restored.prize = round.prize ?? restored.prize;
  restored.practiceSeed = Number(round.practiceSeed || restored.practiceSeed);
  restored.mainSeed = Number(round.mainSeed || restored.mainSeed);
  restored.practiceConfig = round.practiceConfig || restored.practiceConfig;
  restored.mainConfig = round.mainConfig || restored.mainConfig;
  restored.practiceSubmissions = new Map((round.practiceSubmissions || []).map((entry) => [entry.playerId, reviveSubmissionEntry(entry)]));
  restored.mainSubmissions = new Map((round.mainSubmissions || []).map((entry) => [entry.playerId, reviveSubmissionEntry(entry)]));
  restored.practiceStartedAt = round.practiceStartedAt ?? null;
  restored.practiceEndsAt = round.practiceEndsAt ?? null;
  restored.mainIntroEndsAt = round.mainIntroEndsAt ?? null;
  restored.mainStartedAt = round.mainStartedAt ?? null;
  restored.mainEndsAt = round.mainEndsAt ?? null;
  restored.practiceEnabled = round.practiceEnabled !== false;
  restored.results = (round.results || []).map((entry) => ({
    ...entry,
    rank: Number(entry.rank || 0),
    tournamentPoints: Number(entry.tournamentPoints || 0),
    score: Number(entry.score || 0),
    prizeWinner: Boolean(entry.prizeWinner),
    metrics: cloneMetrics(entry.metrics)
  }));
  return restored;
}

function restoreRoom(room) {
  const restored = {
    code: room.code,
    name: room.name || "회식 미니게임",
    createdAt: Number(room.createdAt || Date.now()),
    tournamentId: room.tournamentId || randomUUID(),
    roundCount: room.roundCount === 8 ? 8 : 5,
    prizes: Array.from({ length: room.roundCount === 8 ? 8 : 5 }, (_, index) => String(room.prizes?.[index] || "").trim()),
    state: room.state || "WAITING",
    mode: room.mode || "OFFICIAL",
    adminClientId: room.adminClientId,
    adminRecoveryCode: room.adminRecoveryCode || generateRecoveryCode(),
    players: new Map(),
    timers: [],
    selectedGameIds: Array.isArray(room.selectedGameIds) && room.selectedGameIds.length ? [...room.selectedGameIds] : selectGames(room.roundCount === 8 ? 8 : 5, `${room.code}-${Date.now()}`),
    currentRoundIndex: Number(room.currentRoundIndex ?? -1),
    currentRound: null,
    paused: room.paused ? { ...room.paused } : null,
    lockedPlayerIds: Array.isArray(room.lockedPlayerIds) ? [...room.lockedPlayerIds] : [],
    top3: cloneObjectArray(room.top3),
    finalRanking: cloneObjectArray(room.finalRanking),
    roundHistory: (room.roundHistory || []).map((entry) => ({
      ...entry,
      results: (entry.results || []).map((result) => ({
        ...result,
        metrics: cloneMetrics(result.metrics)
      })),
      standings: cloneObjectArray(entry.standings)
    })),
    eventLog: cloneObjectArray(room.eventLog)
  };

  (room.players || []).forEach((player) => {
    const restoredPlayer = restorePlayer(player);
    restored.players.set(restoredPlayer.id, restoredPlayer);
  });

  restored.currentRound = restoreRound(restored, room.currentRound);
  if (restored.state === "LOCKED") {
    restored.state = "ROUND_INTRO";
  }

  return restored;
}

function restoreSession(session) {
  return {
    clientId: session.clientId,
    roomCode: session.roomCode || null,
    role: session.role || null,
    playerId: session.playerId || null,
    nickname: session.nickname || null,
    stream: null,
    lastSeenAt: Number(session.lastSeenAt || Date.now())
  };
}

function restoreRuntimeState(payload) {
  if (!payload || typeof payload !== "object") {
    return;
  }

  archives.length = 0;

  (payload.rooms || []).forEach((room) => {
    if (!room?.code) {
      return;
    }
    const restoredRoom = restoreRoom(room);
    rooms.set(restoredRoom.code, restoredRoom);
    roomCodes.add(restoredRoom.code);
  });

  (payload.sessions || []).forEach((session) => {
    if (!session?.clientId) {
      return;
    }

    const restoredSession = restoreSession(session);
    const room = restoredSession.roomCode ? rooms.get(restoredSession.roomCode) : null;
    if (restoredSession.roomCode && !room) {
      restoredSession.roomCode = null;
      restoredSession.role = null;
      restoredSession.playerId = null;
      restoredSession.nickname = null;
    } else if (restoredSession.playerId && !room?.players.has(restoredSession.playerId)) {
      restoredSession.playerId = null;
      if (restoredSession.role !== "admin" && restoredSession.role !== "display") {
        restoredSession.role = null;
      }
    }
    sessions.set(restoredSession.clientId, restoredSession);
  });

  (payload.archives || []).forEach((archive) => {
    if (!archive?.id || !archive?.report) {
      return;
    }
    archives.push(cloneJson(archive));
  });
}

async function loadPersistedState() {
  if (!persistenceEnabled || !stateFile) {
    return;
  }

  try {
    const raw = await readFile(stateFile, "utf8");
    const payload = JSON.parse(raw);
    restoreRuntimeState(payload);
    if ((payload.rooms || []).length || (payload.sessions || []).length || (payload.archives || []).length) {
      console.log(
        `Restored ${payload.rooms?.length || 0} rooms, ${payload.sessions?.length || 0} sessions and ${payload.archives?.length || 0} archives from ${stateFile}`
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("Failed to load persisted runtime state:", error);
    }
  }
}

function resumeRecoveredRoom(room) {
  clearRoomTimers(room);

  if (!room.currentRound && room.currentRoundIndex >= 0) {
    room.currentRound = buildRound(room, room.currentRoundIndex);
  }

  switch (room.state) {
    case "MAIN_INTRO": {
      const remainingMs = Math.max(0, Number(room.currentRound?.mainIntroEndsAt || Date.now()) - Date.now());
      scheduleRoom(room, remainingMs, () => startMainPlay(room));
      break;
    }
    case "PRACTICE_PLAY": {
      const remainingMs = Math.max(0, Number(room.currentRound?.practiceEndsAt || Date.now()) - Date.now() + 200);
      scheduleRoom(room, remainingMs, () => finishPractice(room));
      break;
    }
    case "MAIN_PLAY": {
      const remainingMs = Math.max(0, Number(room.currentRound?.mainEndsAt || Date.now()) - Date.now() + 200);
      scheduleRoom(room, remainingMs, () => finishMainPlay(room));
      break;
    }
    case "SCORING":
      scheduleRoom(room, 10, () => finalizeRoundScoring(room));
      break;
    default:
      break;
  }
}

function currentRoundView(room, session) {
  if (!room.currentRound) {
    return null;
  }

  const playerId = session?.playerId;
  const round = room.currentRound;
  const effectiveState = room.state === "PAUSED" ? room.paused?.phase : room.state;
  const submissionMap =
    effectiveState === "PRACTICE_PLAY" || effectiveState === "PRACTICE_RESULT"
      ? round.practiceSubmissions
      : round.mainSubmissions;

  const mySubmission = playerId ? submissionMap.get(playerId) ?? null : null;
  return {
    roundNumber: round.roundIndex + 1,
    gameId: round.gameId,
    title: round.title,
    description: round.description,
    intro: round.intro,
    prize: round.prize,
    effectiveState,
    practiceEnabled: round.practiceEnabled,
    practiceSeed: round.practiceSeed,
    mainSeed: round.mainSeed,
    practiceConfig: effectiveState === "PRACTICE_PLAY" || effectiveState === "PRACTICE_RESULT" ? round.practiceConfig : null,
    mainConfig:
      effectiveState === "MAIN_INTRO" ||
      effectiveState === "MAIN_PLAY" ||
      effectiveState === "SCORING" ||
      effectiveState === "ROUND_RESULT" ||
      room.state === "FINAL_RESULT"
        ? round.mainConfig
        : null,
    practiceStartedAt: round.practiceStartedAt,
    practiceEndsAt: round.practiceEndsAt,
    mainIntroEndsAt: round.mainIntroEndsAt,
    mainStartedAt: round.mainStartedAt,
    mainEndsAt: round.mainEndsAt,
    practiceProgress: {
      submitted: round.practiceSubmissions.size,
      total: room.lockedPlayerIds.length
    },
    mainProgress: {
      submitted: round.mainSubmissions.size,
      total: room.lockedPlayerIds.length
    },
    mySubmission,
    results: effectiveState === "ROUND_RESULT" || room.state === "FINAL_RESULT" ? round.results : null
  };
}

function playerListView(room) {
  return [...room.players.values()]
    .sort((left, right) => left.joinedAt - right.joinedAt)
    .map((player) => ({
      id: player.id,
      nickname: player.nickname,
      state: player.state,
      spectator: player.spectator,
      connected: player.connected,
      totalPoints: player.totalPoints,
      lastPlacement: player.placements[player.placements.length - 1] ?? null
    }));
}

function buildStateForSession(room, session) {
  const viewerRole =
    room.adminClientId === session.clientId
      ? "admin"
      : session.role === "display"
        ? "display"
      : session.playerId && room.players.get(session.playerId)?.spectator
        ? "spectator"
        : session.playerId
          ? "player"
          : "guest";

  return {
    room: roomSummary(room),
    viewer: {
      clientId: session.clientId,
      role: viewerRole,
      roomCode: session.roomCode,
      playerId: session.playerId,
      nickname: session.nickname,
      adminRecoveryCode: viewerRole === "admin" ? room.adminRecoveryCode : null
    },
    players: playerListView(room),
    currentRound: currentRoundView(room, session),
    finalRanking: room.finalRanking,
    eventLog: room.eventLog.slice(-8)
  };
}

function sendState(session) {
  if (!session?.stream || !session.roomCode) {
    return;
  }

  const room = rooms.get(session.roomCode);
  if (!room) {
    session.stream.write(`event: roomClosed\ndata: {}\n\n`);
    return;
  }

  session.stream.write(`event: state\ndata: ${JSON.stringify(buildStateForSession(room, session))}\n\n`);
}

function broadcastRoom(room) {
  scheduleStatePersist();
  sessions.forEach((session) => {
    if (session.roomCode === room.code) {
      sendState(session);
    }
  });
}

function closeAllStreams(reason) {
  sessions.forEach((session) => {
    if (!session.stream) {
      return;
    }

    try {
      session.stream.write(`event: serverClosing\ndata: ${JSON.stringify({ reason })}\n\n`);
      session.stream.end();
    } catch {
      // Ignore stream shutdown errors during process termination.
    } finally {
      session.stream = null;
    }
  });
}

function logRoomEvent(room, message) {
  room.eventLog.push({
    id: randomUUID(),
    message,
    at: Date.now()
  });
  if (room.eventLog.length > eventLogLimit) {
    room.eventLog.shift();
  }
}

function setPlayersState(room, stateName) {
  room.lockedPlayerIds.forEach((playerId) => {
    const player = room.players.get(playerId);
    if (player) {
      player.state = player.connected ? stateName : "DISCONNECTED";
    }
  });
}

function ensureRound(room) {
  if (!room.currentRound && room.currentRoundIndex >= 0) {
    room.currentRound = buildRound(room, room.currentRoundIndex);
  }
}

function openRoundIntro(room) {
  clearRoomTimers(room);
  ensureRound(room);
  room.paused = null;
  room.state = "ROUND_INTRO";
  room.currentRound.practiceStartedAt = null;
  room.currentRound.practiceEndsAt = null;
  room.currentRound.mainIntroEndsAt = null;
  room.currentRound.mainStartedAt = null;
  room.currentRound.mainEndsAt = null;
  setPlayersState(room, "WAITING");
  logRoomEvent(room, `${room.currentRound.roundIndex + 1}라운드 ${room.currentRound.title} 소개`);
  broadcastRoom(room);
}

function finishPractice(room) {
  if (room.state !== "PRACTICE_PLAY") {
    return;
  }
  clearRoomTimers(room);
  room.state = "PRACTICE_RESULT";
  setPlayersState(room, "PRACTICE_DONE");
  logRoomEvent(room, `${room.currentRound.title} 연습 종료`);
  broadcastRoom(room);
}

function startPractice(room, options = {}) {
  if (!options.force && room.state !== "ROUND_INTRO") {
    return;
  }
  clearRoomTimers(room);
  ensureRound(room);
  room.paused = null;
  room.state = "PRACTICE_PLAY";
  room.currentRound.practiceStartedAt = Date.now() + practiceLeadInMs;
  room.currentRound.practiceEndsAt = room.currentRound.practiceStartedAt + room.currentRound.practiceConfig.timeLimitMs;
  room.currentRound.practiceSubmissions.clear();
  setPlayersState(room, "PRACTICING");
  scheduleRoom(room, room.currentRound.practiceEndsAt - Date.now() + 200, () => finishPractice(room));
  logRoomEvent(room, `${room.currentRound.title} ${options.resume ? "연습 재시작" : "연습 시작"}`);
  broadcastRoom(room);
}

function startMainIntro(room, options = {}) {
  if (!options.force && !["ROUND_INTRO", "PRACTICE_RESULT"].includes(room.state)) {
    return;
  }
  clearRoomTimers(room);
  ensureRound(room);
  room.paused = null;
  room.state = "MAIN_INTRO";
  const countdownMs = Math.max(250, Number(options.remainingMs ?? mainIntroMs));
  room.currentRound.mainIntroEndsAt = Date.now() + countdownMs;
  setPlayersState(room, "WAITING");
  scheduleRoom(room, room.currentRound.mainIntroEndsAt - Date.now(), () => startMainPlay(room));
  logRoomEvent(room, `${room.currentRound.title} ${options.resume ? "본게임 카운트다운 재개" : "본게임 카운트다운"}`);
  broadcastRoom(room);
}

function getSubmissionPhase(room, mode) {
  if (mode === "practice") {
    return room.state === "PRACTICE_PLAY" ? room.currentRound.practiceSubmissions : null;
  }
  if (mode === "main") {
    return room.state === "MAIN_PLAY" ? room.currentRound.mainSubmissions : null;
  }
  return null;
}

function fillMissingMainSubmissions(room) {
  room.lockedPlayerIds.forEach((playerId) => {
    if (!room.currentRound.mainSubmissions.has(playerId)) {
      room.currentRound.mainSubmissions.set(playerId, {
        playerId,
        status: "timeout",
        score: 0,
        rankVector: [0, -999999999],
        completedAt: Number.MAX_SAFE_INTEGER,
        metrics: {
          label: "미응답",
          summary: "시간 내 제출하지 못했습니다."
        }
      });
    }
  });
}

function finalizeRoundScoring(room) {
  if (room.state !== "SCORING") {
    return;
  }
  clearRoomTimers(room);
  fillMissingMainSubmissions(room);
  const ordered = sortRankedEntries([...room.currentRound.mainSubmissions.values()]);
  const totalPlayers = room.lockedPlayerIds.length;

  room.currentRound.results = ordered.map((entry, index) => {
    const player = room.players.get(entry.playerId);
    const tournamentPoints = totalPlayers - index;
    player.totalPoints += tournamentPoints;
    player.placements.push(index + 1);
    player.roundResults.push({
      roundIndex: room.currentRound.roundIndex,
      gameId: room.currentRound.gameId,
      rank: index + 1,
      tournamentPoints,
      score: entry.score,
      metrics: entry.metrics
    });
    if (index === 0) {
      player.roundWins += 1;
    }
    if (index === 1) {
      player.secondPlaces += 1;
    }
    return {
      rank: index + 1,
      tournamentPoints,
      playerId: player.id,
      nickname: player.nickname,
      score: entry.score,
      metrics: entry.metrics,
      prizeWinner: index === 0 && Boolean(room.currentRound.prize)
    };
  });

  room.top3 = room.currentRound.results.slice(0, 3).map((entry) => ({
    rank: entry.rank,
    nickname: entry.nickname,
    totalPoints: room.players.get(entry.playerId)?.totalPoints ?? 0
  }));

  room.state = "ROUND_RESULT";
  room.finalRanking = rankPlayersForFinal(room);
  room.roundHistory[room.currentRound.roundIndex] = buildRoundHistoryEntry(room, room.currentRound, room.finalRanking);
  setPlayersState(room, "WAITING");
  const winner = room.currentRound.results[0];
  logRoomEvent(room, `${room.currentRound.title} 결과 공개 - 1위 ${winner.nickname}`);
  broadcastRoom(room);
}

function finishMainPlay(room) {
  if (room.state !== "MAIN_PLAY") {
    return;
  }
  clearRoomTimers(room);
  room.state = "SCORING";
  setPlayersState(room, "WAITING");
  broadcastRoom(room);
  scheduleRoom(room, scoringDelayMs, () => finalizeRoundScoring(room));
}

function startMainPlay(room, options = {}) {
  if (!options.force && room.state !== "MAIN_INTRO") {
    return;
  }
  clearRoomTimers(room);
  room.paused = null;
  room.state = "MAIN_PLAY";
  room.currentRound.mainSubmissions.clear();
  room.currentRound.mainStartedAt = Date.now();
  room.currentRound.mainEndsAt = room.currentRound.mainStartedAt + room.currentRound.mainConfig.timeLimitMs;
  setPlayersState(room, "MAIN_PLAYING");
  scheduleRoom(room, room.currentRound.mainEndsAt - Date.now() + 200, () => finishMainPlay(room));
  logRoomEvent(room, `${room.currentRound.title} ${options.resume ? "본게임 재시작" : "본게임 시작"}`);
  broadcastRoom(room);
}

function pauseRoom(room) {
  if (!resumableRoundStates.has(room.state)) {
    throw new Error("현재 상태에서는 일시정지할 수 없습니다.");
  }

  const paused = {
    phase: room.state,
    pausedAt: Date.now(),
    restartOnResume: false,
    remainingMs: null
  };

  if (room.state === "PRACTICE_PLAY") {
    if (room.currentRound.practiceSubmissions.size > 0) {
      throw new Error("이미 제출이 시작된 연습판은 일시정지 대신 라운드 재시작을 사용해 주세요.");
    }
    paused.restartOnResume = true;
    paused.remainingMs = Math.max(0, room.currentRound.practiceEndsAt - Date.now());
  }

  if (room.state === "MAIN_PLAY") {
    if (room.currentRound.mainSubmissions.size > 0) {
      throw new Error("이미 제출이 시작된 본게임은 일시정지 대신 라운드 재시작을 사용해 주세요.");
    }
    paused.restartOnResume = true;
    paused.remainingMs = Math.max(0, room.currentRound.mainEndsAt - Date.now());
  }

  if (room.state === "MAIN_INTRO") {
    paused.remainingMs = Math.max(0, room.currentRound.mainIntroEndsAt - Date.now());
  }

  clearRoomTimers(room);
  room.paused = paused;
  room.state = "PAUSED";
  setPlayersState(room, "WAITING");
  logRoomEvent(room, `${room.currentRound?.title || "현재 진행"} 일시정지`);
  broadcastRoom(room);
}

function resumeRoom(room) {
  if (room.state !== "PAUSED" || !room.paused) {
    throw new Error("재개할 일시정지 상태가 없습니다.");
  }

  const paused = room.paused;

  switch (paused.phase) {
    case "ROUND_INTRO":
      room.paused = null;
      room.state = "ROUND_INTRO";
      setPlayersState(room, "WAITING");
      logRoomEvent(room, `${room.currentRound?.title || "현재 진행"} 재개`);
      broadcastRoom(room);
      return;
    case "PRACTICE_RESULT":
      room.paused = null;
      room.state = "PRACTICE_RESULT";
      setPlayersState(room, "PRACTICE_DONE");
      logRoomEvent(room, `${room.currentRound?.title || "현재 진행"} 재개`);
      broadcastRoom(room);
      return;
    case "ROUND_RESULT":
      room.paused = null;
      room.state = "ROUND_RESULT";
      setPlayersState(room, "WAITING");
      logRoomEvent(room, `${room.currentRound?.title || "현재 진행"} 재개`);
      broadcastRoom(room);
      return;
    case "MAIN_INTRO":
      startMainIntro(room, { force: true, resume: true, remainingMs: paused.remainingMs ?? mainIntroMs });
      return;
    case "PRACTICE_PLAY":
      startPractice(room, { force: true, resume: true });
      return;
    case "MAIN_PLAY":
      startMainPlay(room, { force: true, resume: true });
      return;
    default:
      throw new Error("지원하지 않는 일시정지 상태입니다.");
  }
}

function startTournament(room) {
  clearRoomTimers(room);
  room.paused = null;
  room.lockedPlayerIds = [...room.players.values()]
    .filter((player) => !player.spectator)
    .sort((left, right) => left.joinedAt - right.joinedAt)
    .map((player) => player.id);

  room.mode = room.lockedPlayerIds.length <= 1 ? "TEST" : "OFFICIAL";
  room.currentRoundIndex = 0;
  room.currentRound = buildRound(room, 0);
  room.state = "LOCKED";
  logRoomEvent(room, `${room.lockedPlayerIds.length}명 잠금, ${room.mode === "TEST" ? "테스트" : "공식"} 모드 시작`);
  openRoundIntro(room);
}

function resetRoom(room) {
  archiveRoomIfNeeded(room, room.state === "ENDED" ? "reset-after-ended" : "reset-after-final");
  clearRoomTimers(room);
  room.paused = null;
  room.createdAt = Date.now();
  room.tournamentId = randomUUID();
  room.state = "WAITING";
  room.mode = "OFFICIAL";
  room.currentRoundIndex = -1;
  room.currentRound = null;
  room.lockedPlayerIds = [];
  room.top3 = [];
  room.finalRanking = [];
  room.roundHistory = [];
  room.eventLog = [];
  room.selectedGameIds = selectGames(room.roundCount, `${room.code}-${Date.now()}-${Math.random()}`);

  room.players.forEach((player) => {
    player.spectator = false;
    player.totalPoints = 0;
    player.roundWins = 0;
    player.secondPlaces = 0;
    player.placements = [];
    player.roundResults = [];
    player.state = player.connected ? "WAITING" : "DISCONNECTED";
  });

  logRoomEvent(room, "같은 방으로 새 대회 준비 완료");
  broadcastRoom(room);
}

function advanceRoom(room) {
  if (room.state === "ROUND_RESULT") {
    if (room.currentRoundIndex + 1 >= room.roundCount) {
      room.state = "FINAL_RESULT";
      room.finalRanking = rankPlayersForFinal(room);
      logRoomEvent(room, "최종 결과 발표");
      broadcastRoom(room);
      return;
    }
    room.currentRoundIndex += 1;
    room.currentRound = buildRound(room, room.currentRoundIndex);
    openRoundIntro(room);
  } else if (room.state === "FINAL_RESULT") {
    room.state = "ENDED";
    logRoomEvent(room, "대회 종료");
    archiveRoomIfNeeded(room, "ended");
    broadcastRoom(room);
  }
}

function updateParticipantConnection(session, connected) {
  if (!session.roomCode || !session.playerId) {
    return;
  }
  const room = rooms.get(session.roomCode);
  const player = room?.players.get(session.playerId);
  if (!player) {
    return;
  }
  player.connected = connected;
  if (!connected) {
    player.state = player.spectator ? "SPECTATING" : "DISCONNECTED";
  } else if (player.spectator) {
    player.state = "SPECTATING";
  } else if (room.state === "PRACTICE_PLAY") {
    player.state = "PRACTICING";
  } else if (room.state === "MAIN_PLAY") {
    player.state = "MAIN_PLAYING";
  } else {
    player.state = "WAITING";
  }
  broadcastRoom(room);
}

function assertAdmin(room, session) {
  if (!room || room.adminClientId !== session.clientId) {
    throw new Error("관리자 권한이 없습니다.");
  }
}

function getSessionFromRequest(url) {
  const clientId = url.searchParams.get("clientId");
  if (!clientId) {
    return null;
  }
  return createSession(clientId);
}

function recoverAdminAccess(payload, session) {
  const roomCode = String(payload.roomCode || "").trim().toUpperCase();
  const recoveryCode = String(payload.recoveryCode || "").trim().toUpperCase();
  const room = rooms.get(roomCode);

  if (!room) {
    throw new Error("방을 찾을 수 없습니다.");
  }
  if (!recoveryCode) {
    throw new Error("관리자 복구 코드를 입력해 주세요.");
  }
  if (room.adminRecoveryCode !== recoveryCode) {
    throw new Error("관리자 복구 코드가 일치하지 않습니다.");
  }

  const previousAdminId = room.adminClientId;
  room.adminClientId = session.clientId;
  session.roomCode = room.code;
  session.role = "admin";
  session.playerId = null;
  session.nickname = "관리자";

  if (previousAdminId && previousAdminId !== session.clientId) {
    const previousSession = sessions.get(previousAdminId);
    if (previousSession) {
      previousSession.role = null;
    }
  }

  logRoomEvent(room, "관리자 권한 복구");
  broadcastRoom(room);
  return {
    roomCode: room.code,
    role: "admin"
  };
}

function createRoom(payload, session, request) {
  const roundCount = payload.roundCount === 8 ? 8 : 5;
  const code = generateRoomCode();
  const prizes = Array.from({ length: roundCount }, (_, index) => String(payload.prizes?.[index] || "").trim());
  const room = {
    code,
    name: payload.name?.trim() || "회식 미니게임",
    createdAt: Date.now(),
    tournamentId: randomUUID(),
    roundCount,
    prizes,
    state: "WAITING",
    mode: "OFFICIAL",
    adminClientId: session.clientId,
    adminRecoveryCode: generateRecoveryCode(),
    players: new Map(),
    timers: [],
    selectedGameIds: selectGames(roundCount, `${code}-${Date.now()}`),
    currentRoundIndex: -1,
    currentRound: null,
    paused: null,
    lockedPlayerIds: [],
    top3: [],
    finalRanking: [],
    roundHistory: [],
    eventLog: []
  };

  rooms.set(code, room);
  session.roomCode = code;
  session.role = "admin";
  session.playerId = null;
  session.nickname = "관리자";
  logRoomEvent(room, "방 생성 완료");
  broadcastRoom(room);
  scheduleStatePersist();
  const requestHost = request.headers.host || `${host}:${port}`;
  return {
    roomCode: code,
    joinUrl: `http://${requestHost}/?room=${code}`,
    adminRecoveryCode: room.adminRecoveryCode
  };
}

function rerollGames(room) {
  room.selectedGameIds = selectGames(room.roundCount, `${room.code}-${Date.now()}-${Math.random()}`);
  logRoomEvent(room, "게임 재추첨");
  broadcastRoom(room);
}

function joinRoom(payload, session) {
  const room = rooms.get(String(payload.roomCode || "").trim().toUpperCase());
  if (!room) {
    throw new Error("방을 찾을 수 없습니다.");
  }

  const nickname = String(payload.nickname || "").trim() || "참가자";
  session.roomCode = room.code;
  session.nickname = nickname;

  if (room.adminClientId === session.clientId) {
    session.role = "admin";
    scheduleStatePersist();
    return { roomCode: room.code, role: "admin" };
  }

  let player = session.playerId ? room.players.get(session.playerId) : null;
  if (!player && nickname) {
    player = [...room.players.values()].find((candidate) => candidate.nickname === nickname && !candidate.connected);
  }

  if (!player) {
    const spectator = room.state !== "WAITING";
    player = createPlayer({ nickname, clientId: session.clientId, spectator });
    room.players.set(player.id, player);
    logRoomEvent(room, spectator ? `${nickname} 관전 입장` : `${nickname} 참가 입장`);
  } else {
    player.clientId = session.clientId;
    player.connected = true;
    player.nickname = nickname;
    logRoomEvent(room, `${nickname} 재접속`);
  }

  session.playerId = player.id;
  session.role = player.spectator ? "spectator" : "player";
  updateParticipantConnection(session, true);
  return {
    roomCode: room.code,
    role: session.role
  };
}

function updatePrize(room, roundIndex, prize) {
  if (roundIndex < 0 || roundIndex >= room.roundCount) {
    throw new Error("유효하지 않은 라운드입니다.");
  }
  room.prizes[roundIndex] = prize;
  if (room.currentRound && room.currentRound.roundIndex === roundIndex) {
    room.currentRound.prize = prize;
  }
  logRoomEvent(room, `${roundIndex + 1}라운드 특별상품 수정`);
  broadcastRoom(room);
}

function removeParticipant(room, playerId) {
  const player = room.players.get(playerId);
  if (!player || player.spectator) {
    return;
  }
  room.players.delete(playerId);
  sessions.forEach((session) => {
    if (session.playerId === playerId) {
      session.playerId = null;
      session.role = null;
      session.roomCode = room.code;
    }
  });
  logRoomEvent(room, `${player.nickname} 참가 제외`);
  broadcastRoom(room);
}

function receiveSubmission(room, session, payload) {
  if (!session.playerId || !room.lockedPlayerIds.includes(session.playerId)) {
    return;
  }

  const player = room.players.get(session.playerId);
  const mode = payload.mode === "practice" ? "practice" : "main";
  const targetMap = getSubmissionPhase(room, mode);
  if (!targetMap) {
    throw new Error(mode === "practice" ? "지금은 연습 제출을 받을 수 없습니다." : "지금은 본게임 제출을 받을 수 없습니다.");
  }
  if (targetMap.has(session.playerId)) {
    return;
  }

  targetMap.set(session.playerId, {
    playerId: session.playerId,
    score: Number(payload.score || 0),
    rankVector: Array.isArray(payload.rankVector) ? payload.rankVector.map((value) => Number(value || 0)) : [Number(payload.score || 0)],
    completedAt: Number(payload.completedAt || Date.now()),
    metrics: payload.metrics || {}
  });

  player.state = mode === "practice" ? "PRACTICE_DONE" : "MAIN_DONE";

  if (mode === "practice" && room.currentRound.practiceSubmissions.size === room.lockedPlayerIds.length) {
    finishPractice(room);
  } else if (mode === "main" && room.currentRound.mainSubmissions.size === room.lockedPlayerIds.length) {
    finishMainPlay(room);
  } else {
    broadcastRoom(room);
  }
}

async function serveFile(response, baseDir, pathname) {
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(normalizedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(baseDir, safePath);
  const fileStat = await stat(filePath);

  if (!fileStat.isFile()) {
    throw new Error("not-file");
  }

  const data = await readFile(filePath);
  const ext = path.extname(filePath);
  const typeMap = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png"
  };

  response.writeHead(200, {
    "Content-Type": typeMap[ext] || "application/octet-stream"
  });
  response.end(data);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || `internal.invalid`}`);

    if (request.method === "GET" && url.pathname === "/healthz") {
      json(response, 200, buildHealthPayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/readyz") {
      json(response, shuttingDown ? 503 : 200, buildHealthPayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/events") {
      const session = getSessionFromRequest(url);
      if (!session) {
        json(response, 400, { error: "clientId가 필요합니다." });
        return;
      }

      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive"
      });
      response.write(`event: ready\ndata: {}\n\n`);
      session.stream = response;
      session.lastSeenAt = Date.now();
      if (session.roomCode) {
        updateParticipantConnection(session, true);
      }

      const keepAlive = setInterval(() => {
        response.write(`event: ping\ndata: ${Date.now()}\n\n`);
      }, 20000);

      request.on("close", () => {
        clearInterval(keepAlive);
        if (session.stream === response) {
          session.stream = null;
        }
        updateParticipantConnection(session, false);
      });

      sendState(session);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/session") {
      const payload = await readJson(request);
      const session = createSession(payload.clientId);
      if (payload.role === "display") {
        const roomCode = String(payload.roomCode || "").trim().toUpperCase();
        if (!roomCode) {
          throw new Error("발표 화면 연결에는 방 코드가 필요합니다.");
        }
        const room = rooms.get(roomCode);
        if (!room) {
          throw new Error("방을 찾을 수 없습니다.");
        }
        session.roomCode = room.code;
        session.role = "display";
        session.playerId = null;
        session.nickname = "발표 화면";
      }
      if (session.roomCode || session.role || session.nickname) {
        scheduleStatePersist();
      }
      json(response, 200, {
        clientId: session.clientId,
        roomCode: session.roomCode,
        role: session.role,
        playerId: session.playerId,
        nickname: session.nickname
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/state") {
      const session = getSessionFromRequest(url);
      if (!session) {
        json(response, 400, { error: "clientId가 필요합니다." });
        return;
      }
      if (!session.roomCode) {
        json(response, 200, { room: null, viewer: { clientId: session.clientId, role: session.role } });
        return;
      }
      const room = rooms.get(session.roomCode);
      if (!room) {
        json(response, 404, { error: "방을 찾을 수 없습니다." });
        return;
      }
      json(response, 200, buildStateForSession(room, session));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/rooms") {
      const roomCodes = String(url.searchParams.get("codes") || "")
        .split(",")
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean);
      const codeFilter = roomCodes.length ? new Set(roomCodes) : null;
      const list = [...rooms.values()]
        .filter((room) => !codeFilter || codeFilter.has(room.code))
        .map(roomDirectoryView)
        .sort((left, right) => right.updatedAt - left.updatedAt);

      json(response, 200, { rooms: list });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/archives") {
      const q = String(url.searchParams.get("q") || "");
      const roomCode = String(url.searchParams.get("roomCode") || "");
      const limit = Number(url.searchParams.get("limit") || 24);
      json(response, 200, {
        archives: listArchivedTournaments({ query: q, roomCode, limit })
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/archives/report") {
      const archiveId = String(url.searchParams.get("id") || "").trim();
      const archive = archives.find((entry) => entry.id === archiveId);
      if (!archive) {
        throw new Error("아카이브 리포트를 찾을 수 없습니다.");
      }
      json(response, 200, cloneJson(archive.report));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/report") {
      const session = getSessionFromRequest(url);
      if (!session) {
        json(response, 400, { error: "clientId가 필요합니다." });
        return;
      }
      const room = rooms.get(session.roomCode);
      assertAdmin(room, session);
      json(response, 200, buildTournamentReport(room));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/room") {
      const payload = await readJson(request);
      const session = createSession(payload.clientId);
      const result = createRoom(payload, session, request);
      json(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/recover") {
      const payload = await readJson(request);
      const session = createSession(payload.clientId);
      const result = recoverAdminAccess(payload, session);
      json(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/join") {
      const payload = await readJson(request);
      const session = createSession(payload.clientId);
      const result = joinRoom(payload, session);
      json(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/action") {
      const payload = await readJson(request);
      const session = createSession(payload.clientId);
      const room = rooms.get(session.roomCode || payload.roomCode);
      assertAdmin(room, session);

      switch (payload.action) {
        case "reroll-games":
          if (room.state !== "WAITING") {
            throw new Error("대기실에서만 재추첨할 수 있습니다.");
          }
          rerollGames(room);
          break;
        case "update-prize":
          if (
            room.state !== "WAITING" &&
            room.state !== "ROUND_INTRO" &&
            !(room.state === "PAUSED" && room.paused?.phase === "ROUND_INTRO")
          ) {
            throw new Error("특별상품은 대기실 또는 라운드 소개 화면에서만 수정할 수 있습니다.");
          }
          updatePrize(room, Number(payload.roundIndex ?? room.currentRoundIndex ?? 0), String(payload.prize || ""));
          break;
        case "remove-player":
          if (room.state !== "WAITING") {
            throw new Error("대기실에서만 참가자를 제외할 수 있습니다.");
          }
          removeParticipant(room, payload.playerId);
          break;
        case "start-tournament":
          if (room.state !== "WAITING") {
            throw new Error("이미 진행 중인 방입니다.");
          }
          if ([...room.players.values()].filter((player) => !player.spectator).length < 1) {
            throw new Error("참가자가 필요합니다.");
          }
          startTournament(room);
          break;
        case "start-practice":
          if (room.state !== "ROUND_INTRO") {
            throw new Error("라운드 안내 화면에서만 연습을 시작할 수 있습니다.");
          }
          startPractice(room);
          break;
        case "skip-practice":
          if (room.state !== "ROUND_INTRO" && room.state !== "PRACTICE_RESULT") {
            throw new Error("현재는 본게임으로 넘어갈 수 없습니다.");
          }
          room.currentRound.practiceEnabled = false;
          startMainIntro(room);
          break;
        case "start-main":
          if (room.state !== "PRACTICE_RESULT" && room.state !== "ROUND_INTRO") {
            throw new Error("현재는 본게임을 시작할 수 없습니다.");
          }
          if (room.state === "ROUND_INTRO") {
            room.currentRound.practiceEnabled = false;
          }
          startMainIntro(room);
          break;
        case "restart-round":
          if (room.currentRoundIndex < 0) {
            throw new Error("재시작할 라운드가 없습니다.");
          }
          room.paused = null;
          room.currentRound = buildRound(room, room.currentRoundIndex);
          openRoundIntro(room);
          break;
        case "pause":
          pauseRoom(room);
          break;
        case "resume":
          resumeRoom(room);
          break;
        case "advance":
          advanceRoom(room);
          break;
        case "reset-room":
          if (room.state !== "FINAL_RESULT" && room.state !== "ENDED") {
            throw new Error("최종 결과 이후에만 같은 방으로 새 대회를 준비할 수 있습니다.");
          }
          resetRoom(room);
          break;
        default:
          throw new Error("알 수 없는 관리자 액션입니다.");
      }

      json(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/player/submit") {
      const payload = await readJson(request);
      const session = createSession(payload.clientId);
      const room = rooms.get(session.roomCode);
      if (!room || !room.currentRound) {
        throw new Error("진행 중인 라운드가 없습니다.");
      }
      receiveSubmission(room, session, payload);
      json(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/shared/")) {
      await serveFile(response, sharedDir, url.pathname.replace("/shared", ""));
      return;
    }

    if (request.method === "GET") {
      await serveFile(response, publicDir, url.pathname);
      return;
    }

    json(response, 404, { error: "Not found" });
  } catch (error) {
    const statusCode = error.code === "ENOENT" ? 404 : 400;
    json(response, statusCode, {
      error: error instanceof Error ? error.message : "알 수 없는 오류"
    });
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  console.log(`Received ${signal}. Starting graceful shutdown...`);
  rooms.forEach((room) => clearRoomTimers(room));
  await persistStateNow();
  closeAllStreams("서버가 재시작되거나 배포로 종료되었습니다. 잠시 후 다시 접속해 주세요.");

  const forceExitTimer = setTimeout(() => {
    console.error("Graceful shutdown timed out. Forcing exit.");
    process.exit(1);
  }, shutdownGraceMs);
  forceExitTimer.unref();

  server.close((error) => {
    clearTimeout(forceExitTimer);
    if (error) {
      console.error("Server close failed:", error);
      process.exit(1);
      return;
    }
    console.log("Server shutdown complete.");
    process.exit(0);
  });
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

await loadPersistedState();
rooms.forEach((room) => resumeRecoveredRoom(room));

server.listen(port, host, () => {
  const localUrl = host === "0.0.0.0" ? `http://127.0.0.1:${port}` : `http://${host}:${port}`;
  console.log(`Realtime minigame MVP server running on ${localUrl}`);
  console.log(`Bind host: ${host}`);
  if (persistenceEnabled) {
    console.log(`State persistence: ${stateFile}`);
  } else {
    console.log("State persistence: disabled");
  }
  console.log(`Shared states: ${ROOM_STATES.length} room states / ${PLAYER_STATES.length} player states / ${ALL_GAME_IDS.length} games`);
});
