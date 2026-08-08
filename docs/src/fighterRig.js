import * as THREE from 'three';
import { DEG, clamp } from 'tk/mathx.js';
import { tuning as T } from 'tk/tuning.js';

// Геометрия тела и вычисление позы. Порт FighterRig.cs.
//
// Общая для сборщика, контроллера позы и ragdoll'а: пока боец под управлением,
// его кости расставляются вот этими формулами, а в момент удара ровно из этой
// позы стартуют частицы тряпки. Разъехаться они не могут, потому что источник
// координат один.
//
// Все величины — в локальных координатах бойца: ноль на настиле под ним,
// +Z — направление взгляда, +Y — вверх.
//
// Руки и ноги — двухзвенные, с настоящей IK. Раньше рука была одной капсулой
// постоянной длины, а поза уводила кисть куда угодно: в стойке плечо от кисти
// отделяло 1.13 метра при длине руки 0.45, и капсула просто висела посередине,
// не касаясь ни плеча, ни рукояти. Двухзвенная цепь такого не допускает
// по построению — звенья всегда своей длины, а недостижимую цель IK
// подтягивает к границе досягаемости.

export const HipsY = 0.95;
export const ChestY = 1.40;
// Голова поднята ровно настолько, чтобы под ней помещалась шея. Без зазора
// шар головы врастал в капсулу груди, и фигура читалась снеговиком.
export const HeadY = 1.85;
export const HeadRadius = 0.185;
export const NeckY = 1.62;

export const HipHalfWidth = 0.13;
export const HipJointY = 0.88;
export const FootY = 0.10;

export const ShoulderHalfWidth = 0.28;
export const ShoulderY = 1.58;

// Длины звеньев. Размах руки 0.68 — это плечо на высоте 1.58 и кисть,
// свисающая до 0.90, то есть до середины бедра. Ровно те пропорции,
// по которым тело и читается человеческим.
export const UpperArmLength = 0.33;
export const ForeArmLength = 0.35;
export const ArmSpan = UpperArmLength + ForeArmLength;

export const ThighLength = 0.42;
export const ShinLength = 0.40;

/**
 * Высота, на которой держат рукоять. Дубина считается от хвата, а не наоборот:
 * хват — это место, куда должны дотянуться кисти, и он обязан быть достижимым.
 */
export const GripY = 1.30;
export const ClubRestReach = 0.38;
/** Насколько центр дубины вынесен от хвата вперёд по её оси. */
export const ClubGripOffset = 0.30;
/** Набалдашник — вдоль локальной оси Y дубины. Им и бьют. */
export const ClubHeadLocal = new THREE.Vector3(0, 0.36, 0);
export const ClubHeadRadius = 0.17;
export const ClubLength = 0.80;
export const ClubRadius = 0.06;

export const LegRadius = 0.11;
export const FootRadius = 0.10;
export const ArmRadius = 0.075;

// Полюса IK: куда выгибается сустав. Локоть уходит ВНИЗ и чуть наружу,
// колено вперёд. Раньше наружу было столько же, сколько вниз, и в стойке
// с руками перед корпусом локти расходились в стороны крыльями.
const ARM_POLE_RIGHT = new THREE.Vector3(0.5, -1, -0.25).normalize();
const ARM_POLE_LEFT = new THREE.Vector3(-0.5, -1, -0.25).normalize();
const LEG_POLE = new THREE.Vector3(0, -0.15, 1).normalize();

const UP = new THREE.Vector3(0, 1, 0);
const _delta = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _up = new THREE.Vector3();
const _side = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _basis = new THREE.Matrix4();

// FreeHandHalfWidth / FreeHandY больше нет: они держали кисть у бедра,
// то есть задавали ровно ту позу «руки по швам», от которой мы уходим.
// Положение кистей в стойке теперь в настройках — guardWidth и guardHeight.

/** Полный набор локальных позиций тела. */
export function makePose() {
  return {
    hips: new THREE.Vector3(),
    chest: new THREE.Vector3(),
    head: new THREE.Vector3(),
    // Плечи и тазобедренные суставы — часть позы, а не константы. Пока они
    // были константами, скручиваться и подседать телу было нечем: опусти
    // таз, и связь таз↔бедро порвётся, потому что бедро осталось на месте.
    shoulderLeft: new THREE.Vector3(),
    shoulderRight: new THREE.Vector3(),
    hipLeft: new THREE.Vector3(),
    hipRight: new THREE.Vector3(),
    footLeft: new THREE.Vector3(),
    footRight: new THREE.Vector3(),
    kneeLeft: new THREE.Vector3(),
    kneeRight: new THREE.Vector3(),
    grip: new THREE.Vector3(),
    club: new THREE.Vector3(),
    clubDir: new THREE.Vector3(0, 0, 1),
    handLeft: new THREE.Vector3(),
    handRight: new THREE.Vector3(),
    elbowLeft: new THREE.Vector3(),
    elbowRight: new THREE.Vector3(),
  };
}

