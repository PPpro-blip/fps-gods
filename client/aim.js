// Client-only viewmodel alignment and camera optics. These values never affect
// server hit validation.
//
// Profiles differentiate:
//  - Standard iron / reflex sights (`scope: null, reticle: 'iron'`)
//  - RPG launcher open ranging sight (`scope: null, reticle: 'launcher'`)
//  - Precision railgun optic (`scope: 'rail', reticle: 'rail'`)
//  - Magnified optical sniper scope (`scope: 'optic', reticle: 'optic'`)
//  - Non-ADS melee / shield / utility (omitted from ADS_PROFILES)
export const ADS_PROFILES = Object.freeze({
  SMG: Object.freeze({
    fov: 61,
    durationMs: 170,
    offset: Object.freeze([0, -0.154, -0.68]),
    scope: null,
    reticle: 'iron',
    magnification: '1.25×',
  }),
  SHOTGUN: Object.freeze({
    fov: 63,
    durationMs: 200,
    offset: Object.freeze([0, -0.065, -0.74]),
    scope: null,
    reticle: 'iron',
    magnification: '1.2×',
  }),
  PISTOL: Object.freeze({
    fov: 62,
    durationMs: 145,
    offset: Object.freeze([0, -0.121, -0.64]),
    scope: null,
    reticle: 'iron',
    magnification: '1.2×',
  }),
  SNIPER: Object.freeze({
    fov: 36,
    durationMs: 220,
    offset: Object.freeze([0, -0.095, -0.85]),
    scope: 'optic',
    reticle: 'optic',
    magnification: '4.0×',
  }),
  LMG: Object.freeze({
    fov: 60,
    durationMs: 220,
    offset: Object.freeze([0, -0.158, -0.78]),
    scope: null,
    reticle: 'iron',
    magnification: '1.3×',
  }),
  ROCKET: Object.freeze({
    fov: 64,
    durationMs: 230,
    offset: Object.freeze([0, -0.189, -0.78]),
    scope: null,
    reticle: 'launcher',
    magnification: '1.2×',
  }),
  RAILGUN: Object.freeze({
    fov: 50,
    durationMs: 205,
    offset: Object.freeze([0, -0.158, -0.78]),
    scope: 'rail',
    reticle: 'rail',
    magnification: '2.2×',
  }),
  MINIGUN: Object.freeze({
    fov: 63,
    durationMs: 240,
    offset: Object.freeze([0, -0.158, -0.78]),
    scope: null,
    reticle: 'iron',
    magnification: '1.2×',
  }),
});

const OPTICAL_SCOPE_HIDE_THRESHOLD = 0.72;

function computeLookScale(currentFovDeg, baseFovDeg) {
  const baseRad = (Math.max(20, Number(baseFovDeg) || 77) * Math.PI) / 180;
  const curRad = (Math.max(15, Number(currentFovDeg) || baseFovDeg) * Math.PI) / 180;
  const ratio = Math.tan(curRad * 0.5) / Math.tan(baseRad * 0.5);
  return Math.max(0.2, Math.min(1, ratio));
}

export class AimController {
  constructor(camera, effects, hipFovOrOptions = 77) {
    this.camera = camera;
    this.effects = effects;
    if (hipFovOrOptions && typeof hipFovOrOptions === 'object') {
      this.hipFov = Number(hipFovOrOptions.hipFov) || 77;
      this.onStateChange = typeof hipFovOrOptions.onStateChange === 'function'
        ? hipFovOrOptions.onStateChange
        : null;
    } else {
      this.hipFov = Number(hipFovOrOptions) || 77;
      this.onStateChange = null;
    }
    this.weaponId = null;
    this.visualProfile = null;
    this.held = false;
    this.amount = 0;
    this.lookScale = 1;
    this.scopeActive = false;
  }

  get profile() {
    return ADS_PROFILES[this.weaponId] ?? null;
  }

  canAim() {
    return Boolean(ADS_PROFILES[this.weaponId]);
  }

  setHipFov(fov) {
    if (Number.isFinite(fov) && fov > 0) {
      this.hipFov = fov;
      if (this.amount === 0 && !this.held) {
        this.camera.fov = fov;
        this.camera.updateProjectionMatrix();
      }
      this.lookScale = computeLookScale(this.camera.fov, this.hipFov);
    }
  }

  setBaseFov(fov) {
    this.setHipFov(fov);
  }

  setWeapon(weaponId) {
    if (weaponId === this.weaponId) return;
    this.weaponId = weaponId;
    this.held = false;
    // Lower magnified scope immediately on weapon swap so a scoped lens never
    // lingers over a newly equipped knife, shield, or sidearm.
    if (this.visualProfile?.scope) {
      this.amount = 0;
      this.visualProfile = ADS_PROFILES[weaponId] ?? null;
      this.syncPresentation(0, this.visualProfile);
      return;
    }
    if (this.amount === 0) {
      this.visualProfile = ADS_PROFILES[weaponId] ?? null;
      this.syncPresentation(0, this.visualProfile);
    }
  }

  setHeld(held) {
    const profile = ADS_PROFILES[this.weaponId];
    this.held = Boolean(held && profile);
    if (this.held) this.visualProfile = profile;
  }

  reset(immediate = false) {
    this.held = false;
    if (immediate) {
      this.amount = 0;
      this.visualProfile = ADS_PROFILES[this.weaponId] ?? null;
      this.camera.fov = this.hipFov;
      this.camera.updateProjectionMatrix();
      this.syncPresentation(0, this.visualProfile);
    }
  }

  update(deltaSeconds) {
    const delta = Math.max(0, Math.min(1, Number(deltaSeconds) || 0));
    const profile = this.visualProfile;
    const step = (delta * 1000) / (profile?.durationMs ?? 180);
    this.amount = this.held ? Math.min(1, this.amount + step) : Math.max(0, this.amount - step);
    const eased = this.amount * this.amount * (3 - 2 * this.amount);
    const sightFov = Math.min(profile?.fov ?? this.hipFov, this.hipFov - 5);
    const targetFov = this.hipFov + (sightFov - this.hipFov) * eased;
    const blend = delta >= 0.25 ? 1 : 1 - Math.exp(-22 * delta);
    const nextFov = this.camera.fov + (targetFov - this.camera.fov) * blend;
    if (Math.abs(nextFov - this.camera.fov) > 0.0001) {
      this.camera.fov = nextFov;
      this.camera.updateProjectionMatrix();
    }
    if (this.amount === 0 && !this.held) {
      this.visualProfile = ADS_PROFILES[this.weaponId] ?? null;
    }
    this.syncPresentation(eased, this.visualProfile);
  }

  syncPresentation(eased, profile) {
    this.lookScale = this.amount === 0 && !this.held
      ? 1
      : computeLookScale(this.camera.fov, this.hipFov);
    const opticHide = Boolean(profile?.scope === 'optic' && this.amount >= OPTICAL_SCOPE_HIDE_THRESHOLD);
    this.scopeActive = Boolean(profile?.scope && this.amount >= 0.55);
    this.effects?.setAim?.(eased, profile);
    this.effects?.setOpticalScopeHidden?.(opticHide);
    this.onStateChange?.({
      amount: eased,
      rawAmount: this.amount,
      profile,
      scope: profile?.scope ?? null,
      reticle: this.amount > 0.15 ? (profile?.reticle ?? 'iron') : null,
      scopeActive: this.scopeActive,
      opticHide,
      magnification: profile?.magnification ?? null,
      lookScale: this.lookScale,
    });
  }
}
