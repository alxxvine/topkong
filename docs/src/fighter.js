import * as THREE from 'three';
import { tuning as T } from 'tk/tuning.js';
import { clamp01, inverseLerp, lerp, RAD } from 'tk/mathx.js';
import * as Rig from 'tk/fighterRig.js';
import { PoseDriver } from 'tk/poseDriver.js';
import { Gait } from 'tk/gait.js';
import { SwingAction } from 'tk/swingAction.js';
import { Locomotion } from 'tk/locomotion.js';
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
    const card = mat(this.color, 0.95);
    const dark = mat(this.color.clone().lerp(new THREE.Color(0x000000), 0.55), 0.95);
    const ink = mat(new THREE.Color(0x241a12), 0.9);
    const wood = mat(new THREE.Color(0x5c3d21), 0.85);
    const metal = mat(new THREE.Color(0x9ea3ad), 0.32, 0.75);

    // Тело — картонная кукла строго по выкройке: голова 5x5, грудь трапеция
    // 2 сверху и 3 снизу, таз квадрат 3x3, рука 6, нога 8. Стоп нет вовсе,
    // нога цельная деталь. Панели расширяются к дальнему концу, а не
    // к суставу, — от этого и весь силуэт.
    const D = Rig.PanelDepth;

    this.bones.hips = this.bone('hips');
    panel(this.bones.hips, Rig.HipsSize, Rig.HipsSize, Rig.HipsSize, D * 2, card);

    this.bones.chest = this.bone('chest');
    panel(this.bones.chest, Rig.ChestHeight,
      Rig.ChestBottomWidth, Rig.ChestTopWidth, D * 2, card);

    this.bones.head = this.bone('head');
    box(this.bones.head, Rig.HeadSize, Rig.HeadSize, Rig.HeadSize * 0.85, null, card);
    for (const side of [-1, 1]) {
      const eye = box(this.bones.head, Rig.HeadSize * 0.16, Rig.HeadSize * 0.24, 0.02,
        new THREE.Vector3(side * Rig.HeadSize * 0.2, Rig.HeadSize * 0.05,
          Rig.HeadSize * 0.43), ink);
      eye.rotation.z = side * 0.1;
    }

    // Нога и рука — по одной трапеции на всю длину. Узкий конец у сустава,
    // широкий на воле: 2 у бедра и 3 внизу, 2 у плеча и 3 у кисти.
    for (const name of ['legLUpper', 'legRUpper']) {
      this.bones[name] = this.limbPanel(name, Rig.LegLength,
        Rig.LegTopWidth, Rig.LegBottomWidth, D * 1.4);
    }
    this.bones.legLLower = this.bone('legLLower');
    this.bones.legRLower = this.bone('legRLower');
    // Стоп на выкройке нет: кости оставлены пустыми, физике они ещё нужны.
    this.bones.footL = this.bone('footL');
    this.bones.footR = this.bone('footR');

    for (const name of ['armRUpper', 'armLUpper']) {
      this.bones[name] = this.limbPanel(name, Rig.ArmLength,
        Rig.ArmTopWidth, Rig.ArmBottomWidth, D);
    }
    this.bones.armRFore = this.bone('armRFore');
    this.bones.armLFore = this.bone('armLFore');

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

    this.buildThread();
    this.buildMarker();
    this.buildTrail();
  }

  bone(name) {
    const g = new THREE.Group();
    g.name = name;
    this.group.add(g);
    return g;
  }

  /**
   * Звено конечности: трапеция от сустава к суставу.
   *
   * Локальная +Y кости смотрит на дальний сустав, поэтому широкий конец
   * панели внизу, узкий вверху — как на чертеже выкройки.
   */
  limbPanel(name, length, nearWidth, farWidth, depth) {
    const g = this.bone(name);
    // Панель короче своей кости на зазор с обоих концов: части тела висят
    // НЕ впритык. Так на сгибе они не въезжают друг в друга, а в просвете
    // видно нить, на которой всё держится.
    panel(g, Math.max(0.02, length - (T.partGap || 0) * 2),
      nearWidth, farWidth, depth, mat(this.color, 0.95));
    return g;
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
    this.updateThread();

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
    console.warn('panel: нечисловой размер', { length, bottom, top, depth });
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
