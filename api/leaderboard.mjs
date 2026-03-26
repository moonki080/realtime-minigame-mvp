import { buildLeaderboardView, reconcileRoomState } from "../lib/core/stateMachine.mjs";
import { getRoom } from "../lib/store/roomStore.mjs";
import { getQuery, handleApi, jsonResponse, methodNotAllowed } from "../lib/utils/http.mjs";

export async function leaderboardRequest(request) {
  if (request.method !== "GET") {
    return methodNotAllowed(["GET"]);
  }

  const query = getQuery(request);
  const room = await getRoom(query.roomCode);
  if (!room) {
    throw new Error("방을 찾을 수 없습니다.");
  }

  reconcileRoomState(room);
  return jsonResponse(200, {
    ok: true,
    leaderboard: buildLeaderboardView(room)
  });
}

export default async function handler(request, response) {
  await handleApi(leaderboardRequest, request, response);
}
