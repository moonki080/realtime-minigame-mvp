import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const port = 4321;
const baseUrl = `http://127.0.0.1:${port}`;
const cwd = path.dirname(fileURLToPath(import.meta.url));

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${path}`);
  }
  return payload;
}

async function waitFor(check, timeoutMs = 12000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await check();
    if (result) {
      return result;
    }
    await delay(120);
  }
  throw new Error("Timed out while waiting for condition.");
}

async function main() {
  const server = spawn("node", ["server.mjs"], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      INTRO_MS: "250",
      RESULT_MS: "300",
      GAME_DURATION_SCALE: "0.05"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let serverOutput = "";
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  try {
    await waitFor(async () => {
      try {
        const health = await request("/healthz");
        return health.ok;
      } catch {
        return false;
      }
    }, 8000);

    const alice = await request("/api/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: "Alice" })
    });
    const bob = await request("/api/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: "Bob" })
    });

    const lobby = await request(`/api/state?playerId=${alice.playerId}`);
    if (!lobby.canStart || lobby.playerCount !== 2) {
      throw new Error("Lobby did not initialize correctly.");
    }

    await request("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: alice.playerId })
    });

    for (let roundNumber = 1; roundNumber <= 5; roundNumber += 1) {
      await waitFor(async () => {
        const state = await request(`/api/state?playerId=${alice.playerId}`);
        return state.phase === "main" && state.round?.number === roundNumber ? state : false;
      });

      await request("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerId: alice.playerId,
          roundNumber,
          mode: "main",
          score: 1000 - roundNumber * 5,
          details: {
            label: "테스트 제출",
            summary: "Alice"
          }
        })
      });

      await request("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerId: bob.playerId,
          roundNumber,
          mode: "main",
          score: 500 - roundNumber * 5,
          details: {
            label: "테스트 제출",
            summary: "Bob"
          }
        })
      });

      const resultState = await waitFor(async () => {
        const state = await request(`/api/state?playerId=${alice.playerId}`);
        return state.phase === "result" && state.round?.number === roundNumber ? state : false;
      });

      if (resultState.roundResults.length !== 2 || resultState.roundResults[0]?.nickname !== "Alice") {
        throw new Error(`Round ${roundNumber} result ranking is invalid.`);
      }
    }

    const finalState = await waitFor(async () => {
      const state = await request(`/api/state?playerId=${alice.playerId}`);
      return state.phase === "final" ? state : false;
    }, 12000);

    if (finalState.finalRanking[0]?.nickname !== "Alice" || finalState.finalRanking.length !== 2) {
      throw new Error("Final ranking is invalid.");
    }

    const resetState = await request("/api/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: alice.playerId })
    });

    if (resetState.phase !== "lobby" || resetState.playerCount !== 2) {
      throw new Error("Reset did not return the app to the lobby.");
    }

    console.log("Smoke test passed: join -> lobby -> 5 rounds -> final -> reset");
  } finally {
    server.kill("SIGINT");
    await delay(150);
    if (!server.killed) {
      server.kill("SIGKILL");
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
