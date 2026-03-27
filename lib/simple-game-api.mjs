import { randomUUID } from "node:crypto";

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

function ensureState() {
  if (!Array.isArray(state.players)) {
    state.players = [];
  }
  if (!Array.isArray(state.lockedPlayerIds)) {
    state.lockedPlayerIds = [];
  }
  if (!Array.isArray(state.roundHistory)) {
    state.roundHistory = [];
  }
  if (!Array.isArray(state.finalRanking)) {
    state.finalRanking = [];
  }
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
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
    throw new Error("닉네임이 비어 있습니다. 다시 시도해 주세요.");
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
    return false;
  }
  setPhase("practice", game.practiceMs);
  return true;
}

function beginMain() {
  const game = getCurrentGame();
  if (!game) {
    return false;
  }
  setPhase("main", game.mainMs);
  return true;
}

function buildRoundRanking() {
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
    return false;
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
  return true;
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
  return true;
}

function allLockedPlayersSubmitted(mode) {
  const lockedPlayers = getLockedPlayers();
  if (!lockedPlayers.length || !state.currentRound) {
    return false;
  }
  const bucket = mode === "practice" ? state.currentRound.practiceSubmissions : state.currentRound.mainSubmissions;
  return lockedPlayers.every((player) => Boolean(bucket[player.id]));
}

function maybeAdvanceState(now = Date.now()) {
  if (state.phase === "lobby" || state.phase === "final") {
    return false;
  }

  if (state.phase === "practice" && allLockedPlayersSubmitted("practice")) {
    return beginMain();
  }

  if (state.phase === "main" && allLockedPlayersSubmitted("main")) {
    return finalizeRound();
  }

  if (!state.phaseEndsAt || now < state.phaseEndsAt) {
    return false;
  }

  switch (state.phase) {
    case "intro":
      return beginPractice();
    case "practice":
      return beginMain();
    case "main":
      return finalizeRound();
    case "result":
      if (state.roundIndex >= gamePlan.length - 1) {
        return finalizeTournament();
      }
      beginRound(state.roundIndex + 1);
      return true;
    default:
      return false;
  }
}

function cleanupLobbyPlayers(now = Date.now()) {
  if (state.phase !== "lobby") {
    return;
  }
  const cutoff = now - lobbyStaleMs;
  state.players = state.players.filter((player) => player.lastSeenAt >= cutoff);
}

function settleState() {
  ensureState();
  let moved = false;
  let guard = 0;
  while (guard < 20) {
    const now = Date.now();
    cleanupLobbyPlayers(now);
    const changed = maybeAdvanceState(now);
    if (!changed) {
      break;
    }
    moved = true;
    guard += 1;
  }
  return moved;
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
  settleState();
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
    ok: true,
    phase: state.phase,
    serverNow: Date.now(),
    joinOpen: state.phase === "lobby",
    canStart: state.phase === "lobby" && state.players.length >= 2,
    playerCount,
    participantCount: playerCount,
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

function buildHealthPayload() {
  settleState();
  return {
    ok: true,
    phase: state.phase,
    playerCount: state.players.length,
    roundIndex: state.roundIndex
  };
}

function fail(response, statusCode, errorMessage, logPrefix, error) {
  const reason = error instanceof Error ? error.message : errorMessage;
  console.error(`${logPrefix} error=${reason}`);
  sendJson(response, statusCode, {
    ok: false,
    error: reason || errorMessage
  });
}

async function handleJoin(request, response) {
  console.log("[api/join] request received");
  try {
    ensureState();
    settleState();
    const body = await readJsonBody(request);
    const nickname = sanitizeNickname(body.nickname);
    console.log(`[api/join] nickname=${nickname}`);

    if (state.phase !== "lobby") {
      fail(response, 409, "이미 게임이 진행 중입니다. 새 게임이 시작되면 다시 입장해 주세요.", "[api/join]");
      return;
    }

    const duplicate = state.players.find((player) => player.nickname.toLowerCase() === nickname.toLowerCase());
    if (duplicate && Date.now() - duplicate.lastSeenAt < lobbyStaleMs) {
      fail(response, 409, "이미 사용 중인 닉네임입니다. 다른 이름을 입력해 주세요.", "[api/join]");
      return;
    }

    if (duplicate) {
      state.players = state.players.filter((player) => player.id !== duplicate.id);
    }

    const player = createPlayer(nickname);
    state.players.push(player);
    console.log("[api/join] player added");
    console.log(`[api/join] current participant count=${state.players.length}`);
    sendJson(response, 200, {
      ok: true,
      playerId: player.id,
      nickname: player.nickname,
      participantCount: state.players.length,
      state: buildPublicState(player.id)
    });
  } catch (error) {
    fail(response, 400, "입장 처리 중 오류가 발생했습니다. 다시 시도해 주세요.", "[api/join]", error);
  }
}

async function handleState(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const playerId = url.searchParams.get("playerId") || null;
    sendJson(response, 200, buildPublicState(playerId));
  } catch (error) {
    fail(response, 400, "상태를 불러오지 못했습니다. 다시 시도해 주세요.", "[api/state]", error);
  }
}