/**
 * Поза по параметрам.
 *
 * @param {object} pose      куда писать — переиспользуемый объект, без мусора на кадр
 * @param {number} bob       вертикальное смещение таза, им же делается подскок при шаге
 * @param {number} stepPhase 0..1, фаза шага; ноги ходят в противофазе
 * @param {number} stride    размах шага вперёд: 0 в покое, больше на скорости
 * @param {number} lift      насколько высоко поднимается стопа за цикл
 * @param {number} clubAngleDeg куда развёрнута дубина относительно взгляда
 * @param {number} clubReach насколько хват вынесен от корпуса
 * @param {number} lean      наклон корпуса вперёд: от разгона и от удара
 * @param {number} sway      заваливание вбок; им и делается вся шаткость походки
 * @param {number} clubHeight смещение хвата по высоте; отрицательное — руки опущены
 * @param {number} clubPitchDeg наклон дубины к земле: 0 — горизонтально, 90 — отвесно вниз
 * @param {number} twistDeg  разворот плечевого пояса относительно таза
 * @param {THREE.Vector3} footL,footR готовые стопы в системе тела; null —
 *        посчитать формулой (только для опорной стойки)
 */
export function computePose(pose, bob, stepPhase, stride, clubAngleDeg, clubReach,
                            lean, sway = 0, clubHeight = 0, clubPitchDeg = 0, lift = 0,
                            twistDeg = 0, footL = null, footR = null) {
  // Подсед опускает ВЕСЬ верх тела разом. Опустить один таз нельзя:
  // расстояния таз↔грудь↔голова держат связи, и попытка просадить
  // что-то одно кончится дракой позы с решателем.
  const crouch = T.stanceCrouch;

  // Смещения намеренно разные по высоте: наклоны корпуса нигде не задаются
  // явно, PoseDriver выводит их из направлений таз→грудь и грудь→голова.
  // Поэтому «завалить тело» здесь означает просто развести эти точки вбок
  // на разную величину — и тело заваливается само, оставаясь связным.
  pose.hips.set(sway * 0.02, HipsY + bob - crouch, lean * 0.02);
  pose.chest.set(sway * 0.10, ChestY + bob - crouch, lean * 0.12);
  pose.head.set(sway * 0.22, HeadY + bob - crouch, lean * 0.20);

  // Плечи живут между грудью и головой и качаются вместе с ними.
  const shoulderSide = sway * 0.16;
  const shoulderFwd = lean * 0.16;
  pose.shoulderRight.set(ShoulderHalfWidth + shoulderSide, ShoulderY + bob - crouch, shoulderFwd);
  pose.shoulderLeft.set(-ShoulderHalfWidth + shoulderSide, ShoulderY + bob - crouch, shoulderFwd);

  // Тазобедренные суставы едут вместе с тазом — иначе подсед их оторвёт.
  pose.hipRight.set(HipHalfWidth + sway * 0.02, HipJointY + bob - crouch, lean * 0.02);
  pose.hipLeft.set(-HipHalfWidth + sway * 0.02, HipJointY + bob - crouch, lean * 0.02);

  // Стопы приходят готовыми: их считает Gait, и считает В МИРЕ, потому что
  // опора обязана стоять на месте, пока тело идёт над ней. Здесь они уже
  // переведены в систему тела — формуле от фазы шага их отдавать нельзя,
  // иначе опора снова поедет за тазом и шаг опять станет косметикой.
  //
  // Формула остаётся только для опорной стойки, из которой собирается
  // скелет: там шага нет вовсе.
  const phaseL = stepPhase * Math.PI * 2;
  if (footL) {
    pose.footLeft.copy(footL);
    pose.footRight.copy(footR);
  } else {
    const half = HipHalfWidth + T.stanceWidth;
    foot(pose.footLeft, -half, phaseL, stride, lift);
    foot(pose.footRight, half, phaseL + Math.PI, stride, lift);
  }

  const a = clubAngleDeg * DEG;
  const flatX = Math.sin(a);
  const flatZ = Math.cos(a);

  // Хват выносится по горизонтали — там, где кисти действительно окажутся.
  const anchorY = GripY + bob - crouch + clubHeight;
  pose.grip.set(flatX * clubReach, anchorY, lean * 0.12 + flatZ * clubReach);

  // Руки в стойке держатся ПЕРЕД телом, а не висят по швам. Опущенные вдоль
  // корпуса руки — это поза человека в очереди, а не бойца; по ней вообще
  // не читается, что он собирается драться.
  //
  // Кисти качаются в противофазе своим ногам: вынесена левая нога — вперёд
  // идёт правая рука. Без этого руки едут вдоль тела досками и выдают всю
  // походку.
  const guardY = T.guardHeight + bob - crouch;
  const swing = Math.cos(phaseL) * T.armSwing * stride;
  guardHand(pose.handRight, 1, guardY, lean, swing);
  guardHand(pose.handLeft, -1, guardY, lean, -swing);

  // Дубина всегда в одной и той же руке — правой. Ни перехвата между
  // ударами, ни подхвата второй рукой на тяжёлом замахе: боец правша,
  // и это его свойство, а не следствие геометрии позы.
  //
  // Раньше держащая рука выбиралась по знаку grip.x, то есть менялась
  // вместе со стороной дуги, и оружие перекладывалось из руки в руку
  // после каждого удара.
  if (T.withClub) pose.handRight.set(pose.grip.x, anchorY, pose.grip.z);

  // Наклон отдельно от разворота: без него дубина всегда горизонтальна,
  // и «волочится за спиной» выглядит как парящий на уровне колен шар.
  const p = clubPitchDeg * DEG;
  const cp = Math.cos(p);
  pose.clubDir.set(flatX * cp, -Math.sin(p), flatZ * cp);

  // Скрут корпуса. Всё, что выше таза, доворачивается вокруг его оси —
  // и плечи расходятся вперёд-назад по-настоящему, а не просто едут вбок.
  //
  // Руки и хват крутятся вместе с плечами не для красоты: рука растёт
  // из плеча, и если плечо уехало, а цель кисти осталась на месте,
  // мышца начнёт тянуть кисть обратно и съест весь скрут.
  if (twistDeg !== 0) {
    const t = twistDeg * DEG;
    const ts = Math.sin(t);
    const tc = Math.cos(t);
    twistY(pose.chest, ts, tc);
    twistY(pose.head, ts, tc);
    twistY(pose.shoulderRight, ts, tc);
    twistY(pose.shoulderLeft, ts, tc);
    twistY(pose.grip, ts, tc);
    twistY(pose.handRight, ts, tc);
    twistY(pose.handLeft, ts, tc);
    twistY(pose.clubDir, ts, tc);
  }

  // Без дубины набалдашник всё равно остаётся частицей: выкидывать его
  // из скелета значило бы пересобирать связи и их длины на ходу. Вместо
  // этого он вешается прямо под кисть, ровно на длину связи, чтобы она
  // не оказалась растянутой, а масса ему снимается в body.js — так он
  // болтается следом и ничего никуда не тянет.
  if (!T.withClub) {
    pose.grip.copy(pose.handRight);
    pose.clubDir.set(0, -1, 0);
  }

  pose.club.copy(pose.grip).addScaledVector(pose.clubDir, ClubGripOffset);

  return pose;
}

