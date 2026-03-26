import { buildRound } from "./roundEngine.mjs";
import { GAME_DEFINITIONS, selectGames } from "./gameRegistry.mjs";
import { buildRoundHistoryEntry, cloneMetrics, rankPlayersForFinal, sortRankedEntries } from "./scoring.mjs";
import { createPlayerId, createRecoveryCode, createTournamentId } from "../utils/ids.mjs";
import { assert, normalizeNickname, normalizePrizeList, normalizeRoomName, normalizeRoundCount } from "../utils/validators.mjs";
import { isViewerOnline, mainIntroMs, now, practiceLeadInMs, scoringDelayMs } from "../utils/timers.mjs";

function logRoomEvent(room, message, timestamp) {
  room.eventLog.push({
    id: createPlayerId(),
    message,
    at: timestamp
  });
  room.updatedAt = timestamp;
  if (room.eventLog.length > 120) {
    room.eventLog.shift();
  }
}

export function createPlayer({ nickname, clientId, spectator = false }, timestamp = now()) {
  return {
    id: createPlayerId(),
    clientId,
    nickname,
    connected: true,
    spectator,
    state: spectator ? "SPECTATING" : "WAITING",
    joinedAt: timestamp,
    lastSeenAt: timestamp,
    totalPoints: 0,
    roundWins: 0,
    secondPlaces: 0,
    placements: [],
    roundResults: []
  };
}

export function createRoomRecord({ code, name, roundCount, prizes, adminClientId }, timestamp = now()) {
  return {
    code,
    name: normalizeRoomName(name),
    createdAt: timestamp,
    updatedAt: timestamp,
    tournamentId: createTournamentId(),
    roundCount: normalizeRoundCount(roundCount),
    prizes: normalizePrizeList(prizes, normalizeRoundCount(roundCount)),
    state: "WAITING",
    mode: "OFFICIAL",
    adminClientId,
    adminRecoveryCode: createRecoveryCode(),
    adminLastSeenAt: timestamp,
    players: new Map(),
    selectedGameIds: selectGames(normalizeRoundCount(roundCount), `${code}-${timestamp}`),
    currentRoundIndex: -1,
    currentRound: null,
    lockedPlayerIds: [],
    top3: [],
    finalRanking: [],
    roundHistory: [],
    eventLog: []
  };
}

export function refreshPresence(room, timestamp = now()) {
  room.players.forEach((player) => {
    const connected = isViewerOnline(player.lastSeenAt, timestamp);
    player.connected = connected;
    if (player.spectator) {
      player.state = connected ? "SPECTATING" : "DISCONNECTED";
      return;
    }

    if (!connected) {
      player.state = "DISCONNECTED";
    } else if (room.state === "PRACTICE_PLAY") {
      player.state = room.currentRound?.practiceSubmissions.has(player.id) ? "PRACTICE_DONE" : "PRACTICING";
    } else if (room.state === "MAIN_PLAY") {
      player.state = room.currentRound?.mainSubmissions.has(player.id) ? "MAIN_DONE" : "MAIN_PLAYING";
    } else if (room.state === "PRACTICE_RESULT") {
      player.state = "PRACTICE_DONE";
    } else {
      player.state = "WAITING";
    }
  });
}

