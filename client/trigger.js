// Pure trigger-state machine shared by the local input layer and the tests.
//
// The browser sends one SHOOT packet per trigger pull for semi-automatic
// weapons, and repeats while the button is held only when the server marks the
// active weapon as automatic. Keeping this logic out of main.js means the rule
// can be unit-tested without a DOM or a WebGL context.
export class WeaponTrigger {
  constructor() {
    this.held = false;
    this.armed = false;
    this.weaponId = null;
    this.auto = false;
  }

  /**
   * Register a fresh trigger pull. Always returns true so the caller can fire
   * immediately; whether the shot is legal is decided by the firing code.
   * @returns {boolean}
   */
  press() {
    this.held = true;
    this.armed = true;
    return true;
  }

  /** Register a trigger release. Holding stops repeating until the next pull. */
  release() {
    this.held = false;
    this.armed = false;
  }

  /**
   * Synchronize with the authoritative active weapon. Switching to another
   * weapon while the button is held disarms repetition so a weapon swap can
   * never fire the new gun without a fresh trigger pull.
   * @param {string|null} weaponId
   * @param {boolean} auto
   */
  sync(weaponId, auto) {
    const nextWeaponId = weaponId ?? null;
    if (nextWeaponId !== this.weaponId) {
      this.weaponId = nextWeaponId;
      this.armed = false;
    }
    this.auto = auto === true;
  }

  /** True when a held trigger should keep firing the current automatic weapon. */
  get shouldRepeat() {
    return this.held && this.armed && this.auto;
  }

  /** Forget all input state, e.g. on death, disconnect, or pointer-lock loss. */
  reset() {
    this.held = false;
    this.armed = false;
  }
}
