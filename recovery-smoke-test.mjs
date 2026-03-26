import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const host = "127.0.0.1";
const port = 4312;
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
        roundTitle: lastState?.currentRound?.title
      },
      null,
      2
    )}`
  );
}

function buildMetrics(playerName, score) {
  return {
    label: `${playerName} ${score}점`,
    summary: "외부 저장소 복구 테스트 제출"
  };
}

function startServer(prefix) {
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: __dirname,
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      ROOM_STORE_PREFIX: prefix,
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
  if (!process.env.ROOM_STORE_URL || !process.env.ROOM_STORE_TOKEN) {
    console.log("Recovery smoke skipped: ROOM_STORE_URL / ROOM_STORE_TOKEN 이 없어 외부 저장소 재시작 복구를 검증할 수 없습니다.");
    return;
  }

  const prefix = `recovery-smoke-${Date.now()}`;
  const adminId = "recovery-admin";
  const playerAId = "recovery-player-a";
  const playerBId = "recovery-player-b";
  let server = null;

  try {
    server = await startServer(prefix);

    const createdRoom = await roomAction({
      action: "createRoom",
      clientId: adminId,
      name: "Recovery Smoke Room",
      roundCount: 5,
      prizes: ["1R", "2R", "3R", "4R", "5R"]
    });

    const adminSession = createdRoom.session;
    const roomCode = createdRoom.roomCode;

    const playerA = (
      await roomAction({
        action: "joinRoom",
        clientId: playerAId,
        roomCode,
        nickname: "문기"
      })
    ).session;
    const playerB = (
      await roomAction({
        action: "joinRoom",
        clientId: playerBId,
        roomCode,
        nickname: "김대리"
      })
    ).session;

    await roundAction(adminSession, { action: "start-tournament" });
    await waitForState(adminSession, (state) => state.room?.state === "ROUND_INTRO", "ROUND_INTRO");
    await roundAction(adminSession, { action: "skip-practice" });
    await waitForState(adminSession, (state) => state.room?.state === "MAIN_PLAY", "재시작 전 MAIN_PLAY", 12000);

    await stopServer(server);
    server = await startServer(prefix);

    const recoveredAdmin = await bootstrap(adminId);
    const recoveredPlayer = await bootstrap(playerAId);
    assert(recoveredAdmin.recovered === true, "재시작 후 관리자 bootstrap 복구가 실패했습니다.");
    assert(recoveredPlayer.recovered === true, "재시작 후 참가자 bootstrap 복구가 실패했습니다.");

    const adminAfterRestart = recoveredAdmin.session;
    const playerAAfterRestart = recoveredPlayer.session;

    assert(adminAfterRestart.roomCode === roomCode, "재시작 후 관리자 roomCode가 유지되지 않았습니다.");
    assert(playerAAfterRestart.roomCode === roomCode, "재시작 후 참가자 roomCode가 유지되지 않았습니다.");

    await waitForState(
      adminAfterRestart,
      (state) => state.room?.state === "MAIN_PLAY" && state.room.currentRoundIndex === 0,
      "재시작 후 MAIN_PLAY 유지",
      12000
    );

    await Promise.all([
      roundAction(playerAAfterRestart, {
        action: "submit",
        mode: "main",
        score: 1200,
        rankVector: [1200],
        metrics: buildMetrics("문기", 1200)
      }),
      roundAction(playerB, {
        action: "submit",
        mode: "main",
        score: 840,
        rankVector: [840],
        metrics: buildMetrics("김대리", 840)
      })
    ]);

    const roundResult = await waitForState(
      adminAfterRestart,
      (state) => state.room?.state === "ROUND_RESULT" && state.currentRound?.results?.length === 2,
      "재시작 후 ROUND_RESULT",
      12000
    );
    assert(roundResult.currentRound.results[0].nickname === "문기", "재시작 후 결과 집계가 비정상입니다.");

    console.log("Recovery smoke test passed: external store persisted room state across local adapter restart");
  } finally {
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
