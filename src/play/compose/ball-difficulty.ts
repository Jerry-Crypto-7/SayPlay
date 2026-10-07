/** Shared visible deadline and physical shot recovery, identical for every player. */
export const BALL_DIFFICULTY: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  'ball.defeat': { targets: 3, paceSeconds: 10, shotRecoveryTicks: 225, shotRecoveryRiseTicks: 8 },
  'ball.score': { targets: 5, paceSeconds: 15, shotRecoveryTicks: 168, shotRecoveryRiseTicks: 4 },
  'ball.score+rival': { targets: 5, paceSeconds: 16, shotRecoveryTicks: 178, shotRecoveryRiseTicks: 4 },
};
