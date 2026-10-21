import * as THREE from 'three';
import { assetManager } from './AssetManager.js';

export class LobbyScene {
  constructor(scene, camera, { weaponModels } = {}) {
    this.scene = scene;
    this.camera = camera;
    this.weaponModels = weaponModels ?? null;
    this.character = null;
    this.characterInstance = null;
    this.weapon = null;
    this.lobbyGroup = null;
    this.lightGroup = null;
    this.animationMixer = null;
    this.idleAction = null;
    this.clock = new THREE.Clock();

    this.init();
  }

  async init() {
    await assetManager.init();

    this.createLobbyEnvironment();
    await this.createLobbyCharacter();
    this.setupLobbyLighting();
    this.setupLobbyCamera();

    console.log('[LobbyScene] Initialized');
  }

  createLobbyEnvironment() {
    this.lobbyGroup = new THREE.Group();
    this.scene.add(this.lobbyGroup);

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

    const reflectiveFloor = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshStandardMaterial({
        color: '#0a0a1a',
        roughness: 0.1,
        metalness: 0.8,
        emissive: '#00f0ff',
        emissiveIntensity: 0.05,
      }),
    );
    reflectiveFloor.rotation.x = -Math.PI / 2;
    reflectiveFloor.position.y = -0.49;
    reflectiveFloor.receiveShadow = true;
    this.lobbyGroup.add(reflectiveFloor);

    this.createDecorativeElements();
  }

  createDecorativeElements() {
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

      const topLight = new THREE.Mesh(
        new THREE.CylinderGeometry(0.8, 1, 0.3, 8),
        new THREE.MeshBasicMaterial({
          color: '#00f0ff',
          emissive: '#00f0ff',
          emissiveIntensity: 0.5,
        }),
      );
      topLight.position.set(0, 3, 0);
      pillar.add(topLight);

      this.lobbyGroup.add(pillar);
    });

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

    const edgeLight = new THREE.Mesh(
      new THREE.BoxGeometry(12.2, 0.05, 12.2),
      new THREE.MeshBasicMaterial({
        color: '#00f0ff',
        emissive: '#00f0ff',
        emissiveIntensity: 0.15,
        transparent: true,
        opacity: 0.8,
      }),
    );
    edgeLight.position.y = -0.44;
    this.lobbyGroup.add(edgeLight);
  }

  async createLobbyCharacter() {
    let characterInstance = assetManager.createCharacterInstance();
    if (!characterInstance) {
      const char = assetManager.getCharacter();
      if (char) {
        this.character = char.clone(true);
        this.animationMixer = new THREE.AnimationMixer(this.character);
      } else {
        console.warn('[LobbyScene] Character model not loaded');
        return;
      }
    } else {
      this.characterInstance = characterInstance;
      this.character = characterInstance.mesh;
      this.animationMixer = characterInstance.mixer;
    }

    this.character.position.set(0, -0.45, 0);
    this.character.scale.set(1, 1, 1);
    this.character.rotation.y = Math.PI * 0.15;

    this.character.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = false;
      }
    });

    this.lobbyGroup.add(this.character);

    this.loadLobbyWeapon('SMG');
    this.setupCharacterAnimations();
  }

  loadLobbyWeapon(weaponId = 'SMG') {
    let model = this.weaponModels?.createModel(weaponId) ?? null;

    if (!model) {
      console.warn(`[LobbyScene] Lobby weapon '${weaponId}' is not available yet`);
      return;
    }

    if (this.weapon) {
      if (this.weapon.parent) this.weapon.parent.remove(this.weapon);
      this.weapon = null;
    }

    this.weapon = model;

    const rightHand = this.character?.getObjectByName('mixamorigRightHand');
    if (rightHand) {
      this.weapon.position.set(0, 0.05, 0);
      this.weapon.rotation.set(-Math.PI / 2, 0, -Math.PI / 2);
      this.weapon.scale.set(0.75, 0.75, 0.75);
      rightHand.add(this.weapon);
    } else if (this.character) {
      this.weapon.position.set(0.25, 0.9, 0.2);
      this.weapon.rotation.set(0, Math.PI / 4, 0);
      this.weapon.scale.set(0.75, 0.75, 0.75);
      this.character.add(this.weapon);
    }

    this.weapon.traverse((child) => {
      if (child.isMesh && child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((mat) => {
          if (mat && mat.emissive) {
            mat.emissive.setHex(0x00f0ff);
            mat.emissiveIntensity = 0.15;
          }
        });
      }
    });

    console.log(`[LobbyScene] Attached lobby weapon: ${weaponId}`);
  }

  setupCharacterAnimations() {
    if (!this.character || !this.animationMixer) return;

    const idleClip = assetManager.getAnimation('idle') || assetManager.getAnimation('pose') || assetManager.getAnimation('tactical');
    if (idleClip) {
      this.idleAction = this.animationMixer.clipAction(idleClip);
      this.idleAction.loop = THREE.LoopRepeat;
      this.idleAction.play();
      console.log('[LobbyScene] Playing character idle animation:', idleClip.name);
    }
  }

  setupLobbyLighting() {
    this.lightGroup = new THREE.Group();
    this.lobbyGroup.add(this.lightGroup);

    const ambient = new THREE.AmbientLight('#404070', 0.9);
    this.lightGroup.add(ambient);

    const directional = new THREE.DirectionalLight('#ffffff', 1.8);
    directional.position.set(10, 20, 10);
    directional.castShadow = true;
    this.lightGroup.add(directional);

    const cyanLight1 = new THREE.PointLight('#00f0ff', 2.2, 30);
    cyanLight1.position.set(-10, 5, -10);
    this.lightGroup.add(cyanLight1);

    const cyanLight2 = new THREE.PointLight('#00f0ff', 2.2, 30);
    cyanLight2.position.set(10, 5, 10);
    this.lightGroup.add(cyanLight2);

    const warmLight = new THREE.PointLight('#ff8b3d', 1.6, 30);
    warmLight.position.set(0, 8, 0);
    this.lightGroup.add(warmLight);
  }

  setupLobbyCamera() {
    this.camera.position.set(0, 1.25, 3.2);
    this.camera.lookAt(0, 0.85, 0);
  }

  update(delta) {
    if (this.animationMixer) {
      this.animationMixer.update(delta);
    }

    if (this.character) {
      this.character.rotation.y += delta * 0.05;
    }

    const time = this.clock.getElapsedTime();
    const pulse = Math.sin(time * 2) * 0.1 + 0.9;

    if (this.lightGroup) {
      this.lightGroup.children.forEach((light) => {
        if (light.color && (light.color.r > 0.9 || light.color.b > 0.9)) {
          light.intensity = 2.2 * pulse;
        }
      });
    }
  }

  show() {
    if (this.lobbyGroup) this.lobbyGroup.visible = true;
    if (this.lightGroup) this.lightGroup.visible = true;
  }

  hide() {
    if (this.lobbyGroup) this.lobbyGroup.visible = false;
    if (this.lightGroup) this.lightGroup.visible = false;
  }

  dispose() {
    if (this.lobbyGroup) {
      this.scene.remove(this.lobbyGroup);
    }
    if (this.characterInstance) {
      this.characterInstance.dispose();
      this.characterInstance = null;
    } else if (this.animationMixer) {
      this.animationMixer.stopAllAction();
      this.animationMixer = null;
    }
    if (this.idleAction) {
      this.idleAction = null;
    }
  }
}
