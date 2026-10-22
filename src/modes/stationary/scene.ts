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
  RingGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { COLORS } from '../../config';
import type { GlLayer } from '../../core/gl';
import { PALETTE, type ParticleSystem, type Placer } from '../../core/particles';
import type { Swarm } from '../../core/swarm';
import type { ItemDef, MonsterKind } from '../../levels/schema';
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
  laneJackpot,
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
 * the crowd shooters from the ads. The screen shows `FIT_HALF_WIDTH` to each side at the squad's
 * depth, less than the arena, so squad and horde are drawn big; the squad sits `SQUAD_NDC` of the
 * way from the screen centre to its bottom edge, with the road running off into the haze the horde
 * walks out of and room under it for the thumb.
 */
const CAMERA_PITCH = (22 * Math.PI) / 180;
const CAMERA_FOV = 60;
const FIT_HALF_WIDTH = 4.8;
const SQUAD_NDC = -0.15;
/**
 * The camera is too close to show the whole arena at the squad's depth, so it follows the squad
 * sideways by this share of its x. Pointer and drag mappings account for it, so the squad stays
 * under the mouse and the finger.
 */
const CAMERA_FOLLOW = 0.35;
/**
 * In a window wider than the game column (desktop), the column shows the whole road instead, from
 * about as far away as on a phone, and the camera holds still: nothing on the road ever leaves the
 * column, so the labels drawn over it (only as wide as the column) are never cut off.
 */
const WIDE_FIT_HALF_WIDTH = 6.4;
const SQUAD_EYE = 0.4;

const FLOOR_NEAR = -10;
/**
 * Haze: the road fades into the horizon colour between these two points of it (sim y). The camera
 * moves with the screen size, so the fog is set from it in `resize`: monsters appear at
 * `SPAWN_FAR` where the haze is total, and walk out of it until they are clear at `FOG_CLEAR_Y`.
 * The band is kept short, so the field itself stays crisp and colourful (a long one washed the
 * whole upper half of the screen out). Nothing pops out of thin air.
 */
const FOG_CLEAR_Y = SPAWN_FAR - 7;
const FOG_SOLID_Y = SPAWN_FAR - 1;

/** Sky colours overhead, a little above the horizon and at it; the fog fades into the horizon one. */
const SKY_TOP = '#2f7fe0';
const SKY_MID = '#78bdf2';
/** Radius of the sky dome; inside the camera's far plane. */
const SKY_RADIUS = 250;
const HORIZON = 0xb3daf6;
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
/** How long a landed strike zone takes to fade out (seconds). */
const ZONE_FADE = 0.35;

const HOP_RATE = [5, 8.5, 3, 2.4, 1.8];
/** How long the squad glows gold after a power-up, and how long its ground ring runs (seconds). */
const GLOW_TIME = 0.45;
const RING_TIME = 0.5;
const MAX_RINGS = 3;
/**
 * A killed monster flashes white, turns grey, topples over and sinks into the road within this many
 * seconds. At most `MAX_CORPSES` fall at once; past that the oldest one is dropped early.
 */
