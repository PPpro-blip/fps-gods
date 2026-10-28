// Client-only viewmodel alignment and camera optics. These values never affect
// server hit validation. No existing model has a verified usable optical scope,
// so even the sniper uses a normal sight picture, not a fake black overlay.
export const ADS_PROFILES = Object.freeze({
  SMG: Object.freeze({ fov: 61, durationMs: 180, offset: Object.freeze([0, -0.225, -0.72]), scope: null }),
  SHOTGUN: Object.freeze({ fov: 63, durationMs: 210, offset: Object.freeze([0, -0.076, -0.76]), scope: null }),
  PISTOL: Object.freeze({ fov: 62, durationMs: 150, offset: Object.freeze([0, -0.185, -0.66]), scope: null }),
  SNIPER: Object.freeze({ fov: 48, durationMs: 240, offset: Object.freeze([0, -0.104, -0.85]), scope: null }),
  LMG: Object.freeze({ fov: 60, durationMs: 220, offset: Object.freeze([0, -0.175, -0.79]), scope: null }),
  ROCKET: Object.freeze({ fov: 64, durationMs: 230, offset: Object.freeze([0, -0.189, -0.78]), scope: null }),
  RAILGUN: Object.freeze({ fov: 54, durationMs: 210, offset: Object.freeze([0, -0.175, -0.79]), scope: null }),
  MINIGUN: Object.freeze({ fov: 63, durationMs: 240, offset: Object.freeze([0, -0.175, -0.79]), scope: null }),
});

export class AimController {
  constructor(camera, effects, hipFov = 77) {
    this.camera = camera;
    this.effects = effects;
    this.hipFov = hipFov;
    this.weaponId = null;
    this.visualProfile = null;
    this.held = false;
    this.amount = 0;
  }

  setHipFov(fov) {
    if (Number.isFinite(fov) && fov > 0) this.hipFov = fov;
  }

  setWeapon(weaponId) {
    if (weaponId === this.weaponId) return;
    this.weaponId = weaponId;
    this.held = false;
    // Retain the old sight while lowering it. It will be replaced on a fresh
    // press, preventing a switch from immediately jumping back to hip FOV.
    if (this.amount === 0) this.visualProfile = ADS_PROFILES[weaponId] ?? null;
  }

  setHeld(held) {
    const profile = ADS_PROFILES[this.weaponId];
    this.held = Boolean(held && profile);
    if (this.held) this.visualProfile = profile;
  }

  reset(immediate = false) {
    this.held = false;
    if (immediate) this.amount = 0;
  }

  update(deltaSeconds) {
    const delta = Math.max(0, Math.min(1, Number(deltaSeconds) || 0));
    const profile = this.visualProfile;
    const step = delta * 1000 / (profile?.durationMs ?? 180);
    this.amount = this.held ? Math.min(1, this.amount + step) : Math.max(0, this.amount - step);
    const eased = this.amount * this.amount * (3 - 2 * this.amount);
    const sightFov = Math.min(profile?.fov ?? this.hipFov, this.hipFov - 5);
    const targetFov = this.hipFov + (sightFov - this.hipFov) * eased;
    // Profile changes and settings changes cannot abruptly jump the lens.
    const blend = 1 - Math.exp(-18 * delta);
    const nextFov = this.camera.fov + (targetFov - this.camera.fov) * blend;
    if (Math.abs(nextFov - this.camera.fov) > 0.0001) {
      this.camera.fov = nextFov;
      this.camera.updateProjectionMatrix();
    }
    this.effects.setAim(eased, profile);
    if (this.amount === 0 && !this.held) this.visualProfile = ADS_PROFILES[this.weaponId] ?? null;
  }
}
