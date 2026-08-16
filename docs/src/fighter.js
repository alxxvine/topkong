import * as THREE from 'three';
import { tuning as T } from 'tk/tuning.js';
import { clamp01, inverseLerp, lerp, RAD } from 'tk/mathx.js';
import * as Rig from 'tk/fighterRig.js';
import { PoseDriver } from 'tk/poseDriver.js';
import { Gait } from 'tk/gait.js';
import { SwingAction } from 'tk/swingAction.js';
import { Locomotion } from 'tk/locomotion.js';
import { Balance } from 'tk/balance.js';
import { Body, P } from 'tk/body.js';

// Боец целиком: кости, состояние тела и переходы между управлением и тряпкой.
//
// Тело симулируется всегда — двух режимов больше нет. PoseDriver говорит,
// какую позу боец ХОЧЕТ принять, мышцы в body.js его туда тянут, а получится
// ли — зависит от того, насколько крепко они держат. Удар не переключает
// режим, он просто отпускает мышцы.

// Режимов тела больше нет: оно всегда физическое. Это лишь ярлык
// для интерфейса и логики — держат ли сейчас мышцы позу.
export const BodyState = {
  Standing: 'standing',
  Downed: 'downed',
  Dead: 'dead',
};

const TRAIL_POINTS = 26;

// Weapon looks. Not just palettes anymore: `head` picks the head's
// GEOMETRY — the spiked ball, a sledge block, an axe blade — while the
// grip, length, mass and hit physics stay the club's, so every look
// swings identically and the strikes read the same. Classic is the
// scene-toned ash and graphite; the unlockables get to be louder on
// purpose: a trophy that nobody can tell from the default is not a
// trophy.
export const CLUB_SKINS = {
  classic: { wood: 0xd8c3a5, woodR: 0.72, metal: 0x9ba1ab, metalR: 0.38, metalM: 0.55, head: 'ball' },
  hammer:  { wood: 0xb99b7a, woodR: 0.6,  metal: 0xaab4c0, metalR: 0.3,  metalM: 0.75, head: 'maul' },
  // A big all-wood mallet: a fat drum across the shaft.
  mallet:  { wood: 0xcdb28c, woodR: 0.6,  metal: 0xa9835c, metalR: 0.62, metalM: 0.08, head: 'drum' },
  // Palette twins of the classic spiked ball: charcoal-and-ember and
  // pale-birch-and-ice. Cheap variety with the head players know.
  ember:   { wood: 0x453a35, woodR: 0.6,  metal: 0xe8543f, metalR: 0.35, metalM: 0.3,  head: 'ball' },
  frost:   { wood: 0xe8e2d4, woodR: 0.5,  metal: 0xa8d8ea, metalR: 0.2,  metalM: 0.7,  head: 'ball' },
  // The bat is all wood; the "metal" slot paints its grip tape. (An axe
  // was tried in this slot and cut: a bladed head read wrong against the
  // blunt swing arcs — simple club-shaped things only.)
  bat:     { wood: 0xdcae72, woodR: 0.55, metal: 0x3a3f47, metalR: 0.65, metalM: 0.15, head: 'bat' },
  gilded:  { wood: 0xc9a54f, woodR: 0.45, metal: 0xf3d05e, metalR: 0.22, metalM: 0.9,  head: 'ball' },
  void:    { wood: 0x2b2438, woodR: 0.6,  metal: 0x8b5cf6, metalR: 0.3,  metalM: 0.7,  head: 'ball' },
};

// Part SHAPES: silhouette variants of the cardboard cutout. The skeleton
// never changes — bone lengths, joints and all the physics stay identical;
// a shape only re-cuts the visual panels (widths, depths, and for the head
// the primitive itself). Same doll, a different cut of cardboard, so any
// combination is safe to hand to bots and players alike.
export const HEAD_SHAPES = {
  // w/h/d in HeadSize units; eyeZ pushes the face out to the new surface.
  classic: { w: 1, h: 1, d: 0.85 },
  brick:   { w: 1.35, h: 0.68, d: 0.85 },
  tower:   { w: 0.75, h: 1.38, d: 0.78 },
  ball:    { ball: true, r: 0.58, eyeZ: 0.54 },
};
export const TORSO_SHAPES = {
  // Multipliers on hips width, chest bottom/top widths and sheet depth.
  classic: { hips: 1, chestB: 1, chestT: 1, d: 1 },
  hero:    { hips: 0.85, chestB: 1.05, chestT: 1.7, d: 1 },
  barrel:  { hips: 1.2, chestB: 1.4, chestT: 0.85, d: 1.3 },
  wiry:    { hips: 0.78, chestB: 0.75, chestT: 0.85, d: 0.7 },
};
export const ARM_SHAPES = {
  // Multipliers on the top/mid/bottom widths of the two-piece trapezoid.
  classic: { top: 1, mid: 1, bottom: 1, d: 1 },
  beefy:   { top: 1.6, mid: 1.5, bottom: 1.3, d: 1.5 },
  noodle:  { top: 0.55, mid: 0.5, bottom: 0.6, d: 0.7 },
  slab:    { top: 1.2, mid: 0.96, bottom: 0.8, d: 1.6 },
};
export const LEG_SHAPES = {
  classic: { top: 1, mid: 1, bottom: 1, d: 1 },
  stumpy:  { top: 1.6, mid: 1.5, bottom: 1.4, d: 1.4 },
  lanky:   { top: 0.6, mid: 0.55, bottom: 0.6, d: 0.75 },
  slab:    { top: 1.2, mid: 0.96, bottom: 0.8, d: 1.5 },
};
const SHAPE_SETS = {
  head: HEAD_SHAPES, torso: TORSO_SHAPES, arms: ARM_SHAPES, legs: LEG_SHAPES,
};

// Eye styles — the head's "skin". Geometry variants of the two face boxes:
// size, height on the face and tilt are enough for four readable moods.
// Tilt is per-side (rotation.z = side * tilt), so positive is a friendly
// outward slant and negative knits the brows.
export const EYE_STYLES = {
  classic: { w: 0.16, h: 0.24, y: 0.05, tilt: 0.1 },
  dot:     { w: 0.13, h: 0.13, y: 0.07, tilt: 0 },
  mean:    { w: 0.2,  h: 0.18, y: 0.08, tilt: -0.38 },
  sleepy:  { w: 0.22, h: 0.08, y: 0.02, tilt: 0.16 },
};

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _impulse = new THREE.Vector3();
const AXIS_Y = new THREE.Vector3(0, 1, 0);

