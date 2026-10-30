// Server-owned combat volumes, in metres relative to the player's feet.
// The equipped character measures ~1.81m tall, with head/neck joints at
// 1.599/1.503m and shoulders at 1.441m (client/operator.js). The 0.42m
// upper envelope includes animated shoulders/arms; the tighter head remains
// deliberately more precise. These are NOT movement collision dimensions.
export const COMBAT_HITBOXES = Object.freeze([
  Object.freeze({ name: 'lower', radius: 0.38, bottom: 0.12, top: 1.04, headshot: false }),
  Object.freeze({ name: 'upper', radius: 0.42, bottom: 1.04, top: 1.49, headshot: false }),
  Object.freeze({ name: 'head', radius: 0.26, bottom: 1.49, top: 1.80, headshot: true }),
]);
