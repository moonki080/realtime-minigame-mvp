import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 4310);
const host = process.env.HOST || "0.0.0.0";
const durationScale = Number(process.env.GAME_DURATION_SCALE || 1);
const introMs = Number(process.env.INTRO_MS || scaleDuration(3000));
const resultMs = Number(process.env.RESULT_MS || scaleDuration(5000));
const lobbyStaleMs = Number(process.env.LOBBY_STALE_MS || 45000);

const gamePlan = [
  {
    id: "color-snap",
    title: "컬러 스냅",
    summary: "목표 색상이 보이면 가장 빠르게 탭하세요.",
    practiceMs: Number(process.env.COLOR_SNAP_PRACTICE_MS || scaleDuration(5000)),
    mainMs: Number(process.env.COLOR_SNAP_MAIN_MS || scaleDuration(6500))
  },
  {
    id: "go-stop",
    title: "GO / STOP 탭",
    summary: "GO일 때만 탭하고 STOP은 피하세요.",
    practiceMs: Number(process.env.GO_STOP_PRACTICE_MS || scaleDuration(5500)),
    mainMs: Number(process.env.GO_STOP_MAIN_MS || scaleDuration(7500))
  },
  {
    id: "number-hunter",
    title: "숫자 헌터",
    summary: "가장 큰 숫자를 빠르게 찾아 누르세요.",
    practiceMs: Number(process.env.NUMBER_HUNTER_PRACTICE_MS || scaleDuration(5500)),
    mainMs: Number(process.env.NUMBER_HUNTER_MAIN_MS || scaleDuration(7500))
  },
  {
    id: "ten-seconds",
    title: "10초 멈춰",
    summary: "정확히 10초라고 생각되는 순간 STOP을 누르세요.",
    practiceMs: Number(process.env.TEN_SECONDS_PRACTICE_MS || scaleDuration(12000)),
    mainMs: Number(process.env.TEN_SECONDS_MAIN_MS || scaleDuration(12000))
  },
  {
    id: "gauge-stop",
    title: "게이지 스톱",
    summary: "움직이는 게이지를 목표 구간에 멈춰 보세요.",
    practiceMs: Number(process.env.GAUGE_STOP_PRACTICE_MS || scaleDuration(5500)),
    mainMs: Number(process.env.GAUGE_STOP_MAIN_MS || scaleDuration(7500))
  }
];

const state = createInitialState();

function scaleDuration(ms) {
  return Math.max(200, Math.round(ms * durationScale));
}

function createInitialState() {
  return {
    phase: "lobby",
    phaseStartedAt: null,
    phaseEndsAt: null,
    roundIndex: -1,
    startedAt: null,
    players: [],
    lockedPlayerIds: [],
    currentRound: null,
    roundHistory: [],
    finalRanking: []
  };
}

function resetPlayerProgress(player) {
  return {
    ...player,
    totalPoints: 0,
    roundPoints: [],
    rawScores: [],
    lastRoundRank: null,
    lastSeenAt: Date.now()
  };
}

function resetToLobby({ keepPlayers = true } = {}) {
  const preservedPlayers = keepPlayers ? state.players.map(resetPlayerProgress) : [];
  state.phase = "lobby";
  state.phaseStartedAt = null;
  state.phaseEndsAt = null;
  state.roundIndex = -1;
  state.startedAt = null;
  state.players = preservedPlayers;
  state.lockedPlayerIds = [];
  state.currentRound = null;
  state.roundHistory = [];
  state.finalRanking = [];
}

function createPlayer(nickname) {
  return {
    id: randomUUID().slice(0, 8),
    nickname,
    joinedAt: Date.now(),
    lastSeenAt: Date.now(),
    totalPoints: 0,
    roundPoints: [],
    rawScores: [],
    lastRoundRank: null
  };
}

function sanitizeNickname(value) {
  const nickname = String(value || "").trim().slice(0, 18);
  if (!nickname) {
    throw new Error("닉네임을 입력해 주세요.");
  }
  return nickname;
}

function getPlayer(playerId) {
  return state.players.find((player) => player.id === playerId) || null;
}

function touchPlayer(playerId) {
  const player = getPlayer(playerId);
  if (player) {
    player.lastSeenAt = Date.now();
  }
}

function getLockedPlayers() {
  return state.lockedPlayerIds
    .map((playerId) => getPlayer(playerId))
    .filter(Boolean);
}

function getCurrentGame() {
  if (state.roundIndex < 0 || state.roundIndex >= gamePlan.length) {
    return null;
  }
  return gamePlan[state.roundIndex];
}

