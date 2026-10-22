import {
  BackSide,
  BoxGeometry,
  Color,
  ConeGeometry,
  DodecahedronGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  PlaneGeometry,
  type Scene,
} from 'three';
import { SPAWN_FAR } from './sim';

/**
 * The monster fortress at the far end of the bridge. The horde pours out of its gate, so the
 * bridge leads somewhere and the monsters come from somewhere. It is the flag of the progress bar
 * standing in the world: the camera never moves, so instead of coming closer it falls apart while
 * the run goes on. One tower top breaks off at a quarter, the other at half, the keep's roof at
 * three quarters (and the keep starts to smoke), and the whole thing sinks into its island when
 * the level is won.
 *
 * A compact gatehouse rather than a castle: it stands where the road is already small on screen,
 * and anything taller would hide the sky and the horde queueing up in front of it.
 *
 * Same space as the scene: sim (x, y) on the ground maps to three.js (x, height, -y).
 */

/**
 * The gate's front face (sim y). Monsters appear just behind it, in the dark gateway, and grow to
 * full size as they step out (see `fortressEmerge`): the horde walks out of the dark instead of
 * out of thin air, and even an 8-unit boss fits through the gate while it is still small.
 */
export const FORT_GATE_Y = SPAWN_FAR - 1;
/** Damage stages; the last one is the collapse when the level is won. */
export const FORT_STAGES = 4;

/** How many stages of damage the fortress shows at this run progress (0..1). */
export function fortressStage(progress: number): number {
  return Math.min(FORT_STAGES, Math.floor(progress * FORT_STAGES + 1e-6));
}

/** Size (0..1) of a monster at sim y: small inside the gateway, full size a few steps out of it. */
export function fortressEmerge(y: number): number {
  return Math.min(1, Math.max(0, (SPAWN_FAR + 1.6 - y) / 4));
}

/** An opening in the front wall: from x `lo` to `hi`, `h` tall. */
export interface FortGate {
  lo: number;
  hi: number;
  h: number;
}

const TUNNEL = 3.5; // depth of the dark gateways behind the front face
const WALL_H = 5.4;
const WALL_D = 2;
const TOWER_W = 2.6;
const TOWER_H = 7.2;
const KEEP_HALF = 4;
const KEEP_Y = FORT_GATE_Y + 5;
const KEEP_D = 5;
const KEEP_H = 8;

/** Purple-grey stone, red roofs and banners like the horde, warm glowing windows. */
const STONE = 0x584c7a;
const STONE_LIGHT = 0x7a6da0;
const ROOF = 0xe0303f;
const DARK = 0x16131d;
const ROCK = 0x6e665e;
const FLAG = 0xff3b4f;
const WINDOW = 0xffb020;
const DUST = new Color(0xd8d0c4);
const SMOKE = new Color(0x4a4552);
const EMBER = new Color(0xff8a3d);

/** How long a broken-off top takes to topple into the sea, and the whole fortress to sink. */
const TOPPLE_TIME = 1.1;
const COLLAPSE_TIME = 1.2;
const MAX_PUFFS = 72;
const SMOKE_EVERY = 0.13;

interface Part {
  obj: Object3D;
  /** The damage stage that brings it down. */
  stage: number;
  x: number;
  h: number;
  z: number;
  /** Which way it falls (-1 left, 1 right). */
  side: number;
  /** Seconds after its stage starts until it goes (a collapse rumbles through, not all at once). */
  delay: number;
}

export class Fortress {
  private readonly parts: Part[] = [];
  private readonly flags: Object3D[] = [];
  /** When each stage broke (index = stage); Infinity while it has not. */
  private readonly brokeAt = new Float64Array(FORT_STAGES + 1).fill(Infinity);
  private stage = 0;
  private nextSmoke = 0;
  /** Where the two towers stand (x); their tops are the first to go. */
  private readonly towerX: number;

  private readonly puffs: InstancedMesh;
  private readonly puffX = new Float32Array(MAX_PUFFS);
  private readonly puffH = new Float32Array(MAX_PUFFS);
  private readonly puffY = new Float32Array(MAX_PUFFS);
  private readonly puffVx = new Float32Array(MAX_PUFFS);
  private readonly puffVh = new Float32Array(MAX_PUFFS);
  private readonly puffSize = new Float32Array(MAX_PUFFS);
  private readonly puffLife = new Float32Array(MAX_PUFFS);
  private readonly puffT = new Float64Array(MAX_PUFFS).fill(-Infinity);
  private readonly puffRgb = new Float32Array(MAX_PUFFS * 3);
  private puffHead = 0;
  private readonly dummy = new Object3D();

