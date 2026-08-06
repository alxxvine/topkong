import * as THREE from '../vendor/three.module.js';
import { tuning as T } from './tuning.js';
import { clamp01, inverseLerp, lerp, RAD } from './mathx.js';
import * as Rig from './fighterRig.js';
import { PoseDriver } from './poseDriver.js';
import { SwingAction } from './swingAction.js';
import { Locomotion } from './locomotion.js';
import { Ragdoll, gatherWorldPoints, makeWorldPointBuffer, P } from './ragdoll.js';

// Боец целиком: кости, состояние тела и переходы между управлением и тряпкой.
//
// Ровно как в Unity-версии, эти два режима работают по очереди, а не вместе.
// Пока боец под управлением, кости расставляет PoseDriver и поза получается
// именно такой, какой задумана. Прилетел удар — та же поза замораживается
// в частицы, и дальше телом занимается только Верле.
//
// Так управление перестаёт бороться с физикой, а ragdoll остаётся там,
// ради чего он и нужен: в полёте с арены.

export const BodyState = {
  Controlled: 'controlled',
  Ragdoll: 'ragdoll',
  StandingUp: 'standing',
  Dead: 'dead',
};

// Порядок костей — тот же, в котором их пишет PoseDriver.apply.
// По нему запоминается поза старта при вставании.
const BONE_ORDER = ['hips', 'chest', 'head', 'club',
  'legLUpper', 'legLLower', 'legRUpper', 'legRLower', 'footL', 'footR',
  'armRUpper', 'armRFore', 'armLUpper', 'armLFore'];

