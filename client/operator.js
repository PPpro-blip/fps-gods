import * as THREE from 'three';

// The shipped operator is a bare Mixamo humanoid: two untextured materials and
// no armour. This module dresses that rig procedurally, on the real bones, so
// every player is a tactical operator instead of a naked mannequin, and hands
// back a group whose yaw matches the server's convention (forward = -Z).

/** Bone names as authored in `character.glb`. */
export const BONES = Object.freeze({
  hips: 'mixamorigHips',
  spine: 'mixamorigSpine',
  spine1: 'mixamorigSpine1',
  spine2: 'mixamorigSpine2',
  neck: 'mixamorigNeck',
  head: 'mixamorigHead',
  leftShoulder: 'mixamorigLeftShoulder',
  rightShoulder: 'mixamorigRightShoulder',
  leftArm: 'mixamorigLeftArm',
  rightArm: 'mixamorigRightArm',
  leftForeArm: 'mixamorigLeftForeArm',
  rightForeArm: 'mixamorigRightForeArm',
  leftHand: 'mixamorigLeftHand',
  rightHand: 'mixamorigRightHand',
  leftUpLeg: 'mixamorigLeftUpLeg',
  rightUpLeg: 'mixamorigRightUpLeg',
  leftLeg: 'mixamorigLeftLeg',
  rightLeg: 'mixamorigRightLeg',
  leftFoot: 'mixamorigLeftFoot',
  rightFoot: 'mixamorigRightFoot',
});

export const WEAPON_SOCKET_NAME = 'weapon-socket';

const BRAND = Object.freeze({
  armour: '#1b2a36',
  armourLight: '#26394a',
  visor: '#39e6ff',
  accent: '#ff8b3d',
  strap: '#0d151c',
  metalness: 0.62,
  roughness: 0.44,
});

/** Shared, dispose-once geometry for the procedural kit. */
function createKitGeometry() {
  return {
    helmet: new THREE.SphereGeometry(0.128, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.62),
    visor: new THREE.BoxGeometry(0.17, 0.05, 0.035),
    neckGuard: new THREE.CylinderGeometry(0.075, 0.09, 0.07, 12, 1, true),
    chest: new THREE.BoxGeometry(0.36, 0.3, 0.2),
    plate: new THREE.BoxGeometry(0.3, 0.1, 0.06),
    pack: new THREE.BoxGeometry(0.28, 0.34, 0.14),
    canister: new THREE.CylinderGeometry(0.045, 0.045, 0.24, 10),
    shoulder: new THREE.BoxGeometry(0.15, 0.1, 0.19),
    knee: new THREE.BoxGeometry(0.13, 0.13, 0.1),
    boot: new THREE.BoxGeometry(0.13, 0.11, 0.27),
    belt: new THREE.CylinderGeometry(0.14, 0.15, 0.07, 16, 1, true),
    strap: new THREE.BoxGeometry(0.045, 0.24, 0.02),
    pouch: new THREE.BoxGeometry(0.09, 0.07, 0.05),
  };
}

let kitCache = null;
function kit() {
  if (!kitCache) kitCache = createKitGeometry();
  return kitCache;
}

/** Release the shared gear geometry; call once, on full teardown. */
export function disposeOperatorKit() {
  if (!kitCache) return;
  for (const geometry of Object.values(kitCache)) geometry.dispose();
  kitCache = null;
}

function armourMaterial(color = BRAND.armour, extra = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    metalness: BRAND.metalness,
    roughness: BRAND.roughness,
    ...extra,
  });
}

function emissiveMaterial(color, intensity = 1.4) {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: new THREE.Color(color),
    emissiveIntensity: intensity,
    metalness: 0.2,
    roughness: 0.3,
  });
}

/**
 * Attach an object to a bone, with its coordinates expressed in the character's
 * own frame: metres, origin on the floor between the feet, +Z forward (the
 * direction the bare Mixamo model faces).
 *
 * Two traps are handled here:
 *  - the bones live under a 0.01-scaled armature, so the offset must be divided
 *    by the bone's world scale and the object's scale inverted, or the gear
 *    renders a hundred times too small;
 *  - the character frame is not the bone frame. Basing the offset on the bone
 *    instead of the rig root would rotate the visor onto the back of the head
 *    (the arms) whenever a bone carries its own rotation.
 */
