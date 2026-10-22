import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  IcosahedronGeometry,
  Matrix4,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { COLORS } from '../../config';
import type { MonsterKind } from '../../levels/schema';

/**
 * Procedural low-poly models: a handful of flat-coloured primitives merged into one geometry
 * with vertex colours, so every kind of unit is a single `InstancedMesh` draw call. Nothing is
 * loaded from files. Models face +z (towards the camera) for monsters and -z (away from it) for
 * soldiers; their feet stand on y = 0.
 */

const tmpMatrix = new Matrix4();
const tmpQuat = new Quaternion();
const tmpEuler = new Euler();
const tmpPos = new Vector3();
const tmpScale = new Vector3();
const tmpColor = new Color();

interface Place {
  x?: number;
  y?: number;
  z?: number;
  sx?: number;
  sy?: number;
  sz?: number;
  rx?: number;
  ry?: number;
  rz?: number;
}

/** A primitive moved into place and painted one flat colour. */
function part(geo: BufferGeometry, color: string, p: Place = {}): BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.deleteAttribute('uv');
  tmpEuler.set(p.rx ?? 0, p.ry ?? 0, p.rz ?? 0);
  tmpQuat.setFromEuler(tmpEuler);
  tmpPos.set(p.x ?? 0, p.y ?? 0, p.z ?? 0);
  tmpScale.set(p.sx ?? 1, p.sy ?? 1, p.sz ?? 1);
  g.applyMatrix4(tmpMatrix.compose(tmpPos, tmpQuat, tmpScale));
  tmpColor.set(color);
  const n = g.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = tmpColor.r;
    colors[i * 3 + 1] = tmpColor.g;
    colors[i * 3 + 2] = tmpColor.b;
  }
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geo.dispose();
  return g;
}

function merge(parts: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
}

const box = (w: number, h: number, d: number) => new BoxGeometry(w, h, d);
const ball = (r: number, detail = 1) => new IcosahedronGeometry(r, detail);

// ---- the squad ------------------------------------------------------------

/** About 0.9 tall and 0.36 wide, so a phalanx with 0.46 spacing still reads as single soldiers. */
export function soldierGeometry(): BufferGeometry {
  // ad-shooter colours: grey shirt, blue helmet and trousers, so the squad reads against red foes
  const uniform = '#a3adbd';
  const uniformDark = '#6f7a8c';
  const helmet = '#2f86e8';
  const trousers = '#2f86e8';
  const skin = '#ffd3ad';
  return merge([
    // legs and boots
    part(box(0.12, 0.3, 0.14), trousers, { x: -0.09, y: 0.15 }),
    part(box(0.12, 0.3, 0.14), trousers, { x: 0.09, y: 0.15 }),
    part(box(0.13, 0.07, 0.19), '#0d1024', { x: -0.09, y: 0.035, z: -0.02 }),
    part(box(0.13, 0.07, 0.19), '#0d1024', { x: 0.09, y: 0.035, z: -0.02 }),
    // torso, belt and a backpack, so the soldier reads from behind
    part(box(0.36, 0.3, 0.2), uniform, { y: 0.45 }),
    part(box(0.37, 0.05, 0.21), '#0d1024', { y: 0.32 }),
    part(box(0.24, 0.26, 0.11), uniformDark, { y: 0.47, z: 0.155 }),
    part(box(0.2, 0.05, 0.12), '#ffd166', { y: 0.58, z: 0.155 }),
    // arms reaching forward to the gun, with hands
    part(box(0.09, 0.09, 0.32), uniform, { x: -0.2, y: 0.52, z: -0.12 }),
    part(box(0.09, 0.09, 0.32), uniform, { x: 0.2, y: 0.52, z: -0.12 }),
    part(box(0.085, 0.085, 0.085), skin, { x: -0.1, y: 0.52, z: -0.3 }),
    part(box(0.085, 0.085, 0.085), skin, { x: 0.1, y: 0.52, z: -0.3 }),
    // gun: light body, dark barrel, bright muzzle
    part(box(0.09, 0.1, 0.5), '#9aa3c8', { y: 0.55, z: -0.34 }),
    part(box(0.05, 0.05, 0.16), '#10142b', { y: 0.55, z: -0.66 }),
    part(box(0.07, 0.07, 0.05), '#ffd166', { y: 0.55, z: -0.76 }),
    // head and helmet with a bright crest
    part(ball(0.11), skin, { y: 0.68 }),
    part(new SphereGeometry(0.155, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2), helmet, {
      y: 0.7,
      sy: 1.05,
    }),
    part(new CylinderGeometry(0.18, 0.18, 0.025, 8), helmet, { y: 0.705 }),
    part(box(0.045, 0.03, 0.3), '#1f63b8', { y: 0.85 }),
  ]);
}