function setPhase(phase, durationMs = null) {
  const now = Date.now();
  state.phase = phase;
  state.phaseStartedAt = now;
  state.phaseEndsAt = Number.isFinite(durationMs) ? now + durationMs : null;
}

function beginRound(roundIndex) {
  const game = gamePlan[roundIndex];
  state.roundIndex = roundIndex;
  state.currentRound = {
    gameId: game.id,
    seed: Math.floor(Math.random() * 1_000_000_000),
    practiceSubmissions: {},
    mainSubmissions: {},
    resultRanking: []
  };
  setPhase("intro", introMs);
}

function beginPractice() {
  const game = getCurrentGame();
  if (!game) {
    return;
  }
  setPhase("practice", game.practiceMs);
}

function beginMain() {
  const game = getCurrentGame();
  if (!game) {
    return;
  }
  setPhase("main", game.mainMs);
}

function buildRoundRanking() {
  const currentGame = getCurrentGame();
  const lockedPlayers = getLockedPlayers();
  const entries = lockedPlayers.map((player) => {
    const submission = state.currentRound?.mainSubmissions[player.id] || null;
    return {
      playerId: player.id,
      nickname: player.nickname,
      rawScore: Number(submission?.score || 0),
      detailLabel: submission?.details?.label || "미제출",
      detailSummary: submission?.details?.summary || "시간 종료 또는 제출 없음",
      submittedAt: submission?.submittedAt || Number.MAX_SAFE_INTEGER,
      joinedAt: player.joinedAt
    };
  });

  entries.sort((left, right) => {
    return (
      right.rawScore - left.rawScore ||
      left.submittedAt - right.submittedAt ||
      left.joinedAt - right.joinedAt
    );
  });

  return entries.map((entry, index) => {
    const roundPoints = lockedPlayers.length - index;
    const player = getPlayer(entry.playerId);
    if (player) {
      player.totalPoints += roundPoints;
      player.roundPoints.push(roundPoints);
      player.rawScores.push(entry.rawScore);
      player.lastRoundRank = index + 1;
    }
    return {
      rank: index + 1,
      roundPoints,
      totalPoints: player?.totalPoints || roundPoints,
      ...entry
    };
  });
}

function finalizeRound() {
  if (!state.currentRound) {
    return;
  }
  const currentGame = getCurrentGame();
  const ranking = buildRoundRanking();
  state.currentRound.resultRanking = ranking;
  state.roundHistory.push({
    roundNumber: state.roundIndex + 1,
    gameId: currentGame.id,
    title: currentGame.title,
    ranking
  });
  setPhase("result", resultMs);
}

function finalizeTournament() {
  const rankedPlayers = [...state.players].sort((left, right) => {
    return (
      right.totalPoints - left.totalPoints ||
      (right.rawScores.at(-1) || 0) - (left.rawScores.at(-1) || 0) ||
      left.joinedAt - right.joinedAt
    );
  });
  state.finalRanking = rankedPlayers.map((player, index) => ({
    rank: index + 1,
    playerId: player.id,
    nickname: player.nickname,
    totalPoints: player.totalPoints,
    roundPoints: player.roundPoints,
    rawScores: player.rawScores
  }));
  setPhase("final");
}

function allLockedPlayersSubmitted(mode) {
  const lockedPlayers = getLockedPlayers();
  if (!lockedPlayers.length || !state.currentRound) {
    return false;
  }
  const bucket = mode === "practice" ? state.currentRound.practiceSubmissions : state.currentRound.mainSubmissions;
  return lockedPlayers.every((player) => Boolean(bucket[player.id]));
}

function maybeAdvanceState() {
  if (state.phase === "lobby" || state.phase === "final") {
    return;
  }

  if (state.phase === "practice" && allLockedPlayersSubmitted("practice")) {
    beginMain();
    return;
  }

  if (state.phase === "main" && allLockedPlayersSubmitted("main")) {
    finalizeRound();
    return;
  }

  if (!state.phaseEndsAt || Date.now() < state.phaseEndsAt) {
    return;
  }

  switch (state.phase) {
    case "intro":
      beginPractice();
      break;
    case "practice":
      beginMain();
      break;
    case "main":
      finalizeRound();
      break;
    case "result":
      if (state.roundIndex >= gamePlan.length - 1) {
        finalizeTournament();
      } else {
        beginRound(state.roundIndex + 1);
      }
      break;
    default:
      break;
  }
}

function cleanupLobbyPlayers() {
  if (state.phase !== "lobby") {
    return;
  }
  const cutoff = Date.now() - lobbyStaleMs;
  state.players = state.players.filter((player) => player.lastSeenAt >= cutoff);
}

