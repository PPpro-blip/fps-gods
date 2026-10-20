import * as THREE from 'three';
import { assetManager } from './AssetManager.js';

export class LobbyScene {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.character = null;
    this.weapon = null;
    this.lobbyGroup = null;
    this.lightGroup = null;
    this.animationMixer = null;
    this.idleAction = null;
    this.clock = new THREE.Clock();
    
    this.init();
  }

  async init() {
    // Wait for assets to load
    await assetManager.init();
    
    // Create lobby scene
    this.createLobbyEnvironment();
    this.createLobbyCharacter();
    this.setupLobbyLighting();
    this.setupLobbyCamera();
    
    console.log('[LobbyScene] Initialized');
  }

  createLobbyEnvironment() {
    // Create a stylized showroom environment
    this.lobbyGroup = new THREE.Group();
    this.scene.add(this.lobbyGroup);
    
    // Floor - stylized showroom floor
    const floorGeometry = new THREE.PlaneGeometry(50, 50);
    const floorMaterial = new THREE.MeshStandardMaterial({
      color: '#1a1a2e',
      roughness: 0.9,
      metalness: 0.1,
    });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.5;
    floor.receiveShadow = true;
    this.lobbyGroup.add(floor);
    
    // Reflective floor for showroom effect
    const reflectiveFloor = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshStandardMaterial({
        color: '#0a0a1a',
        roughness: 0.1,
        metalness: 0.8,
        emissive: '#00f0ff',
        emissiveIntensity: 0.05,
      })
    );
    reflectiveFloor.rotation.x = -Math.PI / 2;
    reflectiveFloor.position.y = -0.49;
    reflectiveFloor.receiveShadow = true;
    this.lobbyGroup.add(reflectiveFloor);
    
    // Decorative elements
    this.createDecorativeElements();
  }

  createDecorativeElements() {
    // Corner pillars with cyan accents
    const pillarGeometry = new THREE.CylinderGeometry(1, 1, 6, 8);
    const pillarMaterial = new THREE.MeshStandardMaterial({
      color: '#151525',
      roughness: 0.7,
      metalness: 0.3,
    });
    
    const pillarPositions = [
      [-15, 3, -15],
      [-15, 3, 15],
      [15, 3, -15],
      [15, 3, 15],
    ];
    
    pillarPositions.forEach((pos) => {
      const pillar = new THREE.Mesh(pillarGeometry, pillarMaterial);
      pillar.position.set(pos[0], pos[1], pos[2]);
      pillar.castShadow = true;
      pillar.receiveShadow = true;
      
      // Add cyan emissive top
      const topLight = new THREE.Mesh(
        new THREE.CylinderGeometry(0.8, 1, 0.3, 8),
        new THREE.MeshBasicMaterial({
          color: '#00f0ff',
          emissive: '#00f0ff',
          emissiveIntensity: 0.5,
        })
      );
      topLight.position.set(0, 3, 0);
      pillar.add(topLight);
      
      this.lobbyGroup.add(pillar);
    });
    
    // Central platform
    const platformGeometry = new THREE.BoxGeometry(12, 0.2, 12);
    const platformMaterial = new THREE.MeshStandardMaterial({
      color: '#252538',
      roughness: 0.5,
      metalness: 0.4,
    });
    const platform = new THREE.Mesh(platformGeometry, platformMaterial);
    platform.position.y = -0.45;
    platform.receiveShadow = true;
    this.lobbyGroup.add(platform);
    
    // Platform edge lighting
    const edgeLight = new THREE.Mesh(
      new THREE.BoxGeometry(12.2, 0.05, 12.2),
      new THREE.MeshBasicMaterial({
        color: '#00f0ff',
        emissive: '#00f0ff',
        emissiveIntensity: 0.15,
        transparent: true,
        opacity: 0.8,
      })
    );
    edgeLight.position.y = -0.44;
    this.lobbyGroup.add(edgeLight);
  }

  async createLobbyCharacter() {
    const characterScene = assetManager.getCharacter();
    if (!characterScene) {
      console.warn('[LobbyScene] Character model not loaded');
      return;
    }
    
    // Clone the character for the lobby
    this.character = characterScene.clone(true);
    
    // Position and scale the character
    this.character.position.set(0, 0, 0);
    this.character.scale.set(1, 1, 1);
    this.character.rotation.y = Math.PI * 0.25; // Slightly angled
    
    // Set up character for tactical pose
    this.character.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = false;
      }
    });
    
    this.lobbyGroup.add(this.character);
    
    // Load and attach primary weapon (rifle)
    await this.loadLobbyWeapon('rifle');
    
    // Set up animations
    this.setupCharacterAnimations();
  }

  async loadLobbyWeapon(weaponName) {
    try {
      const weaponPath = `/assets/weapons/${weaponName}.glb`;
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const loader = new GLTFLoader();
      const glb = await loader.loadAsync(weaponPath);
      
      // Remove existing weapon if any
      if (this.weapon) {
        this.character.remove(this.weapon);
      }
      
      this.weapon = glb.scene;
      
      // Position weapon in character's hand
      this.weapon.position.set(0.3, -0.1, -0.3);
      this.weapon.rotation.set(0, Math.PI / 4, 0);
      this.weapon.scale.set(0.8, 0.8, 0.8);
      
      // Apply cyan emissive to weapon
      this.weapon.traverse((child) => {
        if (child.isMesh && child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(mat => {
              if (mat && mat.emissive) {
                mat.emissive.setHex(0x00f0ff);
                mat.emissiveIntensity = 0.15;
              }
            });
          } else if (child.material.emissive) {
            child.material.emissive.setHex(0x00f0ff);
            child.material.emissiveIntensity = 0.15;
          }
        }
      });
      
      this.character.add(this.weapon);
      console.log(`[LobbyScene] Loaded weapon: ${weaponName}`);
    } catch (error) {
      console.error(`[LobbyScene] Failed to load weapon ${weaponName}:`, error);
    }
  }

  setupCharacterAnimations() {
    // Create animation mixer for the character
    this.animationMixer = new THREE.AnimationMixer(this.character);
    
    // Get idle animation
    const idleClip = assetManager.getAnimation('idle');
    if (idleClip) {
      this.idleAction = this.animationMixer.clipAction(idleClip);
      this.idleAction.loop = THREE.LoopRepeat;
      this.idleAction.play();
    }
    
    // Get tactical pose animation if available
    const poseClip = assetManager.getAnimation('pose') || assetManager.getAnimation('tactical');
    if (poseClip) {
      const poseAction = this.animationMixer.clipAction(poseClip);
      poseAction.loop = THREE.LoopOnce;
      poseAction.clampWhenFinished = true;
      poseAction.play();
    }
  }

  setupLobbyLighting() {
    this.lightGroup = new THREE.Group();
    this.lobbyGroup.add(this.lightGroup);
    
    // Ambient light
    const ambient = new THREE.AmbientLight('#404070', 0.8);
    this.lightGroup.add(ambient);
    
    // Main directional light
    const directional = new THREE.DirectionalLight('#ffffff', 1.5);
    directional.position.set(10, 20, 10);
    directional.castShadow = true;
    directional.shadow.mapSize.width = 2048;
    directional.shadow.mapSize.height = 2048;
    directional.shadow.camera.near = 0.5;
    directional.shadow.camera.far = 100;
    directional.shadow.camera.left = -50;
    directional.shadow.camera.right = 50;
    directional.shadow.camera.top = 50;
    directional.shadow.camera.bottom = -50;
    this.lightGroup.add(directional);
    
    // Cyan accent lights
    const cyanLight1 = new THREE.PointLight('#00f0ff', 2, 30);
    cyanLight1.position.set(-10, 5, -10);
    this.lightGroup.add(cyanLight1);
    
    const cyanLight2 = new THREE.PointLight('#00f0ff', 2, 30);
    cyanLight2.position.set(10, 5, 10);
    this.lightGroup.add(cyanLight2);
    
    // Warm fill light
    const warmLight = new THREE.PointLight('#ff8b3d', 1.5, 30);
    warmLight.position.set(0, 8, 0);
    this.lightGroup.add(warmLight);
  }

  setupLobbyCamera() {
    // Set up camera for lobby view
    this.camera.position.set(0, 3, 8);
    this.camera.lookAt(0, 1, 0);
  }

  update(delta) {
    if (this.animationMixer) {
      this.animationMixer.update(delta);
    }
    
    // Slow rotation of character for showcase
    if (this.character) {
      this.character.rotation.y += delta * 0.05;
    }
    
    // Pulsing effect on cyan lights
    const time = this.clock.getElapsedTime();
    const pulse = Math.sin(time * 2) * 0.1 + 0.9;
    
    this.lightGroup.children.forEach((light) => {
      if (light.color && (light.color.r > 0.9 || light.color.b > 0.9)) {
        const originalIntensity = light.intensity;
        light.intensity = originalIntensity * pulse;
      }
    });
  }

  show() {
    if (this.lobbyGroup) {
      this.lobbyGroup.visible = true;
    }
    if (this.lightGroup) {
      this.lightGroup.visible = true;
    }
  }

  hide() {
    if (this.lobbyGroup) {
      this.lobbyGroup.visible = false;
    }
    if (this.lightGroup) {
      this.lightGroup.visible = false;
    }
  }

  dispose() {
    // Clean up resources
    if (this.lobbyGroup) {
      this.scene.remove(this.lobbyGroup);
    }
    
    if (this.animationMixer) {
      this.animationMixer.stopAllAction();
      this.animationMixer = null;
    }
    
    if (this.idleAction) {
      this.idleAction = null;
    }
  }
}
