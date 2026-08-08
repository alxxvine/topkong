import * as THREE from 'three';
import { tuning as T } from 'tk/tuning.js';
import { clamp01, inverseLerp, lerp, RAD } from 'tk/mathx.js';
import * as Rig from 'tk/fighterRig.js';
import { PoseDriver } from 'tk/poseDriver.js';
import { Gait } from 'tk/gait.js';
import { buildSkin } from 'tk/skin.js';
import { SwingAction } from 'tk/swingAction.js';
import { Locomotion } from 'tk/locomotion.js';
import { Body, P, restPoints } from 'tk/body.js';

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

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _impulse = new THREE.Vector3();
const AXIS_Y = new THREE.Vector3(0, 1, 0);

let nextId = 1;

// Кости оболочки. Порядок фиксирован: по нему считаются skinIndex вершин
// и опорные матрицы, так что менять его нельзя, не пересобрав и то и другое.
const BONE_ORDER = [
  'hips', 'chest', 'head',
  'legLUpper', 'legLLower', 'legRUpper', 'legRLower',
  'footL', 'footR',
  'armRUpper', 'armRFore', 'armLUpper', 'armLFore',
];
const BONE = {};
BONE_ORDER.forEach((n, i) => { BONE[n] = i; });

let _skin = null;
let _inverses = null;

/**
 * Собрать оболочку и опорные матрицы. Делается ОДИН раз на всю игру:
 * геометрия у всех бойцов общая, разная только краска.
 *
 * Опорная поза берётся не из формул повторно, а из настоящего тела,
 * поставленного в стойку, и кости раскладываются тем же writeBones,
 * что работает в игре. Иначе привязка вершин и работа кости считались бы
 * по двум разным представлениям одной позы, и оболочку бы перекосило.
 */
function prepareSkin() {
  const body = new Body({ isOverDeck: () => true });
  body.reset(0, 0, 0);

  const root = new THREE.Object3D();
  const bones = {};
  for (const name of BONE_ORDER) {
    bones[name] = new THREE.Bone();
    root.add(bones[name]);
  }
  bones.club = new THREE.Bone();
  root.add(bones.club);
  body.writeBones(bones, 0);
  root.updateMatrixWorld(true);

  _inverses = BONE_ORDER.map((n) => bones[n].matrixWorld.clone().invert());

  const p = body.pos;
  const mid = p[P.Hips].clone().lerp(p[P.Chest], 0.5);
  const toeL = p[P.FootL].clone().add(new THREE.Vector3(0, -0.02, 0.11));
  const toeR = p[P.FootR].clone().add(new THREE.Vector3(0, -0.02, 0.11));

  _skin = buildSkin([
    // Таз и корпус. Разбиты на две части не для красоты: будь торс одной
    // капсулой, он был бы привязан к одной кости и не гнулся бы в поясе.
    { a: p[P.HipL], b: p[P.HipR], r: Rig.HipsRadius, bone: BONE.hips },
    { a: p[P.Hips], b: mid, r: Rig.TorsoRadius * 0.86, bone: BONE.hips },
    { a: mid, b: p[P.Chest], r: Rig.TorsoRadius, bone: BONE.chest },
    { a: p[P.ShoulderL], b: p[P.ShoulderR], r: Rig.TorsoRadius * 0.68, bone: BONE.chest },
    // Шея принадлежит груди, голова — своей кости: иначе она мотается
    // отдельным шаром или, наоборот, не поворачивается вовсе.
    { a: p[P.Chest], b: p[P.Head], r: 0.085, bone: BONE.chest },
    { a: p[P.Head], b: p[P.Head], r: Rig.HeadRadius, bone: BONE.head },

    { a: p[P.HipL], b: p[P.KneeL], r: Rig.LegRadius, bone: BONE.legLUpper },
    { a: p[P.KneeL], b: p[P.FootL], r: Rig.LegRadius * 0.86, bone: BONE.legLLower },
    { a: p[P.HipR], b: p[P.KneeR], r: Rig.LegRadius, bone: BONE.legRUpper },
    { a: p[P.KneeR], b: p[P.FootR], r: Rig.LegRadius * 0.86, bone: BONE.legRLower },
    { a: p[P.FootL], b: toeL, r: Rig.FootRadius, bone: BONE.footL },
    { a: p[P.FootR], b: toeR, r: Rig.FootRadius, bone: BONE.footR },

    { a: p[P.ShoulderR], b: p[P.ElbowR], r: Rig.ArmRadius, bone: BONE.armRUpper },
    { a: p[P.ElbowR], b: p[P.HandR], r: Rig.ArmRadius * 0.92, bone: BONE.armRFore },
    { a: p[P.ShoulderL], b: p[P.ElbowL], r: Rig.ArmRadius, bone: BONE.armLUpper },
    { a: p[P.ElbowL], b: p[P.HandL], r: Rig.ArmRadius * 0.92, bone: BONE.armLFore },
  ]);
}

