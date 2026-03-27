const PHASE_LABELS = {
  lobby: "대기실",
  intro: "게임 안내",
  practice: "연습",
  main: "본게임",
  result: "라운드 결과",
  final: "최종 결과"
};

const app = document.querySelector("#app");

const store = {
  session: null,
  snapshot: createHomeSnapshot(),
  serverOffsetMs: 0,
  error: "",
  info: "",
  homeNickname: "",
  shouldFocusNickname: false,
  shouldSelectNickname: false,
  busy: false,
  fetchInFlight: false,
  pollTimer: null,
  renderTimer: null,
  runtime: null
};

function createHomeSnapshot(overrides = {}) {
  return {
    phase: "lobby",
    joinOpen: true,
    canStart: false,
    playerCount: 0,
    players: [],
    me: null,
    round: null,
    roundResults: [],
    leaderboard: [],
    finalRanking: [],
    history: [],
    notice: "닉네임만 입력하면 바로 대기실에 입장합니다.",
    ...overrides
  };
}

function enterHome(message = "") {
  store.session = null;
  store.snapshot = createHomeSnapshot();
  store.serverOffsetMs = 0;
  store.runtime = null;
  store.busy = false;
  stopPolling();
  store.info = "";
  store.error = message;
  store.shouldFocusNickname = true;
  render();
}

function setError(message) {
  store.error = message;
  render();
}

function setInfo(message) {
  store.info = message;
  render();
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "요청 처리 중 오류가 발생했습니다.");
  }
  return payload;
}

function syncedNow() {
  return Date.now() + store.serverOffsetMs;
}

function getRemainingMs() {
  if (!store.snapshot?.round?.phaseEndsAt) {
    return 0;
  }
  return Math.max(0, store.snapshot.round.phaseEndsAt - syncedNow());
}

