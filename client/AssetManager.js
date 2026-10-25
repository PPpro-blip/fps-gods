import * as THREE from 'three';
import { buildAnimationSet, CharacterRig } from './animation.js';

// Static GLB assets, served from the Vite `public/` directory so the paths are
// identical in development and in the production build.
//
// `map/arena_map.glb` is a modular sci-fi environment kit (floors, walls,
// columns, props) rather than a pre-assembled level; `MenuStage` instances those
// modules. `characters/character.glb` already contains the full 12-clip
// animation set, so the separate `animations/*.glb` files (which are byte
// duplicates or subsets) are intentionally not downloaded at runtime.
export const ASSET_PATHS = Object.freeze({
  character: '/assets/characters/character.glb',
  map: '/assets/map/arena_map.glb',
  mapFallback: '/assets/map/map-assets.glb',
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

    // The character is the only gameplay-critical asset, so it is loaded first
    // and its animation set is measured before the menu stage needs it.
    await this.loadCharacter();
    this.setProgress(this.status.loaded.includes('character') ? 1 : 0, 'BUILDING ANIMATION SET');
    await this.loadMap();
    this.setProgress(2, this.ready ? 'ASSETS READY' : 'RUNNING WITH FALLBACKS');
    return this.ready;
  }

  async loadCharacter() {
    try {
      const gltf = await this.glbLoader.loadAsync(ASSET_PATHS.character);
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
      console.error('[FPS GODS] Failed to load the operator model:', error);
      this.assets.character = null;
      this.animationSet = null;
      this.status.failed.push('character');
    }
  }

  async loadMap() {
    for (const path of [ASSET_PATHS.map, ASSET_PATHS.mapFallback]) {
      try {
        const gltf = await this.glbLoader.loadAsync(path);
        this.assets.map = gltf.scene;
        this.trackSceneResources(gltf.scene);
        this.indexKitModules(gltf.scene);
        this.status.loaded.push('map');
        console.info(`[FPS GODS] Environment kit ready: ${this.kitModules.size} modules from ${path}`);
        return;
      } catch (error) {
        console.warn(`[FPS GODS] Environment kit '${path}' unavailable:`, error?.message ?? error);
      }
    }
    this.status.failed.push('map');
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