  /**
   * `halfWidth` is half the width of the front wall; `gates` are the openings in it, left to
   * right (one per lane), each `h` tall.
   */
  constructor(
    scene: Scene,
    own: <T extends { dispose(): void }>(x: T) => T,
    halfWidth: number,
    gates: FortGate[],
  ) {
    const lambert = (color: number) => own(new MeshLambertMaterial({ color, flatShading: true }));
    const stone = lambert(STONE);
    const light = lambert(STONE_LIGHT);
    const roof = lambert(ROOF);
    const pole = lambert(0x3a3545);
    const rock = lambert(ROCK);
    const flagMat = own(new MeshLambertMaterial({ color: FLAG, side: DoubleSide }));
    // the windows glow through the haze, like the prize at the end of the lane
    const windowMat = own(new MeshBasicMaterial({ color: WINDOW, fog: false }));
    const darkMat = own(new MeshBasicMaterial({ color: DARK, side: BackSide }));
    const unitBox = own(new BoxGeometry(1, 1, 1));
    // a four-sided cone turned square to the road: a pyramid roof
    const pyramid = own(new ConeGeometry(Math.SQRT1_2, 1, 4).rotateY(Math.PI / 4));
    const tooth = own(new ConeGeometry(0.16, 0.5, 4).rotateX(Math.PI));
    const flagGeo = own(new PlaneGeometry(1.3, 0.8).translate(0.65, 0, 0));
    const rockGeo = own(new DodecahedronGeometry(1, 0));

    const box = (
      parent: Object3D,
      mat: Material,
      x: number,
      h: number,
      y: number,
      w: number,
      hh: number,
      d: number,
    ) => {
      const m = new Mesh(unitBox, mat);
      m.position.set(x, h, -y);
      m.scale.set(w, hh, d);
      parent.add(m);
      return m;
    };
    let n = 0;
    const part = (obj: Object3D, stage: number) => {
      scene.add(obj);
      const x = obj.position.x;
      this.parts.push({
        obj,
        stage,
        x,
        h: obj.position.y,
        z: obj.position.z,
        side: x < -0.5 ? -1 : 1,
        // the collapse rumbles through: a fixed, scattered delay per piece
        delay: stage === FORT_STAGES ? ((n++ * 0.618) % 1) * 0.35 : 0,
      });
    };
    /** A crown with a pyramid roof and a banner on top; `group` sits where it breaks off. */
    const roofTop = (group: Group, w: number, d: number, crownH: number, roofH: number) => {
      box(group, light, 0, crownH / 2, 0, w + 0.5, crownH, d + 0.5);
      const r = new Mesh(pyramid, roof);
      r.position.set(0, crownH + roofH / 2, 0);
      r.scale.set(w + 0.8, roofH, d + 0.8);
      group.add(r);
      box(group, pole, 0, crownH + roofH + 0.7, 0, 0.1, 1.4, 0.1);
      const flag = new Mesh(flagGeo, flagMat);
      flag.position.set(0.05, crownH + roofH + 1.05, 0);
      group.add(flag);
      this.flags.push(flag);
    };

    const g = FORT_GATE_Y;
    this.towerX = halfWidth + TOWER_W / 2 - 0.4;
    const outer = this.towerX + TOWER_W / 2;

    // the island: a flat rock the fortress stands on, its edges broken up by boulders; it stays
    const island = new Group();
    box(island, rock, 0, -2.8, g + 6, outer * 2 + 3, 4.4, 15);
    const boulders: Array<[number, number, number, number]> = [
      [-outer - 1.6, g + 1, 2.2, -2.6],
      [outer + 1.4, g + 2, 2.6, -2.4],
      [-outer - 0.6, g + 10, 2.8, -2.2],
      [outer + 0.8, g + 11, 3, -2.4],
      [-5, g + 14, 2.6, -2.8],
      [4.5, g + 14.5, 2.8, -2.6],
      [-outer + 1, g - 0.8, 1.5, -3],
      [outer - 1, g - 0.6, 1.4, -3],
    ];
    for (const [x, y, r, h] of boulders) {
      const b = new Mesh(rockGeo, rock);
      b.position.set(x, h, -y);
      b.scale.set(r, r * 0.8, r);
      b.rotation.set(x * 0.3, y * 0.7, 0.2);
      island.add(b);
    }
    scene.add(island);

    // the front wall: piers between the gates, a lintel with a raised portcullis over each gate
    let from = -halfWidth;
    const pier = (lo: number, hi: number) => {
      const p = new Group();
      p.position.set((lo + hi) / 2, 0, -(g + WALL_D / 2));
      box(p, stone, 0, WALL_H / 2, 0, hi - lo, WALL_H, WALL_D);
      part(p, FORT_STAGES);
    };
    for (const gate of gates) {
      const w = gate.hi - gate.lo;
      const mid = (gate.lo + gate.hi) / 2;
      pier(from, gate.lo);
      from = gate.hi;
      // the gateway, seen from inside: its far wall, ceiling and floor are what shows
      const dark = new Mesh(unitBox, darkMat);
      dark.position.set(mid, gate.h / 2 - 0.01, -(g + TUNNEL / 2));
      dark.scale.set(w, gate.h, TUNNEL);
      part(dark, FORT_STAGES);
      const lintel = new Group();
      lintel.position.set(mid, gate.h, -(g + WALL_D / 2));
      box(lintel, stone, 0, (WALL_H - gate.h) / 2, 0, w, WALL_H - gate.h, WALL_D);
      box(lintel, pole, 0, -0.12, -WALL_D / 2 + 0.25, w, 0.24, 0.24);
      const count = Math.max(2, Math.round(w / 0.6));
      const teeth = new InstancedMesh(tooth, pole, count);
      for (let i = 0; i < count; i++) {
        this.dummy.position.set(-w / 2 + (i + 0.5) * (w / count), -0.4, WALL_D / 2 - 0.25);
        this.dummy.updateMatrix();
        teeth.setMatrixAt(i, this.dummy.matrix);
      }
      lintel.add(teeth);
      part(lintel, FORT_STAGES);
    }
    pier(from, halfWidth);
    // the battlements crumble a few at a time with every stage
    const merlons = 9;
    for (let i = 0; i < merlons; i++) {
      const x = -halfWidth + 0.45 + i * ((halfWidth * 2 - 0.9) / (merlons - 1));
      const merlon = box(scene, light, x, WALL_H + 0.35, g + 0.3, 0.8, 0.7, 0.6);
      part(merlon, 1 + ((i * 3 + 1) % FORT_STAGES));
    }

    // two corner towers; their tops break off first
    for (const side of [-1, 1]) {
      const tower = new Group();
      tower.position.set(side * this.towerX, 0, -(g + 1));
      box(tower, stone, 0, TOWER_H / 2, 0, TOWER_W, TOWER_H, TOWER_W);
      // an arrow slit facing the bridge
      box(tower, windowMat, 0, TOWER_H * 0.7, -TOWER_W / 2 - 0.02, 0.36, 0.9, 0.04);
      part(tower, FORT_STAGES);
      const top = new Group();
      top.position.set(side * this.towerX, TOWER_H, -(g + 1));
      roofTop(top, TOWER_W, TOWER_W, 0.7, 2.3);
      part(top, side < 0 ? 1 : 2);
    }

    // the keep behind the gate, looking down the bridge with two glowing windows
    const keep = new Group();
    keep.position.set(0, 0, -(KEEP_Y + KEEP_D / 2));
    box(keep, stone, 0, KEEP_H / 2, 0, KEEP_HALF * 2, KEEP_H, KEEP_D);
    for (const side of [-1, 1]) {
      box(keep, windowMat, side * 1.5, KEEP_H - 1, -KEEP_D / 2 - 0.02, 0.9, 1.1, 0.04);
    }
    part(keep, FORT_STAGES);
    const keepTop = new Group();
    keepTop.position.set(0, KEEP_H, -(KEEP_Y + KEEP_D / 2));
    roofTop(keepTop, KEEP_HALF * 2, KEEP_D, 0.8, 2.6);
    part(keepTop, 3);

    // dust and smoke: low-poly puffs that swell and shrink away
    this.puffs = new InstancedMesh(
      own(new IcosahedronGeometry(1, 0)),
      own(new MeshLambertMaterial({ flatShading: true })),
      MAX_PUFFS,
    );
    this.puffs.instanceMatrix.setUsage(DynamicDrawUsage);
    this.puffs.instanceColor = new InstancedBufferAttribute(new Float32Array(MAX_PUFFS * 3), 3);
    this.puffs.frustumCulled = false;
    this.puffs.count = 0;
    scene.add(this.puffs);
  }