// ---- monsters -------------------------------------------------------------

const GOLD = COLORS.gold;
const GOLD_DARK = '#e0a21f';
const EYE = '#ffffff';
const PUPIL = '#10142b';

interface Look {
  body: string;
  dark: string;
  /** Body proportions (unit sphere stretched). */
  w: number;
  h: number;
  /** Eye size relative to the unit body; bigger eyes read friendlier. */
  eye: number;
}

const LOOKS: Record<MonsterKind, Look> = {
  // the horde is red, like the enemies in the ad shooters: it pops against the blue squad
  grunt: { body: '#ec3b45', dark: '#9e1b27', w: 1, h: 0.95, eye: 1 },
  runner: { body: '#ff7a2e', dark: '#b2441a', w: 0.88, h: 1.1, eye: 1.05 },
  tank: { body: '#c22747', dark: '#6e1028', w: 1.08, h: 0.92, eye: 0.9 },
  miniboss: { body: '#7bd84f', dark: '#2f8a2a', w: 1.02, h: 1, eye: 1 },
  boss: { body: COLORS.boss, dark: COLORS.bossDark, w: 1.05, h: 1, eye: 1 },
};

/**
 * Elites are drawn this much bigger than their collision body, so they tower over the horde like
 * the bosses in the ad shooters. Bullets still use the body (plus its forgiving hit margin).
 */
const LOOK_SCALE: Record<MonsterKind, number> = {
  grunt: 1,
  runner: 1,
  tank: 1,
  miniboss: 1.2,
  boss: 1.25,
};

function crown(y: number, size: number): BufferGeometry[] {
  const out: BufferGeometry[] = [
    part(new CylinderGeometry(0.5 * size, 0.58 * size, 0.28 * size, 8), GOLD, { y }),
    part(new CylinderGeometry(0.52 * size, 0.52 * size, 0.07 * size, 8), GOLD_DARK, {
      y: y - 0.1 * size,
    }),
  ];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    out.push(
      part(new ConeGeometry(0.14 * size, 0.42 * size, 4), GOLD, {
        x: Math.cos(a) * 0.4 * size,
        y: y + 0.32 * size,
        z: Math.sin(a) * 0.4 * size,
        ry: Math.PI / 4,
      }),
      part(ball(0.06 * size, 0), '#ff5d73', {
        x: Math.cos(a) * 0.4 * size,
        y: y + 0.55 * size,
        z: Math.sin(a) * 0.4 * size,
      }),
    );
  }
  out.push(part(ball(0.12 * size, 0), '#3b82ff', { y, z: 0.55 * size }));
  return out;
}

/**
 * A monster with a unit-sized collision body (radius 1); scale it by the real radius. Elites come
 * out bigger than their body (`LOOK_SCALE`).
 */
