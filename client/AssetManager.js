import * as THREE from 'three';
import { buildAnimationSet, CharacterRig } from './animation.js';

// Gameplay-critical GLB assets.
//
// `map/arena_map.glb` is a modular sci-fi environment kit (floors, walls,
// columns, props) rather than a pre-assembled level; `MenuStage` instances those
// modules. `characters/character.glb` already contains the full 12-clip
// animation set, so the separate `animations/*.glb` files (which are byte
// duplicates or subsets) are intentionally not downloaded at runtime.
//
// The URLs themselves come from `client/assetUrls.js`, where Vite's `?url`
// imports turn them into content-hashed build output. The constants below are
// only the fallback for environments without a bundler (the Node test suite),
// and they are always reported in diagnostics so a 404 can be traced to the URL
// that was actually requested.
export const PUBLIC_ASSET_PATHS = Object.freeze({
  character: '/assets/characters/character.glb',
  map: '/assets/map/arena_map.glb',
});

export const ASSET_LABELS = Object.freeze({
  character: 'Operator model',
  map: 'Environment kit',
});

export const KIT_MODULES = Object.freeze({
  floor: 'FloorTile_Basic',
  floorDouble: 'FloorTile_Double',
  wall: 'Wall_1',
  wallWindow: 'Window_Wall_SideA',
  wallDoor: 'DoorSingle_Wall_SideA',
  column: 'Column_3',
  crate: 'Props_Crate',
  container: 'Props_CrateLong',
  pod: 'Props_Pod',
  statue: 'Props_Statue',
  computer: 'Props_Computer',
  shelf: 'Props_Shelf',
  lamp: 'Details_Light',
});

const ASSET_ADVICE = Object.freeze({
  'http-404': 'the deployed build does not contain this file — check that it is committed and rebuilt',
  'html-instead-of-glb': 'the host returned the SPA HTML page instead of the asset (usually a missing file plus a catch-all route)',
  'not-glb': 'the response is not a GLB — the deployed file is not the asset this build expects',
  'unreadable-glb': 'the file downloaded but could not be parsed as a GLB',
  'unreadable-body': 'the response body could not be read',
  'network-error': 'the request failed before a response arrived (offline, blocked, or wrong origin)',
  'unresolved-urls': 'the build did not provide asset URLs — the client was booted without the Vite bundler',
  unverifiable: 'the browser could not verify the URL',
  unknown: 'the asset did not load',
});

/**
 * Loads every GLB the client needs exactly once and hands out cheap clones.
 *
 * Failure is reported, never thrown at the render loop: the game is still
 * playable with procedural operators if the character asset is unavailable, and
 * the menu stage falls back to a plain backdrop.
 */
export class AssetManager {
  constructor() {
    this.assets = { character: null, map: null };
    this.characterGltf = null;
    this.animationSet = null;
    this.kitModules = new Map();
    this.disposables = new Set();
    this.status = { requested: ['character', 'map'], loaded: [], failed: [] };
    this.failures = [];
    this.sources = { character: null, map: null };
    this.urlSource = 'unresolved';
    this.progress = { loaded: 0, total: 2, label: 'CONNECTING' };
    this.listeners = new Set();
    this.initialized = false;
    this.loadPromise = null;
    this.glbLoader = null;
  }

  async init() {
    if (this.initialized) return this.loadPromise;
    this.initialized = true;
    this.loadPromise = this.loadAll();
    return this.loadPromise;
  }

  async loadAll() {
    this.setProgress(0, 'LOADING ARMORY');
    try {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      this.glbLoader = new GLTFLoader();
    } catch (error) {
      console.error('[FPS GODS] Could not initialise the GLB loader:', error);
      this.status.failed.push('character', 'map');
      this.setProgress(0, 'ASSET LOADER UNAVAILABLE');
      return false;
    }

    const urls = await this.resolveUrls();
    if (!urls) {
      // No guessing at `/assets/...`: on a host that answers unknown paths with
      // index.html that produces a 200 full of HTML and a mystery parse error.
      this.recordUnresolvedUrls();
      this.setProgress(0, 'ASSET URLS UNAVAILABLE');
      return false;
    }

    // The character is the only gameplay-critical asset, so it is loaded first
    // and its animation set is measured before the menu stage needs it.
    await this.loadCharacter(urls.character);
    this.setProgress(this.status.loaded.includes('character') ? 1 : 0, 'BUILDING ANIMATION SET');
    await this.loadMap(urls.map);
    this.setProgress(2, this.ready && this.mapReady ? 'ASSETS READY' : 'RUNNING WITH FALLBACKS');
    return this.ready;
  }

