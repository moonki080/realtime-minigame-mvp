import { buildGameConfig, getGameDefinition, hashString } from "./gameRegistry.mjs";

export function buildRound(room, roundIndex) {
  const gameId = room.selectedGameIds[roundIndex];
  const game = getGameDefinition(gameId);
  const practiceSeed = hashString(`${room.code}-${roundIndex}-${gameId}-practice`);
  const mainSeed = hashString(`${room.code}-${roundIndex}-${gameId}-main`);

  return {
    roundIndex,
    gameId,
    title: game.title,
    description: game.description,
    intro: game.intro,
    prize: room.prizes[roundIndex] || "",
    practiceSeed,
    mainSeed,
    practiceConfig: buildGameConfig(gameId, "practice", practiceSeed),
    mainConfig: buildGameConfig(gameId, "main", mainSeed),
    practiceSubmissions: new Map(),
    mainSubmissions: new Map(),
    practiceStartedAt: null,
    practiceEndsAt: null,
    mainIntroEndsAt: null,
    mainStartedAt: null,
    mainEndsAt: null,
    scoringReadyAt: null,
    practiceEnabled: true,
    results: []
  };
}
