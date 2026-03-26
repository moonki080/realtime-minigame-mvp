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

async function getAdminReport(clientId) {
  return fetchJson(`${baseUrl}/api/admin/report?clientId=${encodeURIComponent(clientId)}`);
}

async function getRoomDirectory() {
  return fetchJson(`${baseUrl}/api/rooms`);
}

async function getArchives(query = "") {
  const params = new URLSearchParams();
  if (query) {
    params.set("q", query);
  }
  const queryString = params.toString();
  return fetchJson(`${baseUrl}/api/archives${queryString ? `?${queryString}` : ""}`);
}

async function getArchiveReport(id) {
  return fetchJson(`${baseUrl}/api/archives/report?id=${encodeURIComponent(id)}`);
}

async function getHealth(pathname) {
  return fetchJson(`${baseUrl}${pathname}`);
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function expectReject(task, keyword) {
  try {
    await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(message.includes(keyword), `예상한 오류 문구를 찾지 못했습니다: ${message}`);
    return;
  }
  throw new Error("실패해야 하는 요청이 성공했습니다.");
}

function buildMetrics(playerName, roundNumber, score) {
  return {
    label: `${playerName} ${score}점`,
    summary: `${roundNumber}라운드 자동 제출`
  };
}

async function main() {
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: __dirname,
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      PERSIST_STATE: "0",
      PRACTICE_LEAD_IN_MS: "30",
      MAIN_INTRO_MS: "400",
      SCORING_DELAY_MS: "20"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const serverReady = new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    server.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("Realtime minigame MVP server running")) {
        resolve();
      }
    });

    server.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    server.on("exit", (code) => {
      reject(new Error(`테스트 서버가 비정상 종료되었습니다. code=${code}\n${stdout}\n${stderr}`));
    });
  });

  try {
    await serverReady;

    const health = await getHealth("/healthz");
    const ready = await getHealth("/readyz");
    assert(health.ok === true, "healthz 응답이 비정상입니다.");
    assert(ready.ok === true, "readyz 응답이 비정상입니다.");

    const adminId = "smoke-admin";
    const recoveredAdminId = "smoke-admin-recovery";
    const playerA = "smoke-player-a";
    const playerB = "smoke-player-b";
    const spectatorId = "smoke-spectator";
    const displayId = "smoke-display";
    let currentAdminId = adminId;

    await Promise.all([
      post("/api/session", { clientId: adminId }),
      post("/api/session", { clientId: recoveredAdminId }),
      post("/api/session", { clientId: playerA }),
      post("/api/session", { clientId: playerB }),
      post("/api/session", { clientId: spectatorId }),
      post("/api/session", { clientId: displayId })
    ]);

    const roomCreate = await post("/api/admin/room", {
      clientId: adminId,
      name: "스모크 테스트 룸",
      roundCount: 5,
      prizes: ["1R", "2R", "3R", "4R", "5R"]
    });
    const roomCode = roomCreate.roomCode;
    assert(Boolean(roomCreate.adminRecoveryCode), "관리자 복구 코드가 생성되지 않았습니다.");

    const createdAdminState = await getState(adminId);
    assert(createdAdminState.viewer.role === "admin", "방 생성 직후 관리자 role이 유지되어야 합니다.");
    assert(createdAdminState.room?.state === "WAITING", "방 생성 직후 관리자 상태가 WAITING이어야 합니다.");
    assert(createdAdminState.room?.code === roomCode, "방 생성 직후 관리자에게 올바른 방 코드가 보여야 합니다.");

    const initialDirectory = await getRoomDirectory();
    const initialRoomEntry = initialDirectory.rooms.find((room) => room.code === roomCode);
    assert(Boolean(initialRoomEntry), "방 목록 API에 생성한 방이 나타나지 않습니다.");
    assert(initialRoomEntry.state === "WAITING", "생성 직후 방 목록 상태가 WAITING이어야 합니다.");
    assert(initialRoomEntry.participantCount === 0, "생성 직후 참가자 수가 0이어야 합니다.");

    await post("/api/admin/recover", {
      clientId: recoveredAdminId,
      roomCode,
      recoveryCode: roomCreate.adminRecoveryCode
    });
    currentAdminId = recoveredAdminId;

    const recoveredAdminState = await getState(recoveredAdminId);
    assert(recoveredAdminState.viewer.role === "admin", "복구된 세션이 관리자 권한을 가져오지 못했습니다.");
    assert(
      recoveredAdminState.viewer.adminRecoveryCode === roomCreate.adminRecoveryCode,
      "복구된 관리자 화면에 복구 코드가 유지되지 않았습니다."
    );

    const displacedAdminState = await getState(adminId);
    assert(displacedAdminState.viewer.role === "guest", "기존 관리자 세션은 guest 상태로 내려와야 합니다.");

    await post("/api/session", { clientId: displayId, roomCode, role: "display" });
    const displayWaitingState = await getState(displayId);
    assert(displayWaitingState.viewer.role === "display", "발표 전용 세션 역할이 맞지 않습니다.");
    assert(displayWaitingState.room.code === roomCode, "발표 전용 세션이 올바른 방에 연결되지 않았습니다.");

    await post("/api/join", { clientId: playerA, roomCode, nickname: "문기" });
    await post("/api/join", { clientId: playerB, roomCode, nickname: "김대리" });

    const joinedDirectory = await getRoomDirectory();
    const joinedRoomEntry = joinedDirectory.rooms.find((room) => room.code === roomCode);
    assert(Boolean(joinedRoomEntry), "참가자 입장 후 방 목록 API에서 방이 사라졌습니다.");
    assert(joinedRoomEntry.participantCount === 2, "방 목록 API 참가자 수가 예상과 다릅니다.");
    assert(joinedRoomEntry.connectedParticipantCount === 2, "방 목록 API 온라인 참가자 수가 예상과 다릅니다.");

    await post("/api/admin/action", {
      clientId: currentAdminId,
      action: "update-prize",
      roundIndex: 0,
      prize: "에스프레소 쿠폰"
    });
    const waitingState = await getState(currentAdminId);
    assert(waitingState.room.prizes[0] === "에스프레소 쿠폰", "첫 라운드 특별상품 저장이 반영되지 않았습니다.");

    await post("/api/admin/action", { clientId: currentAdminId, action: "start-tournament" });
    await waitForState(currentAdminId, (state) => state.room.state === "ROUND_INTRO" && state.room.currentRoundIndex === 0, "1라운드 소개");

    await post("/api/admin/action", { clientId: currentAdminId, action: "pause" });
    const pausedIntro = await waitForState(currentAdminId, (state) => state.room.state === "PAUSED", "ROUND_INTRO pause");
    assert(pausedIntro.room.pauseInfo?.phase === "ROUND_INTRO", "ROUND_INTRO pause phase가 맞지 않습니다.");
    await post("/api/admin/action", { clientId: currentAdminId, action: "resume" });
    await waitForState(currentAdminId, (state) => state.room.state === "ROUND_INTRO" && state.room.currentRoundIndex === 0, "ROUND_INTRO resume");

    const spectatorJoin = await post("/api/join", { clientId: spectatorId, roomCode, nickname: "관전자" });
    assert(spectatorJoin.role === "spectator", "대회 시작 후 입장자는 관전자가 되어야 합니다.");

    for (let roundIndex = 0; roundIndex < 5; roundIndex += 1) {
      const roundNumber = roundIndex + 1;
      const shouldPractice = roundIndex % 2 === 0;

      const introState = await waitForState(
        currentAdminId,
        (state) => state.room.state === "ROUND_INTRO" && state.room.currentRoundIndex === roundIndex,
        `${roundNumber}라운드 ROUND_INTRO`
      );

      if (shouldPractice) {
        await post("/api/admin/action", { clientId: currentAdminId, action: "start-practice" });
        await waitForState(currentAdminId, (state) => state.room.state === "PRACTICE_PLAY", `${roundNumber}라운드 PRACTICE_PLAY`);

        if (roundIndex === 0) {
          await expectReject(
            () =>
              post("/api/player/submit", {
                clientId: playerA,
                mode: "main",
                score: 999,
                rankVector: [999],
                metrics: buildMetrics("문기", roundNumber, 999)
              }),
            "본게임"
          );
        }

        await Promise.all([
          post("/api/player/submit", {
            clientId: playerA,
            mode: "practice",
            score: 800 + roundIndex,
            rankVector: [800 + roundIndex, -300],
            metrics: buildMetrics("문기", roundNumber, 800 + roundIndex)
          }),
          post("/api/player/submit", {
            clientId: playerB,
            mode: "practice",
            score: 780 + roundIndex,
            rankVector: [780 + roundIndex, -340],
            metrics: buildMetrics("김대리", roundNumber, 780 + roundIndex)
          })
        ]);

        await waitForState(currentAdminId, (state) => state.room.state === "PRACTICE_RESULT", `${roundNumber}라운드 PRACTICE_RESULT`);
        await post("/api/admin/action", { clientId: currentAdminId, action: "start-main" });
      } else {
        await post("/api/admin/action", { clientId: currentAdminId, action: "skip-practice" });
        const skippedState = await waitForState(currentAdminId, (state) => state.room.state === "MAIN_INTRO", `${roundNumber}라운드 MAIN_INTRO`);
        assert(skippedState.currentRound.practiceEnabled === false, "연습 스킵 플래그가 반영되지 않았습니다.");
      }

      await waitForState(
        currentAdminId,
        (state) => state.room.state === "MAIN_PLAY" && state.room.currentRoundIndex === roundIndex,
        `${roundNumber}라운드 MAIN_PLAY`,
        10000
      );

      if (roundIndex === 1) {
        await post("/api/admin/action", { clientId: currentAdminId, action: "pause" });
        const pausedPlay = await waitForState(currentAdminId, (state) => state.room.state === "PAUSED", `${roundNumber}라운드 MAIN_PLAY pause`);
        assert(pausedPlay.room.pauseInfo?.phase === "MAIN_PLAY", "MAIN_PLAY pause phase가 맞지 않습니다.");
        assert(pausedPlay.room.pauseInfo?.restartOnResume === true, "라이브 플레이 pause는 재시작 형태여야 합니다.");
        await post("/api/admin/action", { clientId: currentAdminId, action: "resume" });
        await waitForState(
          currentAdminId,
          (state) => state.room.state === "MAIN_PLAY" && state.room.currentRoundIndex === roundIndex,
          `${roundNumber}라운드 MAIN_PLAY resume`,
          10000
        );
      }

      const playerAScore = roundIndex % 2 === 0 ? 1200 - roundIndex * 10 : 600 - roundIndex * 10;
      const playerBScore = roundIndex % 2 === 0 ? 700 - roundIndex * 10 : 1300 - roundIndex * 10;

      await Promise.all([
        post("/api/player/submit", {
          clientId: playerA,
          mode: "main",
          score: playerAScore,
          rankVector: [playerAScore, -roundIndex],
          metrics: buildMetrics("문기", roundNumber, playerAScore)
        }),
        post("/api/player/submit", {
          clientId: playerB,
          mode: "main",
          score: playerBScore,
          rankVector: [playerBScore, -roundIndex],
          metrics: buildMetrics("김대리", roundNumber, playerBScore)
        })
      ]);

      const resultState = await waitForState(
        currentAdminId,
        (state) => state.room.state === "ROUND_RESULT" && state.currentRound?.results?.length === 2,
        `${roundNumber}라운드 ROUND_RESULT`,
        10000
      );

      const winnerName = resultState.currentRound.results[0].nickname;
      const expectedWinner = roundIndex % 2 === 0 ? "문기" : "김대리";
      assert(winnerName === expectedWinner, `${roundNumber}라운드 우승자가 예상과 다릅니다.`);

      if (roundIndex < 4) {
        await post("/api/admin/action", { clientId: currentAdminId, action: "advance" });
      }
    }

    await post("/api/admin/action", { clientId: currentAdminId, action: "advance" });
    const finalState = await waitForState(currentAdminId, (state) => state.room.state === "FINAL_RESULT", "FINAL_RESULT");

    assert(finalState.finalRanking.length === 2, "최종 순위 인원 수가 맞지 않습니다.");
    assert(finalState.finalRanking[0].nickname === "문기", "최종 우승자는 문기여야 합니다.");
    assert(finalState.finalRanking[0].totalPoints === 8, "문기 최종 점수가 예상과 다릅니다.");
    assert(finalState.finalRanking[1].totalPoints === 7, "김대리 최종 점수가 예상과 다릅니다.");

    const report = await getAdminReport(currentAdminId);
    assert(report.finalRanking.length === 2, "리포트 최종 순위 인원 수가 맞지 않습니다.");
    assert(report.roundHistory.length === 5, "리포트 라운드 히스토리 수가 맞지 않습니다.");
    assert(report.roundHistory[0].results[0].nickname === "문기", "1라운드 리포트 우승자가 예상과 다릅니다.");
    assert(report.eventLog.length > 0, "리포트 이벤트 로그가 비어 있습니다.");

    await post("/api/admin/action", { clientId: currentAdminId, action: "advance" });
    await waitForState(currentAdminId, (state) => state.room.state === "ENDED", "ENDED");

    const archiveList = await getArchives(roomCode);
    const archiveEntry = archiveList.archives.find((archive) => archive.roomCode === roomCode);
    assert(Boolean(archiveEntry), "종료 후 아카이브 목록에 대회 기록이 남아야 합니다.");
    assert(archiveEntry.winner?.nickname === "문기", "아카이브 우승자 정보가 예상과 다릅니다.");

    const archiveReport = await getArchiveReport(archiveEntry.id);
    assert(archiveReport.finalRanking[0].nickname === "문기", "아카이브 리포트 우승자가 예상과 다릅니다.");
    assert(archiveReport.roundHistory.length === 5, "아카이브 리포트 라운드 수가 예상과 다릅니다.");

    await post("/api/admin/action", { clientId: currentAdminId, action: "reset-room" });
    const resetState = await waitForState(currentAdminId, (state) => state.room.state === "WAITING", "reset-room");
    assert(resetState.players.every((player) => player.totalPoints === 0), "새 대회 준비 후 점수가 초기화되지 않았습니다.");
    assert(resetState.players.every((player) => player.spectator === false), "새 대회 준비 후 관전자 플래그가 초기화되지 않았습니다.");
    const resetReport = await getAdminReport(currentAdminId);
    assert(resetReport.roundHistory.length === 0, "새 대회 준비 후 라운드 히스토리가 초기화되지 않았습니다.");
    assert(
      resetReport.eventLog.length === 1 && resetReport.eventLog[0].message.includes("새 대회 준비 완료"),
      "새 대회 준비 후 이벤트 로그가 초기화되지 않았습니다."
    );
    const archivedAfterReset = await getArchives("문기");
    assert(archivedAfterReset.archives.some((archive) => archive.id === archiveEntry.id), "reset 후에도 기존 아카이브 검색 결과가 유지되어야 합니다.");

    console.log("Smoke test passed: admin-recover -> waiting -> pause/resume -> rounds -> final -> archives -> report -> ended -> reset-room");
  } finally {
    server.kill("SIGINT");
    await sleep(120);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
