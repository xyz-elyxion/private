import * as THREE from 'three';
import {
  RAIL_BEAM_DURATION,
  RAIL_CORE_COLOR,
  RAIL_CORE_RADIUS,
  RAIL_GLOW_RADIUS,
  RAIL_HELIX_COLOR,
  RAIL_HELIX_RADIUS,
  RAIL_HELIX_TURN_LEN,
  DEFAULT_WEAPON,
  weaponSpec,
  type WeaponType,
} from './constants';
import { rayAabb } from './map';
import type { AABB, Vec3 } from './types';

// A fading energy/projectile trail. All weapons use the same readable beam
// treatment for now; their gameplay differences come from the shared specs.
type Beam = {
  group: THREE.Group;
  parts: Array<{ mat: THREE.Material & { opacity: number }; base: number }>;
  remaining: number;
};

const UP = new THREE.Vector3(0, 1, 0);

function buildBeam(
  origin: THREE.Vector3,
  end: THREE.Vector3,
  core: number,
  helix: number,
): Beam {
  const group = new THREE.Group();
  const parts: Beam['parts'] = [];
  const dir = new THREE.Vector3().subVectors(end, origin);
  const len = dir.length();
  if (len < 1e-4) return { group, parts, remaining: RAIL_BEAM_DURATION };

  const axis = dir.clone().multiplyScalar(1 / len);
  const mid = origin.clone().addScaledVector(dir, 0.5);
  const quat = new THREE.Quaternion().setFromUnitVectors(UP, axis);
  const addCylinder = (radius: number, color: number, opacity: number) => {
    const geom = new THREE.CylinderGeometry(radius, radius, len, 6, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(mid);
    mesh.quaternion.copy(quat);
    group.add(mesh);
    parts.push({ mat, base: opacity });
  };

  addCylinder(RAIL_GLOW_RADIUS, helix, 0.28);
  addCylinder(RAIL_CORE_RADIUS, core, 1);

  const u = new THREE.Vector3();
  if (Math.abs(axis.y) < 0.99) u.crossVectors(axis, UP).normalize();
  else u.set(1, 0, 0);
  const v = new THREE.Vector3().crossVectors(axis, u).normalize();
  const segs = Math.min(600, Math.max(8, Math.ceil((len / RAIL_HELIX_TURN_LEN) * 12)));
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segs; i++) {
    const f = i / segs;
    const theta = (len * f) / RAIL_HELIX_TURN_LEN * Math.PI * 2;
    const ox = (Math.cos(theta) * u.x + Math.sin(theta) * v.x) * RAIL_HELIX_RADIUS;
    const oy = (Math.cos(theta) * u.y + Math.sin(theta) * v.y) * RAIL_HELIX_RADIUS;
    const oz = (Math.cos(theta) * u.z + Math.sin(theta) * v.z) * RAIL_HELIX_RADIUS;
    pts.push(new THREE.Vector3(
      origin.x + dir.x * f + ox,
      origin.y + dir.y * f + oy,
      origin.z + dir.z * f + oz,
    ));
  }
  const helixGeom = new THREE.BufferGeometry().setFromPoints(pts);
  const helixMat = new THREE.LineBasicMaterial({
    color: helix,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  group.add(new THREE.Line(helixGeom, helixMat));
  parts.push({ mat: helixMat, base: 0.85 });
  return { group, parts, remaining: RAIL_BEAM_DURATION };
}

// Generic shootable target. The combat engine remains independent of whether
// the target is a bot, player, or training dummy.
export type RailTarget = {
  kind: 'bot' | 'remote' | 'target';
  id: string;
  name: string;
  bounds: AABB;
  headshotY: number;
  centerY: number;
};

type RailHit = {
  target: RailTarget;
  t: number;
  hitY: number;
  headshot: boolean;
  point: THREE.Vector3;
};

export type WeaponShotRay = { dir: Vec3; maxDist: number };

export type RailFireResult = {
  hits: RailHit[];
  end: THREE.Vector3;
  rays: WeaponShotRay[];
};

function hash01(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export function shotDirections(dir: THREE.Vector3, type: WeaponType, seed: number): THREE.Vector3[] {
  const spec = weaponSpec(type);
  if (spec.pellets <= 1 || spec.spread <= 0) return [dir.clone().normalize()];
  const forward = dir.clone().normalize();
  const right = new THREE.Vector3();
  if (Math.abs(forward.y) < 0.99) right.crossVectors(forward, UP).normalize();
  else right.set(1, 0, 0);
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < spec.pellets; i++) {
    const u = hash01(seed * 17 + i * 31.7) * 2 - 1;
    const v = hash01(seed * 23 + i * 47.3) * 2 - 1;
    out.push(forward.clone().addScaledVector(right, u * spec.spread).addScaledVector(up, v * spec.spread).normalize());
  }
  return out;
}

export class Railgun {
  cooldown = 0;
  private beams: Beam[] = [];
  private beamCore = RAIL_CORE_COLOR;
  private beamHelix = RAIL_HELIX_COLOR;
  private weaponType: WeaponType = DEFAULT_WEAPON;
  private shotSeed = 0;

  get type(): WeaponType {
    return this.weaponType;
  }

  get automatic(): boolean {
    return weaponSpec(this.weaponType).automatic;
  }

  get cooldownMax(): number {
    return weaponSpec(this.weaponType).cooldown;
  }

  setType(type: WeaponType) {
    const next = weaponSpec(type).id;
    if (next !== this.weaponType) this.cooldown = Math.min(this.cooldown, weaponSpec(next).cooldown);
    this.weaponType = next;
  }

  setBeamColors(core: number, helix: number) {
    this.beamCore = core;
    this.beamHelix = helix;
  }

  step(dt: number, scene: THREE.Scene) {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.remaining -= dt;
      const alpha = Math.max(0, b.remaining / RAIL_BEAM_DURATION);
      for (const p of b.parts) p.mat.opacity = p.base * alpha;
      if (b.remaining <= 0) {
        disposeBeam(scene, b);
        this.beams.splice(i, 1);
      }
    }
  }

  fire(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    scene: THREE.Scene,
    boxes: AABB[],
    targets: RailTarget[],
    beamOrigin?: THREE.Vector3,
  ): RailFireResult | null {
    const spec = weaponSpec(this.weaponType);
    if (this.cooldown > 0) return null;
    this.cooldown = spec.cooldown;
    const directions = shotDirections(dir, this.weaponType, ++this.shotSeed);
    const hits: RailHit[] = [];
    const rays: WeaponShotRay[] = [];
    let primaryEnd = origin.clone().addScaledVector(dir, spec.range);

    for (const shotDir of directions) {
      const o: Vec3 = { x: origin.x, y: origin.y, z: origin.z };
      const d: Vec3 = { x: shotDir.x, y: shotDir.y, z: shotDir.z };
      let wallT = spec.range;
      for (const b of boxes) {
        const t = rayAabb(o, d, b);
        if (t !== null && t > 0 && t < wallT) wallT = t;
      }
      if (rays.length === 0) primaryEnd = origin.clone().addScaledVector(shotDir, wallT);
      rays.push({ dir: d, maxDist: wallT });
      for (const target of targets) {
        const t = rayAabb(o, d, target.bounds);
        if (t === null || t <= 0 || t >= wallT) continue;
        const hitY = origin.y + shotDir.y * t;
        hits.push({
          target,
          t,
          hitY,
          headshot: hitY >= target.headshotY,
          point: origin.clone().addScaledVector(shotDir, t),
        });
      }
      this.spawnBeam((beamOrigin ?? origin).clone(), origin.clone().addScaledVector(shotDir, wallT), scene, this.beamCore, this.beamHelix);
    }
    hits.sort((a, b) => a.t - b.t);
    return { hits, end: primaryEnd, rays };
  }

  spawnBeam(
    origin: THREE.Vector3,
    end: THREE.Vector3,
    scene: THREE.Scene,
    core: number = RAIL_CORE_COLOR,
    helix: number = RAIL_HELIX_COLOR,
  ) {
    const beam = buildBeam(origin.clone(), end.clone(), core, helix);
    scene.add(beam.group);
    this.beams.push(beam);
  }

  disposeAll(scene: THREE.Scene) {
    for (const b of this.beams) disposeBeam(scene, b);
    this.beams.length = 0;
  }
}

function disposeBeam(scene: THREE.Scene, b: Beam) {
  scene.remove(b.group);
  b.group.traverse((obj) => {
    const m = obj as THREE.Mesh & THREE.Line;
    const geom = (m as unknown as { geometry?: THREE.BufferGeometry }).geometry;
    if (geom) geom.dispose();
    const mat = (m as unknown as { material?: THREE.Material | THREE.Material[] }).material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) mat.dispose();
  });
}
