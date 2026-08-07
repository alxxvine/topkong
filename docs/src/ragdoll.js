import * as THREE from 'three';
import { tuning as T } from 'tk/tuning.js';
import { clamp01 } from 'tk/mathx.js';
import * as Rig from 'tk/fighterRig.js';

// Тряпка на частицах Верле — замена PhysX из Unity-версии.
//
// Полноценный движок здесь не нужен и даже вреден. Ragdoll в этой игре живёт
// ровно один раз за жизнь бойца: его ударили, он летит, падает и либо встаёт,
// либо улетает с арены. Ни стопки ящиков, ни техники, ни сложных контактов —
// значит, хватает частиц со связями по расстоянию.
//
// Верле выбран потому, что он не разваливается: скорость хранится как разница
// двух позиций, поэтому жёсткая связь физически не может добавить энергии.
// Суставы PhysX ровно на этом и ломались — на быстром ударе цепь взрывалась.
//
// Точки частиц совпадают с точками позы: тряпка стартует ровно оттуда,
// где боец был в момент удара, без скачка.

// Индексы частиц. Порядок фиксирован — по нему собираются связи и кости.
export const P = {
  Head: 0, Chest: 1, Hips: 2,
  HipL: 3, KneeL: 4, FootL: 5,
  HipR: 6, KneeR: 7, FootR: 8,
  ShoulderR: 9, ElbowR: 10, HandR: 11,
  ShoulderL: 12, ElbowL: 13, HandL: 14,
  ClubTip: 15,
};
const COUNT = 16;

// Радиусы для касания настила и массы для решателя связей. Массы взяты
// из Unity-рига: голова лёгкая, грудь тяжёлая, дубина весит как нога —
// от этого зависит, что кого тащит при падении.
const RADIUS = [
  0.20, 0.24, 0.19,
  0.12, 0.11, 0.10,
  0.12, 0.11, 0.10,
  0.10, 0.08, 0.075,
  0.10, 0.08, 0.075,
  0.17,
];
const MASS = [
  4, 15, 11,
  5, 5, 4,
  5, 5, 4,
  5, 2, 1.5,
  5, 2, 1.5,
  9,
];

// Связи скелета. Кроме очевидных костей есть раскосы по корпусу:
// без них тело складывается пополам и выглядит как мешок, а не как человек.
// У рук появился локоть — та же двухзвенная цепь, что и под управлением,
// иначе тряпка складывала бы руки не так, как их только что видели стоящими.
const LINKS = [
  [P.Head, P.Chest], [P.Chest, P.Hips],
  [P.Head, P.Hips],                                     // раскос корпуса
  [P.Hips, P.HipL], [P.Hips, P.HipR], [P.HipL, P.HipR], // жёсткий таз
  [P.Chest, P.HipL], [P.Chest, P.HipR],
  [P.HipL, P.KneeL], [P.KneeL, P.FootL],
  [P.HipR, P.KneeR], [P.KneeR, P.FootR],
  [P.Chest, P.ShoulderL], [P.Chest, P.ShoulderR], [P.ShoulderL, P.ShoulderR],
  [P.Head, P.ShoulderL], [P.Head, P.ShoulderR],
  [P.ShoulderL, P.HipR], [P.ShoulderR, P.HipL],         // X-раскос корпуса
  [P.ShoulderR, P.ElbowR], [P.ElbowR, P.HandR],
  [P.ShoulderL, P.ElbowL], [P.ElbowL, P.HandL],
  [P.HandL, P.HandR],                                   // двуручный хват
  [P.HandR, P.ClubTip], [P.HandL, P.ClubTip],
];

const _v = new THREE.Vector3();
const _center = new THREE.Vector3();
const _rot = new THREE.Quaternion();
const _dir = new THREE.Vector3();
const _grip = new THREE.Vector3();
const AXIS_Y = new THREE.Vector3(0, 1, 0);

