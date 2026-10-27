import * as THREE from 'three';
import { getMap } from '../shared/maps.js';

// Arena presentation for the map the *server* chose.
//
// Every solid object here is drawn from the same `cover` records the server
// collides against, so nothing decorative ever sits inside the playable box:
// scenery is placed strictly beyond the walls. Lighting and palette come from
// the map's own config, which is why two arenas can feel completely different
// without any per-map code in this file.

/** Cover silhouettes. Each stays inside its collision AABB so looks match hits. */
function coverGeometry(block) {
  switch (block.kind) {
    case 'pillar':
      return new THREE.BoxGeometry(block.width, block.height, block.depth);
    case 'barrier':
      return new THREE.BoxGeometry(block.width, block.height, block.depth);
    case 'sandbag': {
      // Stacked bags: three slimmer boxes that together fill the collision box.
      const group = new THREE.Group();
      const rows = 3;
      const rowHeight = block.height / rows;
      for (let row = 0; row < rows; row += 1) {
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(block.width * (1 - row * 0.06), rowHeight * 0.92, block.depth),
        );
        mesh.position.y = -block.height / 2 + rowHeight * (row + 0.5);
        group.add(mesh);
      }
      return group;
    }
    case 'rock': {
      // A chamfered block reads as a boulder but still fills its AABB, so a
      // player never collides with air or walks through a visual edge.
      const geometry = new THREE.BoxGeometry(block.width, block.height, block.depth, 1, 1, 1);
      const position = geometry.attributes.position;
      for (let index = 0; index < position.count; index += 1) {
        const x = position.getX(index);
        const z = position.getZ(index);
        position.setY(index, position.getY(index) * (Math.abs(x) + Math.abs(z) > 0.5 ? 0.86 : 1));
      }
      geometry.computeVertexNormals();
      return geometry;
    }
    default:
      return new THREE.BoxGeometry(block.width, block.height, block.depth);
  }
}

export class World {
  constructor(scene) {
    this.scene = scene;
    this.mapId = null;
    this.map = null;
    this.coverMeshes = new Map();
    this.roots = [];
    this.ownedGeometries = new Set();
    this.ownedMaterials = new Set();
    this.materials = {};
    this.coverMaterials = undefined;
    this.built = false;
  }

  /**
   * Build (or rebuild) the arena for `mapId`.
   *
   * @returns {boolean} true when the arena actually changed, so the caller can
   *   skip redundant work on every 20 Hz room update.
   */
  setMap(mapId) {
    const map = getMap(mapId);
    if (this.built && this.mapId === map.id) return false;
    this.clear();
    this.mapId = map.id;
    this.map = map;
    this.buildMaterials();
    this.buildLighting();
    this.buildFloor();
    this.buildWalls();
    this.buildScenery();
    this.buildCover();
    this.buildSpawnMarkers();
    this.built = true;
    return true;
  }

  get palette() {
    return this.map?.palette ?? { accent: '#59d8ff' };
  }

  buildMaterials() {
    const palette = this.palette;
    const make = (material) => {
      this.ownedMaterials.add(material);
      return material;
    };
    this.materials = {
      // Readability contract for the arena: floor is the most matte surface
      // (it must read as walkable and not as a mirror), walls are the most
      // specular (vertical metal), and cover sits between them so blocks never
      // blend into either. Values and roughness are the primary separation;
      // hue is secondary.
      floor: make(new THREE.MeshStandardMaterial({
        color: palette.floor, roughness: 0.9, metalness: 0.12,
      })),
      wall: make(new THREE.MeshStandardMaterial({
        color: palette.wall, roughness: 0.55, metalness: 0.45,
      })),
      wallFoot: make(new THREE.MeshStandardMaterial({
        color: palette.wallFoot ?? '#1b2733', roughness: 0.95, metalness: 0.1,
      })),
      trim: make(new THREE.MeshBasicMaterial({ color: palette.wallTrim })),
      accent: make(new THREE.MeshBasicMaterial({ color: palette.accent })),
      cover: palette.cover.map((color) => make(new THREE.MeshStandardMaterial({
        color, roughness: 0.62, metalness: 0.3,
      }))),
      coverEdge: make(new THREE.LineBasicMaterial({
        color: palette.coverEdge, transparent: true, opacity: 0.75,
      })),
      coverSeam: make(new THREE.MeshBasicMaterial({ color: palette.coverSeam })),
      skyline: make(new THREE.MeshStandardMaterial({
        color: palette.skyline, roughness: 0.9, metalness: 0.1,
      })),
      skylineWindow: make(new THREE.MeshBasicMaterial({
        color: palette.accent, transparent: true, opacity: 0.42,
      })),
      markerBase: make(new THREE.MeshBasicMaterial({
        color: palette.floorLine, transparent: true, opacity: 0.5,
      })),
      markerRing: make(new THREE.MeshBasicMaterial({
        color: palette.accent, transparent: true, opacity: 0.8, side: THREE.DoubleSide,
      })),
    };
  }

