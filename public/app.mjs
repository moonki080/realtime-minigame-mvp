import { GAME_DEFINITIONS } from "/shared/gameData.mjs";
import { mountGameController } from "./games.mjs";

const app = document.querySelector("#app");
const defaultStorageKey = "realtime-minigame-client-id";
const displayStorageKey = "realtime-minigame-display-client-id";
const presentationStorageKey = "realtime-minigame-presentation-mode";
const recentRoomsStorageKey = "realtime-minigame-recent-rooms";
const params = new URLSearchParams(window.location.search);
const isDisplayModeParam = params.get("display") === "1";
const storageKey = isDisplayModeParam ? displayStorageKey : defaultStorageKey;

const store = {
  clientId: null,
  session: null,
  snapshot: null,
  loading: false,
  banner: null,
  createRoundCount: 5,
  createRoomName: "회식 미니게임",
  createPrizesText: "",
  joinNickname: "",
  recoveryCode: "",
  prefilledRoomCode: (params.get("room") || "").trim().toUpperCase(),
  entryView: isDisplayModeParam ? "display" : params.get("room") ? "join" : "home",
  actionState: null,
  actionTimer: null,
  sessionPromise: null,
  stream: null,
  activeController: null,
  activeInteractiveKey: null,
  activeGameNode: null,
  clockTimer: null,
  presentationMode: false,
  displayMode: isDisplayModeParam,
  roomDirectory: [],
  recentRooms: [],
  archiveQuery: "",
  archiveList: []
};

store.createPrizesText = Array.from({ length: store.createRoundCount }, (_, index) => `${index + 1}R 특별상품`).join("\n");

const ROOM_STATE_LABELS = {
  WAITING: "참가 대기",
  LOCKED: "인원 잠금",
  ROUND_INTRO: "라운드 소개",
  PRACTICE_PLAY: "연습 진행",
  PRACTICE_RESULT: "연습 결과",
  MAIN_INTRO: "본게임 카운트다운",
  MAIN_PLAY: "본게임 진행",
  PAUSED: "일시정지",
  SCORING: "점수 집계",
  ROUND_RESULT: "라운드 결과",
  FINAL_RESULT: "최종 결과",
  ENDED: "대회 종료"
};

const PLAYER_STATE_LABELS = {
  CONNECTED: "접속됨",
  WAITING: "대기 중",
  PRACTICING: "연습 중",
  PRACTICE_DONE: "연습 완료",
  MAIN_PLAYING: "본게임 중",
  MAIN_DONE: "제출 완료",
  DISCONNECTED: "끊김",
  SPECTATING: "관전 중"
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDateTime(timestamp) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(timestamp));
}

function formatShortDateTime(timestamp) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function buildDefaultPrizeText(roundCount) {
  return Array.from({ length: roundCount }, (_, index) => `${index + 1}R 특별상품`).join("\n");
}

function resizePrizeDraft(prizeText, roundCount) {
  const lines = String(prizeText || "")
    .split("\n")
    .map((line) => line.trimEnd());
  return Array.from({ length: roundCount }, (_, index) => lines[index] || `${index + 1}R 특별상품`).join("\n");
}

function getViewer(snapshot) {
  return snapshot?.viewer || { role: "guest" };
}

function getRoom(snapshot) {
  return snapshot?.room || null;
}

function getRound(snapshot) {
  return snapshot?.currentRound || null;
}

function getMe(snapshot) {
  const viewer = getViewer(snapshot);
  return snapshot?.players?.find((player) => player.id === viewer.playerId) || null;
}

function isInteractivePlayer(snapshot) {
  const viewer = getViewer(snapshot);
  const room = getRoom(snapshot);
  const round = getRound(snapshot);
  return Boolean(
    room &&
      round &&
      viewer.role === "player" &&
      (room.state === "PRACTICE_PLAY" || room.state === "MAIN_PLAY") &&
      !round.mySubmission
  );
}

function getInteractiveKey(snapshot) {
  if (!isInteractivePlayer(snapshot)) {
    return null;
  }
  const room = getRoom(snapshot);
  const round = getRound(snapshot);
  return `${room.code}:${room.state}:${round.roundNumber}:${round.gameId}`;
}

function setBanner(type, message) {
  store.banner = { type, message };
  render();
}

function clearBanner() {
  store.banner = null;
}

function clearActionTimer() {
  if (store.actionTimer) {
    clearTimeout(store.actionTimer);
    store.actionTimer = null;
  }
}

function clearActionState(renderAfter = false) {
  clearActionTimer();
  store.actionState = null;
  if (renderAfter) {
    render();
  }
}

function startActionState(intent, title, message) {
  clearActionTimer();
  const requestId = `${Date.now()}-${Math.random()}`;
  store.actionState = {
    requestId,
    status: "loading",
    slow: false,
    title,
    message,
    intent
  };
  store.actionTimer = window.setTimeout(() => {
    if (store.actionState?.requestId === requestId && store.actionState.status === "loading") {
      store.actionState = {
        ...store.actionState,
        slow: true
      };
      render();
    }
  }, 1500);
  render();
  return requestId;
}

function setActionError(requestId, intent, title, message) {
  if (store.actionState?.requestId !== requestId) {
    return;
  }
  clearActionTimer();
  store.actionState = {
    requestId,
    status: "error",
    slow: true,
    title,
    message,
    intent
  };
  render();
}

function isActionCurrent(requestId) {
  return requestId === "__inline__" || store.actionState?.requestId === requestId;
}

async function postJson(url, payload, options = {}) {
  const response = await fetch(url, {
    method: "POST",
    signal: options.signal,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "요청에 실패했습니다.");
  }
  return data;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    signal: options.signal
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "요청에 실패했습니다.");
  }
  return data;
}

function loadRecentRooms() {
  try {
    const raw = JSON.parse(localStorage.getItem(recentRoomsStorageKey) || "[]");
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map((entry) => ({
        code: String(entry.code || "").trim().toUpperCase(),
        name: String(entry.name || "최근 접속 방").trim() || "최근 접속 방",
        lastRole: String(entry.lastRole || "guest").trim(),
        lastVisitedAt: Number(entry.lastVisitedAt || 0)
      }))
      .filter((entry) => entry.code);
  } catch {
    return [];
  }
}

function saveRecentRooms() {
  localStorage.setItem(recentRoomsStorageKey, JSON.stringify(store.recentRooms.slice(0, 8)));
}

function rememberRoom(snapshot) {
  const room = getRoom(snapshot);
  const viewer = getViewer(snapshot);
  if (!room?.code) {
    return;
  }

  const nextEntry = {
    code: room.code,
    name: room.name,
    lastRole: viewer.role || "guest",
    lastVisitedAt: Date.now()
  };

  store.recentRooms = [nextEntry, ...store.recentRooms.filter((entry) => entry.code !== room.code)].slice(0, 8);
  saveRecentRooms();
}

function buildDirectoryRoomFromSnapshot(snapshot) {
  const room = getRoom(snapshot);
  if (!room?.code) {
    return null;
  }

  const players = snapshot.players || [];
  return {
    code: room.code,
    name: room.name,
    state: room.state,
    createdAt: room.createdAt,
    updatedAt: Date.now(),
    roundCount: room.roundCount,
    currentRoundIndex: room.currentRoundIndex,
    currentRoundNumber: room.currentRoundIndex >= 0 ? room.currentRoundIndex + 1 : 0,
    currentRoundTitle: snapshot.currentRound?.title || room.selectedGames?.[room.currentRoundIndex]?.title || null,
    participantCount: players.filter((player) => !player.spectator).length,
    connectedParticipantCount: players.filter((player) => !player.spectator && player.connected).length,
    spectatorCount: players.filter((player) => player.spectator).length,
    connectedSpectatorCount: players.filter((player) => player.spectator && player.connected).length,
    lockedPlayerCount: room.lockedPlayerCount || 0,
    canRecoverAdmin: true
  };
}

function upsertRoomDirectory(roomEntry) {
  if (!roomEntry?.code) {
    return;
  }

  const next = new Map(store.roomDirectory.map((entry) => [entry.code, entry]));
  next.set(roomEntry.code, {
    ...next.get(roomEntry.code),
    ...roomEntry
  });
  store.roomDirectory = [...next.values()].sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
}

async function refreshRoomDirectory() {
  const data = await fetchJson("/api/rooms");
  store.roomDirectory = Array.isArray(data.rooms) ? data.rooms : [];
  return store.roomDirectory;
}

async function refreshArchiveList(query = store.archiveQuery) {
  store.archiveQuery = String(query || "").trim();
  const params = new URLSearchParams();
  if (store.archiveQuery) {
    params.set("q", store.archiveQuery);
  }
  const queryString = params.toString();
  const data = await fetchJson(`/api/archives${queryString ? `?${queryString}` : ""}`);
  store.archiveList = Array.isArray(data.archives) ? data.archives : [];
  return store.archiveList;
}

async function refreshSession(options = {}) {
  const payload = { clientId: store.clientId };
  if (store.displayMode && store.prefilledRoomCode) {
    payload.roomCode = store.prefilledRoomCode;
    payload.role = "display";
  }
  store.session = await postJson("/api/session", payload, options);
  return store.session;
}

async function ensureSession(options = {}) {
  if (store.sessionPromise) {
    return store.sessionPromise;
  }

  const controller = options.timeoutMs ? new AbortController() : null;
  const timerId =
    controller && options.timeoutMs
      ? window.setTimeout(() => {
          controller.abort();
        }, options.timeoutMs)
      : null;

  const promise = refreshSession({
    signal: controller?.signal
  })
    .then((session) => {
      if (!store.stream && store.clientId) {
        connectStream();
      }
      return session;
    })
    .finally(() => {
      if (timerId) {
        clearTimeout(timerId);
      }
      if (store.sessionPromise === promise) {
        store.sessionPromise = null;
      }
    });

  store.sessionPromise = promise;
  return promise;
}

function applySessionFromViewer(viewer) {
  store.session = {
    clientId: viewer.clientId,
    roomCode: viewer.roomCode,
    role: viewer.role,
    playerId: viewer.playerId,
    nickname: viewer.nickname
  };
}

function applySnapshot(snapshot) {
  clearBanner();
  store.snapshot = snapshot;
  const viewer = getViewer(snapshot);
  rememberRoom(snapshot);
  upsertRoomDirectory(buildDirectoryRoomFromSnapshot(snapshot));
  applySessionFromViewer(viewer);
  if (viewer.roomCode) {
    updateRoomQuery(viewer.roomCode);
  }
}

async function refreshCurrentState() {
  if (!store.clientId) {
    return null;
  }

  const state = await fetchJson(`/api/state?clientId=${encodeURIComponent(store.clientId)}`);
  if (state.room) {
    applySnapshot(state);
    return state;
  }

  store.snapshot = null;
  if (state.viewer) {
    applySessionFromViewer(state.viewer);
  }
  return state;
}

function connectStream() {
  if (store.stream) {
    store.stream.close();
  }

  const stream = new EventSource(`/events?clientId=${encodeURIComponent(store.clientId)}`);
  store.stream = stream;

  stream.addEventListener("state", (event) => {
    applySnapshot(JSON.parse(event.data));
    render();
  });

  stream.addEventListener("serverClosing", (event) => {
    const payload = JSON.parse(event.data || "{}");
    setBanner("error", payload.reason || "서버가 재시작 중입니다. 잠시 후 다시 접속해 주세요.");
  });

  stream.addEventListener("roomClosed", () => {
    store.snapshot = null;
    store.session = {
      ...store.session,
      roomCode: null,
      role: null,
      playerId: null
    };
    destroyActiveController();
    store.entryView = "home";
    updateRoomQuery("");
    setBanner("error", "방이 종료되었거나 더 이상 존재하지 않습니다.");
    void refreshRoomDirectory().then(render).catch(() => {});
    void refreshArchiveList().then(render).catch(() => {});
  });

  stream.onerror = () => {
    renderCountdowns();
  };
}

function updateRoomQuery(roomCode) {
  const next = new URL(window.location.href);
  if (roomCode) {
    next.searchParams.set("room", roomCode);
  } else {
    next.searchParams.delete("room");
  }
  window.history.replaceState({}, "", next);
}

function destroyActiveController() {
  if (store.activeController) {
    store.activeController.destroy();
  }
  store.activeController = null;
  store.activeInteractiveKey = null;
  store.activeGameNode = null;
}

function renderCountdowns() {
  document.querySelectorAll("[data-deadline]").forEach((node) => {
    const deadline = Number(node.dataset.deadline);
    const prefix = node.dataset.prefix || "";
    const suffix = node.dataset.suffix || "";
    const remain = Math.max(0, deadline - Date.now());
    node.textContent = `${prefix}${(remain / 1000).toFixed(1)}초${suffix}`;
  });
}

function startClockTicker() {
  if (store.clockTimer) {
    clearInterval(store.clockTimer);
  }
  store.clockTimer = setInterval(renderCountdowns, 150);
}

