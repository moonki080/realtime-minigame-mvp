export function cloneMetrics(metrics) {
  return metrics
    ? {
        label: metrics.label,
        summary: metrics.summary
      }
    : null;
}

export function sortRankedEntries(entries) {
  return [...entries].sort((left, right) => {
    const leftVector = left.rankVector ?? [left.score ?? 0];
    const rightVector = right.rankVector ?? [right.score ?? 0];
    const maxLength = Math.max(leftVector.length, rightVector.length);
    for (let index = 0; index < maxLength; index += 1) {
      const leftValue = Number(leftVector[index] ?? 0);
      const rightValue = Number(rightVector[index] ?? 0);
      if (leftValue !== rightValue) {
        return rightValue - leftValue;
      }
    }
    return Number(left.completedAt ?? Number.MAX_SAFE_INTEGER) - Number(right.completedAt ?? Number.MAX_SAFE_INTEGER);
  });
}

export function rankPlayersForFinal(room) {
  return [...room.lockedPlayerIds]
    .map((playerId) => room.players.get(playerId))
    .filter(Boolean)
    .sort((left, right) => {
      if (left.totalPoints !== right.totalPoints) {
        return right.totalPoints - left.totalPoints;
      }
      if (left.roundWins !== right.roundWins) {
        return right.roundWins - left.roundWins;
      }
      if (left.secondPlaces !== right.secondPlaces) {
        return right.secondPlaces - left.secondPlaces;
      }
      const leftLastPlacement = left.placements[left.placements.length - 1] ?? Number.MAX_SAFE_INTEGER;
      const rightLastPlacement = right.placements[right.placements.length - 1] ?? Number.MAX_SAFE_INTEGER;
      if (leftLastPlacement !== rightLastPlacement) {
        return leftLastPlacement - rightLastPlacement;
      }
      return left.joinedAt - right.joinedAt;
    })
    .map((player, index) => ({
      playerId: player.id,
      nickname: player.nickname,
      totalPoints: player.totalPoints,
      rank: index + 1,
      roundWins: player.roundWins,
      secondPlaces: player.secondPlaces
    }));
}

export function buildRoundHistoryEntry(room, round, standings, publishedAt) {
  return {
    roundIndex: round.roundIndex,
    roundNumber: round.roundIndex + 1,
    gameId: round.gameId,
    title: round.title,
    description: round.description,
    intro: round.intro,
    prize: round.prize,
    practiceEnabled: round.practiceEnabled,
    practiceSubmittedCount: round.practiceSubmissions.size,
    mainSubmittedCount: round.mainSubmissions.size,
    results: round.results.map((entry) => ({
      rank: entry.rank,
      tournamentPoints: entry.tournamentPoints,
      playerId: entry.playerId,
      nickname: entry.nickname,
      score: entry.score,
      metrics: cloneMetrics(entry.metrics),
      prizeWinner: entry.prizeWinner
    })),
    standings: standings.map((entry) => ({
      playerId: entry.playerId,
      nickname: entry.nickname,
      totalPoints: entry.totalPoints,
      rank: entry.rank,
      roundWins: entry.roundWins,
      secondPlaces: entry.secondPlaces
    })),
    publishedAt
  };
}