  /** Brings the fortress down to `stage` (see `fortressStage`), every stage in between included. */
  breakTo(stage: number, time: number): void {
    while (this.stage < Math.min(stage, FORT_STAGES)) {
      const s = ++this.stage;
      this.brokeAt[s] = time;
      if (s === FORT_STAGES) {
        // the whole front goes down in a cloud
        const reach = this.towerX + TOWER_W;
        for (let i = 0; i < 34; i++) {
          const x = -reach + ((i * 0.618) % 1) * reach * 2;
          const h = 0.5 + ((i * 0.382) % 1) * 4.5;
          const y = FORT_GATE_Y + ((i * 0.7) % 1) * 3;
          this.puff(time + (i % 6) * 0.07, x, h, y, DUST, 2.2, 1.3);
        }
      } else {
        const x = s === 1 ? -this.towerX : s === 2 ? this.towerX : 0;
        const h = s === 3 ? KEEP_H : TOWER_H;
        const y = s === 3 ? KEEP_Y + KEEP_D / 2 : FORT_GATE_Y + 1;
        for (let i = 0; i < 10; i++) {
          const dx = (((i * 0.618) % 1) - 0.5) * (s === 3 ? 6 : 3);
          this.puff(time + i * 0.03, x + dx, h + 0.4, y, DUST, 1.4, 1);
        }
      }
    }
  }