const TRAIL_POINTS = 26;

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _impulse = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
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
    this.velocity = new THREE.Vector3();
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
    this.ragdoll = new Ragdoll(arena);

    this.worldPoints = makeWorldPointBuffer();
    this.state = BodyState.Controlled;
    this.alive = true;

    this.ragdollTime = 0;
    this.settleTime = 0;
    this.standTime = 0;
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
    const dark = mat(this.color.clone().lerp(new THREE.Color(0x000000), 0.62), 0.5);
    const wood = mat(new THREE.Color(0x5c3d21), 0.85);
    const metal = mat(new THREE.Color(0x9ea3ad), 0.32, 0.75);

    this.bones.hips = this.bone('hips');
    capsule(this.bones.hips, 0.19, 0.46, dark);

    this.bones.chest = this.bone('chest');
    capsule(this.bones.chest, 0.235, 0.50, skin);
    // Шея и плечи — дети груди, а не отдельные кости: они не двигаются
    // относительно корпуса, а нужны только чтобы голова и руки к чему-то
    // крепились. Без них они висели рядом с торсом сами по себе.
    capsule(this.bones.chest, 0.085, 0.24,
      skin, new THREE.Vector3(0, Rig.NeckY - Rig.ChestY, 0));
    sphere(this.bones.chest, 0.115, skin,
      new THREE.Vector3(Rig.ShoulderHalfWidth, Rig.ShoulderY - Rig.ChestY, 0));
    sphere(this.bones.chest, 0.115, skin,
      new THREE.Vector3(-Rig.ShoulderHalfWidth, Rig.ShoulderY - Rig.ChestY, 0));

    this.bones.head = this.bone('head');
    sphere(this.bones.head, Rig.HeadRadius, skin);
    box(this.bones.head, 0.12, 0.08, 0.14, new THREE.Vector3(0, 0.02, 0.165), dark);

    // Каждая конечность — две кости постоянной длины. Длина берётся из рига,
    // а не из текущей позы: IK гарантирует, что звено всегда ровно такое,
    // поэтому капсулу не нужно ни тянуть, ни пересобирать.
    this.bones.legLUpper = this.segment('legLUpper', Rig.ThighLength, Rig.LegRadius, skin);
    this.bones.legLLower = this.segment('legLLower', Rig.ShinLength, Rig.FootRadius, skin);
    this.bones.legRUpper = this.segment('legRUpper', Rig.ThighLength, Rig.LegRadius, skin);
    this.bones.legRLower = this.segment('legRLower', Rig.ShinLength, Rig.FootRadius, skin);

    // Стопы — отдельные кости, и это не педантизм. Пока ботинок висел
    // на голени, он заваливался вместе с ней и на каждом шаге торчал
    // из-под ноги под случайным углом.
    this.bones.footL = this.foot(dark);
    this.bones.footR = this.foot(dark);

    // Плечо чуть толще предплечья — по этому и читается, где локоть.
    this.bones.armRUpper = this.segment('armRUpper', Rig.UpperArmLength, Rig.ArmRadius, skin);
    this.bones.armRFore = this.segment('armRFore', Rig.ForeArmLength, Rig.ArmRadius * 0.85, skin);
    this.bones.armLUpper = this.segment('armLUpper', Rig.UpperArmLength, Rig.ArmRadius, skin);
    this.bones.armLFore = this.segment('armLFore', Rig.ForeArmLength, Rig.ArmRadius * 0.85, skin);
    // Кисти: без них предплечье обрывается в пустоту прямо на рукояти.
    sphere(this.bones.armRFore, Rig.ArmRadius, skin, new THREE.Vector3(0, Rig.ForeArmLength * 0.5, 0));
    sphere(this.bones.armLFore, Rig.ArmRadius, skin, new THREE.Vector3(0, Rig.ForeArmLength * 0.5, 0));

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
    const g = new THREE.Group();
    g.name = name;
    this.group.add(g);
    return g;
  }

  /** Звено цепи: капсула фиксированной длины, вытянутая по локальной оси Y. */
  segment(name, length, radius, material) {
    const g = this.bone(name);
    capsule(g, radius, Math.max(length, radius * 2), material);
    return g;
  }

  /** Ботинок: коробка от щиколотки вперёд и вниз, до самого настила. */
  foot(material) {
    const g = this.bone('foot');
    box(g, 0.16, 0.09, 0.26, new THREE.Vector3(0, -0.048, 0.05), material);
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
    this.position.set(x, 0, z);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.facingTarget.set(Math.sin(yaw), 0, Math.cos(yaw));
    this.moveInput.set(0, 0);

    this.state = BodyState.Controlled;
    this.alive = true;
    this.ragdollTime = 0;
    this.settleTime = 0;
    this.standTime = 0;
    this.deadTime = 0;
    this.swingSpeed = 0;
    this.lastHit.clear();
    this.trailPoints.length = 0;

    this.swing.reset();
    this.ragdoll.active = false;
    this.poseDriver.snapToRest();
    this.syncGroup();
    this.group.visible = true;
    this.marker.visible = true;
    this.group.updateMatrixWorld(true);
    this.updateClubHead(1 / 60, true);
  }

  /**
   * Единственная точка входа в тряпку во всей игре.
   * Импульс уже посчитан бьющим — здесь остаётся только заморозить позу.
   */
  goRagdoll(impulse, dt) {
    if (!this.alive) return;

    // Уже летит — значит его добивают. Импульс складывается с тем,
    // что у тела есть: так добивание дотягивает до края, а не обнуляет
    // работу первого удара.
    if (this.state === BodyState.Ragdoll) {
      this.ragdoll.push(impulse, Math.max(dt, 1 / 120));
      this.settleTime = 0;
      return;
    }

    this.group.updateMatrixWorld(true);
    gatherWorldPoints(this, this.worldPoints);

    // Группа уходит в ноль: частицы живут в мире, и кости во время полёта
    // пишутся мировыми координатами напрямую.
    this.group.position.set(0, 0, 0);
    this.group.quaternion.identity();

    this.ragdoll.activate(this.worldPoints, impulse, Math.max(dt, 1 / 120));
    this.state = BodyState.Ragdoll;
    this.ragdollTime = 0;
    this.settleTime = 0;
    this.swing.reset();
    this.velocity.set(0, 0, 0);
  }

  /**
   * Собрать бойца обратно в стойку из той позы, в которой он дошатался на земле.
   *
   * Приём тот же, что в Unity: мировые позы костей запоминаются, корень
   * переносится под таз, позы пересчитываются в его локальные координаты —
   * и дальше PoseDriver подмешивает их к стойке с убывающим весом.
   * Без этого боец телепортировался бы из позы «лежит» в позу «стоит».
   */
  beginStandUp() {
    const p = this.ragdoll.pos;

    // Куда он развернётся: туда же, куда лежит корпус. Это читается
    // как «поднялся с того места, где упал», а не как разворот на месте.
    _v.copy(p[P.Chest]).sub(p[P.Hips]);
    _v.y = 0;
    if (_v.lengthSq() < 1e-6) _v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    _v.normalize();

    this.position.set(p[P.Hips].x, 0, p[P.Hips].z);
    this.velocity.set(0, 0, 0);
    this.yaw = Math.atan2(_v.x, _v.z);
    this.facingTarget.copy(_v);

    this.syncGroup();
    this.group.updateMatrixWorld(true);
    _qi.copy(this.group.quaternion).invert();

    const positions = [];
    const rotations = [];
    for (const name of BONE_ORDER) {
      const bone = this.bones[name];
      positions.push(this.group.worldToLocal(_w.copy(bone.position)).clone());
      rotations.push(_q.copy(bone.quaternion).premultiply(_qi).clone());
    }

    this.poseDriver.resetJelly();
    this.poseDriver.startPositions = positions;
    this.poseDriver.startRotations = rotations;
    this.poseDriver.blendFromStart = 0;

    this.state = BodyState.StandingUp;
    this.standTime = 0;
    this.ragdoll.active = false;
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
    switch (this.state) {
      case BodyState.Controlled:
      case BodyState.StandingUp:
        this.tickControlled(dt, controlEnabled);
        break;
      case BodyState.Ragdoll:
        this.tickRagdoll(dt);
        break;
      case BodyState.Dead:
        this.deadTime += dt;
        return;
    }

    this.group.updateMatrixWorld(true);
    this.updateClubHead(dt, false);
    this.updateMarker();
    this.updateTrail();
  }

  tickControlled(dt, controlEnabled) {
    if (this.state === BodyState.StandingUp) {
      this.standTime += dt;
      const k = clamp01(this.standTime / Math.max(0.05, T.standUpTime));
      // Мягкий вход: с линейным весом первый кадр вставания заметно дёргает.
      this.poseDriver.blendFromStart = k * k * (3 - 2 * k);
      if (k >= 1) {
        this.state = BodyState.Controlled;
        this.poseDriver.startPositions = null;
        this.poseDriver.startRotations = null;
      }
      controlEnabled = false;
    }

    this.swing.held = controlEnabled && this.swing.held;
    this.swing.tick(dt);
    this.locomotion.tick(dt, controlEnabled);
    this.poseDriver.tick(dt, this.locomotion.planarSpeed, this.locomotion.grounded);
    this.syncGroup();

    // Шагнул за кромку — дальше это уже не ходьба. Тряпкой падать честнее:
    // видно, что он именно сорвался, а не съехал по невидимой горке.
    if (!this.locomotion.grounded && this.position.y < -0.15) {
      _impulse.copy(this.velocity);
      this.goRagdoll(_impulse, dt);
      return;
    }

    if (this.position.y < T.killY) this.eliminate();
  }

  tickRagdoll(dt) {
    this.ragdollTime += dt;
    this.ragdoll.step(dt);
    this.ragdoll.writeBones(this.bones);

    // Камера и логика продолжают следить за телом: позиция бойца во время
    // полёта — это проекция таза на землю.
    const hips = this.ragdoll.pos[P.Hips];
    this.position.set(hips.x, hips.y - Rig.HipsY, hips.z);

    if (this.ragdoll.lowestY() < T.killY) {
      this.eliminate();
      return;
    }

    // Встаём, когда тряпка успокоилась и лежит на настиле. Таймаут —
    // страховка от тела, застрявшего в бесконечном мелком дрожании.
    const settled = this.ragdoll.speed(dt) < 0.6
      && this.arena.isOverDeck(hips.x, hips.z, -0.2);
    this.settleTime = settled ? this.settleTime + dt : 0;

    if (this.settleTime >= T.standUpSettle || this.ragdollTime >= T.standUpTimeout) {
      if (this.arena.isOverDeck(hips.x, hips.z, -0.2)) this.beginStandUp();
    }
  }

  syncGroup() {
    this.group.position.copy(this.position);
    this.group.quaternion.setFromAxisAngle(AXIS_Y, this.yaw);
  }

  updateClubHead(dt, snap) {
    _v.copy(Rig.ClubHeadLocal)
      .applyQuaternion(this.bones.club.quaternion)
      .add(this.bones.club.position);
    this.group.localToWorld(_v);

    if (snap) {
      this.clubHead.copy(_v);
      this.clubHeadPrev.copy(_v);
      this.swingSpeed = 0;
    } else {
      this.clubHeadPrev.copy(this.clubHead);
      this.clubHead.copy(_v);
      this.swingSpeed = this.clubHeadPrev.distanceTo(this.clubHead) / Math.max(1e-5, dt);
    }

    // Хват нужен второй точкой «лезвия»: в упор попадают древком, а не шаром.
    _v.set(0, -Rig.ClubGripOffset, 0)
      .applyQuaternion(this.bones.club.quaternion)
      .add(this.bones.club.position);
    this.clubGrip.copy(this.group.localToWorld(_v));
  }

  updateMarker() {
    this.marker.position.set(this.position.x, 0.012, this.position.z);
    // Метка гаснет, когда боец не на настиле: по ней же читается «сорвался».
    const over = this.arena.isOverDeck(this.position.x, this.position.z);
    this.marker.visible = over && this.state !== BodyState.Dead;
  }

  updateTrail() {
    const on = T.showClubTrail && this.state !== BodyState.Dead;
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

      victim.goRagdoll(_impulse, dt);
      victim.lastImpactSpeed = this.swingSpeed;
      victim.lastImpactPower = strength;

      if (onHit) onHit(this, victim, this.clubHead, clamp01(strength));
    }
  }

  /** Отрезок корпуса — по нему и проверяется попадание. */
  torsoSegment(outA, outB) {
    if (this.state === BodyState.Ragdoll) {
      outA.copy(this.ragdoll.pos[P.Hips]);
      outB.copy(this.ragdoll.pos[P.Head]);
      return;
    }
    outA.copy(this.bones.hips.position);
    outB.copy(this.bones.head.position);
    this.group.localToWorld(outA);
    this.group.localToWorld(outB);
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
