import * as THREE from 'three';

// Only assets that actually exist are declared here, and they are declared as
// bundler imports rather than runtime strings.
//
// The previous revision hardcoded `/assets/map/arena_map.glb`,
// `/assets/animations/animations.glb` and `/assets/weapons/rifle.glb`. None of
// those files exist in this repository: the map ships as `map-assets.glb`, the
// animations ship as five separate `Animation_N.glb` files, and there is no
// `rifle` weapon anywhere in the game. Each request therefore 404'd in the
// browser, and every loader swallowed the error and assigned `null`, so the
// failure was invisible except in the network panel - which is what "asset 404s"
// turned out to mean.
//
// A `?url` import is the fix that prevents a repeat: Vite resolves the specifier
// at build time, so a mistyped or deleted asset fails `npm run build` instead of
// silently 404ing for every player. This is the same mechanism `weapons.js`
// already uses successfully for the seven weapon GLBs.
import characterModelUrl from './assets/characters/character.glb?url';

export const ASSET_PATHS = Object.freeze({
  character: characterModelUrl,
});

// Kept for the intended animation contract; see loadAnimations() for why no clip
// currently satisfies it.
export const ANIMATION_MAP = Object.freeze({
  idle: 'Idle',
  run: 'Run',
  shoot: 'Shoot',
  reload: 'Reload',
  death: 'Death',
  jump: 'Jump',
  crouch: 'Crouch',
});

/**
 * Load the presentation assets the lobby actually consumes.
 *
 * Deliberately small. Two asset loads that used to be attempted here were
 * removed rather than repathed, because the data is unusable and shipping it is
 * not free:
 *
 * - **Map (3.0 MB).** `getMap()` has no callers. `world.js` builds the arena
 *   procedurally, so the file was fetched, assigned, and never read.
 * - **Animations (13 MB).** Inspecting the five `Animation_N.glb` files shows
 *   every clip is named `mixamo.com`, `mixamo.com.001`, ... so `ANIMATION_MAP`
 *   can never match, and each file carries its own `mixamorig:*` skeleton while
 *   `character.glb` ships a different rig with zero animations. Clips from those
 *   files cannot drive the loaded character.
 *
 * Restoring animation playback is an art-pipeline task, not a path edit: either
 * re-export one GLB whose clips are named to `ANIMATION_MAP` and retargeted to
 * `character.glb`'s rig, or render the rig that ships inside an
 * `Animation_N.glb` and drop `character.glb`. Both need a decision about which
 * of the five files is authoritative, so it is left to a designer rather than
 * guessed at here.
 */
export class AssetManager {
  constructor() {
    this.assets = {
      character: null,
    };
    this.animationMixer = null;
    this.animations = {};
    this.loaded = false;
    // What a player-facing "asset 404" actually was: a silent null. Failures are
    // recorded and reported instead of only written to the console.
    this.status = { requested: Object.keys(ASSET_PATHS), loaded: [], failed: [] };
    this.glbLoader = null;
  }

  async init() {
    if (this.initialized) return this.loadPromise;
    this.initialized = true;
    this.loadPromise = this.loadAll();
    return this.loadPromise;
  }

  async loadAll() {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    this.glbLoader = new GLTFLoader();
    await this.loadCharacter();
    this.loaded = this.status.failed.length === 0;
    return this.loaded;
  }

  async loadCharacter() {
    try {
      const glb = await this.glbLoader.loadAsync(ASSET_PATHS.character);
      this.assets.character = glb.scene;
      this.setupCharacterMaterials(this.assets.character);
      this.status.loaded.push('character');
    } catch (error) {
      console.error('[AssetManager] Failed to load character:', error);
      this.assets.character = null;
      this.status.failed.push('character');
    }
  }

  setupCharacterMaterials(scene) {
    scene.traverse((child) => {
      if (!child.isMesh) return;
      child.castShadow = true;
      child.receiveShadow = true;
      if (!child.material) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (!material?.emissive) continue;
        material.emissive.setHex(0x00f0ff);
        material.emissiveIntensity = 0.08;
      }
    });
  }

  getCharacter() {
    return this.assets.character;
  }

  /**
   * Always null until an animation source exists (see the class comment).
   * Callers already treat a missing clip as "skip this action", so the lobby
   * renders the character unanimated instead of erroring.
   */
  getAnimation(state) {
    if (!this.warnedAboutAnimations && state) {
      this.warnedAboutAnimations = true;
      console.info('[AssetManager] No animation clips are available for this rig; the lobby character renders in its bind pose. See AssetManager.js for the asset-pipeline fix.');
    }
    return this.animations[state] ?? null;
  }

  playAnimation(state, mesh) {
    const clip = this.getAnimation(state);
    if (!clip || !mesh || !this.animationMixer) return null;
    const action = this.animationMixer.clipAction(clip);
    action.play();
    return action;
  }

  update(delta) {
    this.animationMixer?.update(delta);
  }

  getAnimationMixer() {
    return this.animationMixer;
  }

  /** True when every requested asset resolved, for callers that gate on it. */
  get ready() {
    return this.loaded;
  }
}

// Singleton instance
export const assetManager = new AssetManager();
