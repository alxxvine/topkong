import * as THREE from '../vendor/three.module.js';
import { DEG } from './mathx.js';

// Геометрия тела и вычисление позы. Порт FighterRig.cs.
//
// Общая для сборщика, контроллера позы и ragdoll'а: пока боец под управлением,
// его кости расставляются вот этими формулами, а в момент удара ровно из этой
// позы стартуют частицы тряпки. Разъехаться они не могут, потому что источник
// координат один.
//
// Все величины — в локальных координатах бойца: ноль на настиле под ним,
// +Z — направление взгляда, +Y — вверх.

export const HipsY = 0.95;
export const ChestY = 1.40;
export const HeadY = 1.82;

export const HipHalfWidth = 0.13;
export const HipJointY = 0.88;
export const KneeY = 0.48;
export const FootY = 0.10;

export const ShoulderHalfWidth = 0.28;
export const ShoulderY = 1.58;
export const HandHalfWidth = 0.10;

/** Дубина держится перед собой: центр на этой высоте, головой вперёд. */
export const ClubY = 1.30;
export const ClubRestReach = 0.62;
/** Насколько рукоять отстоит от центра дубины назад. */
export const ClubGripOffset = 0.32;
/** Набалдашник — вдоль локальной оси Y дубины. Им и бьют. */
export const ClubHeadLocal = new THREE.Vector3(0, 0.40, 0);
export const ClubHeadRadius = 0.24;

export const LegRadius = 0.11;
export const FootRadius = 0.10;
export const ArmRadius = 0.085;

const UP = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _chestPoint = new THREE.Vector3();
const _delta = new THREE.Vector3();

/** Полный набор локальных позиций и поворотов тела. */
export function makePose() {
  return {
    hips: new THREE.Vector3(),
    chest: new THREE.Vector3(),
    head: new THREE.Vector3(),
    footLeft: new THREE.Vector3(),
    footRight: new THREE.Vector3(),
    club: new THREE.Vector3(),
    handLeft: new THREE.Vector3(),
    handRight: new THREE.Vector3(),
  };
}

/**
 * Поза по параметрам.
 *
 * @param {object} pose      куда писать — переиспользуемый объект, без мусора на кадр
 * @param {number} bob       вертикальное смещение таза, им же делается подскок при шаге
 * @param {number} stepPhase 0..1, фаза шага; ноги ходят в противофазе
 * @param {number} stride    размах шага: 0 в покое, больше на скорости
 * @param {number} clubAngleDeg куда развёрнута дубина относительно взгляда
 * @param {number} clubReach насколько дубина вынесена от груди
 * @param {number} lean      наклон корпуса вперёд: от разгона и от удара
 * @param {number} sway      заваливание вбок; им и делается вся шаткость походки
 * @param {number} clubHeight смещение дубины по высоте; отрицательное — волочится
 */
export function computePose(pose, bob, stepPhase, stride, clubAngleDeg, clubReach,
                            lean, sway = 0, clubHeight = 0) {
  // Смещения намеренно разные по высоте: наклоны корпуса нигде не задаются
  // явно, PoseDriver выводит их из направлений таз→грудь и грудь→голова.
  // Поэтому «завалить тело» здесь означает просто развести эти точки вбок
  // на разную величину — и тело заваливается само, оставаясь связным.
  pose.hips.set(sway * 0.02, HipsY + bob, lean * 0.02);
  pose.chest.set(sway * 0.10, ChestY + bob, lean * 0.12);
  pose.head.set(sway * 0.22, HeadY + bob, lean * 0.20);

  // Ноги в противофазе: одна выносится вперёд и приподнимается, другая позади.
  const phaseL = stepPhase * Math.PI * 2;
  const phaseR = phaseL + Math.PI;
  foot(pose.footLeft, -HipHalfWidth, phaseL, stride);
  foot(pose.footRight, HipHalfWidth, phaseR, stride);

  const a = clubAngleDeg * DEG;
  _dir.set(Math.sin(a), 0, Math.cos(a));
  // Поперечная ось — по ней разводятся руки на рукояти.
  _side.set(_dir.z, 0, -_dir.x);

  _chestPoint.set(0, ClubY + bob + clubHeight, lean * 0.12);
  pose.club.copy(_chestPoint).addScaledVector(_dir, clubReach);

  // Рукоять — позади центра дубины; кисти разведены по ней в стороны.
  pose.handRight.copy(pose.club).addScaledVector(_dir, -ClubGripOffset)
    .addScaledVector(_side, HandHalfWidth);
  pose.handLeft.copy(pose.club).addScaledVector(_dir, -ClubGripOffset)
    .addScaledVector(_side, -HandHalfWidth);

  return pose;
}

function foot(out, x, phase, stride) {
  // Подъём только на передней половине шага: сзади нога скользит по земле.
  const lift = Math.max(0, Math.sin(phase)) * stride * 0.35;
  const forward = Math.cos(phase) * stride;
  return out.set(x, FootY + lift, forward);
}

export function shoulder(right, out = new THREE.Vector3()) {
  return out.set(right ? ShoulderHalfWidth : -ShoulderHalfWidth, ShoulderY, 0);
}

export function hipJoint(right, out = new THREE.Vector3()) {
  return out.set(right ? HipHalfWidth : -HipHalfWidth, HipJointY, 0);
}

/**
 * Колено — середина между бедром и стопой, чуть вынесенная вперёд.
 * Настоящая двухзвенная IK тут не нужна: ноги короткие, камера далеко,
 * а разницу видно, только если специально искать.
 */
export function knee(foot, right, out = new THREE.Vector3()) {
  hipJoint(right, out);
  out.add(foot).multiplyScalar(0.5);
  out.z += 0.06;
  return out;
}

/** Поворот, направляющий локальную ось Y вдоль вектора. Аналог FromToRotation(up, dir). */
export function aim(direction, out = new THREE.Quaternion()) {
  if (direction.lengthSq() < 1e-12) return out.identity();
  _delta.copy(direction).normalize();
  return out.setFromUnitVectors(UP, _delta);
}

/** Положение и поворот конечности, натянутой между двумя точками. */
export function limb(from, to, outCenter, outRotation) {
  outCenter.copy(from).add(to).multiplyScalar(0.5);
  _delta.copy(to).sub(from);
  aim(_delta, outRotation);
  return outCenter;
}

export function limbLength(from, to) {
  return from.distanceTo(to);
}

/** Поза покоя — из неё собирается тело и в неё же оно возвращается после падения. */
export function restPose(pose = makePose()) {
  return computePose(pose, 0, 0, 0, 0, ClubRestReach, 0, 0, 0);
}