  /**
   * Lighting is deliberately a small, named rig — hemisphere ambient, one key,
   * one fill, one rim, and a couple of accent points — rather than a pile of
   * lights. It is tuned per map so every arena is readable without washing out
   * the contrast that gives the game its look.
   */
  buildLighting() {
    const { lighting } = this.map;
    const palette = this.palette;

    this.scene.background = new THREE.Color(palette.background);
    this.scene.fog = new THREE.FogExp2(palette.fog.color, palette.fog.density);

    const hemisphere = new THREE.HemisphereLight(
      lighting.hemisphere.sky,
      lighting.hemisphere.ground,
      lighting.hemisphere.intensity,
    );
    this.add(hemisphere);

    const key = new THREE.DirectionalLight(lighting.key.color, lighting.key.intensity);
    key.position.set(...lighting.key.position);
    this.add(key);

    const fill = new THREE.DirectionalLight(lighting.fill.color, lighting.fill.intensity);
    fill.position.set(...lighting.fill.position);
    this.add(fill);

    const rim = new THREE.DirectionalLight(lighting.rim.color, lighting.rim.intensity);
    rim.position.set(...lighting.rim.position);
    this.add(rim);

    // A low ambient floor keeps unlit faces from crushing to pure black during
    // fast turns, which is what made combatants hard to pick out before.
    const ambient = new THREE.AmbientLight(palette.wall, 0.55);
    this.add(ambient);

    for (const accent of lighting.accents) {
      const light = new THREE.PointLight(accent.color, accent.intensity, accent.distance, 2);
      light.position.set(...accent.position);
      this.add(light);
    }

    // Ceiling luminaires: cheap emissive strips that justify the accent lights.
    const { halfWidth, halfDepth, wallHeight } = this.map.bounds;
    const lampGeometry = new THREE.BoxGeometry(3.6, 0.1, 0.24);
    this.ownedGeometries.add(lampGeometry);
    const lampColors = [palette.accent, palette.secondary];
    const positions = [
      [-halfWidth * 0.62, -halfDepth * 0.4],
      [halfWidth * 0.62, halfDepth * 0.4],
      [0, 0],
    ];
    positions.forEach(([x, z], index) => {
      const material = new THREE.MeshBasicMaterial({ color: lampColors[index % lampColors.length] });
      this.ownedMaterials.add(material);
      const lamp = new THREE.Mesh(lampGeometry, material);
      lamp.position.set(x, wallHeight + 0.9, z);
      this.add(lamp);
    });
  }

  buildFloor() {
    const { halfWidth, halfDepth } = this.map.bounds;
    const palette = this.palette;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(halfWidth * 2, halfDepth * 2),
      this.materials.floor,
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    this.add(floor);

    const grid = new THREE.GridHelper(halfWidth * 2, Math.round(halfWidth * 2.5), palette.grid, palette.grid);
    grid.position.y = 0.008;
    grid.material.transparent = true;
    grid.material.opacity = 0.28;
    this.add(grid);

    // Perimeter lane and centre rings give the eye a sense of scale and make
    // "playable floor" instantly distinguishable from walls.
    this.addFloorRing(halfWidth - 1.1, halfDepth - 1.1, palette.floorLine, 0.05);
    this.addFloorRing(0, 0, palette.floorLine, 0.06, 5.2);
    this.addFloorRing(0, 0, palette.grid, 0.04, 10.4);
  }

