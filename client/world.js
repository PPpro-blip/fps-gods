import * as THREE from 'three';
import { COVER, MAP, SPAWN_POINTS } from '../shared/gameConfig.js';

const arenaMaterials = {
  floor: new THREE.MeshStandardMaterial({ color: '#101927', roughness: 0.9, metalness: 0.18 }),
  wall: new THREE.MeshStandardMaterial({ color: '#172335', roughness: 0.76, metalness: 0.36 }),
  crate: [
    new THREE.MeshStandardMaterial({ color: '#26394a', roughness: 0.55, metalness: 0.45 }),
    new THREE.MeshStandardMaterial({ color: '#303347', roughness: 0.58, metalness: 0.4 }),
    new THREE.MeshStandardMaterial({ color: '#233e42', roughness: 0.58, metalness: 0.42 }),
  ],
};

// Builds all fixed, visual arena geometry. The matching collision data lives in
// shared/gameConfig.js and is used directly by the Node game server.
export class World {
  constructor(scene) {
    this.scene = scene;
    this.coverMeshes = new Map();
    this.roots = [];
    this.buildLighting();
    this.buildFloor();
    this.buildWalls();
    this.buildCover();
    this.buildSpawnMarkers();
  }

  buildLighting() {
    this.scene.background = new THREE.Color('#08111d');
    this.scene.fog = new THREE.FogExp2('#08111d', 0.0092);

    const hemisphere = new THREE.HemisphereLight('#c3e5ff', '#151a2b', 1.55);
    this.add(hemisphere);

    const key = new THREE.DirectionalLight('#d9edff', 2.15);
    key.position.set(-11, 23, 9);
    this.add(key);

    const cyan = new THREE.PointLight('#36bfe8', 115, 50, 2);
    cyan.position.set(-20, 5, -12);
    this.add(cyan);
    const orange = new THREE.PointLight('#ff874d', 95, 45, 2);
    orange.position.set(20, 4.5, 13);
    this.add(orange);

    // Suspended emissive markers provide a subtle artificial arena ceiling glow.
    for (const [x, z, color] of [[-19, -10, '#53d8ff'], [19, 10, '#ff9858'], [0, 0, '#93a8ff']]) {
      const lamp = new THREE.Mesh(
        new THREE.BoxGeometry(3.8, 0.09, 0.22),
        new THREE.MeshBasicMaterial({ color }),
      );
      lamp.position.set(x, MAP.wallHeight + 1.15, z);
      this.add(lamp);
    }
  }

  buildFloor() {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(MAP.halfWidth * 2, MAP.halfDepth * 2),
      arenaMaterials.floor,
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.025;
    floor.receiveShadow = false;
    this.add(floor);

    const grid = new THREE.GridHelper(MAP.halfWidth * 2, 60, '#224052', '#152738');
    grid.position.y = 0.006;
    grid.material.transparent = true;
    grid.material.opacity = 0.38;
    this.add(grid);

    // Thin perimeter lane markings and center rings break up the broad floor.
    this.addFloorLine(MAP.halfWidth - 1.1, MAP.halfDepth - 1.1, '#246278', 0.035);
    this.addFloorLine(0, 0, '#25617a', 0.045, 5.2);
    this.addFloorLine(0, 0, '#1c4257', 0.035, 10.4);

    const centerRing = new THREE.Mesh(
      new THREE.RingGeometry(5.17, 5.22, 96),
      new THREE.MeshBasicMaterial({ color: '#246b83', transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    centerRing.rotation.x = -Math.PI / 2;
    centerRing.position.y = 0.014;
    this.add(centerRing);
  }

  addFloorLine(halfWidth, halfDepth, color, thickness = 0.035, radius = null) {
    if (radius !== null) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(radius, radius + thickness, 96),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.53, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.012;
      this.add(ring);
      return;
    }

    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 });
    const horizontal = new THREE.Mesh(new THREE.BoxGeometry(halfWidth * 2, 0.012, thickness), material);
    horizontal.position.set(0, 0.012, halfDepth);
    const horizontalBack = horizontal.clone();
    horizontalBack.position.z = -halfDepth;
    const vertical = new THREE.Mesh(new THREE.BoxGeometry(thickness, 0.012, halfDepth * 2), material);
    vertical.position.set(halfWidth, 0.012, 0);
    const verticalLeft = vertical.clone();
    verticalLeft.position.x = -halfWidth;
    this.add(horizontal, horizontalBack, vertical, verticalLeft);
  }