/** Поворот вокруг вертикали. Та же формула, по которой поза уходит в мир. */
function twistY(v, sin, cos) {
  const x = v.x * cos + v.z * sin;
  const z = -v.x * sin + v.z * cos;
  v.x = x;
  v.z = z;
}

/**
 * Кисть в стойке: вынесена вперёд, разведена в сторону и приподнята.
 *
 * @param {number} side  +1 правая, -1 левая
 * @param {number} swing вклад шага: вперёд-назад в противофазе своей ноге
 */
function guardHand(out, side, y, lean, swing) {
  return out.set(
    side * T.guardWidth,
    y,
    T.guardForward + lean * 0.08 + swing);
}

function foot(out, x, phase, stride, lift) {
  // Подъём считается отдельно от длины шага, а не как доля от неё.
  // Пока он был долей, разворот на месте не поднимал стопы вовсе — длина
  // шага там нулевая, — и боец проворачивался юзом, как статуя на круге.
  const up = Math.max(0, Math.sin(phase)) * lift;
  const forward = Math.cos(phase) * stride;
  return out.set(x, FootY + up, forward);
}

/**
 * Радиус, по которому едет стопа при развороте на месте. Не полуширина таза:
 * стопа ходит по дуге шире неё за счёт стойки и выноса.
 */
export const PivotRadius = 0.40;

// Отдельных функций shoulder() и hipJoint() больше нет намеренно. Они
// возвращали постоянные точки, и все, кто ими пользовался, получали сустав,
// не знающий ни про наклон, ни про шаг, ни про скрут, ни про подсед.
// Оба сустава теперь живут в позе.

export const armPole = (right) => (right ? ARM_POLE_RIGHT : ARM_POLE_LEFT);
export const legPole = () => LEG_POLE;