  /**
   * Ask the bundler for the hashed asset URLs.
   *
   * Production never falls back to the unhashed `public/` paths: those are the
   * URLs that produced the deployment 404 this hotfix is about, and silently
   * retrying them hides the real failure. A caller that genuinely has no
   * bundler (the Node test suite, tooling) can opt in explicitly.
   *
   * @returns {Promise<{character: string, map: string}|null>}
   */
  async resolveUrls({ allowPublicFallback = false } = {}) {
    try {
      const { ASSET_URLS } = await import('./assetUrls.js');
      this.urlSource = 'bundle';
      return { character: ASSET_URLS.character, map: ASSET_URLS.map };
    } catch (error) {
      this.resolveError = error;
      this.urlSource = allowPublicFallback ? 'public-fallback' : 'unavailable';
      if (allowPublicFallback) {
        console.warn(
          '[FPS GODS] Bundled asset URLs unavailable, using public paths:',
          error?.message ?? error,
        );
        return { ...PUBLIC_ASSET_PATHS };
      }
      return null;
    }
  }

  /**
   * The build handed us no asset URLs at all. That is a build problem, not a
   * delivery problem, and it must not reach the network as a guess.
   */
  recordUnresolvedUrls(error = this.resolveError) {
    for (const asset of ['character', 'map']) {
      const failure = {
        asset,
        label: ASSET_LABELS[asset],
        url: '(unresolved)',
        reason: 'unresolved-urls',
        status: null,
        contentType: '',
        advice: ASSET_ADVICE['unresolved-urls'],
        message: String(error?.message ?? error ?? 'assetUrls.js could not be imported'),
      };
      this.failures.push(failure);
      this.status.failed.push(asset);
      console.error(
        `[FPS GODS] Required asset failed — ${failure.label}\n`
        + `  asset:   ${asset}\n`
        + `  reason:  unresolved-urls — ${failure.advice}\n`
        + `  cause:   ${failure.message}`,
      );
    }
  }

  async loadCharacter(url = PUBLIC_ASSET_PATHS.character) {
    this.sources.character = url;
    try {
      const gltf = await this.glbLoader.loadAsync(url);
      this.characterGltf = gltf;
      this.assets.character = gltf.scene;
      this.trackSceneResources(gltf.scene);
      this.animationSet = buildAnimationSet(gltf.scene, gltf.animations ?? []);
      for (const warning of this.animationSet.warnings) console.warn(`[FPS GODS] ${warning}`);
      this.status.loaded.push('character');
      console.info(
        `[FPS GODS] Operator ready: ${gltf.animations?.length ?? 0} clips -> `
        + `${Object.keys(this.animationSet.states).join(', ')}`,
      );
    } catch (error) {
      this.assets.character = null;
      this.animationSet = null;
      await this.recordFailure('character', url, error);
    }
  }

  async loadMap(url = PUBLIC_ASSET_PATHS.map) {
    this.sources.map = url;
    try {
      const gltf = await this.glbLoader.loadAsync(url);
      this.assets.map = gltf.scene;
      this.trackSceneResources(gltf.scene);
      this.indexKitModules(gltf.scene);
      this.status.loaded.push('map');
      console.info(`[FPS GODS] Environment kit ready: ${this.kitModules.size} modules from ${url}`);
    } catch (error) {
      // No silent substitution: the previous build quietly retried a second,
      // byte-identical copy of the same kit, which turned a missing asset into
      // a mysterious empty backdrop with nothing in the console to chase.
      await this.recordFailure('map', url, error);
    }
  }

  /* ─────────────────────────── diagnostics ─────────────────────────── */

  /**
   * Turn a load failure into something actionable: the exact URL that was
   * requested, what the host actually returned, and why that breaks the game.
   */
  async recordFailure(asset, url, error) {
    const label = ASSET_LABELS[asset] ?? asset;
    const probe = await this.probeUrl(url);
    const failure = {
      asset,
      label,
      url,
      reason: probe.reason,
      status: probe.status,
      contentType: probe.contentType,
      advice: ASSET_ADVICE[probe.reason] ?? ASSET_ADVICE.unknown,
      message: String(error?.message ?? error),
    };
    this.failures.push(failure);
    this.status.failed.push(asset);
    console.error(
      `[FPS GODS] Required asset failed — ${label}\n`
      + `  asset:   ${asset}\n`
      + `  url:     ${url}\n`
      + `  status:  ${probe.status ?? 'unknown'}\n`
      + `  type:    ${probe.contentType || 'unknown'}\n`
      + `  reason:  ${failure.reason} — ${failure.advice}\n`
      + `  loader:  ${failure.message}`,
    );
    return failure;
  }