export function attachInModelSpace(mesh, bone, object, position = [0, 0, 0], rotation = [0, 0, 0]) {
  if (!bone) return null;
  // A freshly cloned rig has an identity matrix on every bone until the tree is
  // updated once, which would place gear at the origin instead of on the body.
  mesh.updateMatrixWorld(true);
  bone.updateWorldMatrix(true, false);

  const bonePosition = new THREE.Vector3();
  const boneQuaternion = new THREE.Quaternion();
  const boneScale = new THREE.Vector3();
  bone.matrixWorld.decompose(bonePosition, boneQuaternion, boneScale);

  const frameQuaternion = new THREE.Quaternion();
  mesh.getWorldQuaternion(frameQuaternion);

  const offsetQuaternion = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(rotation[0], rotation[1], rotation[2]),
  );
  const toBone = boneQuaternion.clone().invert();
  const safeScale = new THREE.Vector3(
    Math.abs(boneScale.x) > 1e-6 ? boneScale.x : 1,
    Math.abs(boneScale.y) > 1e-6 ? boneScale.y : 1,
    Math.abs(boneScale.z) > 1e-6 ? boneScale.z : 1,
  );

  object.position
    .set(position[0], position[1], position[2])
    .applyQuaternion(frameQuaternion)
    .applyQuaternion(toBone)
    .divide(safeScale);
  object.quaternion.copy(toBone).multiply(frameQuaternion).multiply(offsetQuaternion);
  object.scale.set(1 / safeScale.x, 1 / safeScale.y, 1 / safeScale.z);
  bone.add(object);
  return object;
}

/**
 * Replace the bare skin material with a dark tactical suit, keeping the face
 * and hands as skin so the operator still reads as a person.
 */
export function dressOperator(rig, { accent = BRAND.accent } = {}) {
  const suit = armourMaterial('#22303c', { metalness: 0.28, roughness: 0.62 });
  const trim = emissiveMaterial(accent, 0.55);
  const owned = [suit, trim];
  let applied = 0;

  rig.root.traverse((node) => {
    if (!node.isMesh || !node.material) return;
    const wasArray = Array.isArray(node.material);
    const materials = wasArray ? node.material : [node.material];
    const next = materials.map((material) => {
      const name = String(material.name ?? '').toLowerCase();
      // 'joints' is the face/hands material; leave skin untouched.
      if (name.includes('joint') || name.includes('face') || name.includes('head')) return material;
      applied += 1;
      return suit;
    });
    node.material = wasArray ? next : next[0];
  });

  return { applied, owned };
}

/** Build the full gear set and parent it to the rig's bones. */
export function attachTacticalGear(rig, { accent = BRAND.accent } = {}) {
  const shape = kit();
  const group = new THREE.Group();
  group.name = 'tactical-gear';
  rig.root.add(group);
  const armour = armourMaterial(BRAND.armour);
  const armourLight = armourMaterial(BRAND.armourLight, { metalness: 0.7, roughness: 0.34 });
  const visor = emissiveMaterial(BRAND.visor, 1.9);
  const accentMaterial = emissiveMaterial(accent, 1.1);
  const strapMaterial = armourMaterial(BRAND.strap, { metalness: 0.15, roughness: 0.85 });
  const owned = [armour, armourLight, visor, accentMaterial, strapMaterial];

  // Every gear mesh is parented straight to its bone, so it follows the pose.
  const add = (geometry, material, boneName, position, rotation) => {
    if (!geometry || !boneName) return null;
    const bone = rig.getBone(boneName);
    if (!bone) return null;
    const object = new THREE.Mesh(geometry, material);
    object.castShadow = false;
    object.receiveShadow = false;
    return attachInModelSpace(rig.root, bone, object, position, rotation);
  };

  // Head: helmet dome, visor band, throat guard.
  // Measured bind pose: head 1.599 m, spine2 1.336 m, hips 1.043 m, knees
  // 0.532 m, feet 0.087 m, so every offset below is anchored to a real joint.
  add(shape.helmet, armour, BONES.head, [0, 0.055, -0.012], [0, 0, 0]);
  add(shape.visor, visor, BONES.head, [0, 0.028, 0.072], [0.1, 0, 0]);
  add(shape.neckGuard, armourLight, BONES.neck, [0, 0.03, 0.005], [0, 0, 0]);

  // Torso: chest plate, abdominal plate, backpack, canisters.
  add(shape.chest, armour, BONES.spine2, [0, 0.01, 0.05], [0, 0, 0]);
  add(shape.plate, armourLight, BONES.spine1, [0, -0.04, 0.075], [0, 0, 0]);
  add(shape.pack, armourLight, BONES.spine2, [0, 0.01, -0.115], [0, 0, 0]);
  add(shape.canister, accentMaterial, BONES.spine2, [-0.085, 0.02, -0.195], [0, 0, 0]);
  add(shape.canister, armourLight, BONES.spine2, [0.085, 0.02, -0.195], [0, 0, 0]);
  add(shape.belt, strapMaterial, BONES.hips, [0, -0.05, 0.005], [0, 0, 0]);
  add(shape.strap, strapMaterial, BONES.spine, [0.1, 0.04, 0.075], [0.2, 0, -0.18]);
  add(shape.strap, strapMaterial, BONES.spine, [-0.1, 0.04, 0.075], [0.2, 0, 0.18]);
  add(shape.pouch, strapMaterial, BONES.hips, [0.13, -0.02, 0.09], [0, 0, 0]);
  add(shape.pouch, strapMaterial, BONES.hips, [-0.13, -0.02, 0.09], [0, 0, 0]);

  // Limbs: shoulder pads at the shoulder joint, knee pads, boots.
  add(shape.shoulder, armour, BONES.leftArm, [0, -0.005, 0], [0, 0, -0.1]);
  add(shape.shoulder, armour, BONES.rightArm, [0, -0.005, 0], [0, 0, 0.1]);
  add(shape.knee, armourLight, BONES.leftLeg, [0, 0.01, 0.035], [0.1, 0, 0]);
  add(shape.knee, armourLight, BONES.rightLeg, [0, 0.01, 0.035], [0.1, 0, 0]);
  add(shape.boot, armour, BONES.leftFoot, [0, -0.04, 0.05], [0, 0, 0]);
  add(shape.boot, armour, BONES.rightFoot, [0, -0.04, 0.05], [0, 0, 0]);

  return { group, materials: owned, origins: Object.values(shape) };
}