function formatExportStamp(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function csvEscape(value) {
  const normalized = String(value ?? "");
  if (normalized.includes('"') || normalized.includes(",") || normalized.includes("\n")) {
    return `"${normalized.replaceAll('"', '""')}"`;
  }
  return normalized;
}

function buildCsv(rows) {
  return rows.map((row) => row.map((cell) => csvEscape(cell)).join(",")).join("\n");
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function getExportRoomCode(source = store.snapshot) {
  return source?.room?.code || getRoom(store.snapshot)?.code || "ROOM";
}

function getExportFilename(prefix, extension, source) {
  return `${prefix}-${getExportRoomCode(source)}-${formatExportStamp()}.${extension}`;
}

function buildFinalRankingCsv(report) {
  const rows = [
    ["rank", "nickname", "total_points", "round_wins", "second_places"]
  ];
  report.finalRanking.forEach((entry) => {
    rows.push([entry.rank, entry.nickname, entry.totalPoints, entry.roundWins, entry.secondPlaces]);
  });
  return buildCsv(rows);
}

function buildEventLogCsv(report) {
  const rows = [["time", "message"]];
  report.eventLog.forEach((entry) => {
    rows.push([new Date(entry.at).toISOString(), entry.message]);
  });
  return buildCsv(rows);
}

async function handleExportAction(kind) {
  const report = await fetchJson(`/api/admin/report?clientId=${encodeURIComponent(store.clientId)}`);

  if (kind === "final-csv") {
    if (!report.finalRanking?.length) {
      throw new Error("아직 최종 순위가 없어 CSV를 만들 수 없습니다.");
    }
    downloadTextFile(getExportFilename("final-ranking", "csv", report), `\uFEFF${buildFinalRankingCsv(report)}`, "text/csv;charset=utf-8");
    setBanner("success", "최종 순위 CSV를 내려받았습니다.");
    return;
  }

  if (kind === "log-csv") {
    if (!report.eventLog?.length) {
      throw new Error("내보낼 운영 로그가 없습니다.");
    }
    downloadTextFile(getExportFilename("event-log", "csv", report), `\uFEFF${buildEventLogCsv(report)}`, "text/csv;charset=utf-8");
    setBanner("success", "운영 로그 CSV를 내려받았습니다.");
    return;
  }

  if (kind === "report-json") {
    downloadTextFile(
      getExportFilename("tournament-report", "json", report),
      `${JSON.stringify(report, null, 2)}\n`,
      "application/json;charset=utf-8"
    );
    setBanner("success", "대회 리포트 JSON을 내려받았습니다.");
    return;
  }

  throw new Error("지원하지 않는 export 액션입니다.");
}

async function downloadArchiveReport(archiveId) {
  const report = await fetchJson(`/api/archives/report?id=${encodeURIComponent(archiveId)}`);
  downloadTextFile(
    getExportFilename("tournament-archive", "json", report),
    `${JSON.stringify(report, null, 2)}\n`,
    "application/json;charset=utf-8"
  );
  setBanner("success", "아카이브 리포트 JSON을 내려받았습니다.");
}

function pillClassForPlayer(player) {
  if (player.spectator) {
    return "neutral";
  }
  if (!player.connected) {
    return "accent";
  }
  if (player.state === "MAIN_DONE" || player.state === "PRACTICE_DONE") {
    return "gold";
  }
  return "teal";
}

function getRosterGroups(snapshot) {
  const players = snapshot?.players || [];
  const participants = players.filter((player) => !player.spectator);
  const spectators = players.filter((player) => player.spectator);
  const onlineParticipants = participants.filter((player) => player.connected);
  const offlineParticipants = participants.filter((player) => !player.connected);
  return {
    players,
    participants,
    spectators,
    onlineParticipants,
    offlineParticipants
  };
}

function getEffectiveRoomState(snapshot) {
  const room = getRoom(snapshot);
  if (!room) {
    return null;
  }
  return room.state === "PAUSED" ? room.pauseInfo?.phase || room.state : room.state;
}

function getPendingPlayers(snapshot) {
  const effectiveState = getEffectiveRoomState(snapshot);
  const targetState =
    effectiveState === "PRACTICE_PLAY"
      ? "PRACTICE_DONE"
      : effectiveState === "MAIN_PLAY"
        ? "MAIN_DONE"
        : null;

  if (!targetState) {
    return [];
  }

  return (snapshot?.players || []).filter((player) => !player.spectator && player.state !== targetState);
}

function renderTextChipRow(labels, tone = "neutral") {
  const filtered = (labels || []).filter(Boolean);
  if (!filtered.length) {
    return "";
  }
  return `
    <div class="name-chip-row">
      ${filtered.map((label) => `<span class="name-chip name-chip--${tone}">${escapeHtml(label)}</span>`).join("")}
    </div>
  `;
}

function renderNameChipRow(players, emptyLabel, tone = "neutral") {
  if (!players.length) {
    return renderTextChipRow([emptyLabel], tone);
  }
  return renderTextChipRow(
    players.map((player) => player.nickname),
    tone
  );
}

function renderOpsDetailCard(title, body, chipsHtml = "", tone = "neutral") {
  return `
    <div class="ops-detail-card ops-detail-card--${tone}">
      <h4>${escapeHtml(title)}</h4>
      <p>${escapeHtml(body)}</p>
      ${chipsHtml}
    </div>
  `;
}

function getPlayerProgressBadge(snapshot, player) {
  if (player.spectator) {
    return null;
  }

  const room = getRoom(snapshot);
  const effectiveState = getEffectiveRoomState(snapshot);
  if (!room || !effectiveState) {
    return null;
  }

  if (effectiveState === "PRACTICE_PLAY") {
    if (player.state === "PRACTICE_DONE") {
      return { label: "연습 제출 완료", tone: "gold", pending: false };
    }
    return {
      label: player.connected ? "연습 제출 대기" : "연습 미접속",
      tone: "accent",
      pending: true
    };
  }

  if (effectiveState === "MAIN_PLAY") {
    if (player.state === "MAIN_DONE") {
      return { label: "본게임 제출 완료", tone: "gold", pending: false };
    }
    return {
      label: player.connected ? "본게임 제출 대기" : "본게임 미접속",
      tone: "accent",
      pending: true
    };
  }

  if (effectiveState === "MAIN_INTRO") {
    return { label: "본게임 곧 시작", tone: "teal", pending: false };
  }

  if (room.state === "PAUSED") {
    return { label: "일시정지", tone: "neutral", pending: false };
  }

  return null;
}

function getAdminConfirmationMessage(action, button) {
  const snapshot = store.snapshot;
  if (!snapshot) {
    return null;
  }

  const room = getRoom(snapshot);
  const round = getRound(snapshot);
  const roster = getRosterGroups(snapshot);

  switch (action) {
    case "reroll-games":
      return "선정된 게임 구성이 다시 추첨됩니다. 현재 게임 목록을 바꿀까요?";
    case "start-tournament":
      return `현재 참가 ${roster.participants.length}명을 공식 참가자로 확정하고 대회를 시작할까요? 이후 입장자는 관전자로 처리됩니다.`;
    case "skip-practice":
      return `${round ? `${round.roundNumber}라운드 ` : ""}연습을 건너뛰고 본게임 카운트다운으로 바로 이동할까요?`;
    case "restart-round":
      return `${round ? `${round.roundNumber}라운드 ` : ""}현재 제출과 진행 상태가 초기화됩니다. 정말 다시 시작할까요?`;
    case "reset-room":
      return "현재 대회 결과를 정리하고 같은 방 코드로 새 대회를 엽니다. 계속할까요?";
    case "remove-player": {
      const player = snapshot.players?.find((candidate) => candidate.id === button?.dataset.playerId);
      return `${player?.nickname || "이 참가자"}를 대기실에서 제외할까요?`;
    }
    default:
      return null;
  }
}

function renderBanner() {
  if (!store.banner) {
    return "";
  }
  return `
    <div class="message-box ${store.banner.type === "error" ? "error" : ""}">
      ${escapeHtml(store.banner.message)}
    </div>
  `;
}

function getRoleLabel(role) {
  switch (role) {
    case "admin":
      return "최근 관리자";
    case "player":
      return "최근 참가자";
    case "spectator":
      return "최근 관전자";
    case "display":
      return "최근 발표 화면";
    case "guest":
      return "권한 대기";
    default:
      return "최근 접속";
  }
}

function toneForRoomState(state) {
  switch (state) {
    case "WAITING":
    case "ROUND_INTRO":
      return "accent";
    case "PRACTICE_PLAY":
    case "MAIN_INTRO":
    case "MAIN_PLAY":
      return "teal";
    case "FINAL_RESULT":
    case "ROUND_RESULT":
    case "ENDED":
      return "gold";
    default:
      return "neutral";
  }
}

function buildRoomInsightChips(room) {
  return [
    room.roundCount ? (room.currentRoundNumber ? `${room.currentRoundNumber}/${room.roundCount}R` : `${room.roundCount}라운드`) : null,
    `참가 ${room.participantCount || 0}명`,
    `온라인 ${room.connectedParticipantCount || 0}명`,
    (room.spectatorCount || 0) > 0 ? `관전 ${room.spectatorCount}명` : null,
    room.lockedPlayerCount ? `확정 ${room.lockedPlayerCount}명` : room.state === "WAITING" ? "시작 전 대기" : null
  ];
}

function renderRoomHubCard(room, options = {}) {
  const roomCode = room.code;
  const tone = options.inactive ? "neutral" : toneForRoomState(room.state);
  const roundTitle = room.currentRoundTitle || (room.currentRoundNumber ? `${room.currentRoundNumber}라운드 진행 준비` : "라운드 시작 전");
  return `
    <div class="room-hub-card ${options.inactive ? "room-hub-card--inactive" : ""}">
      <div class="room-hub-header">
        <div>
          <div class="room-hub-code">${escapeHtml(roomCode)}</div>
          <h3>${escapeHtml(room.name || "이름 없는 방")}</h3>
        </div>
        <div class="room-hub-pill-row">
          <span class="pill ${tone}">${escapeHtml(options.inactive ? "최근 기록" : ROOM_STATE_LABELS[room.state] || "진행 중")}</span>
          ${options.roleLabel ? `<span class="pill neutral">${escapeHtml(options.roleLabel)}</span>` : ""}
        </div>
      </div>
      <p class="room-hub-summary">${escapeHtml(roundTitle)}</p>
      ${renderTextChipRow(buildRoomInsightChips(room), options.inactive ? "neutral" : tone)}
      <p class="room-hub-meta">
        ${options.inactive ? "마지막 접속" : "최근 업데이트"} ${escapeHtml(formatShortDateTime(options.updatedAt || room.updatedAt || room.createdAt))}
      </p>
      <div class="button-row room-hub-actions">
        <button type="button" class="secondary" data-action="prefill-room" data-room-code="${escapeHtml(roomCode)}">입장 코드 채우기</button>
        <button type="button" class="ghost" data-action="prepare-recovery" data-room-code="${escapeHtml(roomCode)}">복구 준비</button>
        <button type="button" class="secondary" data-action="open-display" data-room-code="${escapeHtml(roomCode)}">발표 화면</button>
      </div>
    </div>
  `;
}

function renderRoomHubSection(title, description, rooms, buildCard, emptyMessage) {
  return `
    <div class="room-hub-column">
      <div class="panel-header">
        <div>
          <h3>${escapeHtml(title)}</h3>
          <p class="muted">${escapeHtml(description)}</p>
        </div>
      </div>
      <div class="room-hub-grid">
        ${
          rooms.length
            ? rooms.map((room) => buildCard(room)).join("")
            : `
              <div class="soft-card room-hub-empty">
                <h3>${escapeHtml(title)}</h3>
                <p>${escapeHtml(emptyMessage)}</p>
              </div>
            `
        }
      </div>
    </div>
  `;
}

function renderRecoveryHub() {
  const liveRoomMap = new Map(store.roomDirectory.map((room) => [room.code, room]));
  const recentRooms = store.recentRooms.map((entry) => {
    const liveRoom = liveRoomMap.get(entry.code);
    return liveRoom
      ? {
          ...liveRoom,
          roleLabel: getRoleLabel(entry.lastRole),
          updatedAt: entry.lastVisitedAt
        }
      : {
          code: entry.code,
          name: entry.name,
          state: "ENDED",
          roundCount: 0,
          currentRoundNumber: 0,
          currentRoundTitle: "현재는 목록에 보이지 않는 방입니다.",
          participantCount: 0,
          connectedParticipantCount: 0,
          spectatorCount: 0,
          lockedPlayerCount: 0,
          updatedAt: entry.lastVisitedAt,
          roleLabel: getRoleLabel(entry.lastRole),
          inactive: true
        };
  });

  return `
    <section class="panel room-hub-panel">
      <div class="panel-header">
        <div>
          <h2>방 복구 허브</h2>
          <p class="muted">최근 접속한 방과 현재 진행 중인 방을 보고, 입장 코드 채우기나 관리자 복구 준비를 바로 할 수 있습니다.</p>
        </div>
        <div class="admin-toolbar-actions">
          <button type="button" class="secondary" data-action="refresh-room-directory">목록 새로고침</button>
          ${
            store.recentRooms.length
              ? '<button type="button" class="ghost" data-action="clear-recent-rooms">최근 기록 비우기</button>'
              : ""
          }
        </div>
      </div>
      <div class="room-hub-layout">
        ${renderRoomHubSection(
          "최근 접속 방",
          "이 브라우저에서 한 번이라도 열었던 방 기록입니다.",
          recentRooms,
          (room) =>
            renderRoomHubCard(room, {
              roleLabel: room.roleLabel,
              inactive: room.inactive,
              updatedAt: room.updatedAt
            }),
          "아직 이 기기에서 접속한 방 기록이 없습니다."
        )}
        ${renderRoomHubSection(
          "현재 진행 중인 방",
          "서버에 살아 있는 방 목록입니다. 행사 운영 중 다른 기기 연결에도 사용할 수 있습니다.",
          store.roomDirectory,
          (room) => renderRoomHubCard(room),
          "현재 진행 중인 방이 없습니다."
        )}
      </div>
    </section>
  `;
}

function renderArchiveHubCard(archive) {
  const winnerLabel = archive.winner ? `우승 ${archive.winner.nickname} · ${archive.winner.totalPoints}점` : "우승 정보 없음";
  const top3Labels = archive.top3?.length ? archive.top3.map((entry) => `${entry.rank}위 ${entry.nickname}`) : ["순위 데이터 없음"];
  return `
    <div class="room-hub-card archive-hub-card">
      <div class="room-hub-header">
        <div>
          <div class="room-hub-code">${escapeHtml(archive.roomCode)}</div>
          <h3>${escapeHtml(archive.roomName || "종료 대회")}</h3>
        </div>
        <div class="room-hub-pill-row">
          <span class="pill gold">종료 기록</span>
          <span class="pill neutral">${escapeHtml(formatShortDateTime(archive.archivedAt))}</span>
        </div>
      </div>
      <p class="room-hub-summary">${escapeHtml(winnerLabel)}</p>
      ${renderTextChipRow(
        [
          archive.roundCount ? `${archive.completedRoundCount}/${archive.roundCount}R` : null,
          `참가 ${archive.participantCount || 0}명`,
          archive.spectatorCount ? `관전 ${archive.spectatorCount}명` : null
        ],
        "gold"
      )}
      ${renderTextChipRow(top3Labels, "neutral")}
      <div class="button-row room-hub-actions">
        <button type="button" class="secondary" data-action="download-archive-report" data-archive-id="${escapeHtml(archive.id)}">리포트 JSON</button>
        <button type="button" class="ghost" data-action="prefill-room" data-room-code="${escapeHtml(archive.roomCode)}">방 코드 채우기</button>
      </div>
    </div>
  `;
}

function renderArchiveHub() {
  return `
    <section class="panel room-hub-panel">
      <div class="panel-header">
        <div>
          <h2>종료 대회 기록</h2>
          <p class="muted">이전에 끝난 대회 기록을 검색하고, 라운드 히스토리가 담긴 리포트를 다시 내려받을 수 있습니다.</p>
        </div>
      </div>
      <form id="archive-search-form" class="archive-search-form">
        <div class="field">
          <label for="archive-search-input">검색</label>
          <input
            id="archive-search-input"
            name="query"
            maxlength="60"
            placeholder="방 이름, 방 코드, 참가자 이름으로 검색"
            value="${escapeHtml(store.archiveQuery)}"
          />
        </div>
        <div class="button-row archive-search-actions">
          <button type="submit" class="secondary">검색</button>
          <button type="button" class="ghost" data-action="clear-archive-search">검색 초기화</button>
          <button type="button" class="secondary" data-action="refresh-archives">아카이브 새로고침</button>
        </div>
      </form>
      <div class="room-hub-grid">
        ${
          store.archiveList.length
            ? store.archiveList.map((archive) => renderArchiveHubCard(archive)).join("")
            : `
              <div class="soft-card room-hub-empty">
                <h3>검색 결과 없음</h3>
                <p>${escapeHtml(store.archiveQuery ? "검색어와 일치하는 종료 대회 기록이 없습니다." : "아직 저장된 종료 대회 기록이 없습니다.")}</p>
              </div>
            `
        }
      </div>
    </section>
  `;
}

function renderEntryChoiceButton(view, title, description, tone = "neutral") {
  const isActive = store.entryView === view;
  return `
    <button
      type="button"
      class="entry-choice-button ${isActive ? "is-active" : ""}"
      data-action="open-entry"
      data-entry-view="${view}"
    >
      <span class="pill ${tone}">${escapeHtml(title)}</span>
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(description)}</span>
    </button>
  `;
}

function renderActionStateCard() {
  const state = store.actionState;
  if (!state) {
    return "";
  }

  const showControls = state.status === "error" || state.slow;
  return `
    <section class="soft-card action-state-card">
      ${state.status === "loading" ? '<div class="spinner"></div>' : '<span class="pill accent">재시도 가능</span>'}
      <h3>${escapeHtml(state.title)}</h3>
      <p>${escapeHtml(state.message)}</p>
      ${
        state.status === "loading" && state.slow
          ? '<p class="muted tiny">연결이 예상보다 오래 걸리고 있습니다. 다시 시도하거나 홈으로 돌아갈 수 있습니다.</p>'
          : ""
      }
      ${
        showControls
          ? `
            <div class="button-row">
              <button type="button" class="primary" data-action="retry-intent">다시 시도</button>
              <button type="button" class="secondary" data-action="go-home">홈으로</button>
            </div>
          `
          : ""
      }
    </section>
  `;
}

function renderHomeOverview() {
  return `
    <div class="home-flow-grid">
      <div class="soft-card">
        <h3>원하는 역할을 선택하세요</h3>
        <p>홈 화면은 항상 바로 보이고, 이전 세션 복구는 백그라운드에서만 짧게 시도합니다.</p>
      </div>
      <div class="split-grid">
        <div class="choice-card">
          <h3>관리자 시작</h3>
          <p>방을 만들고 대기실에서 참가자 수, QR, 시작 버튼을 바로 확인할 수 있습니다.</p>
        </div>
        <div class="choice-card">
          <h3>참가자 입장</h3>
          <p>방 코드와 닉네임만 입력하면 같은 Wi-Fi의 다른 기기에서도 즉시 입장할 수 있습니다.</p>
        </div>
      </div>
      <div class="choice-card">
        <h3>테스트 모드</h3>
        <p>혼자 빠르게 확인할 수 있도록 테스트용 방을 바로 만들고 대기실로 이동합니다.</p>
      </div>
    </div>
  `;
}

function renderCreateRoomHomePanel() {
  return `
    <div class="home-flow-grid">
      <section class="soft-card">
        <div class="panel-header">
          <div>
            <h3>관리자용 방 만들기</h3>
            <p class="muted">모바일과 데스크톱 모두 같은 흐름으로 방을 만들고 바로 대기실로 이동합니다.</p>
          </div>
          <span class="pill accent">ADM-START</span>
        </div>
        <form id="create-room-form" class="field-stack">
          <div class="field">
            <label for="room-name">방 이름</label>
            <input id="room-name" name="name" maxlength="40" placeholder="예: 영업팀 회식 게임" value="${escapeHtml(store.createRoomName)}" />
          </div>
          <div class="field">
            <label>라운드 수</label>
            <div class="round-toggle">
              <button type="button" data-action="set-round-count" data-round-count="5" class="${store.createRoundCount === 5 ? "active" : ""}">5 라운드</button>
              <button type="button" data-action="set-round-count" data-round-count="8" class="${store.createRoundCount === 8 ? "active" : ""}">8 라운드</button>
            </div>
          </div>
          <div class="field">
            <label for="room-prizes">특별상품 초안</label>
            <textarea id="room-prizes" name="prizes" placeholder="한 줄에 하나씩 입력하세요. 빈 줄은 비워둬도 됩니다.">${escapeHtml(store.createPrizesText)}</textarea>
          </div>
          <div class="button-row">
            <button type="submit" class="primary">방 생성하고 대기실 열기</button>
            <button type="button" class="secondary" data-action="go-home">홈으로</button>
          </div>
        </form>
      </section>
      <div class="split-grid">
        <div class="choice-card">
          <h3>LAN 접속 준비</h3>
          <p>방이 만들어지면 현재 접속 origin 기준 초대 링크와 QR이 생성되어 다른 기기에서도 바로 입장할 수 있습니다.</p>
        </div>
        ${renderAdminRecoveryCard({
          roomCode: store.prefilledRoomCode,
          title: "기존 방 관리자 권한 복구",
          description: "새 기기나 새 브라우저에서 기존 방 운영을 이어받을 때 사용합니다."
        })}
      </div>
    </div>
  `;
}

function renderJoinHomePanel() {
  return `
    <div class="home-flow-grid">
      <section class="soft-card">
        <div class="panel-header">
          <div>
            <h3>참가자 입장</h3>
            <p class="muted">방 코드와 닉네임만 입력하면 입장하고, 대회 시작 후 접속자는 자동으로 관전자 처리됩니다.</p>
          </div>
          <span class="pill teal">JOIN</span>
        </div>
        <form id="join-room-form" class="field-stack">
          <div class="field">
            <label for="join-room-code">방 코드</label>
            <input id="join-room-code" name="roomCode" maxlength="5" placeholder="예: 8F2K9" value="${escapeHtml(store.prefilledRoomCode)}" />
          </div>
          <div class="field">
            <label for="join-nickname">닉네임</label>
            <input id="join-nickname" name="nickname" maxlength="20" placeholder="예: 문기" value="${escapeHtml(store.joinNickname)}" />
          </div>
          <div class="button-row">
            <button type="submit" class="primary">입장하기</button>
            <button type="button" class="secondary" data-action="go-home">홈으로</button>
          </div>
        </form>
      </section>
      <div class="split-grid">
        <div class="choice-card">
          <h3>빠른 참가</h3>
          <p>관리자가 대회를 시작하면 현재 입장 인원으로 참가자가 확정되고, 이후 입장자는 자동으로 관전 모드로 들어갑니다.</p>
        </div>
        <div class="choice-card">
          <h3>재접속 복구</h3>
          <p>같은 기기와 같은 브라우저로 다시 접속하면 기존 플레이 기록을 이어받을 수 있습니다.</p>
        </div>
      </div>
    </div>
  `;
}

function renderTestModeHomePanel() {
  return `
    <div class="home-flow-grid">
      <section class="soft-card">
        <div class="panel-header">
          <div>
            <h3>테스트 모드</h3>
            <p class="muted">빠르게 운영 흐름을 확인할 수 있도록 테스트용 방을 즉시 생성합니다.</p>
          </div>
          <span class="pill gold">TEST</span>
        </div>
        <p class="muted">방 생성 후 대기실로 이동하며, 혼자 시작하면 서버가 자동으로 TEST 모드로 분류합니다.</p>
        <div class="button-row">
          <button type="button" class="primary" data-action="start-test-mode">테스트 방 바로 만들기</button>
          <button type="button" class="secondary" data-action="go-home">홈으로</button>
        </div>
      </section>
      <div class="choice-card">
        <h3>권장 사용 방식</h3>
        <p>관리자 화면, 모바일 참가 화면, 발표 화면을 순서대로 빠르게 점검할 때 유용합니다.</p>
      </div>
    </div>
  `;
}

function renderHomeEntryPanel() {
  if (store.actionState) {
    return renderActionStateCard();
  }

  switch (store.entryView) {
    case "create":
      return renderCreateRoomHomePanel();
    case "join":
      return renderJoinHomePanel();
    case "test":
      return renderTestModeHomePanel();
    default:
      return renderHomeOverview();
  }
}

function renderLanding() {
  if (store.displayMode) {
    return renderDisplayLanding();
  }

  return `
    ${renderBanner()}
    <div class="landing-stack">
      <section class="panel landing-home-shell">
        <div class="panel-header">
          <div>
            <h2>역할을 선택해 시작하세요</h2>
            <p class="muted">무한 준비 화면 없이 바로 홈을 보여주고, 필요한 순간에만 세션과 연결 상태를 안내합니다.</p>
          </div>
          <span class="pill neutral">HOME</span>
        </div>
        <div class="entry-choice-grid">
          ${renderEntryChoiceButton("create", "관리자 시작", "방 생성 후 대기실로 이동", "accent")}
          ${renderEntryChoiceButton("join", "참가자 입장", "방 코드와 닉네임으로 접속", "teal")}
          ${renderEntryChoiceButton("test", "테스트 모드", "테스트용 방을 즉시 생성", "gold")}
        </div>
        <div class="subtle-divider"></div>
        ${renderHomeEntryPanel()}
      </section>
      ${renderRecoveryHub()}
      ${renderArchiveHub()}
    </div>
  `;
}

function renderDisplayLanding() {
  const hasRoomCode = Boolean(store.prefilledRoomCode);
  return `
    ${renderBanner()}
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>발표 전용 화면</h2>
          <p class="muted">참가 조작 없이 대형 화면용 진행 보드만 표시합니다.</p>
        </div>
        <span class="pill gold">DISPLAY</span>
      </div>
      <div class="soft-card">
        <h3>${hasRoomCode ? `${escapeHtml(store.prefilledRoomCode)} 방에 연결 중` : "방 코드가 필요합니다."}</h3>
        <p class="muted">
          ${
            hasRoomCode
              ? "관리자 화면에서 복사한 발표 링크로 접속하면 실시간으로 진행 상황이 반영됩니다."
              : "`?room=방코드&display=1` 형식의 링크로 접속하면 발표 화면이 열립니다."
          }
        </p>
      </div>
    </section>
  `;
}

function renderAdminRecoveryCard({ roomCode = "", title = "관리자 권한 복구", description } = {}) {
  return `
    <div class="soft-card">
      <div class="panel-header">
        <div>
          <h3>${escapeHtml(title)}</h3>
          <p class="muted">${escapeHtml(description || "관리자 화면에 표시된 복구 코드로 기존 방의 관리자 권한을 이어받을 수 있습니다.")}</p>
        </div>
        <span class="pill gold">RECOVER</span>
      </div>
      <form id="recover-admin-form" class="field-stack">
        <div class="field">
          <label for="recover-room-code">방 코드</label>
          <input id="recover-room-code" name="roomCode" maxlength="5" placeholder="예: 8F2K9" value="${escapeHtml(roomCode)}" />
        </div>
        <div class="field">
          <label for="recover-admin-code">복구 코드</label>
          <input
            id="recover-admin-code"
            name="recoveryCode"
            maxlength="12"
            placeholder="예: A1B2C3D4"
            autocomplete="one-time-code"
            value="${escapeHtml(store.recoveryCode)}"
          />
        </div>
        <div class="button-row">
          <button type="submit" class="secondary">관리자 권한 복구</button>
        </div>
      </form>
    </div>
  `;
}

function renderStatsRow(snapshot) {
  const room = getRoom(snapshot);
  const viewer = getViewer(snapshot);
  const round = getRound(snapshot);
  const roleLabel =
    viewer.role === "admin"
      ? "관리자"
      : viewer.role === "spectator"
        ? "관전자"
        : viewer.role === "display"
          ? "발표 화면"
          : viewer.role === "guest"
            ? "권한 대기"
            : "참가자";
  return `
    <div class="stats-grid">
      <div class="stat-card">
        <span class="stat-label">방 코드</span>
        <div class="stat-value">${escapeHtml(room.code)}</div>
      </div>
      <div class="stat-card">
        <span class="stat-label">현재 상태</span>
        <div class="stat-value">${ROOM_STATE_LABELS[room.state]}</div>
      </div>
      <div class="stat-card">
        <span class="stat-label">내 역할</span>
        <div class="stat-value">${roleLabel}</div>
      </div>
      <div class="stat-card">
        <span class="stat-label">현재 라운드</span>
        <div class="stat-value">${round ? `${round.roundNumber}/${room.roundCount}` : "-"}</div>
      </div>
    </div>
  `;
}

function getPhaseLabel(phase) {
  return ROOM_STATE_LABELS[phase] || phase || "-";
}

function isPresentationMode(snapshot) {
  const role = getViewer(snapshot).role;
  return role === "display" || (role === "admin" && store.presentationMode);
}

function renderInviteCard(snapshot) {
  const room = getRoom(snapshot);
  const inviteUrl = `${window.location.origin}/?room=${room.code}`;
  const displayUrl = `${window.location.origin}/?room=${room.code}&display=1`;
  return `
    <div class="invite-card">
      <div class="qr-card">
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(inviteUrl)}" alt="입장 QR 코드" />
      </div>
      <div class="soft-card">
        <h3>모바일 입장 안내</h3>
        <p class="muted">QR을 찍거나 링크를 복사해서 참가자들에게 공유하세요.</p>
        <div class="room-code">${escapeHtml(room.code)}</div>
        <div class="link-box">
          <div class="copy-row">
            <input id="invite-link-input" readonly value="${escapeHtml(inviteUrl)}" />
            <button type="button" class="copy-button" data-action="copy-link" data-copy-target="invite-link-input">복사</button>
          </div>
          <div class="copy-row">
            <input id="display-link-input" readonly value="${escapeHtml(displayUrl)}" />
            <button type="button" class="copy-button" data-action="copy-link" data-copy-target="display-link-input">발표 링크 복사</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderSelectedGames(snapshot) {
  const room = getRoom(snapshot);
  return `
    <div class="result-grid">
      ${room.selectedGames
        .map(
          (game) => `
            <div class="soft-card">
              <span class="pill neutral">${game.round}R</span>
              <h3>${escapeHtml(game.title)}</h3>
              <p>${escapeHtml(game.category)}</p>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderPrizeEditor(snapshot) {
  const room = getRoom(snapshot);
  const currentRound = getRound(snapshot);
  const lockEditing = room.state === "MAIN_PLAY" || room.state === "SCORING";
  return `
    <div class="result-grid">
      ${room.selectedGames
        .map((game) => {
          const value = currentRound?.roundNumber === game.round ? currentRound.prize : room.prizes?.[game.round - 1] || "";
          return `
            <div class="soft-card">
              <div class="panel-header">
                <h3>${game.round}R 특별상품</h3>
                <span class="pill gold">${escapeHtml(game.title)}</span>
              </div>
              <div class="field">
                <input id="prize-input-${game.round}" value="${escapeHtml(value)}" placeholder="예: 스타벅스 1만원권" ${lockEditing ? "disabled" : ""} />
              </div>
              <div class="button-row">
                <button type="button" class="secondary" data-action="save-prize" data-round-index="${game.round - 1}" ${lockEditing ? "disabled" : ""}>저장</button>
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderAdminToolbar(snapshot) {
  const room = getRoom(snapshot);
  const viewer = getViewer(snapshot);
  const on = isPresentationMode(snapshot);
  const recoveryCode = viewer.adminRecoveryCode || room.adminRecoveryCode || "";
  return `
    <section class="panel admin-toolbar">
      <div class="admin-toolbar-row">
        <div>
          <span class="eyebrow">Admin Control</span>
          <h2>${escapeHtml(room.name)}</h2>
          <p class="muted">대형 화면 발표용 포커스 모드를 켜면 핵심 진행 정보만 크게 보여줍니다.</p>
        </div>
        <div class="admin-toolbar-actions">
          <span class="pill ${on ? "gold" : "neutral"}">${on ? "발표 모드 ON" : "발표 모드 OFF"}</span>
          <button type="button" class="${on ? "secondary" : "primary"}" data-action="toggle-presentation">
            ${on ? "발표 모드 끄기" : "발표 모드 켜기"}
          </button>
        </div>
      </div>
      ${
        recoveryCode
          ? `
            <div class="soft-card">
              <h3>관리자 복구 코드</h3>
              <p class="muted">현재 운영 권한을 다른 기기로 옮겨야 할 때 이 코드를 입력하면 됩니다.</p>
              <div class="copy-row">
                <input id="admin-recovery-code-input" readonly value="${escapeHtml(recoveryCode)}" />
                <button
                  type="button"
                  class="copy-button"
                  data-action="copy-value"
                  data-copy-value="${escapeHtml(recoveryCode)}"
                  data-copy-message="관리자 복구 코드를 복사했습니다."
                >
                  코드 복사
                </button>
              </div>
            </div>
          `
          : ""
      }
    </section>
  `;
}

function renderAdminOperationsPanel(snapshot) {
  const room = getRoom(snapshot);
  const round = getRound(snapshot);
  const roster = getRosterGroups(snapshot);
  const pendingPlayers = getPendingPlayers(snapshot);
  const effectiveState = getEffectiveRoomState(snapshot);
  const liveStageLabel = effectiveState === "PRACTICE_PLAY" ? "연습" : "본게임";
  const detailCards = [];

  let badge = "Ops Guide";
  let tone = "neutral";
  let title = "현재 진행 상황을 확인해 주세요.";
  let body = "화면 상태에 맞는 운영 액션을 선택하면 됩니다.";

  switch (room.state) {
    case "WAITING":
      badge = roster.participants.length ? "Ready Check" : "Need Players";
      tone = roster.participants.length ? "teal" : "accent";
      title = roster.participants.length ? "입장 인원과 특별상품을 점검한 뒤 대회를 시작하세요." : "대회 시작 전에 참가자를 먼저 모아 주세요.";
      body = roster.participants.length
        ? `지금 시작하면 참가 ${roster.participants.length}명이 공식 참가자로 잠기고 이후 입장자는 자동으로 관전자로 들어옵니다.`
        : "최소 1명 이상의 참가자가 입장해야 대회를 시작할 수 있습니다.";
      if (roster.offlineParticipants.length) {
        detailCards.push(
          renderOpsDetailCard(
            "오프라인 참가자",
            "시작 전에 재접속 여부를 확인하면 진행 중 불필요한 정지를 줄일 수 있습니다.",
            renderNameChipRow(roster.offlineParticipants, "오프라인 참가자 없음", "accent"),
            "accent"
          )
        );
      } else if (roster.participants.length) {
        detailCards.push(
          renderOpsDetailCard(
            "준비 상태",
            "현재 참가자 모두 온라인입니다. 게임 재추첨이나 특별상품 수정 후 바로 시작해도 됩니다.",
            renderTextChipRow(["참가 준비 완료"], "teal"),
            "teal"
          )
        );
      }
      break;
    case "ROUND_INTRO":
      badge = "Round Brief";
      tone = "gold";
      title = `${round.roundNumber}라운드 안내를 마치고 연습 여부를 선택하세요.`;
      body = "게임 설명과 특별상품을 소개한 뒤 연습을 열거나 바로 본게임으로 넘어갈 수 있습니다.";
      detailCards.push(
        renderOpsDetailCard(
          "이번 라운드 포인트",
          "특별상품과 게임 제목을 멘트로 먼저 안내하면 플레이어 이해가 빨라집니다.",
          renderTextChipRow(
            [round.title, round.prize ? `특별상품: ${round.prize}` : "특별상품 미설정"],
            "gold"
          ),
          "gold"
        )
      );
      break;
    case "PRACTICE_PLAY":
    case "MAIN_PLAY":
      badge = "Live Monitor";
      tone = pendingPlayers.length ? "accent" : "teal";
      title = pendingPlayers.length
        ? `${pendingPlayers.length}명이 아직 ${liveStageLabel} 제출 전입니다.`
        : `모든 참가자가 ${liveStageLabel} 제출을 마쳤습니다.`;
      body = pendingPlayers.length
        ? `제출이 모두 끝나면 자동으로 ${room.state === "PRACTICE_PLAY" ? "연습 결과" : "점수 집계"} 단계로 넘어갑니다.`
        : "자동 전환을 기다리면 다음 단계로 바로 이동합니다.";
      detailCards.push(
        renderOpsDetailCard(
          `${liveStageLabel} 제출 대기`,
          `아직 제출하지 않은 참가자 목록입니다. 운영 멘트나 현장 확인에 활용해 주세요.`,
          renderNameChipRow(pendingPlayers, "모두 제출 완료", pendingPlayers.length ? "accent" : "teal"),
          pendingPlayers.length ? "accent" : "teal"
        )
      );
      if (roster.offlineParticipants.length) {
        detailCards.push(
          renderOpsDetailCard(
            "오프라인 참가자",
            "네트워크가 끊긴 참가자는 현재 제출 대기 목록에 함께 포함될 수 있습니다.",
            renderNameChipRow(roster.offlineParticipants, "오프라인 참가자 없음", "accent"),
            "accent"
          )
        );
      }
      break;
    case "MAIN_INTRO":
      badge = "Countdown";
      tone = "teal";
      title = "본게임 카운트다운 중입니다.";
      body = "안내 멘트를 마무리하고 참가자 준비를 확인해 주세요. 카운트다운 종료 후 본게임이 자동 시작됩니다.";
      detailCards.push(
        renderOpsDetailCard(
          "곧 시작",
          "불가피한 상황이 생기면 지금은 일시정지로 대응할 수 있습니다.",
          renderTextChipRow([round.title], "teal"),
          "teal"
        )
      );
      break;
    case "PRACTICE_RESULT":
      badge = "Next Match";
      tone = "teal";
      title = "연습이 끝났습니다. 본게임 시작 타이밍만 잡아 주세요.";
      body = "연습 점수는 반영되지 않으니 짧게 안내한 뒤 본게임 시작 버튼을 누르면 됩니다.";
      detailCards.push(
        renderOpsDetailCard(
          "연습 제출 현황",
          "연습이 끝난 참가자 수를 확인하고 멘트를 정리해 보세요.",
          renderTextChipRow(
            [`연습 제출 ${round.practiceProgress.submitted}/${round.practiceProgress.total}`],
            "teal"
          ),
          "teal"
        )
      );
      break;
    case "SCORING":
      badge = "Scoring";
      tone = "gold";
      title = "점수 집계 중입니다.";
      body = "별도 조작 없이 잠시 기다리면 라운드 결과 화면으로 넘어갑니다.";
      detailCards.push(
        renderOpsDetailCard(
          "집계 진행",
          "현재 제출 데이터를 계산 중입니다.",
          renderTextChipRow([round?.title || room.name], "gold"),
          "gold"
        )
      );
      break;
    case "ROUND_RESULT": {
      const isLastRound = room.currentRoundIndex + 1 >= room.roundCount;
      const winner = round.results?.[0];
      badge = "Results";
      tone = "gold";
      title = isLastRound ? "최종 결과를 공개할 차례입니다." : "우승자를 발표한 뒤 다음 라운드로 넘어가세요.";
      body = isLastRound
        ? "최종 결과 보기 버튼으로 누적 순위를 발표합니다."
        : `${room.currentRoundIndex + 2}라운드로 넘어가면 다음 게임 소개 화면이 열립니다.`;
      if (winner) {
        detailCards.push(
          renderOpsDetailCard(
            "라운드 우승",
            `${winner.nickname}님이 이번 라운드 1위입니다.`,
            renderTextChipRow(
              [`우승 ${winner.nickname}`, round.prize ? `특별상품: ${round.prize}` : "특별상품 없음"],
              "gold"
            ),
            "gold"
          )
        );
      }
      break;
    }
    case "FINAL_RESULT": {
      const champion = snapshot.finalRanking?.[0];
      badge = "Grand Finale";
      tone = "gold";
      title = "최종 순위를 발표한 뒤 대회를 종료하세요.";
      body = "대회 종료 버튼을 누르면 종료 화면으로 전환되고, 이후 같은 방으로 새 대회를 다시 열 수 있습니다.";
      if (champion) {
        detailCards.push(
          renderOpsDetailCard(
            "최종 우승",
            `${champion.nickname}님이 누적 ${champion.totalPoints}점으로 우승했습니다.`,
            renderTextChipRow([`1위 ${champion.roundWins}회`, `2위 ${champion.secondPlaces}회`], "gold"),
            "gold"
          )
        );
      }
      break;
    }
    case "ENDED":
      badge = "Room Reset";
      tone = "teal";
      title = "같은 방으로 새 대회를 열 수 있습니다.";
      body = "방 코드는 유지한 채 점수와 진행 상태만 초기화해 다음 게임을 바로 시작할 수 있습니다.";
      detailCards.push(
        renderOpsDetailCard(
          "현재 방 코드 유지",
          "참가자들이 같은 링크와 방 코드를 계속 사용할 수 있습니다.",
          renderTextChipRow([room.code], "teal"),
          "teal"
        )
      );
      break;
    case "PAUSED":
      badge = "Paused";
      tone = "neutral";
      title = "진행이 멈춰 있습니다. 재개 또는 라운드 재시작을 선택하세요.";
      body = room.pauseInfo?.restartOnResume
        ? "재개하면 현재 phase가 처음부터 다시 시작됩니다."
        : "재개하면 현재 상태에서 이어서 진행됩니다.";
      detailCards.push(
        renderOpsDetailCard(
          "멈춘 상태",
          `${getPhaseLabel(room.pauseInfo?.phase)} 상태에서 일시정지되었습니다.`,
          renderTextChipRow(
            [
              getPhaseLabel(room.pauseInfo?.phase),
              room.pauseInfo?.restartOnResume ? "재개 시 처음부터" : "재개 시 이어서"
            ],
            "neutral"
          ),
          "neutral"
        )
      );
      break;
    default:
      break;
  }

  const summaryChips = [
    `참가 ${roster.participants.length}명`,
    `온라인 ${roster.onlineParticipants.length}명`,
    `관전 ${roster.spectators.length}명`,
    `오프라인 ${roster.offlineParticipants.length}명`
  ];

  if (effectiveState === "PRACTICE_PLAY" || effectiveState === "MAIN_PLAY") {
    summaryChips.push(`${liveStageLabel} 제출 ${roster.participants.length - pendingPlayers.length}/${roster.participants.length}`);
  }

  return `
    <section class="panel ops-panel">
      <div class="panel-header">
        <div>
          <h3>운영 가이드</h3>
          <p class="muted tiny">현재 상태에 맞는 다음 액션과 확인 포인트</p>
        </div>
        <span class="pill ${tone === "accent" ? "accent" : tone === "gold" ? "gold" : tone === "teal" ? "teal" : "neutral"}">${badge}</span>
      </div>
      ${renderTextChipRow(summaryChips, "neutral")}
      <div class="ops-callout ops-callout--${tone}">
        <span class="ops-kicker">Next Step</span>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(body)}</p>
      </div>
      ${detailCards.length ? `<div class="ops-detail-grid">${detailCards.join("")}</div>` : ""}
    </section>
  `;
}

function renderPresentationLeaderboard(entries, type = "round") {
  const limited = (entries || []).slice(0, 3);
  if (!limited.length) {
    return "";
  }
  return `
    <div class="presentation-results">
      ${limited
        .map((entry, index) => {
          const scoreLabel =
            type === "final"
              ? `누적 ${entry.totalPoints}점`
              : `${entry.score}점 · 대회 ${entry.tournamentPoints}점`;
          const metaLabel =
            type === "final"
              ? `1위 ${entry.roundWins || 0}회 · 2위 ${entry.secondPlaces || 0}회`
              : `${escapeHtml(entry.metrics?.label || "")}${entry.metrics?.summary ? ` · ${escapeHtml(entry.metrics.summary)}` : ""}`;
          return `
            <div class="presentation-result-card ${index === 0 ? "is-winner" : ""}">
              <div class="presentation-rank">${entry.rank}위</div>
              <div>
                <div class="presentation-name">${escapeHtml(entry.nickname)}</div>
                <div class="presentation-meta">${metaLabel}</div>
              </div>
              <div class="presentation-score">${scoreLabel}</div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderPresentationBoard(snapshot) {
  if (!isPresentationMode(snapshot)) {
    return "";
  }

  const room = getRoom(snapshot);
  const round = getRound(snapshot);
  const inviteUrl = `${window.location.origin}/?room=${room.code}`;
  const activeCount = snapshot.players.filter((player) => !player.spectator).length;
  const pauseInfo = room.pauseInfo;

  if (room.state === "WAITING") {
    return `
      <section class="panel presentation-board presentation-board--waiting">
        <div class="presentation-grid">
          <div class="presentation-hero">
            <span class="presentation-kicker">Join Now</span>
            <h2>${escapeHtml(room.name)}</h2>
            <p>휴대폰으로 QR을 찍거나 방 코드를 입력해 바로 입장하세요.</p>
            <div class="presentation-code">${escapeHtml(room.code)}</div>
            <div class="presentation-meta-row">
              <span class="pill gold">참가 ${activeCount}명</span>
              <span class="pill accent">${room.roundCount}라운드</span>
            </div>
          </div>
          <div class="presentation-qr-card">
            <img src="https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(inviteUrl)}" alt="발표용 입장 QR 코드" />
          </div>
        </div>
        <div class="presentation-chip-row">
          ${room.selectedGames.map((game) => `<span class="presentation-chip">${game.round}R ${escapeHtml(game.title)}</span>`).join("")}
        </div>
      </section>
    `;
  }

  if (room.state === "LOCKED") {
    return `
      <section class="panel presentation-board presentation-board--intro">
        <div class="presentation-hero">
          <span class="presentation-kicker">Players Locked</span>
          <h2>${escapeHtml(room.name)}</h2>
          <p>참가 인원이 확정되었습니다. 곧 첫 라운드 소개가 시작됩니다.</p>
        </div>
        <div class="presentation-meta-row">
          <span class="presentation-feature">확정 참가 ${snapshot.players.filter((player) => !player.spectator).length}명</span>
          <span class="presentation-feature">${room.roundCount}라운드 진행</span>
        </div>
      </section>
    `;
  }

  if (room.state === "ROUND_INTRO" && round) {
    return `
      <section class="panel presentation-board presentation-board--intro">
        <div class="presentation-hero">
          <span class="presentation-kicker">Round ${round.roundNumber}</span>
          <h2>${escapeHtml(round.title)}</h2>
          <p>${escapeHtml(round.intro)}</p>
        </div>
        <div class="presentation-meta-row">
          <span class="presentation-feature">특별상품: ${escapeHtml(round.prize || "설정 없음")}</span>
          <span class="presentation-feature">연습 ${round.practiceEnabled ? "진행 가능" : "생략 예정"}</span>
        </div>
      </section>
    `;
  }

  if (["MAIN_INTRO", "PRACTICE_PLAY", "MAIN_PLAY", "SCORING", "PRACTICE_RESULT", "PAUSED"].includes(room.state) && round) {
    const effectiveState = room.state === "PAUSED" ? pauseInfo?.phase : room.state;
    const deadline =
      effectiveState === "PRACTICE_PLAY"
        ? round.practiceEndsAt
        : effectiveState === "MAIN_PLAY"
          ? round.mainEndsAt
          : effectiveState === "MAIN_INTRO"
            ? round.mainIntroEndsAt
            : null;
    const progress =
      effectiveState === "PRACTICE_PLAY"
        ? `${round.practiceProgress.submitted}/${round.practiceProgress.total}`
        : effectiveState === "MAIN_PLAY"
          ? `${round.mainProgress.submitted}/${round.mainProgress.total}`
          : null;

    return `
      <section class="panel presentation-board presentation-board--live">
        <div class="presentation-hero">
          <span class="presentation-kicker">${getPhaseLabel(effectiveState)}</span>
          <h2>${escapeHtml(round.title)}</h2>
          <p>${
            room.state === "PAUSED"
              ? `${getPhaseLabel(pauseInfo?.phase)} 상태에서 잠시 멈췄습니다.`
              : escapeHtml(round.description)
          }</p>
        </div>
        <div class="presentation-metrics">
          <div class="presentation-metric">
            <span>현재 라운드</span>
            <strong>${round.roundNumber}/${room.roundCount}</strong>
          </div>
          <div class="presentation-metric">
            <span>특별상품</span>
            <strong>${escapeHtml(round.prize || "-")}</strong>
          </div>
          ${
            progress
              ? `
                <div class="presentation-metric">
                  <span>제출 현황</span>
                  <strong>${progress}</strong>
                </div>
              `
              : ""
          }
          ${
            deadline
              ? `
                <div class="presentation-metric">
                  <span>남은 시간</span>
                  <strong data-deadline="${deadline}"></strong>
                </div>
              `
              : ""
          }
        </div>
      </section>
    `;
  }

  if (room.state === "ROUND_RESULT" && round) {
    const winner = round.results?.[0];
    return `
      <section class="panel presentation-board presentation-board--result">
        <div class="presentation-hero">
          <span class="presentation-kicker">Round Winner</span>
          <h2>${winner ? `${escapeHtml(winner.nickname)} 우승` : `${escapeHtml(round.title)} 결과`}</h2>
          <p>${winner ? `${winner.score}점으로 이번 라운드 1위를 차지했습니다.` : "라운드 결과를 집계했습니다."}</p>
        </div>
        <div class="presentation-meta-row">
          <span class="presentation-feature">게임: ${escapeHtml(round.title)}</span>
          <span class="presentation-feature">특별상품: ${escapeHtml(round.prize || "설정 없음")}</span>
        </div>
        ${renderPresentationLeaderboard(round.results, "round")}
      </section>
    `;
  }

  if ((room.state === "FINAL_RESULT" || room.state === "ENDED") && snapshot.finalRanking?.length) {
    const champion = snapshot.finalRanking[0];
    return `
      <section class="panel presentation-board presentation-board--final">
        <div class="presentation-hero">
          <span class="presentation-kicker">Grand Winner</span>
          <h2>${escapeHtml(champion.nickname)}</h2>
          <p>누적 ${champion.totalPoints}점으로 최종 우승했습니다.</p>
        </div>
        ${renderPresentationLeaderboard(snapshot.finalRanking, "final")}
      </section>
    `;
  }

  return "";
}

function renderDisplayFallback(snapshot) {
  const room = getRoom(snapshot);
  const round = getRound(snapshot);
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>${escapeHtml(room.name)}</h2>
          <p class="muted">발표 전용 화면이 연결되어 있습니다.</p>
        </div>
        <span class="pill gold">DISPLAY</span>
      </div>
      ${renderStatsRow(snapshot)}
      <div class="timeline-card">
        <h3>${round ? `${round.roundNumber}라운드 · ${escapeHtml(round.title)}` : ROOM_STATE_LABELS[room.state]}</h3>
        <p>${round ? escapeHtml(round.description) : "다음 상태 전환을 기다리고 있습니다."}</p>
      </div>
    </section>
  `;
}

function renderWaitingStage(snapshot) {
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>${escapeHtml(getRoom(snapshot).name)}</h2>
          <p class="muted">참가자 입장을 받고 있습니다. 시작 버튼을 누르면 현재 인원이 공식 참가자로 확정됩니다.</p>
        </div>
        <span class="pill accent">ADM-02</span>
      </div>
      ${renderStatsRow(snapshot)}
      <div class="subtle-divider"></div>
      ${renderInviteCard(snapshot)}
      <div class="subtle-divider"></div>
      <div class="split-grid">
        <div>
          <h3 class="section-title">선정된 게임</h3>
          ${renderSelectedGames(snapshot)}
        </div>
        <div>
          <h3 class="section-title">특별상품 초안</h3>
          ${renderPrizeEditor(snapshot)}
        </div>
      </div>
      <div class="subtle-divider"></div>
      <div class="admin-actions">
        <button type="button" class="secondary" data-action="admin" data-admin-action="reroll-games">게임 재추첨</button>
        <button type="button" class="primary" data-action="admin" data-admin-action="start-tournament">대회 시작</button>
      </div>
    </section>
  `;
}

function renderRoundIntroStage(snapshot) {
  const round = getRound(snapshot);
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>${round.roundNumber}라운드 · ${escapeHtml(round.title)}</h2>
          <p class="muted">${escapeHtml(round.description)}</p>
        </div>
        <span class="pill accent">ADM-03</span>
      </div>
      <div class="timeline-card">
        <h3>${escapeHtml(round.intro)}</h3>
        <p>특별상품: <strong>${escapeHtml(round.prize || "설정 없음")}</strong></p>
      </div>
      <div class="subtle-divider"></div>
      <div class="admin-actions">
        <button type="button" class="primary" data-action="admin" data-admin-action="start-practice">연습 시작</button>
        <button type="button" class="secondary" data-action="admin" data-admin-action="skip-practice">연습 건너뛰기</button>
        <button type="button" class="secondary" data-action="admin" data-admin-action="start-main">본게임 시작</button>
        <button type="button" class="ghost" data-action="admin" data-admin-action="restart-round">라운드 재시작</button>
      </div>
    </section>
  `;
}

function renderMainIntroAdminStage(snapshot) {
  const round = getRound(snapshot);
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>${escapeHtml(round.title)} 본게임 카운트다운</h2>
          <p class="muted">곧 본게임이 자동으로 시작됩니다. 필요하면 잠시 멈추거나 라운드를 다시 열 수 있습니다.</p>
        </div>
        <span class="pill accent">ADM-05</span>
      </div>
      <div class="timeline-card">
        <h3>본게임 시작까지</h3>
        <p class="countdown" data-deadline="${round.mainIntroEndsAt}" data-prefix=""></p>
      </div>
      <div class="subtle-divider"></div>
      <div class="admin-actions">
        <button type="button" class="secondary" data-action="admin" data-admin-action="pause">일시정지</button>
        <button type="button" class="ghost" data-action="admin" data-admin-action="restart-round">라운드 재시작</button>
      </div>
    </section>
  `;
}

function renderLiveMonitorStage(snapshot) {
  const room = getRoom(snapshot);
  const round = getRound(snapshot);
  const progress = room.state === "PRACTICE_PLAY" ? round.practiceProgress : round.mainProgress;
  const deadline = room.state === "PRACTICE_PLAY" ? round.practiceEndsAt : round.mainEndsAt;
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>${escapeHtml(round.title)} ${room.state === "PRACTICE_PLAY" ? "연습 진행" : "본게임 진행"}</h2>
          <p class="muted">${escapeHtml(round.description)}</p>
        </div>
        <span class="pill accent">${room.state === "PRACTICE_PLAY" ? "ADM-04" : "ADM-05"}</span>
      </div>
      <div class="stats-grid">
        <div class="stat-card">
          <span class="stat-label">제출 현황</span>
          <div class="stat-value">${progress.submitted}/${progress.total}</div>
        </div>
        <div class="stat-card">
          <span class="stat-label">남은 시간</span>
          <div class="stat-value" data-deadline="${deadline}" data-prefix=""></div>
        </div>
        <div class="stat-card">
          <span class="stat-label">특별상품</span>
          <div class="stat-value">${escapeHtml(round.prize || "-")}</div>
        </div>
        <div class="stat-card">
          <span class="stat-label">현재 게임</span>
          <div class="stat-value">${escapeHtml(round.title)}</div>
        </div>
      </div>
      <div class="timeline-card">
        <h3>${room.state === "PRACTICE_PLAY" ? "참가자들이 연습판을 진행 중입니다." : "본게임이 진행 중입니다."}</h3>
        <p>제출이 모두 끝나면 자동으로 다음 상태로 넘어갑니다.</p>
      </div>
      <div class="subtle-divider"></div>
      <div class="admin-actions">
        ${
          room.state === "SCORING"
            ? `<button type="button" class="ghost" data-action="admin" data-admin-action="restart-round">라운드 재시작</button>`
            : `
              <button type="button" class="secondary" data-action="admin" data-admin-action="pause">일시정지</button>
              <button type="button" class="ghost" data-action="admin" data-admin-action="restart-round">라운드 재시작</button>
            `
        }
      </div>
    </section>
  `;
}

function renderPracticeResultStage(snapshot) {
  const round = getRound(snapshot);
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>${escapeHtml(round.title)} 연습 결과</h2>
          <p class="muted">연습판은 점수에 반영되지 않습니다. 준비가 되면 본게임을 시작하세요.</p>
        </div>
        <span class="pill accent">ADM-04</span>
      </div>
      <div class="stats-grid">
        <div class="stat-card">
          <span class="stat-label">연습 제출</span>
          <div class="stat-value">${round.practiceProgress.submitted}/${round.practiceProgress.total}</div>
        </div>
        <div class="stat-card">
          <span class="stat-label">특별상품</span>
          <div class="stat-value">${escapeHtml(round.prize || "-")}</div>
        </div>
      </div>
      <div class="admin-actions">
        <button type="button" class="primary" data-action="admin" data-admin-action="start-main">본게임 시작</button>
        <button type="button" class="ghost" data-action="admin" data-admin-action="restart-round">라운드 재시작</button>
      </div>
    </section>
  `;
}

function renderResultsTable(results, viewerPlayerId) {
  if (!results?.length) {
    return `<div class="soft-card"><p class="muted">아직 결과가 없습니다.</p></div>`;
  }
  return `
    <div class="result-table">
      ${results
        .map(
          (entry) => `
            <div class="result-row" ${entry.playerId === viewerPlayerId ? 'style="outline: 2px solid rgba(198, 90, 58, 0.28);"' : ""}>
              <div class="rank-badge">${entry.rank}위</div>
              <div>
                <div class="player-name">${escapeHtml(entry.nickname)}</div>
                <div class="player-meta">${escapeHtml(entry.metrics?.label || "-")} · ${escapeHtml(entry.metrics?.summary || "")}</div>
              </div>
              <div class="pill ${entry.prizeWinner ? "gold" : "neutral"}">${entry.prizeWinner ? "특별상품" : `${entry.tournamentPoints}점`}</div>
              <div class="player-name">${entry.score}점</div>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderPodiumCards(entries, mode = "round") {
  const topEntries = (entries || []).slice(0, 3);
  if (!topEntries.length) {
    return "";
  }

  const order = topEntries.length >= 3 ? [1, 0, 2] : topEntries.length === 2 ? [0, 1] : [0];
  return `
    <div class="podium-grid podium-grid--${mode}">
      ${order
        .filter((index) => topEntries[index])
        .map((index) => {
          const entry = topEntries[index];
          const scoreLabel =
            mode === "final" ? `누적 ${entry.totalPoints}점` : `${entry.score}점 · 대회 ${entry.tournamentPoints}점`;
          const metaLabel =
            mode === "final"
              ? `1위 ${entry.roundWins || 0}회 · 2위 ${entry.secondPlaces || 0}회`
              : `${escapeHtml(entry.metrics?.label || "")}${entry.metrics?.summary ? ` · ${escapeHtml(entry.metrics.summary)}` : ""}`;
          return `
            <div class="podium-card podium-card--rank-${entry.rank}">
              <div class="podium-place">${entry.rank}위</div>
              <div class="podium-name">${escapeHtml(entry.nickname)}</div>
              <div class="podium-meta">${metaLabel}</div>
              <div class="podium-score">${scoreLabel}</div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderRoundSpotlight(round) {
  const winner = round?.results?.[0];
  if (!winner) {
    return "";
  }

  return `
    <div class="winner-spotlight winner-spotlight--round">
      <div class="winner-kicker">Round Winner</div>
      <h3>${escapeHtml(winner.nickname)}</h3>
      <p>${winner.score}점으로 ${escapeHtml(round.title)} 라운드 1위를 차지했습니다.</p>
      <div class="winner-chip-row">
        <span class="winner-chip">${winner.tournamentPoints} 대회 점수</span>
        <span class="winner-chip">${escapeHtml(round.prize ? `특별상품: ${round.prize}` : "특별상품 없음")}</span>
      </div>
    </div>
  `;
}

function renderFinalCeremony(snapshot, compact = false) {
  const ranking = snapshot.finalRanking || [];
  if (!ranking.length) {
    return `
      <div class="soft-card">
        <p class="muted">아직 최종 순위가 없습니다.</p>
      </div>
    `;
  }

  const champion = ranking[0];
  return `
    ${
      compact
        ? ""
        : `
          <div class="winner-spotlight winner-spotlight--final">
            <div class="winner-kicker">Grand Winner</div>
            <h3>${escapeHtml(champion.nickname)}</h3>
            <p>누적 ${champion.totalPoints}점으로 최종 우승했습니다.</p>
            <div class="winner-chip-row">
              <span class="winner-chip">1위 ${champion.roundWins}회</span>
              <span class="winner-chip">2위 ${champion.secondPlaces}회</span>
            </div>
          </div>
          ${renderPodiumCards(ranking, "final")}
        `
    }
    <div class="leaderboard ${compact ? "leaderboard--compact" : ""}">
      ${ranking
        .map(
          (entry) => `
            <div class="leaderboard-row ${entry.rank === 1 && !compact ? "leaderboard-row--winner" : ""}">
              <div class="rank-badge">${entry.rank}위</div>
              <div>
                <div class="player-name">${escapeHtml(entry.nickname)}</div>
                <div class="leader-meta">1위 ${entry.roundWins}회 · 2위 ${entry.secondPlaces}회</div>
              </div>
              <div class="pill ${entry.rank === 1 ? "gold" : "neutral"}">${entry.totalPoints}점</div>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderRoundResultStage(snapshot) {
  const round = getRound(snapshot);
  const room = getRoom(snapshot);
  const isLastRound = room.currentRoundIndex + 1 >= room.roundCount;
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>${escapeHtml(round.title)} 결과</h2>
          <p class="muted">라운드 1위와 누적 상위권을 확인한 뒤 다음 라운드로 넘어갑니다.</p>
        </div>
        <span class="pill accent">ADM-06</span>
      </div>
      ${renderRoundSpotlight(round)}
      ${renderPodiumCards(round.results, "round")}
      ${renderResultsTable(round.results)}
      <div class="admin-actions">
        <button type="button" class="primary" data-action="admin" data-admin-action="advance">${isLastRound ? "최종 결과 공개" : "다음 게임"}</button>
      </div>
    </section>
  `;
}

function renderFinalStage(snapshot) {
  const room = getRoom(snapshot);
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>최종 순위</h2>
          <p class="muted">${room.state === "FINAL_RESULT" ? "누적 총점 기준 우승자와 전체 순위를 발표합니다." : "대회가 종료되었습니다. 같은 방으로 새 대회를 바로 열 수도 있습니다."}</p>
        </div>
        <span class="pill accent">ADM-07</span>
      </div>
      ${renderFinalCeremony(snapshot)}
      <div class="soft-card">
        <h3>운영 자료 내보내기</h3>
        <p class="muted">최종 순위 CSV, 운영 로그 CSV, 라운드별 히스토리가 포함된 리포트 JSON을 저장할 수 있습니다.</p>
        <div class="admin-actions">
          <button type="button" class="secondary" data-action="export" data-export-kind="final-csv">최종 순위 CSV</button>
          <button type="button" class="secondary" data-action="export" data-export-kind="log-csv">운영 로그 CSV</button>
          <button type="button" class="ghost" data-action="export" data-export-kind="report-json">대회 리포트 JSON</button>
        </div>
      </div>
      <div class="admin-actions">
        ${room.state === "FINAL_RESULT" ? '<button type="button" class="secondary" data-action="admin" data-admin-action="advance">대회 종료</button>' : ""}
        <button type="button" class="primary" data-action="admin" data-admin-action="reset-room">같은 방으로 새 대회</button>
      </div>
    </section>
  `;
}

function renderPausedStage(snapshot) {
  const room = getRoom(snapshot);
  const round = getRound(snapshot);
  const pauseInfo = room.pauseInfo;
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>진행 일시정지</h2>
          <p class="muted">${escapeHtml(round?.title || room.name)} · ${getPhaseLabel(pauseInfo?.phase)} 상태에서 멈췄습니다.</p>
        </div>
        <span class="pill accent">ADM-PAUSE</span>
      </div>
      <div class="timeline-card">
        <h3>${pauseInfo?.restartOnResume ? "재개 시 현재 phase가 처음부터 다시 시작됩니다." : "재개하면 현재 상태에서 이어서 진행됩니다."}</h3>
        <p>${pauseInfo?.phase === "MAIN_PLAY" || pauseInfo?.phase === "PRACTICE_PLAY" ? "공정성을 위해 제출이 시작되기 전 단계만 안전하게 일시정지할 수 있습니다." : "운영자가 재개 버튼을 눌러야 다시 진행됩니다."}</p>
      </div>
      <div class="subtle-divider"></div>
      <div class="admin-actions">
        <button type="button" class="primary" data-action="admin" data-admin-action="resume">재개</button>
        <button type="button" class="ghost" data-action="admin" data-admin-action="restart-round">라운드 재시작</button>
      </div>
    </section>
  `;
}

function renderAdminStage(snapshot) {
  const room = getRoom(snapshot);
  switch (room.state) {
    case "WAITING":
      return renderWaitingStage(snapshot);
    case "ROUND_INTRO":
      return renderRoundIntroStage(snapshot);
    case "MAIN_INTRO":
      return renderMainIntroAdminStage(snapshot);
    case "PRACTICE_PLAY":
    case "MAIN_PLAY":
    case "SCORING":
      return renderLiveMonitorStage(snapshot);
    case "PRACTICE_RESULT":
      return renderPracticeResultStage(snapshot);
    case "PAUSED":
      return renderPausedStage(snapshot);
    case "ROUND_RESULT":
      return renderRoundResultStage(snapshot);
    case "FINAL_RESULT":
    case "ENDED":
      return renderFinalStage(snapshot);
    default:
      return `
        <section class="panel">
          <div class="soft-card">
            <h3>진행 상태를 준비 중입니다.</h3>
          </div>
        </section>
      `;
  }
}

function getAdminMobileActions(snapshot) {
  const room = getRoom(snapshot);
  if (!room) {
    return [];
  }

  const isLastRound = room.currentRoundIndex + 1 >= room.roundCount;

  switch (room.state) {
    case "WAITING":
      return [
        { label: "대회 시작", action: "start-tournament", tone: "primary" },
        { label: "게임 재추첨", action: "reroll-games", tone: "secondary" }
      ];
    case "ROUND_INTRO":
      return [
        { label: "연습 시작", action: "start-practice", tone: "primary" },
        { label: "연습 건너뛰기", action: "skip-practice", tone: "secondary" },
        { label: "본게임 시작", action: "start-main", tone: "secondary" }
      ];
    case "PRACTICE_RESULT":
      return [
        { label: "본게임 시작", action: "start-main", tone: "primary" },
        { label: "라운드 재시작", action: "restart-round", tone: "ghost" }
      ];
    case "MAIN_INTRO":
      return [
        { label: "일시정지", action: "pause", tone: "secondary" },
        { label: "라운드 재시작", action: "restart-round", tone: "ghost" }
      ];
    case "PRACTICE_PLAY":
    case "MAIN_PLAY":
      return [
        { label: "일시정지", action: "pause", tone: "secondary" },
        { label: "라운드 재시작", action: "restart-round", tone: "ghost" }
      ];
    case "ROUND_RESULT":
      return [{ label: isLastRound ? "결과 공개" : "다음 게임", action: "advance", tone: "primary" }];
    case "PAUSED":
      return [
        { label: "재개", action: "resume", tone: "primary" },
        { label: "라운드 재시작", action: "restart-round", tone: "ghost" }
      ];
    case "FINAL_RESULT":
      return [
        { label: "대회 종료", action: "advance", tone: "secondary" },
        { label: "다음 게임", action: "reset-room", tone: "primary" }
      ];
    case "ENDED":
      return [{ label: "다음 게임", action: "reset-room", tone: "primary" }];
    default:
      return [];
  }
}

function renderAdminMobileBar(snapshot) {
  const actions = getAdminMobileActions(snapshot);
  if (!actions.length) {
    return "";
  }

  return `
    <section class="admin-mobile-bar">
      <div class="admin-mobile-bar__meta">
        <span class="pill accent">모바일 운영</span>
        <strong>${escapeHtml(ROOM_STATE_LABELS[getRoom(snapshot).state] || "운영 중")}</strong>
      </div>
      <div class="admin-mobile-bar__actions">
        ${actions
          .map(
            (action) => `
              <button type="button" class="${action.tone || "secondary"}" data-action="admin" data-admin-action="${action.action}">
                ${escapeHtml(action.label)}
              </button>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderMyResult(snapshot) {
  const viewer = getViewer(snapshot);
  const round = getRound(snapshot);
  const myRoundResult = round?.results?.find((entry) => entry.playerId === viewer.playerId);
  if (!myRoundResult) {
    return `
      <div class="soft-card">
        <h3>내 결과</h3>
        <p class="muted">아직 공개된 내 라운드 결과가 없습니다.</p>
      </div>
    `;
  }

  return `
    <div class="soft-card">
      <h3>내 결과</h3>
      <p><strong>${myRoundResult.rank}위</strong> · ${myRoundResult.score}점 · 대회 점수 ${myRoundResult.tournamentPoints}점</p>
      <p class="muted">${escapeHtml(myRoundResult.metrics?.label || "")} · ${escapeHtml(myRoundResult.metrics?.summary || "")}</p>
    </div>
  `;
}

function renderPlayerSupportStrip(snapshot) {
  const room = getRoom(snapshot);
  const me = getMe(snapshot);
  return `
    <div class="player-support-strip">
      <div class="support-chip">
        <span>누적 점수</span>
        <strong>${me?.totalPoints ?? 0}점</strong>
      </div>
      <div class="support-chip">
        <span>현재 상태</span>
        <strong>${ROOM_STATE_LABELS[room.state]}</strong>
      </div>
      <div class="support-chip">
        <span>재접속</span>
        <strong>같은 기기에서 기록 복구</strong>
      </div>
    </div>
  `;
}

function renderPlayerStage(snapshot) {
  const room = getRoom(snapshot);
  const round = getRound(snapshot);
  const viewer = getViewer(snapshot);
  const myPlayer = getMe(snapshot);
  const supportStrip = renderPlayerSupportStrip(snapshot);

  switch (room.state) {
    case "WAITING":
      return `
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>대기실 입장 완료</h2>
              <p class="muted">관리자가 시작 버튼을 누르면 현재 접속 인원으로 참가자가 확정됩니다.</p>
            </div>
            <span class="pill teal">USR-02</span>
          </div>
          ${supportStrip}
          ${renderStatsRow(snapshot)}
          <div class="timeline-card">
            <h3>${escapeHtml(getRoom(snapshot).name)}</h3>
            <p>닉네임: <strong>${escapeHtml(myPlayer?.nickname || viewer.nickname || "참가자")}</strong></p>
          </div>
        </section>
      `;
    case "ROUND_INTRO":
      return `
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>${round.roundNumber}라운드 · ${escapeHtml(round.title)}</h2>
              <p class="muted">${escapeHtml(round.description)}</p>
            </div>
            <span class="pill teal">USR-04</span>
          </div>
          ${supportStrip}
          <div class="timeline-card">
            <h3>${escapeHtml(round.intro)}</h3>
            <p>특별상품: <strong>${escapeHtml(round.prize || "설정 없음")}</strong></p>
          </div>
        </section>
      `;
    case "PRACTICE_PLAY":
    case "MAIN_PLAY":
      if (round.mySubmission) {
        return `
          <section class="panel">
            <div class="panel-header">
              <div>
                <h2>${room.state === "PRACTICE_PLAY" ? "연습 제출 완료" : "본게임 제출 완료"}</h2>
                <p class="muted">다른 참가자의 제출을 기다리는 중입니다.</p>
              </div>
              <span class="pill teal">${room.state === "PRACTICE_PLAY" ? "USR-06" : "USR-08"}</span>
            </div>
            ${supportStrip}
            <div class="soft-card">
              <h3>${escapeHtml(round.mySubmission.metrics?.label || "제출됨")}</h3>
              <p>${escapeHtml(round.mySubmission.metrics?.summary || "")}</p>
            </div>
          </section>
        `;
      }
      return `
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>${escapeHtml(round.title)} ${room.state === "PRACTICE_PLAY" ? "연습" : "본게임"}</h2>
              <p class="muted">${escapeHtml(round.description)}</p>
            </div>
            <span class="pill teal">${room.state === "PRACTICE_PLAY" ? "USR-05" : "USR-08"}</span>
          </div>
          ${supportStrip}
          <div id="game-stage-slot"></div>
        </section>
      `;
    case "PRACTICE_RESULT":
      return `
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>연습 결과 확인</h2>
              <p class="muted">연습 점수는 순위에 반영되지 않습니다. 본게임 시작을 기다려 주세요.</p>
            </div>
            <span class="pill teal">USR-06</span>
          </div>
          ${supportStrip}
          <div class="soft-card">
            <h3>${escapeHtml(round.mySubmission?.metrics?.label || "연습 완료")}</h3>
            <p>${escapeHtml(round.mySubmission?.metrics?.summary || "")}</p>
          </div>
        </section>
      `;
    case "MAIN_INTRO":
      return `
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>${escapeHtml(round.title)} 본게임 준비</h2>
              <p class="muted">곧 본게임이 시작됩니다.</p>
            </div>
            <span class="pill teal">USR-07</span>
          </div>
          ${supportStrip}
          <div class="timeline-card">
            <h3>본게임 시작까지</h3>
            <p class="countdown" data-deadline="${round.mainIntroEndsAt}" data-prefix=""></p>
          </div>
        </section>
      `;
    case "PAUSED":
      return `
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>진행이 잠시 멈췄습니다</h2>
              <p class="muted">${getPhaseLabel(room.pauseInfo?.phase)} 상태에서 관리자가 잠시 정지했습니다.</p>
            </div>
            <span class="pill teal">USR-PAUSE</span>
          </div>
          ${supportStrip}
          <div class="timeline-card">
            <h3>${room.pauseInfo?.restartOnResume ? "재개되면 현재 게임이 처음부터 다시 시작됩니다." : "재개되면 바로 이어서 진행됩니다."}</h3>
            <p>화면을 유지한 채 잠시만 기다려 주세요.</p>
          </div>
        </section>
      `;
    case "SCORING":
      return `
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>점수 집계 중</h2>
              <p class="muted">제출 결과를 계산하고 있습니다.</p>
            </div>
            <span class="pill teal">USR-09</span>
          </div>
          ${supportStrip}
          <div class="timeline-card">
            <h3>결과를 곧 공개합니다.</h3>
          </div>
        </section>
      `;
    case "ROUND_RESULT":
      return `
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>${escapeHtml(round.title)} 라운드 결과</h2>
              <p class="muted">이번 라운드의 순위와 내 점수를 확인해보세요.</p>
            </div>
            <span class="pill teal">USR-09</span>
          </div>
          ${supportStrip}
          ${renderRoundSpotlight(round)}
          ${renderMyResult(snapshot)}
          ${renderPodiumCards(round.results, "round")}
          ${renderResultsTable(round.results, viewer.playerId)}
        </section>
      `;
    case "FINAL_RESULT":
    case "ENDED":
      return `
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>최종 결과</h2>
              <p class="muted">대회가 종료되었습니다. 전체 순위를 확인해보세요.</p>
            </div>
            <span class="pill teal">USR-10</span>
          </div>
          ${supportStrip}
          ${renderFinalCeremony(snapshot)}
        </section>
      `;
    default:
      return `
        <section class="panel">
          <div class="soft-card">
            <p class="muted">현재 상태를 준비 중입니다.</p>
          </div>
        </section>
      `;
  }
}

function renderSpectatorStage(snapshot) {
  const room = getRoom(snapshot);
  const round = getRound(snapshot);
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>관전 모드</h2>
          <p class="muted">대회 시작 후 입장했기 때문에 이번 경기 점수에는 포함되지 않습니다.</p>
        </div>
        <span class="pill neutral">USR-03</span>
      </div>
      ${renderStatsRow(snapshot)}
      <div class="timeline-card">
        <h3>${room.state === "PAUSED" ? "진행 일시정지" : round ? `${round.roundNumber}라운드 · ${escapeHtml(round.title)}` : "대기 중"}</h3>
        <p>${
          room.state === "PAUSED"
            ? `${getPhaseLabel(room.pauseInfo?.phase)} 상태에서 잠시 멈췄습니다.`
            : round
              ? escapeHtml(round.description)
              : "다음 대회 시작을 기다려 주세요."
        }</p>
      </div>
      ${
        round?.results
          ? `
            <div class="subtle-divider"></div>
            ${renderResultsTable(round.results)}
          `
          : `
            <div class="soft-card">
              <h3>현재 상태</h3>
              <p class="muted">${ROOM_STATE_LABELS[room.state]}</p>
            </div>
          `
      }
    </section>
  `;
}

function renderGuestRoomStage(snapshot) {
  const room = getRoom(snapshot);
  const round = getRound(snapshot);
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>운영 권한이 다른 기기로 이동했습니다.</h2>
          <p class="muted">이 세션은 현재 읽기 전용 상태입니다. 필요하면 복구 코드로 관리자 권한을 다시 이어받을 수 있습니다.</p>
        </div>
        <span class="pill gold">ADM-RECOVER</span>
      </div>
      ${renderStatsRow(snapshot)}
      <div class="timeline-card">
        <h3>${round ? `${round.roundNumber}라운드 · ${escapeHtml(round.title)}` : escapeHtml(room.name)}</h3>
        <p>${round ? escapeHtml(round.description) : "방은 계속 유지되고 있습니다. 아래에서 복구 코드를 입력하면 관리자 권한을 다시 연결합니다."}</p>
      </div>
      <div class="subtle-divider"></div>
      ${renderAdminRecoveryCard({
        roomCode: room.code,
        title: "이 방의 관리자 권한 다시 연결",
        description: "현재 관리자 화면에 보이는 복구 코드를 입력하면 이 세션이 다시 운영 권한을 가져옵니다."
      })}
    </section>
  `;
}

function renderTopThree(snapshot) {
  const room = getRoom(snapshot);
  if (room.state === "FINAL_RESULT" || room.state === "ENDED") {
    return renderFinalCeremony(snapshot, true);
  }

  const top3 = room.top3 || [];
  if (!top3.length) {
    return `
      <div class="soft-card">
        <h3>누적 Top 3</h3>
        <p class="muted">라운드 결과가 나오면 누적 상위 3명이 표시됩니다.</p>
      </div>
    `;
  }

  return `
    <div class="soft-card">
      <h3>누적 Top 3</h3>
      <div class="leaderboard">
        ${top3
          .map(
            (entry) => `
              <div class="leaderboard-row">
                <div class="rank-badge">${entry.rank}위</div>
                <div>
                  <div class="player-name">${escapeHtml(entry.nickname)}</div>
                  <div class="leader-meta">누적 ${entry.totalPoints}점</div>
                </div>
                <div class="pill gold">${entry.totalPoints}점</div>
              </div>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderFinalRanking(snapshot) {
  return renderFinalCeremony(snapshot, true);
}

function renderPlayersPanel(snapshot) {
  const room = getRoom(snapshot);
  const roster = getRosterGroups(snapshot);
  const pendingPlayers = getPendingPlayers(snapshot);
  const effectiveState = getEffectiveRoomState(snapshot);
  const showPendingSummary = effectiveState === "PRACTICE_PLAY" || effectiveState === "MAIN_PLAY";
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h3>참가자 현황</h3>
          <p class="muted tiny">${room.lockedPlayerCount ? `확정 참가 ${room.lockedPlayerCount}명 · 관전 ${roster.spectators.length}명` : "시작 전 입장자 목록"}</p>
        </div>
      </div>
      ${renderTextChipRow(
        [
          `온라인 참가 ${roster.onlineParticipants.length}`,
          `오프라인 ${roster.offlineParticipants.length}`,
          `관전 ${roster.spectators.length}`,
          showPendingSummary ? `제출 대기 ${pendingPlayers.length}` : null
        ],
        "neutral"
      )}
      ${
        showPendingSummary
          ? `
            <div class="soft-card ops-inline-card">
              <h3>${effectiveState === "PRACTICE_PLAY" ? "연습" : "본게임"} 제출 대기</h3>
              <p>${pendingPlayers.length ? "아직 제출하지 않은 참가자 목록입니다." : "모든 참가자가 제출을 완료했습니다."}</p>
              ${renderNameChipRow(pendingPlayers, "모두 제출 완료", pendingPlayers.length ? "accent" : "teal")}
            </div>
          `
          : ""
      }
      <div class="player-list">
        ${snapshot.players
          .map((player) => {
            const progressBadge = getPlayerProgressBadge(snapshot, player);
            return `
              <div class="player-row ${progressBadge?.pending ? "player-row--pending" : ""}">
                <div>
                  <div class="player-name">${escapeHtml(player.nickname)}</div>
                  <div class="player-meta">${player.connected ? "온라인" : "오프라인"} · ${player.spectator ? "관전" : "참가"}</div>
                </div>
                <div class="pill ${pillClassForPlayer(player)}">${PLAYER_STATE_LABELS[player.state]}</div>
                <div class="player-name">${player.totalPoints}점</div>
                ${
                  room.state === "WAITING" && !player.spectator
                    ? `<button type="button" class="pill neutral" data-action="remove-player" data-player-id="${player.id}">제외</button>`
                    : progressBadge
                      ? `<span class="pill ${progressBadge.tone}">${progressBadge.label}</span>`
                      : `<span class="pill neutral">${player.lastPlacement ? `최근 ${player.lastPlacement}위` : "-"}</span>`
                }
              </div>
            `
          })
          .join("")}
      </div>
    </section>
  `;
}

function renderEventFeed(snapshot) {
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h3>실시간 로그</h3>
        </div>
      </div>
      <div class="event-feed">
        ${snapshot.eventLog
          .slice()
          .reverse()
          .map(
            (entry) => `
              <div class="event-card">
                <p>${escapeHtml(entry.message)}</p>
                <time>${formatDateTime(entry.at)}</time>
              </div>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderSidebar(snapshot) {
  return `
    <div class="app-shell sidebar-shell">
      ${renderPlayersPanel(snapshot)}
      ${renderTopThree(snapshot)}
      ${renderEventFeed(snapshot)}
    </div>
  `;
}

function renderDashboard(snapshot) {
  const viewer = getViewer(snapshot);
  const presentationMode = isPresentationMode(snapshot);
  const presentationBoard = renderPresentationBoard(snapshot);
  const adminOperationsPanel = viewer.role === "admin" && !presentationMode ? renderAdminOperationsPanel(snapshot) : "";
  const mainStage =
    viewer.role === "admin"
      ? renderAdminStage(snapshot)
      : viewer.role === "display"
        ? presentationBoard
          ? ""
          : renderDisplayFallback(snapshot)
      : viewer.role === "guest"
        ? renderGuestRoomStage(snapshot)
      : viewer.role === "spectator"
        ? renderSpectatorStage(snapshot)
        : renderPlayerStage(snapshot);

  return `
    ${renderBanner()}
    <div class="dashboard-grid ${presentationMode ? "dashboard-grid--focus" : ""}">
      <div class="app-shell">
        ${viewer.role === "admin" ? renderAdminToolbar(snapshot) : ""}
        ${presentationBoard}
        ${adminOperationsPanel}
        ${mainStage}
      </div>
      ${renderSidebar(snapshot)}
    </div>
    ${viewer.role === "admin" && !presentationMode ? renderAdminMobileBar(snapshot) : ""}
  `;
}

function mountInteractiveGame(snapshot, preservedNode = null) {
  const slot = document.querySelector("#game-stage-slot");
  if (!slot) {
    destroyActiveController();
    return;
  }

  if (preservedNode && store.activeController) {
    slot.append(preservedNode);
    return;
  }

  const room = getRoom(snapshot);
  const round = getRound(snapshot);
  const mode = room.state === "PRACTICE_PLAY" ? "practice" : "main";
  const interactiveKey = getInteractiveKey(snapshot);
  if (!interactiveKey) {
    return;
  }

  const controller = mountGameController(slot, {
    round,
    mode,
    onSubmit: async (payload) => {
      await postJson("/api/player/submit", {
        clientId: store.clientId,
        mode,
        ...payload
      });
    }
  });

  store.activeController = controller;
  store.activeGameNode = controller.root;
  store.activeInteractiveKey = interactiveKey;
}

function render() {
  let preservedNode = null;
  const nextInteractiveKey = getInteractiveKey(store.snapshot);

  if (store.activeController && nextInteractiveKey === store.activeInteractiveKey && store.activeGameNode) {
    preservedNode = store.activeGameNode;
    preservedNode.remove();
  } else {
    destroyActiveController();
  }

  if (!store.snapshot?.room) {
    app.innerHTML = renderLanding();
    renderCountdowns();
    return;
  }

  app.innerHTML = renderDashboard(store.snapshot);
  mountInteractiveGame(store.snapshot, preservedNode);
  renderCountdowns();
}

function buildCreateRoomIntent() {
  return {
    type: "create-room",
    view: "create",
    name: store.createRoomName.trim() || "회식 미니게임",
    roundCount: store.createRoundCount,
    prizes: Array.from({ length: store.createRoundCount }, (_, index) => store.createPrizesText.split("\n")[index]?.trim() || "")
  };
}

function buildJoinIntent() {
  return {
    type: "join-room",
    view: "join",
    roomCode: store.prefilledRoomCode.trim().toUpperCase(),
    nickname: store.joinNickname.trim()
  };
}

function buildRecoverIntent(roomCode = store.prefilledRoomCode, recoveryCode = store.recoveryCode) {
  return {
    type: "recover-admin",
    view: "create",
    roomCode: String(roomCode || "").trim().toUpperCase(),
    recoveryCode: String(recoveryCode || "").trim().toUpperCase()
  };
}

function buildTestModeIntent() {
  return {
    type: "test-room",
    view: "test",
    name: "테스트 모드",
    roundCount: 5,
    prizes: Array.from({ length: 5 }, (_, index) => `테스트 ${index + 1}R`)
  };
}

function getIntentLoadingState(intent) {
  switch (intent.type) {
    case "create-room":
      return {
        title: "방을 생성하고 있습니다",
        message: "관리자 세션과 대기실을 준비하는 중입니다."
      };
    case "join-room":
      return {
        title: "참가자 입장을 준비하고 있습니다",
        message: "방 연결과 세션 확인을 진행하는 중입니다."
      };
    case "recover-admin":
      return {
        title: "관리자 권한을 복구하고 있습니다",
        message: "복구 코드 확인 후 운영 화면으로 다시 연결합니다."
      };
    case "test-room":
      return {
        title: "테스트 방을 준비하고 있습니다",
        message: "빠른 확인용 관리자 세션과 대기실을 만드는 중입니다."
      };
    default:
      return {
        title: "작업을 처리하고 있습니다",
        message: "잠시만 기다려 주세요."
      };
  }
}

function getIntentErrorTitle(intent) {
  switch (intent.type) {
    case "create-room":
    case "test-room":
      return "방 생성에 실패했습니다";
    case "join-room":
      return "참가자 입장에 실패했습니다";
    case "recover-admin":
      return "관리자 권한 복구에 실패했습니다";
    default:
      return "작업 처리에 실패했습니다";
  }
}

async function syncAfterRoomMutation(roomCode) {
  await refreshSession();
  if (!store.stream && store.clientId) {
    connectStream();
  }
  await refreshCurrentState().catch(() => {});
  await refreshRoomDirectory().catch(() => {});
  await refreshArchiveList().catch(() => {});
  updateRoomQuery(roomCode || store.session?.roomCode || "");
}

async function executeIntent(requestId, intent) {
  switch (intent.type) {
    case "create-room": {
      const result = await postJson("/api/admin/room", {
        clientId: store.clientId,
        name: intent.name,
        roundCount: intent.roundCount,
        prizes: intent.prizes
      });
      if (!isActionCurrent(requestId)) {
        return;
      }
      await syncAfterRoomMutation(result.roomCode);
      if (!isActionCurrent(requestId)) {
        return;
      }
      setBanner("success", `방 ${result.roomCode} 생성 완료`);
      return;
    }
    case "join-room": {
      if (!intent.roomCode || !intent.nickname) {
        throw new Error("방 코드와 닉네임을 입력해 주세요.");
      }
      await postJson("/api/join", {
        clientId: store.clientId,
        roomCode: intent.roomCode,
        nickname: intent.nickname
      });
      if (!isActionCurrent(requestId)) {
        return;
      }
      await syncAfterRoomMutation(intent.roomCode);
      if (!isActionCurrent(requestId)) {
        return;
      }
      setBanner("success", `${intent.roomCode} 방에 입장했습니다.`);
      return;
    }
    case "recover-admin": {
      if (!intent.roomCode || !intent.recoveryCode) {
        throw new Error("방 코드와 관리자 복구 코드를 입력해 주세요.");
      }
      await postJson("/api/admin/recover", {
        clientId: store.clientId,
        roomCode: intent.roomCode,
        recoveryCode: intent.recoveryCode
      });
      if (!isActionCurrent(requestId)) {
        return;
      }
      await syncAfterRoomMutation(intent.roomCode);
      if (!isActionCurrent(requestId)) {
        return;
      }
      setBanner("success", `${intent.roomCode} 방 관리자 권한을 복구했습니다.`);
      return;
    }
    case "test-room": {
      const result = await postJson("/api/admin/room", {
        clientId: store.clientId,
        name: intent.name,
        roundCount: intent.roundCount,
        prizes: intent.prizes
      });
      if (!isActionCurrent(requestId)) {
        return;
      }
      await syncAfterRoomMutation(result.roomCode);
      if (!isActionCurrent(requestId)) {
        return;
      }
      setBanner("success", `테스트 방 ${result.roomCode} 생성 완료`);
      return;
    }
    default:
      throw new Error("지원하지 않는 요청입니다.");
  }
}

async function runIntent(intent) {
  store.entryView = intent.view || store.entryView;
  clearBanner();
  const loadingState = getIntentLoadingState(intent);
  const requestId = startActionState(intent, loadingState.title, loadingState.message);

  try {
    await ensureSession();
  } catch (error) {
    setActionError(
      requestId,
      intent,
      "세션 생성에 실패했습니다",
      error instanceof Error ? error.message : "다시 시도해 주세요."
    );
    return;
  }

  if (!isActionCurrent(requestId)) {
    return;
  }

  try {
    await executeIntent(requestId, intent);
    if (!isActionCurrent(requestId)) {
      return;
    }
    clearActionState();
    render();
  } catch (error) {
    setActionError(
      requestId,
      intent,
      getIntentErrorTitle(intent),
      error instanceof Error ? error.message : "다시 시도해 주세요."
    );
  }
}

async function runInlineIntent(intent) {
  try {
    await ensureSession();
    await executeIntent("__inline__", intent);
  } catch (error) {
    setBanner("error", error instanceof Error ? error.message : "작업 중 오류가 발생했습니다.");
  }
}

async function handleArchiveSearch(form) {
  const query = form.querySelector("[name='query']")?.value?.trim() || "";
  await refreshArchiveList(query);
  render();
  setBanner("success", query ? `아카이브 검색 완료: ${query}` : "전체 아카이브 목록을 불러왔습니다.");
}

function focusField(selector) {
  window.setTimeout(() => {
    document.querySelector(selector)?.focus();
  }, 0);
}

async function handleAdminAction(action, button) {
  await postJson("/api/admin/action", {
    clientId: store.clientId,
    action,
    roundIndex: button?.dataset.roundIndex ? Number(button.dataset.roundIndex) : undefined,
    playerId: button?.dataset.playerId,
    prize:
      action === "update-prize" && button?.dataset.roundIndex
        ? document.querySelector(`#prize-input-${Number(button.dataset.roundIndex) + 1}`)?.value?.trim() || ""
        : undefined
  });

  if (action === "reset-room") {
    await refreshArchiveList().catch(() => {});
    setBanner("success", "같은 방으로 새 대회를 다시 열었습니다.");
  }
}

app.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    if (form.id === "create-room-form") {
      store.createRoomName = form.querySelector("[name='name']").value;
      store.createPrizesText = form.querySelector("[name='prizes']").value;
      await runIntent(buildCreateRoomIntent());
    } else if (form.id === "join-room-form") {
      store.prefilledRoomCode = form.querySelector("[name='roomCode']").value.trim().toUpperCase();
      store.joinNickname = form.querySelector("[name='nickname']").value;
      await runIntent(buildJoinIntent());
    } else if (form.id === "recover-admin-form") {
      store.prefilledRoomCode = form.querySelector("[name='roomCode']").value.trim().toUpperCase();
      store.recoveryCode = form.querySelector("[name='recoveryCode']").value.trim().toUpperCase();
      const intent = buildRecoverIntent();
      if (store.snapshot?.room) {
        await runInlineIntent(intent);
      } else {
        await runIntent(intent);
      }
    } else if (form.id === "archive-search-form") {
      await handleArchiveSearch(form);
    }
  } catch (error) {
    setBanner("error", error instanceof Error ? error.message : "요청 처리 중 오류가 발생했습니다.");
  }
});

app.addEventListener("input", (event) => {
  const field = event.target;
  if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLTextAreaElement)) {
    return;
  }

  if (field.id === "room-name") {
    store.createRoomName = field.value;
  } else if (field.id === "room-prizes") {
    store.createPrizesText = field.value;
  } else if (field.id === "join-room-code" || field.id === "recover-room-code") {
    store.prefilledRoomCode = field.value.trim().toUpperCase();
    field.value = store.prefilledRoomCode;
  } else if (field.id === "join-nickname") {
    store.joinNickname = field.value;
  } else if (field.id === "recover-admin-code") {
    store.recoveryCode = field.value.trim().toUpperCase();
    field.value = store.recoveryCode;
  }
});

app.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) {
    return;
  }

  try {
    const action = button.dataset.action;

    if (action === "open-entry") {
      clearActionState();
      store.entryView = button.dataset.entryView || "home";
      render();
      if (store.entryView === "create") {
        focusField("#room-name");
      } else if (store.entryView === "join") {
        focusField(store.prefilledRoomCode ? "#join-nickname" : "#join-room-code");
      }
      return;
    }

    if (action === "go-home") {
      clearActionState();
      store.entryView = "home";
      render();
      return;
    }

    if (action === "retry-intent") {
      if (store.actionState?.intent) {
        await runIntent(store.actionState.intent);
      }
      return;
    }

    if (action === "start-test-mode") {
      await runIntent(buildTestModeIntent());
      return;
    }

    if (action === "set-round-count") {
      const nextRoundCount = Number(button.dataset.roundCount);
      store.createPrizesText = resizePrizeDraft(store.createPrizesText || buildDefaultPrizeText(store.createRoundCount), nextRoundCount);
      store.createRoundCount = nextRoundCount;
      render();
      return;
    }

    if (action === "toggle-presentation") {
      store.presentationMode = !store.presentationMode;
      localStorage.setItem(presentationStorageKey, store.presentationMode ? "1" : "0");
      render();
      return;
    }

    if (action === "prefill-room") {
      const roomCode = String(button.dataset.roomCode || "").trim().toUpperCase();
      store.prefilledRoomCode = roomCode;
      store.entryView = "join";
      clearActionState();
      updateRoomQuery(roomCode);
      render();
      focusField("#join-nickname");
      setBanner("success", `${roomCode} 방 코드를 입장 폼에 채웠습니다.`);
      return;
    }

    if (action === "prepare-recovery") {
      const roomCode = String(button.dataset.roomCode || "").trim().toUpperCase();
      store.prefilledRoomCode = roomCode;
      store.entryView = "create";
      clearActionState();
      updateRoomQuery(roomCode);
      render();
      focusField("#recover-admin-code");
      setBanner("success", `${roomCode} 방 복구 폼을 준비했습니다.`);
      return;
    }

    if (action === "open-display") {
      const roomCode = String(button.dataset.roomCode || "").trim().toUpperCase();
      window.location.href = `/?room=${encodeURIComponent(roomCode)}&display=1`;
      return;
    }

    if (action === "refresh-room-directory") {
      await refreshRoomDirectory();
      render();
      setBanner("success", "진행 중인 방 목록을 새로고침했습니다.");
      return;
    }

    if (action === "refresh-archives") {
      await refreshArchiveList();
      render();
      setBanner("success", "종료 대회 기록을 새로고침했습니다.");
      return;
    }

    if (action === "clear-recent-rooms") {
      store.recentRooms = [];
      saveRecentRooms();
      render();
      setBanner("success", "최근 접속 방 기록을 비웠습니다.");
      return;
    }

    if (action === "clear-archive-search") {
      store.archiveQuery = "";
      await refreshArchiveList("");
      render();
      focusField("#archive-search-input");
      setBanner("success", "아카이브 검색어를 초기화했습니다.");
      return;
    }

    if (action === "download-archive-report") {
      await downloadArchiveReport(button.dataset.archiveId);
      return;
    }

    if (action === "copy-link" || action === "copy-value") {
      const target = button.dataset.copyTarget ? document.querySelector(`#${button.dataset.copyTarget}`) : null;
      const value = button.dataset.copyValue || target?.value || "";
      await navigator.clipboard.writeText(value);
      setBanner("success", button.dataset.copyMessage || "링크를 복사했습니다.");
      return;
    }

    if (action === "export") {
      await handleExportAction(button.dataset.exportKind);
      return;
    }

    if (action === "admin") {
      const confirmationMessage = getAdminConfirmationMessage(button.dataset.adminAction, button);
      if (confirmationMessage && !window.confirm(confirmationMessage)) {
        return;
      }
      await handleAdminAction(button.dataset.adminAction, button);
      return;
    }

    if (action === "save-prize") {
      await postJson("/api/admin/action", {
        clientId: store.clientId,
        action: "update-prize",
        roundIndex: Number(button.dataset.roundIndex),
        prize: document.querySelector(`#prize-input-${Number(button.dataset.roundIndex) + 1}`)?.value?.trim() || ""
      });
      setBanner("success", "특별상품을 저장했습니다.");
      return;
    }

    if (action === "remove-player") {
      const confirmationMessage = getAdminConfirmationMessage("remove-player", button);
      if (confirmationMessage && !window.confirm(confirmationMessage)) {
        return;
      }
      await postJson("/api/admin/action", {
        clientId: store.clientId,
        action: "remove-player",
        playerId: button.dataset.playerId
      });
      return;
    }
  } catch (error) {
    setBanner("error", error instanceof Error ? error.message : "작업 중 오류가 발생했습니다.");
  }
});

async function attemptAutoRecovery() {
  try {
    await ensureSession({ timeoutMs: 1000 });
    await refreshRoomDirectory().catch(() => {});
    await refreshArchiveList().catch(() => {});
    if (store.session?.roomCode) {
      await refreshCurrentState().catch(() => {});
    }
  } catch (error) {
    if (error instanceof Error && error.name !== "AbortError" && store.displayMode) {
      setBanner("error", error.message || "발표 화면 연결에 실패했습니다.");
    }
  } finally {
    render();
  }
}

async function init() {
  const existingClientId = localStorage.getItem(storageKey);
  store.clientId = existingClientId || crypto.randomUUID();
  localStorage.setItem(storageKey, store.clientId);
  store.presentationMode = localStorage.getItem(presentationStorageKey) === "1";
  store.recentRooms = loadRecentRooms();
  store.createPrizesText = resizePrizeDraft(store.createPrizesText, store.createRoundCount);

  render();
  startClockTicker();

  void refreshRoomDirectory().then(render).catch(() => {});
  void refreshArchiveList().then(render).catch(() => {});

  if (store.displayMode || existingClientId) {
    void attemptAutoRecovery();
  }
}

init();
