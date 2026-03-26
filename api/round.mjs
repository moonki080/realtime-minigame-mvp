import { applyRoundAction, buildStateForViewer, receiveSubmission, reconcileRoomState, resolveViewer } from "../lib/core/stateMachine.mjs";
import { getRoom, saveRoom } from "../lib/store/roomStore.mjs";
import { handleApi, jsonResponse, methodNotAllowed, readJsonBody } from "../lib/utils/http.mjs";

function normalizeRoundAction(action) {
  switch (action) {
    case "start-tournament":
      return "startTournament";
    case "reroll-games":
      return "rerollGames";
    case "start-practice":
      return "startPractice";
    case "skip-practice":
      return "skipPractice";
    case "start-main":
      return "startMain";
    case "restart-round":
      return "restartRound";
    case "reset-room":
      return "resetRoom";
    case "remove-player":
      return "removePlayer";
    case "update-prize":
      return "updatePrize";
    default:
      return action;
  }
}

export async function roundRequest(request) {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  const body = await readJsonBody(request);
  const room = await getRoom(body.roomCode);
  if (!room) {
    throw new Error("방을 찾을 수 없습니다.");
  }

  reconcileRoomState(room);
  const session = resolveViewer(room, {
    clientId: body.clientId,
    roomCode: body.roomCode,
    role: body.role,
    playerId: body.playerId,
    nickname: body.nickname
  });

  if (body.action === "submit") {
    receiveSubmission(room, session, {
      mode: body.mode,
      score: body.score,
      rankVector: body.rankVector,
      completedAt: body.completedAt,
      metrics: body.metrics
    });
  } else {
    applyRoundAction(room, session, {
      ...body,
      action: normalizeRoundAction(body.action)
    });
  }

  reconcileRoomState(room);
  await saveRoom(room);

  return jsonResponse(200, {
    ok: true,
    session,
    snapshot: buildStateForViewer(room, resolveViewer(room, session))
  });
}

export default async function handler(request, response) {
  await handleApi(roundRequest, request, response);
}