  /**
   * Ask the host what that URL really returns. A 200 is not proof of an asset:
   * single-page hosts answer unknown paths with `index.html`, which is exactly
   * how a missing GLB used to look like a parse error.
   */
  async probeUrl(url) {
    if (typeof fetch !== 'function') {
      return { reason: 'unverifiable', status: null, contentType: '', };
    }
    try {
      const response = await fetch(url, { cache: 'no-store' });
      const contentType = response.headers?.get?.('content-type') ?? '';
      const status = response.status;
      if (!response.ok) {
        return {
          reason: status === 404 ? 'http-404' : `http-${status}`,
          status,
          contentType,
        };
      }
      let magic = '';
      try {
        const body = await response.arrayBuffer();
        magic = String.fromCharCode(...new Uint8Array(body.slice(0, 4)));
      } catch {
        return { reason: 'unreadable-body', status, contentType };
      }
      if (magic !== 'glTF') {
        return {
          reason: /html/i.test(contentType) || magic.startsWith('<')
            ? 'html-instead-of-glb'
            : 'not-glb',
          status,
          contentType,
        };
      }
      return { reason: 'unreadable-glb', status, contentType };
    } catch (error) {
      return { reason: 'network-error', status: null, contentType: '', error: String(error?.message ?? error) };
    }
  }

  /** Machine-readable snapshot for bug reports: `window.__FPS_GODS_ASSETS__`. */
  diagnostics() {
    return {
      urlSource: this.urlSource,
      sources: { ...this.sources },
      loaded: [...this.status.loaded],
      failed: [...this.status.failed],
      failures: this.failures.map((failure) => ({ ...failure })),
    };
  }

  /** Human-readable lines for the in-game asset warning banner. */
  describeFailures() {
    return this.failures.map((failure) => {
      const where = failure.url && !failure.url.startsWith('(') ? ` (${failure.url})` : '';
      return `${failure.label} — ${failure.advice}${where}`;
    });
  }

  /** Record geometry/material ownership so `dispose()` can release GPU memory. */
  trackSceneResources(scene) {
    scene.traverse((node) => {
      if (!node.isMesh) return;
      if (node.geometry) this.disposables.add(node.geometry);
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) if (material) this.disposables.add(material);
    });
  }

  indexKitModules(scene) {
    this.kitModules.clear();
    for (const child of scene.children) {
      // Kit parts are named `<Category>_<Variant>`; the GLTFLoader turns ':' and
      // '.' into nothing for node names, so match case-insensitively too.
      this.kitModules.set(child.name, child);
    }
  }

  /** Clone one prefab module from the environment kit, or null when missing. */
  createKitModule(name) {
    const source = this.kitModules.get(name);
    if (!source) return null;
    const clone = source.clone(true);
    clone.position.set(0, 0, 0);
    clone.rotation.set(0, 0, 0);
    return clone;
  }

  hasKitModule(name) {
    return this.kitModules.has(name);
  }

  get kitReady() {
    return this.kitModules.size > 0;
  }

  getMap() {
    return this.assets.map;
  }

  getCharacter() {
    return this.assets.character;
  }

  hasCharacter() {
    return Boolean(this.assets.character);
  }

  get animations() {
    return this.animationSet;
  }

  /** A fresh skinned clone with its own mixer, actions and materials. */
  createCharacterRig(options = {}) {
    if (!this.assets.character || !this.animationSet) return null;
    try {
      return new CharacterRig(this.assets.character, this.animationSet, options);
    } catch (error) {
      console.error('[FPS GODS] Could not instantiate an operator rig:', error);
      return null;
    }
  }

  get ready() {
    return this.status.loaded.includes('character');
  }

  get mapReady() {
    return this.status.loaded.includes('map');
  }

  get hasFailures() {
    return this.failures.length > 0;
  }

  get loadFailed() {
    return this.status.failed;
  }

  onProgress(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    listener(this.progress);
    return () => this.listeners.delete(listener);
  }

  setProgress(loaded, label) {
    this.progress = { loaded: Math.min(loaded, this.progress.total), total: this.progress.total, label };
    for (const listener of this.listeners) listener(this.progress);
  }

  dispose() {
    for (const resource of this.disposables) resource.dispose?.();
    this.disposables.clear();
    this.kitModules.clear();
    this.assets.character = null;
    this.assets.map = null;
    this.animationSet = null;
  }
}

export const assetManager = new AssetManager();
export { THREE };