function sharedSkin() {
  if (!_skin) prepareSkin();
  return _skin;
}

function restInverses() {
  if (!_inverses) prepareSkin();
  return _inverses;
}

export class Fighter {
  constructor(scene, arena, options = {}) {
    this.id = nextId++;
    this.scene = scene;
    this.arena = arena;
    this.name = options.name || ('F' + this.id);
    this.isPlayer = !!options.isPlayer;
    this.color = new THREE.Color(options.color !== undefined ? options.color : 0xe0a267);

    this.position = new THREE.Vector3();
    this.yaw = 0;
    this.moveInput = new THREE.Vector2();
    this.facingTarget = new THREE.Vector3(0, 0, 1);

    this.group = new THREE.Group();
    scene.add(this.group);

    this.bones = {};
    this.build();

    this.swing = new SwingAction();
    this.poseDriver = new PoseDriver(this);
    this.locomotion = new Locomotion(this, arena);
    this.body = new Body(arena);
    // Походка держит мировые опоры стоп. Создаётся после тела не случайно:
    // на спавне она втыкает стопы туда, где тело уже стоит.
    this.gait = new Gait(this, arena);

    this.state = BodyState.Standing;
    this.alive = true;

    this.downTime = 0;
    this.settleTime = 0;
    this.airTime = 0;
    this.deadTime = 0;

    // Скорость набалдашника меряется по смещению за кадр: кость кинематическая,
    // собственной скорости у неё нет вовсе.
    this.clubHead = new THREE.Vector3();
    this.clubHeadPrev = new THREE.Vector3();
    this.clubGrip = new THREE.Vector3();
    this.swingSpeed = 0;
    this.lastHit = new Map();

    this.lastImpactSpeed = 0;
    this.lastImpactPower = 0;

    this.spawn(options.x || 0, options.z || 0, options.yaw || 0);
  }

  // ---------------------------------------------------------------- сборка

  build() {
    const skin = mat(this.color, 0.62);
    const wood = mat(new THREE.Color(0x5c3d21), 0.85);
    const metal = mat(new THREE.Color(0x9ea3ad), 0.32, 0.75);

    // Тело — ОДНА бесшовная оболочка, натянутая на кости скиннингом.
    //
    // Из капсул бесшовное тело не собирается в принципе: на пересечении двух
    // выпуклых форм всегда остаётся складка, и чем сильнее согнут сустав, тем
    // она заметнее. Шар в суставе прячет щель, но стык всё равно читается.
    // Поэтому поверхность строится из общего поля расстояний со сглаженным
    // объединением и вытаскивается один раз на всю игру — см. skin.js.
    for (const name of BONE_ORDER) this.bones[name] = this.bone(name);

    const mesh = new THREE.SkinnedMesh(sharedSkin(), skin);
    mesh.castShadow = true;
    // Геометрия лежит в опорной позе, а рисуется согнутой: считать по ней
    // видимость нельзя, боец пропадал бы с экрана в самых интересных позах.
    mesh.frustumCulled = false;
    this.group.add(mesh);
    // Матрица привязки передаётся ЯВНО, и это не формальность. Без второго
    // аргумента three.js вызывает skeleton.calculateInverses() и пересчитывает
    // опорные матрицы по текущему положению костей — а на сборке они ещё
    // стоят в нуле. Наши, снятые в настоящей опорной стойке, затирались
    // единичными, и оболочку рвало в клочья.
    mesh.bind(
      new THREE.Skeleton(BONE_ORDER.map((n) => this.bones[n]), restInverses()),
      new THREE.Matrix4());
    this.skinMesh = mesh;

    // Кости-пустышки: у них нет собственных мешей, они только гнут оболочку.
    // Исключение — дубина, она отдельный предмет, а не часть тела.
    this.bones.club = this.bone('club');
    capsule(this.bones.club, Rig.ClubRadius, Rig.ClubLength, wood);
    sphere(this.bones.club, Rig.ClubHeadRadius, metal, Rig.ClubHeadLocal);
    for (let i = 0; i < 4; i++) {
      const angle = i * Math.PI * 0.5;
      const dir = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
      const spike = box(this.bones.club, 0.08, 0.08, 0.10,
        _v.copy(Rig.ClubHeadLocal).addScaledVector(dir, Rig.ClubHeadRadius), metal);
      spike.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    }

    this.buildMarker();
    this.buildTrail();
  }