  private puff(
    t: number,
    x: number,
    h: number,
    y: number,
    color: Color,
    size: number,
    life: number,
  ): void {
    const p = this.puffHead;
    this.puffHead = (p + 1) % MAX_PUFFS;
    this.puffT[p] = t;
    this.puffX[p] = x;
    this.puffH[p] = h;
    this.puffY[p] = y;
    this.puffVx[p] = (((p * 0.618) % 1) - 0.5) * 2.4;
    this.puffVh[p] = 1.2 + ((p * 0.382) % 1) * 1.4;
    this.puffSize[p] = size * (0.7 + ((p * 0.27) % 1) * 0.6);
    this.puffLife[p] = life;
    this.puffRgb[p * 3] = color.r;
    this.puffRgb[p * 3 + 1] = color.g;
    this.puffRgb[p * 3 + 2] = color.b;
  }

  update(time: number): void {
    for (const p of this.parts) {
      const o = p.obj;
      const collapse = p.stage === FORT_STAGES;
      const a = (time - this.brokeAt[p.stage] - p.delay) / (collapse ? COLLAPSE_TIME : TOPPLE_TIME);
      if (!(a > 0)) {
        o.visible = true;
        o.position.set(p.x, p.h, p.z);
        o.rotation.set(0, 0, 0);
      } else if (a >= 1) {
        o.visible = false;
      } else if (collapse) {
        // sinks straight down into the island, leaning a little as it goes
        o.visible = true;
        o.position.set(p.x + p.side * 0.4 * a, p.h - 14 * a * a, p.z);
        o.rotation.set(0.1 * a, 0, -p.side * 0.16 * a);
      } else {
        // breaks off, tips outwards and drops into the sea
        o.visible = true;
        o.position.set(p.x + p.side * 3 * a, p.h + 1.5 * a - 13 * a * a, p.z);
        o.rotation.set(0, 0, -p.side * 1.9 * a);
      }
    }
    for (let i = 0; i < this.flags.length; i++) {
      this.flags[i].rotation.y = 0.35 * Math.sin(time * 3.2 + i * 1.9);
    }
    // a roofless keep burns: smoke with the odd ember, and a smoking ruin after the fall
    if (this.stage >= 3) {
      if (this.nextSmoke < time - 1) this.nextSmoke = time;
      while (this.nextSmoke <= time) {
        const k = this.puffHead;
        const ruin = this.stage >= FORT_STAGES;
        const h = ruin ? 1 : KEEP_H + 0.4;
        const x = (((k * 0.618) % 1) - 0.5) * (ruin ? 9 : 5);
        const color = k % 5 === 0 ? EMBER : SMOKE;
        this.puff(this.nextSmoke, x, h, KEEP_Y + KEEP_D / 2, color, 1.1, 1.8);
        this.nextSmoke += SMOKE_EVERY;
      }
    }
    this.syncPuffs(time);
  }

  private syncPuffs(time: number): void {
    const colors = (this.puffs.instanceColor as InstancedBufferAttribute).array as Float32Array;
    const d = this.dummy;
    let n = 0;
    for (let p = 0; p < MAX_PUFFS; p++) {
      const life = this.puffLife[p];
      const a = (time - this.puffT[p]) / life;
      if (!(a >= 0 && a < 1)) continue;
      const t = a * life;
      // swells quickly, then shrinks away as it drifts up
      const s = this.puffSize[p] * Math.min(1, a * 5) * (1 - a * a);
      d.position.set(
        this.puffX[p] + this.puffVx[p] * t,
        this.puffH[p] + this.puffVh[p] * t,
        -this.puffY[p],
      );
      d.rotation.set(p, p * 0.7, a * 1.5);
      d.scale.setScalar(s);
      d.updateMatrix();
      this.puffs.setMatrixAt(n, d.matrix);
      colors.set(this.puffRgb.subarray(p * 3, p * 3 + 3), n * 3);
      n++;
    }
    this.puffs.count = n;
    this.puffs.instanceMatrix.needsUpdate = true;
    if (this.puffs.instanceColor) this.puffs.instanceColor.needsUpdate = true;
  }
}