function buildLeaderboard() {
  return [...state.players]
    .sort((left, right) => {
      return (
        right.totalPoints - left.totalPoints ||
        (right.rawScores.at(-1) || 0) - (left.rawScores.at(-1) || 0) ||
        left.joinedAt - right.joinedAt
      );
    })
    .map((player, index) => ({
      rank: index + 1,
      playerId: player.id,
      nickname: player.nickname,
      totalPoints: player.totalPoints
    }));
}

function buildPublicState(playerId = null) {
  if (playerId) {
    touchPlayer(playerId);
  }
  const me = playerId ? getPlayer(playerId) : null;
  const game = getCurrentGame();
  const playerCount = state.phase === "lobby" ? state.players.length : state.lockedPlayerIds.length;
  const currentResults =
    state.phase === "result" && state.currentRound
      ? state.currentRound.resultRanking
      : state.phase === "final"
        ? state.roundHistory.at(-1)?.ranking || []
        : [];

  return {
    phase: state.phase,
    serverNow: Date.now(),
    joinOpen: state.phase === "lobby",
    canStart: state.phase === "lobby" && state.players.length >= 2,
    playerCount,
    players: state.players.map((player) => ({
      id: player.id,
      nickname: player.nickname,
      totalPoints: player.totalPoints,
      joinedAt: player.joinedAt,
      lastRoundRank: player.lastRoundRank
    })),
    me: me
      ? {
          id: me.id,
          nickname: me.nickname,
          totalPoints: me.totalPoints,
          submittedPractice: Boolean(state.currentRound?.practiceSubmissions[me.id]),
          submittedMain: Boolean(state.currentRound?.mainSubmissions[me.id])
        }
      : null,
    round: game
      ? {
          number: state.roundIndex + 1,
          total: gamePlan.length,
          id: game.id,
          title: game.title,
          summary: game.summary,
          seed: state.currentRound?.seed || 0,
          practiceMs: game.practiceMs,
          mainMs: game.mainMs,
          phaseStartedAt: state.phaseStartedAt,
          phaseEndsAt: state.phaseEndsAt
        }
      : null,
    roundResults: currentResults,
    leaderboard: buildLeaderboard(),
    finalRanking: state.finalRanking,
    history: state.roundHistory.map((entry) => ({
      roundNumber: entry.roundNumber,
      title: entry.title,
      winner: entry.ranking[0]?.nickname || null
    })),
    notice:
      state.phase === "lobby"
        ? "닉네임만 입력하면 바로 참가할 수 있습니다."
        : "현재 게임이 진행 중입니다. 최종 결과 후 새 게임에서 다시 참여해 주세요."
  };
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

async function serveStaticFile(response, pathname) {
  const safePath = path.normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);
  const fileInfo = await stat(filePath);
  if (!fileInfo.isFile()) {
    throw new Error("not-file");
  }

  const data = await readFile(filePath);
  const extension = path.extname(filePath);
  const typeMap = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };

  response.writeHead(200, {
    "Content-Type": typeMap[extension] || "application/octet-stream"
  });
  response.end(data);
}

async function handleJoin(request, response) {
  const body = await readJsonBody(request);
  const nickname = sanitizeNickname(body.nickname);

  if (state.phase !== "lobby") {
    sendJson(response, 409, { error: "이미 게임이 진행 중입니다. 새 게임이 시작되면 다시 입장해 주세요." });
    return;
  }

  const duplicate = state.players.find((player) => player.nickname.toLowerCase() === nickname.toLowerCase());
  if (duplicate && Date.now() - duplicate.lastSeenAt < lobbyStaleMs) {
    sendJson(response, 409, { error: "이미 사용 중인 닉네임입니다. 다른 이름을 입력해 주세요." });
    return;
  }

  if (duplicate) {
    state.players = state.players.filter((player) => player.id !== duplicate.id);
  }

  const player = createPlayer(nickname);
  state.players.push(player);
  sendJson(response, 200, {
    playerId: player.id,
    nickname: player.nickname,
    state: buildPublicState(player.id)
  });
}

async function handleState(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const playerId = url.searchParams.get("playerId") || null;
  sendJson(response, 200, buildPublicState(playerId));
}

