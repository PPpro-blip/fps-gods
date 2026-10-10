import * as THREE from 'three';

// Decorative first-person pistol plus tracer/muzzle flash. This module is only
// a visual effect: the server independently casts every shot and applies damage.
export class WeaponEffects {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.tracers = [];
    this.flashUntil = 0;
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

  fire(now = performance.now()) {
    this.camera.updateMatrixWorld(true);
    const start = this.muzzle.getWorldPosition(new THREE.Vector3());
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
    const end = start.clone().addScaledVector(direction, 46);
    const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
    const material = new THREE.LineBasicMaterial({
      color: '#ffd67a',
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
    });
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    this.scene.add(line);
    this.tracers.push({ line, expiresAt: now + 100 });

    this.flashUntil = now + 48;
    this.flashMesh.visible = true;
    this.flashLight.visible = true;
    this.gun.position.y = -0.273;
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
  }
}