export function monsterGeometry(kind: MonsterKind): BufferGeometry {
  const look = LOOKS[kind];
  const cy = 1; // body centre height: the blob sits on the ground
  const r = look.eye;
  const parts: BufferGeometry[] = [
    part(ball(1, 1), look.body, { y: cy * look.h, sx: look.w, sy: look.h, sz: look.w }),
    // belly patch, a lighter spot that makes the silhouette less plain
    part(ball(0.55, 0), look.dark, {
      y: 0.55 * look.h,
      z: 0.62 * look.w,
      sx: 1.2,
      sy: 0.55,
      sz: 0.5,
    }),
    // stubby feet
    part(ball(0.28, 0), look.dark, { x: -0.42 * look.w, y: 0.14, z: 0.32, sy: 0.6, sz: 1.2 }),
    part(ball(0.28, 0), look.dark, { x: 0.42 * look.w, y: 0.14, z: 0.32, sy: 0.6, sz: 1.2 }),
  ];
  // big googly eyes on the front, set high on the body because the camera looks down on it
  const lift = (38 * Math.PI) / 180;
  const ey = cy * look.h + Math.sin(lift) * 0.82 * look.h;
  const ez = Math.cos(lift) * 0.82 * look.w;
  for (const side of [-1, 1]) {
    const ex = side * 0.34 * look.w;
    parts.push(
      part(ball(0.33 * r, kind === 'grunt' || kind === 'runner' ? 0 : 1), EYE, {
        x: ex,
        y: ey,
        z: ez,
      }),
      part(ball(0.17 * r, 0), PUPIL, { x: ex * 0.92, y: ey + 0.03, z: ez + 0.25 * r }),
    );
  }

  const top = cy * look.h * 2;
  switch (kind) {
    case 'grunt':
      for (const side of [-1, 1]) {
        parts.push(
          part(new ConeGeometry(0.16, 0.38, 4), look.dark, {
            x: side * 0.5,
            y: top - 0.1,
            z: -0.05,
            rz: -side * 0.35,
            ry: Math.PI / 4,
          }),
        );
      }
      break;
    case 'runner':
      // a swept-back mohawk: it is the fast one
      for (let i = 0; i < 3; i++) {
        parts.push(
          part(new ConeGeometry(0.16, 0.5, 4), look.dark, {
            y: top - 0.15,
            z: -0.2 - i * 0.25,
            rx: -1.0 - i * 0.18,
            ry: Math.PI / 4,
          }),
        );
      }
      break;
    case 'tank':
      // heavy: horns, armour plates on the shoulders and spikes on the back
      for (const side of [-1, 1]) {
        parts.push(
          part(new ConeGeometry(0.2, 0.6, 5), '#f4ecd8', {
            x: side * 0.55,
            y: top - 0.1,
            z: 0.05,
            rz: -side * 0.55,
          }),
          part(box(0.5, 0.42, 0.6), look.dark, {
            x: side * 0.95,
            y: cy * 1.15,
            z: 0.0,
            rz: side * 0.25,
          }),
        );
      }
      for (let i = 0; i < 3; i++) {
        parts.push(
          part(new ConeGeometry(0.16, 0.4, 4), look.dark, {
            x: (i - 1) * 0.4,
            y: top - 0.15,
            z: -0.45,
            rx: -0.5,
            ry: Math.PI / 4,
          }),
        );
      }
      break;
    case 'miniboss':
      parts.push(...crown(top + 0.02, 0.9));
      for (const side of [-1, 1]) {
        parts.push(part(ball(0.3, 0), look.dark, { x: side * 0.98, y: cy * 1.05, sy: 0.9 }));
      }
      break;
    case 'boss':
      parts.push(...crown(top + 0.05, 1.1));
      for (const side of [-1, 1]) {
        parts.push(
          part(new ConeGeometry(0.22, 0.7, 5), look.dark, {
            x: side * 0.95,
            y: cy * 1.35,
            rz: -side * 1.0,
          }),
          part(ball(0.34, 0), look.dark, { x: side * 0.95, y: cy * 1.05, sy: 0.9 }),
        );
      }
      break;
  }
  const grow = LOOK_SCALE[kind];
  return merge(parts).scale(grow, grow, grow);
}

