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

// Standard animation states mapped to expected motion types
export const ANIMATION_MAP = Object.freeze({
  idle: 'Idle',
  walk: 'Walk',
  run: 'Run',
  shoot: 'Shoot',
  reload: 'Reload',
  death: 'Death',
  jump: 'Jump',
  crouch: 'Crouch',
  pose: 'Pose',
  tactical: 'Tactical',
  aim: 'Aim',
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
    this.mixers = new Set();
    this.loaded = false;
    this.status = { requested: Object.keys(ASSET_PATHS), loaded: [], failed: [] };
    this.glbLoader = null;
    this.skeletonClone = null;
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
    try {
      const [{ GLTFLoader }, skeletonModule] = await Promise.all([
        import('three/addons/loaders/GLTFLoader.js'),
        import('three/addons/utils/SkeletonUtils.js').catch(() => null),
      ]);
      this.glbLoader = new GLTFLoader();
      this.skeletonClone = skeletonModule?.clone ?? null;
    } catch (error) {
      console.error('[AssetManager] Failed to load Three.js loader modules:', error);
    }

    if (!this.glbLoader) return false;

    await Promise.allSettled([
      this.loadCharacter(),
      this.loadMap(),
      this.loadAnimations(),
    ]);

    this.loaded = Boolean(this.assets.character || this.assets.animations);
    return this.loaded;
  }

  async loadCharacter() {
    try {
      const glb = await this.glbLoader.loadAsync(ASSET_PATHS.character);
      this.assets.character = glb.scene;
      this.setupCharacterMaterials(this.assets.character);
      if (glb.animations?.length) {
        this.extractAnimations(glb);
      }
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
      const animationCandidates = [
        ASSET_PATHS.animations,
        '/assets/animations/Animation_5.glb',
        '/assets/animations/Animation_4.glb',
        '/assets/animations/Animation_3.glb',
        '/assets/animations/Animation_2.glb',
        '/assets/animations/Animation_1.glb',
      ];
      for (const candidate of animationCandidates) {
        try {
          glb = await this.glbLoader.loadAsync(candidate);
          if (glb?.animations?.length) break;
        } catch {
          // Try next candidate
        }
      }

      if (glb) {
        this.assets.animations = glb;
        this.extractAnimations(glb);
        if (!this.assets.character && glb.scene) {
          this.assets.character = glb.scene;
          this.setupCharacterMaterials(this.assets.character);
        }
      }
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

    if (!this.animationMixer && glb.scene) {
      this.animationMixer = new THREE.AnimationMixer(glb.scene);
      this.registerMixer(this.animationMixer);
    }

    // Index-based animation mapping for Mixamo animation files:
    // 0: idle stance, 1: walk, 2: shoot, 3: reload, 4: death, 5: run, 6: sprint,
    // 7: pose / tactical, 8: aim, 9: strafe / walk_back, 10: shoot_alt, 11: jump
    const clips = glb.animations;
    const clipMap = {
      idle: clips[0],
      walk: clips[1] ?? clips[0],
      shoot: clips[2] ?? clips[0],
      reload: clips[3] ?? clips[0],
      death: clips[4] ?? clips[0],
      run: clips[5] ?? clips[1] ?? clips[0],
      sprint: clips[6] ?? clips[5] ?? clips[0],
      pose: clips[7] ?? clips[0],
      tactical: clips[7] ?? clips[0],
      aim: clips[8] ?? clips[0],
      strafe: clips[9] ?? clips[1] ?? clips[0],
      crouch: clips[5] ?? clips[0],
      jump: clips[11] ?? clips[0],
    };

    for (const [key, clip] of Object.entries(clipMap)) {
      if (clip) {
        this.animations[key] = clip;
        this.animations[key.toLowerCase()] = clip;
      }
    }

    clips.forEach((clip, index) => {
      this.animations[clip.name] = clip;
      this.animations[`clip_${index}`] = clip;
      const lowerName = clip.name.toLowerCase();
      for (const [state, trackName] of Object.entries(ANIMATION_MAP)) {
        if (lowerName.includes(trackName.toLowerCase())) {
          this.animations[state.toLowerCase()] = clip;
        }
      }
    });

    console.log('[AssetManager] Available animations:', Object.keys(this.animations));
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

  /**
   * Clone the character model with proper skeletal rebinding for animation playback.
   */
  cloneCharacter() {
    const source = this.assets.character ?? this.assets.animations?.scene;
    if (!source) return null;
    if (this.skeletonClone) {
      return this.skeletonClone(source);
    }
    return source.clone(true);
  }

  /**
   * Create an animated character instance with its own AnimationMixer and animation actions.
   */
  createCharacterInstance() {
    const mesh = this.cloneCharacter();
    if (!mesh) return null;

    const mixer = new THREE.AnimationMixer(mesh);
    this.registerMixer(mixer);

    const actions = {};
    for (const [name, clip] of Object.entries(this.animations)) {
      if (clip) {
        actions[name] = mixer.clipAction(clip);
      }
    }

    let currentAction = null;
    const playAnimation = (state, { loop = true, crossFade = 0.2, clamp = false } = {}) => {
      const clip = this.getAnimation(state);
      if (!clip) return null;
      const nextAction = mixer.clipAction(clip);
      if (clamp) {
        nextAction.loop = THREE.LoopOnce;
        nextAction.clampWhenFinished = true;
      } else {
        nextAction.loop = loop ? THREE.LoopRepeat : THREE.LoopOnce;
      }
      if (currentAction && currentAction !== nextAction) {
        nextAction.reset().fadeIn(crossFade).play();
        currentAction.fadeOut(crossFade);
      } else {
        nextAction.reset().play();
      }
      currentAction = nextAction;
      return nextAction;
    };

    return {
      mesh,
      mixer,
      actions,
      playAnimation,
      getCurrentAction: () => currentAction,
      dispose: () => {
        this.unregisterMixer(mixer);
        mixer.stopAllAction();
      },
    };
  }

  getAnimation(state) {
    if (!state) return this.animations['idle'] || Object.values(this.animations)[0] || null;
    const lower = String(state).toLowerCase();
    if (this.animations[lower]) return this.animations[lower];
    if (this.animations[state]) return this.animations[state];
    for (const [key, clip] of Object.entries(this.animations)) {
      if (key.toLowerCase() === lower || key.toLowerCase().includes(lower)) {
        return clip;
      }
    }
    return this.animations['idle'] || this.animations['pose'] || Object.values(this.animations)[0] || null;
  }

  playAnimation(state, mesh, targetMixer = this.animationMixer) {
    const clip = this.getAnimation(state);
    if (!clip || !targetMixer) return null;
    const action = targetMixer.clipAction(clip);
    action.play();
    return action;
  }

  registerMixer(mixer) {
    if (mixer) this.mixers.add(mixer);
  }

  unregisterMixer(mixer) {
    if (mixer) this.mixers.delete(mixer);
  }

  update(delta) {
    for (const mixer of this.mixers) {
      mixer.update(delta);
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
