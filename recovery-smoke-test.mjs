import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const host = "127.0.0.1";
const port = 4312;
const baseUrl = `http://${host}:${port}`;
const stateFile = path.join(__dirname, ".tmp-recovery-state.json");

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

async function getState(clientId) {
  return fetchJson(`${baseUrl}/api/state?clientId=${encodeURIComponent(clientId)}`);
}

async function waitForState(clientId, predicate, label, timeoutMs = 8000) {
  const startedAt = Date.now();
  let lastState = null;

  while (Date.now() - startedAt < timeoutMs) {
    lastState = await getState(clientId);
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
        roundTitle: lastState?.currentRound?.title
      },
      null,
      2
    )}`
  );
}

function buildMetrics(playerName, roundNumber, score) {
  return {
    label: `${playerName} ${score}점`,
    summary: `${roundNumber}라운드 복구 테스트 제출`
  };
}

function startServer() {
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: __dirname,
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      STATE_FILE: stateFile,
      PRACTICE_LEAD_IN_MS: "30",
      MAIN_INTRO_MS: "400",
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
      reject(new Error(`복구 테스트 서버가 비정상 종료되었습니다. code=${code}\n${stdout}\n${stderr}`));
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

async function main() {
  await rm(stateFile, { force: true });
  await rm(`${stateFile}.tmp`, { force: true });

  const adminId = "recovery-admin";
  const playerA = "recovery-player-a";
  const playerB = "recovery-player-b";
  let server = null;

  try {
    server = await startServer();

    await Promise.all([post("/api/session", { clientId: adminId }), post("/api/session", { clientId: playerA }), post("/api/session", { clientId: playerB })]);

    const roomCreate = await post("/api/admin/room", {
      clientId: adminId,
      name: "재시작 복구 테스트 룸",
      roundCount: 5,
      prizes: ["1R", "2R", "3R", "4R", "5R"]
    });
    const roomCode = roomCreate.roomCode;

    await post("/api/join", { clientId: playerA, roomCode, nickname: "문기" });
    await post("/api/join", { clientId: playerB, roomCode, nickname: "김대리" });

    await post("/api/admin/action", { clientId: adminId, action: "start-tournament" });
    await waitForState(adminId, (state) => state.room.state === "ROUND_INTRO" && state.room.currentRoundIndex === 0, "재시작 전 ROUND_INTRO");

    await post("/api/admin/action", { clientId: adminId, action: "start-practice" });
    await waitForState(adminId, (state) => state.room.state === "PRACTICE_PLAY", "재시작 전 PRACTICE_PLAY");

    await Promise.all([
      post("/api/player/submit", {
        clientId: playerA,
        mode: "practice",
        score: 810,
        rankVector: [810, -10],
        metrics: buildMetrics("문기", 1, 810)
      }),
      post("/api/player/submit", {
        clientId: playerB,
        mode: "practice",
        score: 790,
        rankVector: [790, -12],
        metrics: buildMetrics("김대리", 1, 790)
      })
    ]);

    await waitForState(adminId, (state) => state.room.state === "PRACTICE_RESULT", "재시작 전 PRACTICE_RESULT");
    await post("/api/admin/action", { clientId: adminId, action: "start-main" });
    await waitForState(adminId, (state) => state.room.state === "MAIN_PLAY", "재시작 전 MAIN_PLAY", 10000);

    await stopServer(server);
    server = await startServer();

    const restoredAdminSession = await post("/api/session", { clientId: adminId });
    const restoredPlayerSession = await post("/api/session", { clientId: playerA });
    assert(restoredAdminSession.roomCode === roomCode && restoredAdminSession.role === "admin", "관리자 세션이 복구되지 않았습니다.");
    assert(restoredPlayerSession.roomCode === roomCode && restoredPlayerSession.role === "player", "플레이어 세션이 복구되지 않았습니다.");

    const restoredMainPlay = await waitForState(
      adminId,
      (state) => state.room.state === "MAIN_PLAY" && state.room.currentRoundIndex === 0,
      "재시작 후 MAIN_PLAY",
      10000
    );
    assert(restoredMainPlay.players.every((player) => player.connected === false), "재시작 직후 플레이어 연결 상태가 초기화되지 않았습니다.");

    await Promise.all([
      post("/api/player/submit", {
        clientId: playerA,
        mode: "main",
        score: 1200,
        rankVector: [1200, 0],
        metrics: buildMetrics("문기", 1, 1200)
      }),
      post("/api/player/submit", {
        clientId: playerB,
        mode: "main",
        score: 700,
        rankVector: [700, 0],
        metrics: buildMetrics("김대리", 1, 700)
      })
    ]);

    const roundResult = await waitForState(
      adminId,
      (state) => state.room.state === "ROUND_RESULT" && state.currentRound?.results?.length === 2,
      "재시작 후 ROUND_RESULT",
      10000
    );
    assert(roundResult.currentRound.results[0].nickname === "문기", "복구 후 1라운드 우승자가 예상과 다릅니다.");

    await stopServer(server);
    server = await startServer();

    const restoredRoundResult = await waitForState(
      adminId,
      (state) => state.room.state === "ROUND_RESULT" && state.currentRound?.results?.[0]?.nickname === "문기",
      "재시작 후 ROUND_RESULT 유지"
    );
    assert(restoredRoundResult.finalRanking[0].totalPoints === 2, "재시작 후 누적 점수가 유지되지 않았습니다.");

    await post("/api/admin/action", { clientId: adminId, action: "advance" });
    await waitForState(adminId, (state) => state.room.state === "ROUND_INTRO" && state.room.currentRoundIndex === 1, "재시작 후 다음 라운드");

    console.log("Recovery smoke test passed: persisted sessions + room state + round progress across restarts");
  } finally {
    await stopServer(server);
    await rm(stateFile, { force: true });
    await rm(`${stateFile}.tmp`, { force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