/** Опорные позиции частиц в стойке — из них берутся длины всех связей. */
function restPositions() {
  const pose = Rig.restPose();
  const out = new Array(COUNT);
  out[P.Head] = pose.head.clone();
  out[P.Chest] = pose.chest.clone();
  out[P.Hips] = pose.hips.clone();
  out[P.HipL] = Rig.hipJoint(false);
  out[P.HipR] = Rig.hipJoint(true);
  out[P.KneeL] = pose.kneeLeft.clone();
  out[P.KneeR] = pose.kneeRight.clone();
  out[P.FootL] = pose.footLeft.clone();
  out[P.FootR] = pose.footRight.clone();
  out[P.ShoulderR] = Rig.shoulder(true);
  out[P.ShoulderL] = Rig.shoulder(false);
  out[P.ElbowR] = pose.elbowRight.clone();
  out[P.ElbowL] = pose.elbowLeft.clone();
  out[P.HandR] = pose.handRight.clone();
  out[P.HandL] = pose.handLeft.clone();
  // Набалдашник — вдоль оси дубины, в стойке она смотрит вперёд.
  out[P.ClubTip] = pose.club.clone().addScaledVector(pose.clubDir, Rig.ClubHeadLocal.y);
  return out;
}

const REST = restPositions();
const LINK_LENGTH = LINKS.map(([a, b]) => REST[a].distanceTo(REST[b]));

export class Ragdoll {
  constructor(arena) {
    this.arena = arena;
    this.pos = [];
    this.prev = [];
    this.invMass = [];
    for (let i = 0; i < COUNT; i++) {
      this.pos.push(new THREE.Vector3());
      this.prev.push(new THREE.Vector3());
      this.invMass.push(1 / MASS[i]);
    }
    this.active = false;
    this.restLength = LINK_LENGTH.slice();
  }

  /**
   * Заморозить текущую позу в частицы и толкнуть.
   *
   * Позиции берутся из мировых координат костей, а не из формулы позы:
   * визуально видимое положение и есть то, откуда должен начаться полёт.
   */
  activate(worldPoints, impulse, dt) {
    for (let i = 0; i < COUNT; i++) {
      this.pos[i].copy(worldPoints[i]);
      // Верле хранит скорость как разницу с прошлой позицией.
      this.prev[i].copy(worldPoints[i]).addScaledVector(impulse, -dt);
    }

    // Верх тела получает добавку: тогда тело опрокидывается само,
    // и не нужен ни отдельный момент, ни ручная закрутка.
    const extra = 0.5 * dt;
    this.prev[P.Head].addScaledVector(impulse, -extra);
    this.prev[P.Chest].addScaledVector(impulse, -extra * 0.7);
    this.prev[P.ShoulderL].addScaledVector(impulse, -extra * 0.7);
    this.prev[P.ShoulderR].addScaledVector(impulse, -extra * 0.7);

    this.active = true;
  }

  /**
   * Добавить импульс уже летящей тряпке.
   *
   * Добить лежачего — не жестокость, а единственный способ дотолкать до края
   * того, кого первым ударом не вынесло. Скорость именно складывается,
   * а не назначается заново: иначе второй удар гасил бы первый.
   */
  push(impulse, dt) {
    for (let i = 0; i < COUNT; i++) this.prev[i].addScaledVector(impulse, -dt);
  }

  /** Скорость частицы — восстанавливается из двух позиций. */
  velocity(i, out) {
    return out.copy(this.pos[i]).sub(this.prev[i]);
  }

  /** Средняя скорость всего тела. По ней видно, что тряпка успокоилась. */
  speed(dt) {
    let sum = 0;
    for (let i = 0; i < COUNT; i++) sum += this.pos[i].distanceTo(this.prev[i]);
    return sum / COUNT / Math.max(1e-5, dt);
  }