let nextId = 1;

export class Fighter {
  constructor(scene, arena, options = {}) {
    this.id = nextId++;
    this.scene = scene;
    this.arena = arena;
    this.name = options.name || ('F' + this.id);
    this.isPlayer = !!options.isPlayer;
    /** Whether THIS fighter carries a club. Set per fighter: the player
     *  picks a weapon on the setup screen, bots get theirs from the roster. */
    this.armed = options.armed !== false;
    /** Блок держится прямо сейчас (ПКМ у игрока). Принятый на блок удар
     *  не роняет, а отталкивает — см. checkHits. */
    this.blocking = false;
    this.color = new THREE.Color(options.color !== undefined ? options.color : 0xe0a267);

    this.position = new THREE.Vector3();
    this.yaw = 0;
    this.moveInput = new THREE.Vector2();
    this.facingTarget = new THREE.Vector3(0, 0, 1);

    this.group = new THREE.Group();
    scene.add(this.group);

    /** Per-part shape names (see SHAPE_SETS) and the eye style. Filled
     *  before build(): the per-part builders read them, and setPart
     *  re-runs one builder to swap a silhouette live. */
    this.parts = { head: 'classic', torso: 'classic', arms: 'classic', legs: 'classic' };
    this.clubSkin = 'classic';
    this.eyeStyle = EYE_STYLES[options.eyes] ? options.eyes : 'classic';
    this.partMeshes = { head: [], torso: [], arms: [], legs: [] };
    this.eyeMeshes = [];

    this.bones = {};
    this.build();

    this.swing = new SwingAction();
    this.poseDriver = new PoseDriver(this);
    this.locomotion = new Locomotion(this, arena);
    this.body = new Body(arena);
    // Походка держит мировые опоры стоп. Создаётся после тела не случайно:
    // на спавне она втыкает стопы туда, где тело уже стоит.
    this.gait = new Gait(this, arena);
    // Равновесие читает тело и походку, поэтому создаётся последним.
    this.balance = new Balance(this);

    this.state = BodyState.Standing;
    this.alive = true;

    this.downTime = 0;
    this.settleTime = 0;
    this.airTime = 0;
    this.deadTime = 0;
    /** Расшатка от тарана, 0..1. Копит contact.js, спадает сама. */
    this.stagger = 0;
    /** Куда валит таран — мировое направление; по нему наклоняется поза. */
    this.staggerDirX = 0;
    this.staggerDirZ = 0;

    /** Kills and deaths, CS-style. Survive rounds and respawns; reset only
     *  when the game mode flips (scores mean different things per mode). */
    this.kills = 0;
    this.deaths = 0;
    /** Who shoved/hit this fighter last, and how long that credit lasts.
     *  If the fighter falls off while the window is open, that's a kill. */
    this.lastAttacker = null;
    this.killCredit = 0;

    // Скорость набалдашника меряется по смещению за кадр: кость кинематическая,
    // собственной скорости у неё нет вовсе.
    this.clubHead = new THREE.Vector3();
    this.clubHeadPrev = new THREE.Vector3();
    this.clubGrip = new THREE.Vector3();
    this.swingSpeed = 0;
    /** Stamina 0..1. Strikes, the dash and a held block spend from it;
     *  it refills after a short pause. Empty means no new strikes and a
     *  broken block — the counter to infinite clicking (see tuning). */
    this.stamina = 1;
    this.staminaWait = 0;
    this._swingWas = 'guard';
    // The fists get the same treatment for bare-knuckle strikes.
    this.fistR = new THREE.Vector3();
    this.fistRPrev = new THREE.Vector3();
    this.fistL = new THREE.Vector3();
    this.fistLPrev = new THREE.Vector3();
    this.fistSpeedR = 0;
    this.fistSpeedL = 0;
    this.lastHit = new Map();

    this.lastImpactSpeed = 0;
    this.lastImpactPower = 0;

    this.spawn(options.x || 0, options.z || 0, options.yaw || 0);
  }

  // ---------------------------------------------------------------- сборка

  build() {
    // Тело — картонная кукла строго по выкройке: голова 5x5, грудь трапеция
    // 2 сверху и 3 снизу, таз квадрат 3x3, рука 6, нога 8. Стоп нет вовсе,
    // нога цельная деталь. Панели расширяются к дальнему концу, а не
    // к суставу, — от этого и весь силуэт.
    //
    // Кости создаются здесь один раз; сами панели вешают пер-частевые
    // билдеры (buildTorso и компания) — их же дергает setPart, когда
    // игрок меняет форму детали на живой кукле.
    //
    // Нога и рука — трапеция, разрезанная ровно посередине и раздвинутая
    // на зазор: в просвете видна нить, а колено может согнуться, когда
    // прямой ноге места не осталось.
    for (const name of ['hips', 'chest', 'head',
      'legLUpper', 'legRUpper', 'legLLower', 'legRLower',
      'armRUpper', 'armLUpper', 'armRFore', 'armLFore',
      // Стоп на выкройке нет: кости оставлены пустыми, физике они нужны.
      'footL', 'footR']) {
      this.bones[name] = this.bone(name);
    }
    this.buildTorso();
    this.buildHead();
    this.buildEyes();
    this.buildArms();
    this.buildLegs();

    this.bones.club = this.bone('club');
    this.buildClub();

    this.buildThread();
    this.buildMarker();
    this.marker.visible = !!T.showMarkers;
    this.buildTrail();
  }

  bone(name) {
    const g = new THREE.Group();
    g.name = name;
    this.group.add(g);
    return g;
  }

  /** Drop one part's meshes so its builder can hang a new silhouette. */
  clearPart(part) {
    for (const m of this.partMeshes[part]) {
      m.geometry.dispose();
      m.parent.remove(m);
    }
    this.partMeshes[part].length = 0;
  }

  /** Hips + chest panels for the current torso shape. */
  buildTorso() {
    this.clearPart('torso');
    const st = TORSO_SHAPES[this.parts.torso] || TORSO_SHAPES.classic;
    const card = mat(this.color, 0.95);
    const D = Rig.PanelDepth;
    this.partMeshes.torso.push(
      panel(this.bones.hips, Rig.HipsSize,
        Rig.HipsSize * st.hips, Rig.HipsSize * st.hips, D * 2 * st.d, card),
      panel(this.bones.chest, Rig.ChestHeight,
        Rig.ChestBottomWidth * st.chestB, Rig.ChestTopWidth * st.chestT,
        D * 2 * st.d, card));
  }