  addFloorRing(halfWidth, halfDepth, color, thickness = 0.04, radius = null) {
    const material = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.6, side: THREE.DoubleSide,
    });
    this.ownedMaterials.add(material);

    if (radius !== null) {
      const geometry = new THREE.RingGeometry(radius, radius + thickness, 96);
      this.ownedGeometries.add(geometry);
      const ring = new THREE.Mesh(geometry, material);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.014;
      this.add(ring);
      return;
    }

    const horizontal = new THREE.BoxGeometry(halfWidth * 2, 0.012, thickness);
    const vertical = new THREE.BoxGeometry(thickness, 0.012, halfDepth * 2);
    this.ownedGeometries.add(horizontal);
    this.ownedGeometries.add(vertical);
    for (const z of [halfDepth, -halfDepth]) {
      const line = new THREE.Mesh(horizontal, material);
      line.position.set(0, 0.012, z);
      this.add(line);
    }
    for (const x of [halfWidth, -halfWidth]) {
      const line = new THREE.Mesh(vertical, material);
      line.position.set(x, 0.012, 0);
      this.add(line);
    }
  }

  buildWalls() {
    const { halfWidth, halfDepth, wallHeight, wallThickness } = this.map.bounds;
    const y = wallHeight / 2;
    const wallOptions = [
      [wallThickness, wallHeight, halfDepth * 2 + wallThickness * 2, halfWidth, y, 0],
      [wallThickness, wallHeight, halfDepth * 2 + wallThickness * 2, -halfWidth, y, 0],
      [halfWidth * 2, wallHeight, wallThickness, 0, y, halfDepth],
      [halfWidth * 2, wallHeight, wallThickness, 0, y, -halfDepth],
    ];

    for (const [width, height, depth, x, centerY, z] of wallOptions) {
      const geometry = new THREE.BoxGeometry(width, height, depth);
      this.ownedGeometries.add(geometry);
      const wall = new THREE.Mesh(geometry, this.materials.wall);
      wall.position.set(x, centerY, z);
      this.add(wall);
    }

    // Dark skirting at the foot of each wall. Without it the wall face and the
    // floor meet at nearly the same value from a standing camera, which made
    // the boundary of the play space ambiguous.
    for (const [width, , depth, x, , z] of wallOptions) {
      const geometry = new THREE.BoxGeometry(
        Math.max(0.12, width - 0.02),
        0.42,
        Math.max(0.12, depth - 0.02),
      );
      this.ownedGeometries.add(geometry);
      const mesh = new THREE.Mesh(geometry, this.materials.wallFoot);
      mesh.position.set(
        x === 0 ? 0 : x * 0.995,
        0.21,
        z === 0 ? 0 : z * 0.995,
      );
      this.add(mesh);
    }

    // Luminous trim at the top and foot of every wall: the strongest cue for
    // where the playable area ends.
    const horizontalTrim = new THREE.BoxGeometry(halfWidth * 2, 0.08, 0.08);
    const verticalTrim = new THREE.BoxGeometry(0.08, 0.08, halfDepth * 2);
    this.ownedGeometries.add(horizontalTrim);
    this.ownedGeometries.add(verticalTrim);
    for (const height of [wallHeight - 0.9, 0.16]) {
      for (const x of [-halfWidth + 0.54, halfWidth - 0.54]) {
        const trim = new THREE.Mesh(verticalTrim, this.materials.trim);
        trim.position.set(x, height, 0);
        this.add(trim);
      }
      for (const z of [-halfDepth + 0.54, halfDepth - 0.54]) {
        const trim = new THREE.Mesh(horizontalTrim, this.materials.trim);
        trim.position.set(0, height, z);
        this.add(trim);
      }
    }
  }

  /**
   * Non-collidable background. Everything is placed *outside* the walls, so it
   * can never disagree with the server's collision box.
   */
  buildScenery() {
    const { halfWidth, halfDepth } = this.map.bounds;
    const style = this.map.scenery?.style ?? 'foundry';
    const accentGeometry = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    this.ownedGeometries.add(accentGeometry);

    const tower = (x, z, width, depth, height, color = this.materials.skyline) => {
      const geometry = new THREE.BoxGeometry(width, height, depth);
      this.ownedGeometries.add(geometry);
      const mesh = new THREE.Mesh(geometry, color);
      mesh.position.set(x, height / 2, z);
      this.add(mesh);

      // A few lit windows give the silhouette depth without extra lights.
      const windows = Math.min(6, Math.floor(height / 3));
      for (let index = 0; index < windows; index += 1) {
        const window = new THREE.Mesh(accentGeometry, this.materials.skylineWindow);
        window.position.set(
          x + (index % 2 === 0 ? width * 0.28 : -width * 0.28),
          1.6 + index * (height / (windows + 1)),
          z + depth * 0.52,
        );
        window.scale.set(width * 0.5, 0.9, 0.06);
        this.add(window);
      }
    };

    if (style === 'orbital') {
      // Skybridge floats: a void floor far below and a skyline encircling it.
      const voidFloor = new THREE.Mesh(
        new THREE.PlaneGeometry(halfWidth * 12, halfDepth * 12),
        this.materials.skyline,
      );
      voidFloor.rotation.x = -Math.PI / 2;
      voidFloor.position.y = -26;
      this.add(voidFloor);

      for (let index = 0; index < 9; index += 1) {
        const angle = (index / 9) * Math.PI * 2;
        const distance = 34 + (index % 3) * 9;
        tower(
          Math.cos(angle) * distance,
          Math.sin(angle) * (halfDepth + distance * 0.7),
          5 + (index % 3),
          5 + (index % 2) * 2,
          22 + (index % 4) * 12,
        );
      }
    } else if (style === 'desert') {
      // Dunes and rock spires beyond the outpost wall.
      for (let index = 0; index < 14; index += 1) {
        const side = index % 2 === 0 ? 1 : -1;
        const x = side * (halfWidth + 6 + (index % 5) * 4);
        const z = -halfDepth + (index / 14) * halfDepth * 2;
        const width = 6 + (index % 4) * 3;
        const height = 2.4 + (index % 3) * 1.6;
        const geometry = new THREE.BoxGeometry(width, height, width * 1.3);
        this.ownedGeometries.add(geometry);
        const dune = new THREE.Mesh(geometry, this.materials.skyline);
        dune.position.set(x, height / 2 - 0.4, z);
        dune.rotation.y = (index % 5) * 0.3;
        this.add(dune);
      }
      for (let index = 0; index < 5; index += 1) {
        tower(-halfWidth - 12 + index * 7, -halfDepth - 14, 3.2, 3.2, 9 + (index % 3) * 5);
      }
    } else {
      // Foundry: gantries and chimneys ringing the arena.
      for (let index = 0; index < 10; index += 1) {
        const angle = (index / 10) * Math.PI * 2;
        const x = Math.cos(angle) * (halfWidth + 9);
        const z = Math.sin(angle) * (halfDepth + 9);
        tower(x, z, 3.4 + (index % 3), 3.4, 10 + (index % 4) * 5);
      }
      // Overhead pipes bridging the arena, well above head height.
      for (const x of [-halfWidth * 0.5, halfWidth * 0.5]) {
        const geometry = new THREE.CylinderGeometry(0.22, 0.22, halfDepth * 2 + 4, 8);
        this.ownedGeometries.add(geometry);
        const pipe = new THREE.Mesh(geometry, this.materials.wall);
        pipe.rotation.x = Math.PI / 2;
        pipe.position.set(x, this.map.bounds.wallHeight + 2.2, 0);
        this.add(pipe);
      }
    }
  }

  buildCover() {
    this.map.cover.forEach((block, index) => {
      if (this.coverMeshes.has(index)) return;
      // `coverGeometry` returns either one BufferGeometry or a Group of meshes
      // (stacked sandbags). Both have to end up wrapped in a Mesh with the cover
      // material: adding a bare geometry to a Group silently draws nothing, which
      // is how cover shipped as wireframe edges with no body.
      const shape = coverGeometry(block);
      const body = new THREE.Group();
      body.position.set(block.x, block.height / 2, block.z);
      const material = this.coverMaterial(block.kind, index);

      const bodies = [];
      if (shape.isGroup) {
        for (const child of [...shape.children]) {
          child.material = material;
          this.ownedGeometries.add(child.geometry);
          bodies.push(child);
        }
      } else {
        this.ownedGeometries.add(shape);
        bodies.push(new THREE.Mesh(shape, material));
      }
      body.add(...bodies);
      this.add(body);

      // Wireframe edge: reads as machined panel edges and keeps each block
      // legible against the floor at range.
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(block.width, block.height, block.depth)),
        this.materials.coverEdge,
      );
      this.ownedGeometries.add(edges.geometry);
      edges.position.copy(body.position);
      this.add(edges);

      // Luminous seam at eye-catching height.
      const seamGeometry = new THREE.BoxGeometry(block.width * 0.9, 0.07, block.depth * 0.9);
      this.ownedGeometries.add(seamGeometry);
      const seam = new THREE.Mesh(seamGeometry, this.materials.coverSeam);
      seam.position.set(block.x, Math.min(block.height - 0.18, block.height * 0.72), block.z);
      this.add(seam);

      this.coverMeshes.set(index, { crate: body, edges, seam });
    });
  }

  /**
   * Per-kind cover surface. Crates are matte painted wood/steel, containers are
   * painted sheet metal, pillars are concrete, barriers are hazard-coated —
   * distinct enough that players can tell a crate from a pillar at range by
   * highlight shape alone, not just silhouette.
   */
  coverMaterial(kind, index) {
    const color = this.palette.cover[index % this.palette.cover.length];
    const profile = {
      crate: { roughness: 0.72, metalness: 0.16 },
      container: { roughness: 0.5, metalness: 0.46 },
      pillar: { roughness: 0.94, metalness: 0.06 },
      barrier: { roughness: 0.44, metalness: 0.34 },
    }[kind] ?? { roughness: 0.62, metalness: 0.3 };
    this.coverMaterials ??= new Map();
    const key = `${kind}:${color}`;
    let material = this.coverMaterials.get(key);
    if (!material) {
      material = new THREE.MeshStandardMaterial({ color, ...profile });
      this.ownedMaterials.add(material);
      this.coverMaterials.set(key, material);
    }
    return material;
  }

  updateCover(remainingIds) {
    if (!Array.isArray(remainingIds)) return;
    const remaining = new Set(remainingIds);
    for (const [id, parts] of this.coverMeshes) {
      if (remaining.has(id)) continue;
      this.scene.remove(parts.crate, parts.edges, parts.seam);
      parts.crate.traverse((node) => {
        if (node.geometry) node.geometry.dispose();
      });
      parts.edges.geometry.dispose();
      parts.seam.geometry.dispose();
      this.coverMeshes.delete(id);
    }
  }

  destroyCover(blockId) {
    if (!this.coverMeshes.has(blockId)) return;
    const remainingIds = [...this.coverMeshes.keys()].filter((id) => id !== blockId);
    this.updateCover(remainingIds);
  }

  /** Rebuild every cover block, e.g. at the start of a new match. */
  resetCover() {
    for (const [, parts] of this.coverMeshes) {
      this.scene.remove(parts.crate, parts.edges, parts.seam);
    }
    this.coverMeshes.clear();
    if (this.built) this.buildCover();
  }

  buildSpawnMarkers() {
    const ringGeometry = new THREE.RingGeometry(0.66, 0.72, 32);
    const baseGeometry = new THREE.CircleGeometry(0.8, 32);
    this.ownedGeometries.add(ringGeometry);
    this.ownedGeometries.add(baseGeometry);

    for (const spawn of this.map.spawns) {
      const base = new THREE.Mesh(baseGeometry, this.materials.markerBase);
      base.rotation.x = -Math.PI / 2;
      base.position.set(spawn.x, 0.016, spawn.z);
      this.add(base);

      const ring = new THREE.Mesh(ringGeometry, this.materials.markerRing);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(spawn.x, 0.022, spawn.z);
      this.add(ring);
    }
  }

  /** Add an object to the scene and remember it, so `dispose()` is exact. */
  add(...objects) {
    for (const object of objects) {
      this.roots.push(object);
      this.scene.add(object);
    }
  }

  /** Remove this arena from the scene without releasing shared materials. */
  clear() {
    for (const root of this.roots) this.scene.remove(root);
    this.roots.length = 0;
    this.coverMeshes.clear();
    for (const geometry of this.ownedGeometries) geometry.dispose?.();
    this.ownedGeometries.clear();
    for (const material of this.ownedMaterials) material.dispose?.();
    this.ownedMaterials.clear();
    this.materials = {};
    this.coverMaterials = undefined;
    this.built = false;
    this.scene.background = null;
    this.scene.fog = null;
  }

  /** Release only the geometry and materials this world created. */
  dispose() {
    this.clear();
    this.mapId = null;
    this.map = null;
  }
}