  step(dt) {
    // Затухание задано долей скорости, теряемой за секунду, и приводится
    // к шагу возведением в степень. Иначе смысл числа зависел бы от частоты
    // шага: одно и то же 0.06 при 120 Гц съедает скорость за долю секунды,
    // а при 30 Гц почти не мешает.
    const keep = Math.pow(1 - clamp01(T.ragdollDrag), dt);
    const g = T.gravity * dt * dt;

    for (let i = 0; i < COUNT; i++) {
      const p = this.pos[i];
      const q = this.prev[i];
      const vx = (p.x - q.x) * keep;
      const vy = (p.y - q.y) * keep;
      const vz = (p.z - q.z) * keep;
      q.copy(p);
      p.set(p.x + vx, p.y + vy + g, p.z + vz);
    }

    // Трение и отскок считаются ровно один раз за шаг. Внутри цикла
    // решателя они умножались бы на число итераций, и сбитый боец
    // прилипал бы к настилу вместо того, чтобы катиться к краю.
    this.groundResponse(dt);

    const iterations = Math.max(1, Math.round(T.ragdollIterations));
    for (let k = 0; k < iterations; k++) {
      this.solveLinks();
      this.clampGround();
    }
  }

  solveLinks() {
    for (let i = 0; i < LINKS.length; i++) {
      const a = LINKS[i][0];
      const b = LINKS[i][1];
      const pa = this.pos[a];
      const pb = this.pos[b];

      _v.copy(pb).sub(pa);
      const dist = _v.length();
      if (dist < 1e-6) continue;

      const rest = this.restLength[i];
      const wa = this.invMass[a];
      const wb = this.invMass[b];
      // Коррекция делится обратно пропорционально массе: лёгкую кисть
      // дёргает сильнее, чем грудь, — иначе тряпку ведёт от каждой мелочи.
      const k = ((dist - rest) / dist) / (wa + wb);
      pa.addScaledVector(_v, k * wa);
      pb.addScaledVector(_v, -k * wb);
    }
  }

  /** Реакция настила: трение и отскок. Один раз за шаг. */
  groundResponse(dt) {
    const friction = 1 - Math.pow(1 - clamp01(T.ragdollFriction), dt);
    const bounce = clamp01(T.ragdollBounce);

    for (let i = 0; i < COUNT; i++) {
      const p = this.pos[i];
      if (p.y >= RADIUS[i]) continue;
      // Опоры нет за кромкой — именно поэтому сбитый и улетает вниз,
      // а не скользит по невидимому полу.
      if (!this.arena.isOverDeck(p.x, p.z)) continue;

      const q = this.prev[i];
      const vy = p.y - q.y;
      // Скорость меняется сдвигом прошлой позиции: в Верле её больше негде
      // хранить, и это же не даёт связям накачать в тело энергию.
      q.x += (p.x - q.x) * friction;
      q.z += (p.z - q.z) * friction;
      if (vy < 0) q.y = p.y + vy * bounce;
    }
  }

  /** Выталкивание из настила. Внутри решателя — только позиции, без скоростей. */
  clampGround() {
    for (let i = 0; i < COUNT; i++) {
      const p = this.pos[i];
      if (p.y >= RADIUS[i]) continue;
      if (!this.arena.isOverDeck(p.x, p.z)) continue;
      const q = this.prev[i];
      const shift = RADIUS[i] - p.y;
      p.y = RADIUS[i];
      // Прошлая позиция едет следом: иначе выталкивание само по себе
      // читается как скорость вверх и тело подпрыгивает на ровном месте.
      q.y += shift;
    }
  }

