import { parse as parseUrl } from "node:url";

export async function readJsonBody(request) {
  if (typeof request.body === "object" && request.body !== null) {
    return request.body;
  }

  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function jsonResponse(status, payload) {
  return {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(payload)
  };
}

export function sendNodeResponse(response, result) {
  response.writeHead(result.status, result.headers);
  response.end(result.body);
}

export function getQuery(request) {
  if (request.query) {
    return request.query;
  }
  const parsed = parseUrl(request.url || "", true);
  return parsed.query || {};
}

export function methodNotAllowed(allowed = ["GET"]) {
  return jsonResponse(405, {
    error: `허용되지 않은 메서드입니다. (${allowed.join(", ")})`
  });
}

export async function handleApi(handler, request, response) {
  try {
    const result = await handler(request, response);
    if (response?.writableEnded) {
      return;
    }
    sendNodeResponse(response, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "요청 처리 중 오류가 발생했습니다.";
    sendNodeResponse(response, jsonResponse(400, { error: message }));
  }
}