  buildWalls() {
    const y = MAP.wallHeight / 2;
    const wallOptions = [
      [MAP.wallThickness, MAP.wallHeight, MAP.halfDepth * 2 + MAP.wallThickness * 2, MAP.halfWidth, y, 0],
      [MAP.wallThickness, MAP.wallHeight, MAP.halfDepth * 2 + MAP.wallThickness * 2, -MAP.halfWidth, y, 0],
      [MAP.halfWidth * 2, MAP.wallHeight, MAP.wallThickness, 0, y, MAP.halfDepth],
      [MAP.halfWidth * 2, MAP.wallHeight, MAP.wallThickness, 0, y, -MAP.halfDepth],
    ];

    for (const [width, height, depth, x, centerY, z] of wallOptions) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), arenaMaterials.wall);
      wall.position.set(x, centerY, z);
      this.add(wall);
    }

    // Continuous light strips make the arena edges readable without filling the
    // play space with visual clutter.
    const trimMaterial = new THREE.MeshBasicMaterial({ color: '#34718b' });
    const horizontalTrim = new THREE.BoxGeometry(MAP.halfWidth * 2, 0.07, 0.07);
    const verticalTrim = new THREE.BoxGeometry(0.07, 0.07, MAP.halfDepth * 2);
    for (const x of [-MAP.halfWidth + 0.52, MAP.halfWidth - 0.52]) {
      const trim = new THREE.Mesh(verticalTrim, trimMaterial);
      trim.position.set(x, 4.7, 0);
      this.add(trim);
    }
    for (const z of [-MAP.halfDepth + 0.52, MAP.halfDepth - 0.52]) {
      const trim = new THREE.Mesh(horizontalTrim, trimMaterial);
      trim.position.set(0, 4.7, z);
      this.add(trim);
    }
  }

  buildCover() {
    COVER.forEach((block, index) => {
      if (this.coverMeshes.has(index)) return;
      const geometry = new THREE.BoxGeometry(block.width, block.height, block.depth);
      const material = arenaMaterials.crate[index % arenaMaterials.crate.length];
      const crate = new THREE.Mesh(geometry, material);
      crate.position.set(block.x, block.height / 2, block.z);
      this.add(crate);

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry),
        new THREE.LineBasicMaterial({ color: index % 3 === 1 ? '#7d6a83' : '#5c9db0', transparent: true, opacity: 0.72 }),
      );
      edges.position.copy(crate.position);
      this.add(edges);

      // A narrow luminous seam makes each plain cube legible from a distance.
      const seam = new THREE.Mesh(
        new THREE.BoxGeometry(block.width * 0.86, 0.055, block.depth * 0.86),
        new THREE.MeshBasicMaterial({ color: index % 3 === 1 ? '#8b6680' : '#448198' }),
      );
      seam.position.set(block.x, block.height * 0.31, block.z);
      this.add(seam);
      this.coverMeshes.set(index, { crate, edges, seam });
    });
  }

  updateCover(remainingIds) {
    if (!Array.isArray(remainingIds)) return;
    const remaining = new Set(remainingIds);
    for (const [id, parts] of this.coverMeshes) {
      if (remaining.has(id)) continue;
      this.scene.remove(parts.crate, parts.edges, parts.seam);
      parts.crate.geometry.dispose();
      parts.edges.geometry.dispose();
      parts.edges.material.dispose();
      parts.seam.geometry.dispose();
      parts.seam.material.dispose();
      this.coverMeshes.delete(id);
    }
  }

  destroyCover(blockId) {
    if (!this.coverMeshes.has(blockId)) return;
    const remainingIds = [...this.coverMeshes.keys()].filter((id) => id !== blockId);
    this.updateCover(remainingIds);
  }

  resetCover() {
    this.buildCover();
  }

  /** Add an object to the scene and remember it, so `dispose()` is exact. */
  add(...objects) {
    for (const object of objects) {
      this.roots.push(object);
      this.scene.add(object);
    }
  }

  /** Release only the geometry and materials this world created. */
  dispose() {
    const geometries = new Set();
    const materials = new Set();
    for (const root of this.roots) {
      root.traverse?.((node) => {
        if (node.geometry) geometries.add(node.geometry);
        const list = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of list) if (material) materials.add(material);
      });
      this.scene.remove(root);
    }
    for (const geometry of geometries) geometry.dispose?.();
    for (const material of materials) material.dispose?.();
    this.roots.length = 0;
    this.coverMeshes.clear();
  }

  buildSpawnMarkers() {
    const baseMaterial = new THREE.MeshBasicMaterial({ color: '#173343', transparent: true, opacity: 0.58 });
    const ringMaterial = new THREE.MeshBasicMaterial({ color: '#4bc7e8', transparent: true, opacity: 0.72, side: THREE.DoubleSide });

    for (const spawn of SPAWN_POINTS) {
      const base = new THREE.Mesh(new THREE.CircleGeometry(0.82, 32), baseMaterial);
      base.rotation.x = -Math.PI / 2;
      base.position.set(spawn.x, 0.018, spawn.z);
      this.add(base);

      const ring = new THREE.Mesh(new THREE.RingGeometry(0.68, 0.73, 32), ringMaterial);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(spawn.x, 0.023, spawn.z);
      this.add(ring);
    }
  }
}
