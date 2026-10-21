import * as THREE from 'three';

// Asset path configuration - pointing to web root /assets/...
export const ASSET_PATHS = Object.freeze({
  map: '/assets/map/arena_map.glb',
  character: '/assets/characters/character.glb',
  animations: '/assets/animations/animations.glb',
  weapons: {
    rifle: '/assets/weapons/rifle.glb',
    pistol: '/assets/weapons/pistol.glb',
    knife: '/assets/weapons/knife.glb',
    smg: '/assets/weapons/smg.glb',
    shotgun: '/assets/weapons/shotgun.glb',
    sniper: '/assets/weapons/sniper.glb',
    lmg: '/assets/weapons/lmg.glb',
    rocket: '/assets/weapons/rocket.glb',
  },
});

// Animation state to track name mapping
export const ANIMATION_MAP = Object.freeze({
  idle: 'Idle',
  run: 'Run',
  shoot: 'Shoot',
  reload: 'Reload',
  death: 'Death',
  jump: 'Jump',
  crouch: 'Crouch',
});

export class AssetManager {
  constructor() {
    this.assets = {
      map: null,
      character: null,
      animations: null,
      weapons: {},
    };
    this.animationMixer = null;
    this.animations = {};
    this.loaded = false;
    this.status = { requested: Object.keys(ASSET_PATHS), loaded: [], failed: [] };
    this.glbLoader = null;
    this.initialized = false;
    this.loadPromise = null;
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

    await Promise.allSettled([
      this.loadCharacter(),
      this.loadMap(),
      this.loadAnimations(),
    ]);

    this.loaded = Boolean(this.assets.character);
    return this.loaded;
  }

  async loadCharacter() {
    try {
      const glb = await this.glbLoader.loadAsync(ASSET_PATHS.character);
      this.assets.character = glb.scene;
      this.setupCharacterMaterials(this.assets.character);
      this.status.loaded.push('character');
      console.log('[AssetManager] Character loaded successfully');
    } catch (error) {
      console.error('[AssetManager] Failed to load character:', error);
      this.assets.character = null;
      this.status.failed.push('character');
    }
  }

  async loadMap() {
    try {
      let glb;
      try {
        glb = await this.glbLoader.loadAsync(ASSET_PATHS.map);
      } catch {
        glb = await this.glbLoader.loadAsync('/assets/map/map-assets.glb');
      }
      this.assets.map = glb.scene;
      this.setupMapMaterials(this.assets.map);
      this.status.loaded.push('map');
      console.log('[AssetManager] Map loaded successfully');
    } catch (error) {
      console.error('[AssetManager] Failed to load map:', error);
      this.assets.map = null;
      this.status.failed.push('map');
    }
  }

  async loadAnimations() {
    try {
      let glb;
      try {
        glb = await this.glbLoader.loadAsync(ASSET_PATHS.animations);
      } catch {
        glb = await this.glbLoader.loadAsync('/assets/animations/Animation_5.glb');
      }
      this.assets.animations = glb;
      this.extractAnimations(glb);
      this.status.loaded.push('animations');
      console.log('[AssetManager] Animations loaded successfully');
    } catch (error) {
      console.error('[AssetManager] Failed to load animations:', error);
      this.assets.animations = null;
      this.status.failed.push('animations');
    }
  }

  extractAnimations(glb) {
    if (!glb.animations || !glb.animations.length) {
      return;
    }

    this.animationMixer = new THREE.AnimationMixer(glb.scene);

    glb.animations.forEach((clip) => {
      const lowerName = clip.name.toLowerCase();
      for (const [state, trackName] of Object.entries(ANIMATION_MAP)) {
        if (lowerName.includes(trackName.toLowerCase())) {
          this.animations[state] = clip;
          break;
        }
      }
      this.animations[clip.name] = clip;
    });
  }

  setupMapMaterials(scene) {
    scene.traverse((child) => {
      if (child.isMesh) {
        child.receiveShadow = true;
        child.castShadow = false;
        if (child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach((mat) => {
            if (mat && mat.emissive) {
              mat.emissive.setHex(0x00f0ff);
              mat.emissiveIntensity = 0.1;
            }
          });
        }
      }
    });
  }

  setupCharacterMaterials(scene) {
    scene.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        if (child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach((mat) => {
            if (mat && mat.emissive) {
              mat.emissive.setHex(0x00f0ff);
              mat.emissiveIntensity = 0.08;
            }
          });
        }
      }
    });
  }

  getMap() {
    return this.assets.map;
  }

  getCharacter() {
    return this.assets.character;
  }

  getAnimation(state) {
    if (this.animations[state]) {
      return this.animations[state];
    }
    const lowerState = String(state).toLowerCase();
    for (const [key, clip] of Object.entries(this.animations)) {
      if (key.toLowerCase() === lowerState) {
        return clip;
      }
    }
    return this.animations['idle'] || this.animations['Idle'] || Object.values(this.animations)[0] || null;
  }

  playAnimation(state, mesh) {
    const clip = this.getAnimation(state);
    if (!clip || !mesh || !this.animationMixer) return null;
    const action = this.animationMixer.clipAction(clip);
    action.play();
    return action;
  }

  update(delta) {
    if (this.animationMixer) {
      this.animationMixer.update(delta);
    }
  }

  getAnimationMixer() {
    return this.animationMixer;
  }

  get ready() {
    return this.loaded;
  }
}

// Singleton instance
export const assetManager = new AssetManager();
