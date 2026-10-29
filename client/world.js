import * as THREE from 'three';
import { getMap } from '../shared/maps.js';

// Arena presentation for the map the *server* chose.
//
// Every solid object inside playable bounds is drawn from the exact `cover`
// records the server collides against, so nothing decorative ever blocks or
// misleads movement: landmarks, gantries, turbines, and ambient motes live
// strictly above head height or outside the perimeter walls.

/**
 * Structured cover silhouettes. Every child stays strictly inside the block's
 * `[width, height, depth]` AABB and touches its outer faces so `Box3` bounds
 * match server collision 1:1 while directional light catches real 3D relief.
 */
function buildStructuredCoverGroup(block, unitBox) {
  const group = new THREE.Group();
  const w = block.width;
  const h = block.height;
  const d = block.depth;

  const addBox = (sx, sy, sz, px = 0, py = 0, pz = 0) => {
    const mesh = new THREE.Mesh(unitBox);
    mesh.scale.set(sx, sy, sz);
    mesh.position.set(px, py, pz);
    group.add(mesh);
    return mesh;
  };

  switch (block.kind) {
    case 'container': {
      // Recessed corrugated core + 4 heavy corner posts + top/bottom frame rails.
      addBox(w * 0.92, h * 0.90, d * 0.92);
      const railH = Math.min(0.14, h * 0.08);
      addBox(w, railH, d, 0, h / 2 - railH / 2, 0);
      addBox(w, railH, d, 0, -h / 2 + railH / 2, 0);

      const postW = Math.min(0.18, w * 0.12);
      const postD = Math.min(0.18, d * 0.12);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          addBox(postW, h, postD, sx * (w / 2 - postW / 2), 0, sz * (d / 2 - postD / 2));
        }
      }

      // Corrugation ribs along whichever horizontal axis is longer.
      const alongX = w >= d;
      const span = alongX ? w - postW * 2.4 : d - postD * 2.4;
      const ribCount = Math.max(2, Math.min(6, Math.floor(span / 0.85)));
      for (let i = 0; i < ribCount; i += 1) {
        const offset = -span * 0.42 + (ribCount > 1 ? (i / (ribCount - 1)) * span * 0.84 : 0);
        if (alongX) {
          addBox(0.10, h * 0.78, d * 0.985, offset, 0, 0);
        } else {
          addBox(w * 0.985, h * 0.78, 0.10, 0, 0, offset);
        }
      }
      return group;
    }

    case 'crate': {
      // Industrial framed supply crate with recessed faces and cross-battens.
      addBox(w * 0.90, h * 0.88, d * 0.90);
      const capH = Math.min(0.12, h * 0.09);
      addBox(w, capH, d, 0, h / 2 - capH / 2, 0);
      addBox(w, capH, d, 0, -h / 2 + capH / 2, 0);

      const stileW = Math.min(0.14, w * 0.11);
      const stileD = Math.min(0.14, d * 0.11);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          addBox(stileW, h, stileD, sx * (w / 2 - stileW / 2), 0, sz * (d / 2 - stileD / 2));
        }
      }
      addBox(w * 0.98, Math.min(0.11, h * 0.08), d * 0.98, 0, 0, 0);
      return group;
    }

    case 'pillar': {
      // Heavy architectural column: full-footprint plinth + capital + fluted shaft.
      const plinthH = Math.min(0.28, h * 0.09);
      const capH = Math.min(0.24, h * 0.08);
      addBox(w, plinthH, d, 0, -h / 2 + plinthH / 2, 0);
      addBox(w, capH, d, 0, h / 2 - capH / 2, 0);
      addBox(w * 0.82, h - plinthH - capH, d * 0.82, 0, (plinthH - capH) * 0.5, 0);
      addBox(w * 0.96, h * 0.84, d * 0.36, 0, 0, 0);
      addBox(w * 0.36, h * 0.84, d * 0.96, 0, 0, 0);
      return group;
    }

    case 'barrier': {
      // Ballistic jersey/blast barrier: wide footing, recessed armor core, top lip, end buttresses.
      const footH = Math.min(0.24, h * 0.18);
      const lipH = Math.min(0.16, h * 0.12);
      addBox(w, footH, d, 0, -h / 2 + footH / 2, 0);
      addBox(w, lipH, d, 0, h / 2 - lipH / 2, 0);
      addBox(w * 0.94, h - footH - lipH, d * 0.74, 0, (footH - lipH) * 0.5, 0);
      const endW = Math.min(0.18, w * 0.10);
      const endD = Math.min(0.18, d * 0.10);
      if (w >= d) {
        addBox(endW, h, d, -w / 2 + endW / 2, 0, 0);
        addBox(endW, h, d, w / 2 - endW / 2, 0, 0);
      } else {
        addBox(w, h, endD, 0, 0, -d / 2 + endD / 2);
        addBox(w, h, endD, 0, 0, d / 2 - endD / 2);
      }
      return group;
    }

    case 'sandbag': {
      // Three stacked sandbag courses filling the exact outer AABB.
      const rows = 3;
      const rowHeight = h / rows;
      for (let row = 0; row < rows; row += 1) {
        const taper = row === 0 ? 1 : (1 - row * 0.05);
        const courseH = row === rows - 1 ? rowHeight : rowHeight * 0.92;
        const y = row === rows - 1
          ? h / 2 - courseH / 2
          : -h / 2 + rowHeight * (row + 0.46);
        addBox(w * taper, courseH, d * taper, 0, y, 0);
      }
      return group;
    }

    case 'rock': {
      // Stratified desert boulder: chamfered main mass + lower full-footprint shelf.
      const shelfH = h * 0.34;
      addBox(w, shelfH, d, 0, -h / 2 + shelfH / 2, 0);
      const crown = new THREE.BoxGeometry(w * 0.92, h, d * 0.92, 1, 1, 1);
      const pos = crown.attributes.position;
      for (let index = 0; index < pos.count; index += 1) {
        const x = pos.getX(index);
        const y = pos.getY(index);
        const z = pos.getZ(index);
        if (y > 0 && Math.abs(x) + Math.abs(z) > (w + d) * 0.35) {
          pos.setX(index, x * 0.84);
          pos.setZ(index, z * 0.84);
        }
      }
      crown.computeVertexNormals();
      const crownMesh = new THREE.Mesh(crown);
      crownMesh.userData.ownGeometry = true;
      group.add(crownMesh);
      return group;
    }

    default:
      addBox(w, h, d);
      return group;
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
    this.animatedItems = [];
    this.sharedUnitBox = null;
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
    this.sharedUnitBox = new THREE.BoxGeometry(1, 1, 1);
    this.ownedGeometries.add(this.sharedUnitBox);

    this.buildMaterials();
    this.buildLighting();
    this.buildFloor();
    this.buildWalls();
    this.buildSectorLandmarks();
    this.buildScenery();
    this.buildAmbientLife();
    this.buildCover();
    this.buildSpawnMarkers();
    this.built = true;
    return true;
  }

  get palette() {
    return this.map?.palette ?? { accent: '#59d8ff', secondary: '#ff7a3d' };
  }

  buildMaterials() {
    const palette = this.palette;
    const make = (material) => {
      this.ownedMaterials.add(material);
      return material;
    };

    const floorColor = new THREE.Color(palette.floor);
    const wallColor = new THREE.Color(palette.wall);
    const deckPlateColor = floorColor.clone().lerp(wallColor, 0.34);
    const gantryColor = wallColor.clone().multiplyScalar(0.72);

    this.materials = {
      // Readability contract for the arena: floor is the most matte surface
      // (it must read as walkable and not as a mirror), walls are the most
      // specular (vertical metal), and cover sits between them so blocks never
      // blend into either. Values and roughness are the primary separation;
      // hue is secondary.
      floor: make(new THREE.MeshStandardMaterial({
        color: palette.floor, roughness: 0.9, metalness: 0.12,
      })),
      deckPlate: make(new THREE.MeshStandardMaterial({
        color: deckPlateColor, roughness: 0.92, metalness: 0.10,
      })),
      gantry: make(new THREE.MeshStandardMaterial({
        color: gantryColor, roughness: 0.60, metalness: 0.42,
      })),
      wall: make(new THREE.MeshStandardMaterial({
        color: palette.wall, roughness: 0.55, metalness: 0.45,
      })),
      wallFoot: make(new THREE.MeshStandardMaterial({
        color: palette.wallFoot ?? '#1b2733', roughness: 0.95, metalness: 0.1,
      })),
      trim: make(new THREE.MeshBasicMaterial({ color: palette.wallTrim })),
      accent: make(new THREE.MeshBasicMaterial({ color: palette.accent })),
      secondary: make(new THREE.MeshBasicMaterial({ color: palette.secondary ?? palette.wallTrim })),
      laneNorth: make(new THREE.MeshBasicMaterial({
        color: palette.accent, transparent: true, opacity: 0.46,
      })),
      laneSouth: make(new THREE.MeshBasicMaterial({
        color: palette.secondary ?? palette.wallTrim, transparent: true, opacity: 0.46,
      })),
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
      skylineWarmWindow: make(new THREE.MeshBasicMaterial({
        color: palette.secondary ?? palette.accent, transparent: true, opacity: 0.38,
      })),
      markerBase: make(new THREE.MeshBasicMaterial({
        color: palette.floorLine, transparent: true, opacity: 0.5,
      })),
      markerRing: make(new THREE.MeshBasicMaterial({
        color: palette.accent, transparent: true, opacity: 0.8, side: THREE.DoubleSide,
      })),
      mote: make(new THREE.MeshBasicMaterial({
        color: palette.accent, transparent: true, opacity: 0.44, depthWrite: false,
      })),
      moteWarm: make(new THREE.MeshBasicMaterial({
        color: palette.secondary ?? palette.accent, transparent: true, opacity: 0.40, depthWrite: false,
      })),
    };
  }

  /**
   * Lighting is deliberately a small, named rig — hemisphere ambient, one key,
   * one fill, one rim, and up to three accent points — tuned per map so every
   * arena is readable without washing out silhouette contrast.
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

    const ambient = new THREE.AmbientLight(palette.wall, 0.55);
    this.add(ambient);

    for (const accent of lighting.accents) {
      const light = new THREE.PointLight(accent.color, accent.intensity, accent.distance, 2);
      light.position.set(...accent.position);
      this.add(light);
    }

    // Overhead gantry trusses & suspended luminaires: anchors the accent lights
    // to believable ceiling structure well above combat sightlines.
    const { halfWidth, halfDepth, wallHeight } = this.map.bounds;
    const lampColors = [palette.accent, palette.secondary ?? palette.wallTrim];
    const positions = [
      [-halfWidth * 0.62, -halfDepth * 0.4],
      [halfWidth * 0.62, halfDepth * 0.4],
      [0, 0],
    ];
    const gantryGroup = new THREE.Group();
    positions.forEach(([x, z], index) => {
      // Cross-arena steel girder spanning wall-to-wall above head height.
      const beam = new THREE.Mesh(this.sharedUnitBox, this.materials.gantry);
      beam.scale.set(halfWidth * 2 + 1.2, 0.28, 0.34);
      beam.position.set(0, wallHeight + 1.48, z);
      gantryGroup.add(beam);

      // Vertical hanger struts dropping from girder to luminaire housing.
      for (const dx of [-1.45, 1.45]) {
        const strut = new THREE.Mesh(this.sharedUnitBox, this.materials.gantry);
        strut.scale.set(0.10, 0.54, 0.12);
        strut.position.set(x + dx, wallHeight + 1.18, z);
        gantryGroup.add(strut);
      }

      const housing = new THREE.Mesh(this.sharedUnitBox, this.materials.wallFoot);
      housing.scale.set(3.84, 0.12, 0.38);
      housing.position.set(x, wallHeight + 0.96, z);
      gantryGroup.add(housing);

      const material = new THREE.MeshBasicMaterial({ color: lampColors[index % lampColors.length] });
      this.ownedMaterials.add(material);
      const lamp = new THREE.Mesh(this.sharedUnitBox, material);
      lamp.scale.set(3.6, 0.09, 0.24);
      lamp.position.set(x, wallHeight + 0.89, z);
      gantryGroup.add(lamp);
    });
    this.add(gantryGroup);
  }

  buildFloor() {
    const { halfWidth, halfDepth } = this.map.bounds;
    const palette = this.palette;

    const floorGeometry = new THREE.PlaneGeometry(halfWidth * 2, halfDepth * 2);
    this.ownedGeometries.add(floorGeometry);
    const floor = new THREE.Mesh(floorGeometry, this.materials.floor);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    this.add(floor);

    // Recessed architectural deck plates along the three primary lanes (West
    // flank, Centre spine, East flank) break up the dark floor plane and make
    // player stride speed immediately legible without altering collision height.
    const deckGroup = new THREE.Group();
    const laneXs = [-halfWidth * 0.56, 0, halfWidth * 0.56];
    const bayRows = 5;
    const baySpanZ = (halfDepth * 1.72) / bayRows;
    for (const lx of laneXs) {
      for (let r = 0; r < bayRows; r += 1) {
        const lz = -halfDepth * 0.86 + baySpanZ * (r + 0.5);
        const plate = new THREE.Mesh(this.sharedUnitBox, this.materials.deckPlate);
        plate.scale.set(halfWidth * 0.36, 0.008, baySpanZ * 0.84);
        plate.position.set(lx, -0.008, lz);
        deckGroup.add(plate);
      }
    }

    // North vs South floor callout strips so floor orientation matches skyline:
    // North half carries cool accent lane ticks, South half carries secondary ticks.
    for (const lx of laneXs) {
      const northTick = new THREE.Mesh(this.sharedUnitBox, this.materials.laneNorth);
      northTick.scale.set(1.6, 0.006, 0.09);
      northTick.position.set(lx, 0.011, -halfDepth * 0.62);
      deckGroup.add(northTick);

      const southTick = new THREE.Mesh(this.sharedUnitBox, this.materials.laneSouth);
      southTick.scale.set(1.6, 0.006, 0.09);
      southTick.position.set(lx, 0.011, halfDepth * 0.62);
      deckGroup.add(southTick);
    }
    this.add(deckGroup);

    const grid = new THREE.GridHelper(halfWidth * 2, Math.round(halfWidth * 2.5), palette.grid, palette.grid);
    grid.position.y = 0.008;
    grid.material.transparent = true;
    grid.material.opacity = 0.28;
    this.ownedGeometries.add(grid.geometry);
    if (Array.isArray(grid.material)) {
      grid.material.forEach((m) => this.ownedMaterials.add(m));
    } else {
      this.ownedMaterials.add(grid.material);
    }
    this.add(grid);

    // Perimeter lane and centre rings give the eye a sense of scale and make
    // "playable floor" instantly distinguishable from walls.
    this.addFloorRing(halfWidth - 1.1, halfDepth - 1.1, palette.floorLine, 0.05);
    const coreRing = this.addFloorRing(0, 0, palette.floorLine, 0.06, 5.2);
    this.addFloorRing(0, 0, palette.grid, 0.04, 10.4);
    if (coreRing?.material) {
      this.animatedItems.push({
        kind: 'pulse-opacity',
        material: coreRing.material,
        base: 0.46,
        amp: 0.20,
        speed: 1.8,
        phase: 0,
      });
    }
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
      return ring;
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
    return null;
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

    // Dark skirting at the foot of each wall so floor-to-wall boundaries read crisply.
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

    // Structural pilasters & upper coping beam along perimeter walls so 60 m
    // spans read as segmented industrial/orbital/outpost bays rather than flat planes.
    const reliefGroup = new THREE.Group();
    const innerX = halfWidth - wallThickness * 0.5;
    const innerZ = halfDepth - wallThickness * 0.5;
    const bayCount = 7;
    for (let i = 1; i < bayCount; i += 1) {
      const frac = -1 + (i / bayCount) * 2;
      const zPos = frac * (halfDepth - 2);
      const xPos = frac * (halfWidth - 2);

      for (const sign of [-1, 1]) {
        const eastWestRib = new THREE.Mesh(this.sharedUnitBox, this.materials.gantry);
        eastWestRib.scale.set(0.10, wallHeight - 0.3, 0.44);
        eastWestRib.position.set(sign * (innerX - 0.03), wallHeight * 0.5 + 0.08, zPos);
        reliefGroup.add(eastWestRib);

        const northSouthRib = new THREE.Mesh(this.sharedUnitBox, this.materials.gantry);
        northSouthRib.scale.set(0.44, wallHeight - 0.3, 0.10);
        northSouthRib.position.set(xPos, wallHeight * 0.5 + 0.08, sign * (innerZ - 0.03));
        reliefGroup.add(northSouthRib);
      }
    }

    // Upper cornice coping along the top of all four walls.
    for (const sign of [-1, 1]) {
      const ewCope = new THREE.Mesh(this.sharedUnitBox, this.materials.wallFoot);
      ewCope.scale.set(wallThickness + 0.24, 0.22, halfDepth * 2 + wallThickness * 2);
      ewCope.position.set(sign * halfWidth, wallHeight + 0.11, 0);
      reliefGroup.add(ewCope);

      const nsCope = new THREE.Mesh(this.sharedUnitBox, this.materials.wallFoot);
      nsCope.scale.set(halfWidth * 2 + wallThickness * 2, 0.22, wallThickness + 0.24);
      nsCope.position.set(0, wallHeight + 0.11, sign * halfDepth);
      reliefGroup.add(nsCope);
    }
    this.add(reliefGroup);

    // Luminous trim at the top and foot of every wall: North/West lean cool
    // trim while South gets secondary callout accents above.
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
   * High-readability North vs South sector landmarks & East/West mid-axis
   * pylons mounted atop/outside the walls so players instantly know their
   * orientation from any camera angle without adding obstacles inside the floor.
   */
  buildSectorLandmarks() {
    const { halfWidth, halfDepth, wallHeight } = this.map.bounds;
    const landmarks = new THREE.Group();

    const buildGate = (zSign, beaconMat) => {
      const z = zSign * (halfDepth + 0.35);
      // Twin tall stanchions framing the sector centreline.
      for (const sx of [-1, 1]) {
        const column = new THREE.Mesh(this.sharedUnitBox, this.materials.wall);
        column.scale.set(1.25, 5.2, 1.15);
        column.position.set(sx * 5.6, wallHeight + 2.6, z);
        landmarks.add(column);

        const vStrip = new THREE.Mesh(this.sharedUnitBox, beaconMat);
        vStrip.scale.set(0.16, 4.1, 0.18);
        vStrip.position.set(sx * 5.6, wallHeight + 2.6, z - zSign * 0.56);
        landmarks.add(vStrip);
      }

      // Overhead portal lintel + secondary crown bar.
      const lintel = new THREE.Mesh(this.sharedUnitBox, this.materials.gantry);
      lintel.scale.set(13.2, 0.85, 1.3);
      lintel.position.set(0, wallHeight + 4.9, z);
      landmarks.add(lintel);

      const beaconBar = new THREE.Mesh(this.sharedUnitBox, beaconMat);
      beaconBar.scale.set(9.4, 0.18, 0.22);
      beaconBar.position.set(0, wallHeight + 4.88, z - zSign * 0.62);
      landmarks.add(beaconBar);

      // Distinct silhouette cue: North gets a single central spire fin,
      // South gets twin stepped bastion horns.
      if (zSign < 0) {
        const spire = new THREE.Mesh(this.sharedUnitBox, this.materials.wall);
        spire.scale.set(1.8, 2.4, 0.9);
        spire.position.set(0, wallHeight + 6.4, z);
        landmarks.add(spire);

        const tip = new THREE.Mesh(this.sharedUnitBox, beaconMat);
        tip.scale.set(0.26, 1.8, 0.24);
        tip.position.set(0, wallHeight + 6.5, z - zSign * 0.46);
        landmarks.add(tip);
      } else {
        for (const sx of [-2.6, 2.6]) {
          const horn = new THREE.Mesh(this.sharedUnitBox, this.materials.wall);
          horn.scale.set(1.35, 1.9, 0.9);
          horn.position.set(sx, wallHeight + 6.1, z);
          landmarks.add(horn);

          const pip = new THREE.Mesh(this.sharedUnitBox, beaconMat);
          pip.scale.set(0.75, 0.16, 0.22);
          pip.position.set(sx, wallHeight + 6.75, z - zSign * 0.46);
          landmarks.add(pip);
        }
      }
    };

    buildGate(-1, this.materials.accent);
    buildGate(1, this.materials.secondary);

    // East & West mid-axis flank pylons marking `z = 0`.
    for (const xSign of [-1, 1]) {
      const x = xSign * (halfWidth + 0.4);
      const pylon = new THREE.Mesh(this.sharedUnitBox, this.materials.gantry);
      pylon.scale.set(0.95, 3.2, 2.8);
      pylon.position.set(x, wallHeight + 1.6, 0);
      landmarks.add(pylon);

      const strip = new THREE.Mesh(this.sharedUnitBox, xSign < 0 ? this.materials.accent : this.materials.secondary);
      strip.scale.set(0.18, 0.16, 2.2);
      strip.position.set(x - xSign * 0.46, wallHeight + 2.45, 0);
      landmarks.add(strip);
    }

    this.add(landmarks);
  }

  /**
   * Non-collidable background strictly beyond the walls so it never disagrees
   * with the server's collision box.
   */
  buildScenery() {
    const { halfWidth, halfDepth } = this.map.bounds;
    const style = this.map.scenery?.style ?? 'foundry';

    const tower = (x, z, width, depth, height, warm = false) => {
      const mesh = new THREE.Mesh(this.sharedUnitBox, this.materials.skyline);
      mesh.scale.set(width, height, depth);
      mesh.position.set(x, height / 2, z);
      this.add(mesh);

      const winMat = warm ? this.materials.skylineWarmWindow : this.materials.skylineWindow;
      const windows = Math.min(6, Math.floor(height / 3));
      const faceSign = z > 0 ? -1 : 1;
      for (let index = 0; index < windows; index += 1) {
        const win = new THREE.Mesh(this.sharedUnitBox, winMat);
        win.position.set(
          x + (index % 2 === 0 ? width * 0.24 : -width * 0.24),
          1.8 + index * (height / (windows + 1)),
          z + faceSign * (depth * 0.51),
        );
        win.scale.set(width * 0.36, 0.42, 0.06);
        this.add(win);
      }
    };

    if (style === 'orbital') {
      const voidGeometry = new THREE.PlaneGeometry(halfWidth * 12, halfDepth * 12);
      this.ownedGeometries.add(voidGeometry);
      const voidFloor = new THREE.Mesh(voidGeometry, this.materials.skyline);
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
          index % 3 === 1,
        );
      }
    } else if (style === 'desert') {
      for (let index = 0; index < 14; index += 1) {
        const side = index % 2 === 0 ? 1 : -1;
        const x = side * (halfWidth + 6 + (index % 5) * 4);
        const z = -halfDepth + (index / 14) * halfDepth * 2;
        const width = 6 + (index % 4) * 3;
        const height = 2.4 + (index % 3) * 1.8;
        const dune = new THREE.Mesh(this.sharedUnitBox, this.materials.skyline);
        dune.scale.set(width, height, width * 1.3);
        dune.position.set(x, height / 2 - 0.4, z);
        dune.rotation.y = (index % 5) * 0.3;
        this.add(dune);
      }
      for (let index = 0; index < 5; index += 1) {
        tower(-halfWidth - 12 + index * 7, -halfDepth - 14, 3.2, 3.2, 9 + (index % 3) * 5, index % 2 === 1);
      }
    } else {
      for (let index = 0; index < 10; index += 1) {
        const angle = (index / 10) * Math.PI * 2;
        const x = Math.cos(angle) * (halfWidth + 9);
        const z = Math.sin(angle) * (halfDepth + 9);
        tower(x, z, 3.4 + (index % 3), 3.4, 10 + (index % 4) * 5, index >= 5);
      }
      const pipeGeometry = new THREE.CylinderGeometry(0.22, 0.22, halfDepth * 2 + 4, 8);
      this.ownedGeometries.add(pipeGeometry);
      for (const x of [-halfWidth * 0.5, halfWidth * 0.5]) {
        const pipe = new THREE.Mesh(pipeGeometry, this.materials.wall);
        pipe.rotation.x = Math.PI / 2;
        pipe.position.set(x, this.map.bounds.wallHeight + 2.2, 0);
        this.add(pipe);
      }
    }
  }

  /**
   * Restrained, purposeful mechanical & atmospheric life per arena. Every
   * animated node sits outside the walls or high overhead so combat sightlines
   * remain 100% crisp.
   */
  buildAmbientLife() {
    const { halfWidth, halfDepth, wallHeight } = this.map.bounds;
    const style = this.map.scenery?.style ?? 'foundry';
    const lifeGroup = new THREE.Group();

    if (style === 'foundry') {
      // Twin giant exhaust turbines mounted in East & West outer furnace housings.
      const ringGeo = new THREE.TorusGeometry(2.35, 0.22, 8, 24);
      this.ownedGeometries.add(ringGeo);

      for (const sign of [-1, 1]) {
        const housing = new THREE.Group();
        housing.position.set(sign * (halfWidth + 3.1), wallHeight + 3.4, -sign * 7.5);
        housing.rotation.y = sign < 0 ? Math.PI / 2 : -Math.PI / 2;

        const shroud = new THREE.Mesh(ringGeo, this.materials.gantry);
        housing.add(shroud);

        const glowRing = new THREE.Mesh(ringGeo, sign < 0 ? this.materials.accent : this.materials.secondary);
        glowRing.scale.set(0.92, 0.92, 0.35);
        glowRing.position.z = 0.08;
        housing.add(glowRing);

        const rotor = new THREE.Group();
        for (let b = 0; b < 6; b += 1) {
          const bladeWrap = new THREE.Group();
          bladeWrap.rotation.z = (b / 6) * Math.PI * 2;
          const blade = new THREE.Mesh(this.sharedUnitBox, this.materials.wall);
          blade.scale.set(0.36, 1.95, 0.08);
          blade.position.y = 1.05;
          blade.rotation.y = 0.32;
          bladeWrap.add(blade);
          rotor.add(bladeWrap);
        }
        const hub = new THREE.Mesh(this.sharedUnitBox, this.materials.wallFoot);
        hub.scale.set(0.62, 0.62, 0.38);
        rotor.add(hub);
        housing.add(rotor);

        lifeGroup.add(housing);
        this.animatedItems.push({ kind: 'spin', object: rotor, axis: 'z', speed: 0.95 * sign });
      }
    } else if (style === 'orbital') {
      // Majestic rotating outer orbital station ring & solar collector wings.
      const orbitalRing = new THREE.Group();
      orbitalRing.position.set(0, wallHeight + 6.4, 0);
      orbitalRing.rotation.x = 0.16;
      orbitalRing.rotation.z = -0.10;

      const segmentCount = 16;
      const radius = Math.max(halfWidth, halfDepth) + 12;
      for (let i = 0; i < segmentCount; i += 1) {
        const angle = (i / segmentCount) * Math.PI * 2;
        const seg = new THREE.Mesh(this.sharedUnitBox, this.materials.gantry);
        seg.scale.set(5.4, 0.45, 0.85);
        seg.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
        seg.rotation.y = -angle;
        orbitalRing.add(seg);

        if (i % 4 === 0) {
          const panel = new THREE.Mesh(
            this.sharedUnitBox,
            i % 8 === 0 ? this.materials.accent : this.materials.secondary,
          );
          panel.scale.set(2.8, 0.14, 0.22);
          panel.position.set(Math.cos(angle) * (radius - 0.5), 0, Math.sin(angle) * (radius - 0.5));
          panel.rotation.y = -angle;
          orbitalRing.add(panel);
        }
      }
      lifeGroup.add(orbitalRing);
      this.animatedItems.push({ kind: 'spin', object: orbitalRing, axis: 'y', speed: 0.14 });
    } else if (style === 'desert') {
      // Rotating outpost radar array (North-West ridge) & wind turbine (South-East ridge).
      const mast = new THREE.Mesh(this.sharedUnitBox, this.materials.gantry);
      mast.scale.set(0.55, 5.4, 0.55);
      mast.position.set(-halfWidth * 0.48, wallHeight + 2.7, -halfDepth - 4.2);
      lifeGroup.add(mast);

      const radarHead = new THREE.Group();
      radarHead.position.set(-halfWidth * 0.48, wallHeight + 5.6, -halfDepth - 4.2);
      const dish = new THREE.Mesh(this.sharedUnitBox, this.materials.wall);
      dish.scale.set(3.2, 1.35, 0.24);
      dish.rotation.x = -0.22;
      const dishBar = new THREE.Mesh(this.sharedUnitBox, this.materials.accent);
      dishBar.scale.set(2.6, 0.14, 0.28);
      dishBar.position.y = 0.2;
      radarHead.add(dish, dishBar);
      lifeGroup.add(radarHead);
      this.animatedItems.push({ kind: 'spin', object: radarHead, axis: 'y', speed: 0.55 });

      const turbineTower = new THREE.Mesh(this.sharedUnitBox, this.materials.gantry);
      turbineTower.scale.set(0.5, 6.6, 0.5);
      turbineTower.position.set(halfWidth * 0.52, wallHeight + 3.3, halfDepth + 4.6);
      lifeGroup.add(turbineTower);

      const turbineRotor = new THREE.Group();
      turbineRotor.position.set(halfWidth * 0.52, wallHeight + 6.5, halfDepth + 4.25);
      for (let b = 0; b < 3; b += 1) {
        const arm = new THREE.Group();
        arm.rotation.z = (b / 3) * Math.PI * 2;
        const blade = new THREE.Mesh(this.sharedUnitBox, this.materials.wall);
        blade.scale.set(0.24, 2.7, 0.08);
        blade.position.y = 1.35;
        arm.add(blade);
        turbineRotor.add(arm);
      }
      lifeGroup.add(turbineRotor);
      this.animatedItems.push({ kind: 'spin', object: turbineRotor, axis: 'z', speed: 1.15 });
    }

    // Sparse perimeter atmospheric motes (16 tiny meshes strictly outside the
    // arena bounds so center combat visibility remains 100% clean).
    const moteCount = 16;
    for (let i = 0; i < moteCount; i += 1) {
      const angle = (i / moteCount) * Math.PI * 2 + (i % 3) * 0.21;
      const radiusX = halfWidth + 2.4 + (i % 4) * 2.1;
      const radiusZ = halfDepth + 2.4 + ((i + 1) % 4) * 2.1;
      const baseX = Math.cos(angle) * radiusX;
      const baseZ = Math.sin(angle) * radiusZ;
      const baseY = 1.8 + (i % 5) * 1.45;
      const mote = new THREE.Mesh(
        this.sharedUnitBox,
        i % 2 === 0 ? this.materials.mote : this.materials.moteWarm,
      );
      const size = style === 'desert' ? 0.11 : 0.085;
      mote.scale.set(size, size, size);
      mote.position.set(baseX, baseY, baseZ);
      lifeGroup.add(mote);
      this.animatedItems.push({
        kind: 'mote',
        object: mote,
        style,
        baseX,
        baseY,
        baseZ,
        phase: i * 0.77,
        speed: 0.45 + (i % 4) * 0.14,
      });
    }

    this.add(lifeGroup);
  }

  /**
   * Advance lightweight arena animations (turbines, orbital ring, radar, and
   * sparse perimeter motes). Zero heap allocations per frame.
   */
  update(now = performance.now(), delta = 0.016, { reducedMotion = false } = {}) {
    if (!this.built || this.animatedItems.length === 0) return;
    const dt = Math.min(0.1, Math.max(0, Number(delta) || 0));
    const motionScale = reducedMotion ? 0.12 : 1;
    const t = (Number(now) || 0) * 0.001;

    for (let i = 0; i < this.animatedItems.length; i += 1) {
      const item = this.animatedItems[i];
      if (item.kind === 'spin') {
        item.object.rotation[item.axis] += item.speed * dt * motionScale;
      } else if (item.kind === 'pulse-opacity') {
        const wave = reducedMotion ? 0 : Math.sin(t * item.speed + item.phase);
        item.material.opacity = item.base + wave * item.amp;
      } else if (item.kind === 'mote') {
        if (reducedMotion) continue;
        const p = t * item.speed + item.phase;
        if (item.style === 'desert') {
          const drift = ((p * 2.2) % 8) - 4;
          item.object.position.set(
            item.baseX + drift,
            item.baseY + Math.sin(p * 1.7) * 0.35,
            item.baseZ + Math.cos(p * 1.1) * 0.45,
          );
        } else if (item.style === 'orbital') {
          item.object.position.set(
            item.baseX + Math.sin(p) * 0.55,
            item.baseY + Math.cos(p * 0.8) * 0.65,
            item.baseZ + Math.cos(p) * 0.55,
          );
        } else {
          // Foundry: rising warm/cyan embers outside the walls.
          const rise = (p * 1.35) % 6.5;
          item.object.position.set(
            item.baseX + Math.sin(p * 1.6) * 0.35,
            item.baseY + rise,
            item.baseZ + Math.cos(p * 1.3) * 0.35,
          );
        }
      }
    }
  }

  buildCover() {
    this.map.cover.forEach((block, index) => {
      if (this.coverMeshes.has(index)) return;
      const body = buildStructuredCoverGroup(block, this.sharedUnitBox);
      body.position.set(block.x, block.height / 2, block.z);
      const material = this.coverMaterial(block.kind, index);

      body.traverse((child) => {
        if (!child.isMesh) return;
        child.material = material;
        if (child.userData.ownGeometry) {
          this.ownedGeometries.add(child.geometry);
        }
      });
      this.add(body);

      // Machined outer edge outline keeps every cover silhouette sharp at range.
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(block.width, block.height, block.depth)),
        this.materials.coverEdge,
      );
      this.ownedGeometries.add(edges.geometry);
      edges.position.copy(body.position);
      this.add(edges);

      // Primary luminous seam (preserved for lighting contrast contract).
      const seamGeometry = new THREE.BoxGeometry(block.width * 1.006, 0.065, block.depth * 1.006);
      this.ownedGeometries.add(seamGeometry);
      const seam = new THREE.Mesh(seamGeometry, this.materials.coverSeam);
      seam.position.set(block.x, Math.min(block.height - 0.18, block.height * 0.72), block.z);
      this.add(seam);

      // Additional per-kind callout accents (vertical pillar beacon fins or
      // north/south facing status pips) strictly flush with the cover surface.
      let details = null;
      if (block.kind === 'pillar') {
        details = new THREE.Group();
        details.position.set(block.x, block.height * 0.5, block.z);
        const finMat = block.z < 0 ? this.materials.accent : this.materials.secondary;
        for (const sz of [-1, 1]) {
          const stripZ = new THREE.Mesh(this.sharedUnitBox, finMat);
          stripZ.scale.set(0.08, block.height * 0.56, 0.03);
          stripZ.position.set(0, 0, sz * (block.depth * 0.482));
          details.add(stripZ);
        }
        for (const sx of [-1, 1]) {
          const stripX = new THREE.Mesh(this.sharedUnitBox, finMat);
          stripX.scale.set(0.03, block.height * 0.56, 0.08);
          stripX.position.set(sx * (block.width * 0.482), 0, 0);
          details.add(stripX);
        }
        this.add(details);
      } else if (block.kind === 'barrier' || block.kind === 'container') {
        details = new THREE.Group();
        const tagMat = block.z <= 0 ? this.materials.accent : this.materials.secondary;
        const lowBand = new THREE.Mesh(this.sharedUnitBox, tagMat);
        const bandFrac = block.kind === 'container' ? 0.935 : 0.955;
        lowBand.scale.set(block.width * bandFrac, 0.055, block.depth * bandFrac);
        lowBand.position.set(block.x, Math.max(0.24, block.height * 0.24), block.z);
        details.add(lowBand);
        this.add(details);
      }

      this.coverMeshes.set(index, { crate: body, edges, seam, details });
    });
  }

  /**
   * Per-kind cover surface. Crates are matte painted wood/steel, containers are
   * painted sheet metal, pillars are concrete, barriers are hazard-coated.
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
      if (parts.details) this.scene.remove(parts.details);
      parts.crate.traverse((node) => {
        if (node.geometry && node.userData?.ownGeometry) {
          node.geometry.dispose();
          this.ownedGeometries.delete(node.geometry);
        }
      });
      parts.edges.geometry.dispose();
      this.ownedGeometries.delete(parts.edges.geometry);
      parts.seam.geometry.dispose();
      this.ownedGeometries.delete(parts.seam.geometry);
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
      if (parts.details) this.scene.remove(parts.details);
      parts.crate.traverse((node) => {
        if (node.geometry && node.userData?.ownGeometry) {
          node.geometry.dispose();
          this.ownedGeometries.delete(node.geometry);
        }
      });
      parts.edges.geometry.dispose();
      this.ownedGeometries.delete(parts.edges.geometry);
      parts.seam.geometry.dispose();
      this.ownedGeometries.delete(parts.seam.geometry);
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
    this.animatedItems.length = 0;
    for (const geometry of this.ownedGeometries) geometry.dispose?.();
    this.ownedGeometries.clear();
    for (const material of this.ownedMaterials) material.dispose?.();
    this.ownedMaterials.clear();
    this.materials = {};
    this.coverMaterials = undefined;
    this.sharedUnitBox = null;
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
