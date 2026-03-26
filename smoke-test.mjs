import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const host = "127.0.0.1";
const port = 4311;
const baseUrl = `http://${host}:${port}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function post(pathname, payload) {
  return fetchJson(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

async function bootstrap(clientId, extra = {}) {
  return post("/api/bootstrap", {
    clientId,
    ...extra
  });
}

async function roomAction(payload) {
  return post("/api/room", payload);
}

async function roundAction(session, payload) {
  return post("/api/round", {
    clientId: session.clientId,
    roomCode: session.roomCode,
    role: session.role,
    playerId: session.playerId || null,
    nickname: session.nickname || null,
    ...payload
  });
}

async function getState(session) {
  const params = new URLSearchParams({
    clientId: session.clientId,
    roomCode: session.roomCode
  });
  if (session.role) {
    params.set("role", session.role);
  }
  if (session.playerId) {
    params.set("playerId", session.playerId);
  }
  if (session.nickname) {
    params.set("nickname", session.nickname);
  }
  return fetchJson(`${baseUrl}/api/player?${params.toString()}`);
}

async function getLeaderboard(roomCode) {
  return fetchJson(`${baseUrl}/api/leaderboard?roomCode=${encodeURIComponent(roomCode)}`);
}

async function getHealth(pathname) {
  return fetchJson(`${baseUrl}${pathname}`);
}

async function waitForState(session, predicate, label, timeoutMs = 12000) {
  const startedAt = Date.now();
  let lastState = null;

  while (Date.now() - startedAt < timeoutMs) {
    lastState = await getState(session);
    if (predicate(lastState)) {
      return lastState;
    }
    await sleep(80);
  }

  throw new Error(
    `${label} 대기 중 타임아웃\n마지막 상태: ${JSON.stringify(
      {
        roomState: lastState?.room?.state,
        roundIndex: lastState?.room?.currentRoundIndex,
        roundTitle: lastState?.currentRound?.title,
        role: lastState?.viewer?.role
      },
      null,
      2
    )}`
  );
}

function buildMetrics(playerName, roundNumber, mode, score) {
  return {
    label: `${playerName} ${score}점`,
    summary: `${roundNumber}라운드 ${mode === "practice" ? "연습" : "본게임"} 자동 제출`
  };
}

async function submitScore(session, roundNumber, mode, score) {
  return roundAction(session, {
    action: "submit",
    mode,
    score,
    rankVector: [score],
    metrics: buildMetrics(session.nickname, roundNumber, mode, score)
  });
}

function startServer() {
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: __dirname,
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      PRACTICE_LEAD_IN_MS: "20",
      MAIN_INTRO_MS: "120",
      SCORING_DELAY_MS: "20"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const ready = new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    server.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("Realtime minigame MVP server running")) {
        resolve(server);
      }
    });

    server.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    server.on("exit", (code) => {
      reject(new Error(`스모크 테스트 서버가 비정상 종료되었습니다. code=${code}\n${stdout}\n${stderr}`));
    });
  });

  return ready;
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => {
    server.once("exit", resolve);
  });
  server.kill("SIGINT");
  await exited;
  await sleep(120);
}

async function playRound(adminSession, playerA, playerB, roundIndex, flow) {
  const roundNumber = roundIndex + 1;

  await waitForState(
    adminSession,
    (state) => state.room?.state === "ROUND_INTRO" && state.room.currentRoundIndex === roundIndex,
    `${roundNumber}라운드 ROUND_INTRO`
  );

  if (flow === "practice") {
    await roundAction(adminSession, { action: "start-practice" });
    await waitForState(adminSession, (state) => state.room?.state === "PRACTICE_PLAY", `${roundNumber}라운드 PRACTICE_PLAY`);
    await Promise.all([
      submitScore(playerA, roundNumber, "practice", 900 - roundIndex * 10),
      submitScore(playerB, roundNumber, "practice", 780 - roundIndex * 10)
    ]);
    await waitForState(adminSession, (state) => state.room?.state === "PRACTICE_RESULT", `${roundNumber}라운드 PRACTICE_RESULT`);
    await roundAction(adminSession, { action: "start-main" });
  } else if (flow === "skip") {
    await roundAction(adminSession, { action: "skip-practice" });
  } else {
    await roundAction(adminSession, { action: "start-main" });
  }

  await waitForState(adminSession, (state) => state.room?.state === "MAIN_PLAY", `${roundNumber}라운드 MAIN_PLAY`, 12000);
  await Promise.all([
    submitScore(playerA, roundNumber, "main", 1200 - roundIndex * 17),
    submitScore(playerB, roundNumber, "main", 850 - roundIndex * 11)
  ]);

  const roundResult = await waitForState(
    adminSession,
    (state) => state.room?.state === "ROUND_RESULT" && state.currentRound?.results?.length === 2,
    `${roundNumber}라운드 ROUND_RESULT`,
    12000
  );
  assert(roundResult.currentRound.results[0].nickname === "문기", `${roundNumber}라운드 우승자가 예상과 다릅니다.`);

  const leaderboard = await getLeaderboard(adminSession.roomCode);
  assert(leaderboard.leaderboard?.type === "round", `${roundNumber}라운드 leaderboard 타입이 round여야 합니다.`);
  assert(leaderboard.leaderboard?.results?.length === 2, `${roundNumber}라운드 leaderboard 결과 길이가 예상과 다릅니다.`);
}

async function main() {
  const adminId = "smoke-admin";
  const playerAId = "smoke-player-a";
  const playerBId = "smoke-player-b";
  const spectatorId = "smoke-spectator";
  const displayId = "smoke-display";
  let server = null;

  try {
    server = await startServer();

    const health = await getHealth("/healthz");
    const ready = await getHealth("/readyz");
    assert(health.ok === true, "healthz 응답이 비정상입니다.");
    assert(ready.ok === true, "readyz 응답이 비정상입니다.");

    const freshHome = await bootstrap("fresh-home-client");
    assert(freshHome.recovered === false, "신규 홈 클라이언트는 복구되면 안 됩니다.");
    assert(freshHome.home?.showAdminStart === true, "홈 버튼 정보가 누락되었습니다.");

    const createdRoom = await roomAction({
      action: "createRoom",
      clientId: adminId,
      name: "Vercel Smoke Room",
      roundCount: 5,
      prizes: ["1R 상품", "2R 상품", "3R 상품", "4R 상품", "5R 상품"]
    });

    const adminSession = createdRoom.session;
    const roomCode = createdRoom.roomCode;
    assert(Boolean(roomCode), "방 코드가 생성되지 않았습니다.");
    assert(adminSession.role === "admin", "방 생성 직후 관리자 세션이 반환되어야 합니다.");
    assert(createdRoom.snapshot?.room?.state === "WAITING", "방 생성 직후 상태가 WAITING이어야 합니다.");

    const recoveredAdmin = await bootstrap(adminId);
    assert(recoveredAdmin.recovered === true, "관리자 bootstrap 복구가 동작하지 않았습니다.");
    assert(recoveredAdmin.session?.role === "admin", "복구된 관리자 role이 맞지 않습니다.");

    const joinA = await roomAction({
      action: "joinRoom",
      clientId: playerAId,
      roomCode,
      nickname: "문기"
    });
    const joinB = await roomAction({
      action: "joinRoom",
      clientId: playerBId,
      roomCode,
      nickname: "김대리"
    });
    const playerA = joinA.session;
    const playerB = joinB.session;

    assert(playerA.role === "player" && playerB.role === "player", "참가자 입장이 정상 처리되지 않았습니다.");

    const recoveredPlayer = await bootstrap(playerAId);
    assert(recoveredPlayer.recovered === true, "참가자 bootstrap 복구가 동작하지 않았습니다.");
    assert(recoveredPlayer.session?.role === "player", "복구된 참가자 role이 맞지 않습니다.");

    const displayBootstrap = await bootstrap(displayId, {
      roomCode,
      role: "display",
      display: true
    });
    assert(displayBootstrap.recovered === true, "발표 화면 bootstrap이 동작하지 않았습니다.");
    assert(displayBootstrap.session?.role === "display", "발표 화면 role이 맞지 않습니다.");

    const waitingState = await waitForState(
      adminSession,
      (state) => state.room?.state === "WAITING" && state.players?.filter((player) => !player.spectator).length === 2,
      "대기실 참가자 반영"
    );
    assert(waitingState.players.filter((player) => !player.spectator).length === 2, "대기실 참가자 수가 맞지 않습니다.");

    await roundAction(adminSession, {
      action: "update-prize",
      roundIndex: 0,
      prize: "에스프레소 쿠폰"
    });
    const prizeState = await getState(adminSession);
    assert(prizeState.room.prizes[0] === "에스프레소 쿠폰", "첫 라운드 특별상품 저장이 반영되지 않았습니다.");

    await roundAction(adminSession, { action: "start-tournament" });
    await waitForState(
      adminSession,
      (state) => state.room?.state === "ROUND_INTRO" && state.room.currentRoundIndex === 0,
      "1라운드 ROUND_INTRO"
    );

    const spectatorJoin = await roomAction({
      action: "joinRoom",
      clientId: spectatorId,
      roomCode,
      nickname: "관전자"
    });
    assert(spectatorJoin.session.role === "spectator", "대회 시작 후 입장은 관전자로 처리되어야 합니다.");

    await playRound(adminSession, playerA, playerB, 0, "practice");
    await roundAction(adminSession, { action: "advance" });

    await playRound(adminSession, playerA, playerB, 1, "skip");
    await roundAction(adminSession, { action: "advance" });

    await playRound(adminSession, playerA, playerB, 2, "direct");
    await roundAction(adminSession, { action: "advance" });

    await playRound(adminSession, playerA, playerB, 3, "skip");
    await roundAction(adminSession, { action: "advance" });

    await playRound(adminSession, playerA, playerB, 4, "practice");
    await roundAction(adminSession, { action: "advance" });

    const finalState = await waitForState(
      adminSession,
      (state) => state.room?.state === "FINAL_RESULT" && state.finalRanking?.length === 2,
      "FINAL_RESULT"
    );
    assert(finalState.finalRanking[0].nickname === "문기", "최종 우승자가 예상과 다릅니다.");

    const finalLeaderboard = await getLeaderboard(roomCode);
    assert(finalLeaderboard.leaderboard?.type === "final", "최종 leaderboard 타입이 final이어야 합니다.");
    assert(finalLeaderboard.leaderboard?.results?.length === 2, "최종 leaderboard 결과 길이가 예상과 다릅니다.");

    await roundAction(adminSession, { action: "advance" });
    await waitForState(adminSession, (state) => state.room?.state === "ENDED", "ENDED");

    await roundAction(adminSession, { action: "reset-room" });
    const resetState = await waitForState(
      adminSession,
      (state) => state.room?.state === "WAITING" && state.room.currentRoundIndex === -1,
      "reset-room 후 WAITING"
    );
    assert(resetState.players.every((player) => player.totalPoints === 0), "새 대회 reset 후 점수가 초기화되지 않았습니다.");

    console.log("Smoke test passed: bootstrap -> room -> polling -> practice/main -> results -> final -> reset");
  } finally {
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
