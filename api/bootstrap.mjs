import { buildStateForViewer, reconcileRoomState, resolveViewer } from "../lib/core/stateMachine.mjs";
import { getRoom, listRooms, saveRoom } from "../lib/store/roomStore.mjs";
import { handleApi, jsonResponse, methodNotAllowed, readJsonBody } from "../lib/utils/http.mjs";

async function findRecoverableRoom(viewer) {
  if (viewer.roomCode) {
    return getRoom(viewer.roomCode);
  }

  const rooms = await listRooms();
  return (
    rooms.find((room) => room.adminClientId === viewer.clientId) ||
    rooms.find((room) => [...room.players.values()].some((player) => player.clientId === viewer.clientId || player.id === viewer.playerId)) ||
    null
  );
}

export async function bootstrapRequest(request) {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  const body = await readJsonBody(request);
  const viewerInput = {
    clientId: body.clientId,
    roomCode: body.roomCode,
    role: body.role,
    playerId: body.playerId,
    nickname: body.nickname
  };

  if (!viewerInput.clientId) {
    return jsonResponse(200, {
      ok: true,
      recovered: false,
      session: null,
      home: {
        showAdminStart: true,
        showPlayerJoin: true,
        showTestMode: true
      }
    });
  }

  const room = await findRecoverableRoom({
    ...viewerInput,
    role: body.display ? "display" : viewerInput.role
  });

  if (!room) {
    return jsonResponse(200, {
      ok: true,
      recovered: false,
      session: null,
      home: {
        showAdminStart: true,
        showPlayerJoin: true,
        showTestMode: true
      }
    });
  }

  reconcileRoomState(room);
  const viewer = resolveViewer(room, {
    ...viewerInput,
    role: body.display ? "display" : viewerInput.role
  });
  await saveRoom(room);

  if (!viewer.roomCode || viewer.role === "guest") {
    return jsonResponse(200, {
      ok: true,
      recovered: false,
      session: null,
      home: {
        showAdminStart: true,
        showPlayerJoin: true,
        showTestMode: true
      }
    });
  }

  return jsonResponse(200, {
    ok: true,
    recovered: true,
    session: viewer,
    snapshot: buildStateForViewer(room, viewer),
    home: {
      showAdminStart: true,
      showPlayerJoin: true,
      showTestMode: true
    }
  });
}

export default async function handler(request, response) {
  await handleApi(bootstrapRequest, request, response);
}
