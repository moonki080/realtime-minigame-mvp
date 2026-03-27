import { ALL_GAME_IDS, GAME_DEFINITIONS, PLAYER_STATES, ROOM_STATES, hashString, selectGames } from "../../public/shared/gameData.mjs";

export { ALL_GAME_IDS, GAME_DEFINITIONS, PLAYER_STATES, ROOM_STATES, hashString, selectGames };

export function getGameDefinition(gameId) {
  const game = GAME_DEFINITIONS[gameId];
  if (!game) {
    throw new Error(`알 수 없는 게임 ID입니다: ${gameId}`);
  }
  return game;
}

export function buildGameConfig(gameId, mode, seed) {
  return getGameDefinition(gameId).buildChallenge(seed, mode);
}