  /** The head block (or ball) for the current head shape. */
  buildHead() {
    this.clearPart('head');
    const st = HEAD_SHAPES[this.parts.head] || HEAD_SHAPES.classic;
    const card = mat(this.color, 0.95);
    const H = Rig.HeadSize;
    this.partMeshes.head.push(st.ball
      ? sphere(this.bones.head, H * st.r, card)
      : box(this.bones.head, H * st.w, H * st.h, H * st.d, null, card));
  }

  /**
   * Звено конечности: трапеция от сустава к суставу. Локальная +Y кости
   * смотрит на дальний сустав, панель расширяется к нему — как на чертеже.
   * Панель короче своей кости на зазор с обоих концов: части тела висят
   * НЕ впритык, на сгибе не въезжают друг в друга, в просвете видна нить.
   */
  limbPiece(part, boneName, half, nearWidth, farWidth, depth) {
    const m = panel(this.bones[boneName],
      Math.max(0.02, half - (T.partGap || 0) * Rig.CM * 2),
      nearWidth, farWidth, depth, mat(this.color, 0.95));
    this.partMeshes[part].push(m);
  }

  buildArms() {
    this.clearPart('arms');
    const st = ARM_SHAPES[this.parts.arms] || ARM_SHAPES.classic;
    const D = Rig.PanelDepth * st.d;
    for (const n of ['armRUpper', 'armLUpper']) {
      this.limbPiece('arms', n, Rig.HalfArm,
        Rig.ArmTopWidth * st.top, Rig.ArmMidWidth * st.mid, D);
    }
    for (const n of ['armRFore', 'armLFore']) {
      this.limbPiece('arms', n, Rig.HalfArm,
        Rig.ArmMidWidth * st.mid, Rig.ArmBottomWidth * st.bottom, D);
    }
  }

  buildLegs() {
    this.clearPart('legs');
    const st = LEG_SHAPES[this.parts.legs] || LEG_SHAPES.classic;
    const D = Rig.PanelDepth * 1.4 * st.d;
    for (const n of ['legLUpper', 'legRUpper']) {
      this.limbPiece('legs', n, Rig.HalfLeg,
        Rig.LegTopWidth * st.top, Rig.LegMidWidth * st.mid, D);
    }
    for (const n of ['legLLower', 'legRLower']) {
      this.limbPiece('legs', n, Rig.HalfLeg,
        Rig.LegMidWidth * st.mid, Rig.LegBottomWidth * st.bottom, D);
    }
  }

  /** (Re)build the two face boxes for the current eye style. Called from
   *  build() and again by setEyes — geometry swaps, the head bone stays.
   *  The Z offset comes from the HEAD shape: the face sits on whatever
   *  surface the current head has. */
  buildEyes() {
    for (const eye of this.eyeMeshes) {
      eye.geometry.dispose();
      this.bones.head.remove(eye);
    }
    this.eyeMeshes.length = 0;
    const st = EYE_STYLES[this.eyeStyle] || EYE_STYLES.classic;
    const hs = HEAD_SHAPES[this.parts.head] || HEAD_SHAPES.classic;
    const ink = mat(new THREE.Color(0x2b2f38), 0.85);
    for (const side of [-1, 1]) {
      const eye = box(this.bones.head, Rig.HeadSize * st.w, Rig.HeadSize * st.h, 0.02,
        new THREE.Vector3(side * Rig.HeadSize * 0.2, Rig.HeadSize * st.y,
          Rig.HeadSize * (hs.eyeZ ?? 0.43)), ink);
      eye.rotation.z = side * st.tilt;
      this.eyeMeshes.push(eye);
    }
  }

