import { buildStateForViewer, createRoomRecord, joinRoom, recoverAdmin, resolveViewer, roomSummary } from "../lib/core/stateMachine.mjs";
import { generateUniqueRoomCode, getRoom, saveRoom } from "../lib/store/roomStore.mjs";
import { handleApi, jsonResponse, methodNotAllowed, readJsonBody } from "../lib/utils/http.mjs";

export async function roomRequest(request) {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  const body = await readJsonBody(request);
  const action = body.action;
  const viewer = {
    clientId: body.clientId,
    roomCode: body.roomCode,
    role: body.role,
    playerId: body.playerId,
    nickname: body.nickname
  };

  if (!viewer.clientId) {
    throw new Error("clientId가 필요합니다.");
  }

  if (action === "createRoom") {
    const code = await generateUniqueRoomCode();
    const room = createRoomRecord({
      code,
      name: body.name,
      roundCount: body.roundCount,
      prizes: body.prizes,
      adminClientId: viewer.clientId
    });
    await saveRoom(room);
    const session = resolveViewer(room, {
      clientId: viewer.clientId,
      roomCode: room.code,
      role: "admin",
      nickname: "관리자"
    });
    return jsonResponse(200, {
      ok: true,
      session,
      roomCode: room.code,
      adminRecoveryCode: room.adminRecoveryCode,
      snapshot: buildStateForViewer(room, session)
    });
  }

  const room = await getRoom(body.roomCode);
  if (!room) {
    throw new Error("방을 찾을 수 없습니다.");
  }

  if (action === "joinRoom") {
    const session = joinRoom(room, viewer, body);
    await saveRoom(room);
    return jsonResponse(200, {
      ok: true,
      session,
      roomCode: room.code,
      snapshot: buildStateForViewer(room, resolveViewer(room, session))
    });
  }

  if (action === "recoverAdmin") {
    const session = recoverAdmin(room, viewer, String(body.recoveryCode || "").trim().toUpperCase());
    await saveRoom(room);
    return jsonResponse(200, {
      ok: true,
      session,
      roomCode: room.code,
      snapshot: buildStateForViewer(room, resolveViewer(room, session))
    });
  }

  if (action === "getRoomSummary") {
    const session = resolveViewer(room, viewer);
    await saveRoom(room);
    return jsonResponse(200, {
      ok: true,
      session,
      room: roomSummary(room)
    });
  }

  throw new Error("지원하지 않는 room 액션입니다.");
}

export default async function handler(request, response) {
  await handleApi(roomRequest, request, response);
}
