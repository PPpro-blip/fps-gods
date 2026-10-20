import * as THREE from 'three';

// Asset path configuration
const ASSET_PATHS = {
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
};

// Animation state to track name mapping
const ANIMATION_MAP = {
  idle: 'Idle',
  run: 'Run',
  shoot: 'Shoot',
  reload: 'Reload',
  death: 'Death',
  jump: 'Jump',
  crouch: 'Crouch',
};

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
    this.loadingPromises = [];
    this.glbLoader = null;
  }

  async init() {
    // Dynamically import GLTFLoader
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    this.glbLoader = new GLTFLoader();
    
    // Load all assets
    await Promise.all([
      this.loadMap(),
      this.loadCharacter(),
      this.loadAnimations(),
    ]);
    
    this.loaded = true;
  }

  async loadMap() {
    try {
      const glb = await this.glbLoader.loadAsync(ASSET_PATHS.map);
      this.assets.map = glb.scene;
      this.setupMapMaterials(this.assets.map);
      console.log('[AssetManager] Map loaded successfully');
    } catch (error) {
      console.error('[AssetManager] Failed to load map:', error);
      this.assets.map = null;
    }
  }

  async loadCharacter() {
    try {
      const glb = await this.glbLoader.loadAsync(ASSET_PATHS.character);
      this.assets.character = glb.scene;
      this.setupCharacterMaterials(this.assets.character);
      console.log('[AssetManager] Character loaded successfully');
    } catch (error) {
      console.error('[AssetManager] Failed to load character:', error);
      this.assets.character = null;
    }
  }

  async loadAnimations() {
    try {
      const glb = await this.glbLoader.loadAsync(ASSET_PATHS.animations);
      this.assets.animations = glb;
      this.extractAnimations(glb);
      console.log('[AssetManager] Animations loaded successfully');
    } catch (error) {
      console.error('[AssetManager] Failed to load animations:', error);
      this.assets.animations = null;
    }
  }

  extractAnimations(glb) {
    if (!glb.animations || !glb.animations.length) {
      console.warn('[AssetManager] No animations found in GLB file');
      return;
    }
    
    // Create animation mixer
    this.animationMixer = new THREE.AnimationMixer(glb.scene);
    
    // Map animation clips by name
    glb.animations.forEach((clip) => {
      const lowerName = clip.name.toLowerCase();
      // Try to match with our animation states
      for (const [state, trackName] of Object.entries(ANIMATION_MAP)) {
        if (lowerName.includes(trackName.toLowerCase())) {
          this.animations[state] = clip;
          break;
        }
      }
      // Also store by original name
      this.animations[clip.name] = clip;
    });
    
    console.log('[AssetManager] Extracted animations:', Object.keys(this.animations));
  }

  setupMapMaterials(scene) {
    scene.traverse((child) => {
      if (child.isMesh) {
        // Enable shadow reception for map
        child.receiveShadow = true;
        child.castShadow = false;
        
        // Add cyan emissive accents if material exists
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(mat => {
              if (mat && mat.emissive) {
                mat.emissive.setHex(0x00f0ff);
                mat.emissiveIntensity = 0.1;
              }
            });
          } else if (child.material.emissive) {
            child.material.emissive.setHex(0x00f0ff);
            child.material.emissiveIntensity = 0.1;
          }
        }
      }
    });
  }

  setupCharacterMaterials(scene) {
    scene.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        
        // Apply cyan emissive accents to character materials
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(mat => {
              if (mat && mat.emissive) {
                mat.emissive.setHex(0x00f0ff);
                mat.emissiveIntensity = 0.08;
              }
            });
          } else if (child.material.emissive) {
            child.material.emissive.setHex(0x00f0ff);
            child.material.emissiveIntensity = 0.08;
          }
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
    // Try exact match
    if (this.animations[state]) {
      return this.animations[state];
    }
    
    // Try case-insensitive match
    const lowerState = state.toLowerCase();
    for (const [key, clip] of Object.entries(this.animations)) {
      if (key.toLowerCase() === lowerState) {
        return clip;
      }
    }
    
    // Return idle as fallback
    return this.animations['idle'] || this.animations['Idle'] || null;
  }

  playAnimation(state, mesh) {
    const clip = this.getAnimation(state);
    if (!clip || !mesh || !this.animationMixer) return null;
    
    // Find or create action
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
}

// Singleton instance
export const assetManager = new AssetManager();
