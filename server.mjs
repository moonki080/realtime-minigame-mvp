import { createServer } from "node:http";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import bootstrapHandler from "./api/bootstrap.mjs";
import roomHandler from "./api/room.mjs";
import roundHandler from "./api/round.mjs";
import playerHandler from "./api/player.mjs";
import leaderboardHandler from "./api/leaderboard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 4310);
const host = process.env.HOST || "0.0.0.0";
let shuttingDown = false;

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

async function serveFile(response, baseDir, pathname) {
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(normalizedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(baseDir, safePath);
  const fileStat = await stat(filePath);

  if (!fileStat.isFile()) {
    throw new Error("not-file");
  }

  const data = await readFile(filePath);
  const ext = path.extname(filePath);
  const typeMap = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png"
  };

  response.writeHead(200, {
    "Content-Type": typeMap[ext] || "application/octet-stream"
  });
  response.end(data);
}

function buildHealthPayload() {
  return {
    ok: !shuttingDown,
    shuttingDown,
    timestamp: Date.now(),
    runtime: "local-node-adapter"
  };
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/healthz") {
      json(response, 200, buildHealthPayload());
      return;
    }

    if (request.method === "GET" && request.url === "/readyz") {
      json(response, shuttingDown ? 503 : 200, buildHealthPayload());
      return;
    }

    if (request.url?.startsWith("/api/bootstrap")) {
      await bootstrapHandler(request, response);
      return;
    }

    if (request.url?.startsWith("/api/room")) {
      await roomHandler(request, response);
      return;
    }

    if (request.url?.startsWith("/api/round")) {
      await roundHandler(request, response);
      return;
    }

    if (request.url?.startsWith("/api/player")) {
      await playerHandler(request, response);
      return;
    }

    if (request.url?.startsWith("/api/leaderboard")) {
      await leaderboardHandler(request, response);
      return;
    }

    if (request.method === "GET" && (request.url === "/" || request.url?.startsWith("/public/") || request.url?.startsWith("/app.") || request.url?.startsWith("/styles.") || request.url?.startsWith("/games."))) {
      await serveFile(response, publicDir, request.url === "/" ? "/index.html" : request.url.replace("/public", ""));
      return;
    }

    if (request.method === "GET") {
      await serveFile(response, publicDir, request.url || "/index.html");
      return;
    }

    json(response, 404, { error: "요청한 경로를 찾을 수 없습니다." });
  } catch (error) {
    if (error instanceof Error && error.message === "not-file") {
      json(response, 404, { error: "파일을 찾을 수 없습니다." });
      return;
    }
    json(response, 400, { error: error instanceof Error ? error.message : "요청 처리 중 오류가 발생했습니다." });
  }
});

server.listen(port, host, () => {
  console.log(`Realtime minigame MVP server running on http://127.0.0.1:${port}`);
  console.log(`Bind host: ${host}`);
  console.log(`Runtime mode: local adapter for /api functions`);
  console.log(`Room store: ${process.env.ROOM_STORE_URL ? "external" : "in-memory fallback"}`);
});

function gracefulShutdown(signal) {
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down local adapter...`);
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