async function handleStart(request, response) {
  const body = await readJsonBody(request);
  const player = getPlayer(body.playerId);
  if (!player) {
    sendJson(response, 404, { error: "참가자 정보를 찾을 수 없습니다." });
    return;
  }
  if (state.phase !== "lobby") {
    sendJson(response, 409, { error: "이미 게임이 시작되었습니다." });
    return;
  }
  if (state.players.length < 2) {
    sendJson(response, 409, { error: "최소 2명 이상 참가해야 시작할 수 있습니다." });
    return;
  }

  state.players = state.players.map(resetPlayerProgress);
  state.lockedPlayerIds = state.players.map((entry) => entry.id);
  state.startedAt = Date.now();
  beginRound(0);
  sendJson(response, 200, buildPublicState(player.id));
}

async function handleSubmit(request, response) {
  const body = await readJsonBody(request);
  const player = getPlayer(body.playerId);
  if (!player) {
    sendJson(response, 404, { error: "참가자 정보를 찾을 수 없습니다." });
    return;
  }
  if (!state.currentRound || !getLockedPlayers().some((entry) => entry.id === player.id)) {
    sendJson(response, 409, { error: "현재 라운드 참가자가 아닙니다." });
    return;
  }

  const mode = body.mode === "practice" ? "practice" : body.mode === "main" ? "main" : null;
  if (!mode || state.phase !== mode) {
    sendJson(response, 409, { error: "지금은 이 제출을 받을 수 없는 상태입니다." });
    return;
  }

  const roundNumber = Number(body.roundNumber || 0);
  if (roundNumber !== state.roundIndex + 1) {
    sendJson(response, 409, { error: "이미 다음 라운드로 넘어갔습니다." });
    return;
  }

  const bucket = mode === "practice" ? state.currentRound.practiceSubmissions : state.currentRound.mainSubmissions;
  if (bucket[player.id]) {
    sendJson(response, 200, buildPublicState(player.id));
    return;
  }

  bucket[player.id] = {
    score: Math.max(0, Math.round(Number(body.score || 0))),
    details: {
      label: String(body.details?.label || ""),
      summary: String(body.details?.summary || "")
    },
    submittedAt: Date.now()
  };

  maybeAdvanceState();
  sendJson(response, 200, buildPublicState(player.id));
}

async function handleReset(request, response) {
  const body = await readJsonBody(request);
  const player = getPlayer(body.playerId);
  if (!player) {
    sendJson(response, 404, { error: "참가자 정보를 찾을 수 없습니다." });
    return;
  }
  if (state.phase !== "final" && state.phase !== "lobby") {
    sendJson(response, 409, { error: "지금은 새 게임으로 초기화할 수 없습니다." });
    return;
  }

  resetToLobby({ keepPlayers: true });
  sendJson(response, 200, buildPublicState(player.id));
}

function buildHealthPayload() {
  return {
    ok: true,
    phase: state.phase,
    playerCount: state.players.length,
    roundIndex: state.roundIndex
  };
}

const server = createServer(async (request, response) => {
  try {
    if (!request.url) {
      sendJson(response, 400, { error: "잘못된 요청입니다." });
      return;
    }

    if (request.method === "GET" && request.url === "/healthz") {
      sendJson(response, 200, buildHealthPayload());
      return;
    }

    if (request.method === "GET" && request.url.startsWith("/api/state")) {
      await handleState(request, response);
      return;
    }

    if (request.method === "POST" && request.url === "/api/join") {
      await handleJoin(request, response);
      return;
    }

    if (request.method === "POST" && request.url === "/api/start") {
      await handleStart(request, response);
      return;
    }

    if (request.method === "POST" && request.url === "/api/submit") {
      await handleSubmit(request, response);
      return;
    }

    if (request.method === "POST" && request.url === "/api/reset") {
      await handleReset(request, response);
      return;
    }

    if (request.method === "GET") {
      await serveStaticFile(response, request.url === "/" ? "/index.html" : request.url);
      return;
    }

    sendJson(response, 404, { error: "요청한 경로를 찾을 수 없습니다." });
  } catch (error) {
    if (error instanceof Error && error.message === "not-file") {
      sendJson(response, 404, { error: "파일을 찾을 수 없습니다." });
      return;
    }
    sendJson(response, 400, { error: error instanceof Error ? error.message : "요청 처리 중 오류가 발생했습니다." });
  }
});

const tickTimer = setInterval(() => {
  cleanupLobbyPlayers();
  maybeAdvanceState();
}, 250);

server.listen(port, host, () => {
  console.log(`Simple realtime minigame server running on http://127.0.0.1:${port}`);
  console.log(`Bind host: ${host}`);
  console.log(`Mode: single room, in-memory only`);
});

function gracefulShutdown(signal) {
  clearInterval(tickTimer);
  console.log(`Received ${signal}, shutting down...`);
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
