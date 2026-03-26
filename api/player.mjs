import { buildStateForViewer, reconcileRoomState, resolveViewer } from "../lib/core/stateMachine.mjs";
import { getRoom, saveRoom } from "../lib/store/roomStore.mjs";
import { getQuery, handleApi, jsonResponse, methodNotAllowed } from "../lib/utils/http.mjs";

export async function playerRequest(request) {
  if (request.method !== "GET") {
    return methodNotAllowed(["GET"]);
  }

  const query = getQuery(request);
  const viewerInput = {
    clientId: query.clientId,
    roomCode: query.roomCode,
    role: query.role,
    playerId: query.playerId,
    nickname: query.nickname
  };

  if (!viewerInput.clientId || !viewerInput.roomCode) {
    return jsonResponse(200, {
      room: null,
      viewer: {
        clientId: viewerInput.clientId || null,
        role: null,
        roomCode: viewerInput.roomCode || null,
        playerId: viewerInput.playerId || null,
        nickname: viewerInput.nickname || null
      }
    });
  }

  const room = await getRoom(viewerInput.roomCode);
  if (!room) {
    return jsonResponse(200, {
      room: null,
      viewer: {
        clientId: viewerInput.clientId,
        role: null,
        roomCode: null,
        playerId: null,
        nickname: viewerInput.nickname || null
      }
    });
  }

  reconcileRoomState(room);
  const viewer = resolveViewer(room, viewerInput);
  await saveRoom(room);
  return jsonResponse(200, buildStateForViewer(room, viewer));
}

export default async function handler(request, response) {
  await handleApi(playerRequest, request, response);
}
