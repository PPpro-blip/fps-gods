import * as THREE from 'three';

// Decorative first-person weapon presentation, smoke, tracers, and muzzle flash.
// The server independently resolves every shot and applies all damage.
export class WeaponEffects {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.tracers = [];
    this.smokeMeshes = new Map();
    this.smokeGeometry = new THREE.SphereGeometry(1, 20, 14);
    this.flashUntil = 0;
    this.weaponId = 'SMG';
    this.buildViewModel();
  }

  buildViewModel() {
    const gun = new THREE.Group();
    gun.position.set(0.31, -0.255, -0.48);
    gun.rotation.set(-0.06, -0.11, -0.035);
    this.camera.add(gun);
    this.gun = gun;

    const bodyMaterial = new THREE.MeshStandardMaterial({ color: '#263548', roughness: 0.42, metalness: 0.7 });
    const slideMaterial = new THREE.MeshStandardMaterial({ color: '#65758a', roughness: 0.32, metalness: 0.82 });
    const gripMaterial = new THREE.MeshStandardMaterial({ color: '#111923', roughness: 0.78, metalness: 0.18 });
    const accentMaterial = new THREE.MeshBasicMaterial({ color: '#59d8ff' });
    this.accentMaterial = accentMaterial;

    const slide = new THREE.Mesh(new THREE.BoxGeometry(0.125, 0.095, 0.36), slideMaterial);
    slide.position.set(0, 0.035, -0.105);
    gun.add(slide);

    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.145, 0.09, 0.285), bodyMaterial);
    frame.position.set(0, -0.035, -0.075);
    gun.add(frame);

    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.21, 8), bodyMaterial);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.025, -0.36);
    gun.add(barrel);

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.205, 0.12), gripMaterial);
    grip.position.set(0, -0.15, 0.005);
    grip.rotation.x = -0.19;
    gun.add(grip);

    const gripBase = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.027, 0.13), slideMaterial);
    gripBase.position.set(0, -0.245, 0.008);
    gripBase.rotation.x = -0.19;
    gun.add(gripBase);

    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.028, 0.045), accentMaterial);
    sight.position.set(0, 0.098, -0.16);
    gun.add(sight);

    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.025, -0.455);
    gun.add(muzzle);
    this.muzzle = muzzle;

    const flashMaterial = new THREE.MeshBasicMaterial({ color: '#ffdf96', transparent: true, opacity: 0.95 });
    this.flashMesh = new THREE.Mesh(new THREE.SphereGeometry(0.065, 8, 6), flashMaterial);
    this.flashMesh.position.copy(muzzle.position);
    this.flashMesh.visible = false;
    gun.add(this.flashMesh);

    this.flashLight = new THREE.PointLight('#ffbd69', 2.3, 3.2, 2);
    this.flashLight.position.copy(muzzle.position);
    this.flashLight.visible = false;
    gun.add(this.flashLight);
  }

  setWeapon(weaponId) {
    this.weaponId = weaponId;
    const accentByWeapon = {
      SMG: '#ff9858', SHOTGUN: '#ff9858', KNIFE: '#ff9858',
      PISTOL: '#80aaff', SNIPER: '#80aaff', SMOKE_GRENADE: '#80aaff',
      LMG: '#ffc857', ROCKET: '#ffc857', COMBAT_SHIELD: '#ffc857',
      RAILGUN: '#59d8ff', MINIGUN: '#59d8ff', GOD_FIST: '#59d8ff',
    };
    this.accentMaterial.color.set(accentByWeapon[weaponId] ?? '#59d8ff');
    const scale = weaponId === 'SNIPER' || weaponId === 'RAILGUN' || weaponId === 'ROCKET'
      ? 1.13
      : weaponId === 'KNIFE' || weaponId === 'GOD_FIST' || weaponId === 'COMBAT_SHIELD'
        ? 0.82
        : 1;
    this.gun.scale.setScalar(scale);
  }

  fire(now = performance.now(), weaponId = this.weaponId) {
    this.setWeapon(weaponId);
    const noTracer = ['PISTOL', 'KNIFE', 'GOD_FIST', 'SMOKE_GRENADE', 'COMBAT_SHIELD'].includes(weaponId);
    const noMuzzleFlash = ['KNIFE', 'GOD_FIST', 'SMOKE_GRENADE', 'COMBAT_SHIELD'].includes(weaponId);
    this.camera.updateMatrixWorld(true);
    const start = this.muzzle.getWorldPosition(new THREE.Vector3());
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
    if (!noTracer) {
      const end = start.clone().addScaledVector(direction, 58);
      const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
      const color = weaponId === 'ROCKET' ? '#ff9858' : weaponId === 'RAILGUN' ? '#59d8ff' : '#ffd67a';
      const material = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.88,
        depthWrite: false,
      });
      const line = new THREE.Line(geometry, material);
      line.frustumCulled = false;
      this.scene.add(line);
      this.tracers.push({ line, expiresAt: now + 100 });
    }

    if (!noMuzzleFlash) {
      this.flashUntil = now + 48;
      this.flashMesh.visible = true;
      this.flashLight.visible = true;
      this.gun.position.y = -0.273;
    }
  }

  updateSmokeClouds(clouds = []) {
    const visibleIds = new Set(clouds.map((cloud) => cloud.id));
    for (const [id, record] of this.smokeMeshes) {
      if (visibleIds.has(id)) continue;
      this.scene.remove(record.group);
      for (const material of record.materials) material.dispose();
      this.smokeMeshes.delete(id);
    }

    for (const cloud of clouds) {
      let record = this.smokeMeshes.get(cloud.id);
      if (!record) {
        const group = new THREE.Group();
        const radius = Math.max(1, Number(cloud.radius) || 4);
        const materials = [0.28, 0.22, 0.18].map((opacity) => new THREE.MeshBasicMaterial({
          color: '#8e9aa6',
          transparent: true,
          opacity,
          depthWrite: false,
          side: THREE.DoubleSide,
        }));
        const lobes = [
          { x: 0, y: 0, z: 0, scale: [1, 0.78, 1] },
          { x: -0.36, y: 0.1, z: 0.22, scale: [0.74, 0.66, 0.72] },
          { x: 0.34, y: -0.05, z: -0.24, scale: [0.76, 0.69, 0.75] },
        ];
        lobes.forEach((lobe, index) => {
          const mesh = new THREE.Mesh(this.smokeGeometry, materials[index]);
          mesh.position.set(lobe.x * radius, lobe.y * radius, lobe.z * radius);
          mesh.scale.set(radius * lobe.scale[0], radius * lobe.scale[1], radius * lobe.scale[2]);
          group.add(mesh);
        });
        this.scene.add(group);
        record = { group, materials };
        this.smokeMeshes.set(cloud.id, record);
      }
      record.group.position.set(cloud.x, cloud.y, cloud.z);
    }
  }

  update(now = performance.now()) {
    for (let index = this.tracers.length - 1; index >= 0; index -= 1) {
      const tracer = this.tracers[index];
      const remaining = tracer.expiresAt - now;
      if (remaining <= 0) {
        this.scene.remove(tracer.line);
        tracer.line.geometry.dispose();
        tracer.line.material.dispose();
        this.tracers.splice(index, 1);
      } else {
        tracer.line.material.opacity = Math.min(0.88, remaining / 100);
      }
    }

    const flashVisible = now < this.flashUntil;
    this.flashMesh.visible = flashVisible;
    this.flashLight.visible = flashVisible;
    this.gun.position.y += (-0.255 - this.gun.position.y) * 0.28;
  }

  dispose() {
    for (const tracer of this.tracers) {
      this.scene.remove(tracer.line);
      tracer.line.geometry.dispose();
      tracer.line.material.dispose();
    }
    for (const record of this.smokeMeshes.values()) {
      this.scene.remove(record.group);
      for (const material of record.materials) material.dispose();
    }
    this.smokeMeshes.clear();
    this.smokeGeometry.dispose();
  }
}