/** Parent a weapon model to the right hand with the muzzle pointing forward. */
export function attachWeaponSocket(rig) {
  const hand = rig.getBone(BONES.rightHand);
  const socket = new THREE.Group();
  socket.name = WEAPON_SOCKET_NAME;
  if (hand) {
    // Weapon models are authored muzzle-toward -Z, but the body is flipped 180°
    // inside its wrapper, so the socket counter-rotates to keep the muzzle
    // pointing where the operator is facing.
    attachInModelSpace(rig.root, hand, socket, [0.13, -0.03, 0.04], [0, Math.PI, 0]);
  } else {
    rig.root.add(socket);
    socket.position.set(0.26, 1.15, 0.2);
  }
  return socket;
}

/**
 * Turn a bare rig into a complete operator.
 *
 * @param {import('./animation.js').CharacterRig} rig
 * @param {{accent?:string, color?:string, gear?:boolean, dress?:boolean}} options
 * @returns {{group:THREE.Group, body:THREE.Object3D, rig:object, socket:THREE.Group,
 *   setWeapon:Function, dispose:Function}}
 */
export function createOperator(rig, {
  color = null,
  accent = null,
  gear = true,
  dress = true,
} = {}) {
  if (!rig?.root) throw new Error('createOperator requires a CharacterRig');

  const group = new THREE.Group();
  group.name = 'operator';
  const body = rig.root;
  body.updateMatrixWorld(true);
  // The Mixamo model faces +Z; the game's yaw convention faces -Z, so the body
  // is flipped inside a wrapper. The wrapper is what gameplay rotates.
  body.rotation.y = Math.PI;
  group.add(body);

  if (color && rig.tint) rig.tint(color);
  const accentColor = accent ?? color ?? BRAND.accent;
  const dressed = dress ? dressOperator(rig, { accent: accentColor }) : null;
  const gearSet = gear ? attachTacticalGear(rig, { accent: accentColor }) : null;
  const socket = attachWeaponSocket(rig);

  return {
    group,
    body,
    rig,
    socket,
    gearMaterials: [...(dressed?.owned ?? []), ...(gearSet?.materials ?? [])],
    setWeapon(model) {
      if (!model) return null;
      for (const child of [...socket.children]) socket.remove(child);
      // Push the weapon forward so the grip, not the middle of the barrel, sits
      // in the hand: -Z is the muzzle direction in the socket's own space.
      const length = Number(model.userData?.length) || 0.7;
      model.position.set(0, 0, -length * 0.22);
      socket.add(model);
      return model;
    },
    dispose() {
      rig.dispose();
      for (const material of this.gearMaterials) material.dispose?.();
      this.gearMaterials.length = 0;
      // Gear geometry is shared by every operator and freed by disposeOperatorKit().
      group.removeFromParent();
    },
  };
}

export { BRAND as OPERATOR_PALETTE };