async function handleStart(request, response) {
  try {
    settleState();
    const body = await readJsonBody(request);
    const player = getPlayer(body.playerId);
    if (!player) {
      fail(response, 404, "참가자 정보를 찾을 수 없습니다.", "[api/start]");
      return;
    }
    if (state.phase !== "lobby") {
      fail(response, 409, "이미 게임이 시작되었습니다.", "[api/start]");
      return;
    }
    if (state.players.length < 2) {
      fail(response, 409, "최소 2명 이상 참가해야 시작할 수 있습니다.", "[api/start]");
      return;
    }

    state.players = state.players.map(resetPlayerProgress);
    state.lockedPlayerIds = state.players.map((entry) => entry.id);
    state.startedAt = Date.now();
    beginRound(0);
    sendJson(response, 200, buildPublicState(player.id));
  } catch (error) {
    fail(response, 400, "게임 시작 처리 중 오류가 발생했습니다.", "[api/start]", error);
  }
}

async function handleSubmit(request, response) {
  try {
    settleState();
    const body = await readJsonBody(request);
    const player = getPlayer(body.playerId);
    if (!player) {
      fail(response, 404, "참가자 정보를 찾을 수 없습니다.", "[api/submit]");
      return;
    }
    if (!state.currentRound || !getLockedPlayers().some((entry) => entry.id === player.id)) {
      fail(response, 409, "현재 라운드 참가자가 아닙니다.", "[api/submit]");
      return;
    }

    const mode = body.mode === "practice" ? "practice" : body.mode === "main" ? "main" : null;
    if (!mode || state.phase !== mode) {
      fail(response, 409, "지금은 이 제출을 받을 수 없는 상태입니다.", "[api/submit]");
      return;
    }

    const roundNumber = Number(body.roundNumber || 0);
    if (roundNumber !== state.roundIndex + 1) {
      fail(response, 409, "이미 다음 라운드로 넘어갔습니다.", "[api/submit]");
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

    settleState();
    sendJson(response, 200, buildPublicState(player.id));
  } catch (error) {
    fail(response, 400, "점수 제출 중 오류가 발생했습니다.", "[api/submit]", error);
  }
}

async function handleReset(request, response) {
  try {
    settleState();
    const body = await readJsonBody(request);
    const player = getPlayer(body.playerId);
    if (!player) {
      fail(response, 404, "참가자 정보를 찾을 수 없습니다.", "[api/reset]");
      return;
    }
    if (state.phase !== "final" && state.phase !== "lobby") {
      fail(response, 409, "지금은 새 게임으로 초기화할 수 없습니다.", "[api/reset]");
      return;
    }

    resetToLobby({ keepPlayers: true });
    sendJson(response, 200, buildPublicState(player.id));
  } catch (error) {
    fail(response, 400, "초기화 중 오류가 발생했습니다.", "[api/reset]", error);
  }
}

export function routeApiRequest(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const route = url.searchParams.get("route") || url.pathname.replace(/^\/api\//, "");

  if (request.method === "GET" && (url.pathname === "/healthz" || route === "healthz")) {
    sendJson(response, 200, buildHealthPayload());
    return;
  }

  if (request.method === "GET" && route === "state") {
    return handleState(request, response);
  }

  if (request.method === "POST" && route === "join") {
    return handleJoin(request, response);
  }

  if (request.method === "POST" && route === "start") {
    return handleStart(request, response);
  }

  if (request.method === "POST" && route === "submit") {
    return handleSubmit(request, response);
  }

  if (request.method === "POST" && route === "reset") {
    return handleReset(request, response);
  }

  sendJson(response, 404, {
    ok: false,
    error: "요청한 API 경로를 찾을 수 없습니다."
  });
}