  /** Разложить частицы обратно в кости. Обратная операция к захвату позы. */
  writeBones(bones) {
    const p = this.pos;

    Rig.aim(_v.copy(p[P.Chest]).sub(p[P.Hips]), _rot);
    bones.hips.position.copy(p[P.Hips]);
    bones.hips.quaternion.copy(_rot);

    Rig.aim(_v.copy(p[P.Head]).sub(p[P.Chest]), _rot);
    bones.chest.position.copy(p[P.Chest]);
    bones.chest.quaternion.copy(_rot);
    bones.head.position.copy(p[P.Head]);
    bones.head.quaternion.copy(_rot);

    limbTo(bones.legLUpper, p[P.HipL], p[P.KneeL]);
    limbTo(bones.legLLower, p[P.KneeL], p[P.FootL]);
    limbTo(bones.legRUpper, p[P.HipR], p[P.KneeR]);
    limbTo(bones.legRLower, p[P.KneeR], p[P.FootR]);

    // Стопы разворачиваются вслед за тем, куда лежит корпус, но остаются
    // горизонтальными: ботинок, кувыркающийся вокруг щиколотки, читается
    // как поломка, а не как физика.
    _v.copy(p[P.Chest]).sub(p[P.Hips]);
    _v.y = 0;
    const footYaw = _v.lengthSq() > 1e-8 ? Math.atan2(_v.x, _v.z) : 0;
    bones.footL.position.copy(p[P.FootL]);
    bones.footL.quaternion.setFromAxisAngle(AXIS_Y, footYaw);
    bones.footR.position.copy(p[P.FootR]);
    bones.footR.quaternion.setFromAxisAngle(AXIS_Y, footYaw);
    limbTo(bones.armRUpper, p[P.ShoulderR], p[P.ElbowR]);
    limbTo(bones.armRFore, p[P.ElbowR], p[P.HandR]);
    limbTo(bones.armLUpper, p[P.ShoulderL], p[P.ElbowL]);
    limbTo(bones.armLFore, p[P.ElbowL], p[P.HandL]);

    // Дубина: ось от середины хвата к набалдашнику, центр — на длине хвата.
    // Та же формула, что в PoseDriver.Apply, поэтому переход её не дёргает.
    _grip.copy(p[P.HandL]).add(p[P.HandR]).multiplyScalar(0.5);
    _dir.copy(p[P.ClubTip]).sub(_grip);
    Rig.aim(_dir, _rot);
    if (_dir.lengthSq() > 1e-8) _dir.normalize();
    bones.club.position.copy(_grip).addScaledVector(_dir, Rig.ClubGripOffset);
    bones.club.quaternion.copy(_rot);
  }

  /** Самая низкая точка тела — по ней видно, что боец улетел под арену. */
  lowestY() {
    let y = Infinity;
    for (let i = 0; i < COUNT; i++) y = Math.min(y, this.pos[i].y);
    return y;
  }

  center(out) {
    out.set(0, 0, 0);
    for (let i = 0; i < COUNT; i++) out.add(this.pos[i]);
    return out.multiplyScalar(1 / COUNT);
  }
}

function limbTo(bone, from, to) {
  Rig.limb(from, to, _center, _rot);
  bone.position.copy(_center);
  bone.quaternion.copy(_rot);
}

/**
 * Мировые точки бойца в порядке частиц. Нужны и при переходе в тряпку,
 * и при вставании обратно — оба раза это один и тот же список.
 */
export function gatherWorldPoints(fighter, out) {
  const b = fighter.bones;
  const pose = fighter.poseDriver.pose;

  set(out, P.Hips, pose.hips);
  set(out, P.Chest, pose.chest);
  set(out, P.Head, pose.head);
  set(out, P.FootL, pose.footLeft);
  set(out, P.FootR, pose.footRight);
  set(out, P.HandR, pose.handRight);
  set(out, P.HandL, pose.handLeft);

  set(out, P.KneeL, pose.kneeLeft);
  set(out, P.KneeR, pose.kneeRight);
  set(out, P.ElbowL, pose.elbowLeft);
  set(out, P.ElbowR, pose.elbowRight);

  set(out, P.HipL, Rig.hipJoint(false, _v));
  set(out, P.HipR, Rig.hipJoint(true, _v));
  set(out, P.ShoulderL, Rig.shoulder(false, _v));
  set(out, P.ShoulderR, Rig.shoulder(true, _v));

  // Набалдашник берётся с самой кости: на проносе именно он определяет,
  // куда в этот кадр пришёлся удар.
  _v.copy(Rig.ClubHeadLocal).applyQuaternion(b.club.quaternion).add(b.club.position);
  set(out, P.ClubTip, _v);

  return out;

  function set(dst, index, local) {
    dst[index].copy(local);
    fighter.group.localToWorld(dst[index]);
  }
}

export function makeWorldPointBuffer() {
  const out = [];
  for (let i = 0; i < COUNT; i++) out.push(new THREE.Vector3());
  return out;
}

export const PARTICLE_COUNT = COUNT;