  /**
   * Светящаяся нить по всему скелету.
   *
   * Проведена по каждой кости целиком, а не кусочками в суставах: панели
   * закрывают её почти везде, и видно нить ровно в зазорах между ними.
   * Считать отдельно, где именно её показать, не нужно — геометрия делает
   * это сама.
   */
  buildThread() {
    const pairs = [
      [P.Hips, P.Chest], [P.Chest, P.Head],
      [P.Hips, P.HipL], [P.Hips, P.HipR],
      [P.HipL, P.KneeL], [P.KneeL, P.FootL],
      [P.HipR, P.KneeR], [P.KneeR, P.FootR],
      [P.Chest, P.ShoulderL], [P.Chest, P.ShoulderR],
      [P.ShoulderR, P.ElbowR], [P.ElbowR, P.HandR],
      [P.ShoulderL, P.ElbowL], [P.ElbowL, P.HandL],
    ];
    this.threadPairs = pairs;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position',
      new THREE.BufferAttribute(new Float32Array(pairs.length * 6), 3));
    // Складывающееся свечение без записи в буфер глубины: нить светится
    // сквозь и не спорит с панелями за то, кто ближе.
    this.thread = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
      color: this.color.clone().lerp(new THREE.Color(0xfff6d8), 0.9),
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    this.thread.frustumCulled = false;
    this.group.add(this.thread);
  }

  updateThread() {
    if (!this.thread) return;
    const attr = this.thread.geometry.getAttribute('position');
    const arr = attr.array;
    const p = this.body.pos;
    for (let i = 0; i < this.threadPairs.length; i++) {
      const [a, b] = this.threadPairs[i];
      arr[i * 6] = p[a].x; arr[i * 6 + 1] = p[a].y; arr[i * 6 + 2] = p[a].z;
      arr[i * 6 + 3] = p[b].x; arr[i * 6 + 4] = p[b].y; arr[i * 6 + 5] = p[b].z;
    }
    attr.needsUpdate = true;
  }

  /** Круг под ногами. Единственный способ в свалке понять, кто из них ты. */
  buildMarker() {
    const r = this.isPlayer ? 0.55 : 0.45;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r - 0.045, r, 40),
      new THREE.MeshBasicMaterial({
        color: this.isPlayer ? 0xffffff : this.color,
        transparent: true,
        opacity: this.isPlayer ? 0.85 : 0.4,
        depthWrite: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.012;
    // Маркер живёт в сцене, а не в группе бойца: у тряпки группа стоит
    // в нуле, и метка уехала бы в центр арены.
    this.marker = ring;
    this.scene.add(ring);
  }

  /** Лента за набалдашником: по её форме сразу видно, какой получилась дуга. */
  buildTrail() {
    const positions = new Float32Array(TRAIL_POINTS * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.trail = new THREE.Line(geometry, new THREE.LineBasicMaterial({
      color: this.color,
      transparent: true,
      opacity: 0.55,
    }));
    this.trail.frustumCulled = false;
    this.trailPoints = [];
    this.scene.add(this.trail);
  }

  // ------------------------------------------------------------- состояния

  spawn(x, z, yaw) {
    this.yaw = yaw;
    this.facingTarget.set(Math.sin(yaw), 0, Math.cos(yaw));
    this.moveInput.set(0, 0);

    this.state = BodyState.Standing;
    this.alive = true;
    this.downTime = 0;
    this.settleTime = 0;
    this.airTime = 0;
    this.deadTime = 0;
    // Kill credit does not survive a respawn: a fresh life owes nobody.
    this.lastAttacker = null;
    this.killCredit = 0;
    /** Расшатка от тарана, 0..1. Копит contact.js, спадает сама. */
    this.stagger = 0;
    /** Куда валит таран — мировое направление; по нему наклоняется поза. */
    this.staggerDirX = 0;
    this.staggerDirZ = 0;
    this.swingSpeed = 0;
    this.stamina = 1;
    this.staminaWait = 0;
    this._swingWas = 'guard';
    this.lastHit.clear();
    this.trailPoints.length = 0;

    this.swing.reset();
    this.poseDriver.reset();
    this.locomotion.reset();
    this.balance.reset();
    this.body.reset(x, z, yaw);
    this.gait.reset(x, z, yaw);

    // Группа бойца стоит в нуле навсегда: кости пишутся мировыми координатами
    // прямо из частиц. Именно переключение группы между двумя системами
    // отсчёта и порождало кадр с телом в центре арены.
    this.group.position.set(0, 0, 0);
    this.group.quaternion.identity();
    this.group.visible = true;
    this.marker.visible = !!T.showMarkers;

    // Разложить кости сразу, иначе первый кадр рисует позу с прошлой жизни.
    this.poseDriver.tick(1 / 120, 0, true);
    this.body.setTargets(this.poseDriver.pose, yaw);
    this.body.writeBones(this.bones, this.poseDriver.headTurn, this.poseDriver.lookPitch);
    this.updateThread();
    this.position.set(x, 0, z);
    this.group.updateMatrixWorld(true);
    this.updateClubHead(1 / 120, true);
  }

  /**
   * Принять удар. Единственная точка, где боец теряет управление.
   *
   * Отдельного режима «тряпка» больше нет: мышцы просто отпускаются.
   * Тело всё это время симулировалось и продолжает — меняется лишь то,
   * держит ли оно позу. Отсюда же исчезла вся машинерия перехода:
   * ни заморозки позы, ни переноса координат, ни обратной сборки.
   */
  takeHit(impulse, dt, index) {
    if (!this.alive) return;

    const step = Math.max(dt, 1 / 120);
    // Верх тела получает добавку, поэтому боец опрокидывается сам,
    // без отдельно заданного момента.
    this.body.pushAll(impulse, step,
      [P.Head, P.Chest, P.ShoulderL, P.ShoulderR], 0.5);
    if (index !== undefined) this.body.push(index, impulse, step * 0.6);

    this.body.strength = 0;
    this.downTime = 0;
    this.settleTime = 0;
    this.swing.reset();
  }

  /**
   * Credit an outside influence: whoever affected this fighter last within
   * the credit window owns the eventual fall. Called on club hits, ram
   * topples and while a downed body is being rolled — the CS rule of
   * «knocked them down or drove them to it».
   */
  credit(attacker) {
    if (!attacker || attacker === this) return;
    this.lastAttacker = attacker;
    this.killCredit = T.killCreditTime;
  }

  eliminate() {
    if (!this.alive) return;
    this.alive = false;
    this.state = BodyState.Dead;
    this.deadTime = 0;
    this.deaths++;
    // A posthumous kill still counts: taking each other down is two kills.
    if (this.killCredit > 0 && this.lastAttacker) {
      this.lastAttacker.kills++;
      // The kill feed listens here — the one place every credited
      // knock-off passes through. main installs the listener.
      Fighter.onKill?.(this.lastAttacker, this);
    }
    this.lastAttacker = null;
    this.killCredit = 0;
    this.group.visible = false;
    this.marker.visible = false;
    this.trailPoints.length = 0;
  }

  /**
   * Есть ли у ЭТОГО бойца дубина. Слои: свой выбор бойца (armed — игрок
   * решает на экране персонажа, ботам выдаёт база), общая ручка withClub
   * выключает оружие всем, botsArmed — только ботам. Игрок с дубиной
   * против безоружных ботов (и наоборот) — легитимный способ играть.
   */
  get hasClub() {
    return T.withClub && this.armed && (this.isPlayer || T.botsArmed);
  }

  /**
   * Re-arm the fighter with the named look: skins are palettes, and some
   * of them are whole different HEADS (sledge block, axe blade). Rebuilds
   * the club meshes; the bone, grip and physics never change.
   */
  setClubSkin(name) {
    this.clubSkin = CLUB_SKINS[name] ? name : 'classic';
    this.buildClub();
  }

  /** (Re)build the weapon on the club bone for the current skin. */
  buildClub() {
    const skin = CLUB_SKINS[this.clubSkin] || CLUB_SKINS.classic;
    for (const m of [...this.bones.club.children]) {
      if (!m.isMesh) continue;
      m.geometry.dispose();
      this.bones.club.remove(m);
    }
    // Оружие в тон сцене: светлый ясень и матовый металл вместо тёмного
    // дерева с чёрным набалдашником — тёмная дубина была самым тёмным
    // пятном в кадре и перетягивала взгляд с бойца на себя.
    const wood = mat(new THREE.Color(skin.wood), skin.woodR);
    const metal = mat(new THREE.Color(skin.metal), skin.metalR, skin.metalM);
    const H = Rig.ClubHeadLocal;
    if (skin.head === 'bat') {
      // The bat: one smooth round taper instead of shaft-plus-head, a fat
      // tip and a taped grip. Same length, same hit point (ClubHeadLocal).
      addMesh(this.bones.club,
        new THREE.CylinderGeometry(0.085, 0.045, Rig.ClubLength + 0.14, 12, 1),
        wood, _v.set(0, 0.07, 0));
      sphere(this.bones.club, 0.085, wood,
        _v.set(0, Rig.ClubLength * 0.5 + 0.14, 0));
      addMesh(this.bones.club,
        new THREE.CylinderGeometry(0.052, 0.052, 0.16, 10, 1),
        metal, _v.set(0, -Rig.ClubLength * 0.4, 0));
      return;
    }
    capsule(this.bones.club, Rig.ClubRadius, Rig.ClubLength, wood);
    if (skin.head === 'maul') {
      // The sledge: one steel block across the shaft.
      box(this.bones.club, 0.34, 0.17, 0.17, H, metal);
    } else if (skin.head === 'drum') {
      // The mallet: a fat wooden drum across the shaft.
      const drum = addMesh(this.bones.club,
        new THREE.CylinderGeometry(0.13, 0.13, 0.3, 12, 1), metal, H);
      drum.rotation.z = Math.PI / 2;
    } else {
      // The classic: the spiked ball.
      sphere(this.bones.club, Rig.ClubHeadRadius, metal, H);
      for (let i = 0; i < 4; i++) {
        const angle = i * Math.PI * 0.5;
        const dir = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
        const spike = box(this.bones.club, 0.08, 0.08, 0.10,
          _v.copy(H).addScaledVector(dir, Rig.ClubHeadRadius), metal);
        spike.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      }
    }
  }

  /**
   * Repaint the fighter. Panel materials are SHARED between fighters of
   * the same color (see mat()), so they are never mutated — the meshes are
   * moved onto the materials of the new palette instead (applyParts walks
   * every colored mesh). Only the fighter's own thread, marker and trail
   * materials change in place.
   */
  setColor(hex) {
    this.color.set(hex);
    this.applyParts();
    this.thread.material.color.copy(this.color).lerp(new THREE.Color(0xfff6d8), 0.9);
    if (!this.isPlayer) this.marker.material.color.copy(this.color);
    this.trail.material.color.copy(this.color);
  }

  /** Re-cut one body part (head / torso / arms / legs) to the named
   *  shape. Unknown names fall back to classic. Pure cosmetics: the
   *  builders touch panels only, never bones or physics. */
  setPart(part, shapeName) {
    const set = SHAPE_SETS[part];
    if (!set) return;
    this.parts[part] = set[shapeName] ? shapeName : 'classic';
    if (part === 'head') {
      this.buildHead();
      // The face rides the head's surface — a new skull re-seats the eyes.
      this.buildEyes();
    } else if (part === 'torso') this.buildTorso();
    else if (part === 'arms') this.buildArms();
    else this.buildLegs();
  }

  /** Swap the face: rebuilds the eye boxes for the named style. */
  setEyes(styleName) {
    this.eyeStyle = EYE_STYLES[styleName] ? styleName : 'classic';
    this.buildEyes();
  }

  /** Move every colored panel onto the base color's material. */
  applyParts() {
    const m = mat(this.color, 0.95);
    for (const part of Object.keys(this.partMeshes)) {
      for (const mesh of this.partMeshes[part]) mesh.material = m;
    }
  }

  // ------------------------------------------------------------------ цикл

  tick(dt, controlEnabled) {
    if (this.state === BodyState.Dead) {
      this.deadTime += dt;
      return;
    }

    const body = this.body;
    this.updateStrength(dt);
    // Расшатка от тарана отпускает, как только напор прекратился.
    // Копится она в contact.js — ДО тика, поэтому при живом напоре
    // приход всегда обгоняет этот спад.
    this.stagger = Math.max(0, this.stagger - T.shoveStaggerDecay * dt);
    // The kill-credit window runs out on its own: shove somebody, let them
    // recover for a while, and their later stumble is not your kill.
    this.killCredit = Math.max(0, this.killCredit - dt);

    // Управление возвращается не мгновенно, а по мере того, как мышцы
    // снова начинают держать тело.
    const inControl = controlEnabled && body.strength > T.controlStrength;

    // No club is not "no strikes" anymore: the same machine runs the
    // punches, it just reads PUNCH_STYLES and drives the alternating fist
    // (poseDriver.overrideHands). The flag is synced every tick — the
    // club toggles live.
    this.swing.fists = !this.hasClub;
    this.swing.held = inControl && this.swing.held;

    // Stamina. A new strike must be affordable BEFORE the windup starts —
    // player and bot alike get their held wish silently dropped when the
    // pool is dry; the charge lands at the moment the windup begins.
    // The block drain and the dash cost live with their verbs (main.js).
    this.staminaWait = Math.max(0, this.staminaWait - dt);
    const strikeCost = this.hasClub ? T.staminaClubCost : T.staminaPunchCost;
    if (T.staminaOn && this.swing.state === 'guard' && this.swing.held
        && this.stamina < strikeCost) {
      this.swing.held = false;
      this.swing.castNow = false;
    }
    this.swing.tick(dt);
    if (T.staminaOn) {
      if (this.swing.state === 'windup' && this._swingWas !== 'windup') {
        this.stamina = Math.max(0, this.stamina - strikeCost);
        this.staminaWait = T.staminaDelay;
      }
      const busy = this.blocking
        || this.swing.state === 'windup' || this.swing.state === 'strike';
      if (this.blocking) {
        this.stamina = Math.max(0, this.stamina - T.staminaBlockDrain * dt);
      } else if (!busy && this.staminaWait <= 0) {
        this.stamina = Math.min(1, this.stamina + T.staminaRegen * dt);
      }
    } else {
      this.stamina = 1;
    }
    this._swingWas = this.swing.state;
    this.bones.club.visible = this.hasClub;
    // Телу тоже: без дубины набалдашник почти невесом и ничего не тянет.
    body.clubOn = this.hasClub;
    // Равновесие считается ДО локомоции: она подмешивает его поправку
    // в скорость ядра, а походка — его направление падения в шаг.
    this.balance.tick(dt, this.locomotion.grounded);
    this.locomotion.tick(dt, inControl);

    const pose = this.poseDriver.tick(dt, this.locomotion.planarSpeed,
      this.locomotion.grounded);

    if (this.locomotion.kinematic) {
      // Корень ведёт ввод, а не физика: таз ставится туда, куда его увела
      // локомоция, поза раскладывается от него, и частицы садятся ровно
      // в свои цели. Физика при этом никуда не девается — она подхватит
      // тело из этой самой позы, как только мышцы отпустят.
      const base = this.arena.isOverDeck(this.position.x, this.position.z, 0.4)
        ? 0 : this.position.y;
      body.placeHips(this.position.x, base + Rig.HipsY, this.position.z);
      body.setTargets(pose, this.yaw);
      body.snap();
      // Заступил за кромку — опоры нет, и держаться больше не на чем.
      if (!this.arena.isOverDeck(this.position.x, this.position.z, 0.1)) {
        body.strength = 0;
        this.downTime = 0;
        this.settleTime = 0;
      }
    } else {
      body.setTargets(pose, this.yaw);
      body.step(dt);
      this.slipOffLedge(dt);
      // Встающий держится за настил, а не скользит по нему. Пока мышцы
      // на нуле (только что сбили, летит) — никакого хвата: отбрасывание
      // должно долетать. Хват включается вместе с первыми процентами силы,
      // то есть ровно тогда, когда тело начало подниматься.
      if (body.strength > 0.02 && body.touchesDeck()) {
        body.dampPlanar(T.riseGrip, dt);
      }
    }
    body.writeBones(this.bones, this.poseDriver.headTurn, this.poseDriver.lookPitch);
    this.updateThread();

    // Позиция бойца — проекция таза на землю. При физическом теле она
    // следствие физики; при кинематическом её ведёт локомоция, и обратно
    // читать нечего.
    if (!this.locomotion.kinematic) {
      const hips = body.pos[P.Hips];
      this.position.set(hips.x, hips.y - Rig.HipsY, hips.z);
    }

    if (body.lowestY() < T.killY) {
      this.eliminate();
      return;
    }

    this.group.updateMatrixWorld(true);
    this.updateClubHead(dt, false);
    this.updateMarker();
    this.updateTrail();
  }

  /**
   * Сползание с кромки.
   *
   * Тело, легшее поперёк края тазом в пустоту, держится тем, что осталось
   * на настиле, и держится УСТОЙЧИВО: разрешаться там нечему, и оно висит
   * так сколько угодно — замерено, два падения из шести не кончались ничем
   * за восемнадцать секунд. Ни встать (таз в воздухе), ни упасть.
   *
   * Висеть тазом за краем — не равновесие, а вопрос секунды, поэтому
   * тело подталкивается НАРУЖУ и вниз, пока таз под диском. Это не
   * «убить упавшего»: пока таз над настилом, толчка нет вовсе, и боец,
   * свесивший ногу, спокойно встаёт.
   */
  slipOffLedge(dt) {
    const body = this.body;
    if (!body.underDeck[P.Hips]) return;
    // Только пока тело ещё ЛЕЖИТ на кромке. Свободно падающему помогать
    // незачем, а помощь эта копится: толчок, приложенный на всю длину
    // полёта, разгонял сбитого вбок и уносил на 26 метров от центра
    // вместо четырнадцати.
    if (!body.touchesDeck()) return;
    const hips = body.pos[P.Hips];
    const len = Math.hypot(hips.x, hips.z) || 1;
    // ledgeSlip — УСКОРЕНИЕ, поэтому домножается на dt здесь.
    //
    // pushAll принимает изменение скорости и целиком выдаёт его за один
    // вызов: так и надо удару, который случается однажды. Сползание же
    // зовётся каждый шаг физики, и без dt оно выдавало 7 м/с по 120 раз
    // в секунду. Замерено покадрово: тело сходило с кромки на 4.6 м/с,
    // а через семь шагов физики летело 33.8 — «резко улетает» вместо
    // плавного падения. С dt это те же честные 7 м/с².
    const k = T.ledgeSlip * dt;
    _impulse.set(hips.x / len * k, -k * 0.5, hips.z / len * k);
    body.pushAll(_impulse, dt);
  }

  /**
   * Восстановление силы мышц. Оно же — подъём с земли.
   *
   * Отдельного вставания больше нет и не нужно: мышцы наливаются силой,
   * цель у них по-прежнему «стоять», и тело поднимает себя само. Прежняя
   * схема запоминала позу, переносила корень, пересчитывала локальные
   * координаты и интерполировала — всё это здесь просто не требуется.
   */
  updateStrength(dt) {
    const body = this.body;

    // Сорвался с настила — держать позу нечем. Без этого боец уезжал
    // за кромку стоя по стойке смирно и так же, не сгибаясь, падал вниз.
    //
    // Опора здесь — ЛЮБАЯ, а не только под ногами. Стоящему хватает стоп,
    // а лежачий опирается спиной и плечом, и у кромки ноги у него свешены
    // за край. По одним стопам такое тело считалось висящим в воздухе,
    // мышцы отпускались насовсем, а таймеры подъёма сбрасывались каждый
    // кадр — боец лежал на арене и не вставал никогда. Это и есть
    // «забаговался и не встал».
    const supported = this.locomotion.grounded || body.touchesDeck();
    this.airTime = supported ? 0 : this.airTime + dt;
    if (this.airTime > T.airReleaseTime) {
      body.strength = Math.max(0, body.strength - dt / 0.25);
      this.downTime = 0;
      this.settleTime = 0;
    }

    if (body.strength >= 1) {
      this.state = BodyState.Standing;
      this.settleTime = 0;
      return;
    }

    this.downTime += dt;
    const hips = body.pos[P.Hips];
    // Встать можно там, где под телом есть настил и таз ещё над ареной.
    // Прежняя проверка требовала от таза двадцати сантиметров ЗАПАСА
    // внутрь — и внешнее кольцо арены становилось полосой, в которой
    // упавший не поднимался вовсе. Ровно там боец обычно и падает.
    //
    // И КОРПУС не должен свисать под диск. Подъём переставляет таз в стойку
    // одним кадром, и висящее в пустоте он выдёргивает наверх вместе со всем
    // телом: замерено, рывок таза на 41 см при теле на 1.84 м ниже настила.
    // Ушёл за край тазом — падай, а не возвращайся в стойку.
    //
    // Ногу при этом свесить можно: запрет по ЛЮБОЙ частице кончался хуже
    // самого бага — тело, зацепившееся за кромку одной ногой, не вставало
    // и не падало вовсе, два случая из шести висели так весь замер.
    const onDeck = supported && !body.coreUnderDeck()
      && this.arena.isOverDeck(hips.x, hips.z);
    const calm = onDeck && body.speed(dt) < T.settleSpeed;
    this.settleTime = calm ? this.settleTime + dt : 0;

    // Таймаут — страховка от тела, застрявшего в бесконечном мелком дрожании.
    if (onDeck && (this.settleTime >= T.standUpSettle || this.downTime >= T.standUpTimeout)) {
      body.strength = Math.min(1, body.strength + dt / Math.max(0.05, T.standUpTime));
    }

    this.state = body.strength > T.controlStrength
      ? BodyState.Standing
      : BodyState.Downed;
  }

  /**
   * Скорость набалдашника. Раньше она вычислялась по смещению кости, потому
   * что кость была кинематической и своей скорости не имела. Теперь
   * набалдашник — настоящая частица, и это её честная скорость.
   */
  updateClubHead(dt, snap) {
    const tip = this.body.pos[P.ClubTip];
    if (snap) {
      this.clubHead.copy(tip);
      this.clubHeadPrev.copy(tip);
      this.fistR.copy(this.body.pos[P.HandR]);
      this.fistRPrev.copy(this.fistR);
      this.fistL.copy(this.body.pos[P.HandL]);
      this.fistLPrev.copy(this.fistL);
      this.swingSpeed = 0;
      this.fistSpeedR = 0;
      this.fistSpeedL = 0;
    } else {
      this.clubHeadPrev.copy(this.clubHead);
      this.clubHead.copy(tip);
      this.swingSpeed = this.clubHeadPrev.distanceTo(this.clubHead) / Math.max(1e-5, dt);
      // Both fists are tracked the same way: punches alternate hands, and
      // the swept segment must come from the fist that actually flew.
      this.fistRPrev.copy(this.fistR);
      this.fistR.copy(this.body.pos[P.HandR]);
      this.fistSpeedR = this.fistRPrev.distanceTo(this.fistR) / Math.max(1e-5, dt);
      this.fistLPrev.copy(this.fistL);
      this.fistL.copy(this.body.pos[P.HandL]);
      this.fistSpeedL = this.fistLPrev.distanceTo(this.fistL) / Math.max(1e-5, dt);
    }
    // Хват — вторая точка «лезвия»: в упор попадают древком, а не шаром.
    this.clubGrip.copy(this.body.pos[P.HandR]);
  }

  updateMarker() {
    this.marker.position.set(this.position.x, 0.012, this.position.z);
    // Метка гаснет, когда боец не на настиле: по ней же читается «сорвался».
    const over = this.arena.isOverDeck(this.position.x, this.position.z);
    this.marker.visible = !!T.showMarkers && over && this.state !== BodyState.Dead;
  }

  updateTrail() {
    const on = T.withClub && T.showClubTrail && this.state !== BodyState.Dead;
    this.trail.visible = on;
    if (!on) return;

    this.trailPoints.push(this.clubHead.clone());
    while (this.trailPoints.length > TRAIL_POINTS) this.trailPoints.shift();

    const attr = this.trail.geometry.getAttribute('position');
    const arr = attr.array;
    for (let i = 0; i < TRAIL_POINTS; i++) {
      // Недостающие точки прижимаются к самой старой: иначе хвост тянется
      // из нуля координат через всю арену.
      const p = this.trailPoints[Math.max(0, i - (TRAIL_POINTS - this.trailPoints.length))]
        || this.trailPoints[0] || this.clubHead;
      arr[i * 3] = p.x;
      arr[i * 3 + 1] = p.y;
      arr[i * 3 + 2] = p.z;
    }
    attr.needsUpdate = true;
    this.trail.material.opacity = this.swing.striking ? 0.85 : 0.2;
  }

  // ----------------------------------------------------------------- удары

  /**
   * Превращает касание дубины в толчок. Ни урона, ни здоровья в игре нет —
   * удар выдаёт только импульс, а проигрывает тот, кого этим импульсом
   * в итоге вынесло за край.
   *
   * Проверка идёт по отрезку, который набалдашник прошёл за кадр, а не по его
   * положению: на полном проносе шар за кадр пролетает больше собственного
   * диаметра и точечная проверка просто прошла бы сквозь соперника.
   */
  checkHits(others, dt, now, onHit) {
    if (!this.alive || !this.swing.striking) return;

    // Fists are a shorter, softer blade: one swept point instead of a
    // shaft, tighter reach, and their own speed scale — a fist tops out
    // far below a club head on a full sweep.
    const fists = !this.hasClub;
    const right = this.swing.hand >= 0;
    const tip = fists ? (right ? this.fistR : this.fistL) : this.clubHead;
    const tipPrev = fists ? (right ? this.fistRPrev : this.fistLPrev) : this.clubHeadPrev;
    const speed = fists ? (right ? this.fistSpeedR : this.fistSpeedL) : this.swingSpeed;
    const minSpeed = fists ? T.punchMinSpeed : T.minImpactSpeed;
    const maxSpeed = fists ? T.punchMaxSpeed : T.maxImpactSpeed;
    if (speed < minSpeed) return;

    for (const victim of others) {
      if (victim === this || !victim.alive) continue;

      const last = this.lastHit.get(victim.id);
      if (last !== undefined && now - last < T.hitCooldown) continue;

      victim.torsoSegment(_a, _b);
      const reach = fists ? 0.34 : Rig.ClubHeadRadius + 0.30;

      const swept = segmentDistance(tipPrev, tip, _a, _b);
      const shaft = fists ? swept : segmentDistance(this.clubGrip, this.clubHead, _a, _b);
      if (Math.min(swept, shaft) > reach) continue;

      this.lastHit.set(victim.id, now);

      const strength = inverseLerp(minSpeed, maxSpeed, speed)
        * this.swing.power;

      // Блок: удар не роняет, а отталкивает. Толчок уходит в скорость
      // ЛОКОМОЦИИ, а не в частицы: стоящий боец кинематичен, его тело
      // и так сядет в позу, — он просто отъезжает назад, оставаясь
      // на ногах. Лёгкая расшатка остаётся: блок держит, но не бесплатен.
      if (victim.blocking) {
        _impulse.copy(victim.position).sub(this.position);
        _impulse.y = 0;
        if (_impulse.lengthSq() < 1e-4) _impulse.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        _impulse.normalize();
        const push = T.blockPushback * (0.5 + 0.5 * clamp01(strength));
        victim.locomotion.shove(_impulse.x * push, _impulse.z * push);
        victim.stagger = Math.min(0.75, victim.stagger + 0.2);
        victim.staggerDirX = _impulse.x;
        victim.staggerDirZ = _impulse.z;
        // Catching a blow on the shell costs the BLOCKER stamina on top
        // of the hold drain — turtling under fire runs out fast, and an
        // empty pool drops the shell (the block-broken latch in main).
        // The hit also resets the regen delay: no sipping between blows.
        if (T.staminaOn) {
          victim.stamina = Math.max(0, victim.stamina
            - T.staminaBlockHit * (0.6 + 0.4 * clamp01(strength)));
          victim.staminaWait = Math.max(victim.staminaWait, T.staminaDelay);
        }
        victim.credit(this);
        if (onHit) onHit(this, victim, tip, clamp01(strength) * 0.5, true);
        continue;
      }

      // The style shapes the hit: the rising scoop launches upward, the
      // overhead slam hits flatter and harder. Punches carry their own
      // set with the same slots. See SWING_STYLES / PUNCH_STYLES.
      const st = this.swing.style;

      _impulse.copy(victim.position).sub(this.position);
      _impulse.y = 0;
      if (_impulse.lengthSq() < 1e-4) _impulse.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      _impulse.normalize();
      _impulse.y = T.knockUpBias * (st.up || 1);
      _impulse.normalize();

      const power = lerp(T.minKnockback, T.maxKnockback, clamp01(strength)) * (st.pow || 1);
      _impulse.multiplyScalar(power);

      // Куда именно пришёлся удар, разберём в отдельной итерации.
      // Пока импульс прикладывается всему телу целиком.
      victim.takeHit(_impulse, dt);
      victim.credit(this);
      victim.lastImpactSpeed = speed;
      victim.lastImpactPower = strength;

      if (onHit) onHit(this, victim, tip, clamp01(strength));
    }
  }

  /** Отрезок корпуса — по нему и проверяется попадание. */
  torsoSegment(outA, outB) {
    outA.copy(this.body.pos[P.Hips]);
    outB.copy(this.body.pos[P.Head]);
  }

  get facingDegrees() { return this.yaw * RAD; }

  dispose() {
    this.scene.remove(this.group);
    this.scene.remove(this.marker);
    this.scene.remove(this.trail);
  }
}

// ------------------------------------------------------------- вспомогательное

const _sharedMaterials = new Map();

/**
 * Картонная панель: трапеция, вытянутая по локальной оси Y.
 *
 * Строится четырёхгранным «цилиндром» — он и есть коробка с разной шириной
 * на концах. Отдельной геометрии писать не пришлось: у цилиндра с четырьмя
 * сегментами грани ровно те же, что у коробки, а разные радиусы сверху
 * и снизу дают трапецию даром.
 *
 * @param {number} bottom ширина широкого конца (у ближнего сустава)
 * @param {number} top    ширина узкого конца
 * @param {number} depth  толщина листа; по ней панель и читается картоном
 */
function panel(parent, length, bottom, top, depth, material, offset) {
  // Защита от пропавшей настройки. Потерянное число приходит сюда как NaN,
  // а NaN в геометрии — это не ошибка в консоли, а молча исчезнувшая деталь:
  // ровно так пропали разом все панели, когда partGap не доехал до tuning.
  if (!Number.isFinite(length) || !Number.isFinite(bottom) ||
      !Number.isFinite(top) || !Number.isFinite(depth)) {
    console.warn('panel: non-numeric size', { length, bottom, top, depth });
    length = Number.isFinite(length) ? length : 0.2;
    bottom = Number.isFinite(bottom) ? bottom : 0.1;
    top = Number.isFinite(top) ? top : 0.1;
    depth = Number.isFinite(depth) ? depth : 0.1;
  }
  const g = new THREE.CylinderGeometry(
    top * 0.5 * Math.SQRT2, bottom * 0.5 * Math.SQRT2, length, 4, 1);
  // Развернуть, чтобы грани смотрели вдоль осей, а не рёбра.
  g.rotateY(Math.PI / 4);
  g.scale(1, 1, depth / Math.max(0.001, bottom));
  return addMesh(parent, g, material, offset);
}

function mat(color, roughness, metalness = 0.05) {
  const key = color.getHex() + '|' + roughness + '|' + metalness;
  let m = _sharedMaterials.get(key);
  if (!m) {
    // Плоские грани без сглаживания: картон не бликует округло.
    m = new THREE.MeshStandardMaterial({ color, roughness, metalness, flatShading: true });
    _sharedMaterials.set(key, m);
  }
  return m;
}

function addMesh(parent, geometry, material, offset) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  if (offset) mesh.position.copy(offset);
  parent.add(mesh);
  return mesh;
}