function formatCountdown(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minute = Math.floor(seconds / 60);
  const second = seconds % 60;
  return minute ? `${minute}:${String(second).padStart(2, "0")}` : `${second}s`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shouldAnimateView() {
  const phase = store.snapshot?.phase;
  return Boolean(store.snapshot?.me && ["intro", "practice", "main", "result"].includes(phase));
}

function focusNicknameInput(selection = null) {
  const input = document.querySelector("#nickname");
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  input.focus();
  if (selection && Number.isInteger(selection.start) && Number.isInteger(selection.end)) {
    input.setSelectionRange(selection.start, selection.end);
  } else if (store.shouldSelectNickname) {
    input.select();
  }
  store.shouldFocusNickname = false;
  store.shouldSelectNickname = false;
}

function createRng(seedInput) {
  let seed = 2166136261;
  const text = String(seedInput || "seed");
  for (let index = 0; index < text.length; index += 1) {
    seed ^= text.charCodeAt(index);
    seed = Math.imul(seed, 16777619);
  }
  return () => {
    seed += 0x6d2b79f5;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function buildGoStopSequence(seed, durationMs) {
  const rng = createRng(seed);
  const cueDuration = Math.max(500, Math.floor(durationMs / 7));
  const sequence = [];
  let goCount = 0;
  for (let index = 0; index < 7; index += 1) {
    let kind = rng() > 0.38 ? "GO" : "STOP";
    if (index >= 5 && goCount < 2) {
      kind = "GO";
    }
    if (kind === "GO") {
      goCount += 1;
    }
    sequence.push({
      index,
      kind,
      startOffset: index * cueDuration,
      endOffset: (index + 1) * cueDuration
    });
  }
  return sequence;
}

function buildNumberQuestions(seed) {
  const rng = createRng(seed);
  return Array.from({ length: 3 }, () => {
    const values = [];
    while (values.length < 9) {
      const value = 10 + Math.floor(rng() * 90);
      if (!values.includes(value)) {
        values.push(value);
      }
    }
    const target = Math.max(...values);
    return {
      target,
      cells: values.map((value) => ({
        value,
        isTarget: value === target
      }))
    };
  });
}

function createRuntime(snapshot) {
  if (!snapshot?.round || !["practice", "main"].includes(snapshot.phase)) {
    return null;
  }

  const phaseDuration = snapshot.phase === "practice" ? snapshot.round.practiceMs : snapshot.round.mainMs;
  const key = `${snapshot.round.id}:${snapshot.phase}:${snapshot.round.number}:${snapshot.round.seed}`;
  const rng = createRng(`${snapshot.round.seed}:${snapshot.phase}`);

  switch (snapshot.round.id) {
    case "color-snap": {
      const colors = ["#2563eb", "#0f766e", "#dc2626", "#9333ea", "#ea580c"];
      const revealDelay = Math.min(phaseDuration - 900, 900 + Math.floor(rng() * Math.max(900, phaseDuration - 1800)));
      return {
        key,
        gameId: snapshot.round.id,
        submitted: false,
        submitting: false,
        revealAt: snapshot.round.phaseStartedAt + revealDelay,
        targetColor: colors[Math.floor(rng() * colors.length)]
      };
    }
    case "go-stop":
      return {
        key,
        gameId: snapshot.round.id,
        submitted: false,
        submitting: false,
        sequence: buildGoStopSequence(`${snapshot.round.seed}:${snapshot.phase}`, phaseDuration),
        handledCueIndices: new Set(),
        falseTaps: 0,
        reactionTimes: []
      };
    case "number-hunter":
      return {
        key,
        gameId: snapshot.round.id,
        submitted: false,
        submitting: false,
        questions: buildNumberQuestions(`${snapshot.round.seed}:${snapshot.phase}`),
        currentIndex: 0,
        attempts: [],
        questionStartedAt: snapshot.round.phaseStartedAt
      };
    case "ten-seconds":
      return {
        key,
        gameId: snapshot.round.id,
        submitted: false,
        submitting: false
      };
    case "gauge-stop":
      return {
        key,
        gameId: snapshot.round.id,
        submitted: false,
        submitting: false,
        targetStart: 0.38 + rng() * 0.18,
        targetWidth: 0.2,
        speed: 0.0017 + rng() * 0.0006
      };
    default:
      return null;
  }
}

function ensureRuntime() {
  const snapshot = store.snapshot;
  if (!snapshot?.round || !["practice", "main"].includes(snapshot.phase)) {
    store.runtime = null;
    return;
  }

  const key = `${snapshot.round.id}:${snapshot.phase}:${snapshot.round.number}:${snapshot.round.seed}`;
  if (!store.runtime || store.runtime.key !== key) {
    store.runtime = createRuntime(snapshot);
  }

  if (!store.runtime) {
    return;
  }

  if (snapshot.phase === "practice" && snapshot.me?.submittedPractice) {
    store.runtime.submitted = true;
  }

  if (snapshot.phase === "main" && snapshot.me?.submittedMain) {
    store.runtime.submitted = true;
  }
}

function getCurrentCue(runtime) {
  const elapsed = syncedNow() - store.snapshot.round.phaseStartedAt;
  return runtime.sequence.find((cue) => elapsed >= cue.startOffset && elapsed < cue.endOffset) || null;
}

function getGaugePosition(runtime) {
  const elapsed = Math.max(0, syncedNow() - store.snapshot.round.phaseStartedAt);
  const cycle = (elapsed * runtime.speed) % 2;
  return cycle <= 1 ? cycle : 2 - cycle;
}

async function fetchState() {
  if (store.fetchInFlight || !store.session?.playerId) {
    return;
  }

  store.fetchInFlight = true;
  try {
    const snapshot = await requestJson(`/api/state?playerId=${encodeURIComponent(store.session.playerId)}`);
    store.snapshot = snapshot;
    store.serverOffsetMs = snapshot.serverNow - Date.now();

    if (!snapshot.me) {
      enterHome("상태를 불러오지 못했습니다. 다시 시도해 주세요.");
      return;
    }

    ensureRuntime();
    render();
  } catch (error) {
    setError(error instanceof Error ? error.message : "상태 동기화에 실패했습니다. 잠시 후 다시 시도해 주세요.");
  } finally {
    store.fetchInFlight = false;
  }
}

async function joinLobby(nickname) {
  store.busy = true;
  store.error = "";
  render();
  try {
    const payload = await requestJson("/api/join", {
      method: "POST",
      body: JSON.stringify({ nickname })
    });
    store.session = {
      playerId: payload.playerId,
      nickname: payload.nickname
    };
    store.snapshot = payload.state;
    store.serverOffsetMs = payload.state.serverNow - Date.now();
    store.info = `${payload.nickname}님으로 입장했습니다.`;
    ensureRuntime();
    startPolling();
    render();
  } catch (error) {
    enterHome(error instanceof Error ? error.message : "입장에 실패했습니다. 다시 시도해 주세요.");
  } finally {
    store.busy = false;
    render();
  }
}

async function startGame() {
  if (!store.session?.playerId) {
    return;
  }
  store.busy = true;
  render();
  try {
    const snapshot = await requestJson("/api/start", {
      method: "POST",
      body: JSON.stringify({ playerId: store.session.playerId })
    });
    store.snapshot = snapshot;
    store.serverOffsetMs = snapshot.serverNow - Date.now();
    store.info = "게임이 시작되었습니다.";
    ensureRuntime();
    render();
  } catch (error) {
    enterHome(error instanceof Error ? error.message : "상태를 불러오지 못했습니다. 다시 시도해 주세요.");
  } finally {
    store.busy = false;
    render();
  }
}

async function resetGame() {
  if (!store.session?.playerId) {
    return;
  }
  store.busy = true;
  render();
  try {
    const snapshot = await requestJson("/api/reset", {
      method: "POST",
      body: JSON.stringify({ playerId: store.session.playerId })
    });
    store.snapshot = snapshot;
    store.serverOffsetMs = snapshot.serverNow - Date.now();
    store.info = "새 게임을 시작할 수 있도록 초기화했습니다.";
    ensureRuntime();
    render();
  } catch (error) {
    enterHome(error instanceof Error ? error.message : "상태를 불러오지 못했습니다. 다시 시도해 주세요.");
  } finally {
    store.busy = false;
    render();
  }
}

async function submitGameScore(score, details) {
  const runtime = store.runtime;
  if (!runtime || runtime.submitted || runtime.submitting || !store.session?.playerId || !store.snapshot?.round) {
    return;
  }

  const expectedPhase = store.snapshot.phase;
  const expectedRoundNumber = store.snapshot.round.number;

  runtime.submitted = true;
  runtime.submitting = true;
  runtime.lastSubmission = {
    score,
    details
  };
  render();

  try {
    const snapshot = await requestJson("/api/submit", {
      method: "POST",
      body: JSON.stringify({
        playerId: store.session.playerId,
        roundNumber: store.snapshot.round.number,
        mode: store.snapshot.phase,
        score,
        details
      })
    });
    store.snapshot = snapshot;
    store.serverOffsetMs = snapshot.serverNow - Date.now();
    ensureRuntime();
    render();
  } catch (error) {
    runtime.submitted = false;
    runtime.submitting = false;
    await fetchState();
    if (store.snapshot?.phase !== expectedPhase || store.snapshot?.round?.number !== expectedRoundNumber) {
      return;
    }
    setError(error instanceof Error ? error.message : "점수 제출에 실패했습니다.");
  }
}

function maybeAutoSubmit() {
  if (!store.runtime || store.runtime.submitted || !["practice", "main"].includes(store.snapshot?.phase || "")) {
    return;
  }
  if (getRemainingMs() > 0) {
    return;
  }

  switch (store.runtime.gameId) {
    case "color-snap":
      submitGameScore(0, {
        label: "시간 종료",
        summary: "목표 색상을 누르지 못했습니다."
      });
      break;
    case "go-stop": {
      const goCount = store.runtime.sequence.filter((cue) => cue.kind === "GO").length;
      const correctCount = store.runtime.reactionTimes.length;
      const missed = Math.max(0, goCount - correctCount);
      const score = Math.max(0, correctCount * 220 - store.runtime.falseTaps * 140 - missed * 90);
      submitGameScore(score, {
        label: `${correctCount}회 정답`,
        summary: `미스 ${missed}회 · 오탭 ${store.runtime.falseTaps}회`
      });
      break;
    }
    case "number-hunter": {
      const correctCount = store.runtime.attempts.filter((attempt) => attempt.correct).length;
      submitGameScore(correctCount * 280, {
        label: `${correctCount}/3 정답`,
        summary: "시간 종료로 현재 결과를 제출했습니다."
      });
      break;
    }
    case "ten-seconds":
      submitGameScore(0, {
        label: "시간 종료",
        summary: "STOP 버튼을 누르지 못했습니다."
      });
      break;
    case "gauge-stop":
      submitGameScore(0, {
        label: "시간 종료",
        summary: "게이지를 멈추지 못했습니다."
      });
      break;
    default:
      break;
  }
}

function renderBanner() {
  const banners = [];
  if (store.error) {
    banners.push(`<div class="banner error">${escapeHtml(store.error)}</div>`);
  }
  if (store.info) {
    banners.push(`<div class="banner info">${escapeHtml(store.info)}</div>`);
  }
  return banners.join("");
}

function renderStatusGrid(snapshot) {
  const me = snapshot.me;
  const round = snapshot.round;
  const leaderboard = snapshot.leaderboard || [];
  return `
    <div class="status-grid">
      <div class="stat-card">
        <span class="stat-label">현재 상태</span>
        <div class="stat-value">${PHASE_LABELS[snapshot.phase]}</div>
      </div>
      <div class="stat-card">
        <span class="stat-label">참가 인원</span>
        <div class="stat-value">${snapshot.playerCount}명</div>
      </div>
      <div class="stat-card">
        <span class="stat-label">내 닉네임</span>
        <div class="stat-value">${escapeHtml(me?.nickname || "-")}</div>
      </div>
      <div class="stat-card">
        <span class="stat-label">내 누적 점수</span>
        <div class="stat-value">${me?.totalPoints || 0}점</div>
      </div>
      <div class="stat-card">
        <span class="stat-label">현재 게임</span>
        <div class="stat-value">${round ? `${round.number}/${round.total}` : "-"}</div>
      </div>
      <div class="stat-card">
        <span class="stat-label">게임 제목</span>
        <div class="stat-value">${escapeHtml(round?.title || "-")}</div>
      </div>
      <div class="stat-card">
        <span class="stat-label">현재 1위</span>
        <div class="stat-value">${escapeHtml(leaderboard[0]?.nickname || "-")}</div>
      </div>
      <div class="stat-card">
        <span class="stat-label">남은 시간</span>
        <div class="stat-value">${round?.phaseEndsAt ? formatCountdown(getRemainingMs()) : "-"}</div>
      </div>
    </div>
  `;
}

function renderLeaderboard(leaders, title = "누적 Top 3") {
  const top = (leaders || []).slice(0, 3);
  if (!top.length) {
    return `
      <section class="panel">
        <h3>${title}</h3>
        <p class="muted">아직 집계된 점수가 없습니다.</p>
      </section>
    `;
  }

  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h3>${title}</h3>
          <p class="muted">라운드별 순위 점수가 누적됩니다.</p>
        </div>
      </div>
      <div class="leaderboard-list">
        ${top
          .map(
            (entry) => `
              <div class="leaderboard-row">
                <div>
                  <div class="leaderboard-name">${entry.rank}위 · ${escapeHtml(entry.nickname)}</div>
                  <div class="muted small">누적 ${entry.totalPoints}점</div>
                </div>
                <span class="pill ${entry.rank === 1 ? "gold" : "primary"}">${entry.totalPoints}점</span>
              </div>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderHome(snapshot) {
  const joinDisabled = !snapshot.joinOpen;
  return `
    <div class="screen">
      ${renderBanner()}
      <section class="hero-card">
        <span class="eyebrow">Realtime Minigame</span>
        <h1>회식용 실시간 미니게임</h1>
        <p>같은 URL로 접속해서 닉네임만 입력하면 바로 참가할 수 있는 가벼운 5종 미니게임 앱입니다.</p>
      </section>
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>닉네임 입력</h2>
            <p class="muted">${escapeHtml(snapshot.notice)}</p>
          </div>
          <span class="pill primary">${PHASE_LABELS[snapshot.phase]}</span>
        </div>
        <form id="join-form" class="field-stack">
          <div class="field">
            <label for="nickname">닉네임</label>
            <input id="nickname" name="nickname" maxlength="18" placeholder="예: 김대리" value="${escapeHtml(store.homeNickname)}" ${joinDisabled ? "disabled" : ""} />
          </div>
          <div class="button-row">
            <button type="submit" class="primary" ${joinDisabled || store.busy ? "disabled" : ""}>입장하기</button>
          </div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-header">
          <div>
            <h3>${snapshot.joinOpen ? "현재 대기실" : "현재 진행 상태"}</h3>
            <p class="muted">${snapshot.joinOpen ? "2명 이상 모이면 누구나 게임을 시작할 수 있습니다." : "게임 진행 중에는 새 입장이 잠시 닫힙니다."}</p>
          </div>
        </div>
        <div class="status-grid">
          <div class="stat-card">
            <span class="stat-label">참가 인원</span>
            <div class="stat-value">${snapshot.playerCount}명</div>
          </div>
          <div class="stat-card">
            <span class="stat-label">진행 상태</span>
            <div class="stat-value">${PHASE_LABELS[snapshot.phase]}</div>
          </div>
          <div class="stat-card">
            <span class="stat-label">현재 게임</span>
            <div class="stat-value">${escapeHtml(snapshot.round?.title || "-")}</div>
          </div>
          <div class="stat-card">
            <span class="stat-label">최고 점수자</span>
            <div class="stat-value">${escapeHtml(snapshot.leaderboard?.[0]?.nickname || "-")}</div>
          </div>
        </div>
        <div class="player-list">
          ${(snapshot.players || []).length
            ? snapshot.players
                .map(
                  (player) => `
                    <div class="player-row">
                      <div>
                        <div class="player-name">${escapeHtml(player.nickname)}</div>
                      </div>
                      <span class="pill primary">${player.totalPoints || 0}점</span>
                    </div>
                  `
                )
                .join("")
            : `<div class="card"><p class="muted">아직 참가자가 없습니다.</p></div>`}
        </div>
      </section>
      ${snapshot.phase === "final" ? renderLeaderboard(snapshot.finalRanking, "마지막 최종 순위") : ""}
    </div>
  `;
}

function renderLobby(snapshot) {
  return `
    <div class="screen">
      ${renderBanner()}
      <section class="hero-card">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Lobby</span>
            <h1>대기실</h1>
            <p>${escapeHtml(snapshot.me.nickname)}님이 입장했습니다. 2명 이상이면 누구나 바로 시작할 수 있습니다.</p>
          </div>
          <span class="pill primary">${snapshot.playerCount}명 참가</span>
        </div>
        <div class="button-row">
          <button type="button" class="primary" data-action="start-game" ${!snapshot.canStart || store.busy ? "disabled" : ""}>게임 시작</button>
        </div>
      </section>
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>참가자 목록</h2>
            <p class="muted">첫 클릭 한 번만 유효하게 시작됩니다.</p>
          </div>
        </div>
        <div class="player-list">
          ${snapshot.players
            .map(
              (player) => `
                <div class="player-row">
                  <div>
                    <div class="player-name">${escapeHtml(player.nickname)}</div>
                    <div class="muted small">${player.id === snapshot.me.id ? "나" : "참가자"}</div>
                  </div>
                  <span class="pill ${player.id === snapshot.me.id ? "gold" : "primary"}">${player.id === snapshot.me.id ? "YOU" : "READY"}</span>
                </div>
              `
            )
            .join("")}
        </div>
      </section>
      <section class="panel">
        <h3>진행 순서</h3>
        <div class="history-list">
          ${[
            "1. 컬러 스냅",
            "2. GO / STOP 탭",
            "3. 숫자 헌터",
            "4. 10초 멈춰",
            "5. 게이지 스톱"
          ]
            .map(
              (text) => `
                <div class="history-row">
                  <span>${escapeHtml(text)}</span>
                </div>
              `
            )
            .join("")}
        </div>
      </section>
    </div>
  `;
}

function renderGameHeader(snapshot) {
  const round = snapshot.round;
  const phaseLabel = PHASE_LABELS[snapshot.phase];
  const remainingMs = getRemainingMs();
  const totalDuration =
    snapshot.phase === "intro"
      ? Math.max(1, round.phaseEndsAt - round.phaseStartedAt)
      : snapshot.phase === "practice"
        ? round.practiceMs
        : round.mainMs;
  const progress = Math.max(0, Math.min(100, ((totalDuration - remainingMs) / totalDuration) * 100));

  return `
    <div class="game-head">
      <div class="panel-header">
        <div>
          <span class="eyebrow">${round.number}/${round.total} Game</span>
          <h2>${escapeHtml(round.title)}</h2>
          <p class="muted">${escapeHtml(round.summary)}</p>
        </div>
        <span class="pill ${snapshot.phase === "main" ? "gold" : "primary"}">${phaseLabel}</span>
      </div>
      <div class="countdown">${formatCountdown(remainingMs)}</div>
      <div class="progress-bar"><span style="width:${progress}%"></span></div>
    </div>
  `;
}

function renderColorSnap(runtime) {
  const live = syncedNow() >= runtime.revealAt;
  return `
    <div class="tap-zone">
      <button type="button" class="tap-zone__surface ${live ? "is-live" : ""}" data-action="color-snap-tap" style="${live ? `background:${runtime.targetColor}; border-color:${runtime.targetColor};` : ""}">
        ${runtime.submitted ? "제출 완료" : live ? "지금 탭!" : "목표 색상이 나타나면 탭하세요"}
      </button>
    </div>
  `;
}

function renderGoStop(runtime) {
  const cue = getCurrentCue(runtime);
  const label = cue ? cue.kind : "대기";
  return `
    <div class="game-stage">
      <div class="cue-card">
        <div class="cue-word ${cue?.kind === "GO" ? "go" : cue?.kind === "STOP" ? "stop" : ""}">${label}</div>
        <p class="muted">${cue ? "GO일 때만 버튼을 누르세요." : "곧 다음 신호가 나옵니다."}</p>
      </div>
      <button type="button" class="primary" data-action="go-stop-tap" ${runtime.submitted ? "disabled" : ""}>탭</button>
    </div>
  `;
}

function renderNumberHunter(runtime) {
  const question = runtime.questions[runtime.currentIndex];
  return `
    <div class="game-stage">
      <div class="meta-card">
        <div class="stat-label">문제 ${runtime.currentIndex + 1}/3</div>
        <div class="stat-value">${question.target}</div>
        <p class="muted">가장 큰 숫자를 골라 보세요.</p>
      </div>
      <div class="number-grid">
        ${question.cells
          .map(
            (cell, index) => `
              <button type="button" class="number-cell" data-action="number-select" data-index="${index}" ${runtime.submitted ? "disabled" : ""}>${cell.value}</button>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderTenSeconds(runtime) {
  return `
    <div class="pulse-zone">
      <p class="muted center">머릿속으로 10초를 세고 정확하다고 느껴질 때 STOP을 눌러 주세요.</p>
      <button type="button" class="primary" data-action="ten-seconds-stop" ${runtime.submitted ? "disabled" : ""}>STOP</button>
    </div>
  `;
}

function renderGaugeStop(runtime) {
  const markerPosition = getGaugePosition(runtime) * 100;
  return `
    <div class="gauge-shell">
      <div class="gauge-track">
        <div class="gauge-target" style="left:${runtime.targetStart * 100}%; width:${runtime.targetWidth * 100}%"></div>
        <div class="gauge-marker" style="left:${markerPosition}%"></div>
      </div>
      <button type="button" class="primary" data-action="gauge-stop" ${runtime.submitted ? "disabled" : ""}>여기서 멈추기</button>
    </div>
  `;
}

function renderGameInteraction(snapshot) {
  const runtime = store.runtime;
  if (!runtime) {
    return `
      <div class="card">
        <p class="muted">게임 준비 중입니다.</p>
      </div>
    `;
  }

  if (runtime.submitted) {
    return `
      <div class="card center">
        <h3>제출 완료</h3>
        <p class="muted">다른 참가자의 제출이 끝나거나 시간이 종료되면 자동으로 다음 단계로 이동합니다.</p>
      </div>
    `;
  }

  switch (snapshot.round.id) {
    case "color-snap":
      return renderColorSnap(runtime);
    case "go-stop":
      return renderGoStop(runtime);
    case "number-hunter":
      return renderNumberHunter(runtime);
    case "ten-seconds":
      return renderTenSeconds(runtime);
    case "gauge-stop":
      return renderGaugeStop(runtime);
    default:
      return "";
  }
}

function renderGameScreen(snapshot) {
  const isIntro = snapshot.phase === "intro";
  return `
    <div class="screen">
      ${renderBanner()}
      <section class="game-shell">
        ${renderGameHeader(snapshot)}
        ${renderStatusGrid(snapshot)}
        ${
          isIntro
            ? `
              <div class="card">
                <h3>${escapeHtml(snapshot.round.title)}</h3>
                <p class="muted">${escapeHtml(snapshot.round.summary)}</p>
                <p class="muted">3초 후 연습이 자동으로 시작됩니다.</p>
              </div>
            `
            : renderGameInteraction(snapshot)
        }
      </section>
      ${renderLeaderboard(snapshot.leaderboard)}
    </div>
  `;
}

function renderRoundResult(snapshot) {
  const mine = snapshot.roundResults.find((entry) => entry.playerId === snapshot.me.id);
  return `
    <div class="screen">
      ${renderBanner()}
      <section class="panel">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Round Result</span>
            <h2>${snapshot.round.number}라운드 결과</h2>
            <p class="muted">${escapeHtml(snapshot.round.title)} 결과가 집계되었습니다. 5초 뒤 다음 게임으로 자동 이동합니다.</p>
          </div>
          <span class="pill gold">${formatCountdown(getRemainingMs())}</span>
        </div>
        <div class="score-grid">
          <div class="score-card">
            <span class="stat-label">내 순위</span>
            <div class="stat-value">${mine ? `${mine.rank}위` : "-"}</div>
          </div>
          <div class="score-card">
            <span class="stat-label">내 게임 점수</span>
            <div class="stat-value">${mine ? `${mine.rawScore}` : "0"}</div>
          </div>
          <div class="score-card">
            <span class="stat-label">이번 라운드 점수</span>
            <div class="stat-value">${mine ? `${mine.roundPoints}점` : "0점"}</div>
          </div>
          <div class="score-card">
            <span class="stat-label">누적 점수</span>
            <div class="stat-value">${mine ? `${mine.totalPoints}점` : `${snapshot.me.totalPoints}점`}</div>
          </div>
        </div>
      </section>
      <section class="panel">
        <h3>이번 라운드 순위</h3>
        <div class="leaderboard-list">
          ${snapshot.roundResults
            .map(
              (entry) => `
                <div class="leaderboard-row">
                  <div>
                    <div class="leaderboard-name">${entry.rank}위 · ${escapeHtml(entry.nickname)}</div>
                    <div class="muted small">${escapeHtml(entry.detailLabel)} · ${escapeHtml(entry.detailSummary)}</div>
                  </div>
                  <span class="pill ${entry.rank === 1 ? "gold" : "primary"}">${entry.roundPoints}점</span>
                </div>
              `
            )
            .join("")}
        </div>
      </section>
      ${renderLeaderboard(snapshot.leaderboard)}
    </div>
  `;
}

function renderFinal(snapshot) {
  const podium = snapshot.finalRanking.slice(0, 3);
  return `
    <div class="screen">
      ${renderBanner()}
      <section class="hero-card">
        <div class="panel-header">
          <div>
            <span class="eyebrow">Final Ranking</span>
            <h1>최종 결과</h1>
            <p>5개 게임이 모두 끝났습니다. 순위 점수 합산으로 최종 우승자를 결정했습니다.</p>
          </div>
          <span class="pill gold">${escapeHtml(snapshot.finalRanking[0]?.nickname || "-")} 우승</span>
        </div>
        <div class="button-row">
          <button type="button" class="primary" data-action="reset-game" ${store.busy ? "disabled" : ""}>새 게임 시작</button>
        </div>
      </section>
      <section class="panel">
        <h2>Top 3</h2>
        <div class="podium-grid">
          ${podium
            .map(
              (entry) => `
                <div class="podium-card rank-${entry.rank}">
                  <div class="pill ${entry.rank === 1 ? "gold" : "primary"}">${entry.rank}위</div>
                  <h3>${escapeHtml(entry.nickname)}</h3>
                  <p class="muted">${entry.totalPoints}점</p>
                </div>
              `
            )
            .join("")}
        </div>
      </section>
      <section class="panel final-list">
        <h2>최종 순위표</h2>
        <div class="leaderboard-list">
          ${snapshot.finalRanking
            .map(
              (entry) => `
                <div class="leaderboard-row">
                  <div>
                    <div class="leaderboard-name">${entry.rank}위 · ${escapeHtml(entry.nickname)}</div>
                    <div class="muted small">라운드 점수 ${entry.roundPoints.join(" / ") || "-"}</div>
                  </div>
                  <span class="pill ${entry.rank === 1 ? "gold" : "primary"}">${entry.totalPoints}점</span>
                </div>
              `
            )
            .join("")}
        </div>
      </section>
      <section class="panel">
        <h3>게임 진행 히스토리</h3>
        <div class="history-list">
          ${snapshot.history
            .map(
              (entry) => `
                <div class="history-row">
                  <div>${entry.roundNumber}R · ${escapeHtml(entry.title)}</div>
                  <div class="muted">${escapeHtml(entry.winner || "-")}</div>
                </div>
              `
            )
            .join("")}
        </div>
      </section>
    </div>
  `;
}

function render() {
  const activeElement = document.activeElement;
  const nicknameSelection =
    activeElement instanceof HTMLInputElement && activeElement.id === "nickname"
      ? {
          start: activeElement.selectionStart ?? store.homeNickname.length,
          end: activeElement.selectionEnd ?? store.homeNickname.length
        }
      : null;
  if (activeElement instanceof HTMLInputElement && activeElement.id === "nickname") {
    store.homeNickname = activeElement.value;
  }

  const snapshot = store.snapshot;
  if (!snapshot.me) {
    app.innerHTML = renderHome(snapshot);
    if (nicknameSelection || store.shouldFocusNickname) {
      focusNicknameInput(nicknameSelection);
    }
    return;
  }

  switch (snapshot.phase) {
    case "lobby":
      app.innerHTML = renderLobby(snapshot);
      break;
    case "intro":
    case "practice":
    case "main":
      app.innerHTML = renderGameScreen(snapshot);
      break;
    case "result":
      app.innerHTML = renderRoundResult(snapshot);
      break;
    case "final":
      app.innerHTML = renderFinal(snapshot);
      break;
    default:
      app.innerHTML = renderHome(snapshot);
      if (nicknameSelection || store.shouldFocusNickname) {
        focusNicknameInput(nicknameSelection);
      }
      break;
  }
}

function handleColorSnapTap() {
  const runtime = store.runtime;
  if (!runtime || runtime.submitted) {
    return;
  }
  const now = syncedNow();
  if (now < runtime.revealAt) {
    submitGameScore(0, {
      label: "성급한 탭",
      summary: "목표 색상이 나오기 전에 눌렀습니다."
    });
    return;
  }
  const reaction = now - runtime.revealAt;
  const score = Math.max(0, 1000 - Math.round(reaction * 1.4));
  submitGameScore(score, {
    label: `${reaction}ms`,
    summary: `반응속도 기준 점수 ${score}점`
  });
}

function handleGoStopTap() {
  const runtime = store.runtime;
  if (!runtime || runtime.submitted) {
    return;
  }
  const cue = getCurrentCue(runtime);
  if (!cue) {
    runtime.falseTaps += 1;
    render();
    return;
  }
  if (runtime.handledCueIndices.has(cue.index)) {
    return;
  }

  runtime.handledCueIndices.add(cue.index);
  if (cue.kind === "GO") {
    const reaction = Math.max(0, syncedNow() - (store.snapshot.round.phaseStartedAt + cue.startOffset));
    runtime.reactionTimes.push(reaction);
  } else {
    runtime.falseTaps += 1;
  }

  const goCount = runtime.sequence.filter((entry) => entry.kind === "GO").length;
  if (runtime.reactionTimes.length + runtime.falseTaps >= runtime.sequence.length || runtime.reactionTimes.length === goCount) {
    const missed = Math.max(0, goCount - runtime.reactionTimes.length);
    const avgReaction =
      runtime.reactionTimes.length > 0
        ? runtime.reactionTimes.reduce((sum, value) => sum + value, 0) / runtime.reactionTimes.length
        : 999;
    const score = Math.max(
      0,
      runtime.reactionTimes.length * 220 - runtime.falseTaps * 140 - missed * 90 + Math.max(0, 320 - avgReaction / 3)
    );
    submitGameScore(score, {
      label: `${runtime.reactionTimes.length}회 정답`,
      summary: `오탭 ${runtime.falseTaps}회 · 평균 ${Math.round(avgReaction)}ms`
    });
    return;
  }

  render();
}

function handleNumberSelect(index) {
  const runtime = store.runtime;
  if (!runtime || runtime.submitted) {
    return;
  }
  const question = runtime.questions[runtime.currentIndex];
  if (!question) {
    return;
  }
  const choice = question.cells[index];
  if (!choice) {
    return;
  }

  const reaction = Math.max(0, syncedNow() - runtime.questionStartedAt);
  runtime.attempts.push({
    correct: choice.isTarget,
    reaction
  });

  if (runtime.currentIndex >= runtime.questions.length - 1) {
    const correctCount = runtime.attempts.filter((attempt) => attempt.correct).length;
    const averageReaction =
      runtime.attempts.length > 0
        ? runtime.attempts.reduce((sum, attempt) => sum + attempt.reaction, 0) / runtime.attempts.length
        : 0;
    const score = Math.max(0, correctCount * 300 + Math.max(0, 420 - averageReaction / 6));
    submitGameScore(score, {
      label: `${correctCount}/3 정답`,
      summary: `평균 ${Math.round(averageReaction)}ms`
    });
    return;
  }

  runtime.currentIndex += 1;
  runtime.questionStartedAt = syncedNow();
  render();
}

function handleTenSecondsStop() {
  const runtime = store.runtime;
  if (!runtime || runtime.submitted) {
    return;
  }
  const elapsed = Math.max(0, syncedNow() - store.snapshot.round.phaseStartedAt);
  const error = Math.abs(elapsed - 10000);
  const score = Math.max(0, 1000 - Math.round(error * 0.3));
  submitGameScore(score, {
    label: `${(elapsed / 1000).toFixed(2)}초`,
    summary: `오차 ${(error / 1000).toFixed(2)}초`
  });
}

function handleGaugeStop() {
  const runtime = store.runtime;
  if (!runtime || runtime.submitted) {
    return;
  }
  const position = getGaugePosition(runtime);
  const targetCenter = runtime.targetStart + runtime.targetWidth / 2;
  const distance = Math.abs(position - targetCenter);
  const score = Math.max(0, 1000 - Math.round(distance * 2600));
  submitGameScore(score, {
    label: `거리 ${(distance * 100).toFixed(1)}%`,
    summary: `정확도 기반 점수 ${score}점`
  });
}

app.addEventListener("submit", async (event) => {
  if (event.target instanceof HTMLFormElement && event.target.id === "join-form") {
    event.preventDefault();
    const formData = new FormData(event.target);
    const nickname = String(formData.get("nickname") || "").trim();
    store.homeNickname = String(formData.get("nickname") || "");
    if (!nickname) {
      store.shouldFocusNickname = true;
      setError("닉네임을 입력해 주세요.");
      return;
    }
    await joinLobby(nickname);
  }
});

app.addEventListener("input", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.id === "nickname") {
    store.homeNickname = event.target.value;
  }
});

app.addEventListener("click", async (event) => {
  const target = event.target instanceof HTMLElement ? event.target.closest("[data-action]") : null;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const { action } = target.dataset;
  store.error = "";

  switch (action) {
    case "start-game":
      await startGame();
      break;
    case "reset-game":
      await resetGame();
      break;
    case "color-snap-tap":
      handleColorSnapTap();
      break;
    case "go-stop-tap":
      handleGoStopTap();
      break;
    case "number-select":
      handleNumberSelect(Number(target.dataset.index));
      break;
    case "ten-seconds-stop":
      handleTenSecondsStop();
      break;
    case "gauge-stop":
      handleGaugeStop();
      break;
    default:
      break;
  }
});

function startTimers() {
  if (!store.renderTimer) {
    store.renderTimer = window.setInterval(() => {
      if (!shouldAnimateView()) {
        return;
      }
      maybeAutoSubmit();
      render();
    }, 200);
  }
}

function startPolling() {
  if (store.pollTimer) {
    return;
  }
  store.pollTimer = window.setInterval(() => {
    fetchState();
  }, 1000);
}

function stopPolling() {
  if (!store.pollTimer) {
    return;
  }
  window.clearInterval(store.pollTimer);
  store.pollTimer = null;
}

function boot() {
  render();
  startTimers();
}

boot();
