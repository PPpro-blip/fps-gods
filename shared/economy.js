export const CURRENCY_CONFIG = Object.freeze({
  id: 'credits',
  name: 'SHARZS',
  singularName: 'SHARZS',
  shortCode: 'SHARZS',
  symbol: '◈',
  maxBalance: 1_000_000_000,
  maxSingleAward: 10_000,
  rewards: Object.freeze({
    eliminationMultiplayer: 15,
    eliminationSoloBots: 5,
    headshotBonus: 5,
    assist: 5,
    matchCompletion: 25,
    matchVictory: 50,
  }),
  antiFarming: Object.freeze({
    assistWindowMs: 8_000,
    assistMinDamage: 20,
    sameVictimWindowMs: 120_000,
    maxRewardedKillsPerVictimWindow: 5,
    botKillWindowMs: 300_000,
    maxBotKillCreditsPerWindow: 250,
    minMatchParticipationMs: 15_000,
  }),
});

export const REWARD_REASONS = Object.freeze({
  ELIMINATION: 'elimination',
  ASSIST: 'assist',
  MATCH_COMPLETION: 'match_completion',
  MATCH_VICTORY: 'match_victory',
});

export function formatCredits(amount, { compact = false, includeName = false } = {}) {
  const safe = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
  const formatted = compact && safe >= 10_000
    ? `${(safe / 1000).toFixed(safe >= 100_000 ? 0 : 1)}K`
    : safe.toLocaleString('en-US');
  if (includeName) {
    return `${CURRENCY_CONFIG.symbol} ${formatted} ${safe === 1 ? CURRENCY_CONFIG.singularName : CURRENCY_CONFIG.name}`;
  }
  return `${CURRENCY_CONFIG.symbol} ${formatted}`;
}