function capsule(parent, radius, height, material) {
  // В three длина капсулы — только цилиндрическая часть, в Unity height
  // включала полусферы. Отсюда вычитание.
  const body = Math.max(0.001, height - radius * 2);
  return addMesh(parent, new THREE.CapsuleGeometry(radius, body, 6, 12), material);
}

function sphere(parent, radius, material, offset) {
  return addMesh(parent, new THREE.SphereGeometry(radius, 18, 12), material, offset);
}

function box(parent, x, y, z, offset, material) {
  return addMesh(parent, new THREE.BoxGeometry(x, y, z), material, offset);
}

/** Кратчайшее расстояние между двумя отрезками. */
function segmentDistance(p1, q1, p2, q2) {
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
  const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z;

  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;

  let s = 0, t = 0;
  if (a <= 1e-9 && e <= 1e-9) {
    return Math.hypot(rx, ry, rz);
  }
  if (a <= 1e-9) {
    t = clamp01(f / e);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-9) {
      s = clamp01(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > 1e-9 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }

  const cx = p1.x + d1x * s - (p2.x + d2x * t);
  const cy = p1.y + d1y * s - (p2.y + d2y * t);
  const cz = p1.z + d1z * s - (p2.z + d2z * t);
  return Math.hypot(cx, cy, cz);
}