/**
 * Двухзвенная IK: где встанет сустав, если цепь длиной l1+l2 тянется
 * от root к target.
 *
 * Классическая тригонометрия, никаких итераций: расстояние до цели даёт
 * основание треугольника, длины звеньев — его стороны, а полюс решает,
 * в какую из двух зеркальных сторон он выгнется. Локоть наружу, колено вперёд.
 *
 * Недостижимую цель функция честно подтягивает к границе досягаемости
 * и пишет фактическое положение конца в outEnd. Вызывающий обязан
 * использовать именно его: тянуться к тому, куда рука не достаёт, — это ровно
 * та ошибка, из-за которой руки раньше висели в воздухе.
 */
export function solveTwoBone(root, target, l1, l2, pole, outJoint, outEnd) {
  _axis.copy(target).sub(root);
  let d = _axis.length();
  if (d < 1e-5) {
    _axis.set(0, -1, 0);
    d = 1e-5;
  } else {
    _axis.divideScalar(d);
  }

  const dc = clamp(d, Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
  outEnd.copy(root).addScaledVector(_axis, dc);

  // Проекция полюса на плоскость, перпендикулярную оси цепи.
  _pole.copy(pole).addScaledVector(_axis, -pole.dot(_axis));
  if (_pole.lengthSq() < 1e-8) {
    // Полюс совпал с осью — берём любое перпендикулярное направление,
    // лишь бы сустав не оказался на самой оси и звенья не слиплись.
    _pole.set(-_axis.y, _axis.x, 0);
    if (_pole.lengthSq() < 1e-8) _pole.set(1, 0, 0);
  }
  _pole.normalize();

  const a = (l1 * l1 - l2 * l2 + dc * dc) / (2 * dc);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  outJoint.copy(root).addScaledVector(_axis, a).addScaledVector(_pole, h);
  return outEnd;
}

/**
 * Полный поворот кости: куда смотрит её локальная +Y и куда — локальная +X.
 *
 * Существует потому, что aim() задаёт только одну ось, а разворот вокруг неё
 * оставляет на усмотрение setFromUnitVectors. Для капсулы руки это неважно —
 * она симметрична. Для груди и головы важно решающе: к груди прикручены шары
 * плеч, к голове морда, и с одной лишь осью Y они замирали в мировых
 * координатах. Боец разворачивался, а плечи и лицо оставались смотреть
 * в одну и ту же сторону — тело от этого и читалось деревянным.
 *
 * sideways ортогонализуется к up, так что передавать можно живой вектор
 * между частицами, не выпрямляя его заранее.
 */
export function orient(up, sideways, out = new THREE.Quaternion()) {
  _up.copy(up);
  if (_up.lengthSq() < 1e-10) _up.copy(UP);
  _up.normalize();

  _side.copy(sideways).addScaledVector(_up, -sideways.dot(_up));
  if (_side.lengthSq() < 1e-10) {
    // Плечи сложились в одну точку — берём любую ось поперёк, лишь бы
    // базис не выродился и кость не схлопнулась в ноль.
    _side.set(1, 0, 0).addScaledVector(_up, -_up.x);
    if (_side.lengthSq() < 1e-10) _side.set(0, 0, 1).addScaledVector(_up, -_up.z);
  }
  _side.normalize();

  _fwd.crossVectors(_side, _up);
  _basis.makeBasis(_side, _up, _fwd);
  return out.setFromRotationMatrix(_basis);
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
  computePose(pose, 0, 0, 0, 0, ClubRestReach, 0, 0, 0, 0);
  solveRestJoints(pose);
  return pose;
}

/**
 * Досчитать суставы для уже готовой позы. Вынесено отдельно, потому что
 * в игре это делает PoseDriver (ему нужны ещё и подтянутые кисти),
 * а сборщику тела и ragdoll'у хватает статичной стойки.
 */
export function solveRestJoints(pose) {
  solveTwoBone(pose.shoulderRight, pose.handRight, UpperArmLength, ForeArmLength,
    ARM_POLE_RIGHT, pose.elbowRight, pose.handRight);
  solveTwoBone(pose.shoulderLeft, pose.handLeft, UpperArmLength, ForeArmLength,
    ARM_POLE_LEFT, pose.elbowLeft, pose.handLeft);
  solveTwoBone(pose.hipLeft, pose.footLeft, ThighLength, ShinLength,
    LEG_POLE, pose.kneeLeft, pose.footLeft);
  solveTwoBone(pose.hipRight, pose.footRight, ThighLength, ShinLength,
    LEG_POLE, pose.kneeRight, pose.footRight);
  return pose;
}
