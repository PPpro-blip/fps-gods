import * as THREE from 'three';
import { COMBAT_HITBOXES } from '../shared/combatHitboxes.js';

// Loaded only by Vite's development build and only with ?hitboxes=1.
// Outlines are frozen at the server's shot-time poses, while the normal models
// continue interpolating. This makes both pose alignment and network offset visible.
export class HitboxDebug {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.geometries = COMBAT_HITBOXES.map(v => new THREE.CylinderGeometry(v.radius, v.radius, v.top - v.bottom, 20, 1));
    this.materials = ['#ffad53', '#4ceaff', '#ff6bf0'].map(color => new THREE.MeshBasicMaterial({ color, wireframe: true, depthTest: false, transparent: true, opacity: 0.72 }));
    this.markerGeometry = new THREE.SphereGeometry(0.07, 8, 6);
    this.traceMaterials = {
      player: new THREE.LineBasicMaterial({ color: '#a5ff86', depthTest: false }),
      cover: new THREE.LineBasicMaterial({ color: '#ff9e40', depthTest: false }),
      floor: new THREE.LineBasicMaterial({ color: '#ff9e40', depthTest: false }),
      smoke: new THREE.LineBasicMaterial({ color: '#c290ff', depthTest: false }),
      miss: new THREE.LineBasicMaterial({ color: '#f8faff', depthTest: false }),
    };
    this.markerMaterials = Object.fromEntries(Object.keys(this.traceMaterials).map(k => [k, new THREE.MeshBasicMaterial({ color: this.traceMaterials[k].color, depthTest: false })]));
    this.boxes = new Map();
    this.traces = [];
    this.freezeUntil = 0;
    this.label = document.createElement('div');
    this.label.textContent = 'DEV HITBOXES · cyan upper · amber lower · magenta head · green hit / orange cover / white miss';
    Object.assign(this.label.style, { position: 'fixed', top: '8px', left: '8px', zIndex: '9999', color: '#fff', background: '#07101deb', padding: '6px', font: '11px monospace', pointerEvents: 'none' });
    document.body.append(this.label);
  }

  syncBoxes(players, selfId) {
    const ids = new Set();
    for (const player of players) {
      if (player.id === selfId || player.alive === false || player.connected === false || ![player.x, player.y, player.z].every(Number.isFinite)) continue;
      ids.add(player.id);
      let group = this.boxes.get(player.id);
      if (!group) {
        group = new THREE.Group();
        COMBAT_HITBOXES.forEach((v, i) => {
          const mesh = new THREE.Mesh(this.geometries[i], this.materials[i]);
          mesh.position.y = (v.bottom + v.top) / 2;
          mesh.renderOrder = 1000;
          group.add(mesh);
        });
        this.group.add(group);
        this.boxes.set(player.id, group);
      }
      group.position.set(player.x, player.y, player.z);
    }
    for (const [id, group] of this.boxes) if (!ids.has(id)) { this.group.remove(group); this.boxes.delete(id); }
  }
  observe(players, selfId, now = performance.now()) {
    this.prune(players);
    if (now >= this.freezeUntil) this.syncBoxes(players, selfId);
  }
  trace(data, selfId, now = performance.now()) {
    if (!Array.isArray(data?.players) || !Array.isArray(data?.traces)) return;
    this.syncBoxes(data.players, selfId);
    this.freezeUntil = now + 1500;
    for (const trace of data.traces.slice(0, 16)) {
      if (!trace?.origin || !trace?.point || !['x', 'y', 'z'].every(k => Number.isFinite(trace.origin[k]) && Number.isFinite(trace.point[k]))) continue;
      const kind = this.traceMaterials[trace.kind] ? trace.kind : 'miss';
      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(trace.origin.x, trace.origin.y, trace.origin.z),
        new THREE.Vector3(trace.point.x, trace.point.y, trace.point.z),
      ]);
      const line = new THREE.Line(geometry, this.traceMaterials[kind]);
      const marker = new THREE.Mesh(this.markerGeometry, this.markerMaterials[kind]);
      marker.position.set(trace.point.x, trace.point.y, trace.point.z);
      line.renderOrder = marker.renderOrder = 1001;
      this.group.add(line, marker);
      this.traces.push({ line, marker, geometry, expires: now + 1500 });
    }
    while (this.traces.length > 32) this.removeTrace(this.traces.shift());
    this.label.textContent = `DEV HITBOXES · shot-time server pose · cyan upper / amber lower / magenta head · ${data.traces.map(t => t.headshot ? 'HEAD' : t.kind).join(', ')}`;
  }

  prune(players) {
    const alive = new Set(players.filter(p => p.alive !== false && p.connected !== false).map(p => p.id));
    for (const [id, group] of this.boxes) if (!alive.has(id)) { this.group.remove(group); this.boxes.delete(id); }
  }
  removeTrace(item) { this.group.remove(item.line, item.marker); item.geometry.dispose(); }
  update(now = performance.now()) {
    while (this.traces.length && this.traces[0].expires <= now) this.removeTrace(this.traces.shift());
  }
  clear() {
    for (const item of this.traces) this.removeTrace(item);
    this.traces = [];
    for (const group of this.boxes.values()) this.group.remove(group);
    this.boxes.clear();
    this.freezeUntil = 0;
  }
  dispose() {
    this.clear();
    this.scene.remove(this.group);
    this.label.remove();
    for (const g of this.geometries) g.dispose();
    this.markerGeometry.dispose();
    for (const m of [...this.materials, ...Object.values(this.traceMaterials), ...Object.values(this.markerMaterials)]) m.dispose();
  }
}