/** Height of a monster's head top in model units, to hang the HP label over it. */
export function monsterTop(kind: MonsterKind): number {
  const h = LOOKS[kind].h;
  const crowned = kind === 'miniboss' || kind === 'boss';
  return (2 * h + (crowned ? 0.9 : kind === 'grunt' ? 0.3 : 0)) * LOOK_SCALE[kind];
}

// ---- lane props -------------------------------------------------------------

/**
 * A lane block as stacks of old tyres, like the obstacles in the ad shooters: piles of three side
 * by side (as many as fit, at least three), filling `width` and `depth` (ground units). Feet on
 * y = 0, `height` tall.
 */
export function tireStackGeometry(width: number, depth: number, height: number): BufferGeometry {
  const stacks = Math.max(3, Math.round(width / depth));
  const r = Math.min(depth / 2, width / (stacks * 2));
  const layers = 3;
  const h = height / layers;
  const parts: BufferGeometry[] = [];
  for (let s = 0; s < stacks; s++) {
    const x = (s - (stacks - 1) / 2) * r * 2;
    for (let l = 0; l < layers; l++) {
      const y = h * (l + 0.5);
      // a slight twist per layer, so the pile does not look machined
      const ry = (s * 3 + l) * 0.7;
      parts.push(
        part(new CylinderGeometry(r * 0.98, r * 0.98, h * 0.92, 18), '#2b2e36', { x, y, ry }),
        part(new CylinderGeometry(r * 0.99, r * 0.99, h * 0.18, 18), '#3a3e48', { x, y, ry }),
      );
    }
    // the hole and rim on top of the pile
    parts.push(
      part(new CylinderGeometry(r * 0.55, r * 0.55, 0.02, 14), '#121318', { x, y: height + 0.005 }),
      part(new CylinderGeometry(r * 0.4, r * 0.4, 0.03, 12), '#8b93a1', { x, y: height + 0.01 }),
    );
  }
  return merge(parts);
}

/** A round pedestal that power-ups float over: a dark base with a glowing ring in `color`. */
export function pedestalGeometry(color: string): BufferGeometry {
  return merge([
    part(new CylinderGeometry(1.05, 1.15, 0.22, 24), '#3a4256', { y: 0.11 }),
    part(new CylinderGeometry(0.98, 0.98, 0.05, 24), color, { y: 0.245 }),
    part(new CylinderGeometry(0.7, 0.7, 0.06, 24), '#e9f6ff', { y: 0.27 }),
  ]);
}

/** A chunky gun model for weapon pick-ups, about 1.6 long, pointing along +x, centred. */
export function gunGeometry(): BufferGeometry {
  return merge([
    part(box(1.0, 0.26, 0.2), '#6d7a5b', { x: 0 }),
    part(box(0.55, 0.09, 0.09), '#1c1f26', { x: 0.75 }),
    part(box(0.18, 0.4, 0.16), '#2c3038', { x: -0.08, y: -0.28, rz: -0.25 }),
    part(box(0.16, 0.34, 0.15), '#2c3038', { x: 0.24, y: -0.24, rz: 0.15 }),
    part(box(0.42, 0.2, 0.17), '#56624a', { x: -0.62, y: -0.04 }),
    part(box(0.36, 0.08, 0.08), '#c9d2df', { x: 0.05, y: 0.18 }),
  ]);
}

/**
 * The hull for a cartoon outline: the model's positions only, welded and with smooth normals,
 * so pushing every vertex out along its normal gives a closed shell without cracks at the edges.
 */
export function outlineGeometry(model: BufferGeometry): BufferGeometry {
  const shell = new BufferGeometry();
  shell.setAttribute('position', model.getAttribute('position').clone());
  const welded = mergeVertices(shell, 1e-3);
  shell.dispose();
  welded.computeVertexNormals();
  return welded;
}