  bone(name) {
    const g = new THREE.Bone();
    g.name = name;
    this.group.add(g);
    return g;
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
    this.swingSpeed = 0;
    this.lastHit.clear();
    this.trailPoints.length = 0;

    this.swing.reset();
    this.poseDriver.reset();
    this.locomotion.reset();
    this.body.reset(x, z, yaw);
    this.gait.reset(x, z, yaw);

    // Группа бойца стоит в нуле навсегда: кости пишутся мировыми координатами
    // прямо из частиц. Именно переключение группы между двумя системами
    // отсчёта и порождало кадр с телом в центре арены.
    this.group.position.set(0, 0, 0);
    this.group.quaternion.identity();
    this.group.visible = true;
    this.marker.visible = true;

    // Разложить кости сразу, иначе первый кадр рисует позу с прошлой жизни.
    this.poseDriver.tick(1 / 120, 0, true);
    this.body.setTargets(this.poseDriver.pose, yaw);
    this.body.writeBones(this.bones, this.poseDriver.headTurn);
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

  eliminate() {
    if (!this.alive) return;
    this.alive = false;
    this.state = BodyState.Dead;
    this.deadTime = 0;
    this.group.visible = false;
    this.marker.visible = false;
    this.trailPoints.length = 0;
  }

  // ------------------------------------------------------------------ цикл

  tick(dt, controlEnabled) {
    if (this.state === BodyState.Dead) {
      this.deadTime += dt;
      return;
    }

    const body = this.body;
    this.updateStrength(dt);

    // Управление возвращается не мгновенно, а по мере того, как мышцы
    // снова начинают держать тело.
    const inControl = controlEnabled && body.strength > T.controlStrength;

    // Без дубины бить нечем: замах не считается вовсе, иначе боец
    // размахивает пустой рукой и портит замер походки.
    this.swing.held = inControl && this.swing.held && T.withClub;
    if (T.withClub) this.swing.tick(dt);
    else this.swing.reset();
    this.bones.club.visible = T.withClub;
    this.locomotion.tick(dt, inControl);

    const pose = this.poseDriver.tick(dt, this.locomotion.planarSpeed,
      this.locomotion.grounded);

    body.setTargets(pose, this.yaw);
    body.step(dt);
    body.writeBones(this.bones, this.poseDriver.headTurn);

    // Позиция бойца — проекция таза на землю. Она следствие физики,
    // а не то, что ей задают.
    const hips = body.pos[P.Hips];
    this.position.set(hips.x, hips.y - Rig.HipsY, hips.z);

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
    this.airTime = this.locomotion.grounded ? 0 : this.airTime + dt;
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
    const onDeck = this.arena.isOverDeck(hips.x, hips.z, -0.2);
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
      this.swingSpeed = 0;
    } else {
      this.clubHeadPrev.copy(this.clubHead);
      this.clubHead.copy(tip);
      this.swingSpeed = this.clubHeadPrev.distanceTo(this.clubHead) / Math.max(1e-5, dt);
    }
    // Хват — вторая точка «лезвия»: в упор попадают древком, а не шаром.
    this.clubGrip.copy(this.body.pos[P.HandR]);
  }

  updateMarker() {
    this.marker.position.set(this.position.x, 0.012, this.position.z);
    // Метка гаснет, когда боец не на настиле: по ней же читается «сорвался».
    const over = this.arena.isOverDeck(this.position.x, this.position.z);
    this.marker.visible = over && this.state !== BodyState.Dead;
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
    if (!T.withClub) return;
    if (!this.alive || !this.swing.striking) return;
    if (this.swingSpeed < T.minImpactSpeed) return;

    for (const victim of others) {
      if (victim === this || !victim.alive) continue;

      const last = this.lastHit.get(victim.id);
      if (last !== undefined && now - last < T.hitCooldown) continue;

      victim.torsoSegment(_a, _b);
      const reach = Rig.ClubHeadRadius + 0.30;

      const swept = segmentDistance(this.clubHeadPrev, this.clubHead, _a, _b);
      const shaft = segmentDistance(this.clubGrip, this.clubHead, _a, _b);
      if (Math.min(swept, shaft) > reach) continue;

      this.lastHit.set(victim.id, now);

      const strength = inverseLerp(T.minImpactSpeed, T.maxImpactSpeed, this.swingSpeed)
        * this.swing.power;

      _impulse.copy(victim.position).sub(this.position);
      _impulse.y = 0;
      if (_impulse.lengthSq() < 1e-4) _impulse.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      _impulse.normalize();
      _impulse.y = T.knockUpBias;
      _impulse.normalize();

      const power = lerp(T.minKnockback, T.maxKnockback, clamp01(strength));
      _impulse.multiplyScalar(power);

      // Куда именно пришёлся удар, разберём в отдельной итерации.
      // Пока импульс прикладывается всему телу целиком.
      victim.takeHit(_impulse, dt);
      victim.lastImpactSpeed = this.swingSpeed;
      victim.lastImpactPower = strength;

      if (onHit) onHit(this, victim, this.clubHead, clamp01(strength));
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

function mat(color, roughness, metalness = 0.05) {
  const key = color.getHex() + '|' + roughness + '|' + metalness;
  let m = _sharedMaterials.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
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