const DEATH_TIME = 0.45;
const MAX_CORPSES = 80;
/** The prize at the end of the upgrade lane is drawn this much bigger than the other power-ups. */
export const JACKPOT_SCALE = 1.35;

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
  /** Power-ups: the light column, hidden while it stands in the haze (it would glow white there). */
  beam?: Mesh;
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
  /** The sky dome; it travels with the camera. */
  private sky!: Mesh;
  private readonly renderer: WebGLRenderer;
  private readonly disposables: Array<{ dispose(): void }> = [];

  private width = 1;
  private tanHalfV = 0.5;
  private tanHalfH = 0.3;
  /** Distance from the camera to the squad measured along the view axis. */
  private squadDepth = 20;
  /** Share of the squad's x the camera follows (`CAMERA_FOLLOW`, or 0 in a wide window). */
  private follow = CAMERA_FOLLOW;
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
  /** Killed monsters on their way out: grey bodies, and the white flash they start with (per kind). */
  private readonly corpseMeshes: Array<InstancedMesh<BufferGeometry, Material>> = [];
  private readonly deathFlashes: Array<InstancedMesh<BufferGeometry, Material>> = [];
  private readonly corpseX = new Float32Array(MAX_CORPSES);
  private readonly corpseY = new Float32Array(MAX_CORPSES);
  private readonly corpseR = new Float32Array(MAX_CORPSES);
  private readonly corpseKind = new Uint8Array(MAX_CORPSES);
  /** Time of death; -Infinity for a free slot. */
  private readonly corpseT = new Float32Array(MAX_CORPSES).fill(-Infinity);
  private corpseHead = 0;
  private readonly corpseCount: number[] = [0, 0, 0, 0, 0];
  private readonly flashCount: number[] = [0, 0, 0, 0, 0];
  /** A gold shell over the whole squad right after it caught a power-up. */
  private readonly squadShell: InstancedMesh<BufferGeometry, Material>;
  private readonly squadShellMat: MeshBasicMaterial;
  /** Gold rings that run over the ground from the squad when it catches a power-up. */
  private readonly rings: Array<{ mesh: Mesh; mat: MeshBasicMaterial; start: number }> = [];
  private glowStart = -Infinity;
  /** Time of the last frame, so events between frames can be stamped. */
  private now = 0;
  private readonly paletteRgb: Float32Array;

  private readonly elements = new Map<LaneElement, ElementView>();
  private readonly glow: Mesh;
  private readonly zones: ZoneView[] = [];
  private readonly flashPlanes: Array<{ mesh: Mesh; mat: MeshBasicMaterial }> = [];
  /** Strike zones seen last frame, to notice the ones that landed since. */
  private readonly lastAttacks: Array<{ x: number; lo: number; hi: number; y: number }> = [];
  /** Landed strike zones on their way out. */
  private readonly fadingZones: Array<{ lo: number; hi: number; top: number; start: number }> = [];
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

    const glowMat = (color: number, opacity: number) =>
      own(
        new MeshBasicMaterial({
          color,
          transparent: true,
          opacity,
          depthWrite: false,
          blending: AdditiveBlending,
        }),
      );
    const flashMat = glowMat(0xffffff, 0.75);
    const corpseMat = own(new MeshLambertMaterial({ color: 0x9aa0ab, flatShading: true }));
    for (const kind of MONSTER_KIND_BY_INDEX) {
      const geo = own(monsterGeometry(kind));
      const mesh = instanced(geo, unitMat, MAX_MONSTERS);
      this.monsterMeshes.push(mesh);
      this.scene.add(mesh);
      this.addOutline(mesh, own(outlineGeometry(geo)), own(this.outlineMaterial(MONSTER_OUTLINE)));
      const corpses = instanced(geo, corpseMat, MAX_CORPSES);
      this.corpseMeshes.push(corpses);
      this.scene.add(corpses);
      const flash = instanced(geo, flashMat, MAX_CORPSES);
      this.deathFlashes.push(flash);
      this.scene.add(flash);
    }
    const soldierGeo = own(soldierGeometry());
    this.soldiers = instanced(soldierGeo, unitMat, MAX_SHOOTERS);
    this.scene.add(this.soldiers);
    this.addOutline(
      this.soldiers,
      own(outlineGeometry(soldierGeo)),
      own(this.outlineMaterial(SOLDIER_OUTLINE)),
    );
    this.squadShellMat = glowMat(0xffc23a, 0);
    this.squadShell = instanced(soldierGeo, this.squadShellMat, MAX_SHOOTERS);
    this.squadShell.instanceMatrix = this.soldiers.instanceMatrix;
    this.scene.add(this.squadShell);
    const ringGeo = own(new RingGeometry(0.82, 1, 40).rotateX(-Math.PI / 2));
    for (let i = 0; i < MAX_RINGS; i++) {
      // plain blending: added onto the light road, gold would wash out to white
      const mat = own(
        new MeshBasicMaterial({
          color: 0xffb800,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      const mesh = new Mesh(ringGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.rings.push({ mesh, mat, start: -Infinity });
    }

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
    // less fill and more sun than a flat studio light: shapes and colours keep their contrast
    this.scene.add(new HemisphereLight(0xffffff, 0x8d939e, 1.45));
    this.scene.add(new AmbientLight(0xffffff, 0.25));
    const sun = new DirectionalLight(0xfff4e0, 2.7);
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
    // The sky is a dome around the camera, coloured by how high each direction points: exactly
    // the haze colour at the horizon, deep blue overhead. A flat screen gradient reached the haze
    // colour only at the bottom edge, so the fogged sea met blue sky in a hard line.
    this.scene.background = new Color(HORIZON);
    this.sky = new Mesh(
      this.track(new SphereGeometry(SKY_RADIUS, 32, 16)),
      this.track(
        new ShaderMaterial({
          side: BackSide,
          depthTest: false,
          depthWrite: false,
          fog: false,
          uniforms: {
            top: { value: new Color(SKY_TOP) },
            mid: { value: new Color(SKY_MID) },
            horizon: { value: new Color(HORIZON) },
          },
          vertexShader: `
            varying vec3 vDir;
            void main() {
              vDir = normalize(position);
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
          fragmentShader: `
            uniform vec3 top;
            uniform vec3 mid;
            uniform vec3 horizon;
            varying vec3 vDir;
            void main() {
              float h = max(normalize(vDir).y, 0.0);
              // the camera looks down, so the top of the screen is only a few degrees up:
              // a thin band of haze, then quickly into blue
              vec3 c = mix(horizon, mid, smoothstep(0.0, 0.035, h));
              c = mix(c, top, smoothstep(0.035, 0.16, h));
              gl_FragColor = vec4(c, 1.0);
              #include <colorspace_fragment>
            }`,
        }),
      ),
    );
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this.scene.fog = new Fog(HORIZON, 30, 56); // the real distances are set in `resize`

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
    // the sea stays clear of the haze all the way to the horizon, deep blue on both sides of the
    // bridge as in the ad shooters; only the bridge itself fades into the distance
    const water = new Mesh(plane, this.track(new MeshBasicMaterial({ map: sea, fog: false })));
    placeRect(water, -400, 400, -300, 500, -5);
    this.scene.add(water);

    // the road: warm grey deck plates with fine anti-slip ribs across, calm enough that the
    // squad and the horde stand out on it; white edge lines
    const half = ARENA.halfWidth + 0.3;
    const ribs = this.track(
      canvasTexture([64, 64], (g) => {
        g.fillStyle = '#c8c2b7';
        g.fillRect(0, 0, 64, 64);
        for (let i = 0; i < 4; i++) {
          const y = i * 16;
          g.fillStyle = '#bdb6ab';
          g.fillRect(0, y, 64, 2);
          g.fillStyle = '#d0cac0';
          g.fillRect(0, y + 2, 64, 1);
        }
        // a faint seam where two plates meet
        g.fillStyle = 'rgba(120, 112, 100, 0.25)';
        g.fillRect(0, 0, 1, 64);
      }),
    );
    ribs.repeat.set((half * 2) / 2.4, length / 1.2);
    const road = new Mesh(plane, this.track(new MeshLambertMaterial({ map: ribs })));
    placeRect(road, -half, half, FLOOR_NEAR, end, 0);
    this.scene.add(road);
    // the deck, its top just under the road so the two never fight over the same depth
    box(lambert(0x8d939e), 0, -0.79, mid, half * 2 + 1.4, 1.5, length);
    const railMat = lambert(0xaab0ba);
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
    const pylonMat = lambert(0x7b828e);
    const cableMat = lambert(0xc9ced6);
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

    // a solid dark wall between the upgrade lane and the monsters, with a lighter cap, from a
    // little ahead of the squad until it disappears in the haze: the two lanes read at a glance
    const left = sim.lane.x < 0;
    const laneEdge = sim.lane.x + (left ? 1 : -1) * (sim.lane.width / 2);
    const fieldEdge = left ? sim.monsterMinX : sim.monsterMaxX;
    const wallX = (laneEdge + fieldEdge) / 2;
    const wallZ = -(SPAWN_FAR + 3.2) / 2;
    box(lambert(0x565c68), wallX, 0.75, wallZ, 0.32, 1.5, SPAWN_FAR - 3.2);
    box(lambert(0x9aa0ab), wallX, 1.54, wallZ, 0.38, 0.08, SPAWN_FAR - 3.2);

    // the line monsters bite at
    const bite = new Mesh(plane, solid(0xff4d6d, 0.45));
    placeRect(bite, mx0, mx1, 0.5, 0.75, 0.06);
    this.scene.add(bite);
  }

  private buildLane(own: <T extends { dispose(): void }>(x: T) => T): void {
    const sim = this.sim;
    // blocks are piles of old tyres; power-ups float over glowing pedestals
    // a pile fills what it blocks: road edge to divider, so its look matches what it stops
    const tireGeo = own(
      tireStackGeometry(sim.lane.blockHi - sim.lane.blockLo - 0.3, BLOCK_HEIGHT - 0.1, 1.2),
    );
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

    const jackpot = laneJackpot(sim.lane.elements);
    // the prize at the far end shines through the haze: it is the goal you see from the start
    const clear = <T extends MeshBasicMaterial | MeshLambertMaterial>(m: T): T => {
      const c = own(m.clone() as T);
      c.fog = false;
      return c;
    };
    const jackpotPedestal = clear(pedestalMat);
    const jackpotBeams = {
      crowd: clear(beamMats.crowd),
      upgrade: clear(beamMats.upgrade),
      weapon: clear(beamMats.weapon),
    };
    for (const e of sim.lane.elements) {
      const group = new Group();
      if (e === jackpot) group.scale.setScalar(JACKPOT_SCALE);
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
        const prize = e === jackpot;
        const bodyMat = prize ? jackpotPedestal : pedestalMat;
        group.add(new Mesh(pedestals[kind], bodyMat));
        const beam = new Mesh(beamGeo, (prize ? jackpotBeams : beamMats)[kind]);
        beam.position.y = 1.05;
        group.add(beam);
        let float: Object3D | undefined;
        if (kind === 'weapon') {
          float = new Mesh(gun, bodyMat);
          float.position.y = 1.2;
          group.add(float);
        }
        this.elements.set(e, {
          group,
          item: e.item,
          ...(float ? { float } : {}),
          ...(prize ? {} : { beam }),
        });
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
    const wide = this.gl.width > width + 1;
    this.follow = wide ? 0 : CAMERA_FOLLOW;
    const depth = (wide ? WIDE_FIT_HALF_WIDTH : FIT_HALF_WIDTH) / (tanV * aspect);
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
    // the fog measures depth along the view axis; a step of y along the road adds y * cos(pitch)
    const fog = this.scene.fog as Fog;
    fog.near = depth + FOG_CLEAR_Y * cosP;
    fog.far = depth + FOG_SOLID_Y * cosP;
    this.camera.updateMatrixWorld();
  }

  /** World x under a screen x (CSS px), as seen at the squad's depth. */
  screenToWorldX(px: number): number {
    return (((px / this.width) * 2 - 1) * this.tanHalfH * this.squadDepth) / (1 - this.follow);
  }

  /** World distance that a horizontal drag of `px` CSS px covers at the squad's depth. */
  pxToWorld(px: number): number {
    return ((px / this.width) * 2 * this.tanHalfH * this.squadDepth) / (1 - this.follow);
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

  /** The squad caught a power-up: a gold ring runs over the ground from it and it glows gold. */
  celebrate(x: number): void {
    const ring = this.rings.reduce((a, b) => (a.start <= b.start ? a : b));
    ring.start = this.now;
    ring.mesh.position.set(x, 0.14, 0.3);
    this.glowStart = this.now;
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
    this.now = time;
    const follow = this.sim.squadX * this.follow;
    this.camera.position.set(follow + shakeX, this.baseCamY + shakeY, this.baseCamZ);
    this.sky.position.copy(this.camera.position);
    this.camera.updateMatrixWorld();

    this.syncMonsters(time);
    this.syncSoldiers(time, player, recoil);
    this.syncBullets();
    this.syncParticles(particles);
    this.syncLane(time);
    this.syncZones(flashes, time);
    this.syncRings(time);
    this.syncCorpses(time);
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

  /** A monster died at (x, y): it starts its short fall (see `DEATH_TIME`). */
  corpse(x: number, y: number, kind: MonsterKind, radius: number): void {
    const c = this.corpseHead;
    this.corpseHead = (c + 1) % MAX_CORPSES;
    this.corpseX[c] = x;
    this.corpseY[c] = y;
    this.corpseR[c] = radius;
    this.corpseKind[c] = MONSTER_KIND_BY_INDEX.indexOf(kind);
    this.corpseT[c] = this.now;
  }

  private syncCorpses(time: number): void {
    const counts = this.corpseCount;
    const flashes = this.flashCount;
    counts.fill(0);
    flashes.fill(0);
    const bodies = this.corpseMeshes.map((m) => m.instanceMatrix.array as Float32Array);
    const shells = this.deathFlashes.map((m) => m.instanceMatrix.array as Float32Array);
    for (let c = 0; c < MAX_CORPSES; c++) {
      const a = (time - this.corpseT[c]) / DEATH_TIME;
      if (!(a >= 0 && a < 1)) continue;
      const k = this.corpseKind[c];
      const x = this.corpseX[c];
      const y = this.corpseY[c];
      const r = this.corpseR[c];
      // a quick pop, then it keels over to one side, shrinks and sinks into the road
      const pop = a < 0.15 ? 1 + 0.15 * (a / 0.15) : 1.15;
      const fall = Math.min(1, Math.max(0, (a - 0.12) / 0.45));
      const roll = (c & 1 ? 1 : -1) * 1.4 * fall * (2 - fall);
      const fade = Math.max(0, (a - 0.5) / 0.5);
      const s = r * pop * (1 - 0.6 * fade);
      const sink = -r * 0.9 * fade;
      writeTRS(bodies[k], counts[k]++, x, sink, -y, 0, roll, s, s, s);
      if (a < 0.2)
        writeTRS(shells[k], flashes[k]++, x, sink, -y, 0, roll, s * 1.04, s * 1.04, s * 1.04);
    }
    for (let k = 0; k < this.corpseMeshes.length; k++) {
      this.corpseMeshes[k].count = counts[k];
      this.corpseMeshes[k].instanceMatrix.needsUpdate = true;
      this.deathFlashes[k].count = flashes[k];
      this.deathFlashes[k].instanceMatrix.needsUpdate = true;
    }
  }

  private syncSoldiers(time: number, player: Swarm, recoil: number): void {
    const sim = this.sim;
    const arr = this.soldiers.instanceMatrix.array as Float32Array;
    const shadowArr = this.shadows.instanceMatrix.array as Float32Array;
    let shadowN = this.shadowFill;
    const moving = Math.min(1, Math.abs(sim.squadVx) / 4);
    const lean = Math.max(-0.3, Math.min(0.3, -sim.squadVx * 0.014));
    const n = player.n;
    // a small squad is drawn bigger (one soldier would be a speck); a big one shrinks to its 1.6
    const size = 1.6 + 0.7 / Math.sqrt(Math.max(1, n));
    const muzzleArr = this.muzzles.instanceMatrix.array as Float32Array;
    const flare = recoil * recoil;
    for (let i = 0; i < n; i++) {
      // every soldier stands a little off its grid slot and turned its own way: a group of people,
      // not a parade block (small enough that the bullets still leave from the gun)
      const x = player.x[i] + (((i * 0.618) % 1) - 0.5) * 0.2;
      const y = player.y[i] + (((i * 0.382 + 0.3) % 1) - 0.5) * 0.28;
      const yaw = (((i * 0.7548) % 1) - 0.5) * 0.35;
      const bob = (Math.abs(Math.sin(time * 14 + i * 1.3)) * 0.06 * moving) as number;
      writeTRS(arr, i, x, bob, -y + recoil * 0.12, yaw, lean, size, size, size);
      writeTRS(shadowArr, shadowN++, x, 0.1, -y, 0, 0, 0.2 * size, 1, 0.2 * size);
      // the gun's muzzle sits at (0, 0.55, -0.76) in model space
      const m = flare * size * 0.55;
      writeTRS(muzzleArr, i, x, 0.55 * size, -y - 0.8 * size + recoil * 0.12, i * 1.9, 0, m, m, m);
    }
    this.soldiers.count = n;
    this.soldiers.instanceMatrix.needsUpdate = true;
    const glow = Math.max(0, 1 - (time - this.glowStart) / GLOW_TIME);
    this.squadShellMat.opacity = 0.85 * glow;
    this.squadShell.count = glow > 0 ? n : 0;
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
        g.position.set((sim.lane.blockLo + sim.lane.blockHi) / 2, 0, -e.y - 0.06 * e.flash);
        g.scale.set(1 + 0.03 * e.flash, 1 - 0.08 * e.flash, 1);
      } else {
        const front = k === 0;
        g.position.set(sim.lane.x, 0, -e.y);
        if (view.beam) view.beam.visible = e.y < FOG_CLEAR_Y;
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

  private syncRings(time: number): void {
    for (const ring of this.rings) {
      const age = (time - ring.start) / RING_TIME;
      ring.mesh.visible = age >= 0 && age < 1;
      if (!ring.mesh.visible) continue;
      const r = 0.8 + 3.2 * (1 - (1 - age) * (1 - age)); // fast out, then easing
      ring.mesh.scale.set(r, 1, r);
      ring.mat.opacity = 0.9 * (1 - age);
    }
  }

  /**
   * One strike zone from the squad's row up to the elite at `top`: it fills up while `t` runs to 1,
   * blinks white just before it lands, and is drawn at `k` of its strength (1 live, then fading).
   */
  private drawZone(z: ZoneView, lo: number, hi: number, top: number, t: number, k: number): void {
    const bottom = -1.5;
    z.group.visible = true;
    placeRect(z.base, lo, hi, bottom, top, 0.14);
    z.baseMat.opacity = (0.2 + 0.35 * t) * k;
    const reach = (top - bottom) * t;
    placeRect(z.fill, lo, hi, top - reach, top, 0.16);
    z.fillMat.opacity = (0.3 + 0.4 * t) * k;
    const w = 0.14;
    placeRect(z.edges[0], lo, lo + w, bottom, top, 0.18);
    placeRect(z.edges[1], hi - w, hi, bottom, top, 0.18);
    placeRect(z.edges[2], lo, hi, top - w, top, 0.18);
    placeRect(z.edges[3], lo, hi, bottom, bottom + w, 0.18);
    z.edgeMat.opacity = 0.95 * k;
    const white = k === 1 && t > 0.7 && Math.floor(t * 20) % 2 === 0;
    const mid = (top + bottom) / 2;
    const c0 = z.curtains[0];
    const c1 = z.curtains[1];
    c0.position.set(lo, 0.35, -mid);
    c1.position.set(hi, 0.35, -mid);
    c0.scale.set(1, 0.7, top - bottom);
    c1.scale.set(1, 0.7, top - bottom);
    z.edgeMat.color.setHex(white ? 0xffffff : 0xff5a6e);
  }

  private syncZones(
    flashes: ReadonlyArray<{ x: number; half: number; life: number; hit: boolean }>,
    time: number,
  ): void {
    const sim = this.sim;
    // a strike that just landed is gone from the sim; its zone fades out instead of popping away
    for (const last of this.lastAttacks) {
      if (!sim.attacks.some((a) => a.x === last.x)) {
        this.fadingZones.push({ lo: last.lo, hi: last.hi, top: last.y, start: time });
      }
    }
    this.lastAttacks.length = 0;
    for (const a of sim.attacks) this.lastAttacks.push({ x: a.x, lo: a.lo, hi: a.hi, y: a.y });
    while (this.fadingZones.length > 0 && time - this.fadingZones[0].start >= ZONE_FADE) {
      this.fadingZones.shift();
    }

    let n = 0;
    for (const a of sim.attacks) {
      if (n >= MAX_ATTACKS) break;
      this.drawZone(this.zones[n++], a.lo, a.hi, a.y, a.t, 1);
    }
    for (const f of this.fadingZones) {
      if (n >= MAX_ATTACKS) break;
      this.drawZone(this.zones[n++], f.lo, f.hi, f.top, 1, 1 - (time - f.start) / ZONE_FADE);
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
