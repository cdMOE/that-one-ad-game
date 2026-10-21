import {
  AdditiveBlending,
  AmbientLight,
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  CylinderGeometry,
  Color,
  DirectionalLight,
  DynamicDrawUsage,
  Fog,
  Group,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedMesh,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { COLORS } from '../../config';
import type { GlLayer } from '../../core/gl';
import { PALETTE, type ParticleSystem, type Placer } from '../../core/particles';
import type { Swarm } from '../../core/swarm';
import type { ItemDef } from '../../levels/schema';
import {
  gunGeometry,
  monsterGeometry,
  outlineGeometry,
  pedestalGeometry,
  soldierGeometry,
  tireStackGeometry,
} from './models';
import {
  ARENA,
  BLOCK_HEIGHT,
  MAX_BULLETS,
  MAX_MONSTERS,
  MAX_SHOOTERS,
  MONSTERS,
  MONSTER_KIND_BY_INDEX,
  SPAWN_FAR,
  type LaneElement,
  type StationarySim,
} from './sim';

/**
 * The 3D view of the shooter: a Three.js scene that mirrors the state of a `StationarySim`.
 * Sim space is (x, y) on the ground with y running away from the squad; the scene maps it to
 * three.js as (x, height, -y), so the camera sits behind the squad at positive z.
 *
 * Crowds are drawn with `InstancedMesh` (one draw call per monster kind, one for soldiers,
 * bullets, particles and blob shadows) and everything is written straight into the instance
 * buffers, so a frame allocates nothing.
 */

/**
 * Camera rig: a low third-person camera behind the squad, looking down at `CAMERA_PITCH`, like
 * the crowd shooters from the ads. The arena (plus its walls) must fit `FIT_HALF_WIDTH` at the
 * squad's depth, and the squad sits `SQUAD_NDC` of the way from the screen centre to its bottom
 * edge: big and in front, with the road running off into the haze the horde walks out of.
 */
const CAMERA_PITCH = (26 * Math.PI) / 180;
const CAMERA_FOV = 60;
const FIT_HALF_WIDTH = 5.6;
const SQUAD_NDC = -0.3;
/**
 * The camera is too close to show the whole arena at the squad's depth, so it follows the squad
 * sideways by this share of its x. Pointer and drag mappings account for it, so the squad stays
 * under the mouse and the finger.
 */
const CAMERA_FOLLOW = 0.2;
const SQUAD_EYE = 0.4;

const FLOOR_NEAR = -10;
/**
 * Haze: everything fades into the horizon colour between these distances from the camera. The
 * squad stands about 22 away, the spawn line about 36 and the far spawn about 45, so the horde and
 * the far end of the upgrade lane come out of the mist, as in the ad shooters.
 */
const FOG_NEAR = 30;
const FOG_FAR = 56;

/** Sky gradient from the top of the screen down to the horizon; the fog fades into the horizon. */
const SKY_TOP = '#2f7fe0';
const SKY_MID = '#78bdf2';
const HORIZON = 0xcdeafb;
/** Cartoon outline colour and thickness (model units) for the squad and the horde. */
const OUTLINE = 0x1b1e2c;
const SOLDIER_OUTLINE = 0.03;
const MONSTER_OUTLINE = 0.055;
/** Where the bridge pylons stand along the road (sim y). */
const PYLONS_Y = [6, 30];
const BULLET_HEIGHT = 0.62;
/** At most this many bullets are drawn; a big squad fires hundreds, and every one of them is noise. */
const MAX_DRAWN_BULLETS = 120;
const POPUP_HEIGHT = 1.3;
const MAX_ATTACKS = 12;
const MAX_FLASHES = 6;

const HOP_RATE = [5, 8.5, 3, 2.4, 1.8];

/** Writes a translation, yaw (about y), roll (about z) and scale into a column-major matrix. */
function writeTRS(
  a: Float32Array,
  index: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  roll: number,
  sx: number,
  sy: number,
  sz: number,
): void {
  const o = index * 16;
  const cy = Math.cos(yaw);
  const sY = Math.sin(yaw);
  const cz = Math.cos(roll);
  const sZ = Math.sin(roll);
  a[o] = cy * cz * sx;
  a[o + 1] = sZ * sx;
  a[o + 2] = -sY * cz * sx;
  a[o + 3] = 0;
  a[o + 4] = -cy * sZ * sy;
  a[o + 5] = cz * sy;
  a[o + 6] = sY * sZ * sy;
  a[o + 7] = 0;
  a[o + 8] = sY * sz;
  a[o + 9] = 0;
  a[o + 10] = cy * sz;
  a[o + 11] = 0;
  a[o + 12] = x;
  a[o + 13] = y;
  a[o + 14] = z;
  a[o + 15] = 1;
}

function instanced(
  geometry: BufferGeometry,
  material: Material,
  capacity: number,
): InstancedMesh<BufferGeometry, Material> {
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  return mesh;
}

/** A unit square lying on the ground; scale x/z to size it. */
function groundPlane(): PlaneGeometry {
  return new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
}

function placeRect(
  m: Object3D,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  height: number,
): void {
  m.position.set((x0 + x1) / 2, height, -(y0 + y1) / 2);
  m.scale.set(x1 - x0, 1, y1 - y0);
}

function canvasTexture(
  size: [number, number],
  draw: (g: CanvasRenderingContext2D) => void,
): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = size[0];
  c.height = size[1];
  const g = c.getContext('2d');
  if (g) draw(g);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

interface ElementView {
  group: Group;
  /** Blocks: the tyre pile, which squashes and glows warm when hit. */
  body?: Mesh;
  /** Blocks: their own copy of the tyre material, so the hit glow stays on the pile that was hit. */
  bodyMat?: MeshLambertMaterial;
  item?: ItemDef;
  /** Power-ups: what floats and turns over the pedestal (the gun, or a glowing column). */
  float?: Object3D;
}

interface ZoneView {
  group: Group;
  base: Mesh;
  fill: Mesh;
  edges: Mesh[];
  /** Translucent walls along the two long sides, so the zone is visible from a low angle too. */
  curtains: Mesh[];
  baseMat: MeshBasicMaterial;
  fillMat: MeshBasicMaterial;
  edgeMat: MeshBasicMaterial;
}

export class ShooterScene implements Placer {
  /** Screen position (CSS px) and px-per-world-unit of the last `placeAt`. */
  sx = 0;
  sy = 0;
  scale = 1;

  readonly camera = new PerspectiveCamera(50, 0.6, 6, 300);
  private readonly scene = new Scene();
  private readonly renderer: WebGLRenderer;
  private readonly disposables: Array<{ dispose(): void }> = [];

  private width = 1;
  private tanHalfV = 0.5;
  private tanHalfH = 0.3;
  /** Distance from the camera to the squad measured along the view axis. */
  private squadDepth = 20;
  private baseCamY = 0;
  private baseCamZ = 0;

  private readonly monsterMeshes: Array<InstancedMesh<BufferGeometry, Material>> = [];
  private readonly monsterCount: number[] = [0, 0, 0, 0, 0];
  private readonly soldiers: InstancedMesh<BufferGeometry, Material>;
  private readonly shadows: InstancedMesh<BufferGeometry, Material>;
  private readonly bullets: InstancedMesh<BufferGeometry, Material>;
  private readonly bulletGlow: InstancedMesh<BufferGeometry, Material>;
  private readonly muzzles: InstancedMesh<BufferGeometry, Material>;
  /** Cartoon outlines: a back-facing shell per crowd mesh that shares its instance matrices. */
  private readonly outlines: Array<{
    src: InstancedMesh<BufferGeometry, Material>;
    hull: InstancedMesh<BufferGeometry, Material>;
  }> = [];
  private readonly sparks: InstancedMesh<BufferGeometry, Material>;
  private readonly paletteRgb: Float32Array;

  private readonly elements = new Map<LaneElement, ElementView>();
  private readonly glow: Mesh;
  private readonly zones: ZoneView[] = [];
  private readonly flashPlanes: Array<{ mesh: Mesh; mat: MeshBasicMaterial }> = [];
  private readonly tireMat: MeshLambertMaterial;
  private readonly tmp = new Vector3();

  constructor(
    private readonly gl: GlLayer,
    private readonly sim: StationarySim,
    particleCapacity: number,
  ) {
    this.renderer = gl.acquire();
    this.scene.background = new Color(COLORS.bg);

    this.buildLights();
    this.buildWorld();

    const own = <T extends { dispose(): void }>(x: T): T => {
      this.disposables.push(x);
      return x;
    };
    const unitMat = own(
      new MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    ) as Material;

    for (const kind of MONSTER_KIND_BY_INDEX) {
      const geo = own(monsterGeometry(kind));
      const mesh = instanced(geo, unitMat, MAX_MONSTERS);
      this.monsterMeshes.push(mesh);
      this.scene.add(mesh);
      this.addOutline(mesh, own(outlineGeometry(geo)), own(this.outlineMaterial(MONSTER_OUTLINE)));
    }
    const soldierGeo = own(soldierGeometry());
    this.soldiers = instanced(soldierGeo, unitMat, MAX_SHOOTERS);
    this.scene.add(this.soldiers);
    this.addOutline(
      this.soldiers,
      own(outlineGeometry(soldierGeo)),
      own(this.outlineMaterial(SOLDIER_OUTLINE)),
    );

    // blob shadows: a dark disc under every unit
    this.shadows = instanced(
      own(new CircleGeometry(1, 14).rotateX(-Math.PI / 2)),
      own(
        new MeshBasicMaterial({
          color: 0x000000,
          transparent: true,
          opacity: 0.32,
          depthWrite: false,
        }),
      ),
      MAX_MONSTERS + MAX_SHOOTERS,
    );
    this.shadows.renderOrder = 1;
    this.scene.add(this.shadows);

    // bullets: a thin bright core in a faint sleeve; the low camera sees them up close
    this.bullets = instanced(
      own(new BoxGeometry(0.07, 0.07, 0.55)),
      own(new MeshBasicMaterial({ color: 0xfff0a0 })),
      MAX_BULLETS,
    );
    this.scene.add(this.bullets);
    this.bulletGlow = instanced(
      own(new BoxGeometry(0.14, 0.12, 0.8)),
      own(
        new MeshBasicMaterial({
          color: 0xff9d2e,
          transparent: true,
          opacity: 0.15,
          depthWrite: false,
          blending: AdditiveBlending,
        }),
      ),
      MAX_BULLETS,
    );
    this.scene.add(this.bulletGlow);

    // muzzle flashes: a short bright star at the tip of every gun, flaring with each shot
    this.muzzles = instanced(
      own(new BoxGeometry(0.42, 0.12, 0.42)),
      own(
        new MeshBasicMaterial({
          color: 0xfff1a8,
          transparent: true,
          opacity: 0.5,
          depthWrite: false,
          blending: AdditiveBlending,
        }),
      ),
      MAX_SHOOTERS,
    );
    this.scene.add(this.muzzles);

    this.sparks = instanced(
      own(new BoxGeometry(1, 1, 1)),
      own(new MeshBasicMaterial({})),
      particleCapacity,
    );
    this.sparks.instanceColor = new InstancedBufferAttribute(
      new Float32Array(particleCapacity * 3),
      3,
    );
    this.scene.add(this.sparks);
    this.paletteRgb = new Float32Array(PALETTE.length * 3);
    const c = new Color();
    PALETTE.forEach((hex, i) => {
      c.set(hex);
      this.paletteRgb.set([c.r, c.g, c.b], i * 3);
    });

    // lane contents
    this.tireMat = own(new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    this.buildLane(own);
    this.glow = new Mesh(
      own(new CircleGeometry(1.45, 24).rotateX(-Math.PI / 2)),
      own(
        new MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.2,
          depthWrite: false,
        }),
      ),
    );
    this.glow.visible = false;
    this.glow.position.y = 0.12;
    this.scene.add(this.glow);

    this.buildZones(own);
  }

  // ---- construction ---------------------------------------------------------

  private buildLights(): void {
    // bright midday light like the ad shooters: a blue sky above, a light road below
    this.scene.add(new HemisphereLight(0xffffff, 0x8d939e, 1.9));
    this.scene.add(new AmbientLight(0xffffff, 0.45));
    const sun = new DirectionalLight(0xfff4e0, 2.3);
    sun.position.set(-8, 16, 10);
    this.scene.add(sun);
  }

  /** A back-facing material that pushes every vertex out along its normal: the outline shell. */
  private outlineMaterial(thickness: number): MeshBasicMaterial {
    const mat = new MeshBasicMaterial({ color: OUTLINE, side: BackSide });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n  transformed += normal * ${thickness.toFixed(3)};`,
      );
    };
    return mat;
  }

  /** Draws `src` with a cartoon outline: the hull reuses its instance matrices every frame. */
  private addOutline(
    src: InstancedMesh<BufferGeometry, Material>,
    geometry: BufferGeometry,
    material: Material,
  ): void {
    const hull = instanced(geometry, material, src.instanceMatrix.count);
    hull.instanceMatrix = src.instanceMatrix;
    this.outlines.push({ src, hull });
    this.scene.add(hull);
  }

  private track<T extends { dispose(): void }>(x: T): T {
    this.disposables.push(x);
    return x;
  }

  private buildWorld(): void {
    const sim = this.sim;
    const plane = this.track(groundPlane());
    // the road reaches at least as far back as the monsters spawn, and past the last lane element
    let laneFar = SPAWN_FAR + 3;
    for (const e of sim.lane.elements) laneFar = Math.max(laneFar, e.y + 3);
    // and carries on far into the haze beyond that
    const end = laneFar + 60;
    const length = end - FLOOR_NEAR;
    const mid = -(FLOOR_NEAR + end) / 2;
    const solid = (color: number, opacity = 1) =>
      this.track(
        new MeshBasicMaterial({
          color,
          transparent: opacity < 1,
          opacity,
          depthWrite: opacity >= 1,
        }),
      );
    const lambert = (color: number) => this.track(new MeshLambertMaterial({ color }));
    const unitBox = this.track(new BoxGeometry(1, 1, 1));
    const box = (
      material: Material,
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
    ) => {
      const m = new Mesh(unitBox, material);
      m.position.set(x, y, z);
      m.scale.set(w, h, d);
      this.scene.add(m);
      return m;
    };

    // a blue sky that pales towards the horizon, and haze in the horizon's colour
    this.scene.background = this.track(
      canvasTexture([2, 256], (g) => {
        const grad = g.createLinearGradient(0, 0, 0, 256);
        grad.addColorStop(0, SKY_TOP);
        grad.addColorStop(0.55, SKY_MID);
        grad.addColorStop(1, `#${HORIZON.toString(16)}`);
        g.fillStyle = grad;
        g.fillRect(0, 0, 2, 256);
      }),
    );
    this.scene.fog = new Fog(HORIZON, FOG_NEAR, FOG_FAR);

    // the sea under the bridge, with a few light ripples
    const sea = this.track(
      canvasTexture([128, 128], (g) => {
        g.fillStyle = '#2b8ad6';
        g.fillRect(0, 0, 128, 128);
        g.strokeStyle = 'rgba(160, 214, 250, 0.45)';
        g.lineWidth = 2;
        for (let i = 0; i < 26; i++) {
          const x = (i * 53) % 128;
          const y = (i * 37) % 128;
          g.beginPath();
          g.moveTo(x, y);
          g.quadraticCurveTo(x + 6, y - 3, x + 12, y);
          g.stroke();
        }
      }),
    );
    sea.repeat.set(90, 90);
    const water = new Mesh(plane, this.track(new MeshBasicMaterial({ map: sea })));
    placeRect(water, -400, 400, -300, 500, -5);
    this.scene.add(water);

    // the road: light grey anti-slip plates with a grid of studs, white edge lines
    const half = ARENA.halfWidth + 0.3;
    const studs = this.track(
      canvasTexture([64, 64], (g) => {
        g.fillStyle = '#c3c7cf';
        g.fillRect(0, 0, 64, 64);
        for (let y = 0; y < 2; y++) {
          for (let x = 0; x < 2; x++) {
            const cx = 16 + x * 32;
            const cy = 16 + y * 32;
            g.fillStyle = '#a9aeb8';
            g.beginPath();
            g.ellipse(cx, cy + 1.5, 7, 5, 0, 0, Math.PI * 2);
            g.fill();
            g.fillStyle = '#d6d9df';
            g.beginPath();
            g.ellipse(cx, cy - 1, 6, 4, 0, 0, Math.PI * 2);
            g.fill();
          }
        }
      }),
    );
    studs.repeat.set((half * 2) / 0.9, length / 0.9);
    const road = new Mesh(plane, this.track(new MeshLambertMaterial({ map: studs })));
    placeRect(road, -half, half, FLOOR_NEAR, end, 0);
    this.scene.add(road);
    // the deck, its top just under the road so the two never fight over the same depth
    box(lambert(0x8d939e), 0, -0.79, mid, half * 2 + 1.4, 1.5, length);
    const railMat = lambert(0xdfe3ea);
    for (const side of [-1, 1]) {
      box(railMat, side * (half + 0.3), 0.12, mid, 0.6, 0.24, length); // kerb
      const edge = new Mesh(plane, solid(0xffffff));
      placeRect(
        edge,
        side * (half - 0.35) - 0.07,
        side * (half - 0.35) + 0.07,
        FLOOR_NEAR,
        end,
        0.05,
      );
      this.scene.add(edge);
      // railing: two rails on posts
      const rx = side * (half + 0.45);
      box(railMat, rx, 1.0, mid, 0.12, 0.12, length);
      box(railMat, rx, 0.6, mid, 0.08, 0.08, length);
    }
    const postCount = Math.ceil(length / 1.6) * 2;
    const posts = instanced(unitBox, railMat, postCount);
    const postArr = posts.instanceMatrix.array as Float32Array;
    let pn = 0;
    for (let y = FLOOR_NEAR; y < end && pn < postCount; y += 1.6) {
      for (const side of [-1, 1]) {
        writeTRS(postArr, pn++, side * (half + 0.45), 0.5, -y, 0, 0, 0.14, 1.0, 0.14);
      }
    }
    posts.count = pn;
    this.scene.add(posts);

    // bridge pylons with stay cables down to the deck edges
    const pylonMat = lambert(0x949ba6);
    const cableMat = lambert(0xe9edf3);
    const cableGeo = this.track(new CylinderGeometry(0.035, 0.035, 1, 5).rotateX(Math.PI / 2));
    const towerX = half + 1.7;
    for (const py of PYLONS_Y) {
      for (const side of [-1, 1]) {
        box(pylonMat, side * towerX, 9, -py, 1.2, 26, 1.2);
        for (const d of [-14, -10.5, -7, -3.5, 3.5, 7, 10.5, 14]) {
          const from = new Vector3(side * towerX, 19, -py);
          const to = new Vector3(side * (half + 0.45), 1.05, -(py + d));
          const cable = new Mesh(cableGeo, cableMat);
          cable.position.copy(from).add(to).multiplyScalar(0.5);
          cable.scale.set(1, 1, from.distanceTo(to));
          cable.lookAt(to);
          this.scene.add(cable);
        }
      }
      box(pylonMat, 0, 21.5, -py, towerX * 2 + 1.2, 1.2, 1.2); // cross beam
    }

    const mx0 = sim.monsterMinX - 0.2;
    const mx1 = sim.monsterMaxX + 0.2;

    // a dark divider between the upgrade lane and the monsters, from a little ahead of the squad
    // until it disappears in the haze
    const left = sim.lane.x < 0;
    const laneEdge = sim.lane.x + (left ? 1 : -1) * (sim.lane.width / 2);
    const fieldEdge = left ? sim.monsterMinX : sim.monsterMaxX;
    box(
      lambert(0x2e333e),
      (laneEdge + fieldEdge) / 2,
      0.8,
      -(SPAWN_FAR + 3.2) / 2,
      0.16,
      1.6,
      SPAWN_FAR - 3.2,
    );

    // the line monsters bite at
    const bite = new Mesh(plane, solid(0xff4d6d, 0.45));
    placeRect(bite, mx0, mx1, 0.5, 0.75, 0.06);
    this.scene.add(bite);
  }

  private buildLane(own: <T extends { dispose(): void }>(x: T) => T): void {
    const sim = this.sim;
    const width = sim.lane.width;
    // blocks are piles of old tyres; power-ups float over glowing pedestals
    const tireGeo = own(tireStackGeometry(width - 0.2, BLOCK_HEIGHT - 0.1, 1.2));
    const colors: Record<ItemDef['kind'], string> = {
      crowd: '#3b9cff',
      upgrade: '#ffc23a',
      weapon: '#38e1ff',
    };
    const pedestals = {
      crowd: own(pedestalGeometry(colors.crowd)),
      upgrade: own(pedestalGeometry(colors.upgrade)),
      weapon: own(pedestalGeometry(colors.weapon)),
    };
    const pedestalMat = own(new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    const gun = own(gunGeometry());
    const beamGeo = own(new CylinderGeometry(0.85, 0.85, 1.6, 24, 1, true));
    const beamMats = {
      crowd: own(this.beamMaterial(colors.crowd)),
      upgrade: own(this.beamMaterial(colors.upgrade)),
      weapon: own(this.beamMaterial(colors.weapon)),
    };

    for (const e of sim.lane.elements) {
      const group = new Group();
      if (e.type === 'block') {
        // a clone shares the tyre shader, so a hit never swaps programs (no compile hitch)
        const bodyMat = own(this.tireMat.clone());
        bodyMat.emissive.setHex(0xff8a3d);
        bodyMat.emissiveIntensity = 0;
        const body = new Mesh(tireGeo, bodyMat);
        group.add(body);
        this.elements.set(e, { group, body, bodyMat });
      } else if (e.item) {
        const kind = e.item.kind;
        group.add(new Mesh(pedestals[kind], pedestalMat));
        const beam = new Mesh(beamGeo, beamMats[kind]);
        beam.position.y = 1.05;
        group.add(beam);
        let float: Object3D | undefined;
        if (kind === 'weapon') {
          float = new Mesh(gun, pedestalMat);
          float.position.y = 1.2;
          group.add(float);
        }
        this.elements.set(e, { group, item: e.item, ...(float ? { float } : {}) });
      }
      group.visible = false;
      this.scene.add(group);
    }
  }

  /** The see-through light column over a power-up's pedestal. */
  private beamMaterial(color: string): MeshBasicMaterial {
    return new MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      side: BackSide,
      blending: AdditiveBlending,
    });
  }

  private buildZones(own: <T extends { dispose(): void }>(x: T) => T): void {
    const plane = own(groundPlane());
    const wall = own(new PlaneGeometry(1, 1).rotateY(Math.PI / 2));
    for (let i = 0; i < MAX_ATTACKS; i++) {
      const mk = (opacity: number) =>
        own(
          new MeshBasicMaterial({ color: 0xff3c50, transparent: true, opacity, depthWrite: false }),
        );
      const baseMat = mk(0.2);
      const fillMat = mk(0.3);
      const edgeMat = mk(0.95);
      const base = new Mesh(plane, baseMat);
      const fill = new Mesh(plane, fillMat);
      const group = new Group();
      group.add(base, fill);
      const edges: Mesh[] = [];
      for (let k = 0; k < 4; k++) {
        const edge = new Mesh(plane, edgeMat);
        edges.push(edge);
        group.add(edge);
      }
      const curtains: Mesh[] = [];
      for (let k = 0; k < 2; k++) {
        const curtain = new Mesh(wall, fillMat);
        curtains.push(curtain);
        group.add(curtain);
      }
      group.visible = false;
      this.scene.add(group);
      this.zones.push({ group, base, fill, edges, curtains, baseMat, fillMat, edgeMat });
    }
    for (let i = 0; i < MAX_FLASHES; i++) {
      const mat = own(
        new MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      const mesh = new Mesh(plane, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.flashPlanes.push({ mesh, mat });
    }
  }

  // ---- camera ----------------------------------------------------------------

  /**
   * Frames the field: the camera hovers at a fixed height and backs away until the arena fits the
   * screen width, tilting so that the near and far ends of the field touch the bottom and top edges.
   */
  resize(width: number, height: number): void {
    this.width = width;
    const aspect = width / Math.max(1, height);
    const tanV = Math.tan((CAMERA_FOV * Math.PI) / 360);
    // framed for the game column; a wider window just shows more scenery to the sides
    const depth = FIT_HALF_WIDTH / (tanV * aspect);
    // the camera sits behind and above the squad point, along the (tilted) view axis
    const sinP = Math.sin(CAMERA_PITCH);
    const cosP = Math.cos(CAMERA_PITCH);
    const lateral = SQUAD_NDC * tanV * depth; // how far below the axis the squad appears
    const camY = SQUAD_EYE + depth * sinP - lateral * cosP; // height
    const camBack = depth * cosP + lateral * sinP; // distance behind the squad (sim y = -camBack)
    this.camera.fov = CAMERA_FOV;
    this.camera.aspect = this.gl.width / Math.max(1, this.gl.height);
    this.camera.updateProjectionMatrix();
    this.baseCamY = camY;
    this.baseCamZ = camBack;
    this.camera.position.set(0, camY, camBack);
    this.camera.rotation.set(-CAMERA_PITCH, 0, 0);
    this.tanHalfV = tanV;
    this.tanHalfH = tanV * aspect;
    this.squadDepth = depth;
    this.camera.updateMatrixWorld();
  }

  /** World x under a screen x (CSS px), as seen at the squad's depth. */
  screenToWorldX(px: number): number {
    return (((px / this.width) * 2 - 1) * this.tanHalfH * this.squadDepth) / (1 - CAMERA_FOLLOW);
  }

  /** World distance that a horizontal drag of `px` CSS px covers at the squad's depth. */
  pxToWorld(px: number): number {
    return ((px / this.width) * 2 * this.tanHalfH * this.squadDepth) / (1 - CAMERA_FOLLOW);
  }

  /** Projects the ground position (x, y) at `height` to the screen; results land in sx/sy/scale. */
  placeAt(x: number, y: number, height: number): void {
    const v = this.tmp.set(x, height, -y);
    const e = this.camera.matrixWorldInverse.elements;
    const depth = -(e[2] * x + e[6] * height + e[10] * -y + e[14]);
    v.project(this.camera);
    // the canvas covers the whole window, the overlay only the game column
    this.sx = (v.x * 0.5 + 0.5) * this.gl.width - this.gl.offsetX;
    this.sy = (-v.y * 0.5 + 0.5) * this.gl.height - this.gl.offsetY;
    this.scale = this.gl.height / 2 / (this.tanHalfV * Math.max(0.1, depth));
  }

  place(x: number, y: number): void {
    this.placeAt(x, y, POPUP_HEIGHT);
  }

  // ---- per-frame sync ---------------------------------------------------------

  /** Mirrors the sim into the scene and draws it. `shakeX/Y` are in world units. */
  render(
    time: number,
    player: Swarm,
    recoil: number,
    particles: ParticleSystem,
    flashes: ReadonlyArray<{ x: number; half: number; life: number; hit: boolean }>,
    shakeX: number,
    shakeY: number,
  ): void {
    const follow = this.sim.squadX * CAMERA_FOLLOW;
    this.camera.position.set(follow + shakeX, this.baseCamY + shakeY, this.baseCamZ);
    this.camera.updateMatrixWorld();

    this.syncMonsters(time);
    this.syncSoldiers(time, player, recoil);
    this.syncBullets();
    this.syncParticles(particles);
    this.syncLane(time);
    this.syncZones(flashes);
    for (const o of this.outlines) o.hull.count = o.src.count;
    this.renderer.render(this.scene, this.camera);
  }

  private syncMonsters(time: number): void {
    const sim = this.sim;
    const counts = this.monsterCount;
    counts.fill(0);
    const shadowArr = this.shadows.instanceMatrix.array as Float32Array;
    let shadowN = 0;
    const arrays = this.monsterMeshes.map((m) => m.instanceMatrix.array as Float32Array);
    for (let i = 0; i < MAX_MONSTERS; i++) {
      if (!sim.malive[i]) continue;
      const k = sim.mkind[i];
      const r = MONSTERS[MONSTER_KIND_BY_INDEX[k]].radius;
      const x = sim.mx[i];
      const y = sim.my[i];
      const phase = i * 1.7;
      const t = time * HOP_RATE[k] + phase;
      const hop = Math.abs(Math.sin(t));
      const small = r < 1;
      const lift = hop * (small ? 0.16 : 0.05) * r;
      const squash = 1 - 0.1 * (1 - hop);
      let s = r;
      if (sim.mstate[i] === 2) s *= 1 + 0.05 * Math.sin(time * 40);
      writeTRS(
        arrays[k],
        counts[k]++,
        x,
        lift,
        -y,
        Math.sin(t * 0.5) * 0.18,
        Math.sin(t) * 0.07,
        s * (2 - squash),
        s * squash,
        s * (2 - squash),
      );
      const sr = r * 1.05 * (1 - lift * 0.3);
      writeTRS(shadowArr, shadowN++, x, 0.1, -y, 0, 0, sr, 1, sr);
    }
    for (let k = 0; k < this.monsterMeshes.length; k++) {
      const mesh = this.monsterMeshes[k];
      mesh.count = counts[k];
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.shadowFill = shadowN;
  }

  private shadowFill = 0;

  private syncSoldiers(time: number, player: Swarm, recoil: number): void {
    const sim = this.sim;
    const arr = this.soldiers.instanceMatrix.array as Float32Array;
    const shadowArr = this.shadows.instanceMatrix.array as Float32Array;
    let shadowN = this.shadowFill;
    const moving = Math.min(1, Math.abs(sim.squadVx) / 4);
    const lean = Math.max(-0.3, Math.min(0.3, -sim.squadVx * 0.014));
    const n = player.n;
    // a small squad is drawn bigger (one soldier would be a speck); a big one shrinks to its 1.3
    const size = 1.3 + 0.55 / Math.sqrt(Math.max(1, n));
    const muzzleArr = this.muzzles.instanceMatrix.array as Float32Array;
    const flare = recoil * recoil;
    for (let i = 0; i < n; i++) {
      const x = player.x[i];
      const y = player.y[i];
      const bob = (Math.abs(Math.sin(time * 14 + i * 1.3)) * 0.06 * moving) as number;
      writeTRS(arr, i, x, bob, -y + recoil * 0.12, 0, lean, size, size, size);
      writeTRS(shadowArr, shadowN++, x, 0.1, -y, 0, 0, 0.2 * size, 1, 0.2 * size);
      // the gun's muzzle sits at (0, 0.55, -0.76) in model space
      const m = flare * size * 0.55;
      writeTRS(muzzleArr, i, x, 0.55 * size, -y - 0.8 * size + recoil * 0.12, i * 1.9, 0, m, m, m);
    }
    this.soldiers.count = n;
    this.soldiers.instanceMatrix.needsUpdate = true;
    this.muzzles.count = recoil > 0.05 ? n : 0;
    this.muzzles.instanceMatrix.needsUpdate = true;
    this.shadows.count = shadowN;
    this.shadows.instanceMatrix.needsUpdate = true;
  }

  private syncBullets(): void {
    const sim = this.sim;
    const arr = this.bullets.instanceMatrix.array as Float32Array;
    const glow = this.bulletGlow.instanceMatrix.array as Float32Array;
    let alive = 0;
    for (let i = 0; i < MAX_BULLETS; i++) if (sim.blife[i] > 0) alive++;
    // with more bullets in flight than we want on screen, only every `stride`-th one is drawn
    const stride = Math.max(1, Math.ceil(alive / MAX_DRAWN_BULLETS));
    let n = 0;
    let seen = 0;
    for (let i = 0; i < MAX_BULLETS; i++) {
      if (sim.blife[i] <= 0 || seen++ % stride !== 0) continue;
      const yaw = Math.atan2(sim.bvx[i], -sim.bvy[i]);
      writeTRS(arr, n, sim.bx[i], BULLET_HEIGHT, -sim.by[i], yaw, 0, 1, 1, 1);
      writeTRS(glow, n, sim.bx[i], BULLET_HEIGHT, -sim.by[i], yaw, 0, 1, 1, 1);
      n++;
    }
    this.bullets.count = n;
    this.bullets.instanceMatrix.needsUpdate = true;
    this.bulletGlow.count = n;
    this.bulletGlow.instanceMatrix.needsUpdate = true;
  }

  private syncParticles(p: ParticleSystem): void {
    const arr = this.sparks.instanceMatrix.array as Float32Array;
    const colors = (this.sparks.instanceColor as InstancedBufferAttribute).array as Float32Array;
    let n = 0;
    for (let i = 0; i < p.cap; i++) {
      const life = p.life[i];
      if (life <= 0) continue;
      const t = life / p.maxLife[i];
      const d = p.size[i] * (0.4 + 0.6 * t) * 1.1;
      // sparks hop out of the ground plane a little, each at its own height
      const h = 0.35 + ((i * 0.618) % 1) * 0.7 * (1.2 - t);
      writeTRS(arr, n, p.x[i], h, -p.y[i], i, i * 0.7, d, d, d);
      const c = p.color[i] * 3;
      colors[n * 3] = this.paletteRgb[c];
      colors[n * 3 + 1] = this.paletteRgb[c + 1];
      colors[n * 3 + 2] = this.paletteRgb[c + 2];
      n++;
    }
    this.sparks.count = n;
    this.sparks.instanceMatrix.needsUpdate = true;
    if (this.sparks.instanceColor) this.sparks.instanceColor.needsUpdate = true;
  }

  private syncLane(time: number): void {
    const sim = this.sim;
    for (const view of this.elements.values()) view.group.visible = false;
    this.glow.visible = false;
    sim.lane.elements.forEach((e, k) => {
      const view = this.elements.get(e);
      if (!view) return;
      const g = view.group;
      g.visible = true;
      if (view.bodyMat && e.type === 'block') {
        // a warm glow and a little knock back per hit; under steady fire it pulses, never strobes
        view.bodyMat.emissiveIntensity = 0.35 * e.flash;
        g.position.set(sim.lane.x, 0, -e.y - 0.06 * e.flash);
        g.scale.set(1 + 0.03 * e.flash, 1 - 0.08 * e.flash, 1);
      } else {
        const front = k === 0;
        g.position.set(sim.lane.x, 0, -e.y);
        if (view.float) {
          view.float.rotation.y = time * 1.8;
          view.float.position.y = 1.2 + Math.sin(time * 3 + k) * 0.08;
        }
        if (front) {
          this.glow.visible = true;
          this.glow.position.set(sim.lane.x, 0.12, -e.y);
          const s = 1 + 0.1 * Math.sin(time * 8);
          this.glow.scale.set(s, 1, s);
        }
      }
    });
  }

  private syncZones(
    flashes: ReadonlyArray<{ x: number; half: number; life: number; hit: boolean }>,
  ): void {
    const sim = this.sim;
    const bottom = -1.5;
    let n = 0;
    for (const a of sim.attacks) {
      if (n >= MAX_ATTACKS) break;
      const z = this.zones[n++];
      z.group.visible = true;
      const top = a.y;
      placeRect(z.base, a.lo, a.hi, bottom, top, 0.14);
      z.baseMat.opacity = 0.2 + 0.35 * a.t;
      const reach = (top - bottom) * a.t;
      placeRect(z.fill, a.lo, a.hi, top - reach, top, 0.16);
      z.fillMat.opacity = 0.3 + 0.4 * a.t;
      const w = 0.14;
      placeRect(z.edges[0], a.lo, a.lo + w, bottom, top, 0.18);
      placeRect(z.edges[1], a.hi - w, a.hi, bottom, top, 0.18);
      placeRect(z.edges[2], a.lo, a.hi, top - w, top, 0.18);
      placeRect(z.edges[3], a.lo, a.hi, bottom, bottom + w, 0.18);
      const white = a.t > 0.7 && Math.floor(a.t * 20) % 2 === 0;
      const mid = (top + bottom) / 2;
      const c0 = z.curtains[0];
      const c1 = z.curtains[1];
      c0.position.set(a.lo, 0.35, -mid);
      c1.position.set(a.hi, 0.35, -mid);
      c0.scale.set(1, 0.7, top - bottom);
      c1.scale.set(1, 0.7, top - bottom);
      z.edgeMat.color.setHex(white ? 0xffffff : 0xff5a6e);
    }
    for (; n < MAX_ATTACKS; n++) this.zones[n].group.visible = false;

    for (let i = 0; i < MAX_FLASHES; i++) {
      const f = flashes[i];
      const plane = this.flashPlanes[i];
      plane.mesh.visible = !!f;
      if (!f) continue;
      const lo = Math.max(f.x - f.half, sim.monsterMinX);
      const hi = Math.min(f.x + f.half, sim.monsterMaxX);
      placeRect(plane.mesh, lo, hi, -1.5, ARENA.spawnTop, 0.22);
      plane.mat.opacity = (f.life / 0.3) * (f.hit ? 0.7 : 0.35);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.scene.traverse((o) => {
      if (o instanceof InstancedMesh) o.dispose();
    });
  }
}