function setPlayersState(room, stateName) {
  room.lockedPlayerIds.forEach((playerId) => {
    const player = room.players.get(playerId);
    if (player) {
      player.state = player.connected ? stateName : "DISCONNECTED";
    }
  });
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

function openRoundIntro(room, timestamp) {
  if (!room.currentRound && room.currentRoundIndex >= 0) {
    room.currentRound = buildRound(room, room.currentRoundIndex);
  }
  room.state = "ROUND_INTRO";
  room.currentRound.practiceStartedAt = null;
  room.currentRound.practiceEndsAt = null;
  room.currentRound.mainIntroEndsAt = null;
  room.currentRound.mainStartedAt = null;
  room.currentRound.mainEndsAt = null;
  room.currentRound.scoringReadyAt = null;
  setPlayersState(room, "WAITING");
  logRoomEvent(room, `${room.currentRound.roundIndex + 1}라운드 ${room.currentRound.title} 소개`, timestamp);
}

function finishPractice(room, timestamp) {
  room.state = "PRACTICE_RESULT";
  setPlayersState(room, "PRACTICE_DONE");
  logRoomEvent(room, `${room.currentRound.title} 연습 종료`, timestamp);
}

function startPractice(room, timestamp) {
  assert(room.state === "ROUND_INTRO", "라운드 안내 화면에서만 연습을 시작할 수 있습니다.");
  room.state = "PRACTICE_PLAY";
  room.currentRound.practiceStartedAt = timestamp + practiceLeadInMs;
  room.currentRound.practiceEndsAt = room.currentRound.practiceStartedAt + room.currentRound.practiceConfig.timeLimitMs;
  room.currentRound.practiceSubmissions = new Map();
  setPlayersState(room, "PRACTICING");
  logRoomEvent(room, `${room.currentRound.title} 연습 시작`, timestamp);
}

function startMainIntro(room, timestamp) {
  assert(["ROUND_INTRO", "PRACTICE_RESULT"].includes(room.state), "현재는 본게임을 시작할 수 없습니다.");
  room.state = "MAIN_INTRO";
  room.currentRound.mainIntroEndsAt = timestamp + mainIntroMs;
  setPlayersState(room, "WAITING");
  logRoomEvent(room, `${room.currentRound.title} 본게임 카운트다운`, timestamp);
}

function startMainPlay(room, timestamp) {
  room.state = "MAIN_PLAY";
  room.currentRound.mainSubmissions = new Map();
  room.currentRound.mainStartedAt = timestamp;
  room.currentRound.mainEndsAt = timestamp + room.currentRound.mainConfig.timeLimitMs;
  setPlayersState(room, "MAIN_PLAYING");
  logRoomEvent(room, `${room.currentRound.title} 본게임 시작`, timestamp);
}

function finishMainPlay(room, timestamp) {
  room.state = "SCORING";
  room.currentRound.scoringReadyAt = timestamp + scoringDelayMs;
  setPlayersState(room, "WAITING");
}

function finalizeRoundScoring(room, timestamp) {
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
      metrics: cloneMetrics(entry.metrics)
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
      metrics: cloneMetrics(entry.metrics),
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
  room.roundHistory[room.currentRound.roundIndex] = buildRoundHistoryEntry(room, room.currentRound, room.finalRanking, timestamp);
  setPlayersState(room, "WAITING");
  const winner = room.currentRound.results[0];
  logRoomEvent(room, `${room.currentRound.title} 결과 공개 - 1위 ${winner.nickname}`, timestamp);
}

function shouldFinishPractice(room, timestamp) {
  return room.state === "PRACTICE_PLAY" && room.currentRound && timestamp >= Number(room.currentRound.practiceEndsAt || 0);
}

function shouldStartMainPlay(room, timestamp) {
  return room.state === "MAIN_INTRO" && room.currentRound && timestamp >= Number(room.currentRound.mainIntroEndsAt || 0);
}

function shouldFinishMain(room, timestamp) {
  return room.state === "MAIN_PLAY" && room.currentRound && timestamp >= Number(room.currentRound.mainEndsAt || 0);
}

function shouldFinalizeScoring(room, timestamp) {
  return room.state === "SCORING" && room.currentRound && timestamp >= Number(room.currentRound.scoringReadyAt || 0);
}

export function reconcileRoomState(room, timestamp = now()) {
  refreshPresence(room, timestamp);

  for (let step = 0; step < 6; step += 1) {
    if (room.state === "PRACTICE_PLAY" && room.currentRound.practiceSubmissions.size >= room.lockedPlayerIds.length) {
      finishPractice(room, timestamp);
      continue;
    }
    if (room.state === "MAIN_PLAY" && room.currentRound.mainSubmissions.size >= room.lockedPlayerIds.length) {
      finishMainPlay(room, timestamp);
      continue;
    }
    if (shouldFinishPractice(room, timestamp)) {
      finishPractice(room, timestamp);
      continue;
    }
    if (shouldStartMainPlay(room, timestamp)) {
      startMainPlay(room, timestamp);
      continue;
    }
    if (shouldFinishMain(room, timestamp)) {
      finishMainPlay(room, timestamp);
      continue;
    }
    if (shouldFinalizeScoring(room, timestamp)) {
      finalizeRoundScoring(room, timestamp);
      continue;
    }
    break;
  }

  room.updatedAt = timestamp;
  return room;
}

export function startTournament(room, timestamp = now()) {
  room.lockedPlayerIds = [...room.players.values()]
    .filter((player) => !player.spectator)
    .sort((left, right) => left.joinedAt - right.joinedAt)
    .map((player) => player.id);

  assert(room.lockedPlayerIds.length >= 1, "참가자가 필요합니다.");

  room.mode = room.lockedPlayerIds.length <= 1 ? "TEST" : "OFFICIAL";
  room.currentRoundIndex = 0;
  room.currentRound = buildRound(room, 0);
  room.state = "LOCKED";
  logRoomEvent(room, `${room.lockedPlayerIds.length}명 잠금, ${room.mode === "TEST" ? "테스트" : "공식"} 모드 시작`, timestamp);
  openRoundIntro(room, timestamp);
}

export function advanceRoom(room, timestamp = now()) {
  if (room.state === "ROUND_RESULT") {
    if (room.currentRoundIndex + 1 >= room.roundCount) {
      room.state = "FINAL_RESULT";
      room.finalRanking = rankPlayersForFinal(room);
      logRoomEvent(room, "최종 결과 발표", timestamp);
      return;
    }
    room.currentRoundIndex += 1;
    room.currentRound = buildRound(room, room.currentRoundIndex);
    openRoundIntro(room, timestamp);
    return;
  }

  if (room.state === "FINAL_RESULT") {
    room.state = "ENDED";
    logRoomEvent(room, "대회 종료", timestamp);
  }
}

export function rerollGames(room, timestamp = now()) {
  room.selectedGameIds = selectGames(room.roundCount, `${room.code}-${timestamp}-${Math.random()}`);
  logRoomEvent(room, "게임 재추첨", timestamp);
}

export function restartRound(room, timestamp = now()) {
  assert(room.currentRoundIndex >= 0, "재시작할 라운드가 없습니다.");
  room.currentRound = buildRound(room, room.currentRoundIndex);
  openRoundIntro(room, timestamp);
}

export function removeParticipant(room, playerId, timestamp = now()) {
  const player = room.players.get(playerId);
  if (!player || player.spectator) {
    return;
  }
  room.players.delete(playerId);
  logRoomEvent(room, `${player.nickname} 참가 제외`, timestamp);
}

export function resetRoom(room, timestamp = now()) {
  room.createdAt = timestamp;
  room.updatedAt = timestamp;
  room.tournamentId = createTournamentId();
  room.state = "WAITING";
  room.mode = "OFFICIAL";
  room.currentRoundIndex = -1;
  room.currentRound = null;
  room.lockedPlayerIds = [];
  room.top3 = [];
  room.finalRanking = [];
  room.roundHistory = [];
  room.eventLog = [];
  room.selectedGameIds = selectGames(room.roundCount, `${room.code}-${timestamp}-${Math.random()}`);

  room.players.forEach((player) => {
    player.spectator = false;
    player.totalPoints = 0;
    player.roundWins = 0;
    player.secondPlaces = 0;
    player.placements = [];
    player.roundResults = [];
    player.state = player.connected ? "WAITING" : "DISCONNECTED";
  });

  logRoomEvent(room, "같은 방으로 새 대회 준비 완료", timestamp);
}

export function updatePrize(room, roundIndex, prize, timestamp = now()) {
  assert(roundIndex >= 0 && roundIndex < room.roundCount, "유효하지 않은 라운드입니다.");
  room.prizes[roundIndex] = prize;
  if (room.currentRound && room.currentRound.roundIndex === roundIndex) {
    room.currentRound.prize = prize;
  }
  logRoomEvent(room, `${roundIndex + 1}라운드 특별상품 수정`, timestamp);
}

export function joinRoom(room, viewer, payload, timestamp = now()) {
  const nickname = normalizeNickname(payload.nickname);
  let player = payload.playerId ? room.players.get(payload.playerId) : null;
  if (!player && nickname) {
    player = [...room.players.values()].find((candidate) => candidate.nickname === nickname && !candidate.connected);
  }

  if (!player) {
    const spectator = room.state !== "WAITING";
    player = createPlayer({ nickname, clientId: viewer.clientId, spectator }, timestamp);
    room.players.set(player.id, player);
    logRoomEvent(room, spectator ? `${nickname} 관전 입장` : `${nickname} 참가 입장`, timestamp);
  } else {
    player.clientId = viewer.clientId;
    player.nickname = nickname;
    player.lastSeenAt = timestamp;
    player.connected = true;
    logRoomEvent(room, `${nickname} 재접속`, timestamp);
  }

  return {
    clientId: viewer.clientId,
    roomCode: room.code,
    role: player.spectator ? "spectator" : "player",
    playerId: player.id,
    nickname: player.nickname
  };
}

export function recoverAdmin(room, viewer, recoveryCode, timestamp = now()) {
  assert(room.adminRecoveryCode === recoveryCode, "관리자 복구 코드가 일치하지 않습니다.");
  room.adminClientId = viewer.clientId;
  room.adminLastSeenAt = timestamp;
  logRoomEvent(room, "관리자 권한 복구", timestamp);
  return {
    clientId: viewer.clientId,
    roomCode: room.code,
    role: "admin",
    playerId: null,
    nickname: "관리자"
  };
}

export function receiveSubmission(room, session, payload, timestamp = now()) {
  assert(session.playerId && room.lockedPlayerIds.includes(session.playerId), "현재 제출 권한이 없습니다.");
  const player = room.players.get(session.playerId);
  assert(player, "참가자를 찾을 수 없습니다.");

  const mode = payload.mode === "practice" ? "practice" : "main";
  const targetMap = mode === "practice" ? room.currentRound.practiceSubmissions : room.currentRound.mainSubmissions;
  const expectedState = mode === "practice" ? "PRACTICE_PLAY" : "MAIN_PLAY";
  assert(room.state === expectedState, mode === "practice" ? "지금은 연습 제출을 받을 수 없습니다." : "지금은 본게임 제출을 받을 수 없습니다.");

  if (targetMap.has(session.playerId)) {
    return;
  }

  targetMap.set(session.playerId, {
    playerId: session.playerId,
    score: Number(payload.score || 0),
    rankVector: Array.isArray(payload.rankVector) ? payload.rankVector.map((value) => Number(value || 0)) : [Number(payload.score || 0)],
    completedAt: Number(payload.completedAt || timestamp),
    metrics: cloneMetrics(payload.metrics)
  });

  player.lastSeenAt = timestamp;
  player.state = mode === "practice" ? "PRACTICE_DONE" : "MAIN_DONE";
  reconcileRoomState(room, timestamp);
}

export function resolveViewer(room, rawViewer, timestamp = now()) {
  const viewer = {
    clientId: rawViewer.clientId,
    roomCode: rawViewer.roomCode || room?.code || null,
    role: rawViewer.role || null,
    playerId: rawViewer.playerId || null,
    nickname: rawViewer.nickname || null
  };

  if (!room) {
    return viewer;
  }

  reconcileRoomState(room, timestamp);

  if (viewer.role === "display") {
    return {
      ...viewer,
      roomCode: room.code,
      role: "display",
      playerId: null,
      nickname: "발표 화면"
    };
  }

  if (room.adminClientId === viewer.clientId) {
    room.adminLastSeenAt = timestamp;
    return {
      ...viewer,
      roomCode: room.code,
      role: "admin",
      playerId: null,
      nickname: "관리자"
    };
  }

  let player = viewer.playerId ? room.players.get(viewer.playerId) : null;
  if (!player) {
    player = [...room.players.values()].find((candidate) => candidate.clientId === viewer.clientId) || null;
  }

  if (!player) {
    return {
      ...viewer,
      roomCode: room.code,
      role: "guest",
      playerId: null
    };
  }

  player.clientId = viewer.clientId;
  player.lastSeenAt = timestamp;
  player.connected = true;
  if (viewer.nickname) {
    player.nickname = viewer.nickname;
  }

  return {
    clientId: viewer.clientId,
    roomCode: room.code,
    role: player.spectator ? "spectator" : "player",
    playerId: player.id,
    nickname: player.nickname
  };
}

export function roomSummary(room) {
  return {
    code: room.code,
    name: room.name,
    createdAt: room.createdAt,
    roundCount: room.roundCount,
    prizes: room.prizes,
    state: room.state,
    mode: room.mode,
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

export function currentRoundView(room, session) {
  if (!room.currentRound) {
    return null;
  }
  const round = room.currentRound;
  const mySubmission =
    session.playerId && room.state === "PRACTICE_PLAY"
      ? round.practiceSubmissions.get(session.playerId) ?? null
      : session.playerId && room.state !== "PRACTICE_PLAY"
        ? round.mainSubmissions.get(session.playerId) ?? null
        : null;

  return {
    roundNumber: round.roundIndex + 1,
    gameId: round.gameId,
    title: round.title,
    description: round.description,
    intro: round.intro,
    prize: round.prize,
    effectiveState: room.state,
    practiceEnabled: round.practiceEnabled,
    practiceSeed: round.practiceSeed,
    mainSeed: round.mainSeed,
    practiceConfig: room.state === "PRACTICE_PLAY" || room.state === "PRACTICE_RESULT" ? round.practiceConfig : null,
    mainConfig:
      room.state === "MAIN_INTRO" ||
      room.state === "MAIN_PLAY" ||
      room.state === "SCORING" ||
      room.state === "ROUND_RESULT" ||
      room.state === "FINAL_RESULT" ||
      room.state === "ENDED"
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
    results: room.state === "ROUND_RESULT" || room.state === "FINAL_RESULT" || room.state === "ENDED" ? round.results : null
  };
}

export function playerListView(room) {
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

export function buildStateForViewer(room, session) {
  return {
    room: roomSummary(room),
    viewer: {
      clientId: session.clientId,
      role: session.role,
      roomCode: session.roomCode,
      playerId: session.playerId,
      nickname: session.nickname,
      adminRecoveryCode: session.role === "admin" ? room.adminRecoveryCode : null
    },
    players: playerListView(room),
    currentRound: currentRoundView(room, session),
    finalRanking: room.finalRanking,
    eventLog: room.eventLog.slice(-8)
  };
}

export function applyRoundAction(room, session, payload, timestamp = now()) {
  assert(room.adminClientId === session.clientId, "관리자 권한이 없습니다.");
  reconcileRoomState(room, timestamp);

  switch (payload.action) {
    case "startTournament":
      assert(room.state === "WAITING", "이미 진행 중인 방입니다.");
      startTournament(room, timestamp);
      return;
    case "rerollGames":
      assert(room.state === "WAITING", "대기실에서만 재추첨할 수 있습니다.");
      rerollGames(room, timestamp);
      return;
    case "startPractice":
      startPractice(room, timestamp);
      return;
    case "skipPractice":
      assert(room.state === "ROUND_INTRO" || room.state === "PRACTICE_RESULT", "현재는 본게임으로 넘어갈 수 없습니다.");
      room.currentRound.practiceEnabled = false;
      startMainIntro(room, timestamp);
      return;
    case "startMain":
      if (room.state === "ROUND_INTRO") {
        room.currentRound.practiceEnabled = false;
      }
      startMainIntro(room, timestamp);
      return;
    case "advance":
      advanceRoom(room, timestamp);
      return;
    case "restartRound":
      restartRound(room, timestamp);
      return;
    case "resetRoom":
      assert(room.state === "FINAL_RESULT" || room.state === "ENDED", "최종 결과 이후에만 같은 방으로 새 대회를 준비할 수 있습니다.");
      resetRoom(room, timestamp);
      return;
    case "removePlayer":
      assert(room.state === "WAITING", "대기실에서만 참가자를 제외할 수 있습니다.");
      removeParticipant(room, payload.playerId, timestamp);
      return;
    case "updatePrize":
      updatePrize(room, Number(payload.roundIndex ?? room.currentRoundIndex ?? 0), String(payload.prize || ""), timestamp);
      return;
    default:
      throw new Error("지원하지 않는 라운드 액션입니다.");
  }
}

export function buildLeaderboardView(room) {
  if (room.state === "ROUND_RESULT" && room.currentRound) {
    return {
      type: "round",
      roundNumber: room.currentRound.roundIndex + 1,
      title: room.currentRound.title,
      prize: room.currentRound.prize,
      results: room.currentRound.results
    };
  }

  return {
    type: "final",
    results: room.finalRanking
  };
}
