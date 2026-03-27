import { createServer } from "node:http";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { routeApiRequest } from "./lib/simple-game-api.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 4310);
const host = process.env.HOST || "0.0.0.0";

async function serveStaticFile(response, pathname) {
  const safePath = path.normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);
  const fileInfo = await stat(filePath);
  if (!fileInfo.isFile()) {
    throw new Error("not-file");
  }

  const data = await readFile(filePath);
  const extension = path.extname(filePath);
  const typeMap = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };

  response.writeHead(200, {
    "Content-Type": typeMap[extension] || "application/octet-stream"
  });
  response.end(data);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

const server = createServer(async (request, response) => {
  try {
    if (!request.url) {
      sendJson(response, 400, { ok: false, error: "잘못된 요청입니다." });
      return;
    }

    if (request.url === "/healthz" || request.url.startsWith("/api/")) {
      await routeApiRequest(request, response);
      return;
    }

    if (request.method === "GET") {
      await serveStaticFile(response, request.url === "/" ? "/index.html" : request.url);
      return;
    }

    sendJson(response, 404, { ok: false, error: "요청한 경로를 찾을 수 없습니다." });
  } catch (error) {
    if (error instanceof Error && error.message === "not-file") {
      sendJson(response, 404, { ok: false, error: "파일을 찾을 수 없습니다." });
      return;
    }
    sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : "요청 처리 중 오류가 발생했습니다." });
  }
});

server.listen(port, host, () => {
  console.log(`Simple realtime minigame server running on http://127.0.0.1:${port}`);
  console.log(`Bind host: ${host}`);
  console.log(`Mode: single room, in-memory only`);
});

function gracefulShutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
