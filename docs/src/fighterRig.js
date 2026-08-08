import * as THREE from 'three';
import { DEG, clamp } from 'tk/mathx.js';
import { tuning as T } from 'tk/tuning.js';
import { S, CLUB } from 'tk/skeleton.js';

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
// Руки и ноги — ЦЕЛЬНЫЕ. Это не упрощение, а требование выкройки: и рука,
// и нога там по одной трапеции, гнуть их негде. Отсюда правило, которому
// подчинён весь файл: конец кости всегда ровно на её длину от корня.
// Не «примерно», не «подтянуть к границе досягаемости» — ровно.
//
// Из этого правила растёт и вся походка. Высота таза не константа,
// а следствие того, куда походка поставила опору: чем дальше вынесена
// стопа, тем ниже таз. Перевалиться на опорную ногу приходится по той же
// причине — маховой ноге нечем подобраться, чтобы пронестись над настилом.

// Размеры больше не живут здесь. Они приходят из скелета (skeleton.js),
// который собирает их из таблицы пропорций — клеток выкройки. Этот файл
// оставляет их себе под прежними именами, чтобы остальные модули не знали
// о перемене и продолжали читать Rig.LegLength.
//
// Почему вообще понадобилось разделять. Пропорции были рассыпаны по четырём
// файлам: панели здесь, массы и радиусы в физике, ширина шага в походке.
// Наложить на скелет другое тело значило пройтись по всем четырём — а теперь
// достаточно дописать строчку в BODIES.
export const CM = S.prop.cm;
export const Spring = S.Spring;
export const HeadSize = S.HeadSize;
export const ChestHeight = S.ChestHeight;
export const ChestTopWidth = S.ChestTopWidth;
export const ChestBottomWidth = S.ChestBottomWidth;
export const HipsSize = S.HipsSize;
export const PanelDepth = S.PanelDepth;

export const LegLength = S.LegLength;
export const LegTopWidth = S.LegTopWidth;
export const LegBottomWidth = S.LegBottomWidth;
export const ArmLength = S.ArmLength;
export const ArmTopWidth = S.ArmTopWidth;
export const ArmBottomWidth = S.ArmBottomWidth;

// Конечность снова из ДВУХ половинок, но выглядит по-прежнему цельной:
// трапеция разрезана ровно посередине и раздвинута на зазор, а в просвете
// видна нить. Прямой её держит не форма, а связь-предел через весь размах
// (см. skeleton.js) — и отпускает ровно тогда, когда согнуться необходимо.
export const HalfLeg = S.HalfLeg;
export const HalfArm = S.HalfArm;
export const LegMidWidth = S.LegMidWidth;
export const ArmMidWidth = S.ArmMidWidth;
export const ArmSpan = S.ArmSpan;

export const FootY = S.FootY;
export const HipJointY = S.HipJointY;
export const HipsY = S.HipsY;
export const ChestY = S.ChestY;
export const ShoulderY = S.ShoulderY;
export const NeckY = S.NeckY;
export const HeadY = S.HeadY;
export const HeadRadius = S.HeadRadius;
export const Height = S.Height;

export const HipHalfWidth = S.HipHalfWidth;
export const ShoulderHalfWidth = S.ShoulderHalfWidth;

/**
 * Высота, на которой держат рукоять. Дубина считается от хвата, а не наоборот:
 * хват — это место, куда должны дотянуться кисти, и он обязан быть достижимым.
 */
export const GripY = S.GripY;
// Оружие — не часть тела: одна дубина на любую куклу, размеры её в CLUB.
export const ClubRestReach = CLUB.restReach;
/** Насколько центр дубины вынесен от хвата вперёд по её оси. */
export const ClubGripOffset = CLUB.gripOffset;
/** Набалдашник — вдоль локальной оси Y дубины. Им и бьют. */
export const ClubHeadLocal = CLUB.headLocal;
export const ClubHeadRadius = CLUB.headRadius;
export const ClubLength = CLUB.length;
export const ClubRadius = CLUB.radius;


// Полюса: куда сгибается сустав, когда сгибаться приходится.
//
// Они возвращены вместе с изломом конечности, но в другом качестве. Раньше
// полюс работал всегда, и IK честно сгибала ногу под любую цель — оттого
// «цельная» кость и выходила согнутой. Теперь сгиб включается ТОЛЬКО когда
// конец ближе полной длины: стоящий боец распрямлён, и полюс на него никак
// не влияет. Он вступает в дело, когда стопа оказалась выше настила
// и выпрямиться уже нельзя.
//
// Колено вперёд, локоть вниз и чуть наружу. Наружу у локтя немного: было
// столько же, сколько вниз, и в стойке с руками перед корпусом локти
// расходились в стороны крыльями.
const ARM_POLE_RIGHT = new THREE.Vector3(0.5, -1, -0.25).normalize();
const ARM_POLE_LEFT = new THREE.Vector3(-0.5, -1, -0.25).normalize();
const LEG_POLE = new THREE.Vector3(0, -0.1, 1).normalize();
const _pole = new THREE.Vector3();
const _axis = new THREE.Vector3();

export const armPole = (right) => (right ? ARM_POLE_RIGHT : ARM_POLE_LEFT);
export const legPole = () => LEG_POLE;

const UP = new THREE.Vector3(0, 1, 0);
const _delta = new THREE.Vector3();
const _up = new THREE.Vector3();
const _side = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _basis = new THREE.Matrix4();

// FreeHandHalfWidth / FreeHandY больше нет: они держали кисть у бедра,
// то есть задавали ровно ту позу «руки по швам», от которой мы уходим.
// Положение кистей в стойке теперь в настройках — guardOut и guardForward,
// и оба безразмерные: это направление от плеча, а не точка в метрах.

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
  const legOut = HipHalfWidth + T.limbOffset;
  const hipSide = sway * 0.02;
  const hipFwd = lean * 0.02;

  // Высоту таза задаёт ОПОРНАЯ НОГА, а не константа.
  //
  // Это главное, чем поза цельных костей отличается от позы на суставах.
  // Нога — одна деталь, гнуться ей негде, значит расстояние от бедра
  // до стопы всегда ровно LegLength. Стоит потребовать от таза высоту,
  // которой при таком выносе стопы быть не может, и решатель начинает
  // каждый кадр выталкивать таз по сфере вокруг прибитой к настилу стопы.
  // У выталкивания по сфере есть боковая составляющая, и она копится:
  // замерено, что при постоянном расхождении 7.7 см боец уезжал сам
  // на 5.7 метра за шесть секунд и разгонялся выше заданного предела.
  //
  // Поэтому высота считается из геометрии: чем дальше вынесена опора,
  // тем ниже таз. Так задаром получается вся вертикальная раскачка ходьбы —
  // таз поднимается, когда проходит над стопой, и проседает на разножке.
  const pelvis = solvePelvis(footL, footR, legOut, hipSide, hipFwd, ride(stride));
  const roll = pelvis.roll;
  const rs = Math.sin(roll);
  const rc = Math.cos(roll);
  const base = pelvis.base;
  const drop = HipJointY - base;

  // Смещения намеренно разные по высоте: наклоны корпуса нигде не задаются
  // явно, PoseDriver выводит их из направлений таз→грудь и грудь→голова.
  // Поэтому «завалить тело» здесь означает просто развести эти точки вбок
  // на разную величину — и тело заваливается само, оставаясь связным.
  pose.hips.set(sway * 0.02, HipsY + bob - drop, lean * 0.02);
  pose.chest.set(sway * 0.10, ChestY + bob - drop, lean * 0.12);
  pose.head.set(sway * 0.22, HeadY + bob - drop, lean * 0.20);

  // Плечи живут между грудью и головой и качаются вместе с ними.
  const shoulderSide = sway * 0.16;
  const shoulderFwd = lean * 0.16;
  const armOut = ShoulderHalfWidth + T.limbOffset;
  pose.shoulderRight.set(armOut + shoulderSide, ShoulderY + bob - drop, shoulderFwd);
  pose.shoulderLeft.set(-armOut + shoulderSide, ShoulderY + bob - drop, shoulderFwd);

  // Тазобедренные суставы едут вместе с тазом — иначе подсед их оторвёт.
  pose.hipRight.set(legOut + hipSide, HipJointY + bob - drop, hipFwd);
  pose.hipLeft.set(-legOut + hipSide, HipJointY + bob - drop, hipFwd);

  // Перекос таза. Всё, что от таза и выше, заваливается вбок как одно целое:
  // поворот — движение жёсткое, длины связей от него не меняются, и тело
  // остаётся связным.
  //
  // Без перекоса цельной ноге негде пронести стопу. Высота бедра над
  // опорой задана длиной ноги, и маховая стопа, проходя под тазом,
  // обязана уйти в настил: у неё нет колена, чтобы подобраться. Человек
  // в лыжных ботинках решает это ровно так же — переваливается на опорную
  // ногу и заносит вторую. Отсюда же и вся походка вразвалку.
  if (roll !== 0) {
    rollX(pose.hips, hipSide, base, rs, rc);
    rollX(pose.chest, hipSide, base, rs, rc);
    rollX(pose.head, hipSide, base, rs, rc);
    rollX(pose.shoulderRight, hipSide, base, rs, rc);
    rollX(pose.shoulderLeft, hipSide, base, rs, rc);
    rollX(pose.hipRight, hipSide, base, rs, rc);
    rollX(pose.hipLeft, hipSide, base, rs, rc);
  }

  // Стопы приходят готовыми: их считает Gait, и считает В МИРЕ, потому что
  // опора обязана стоять на месте, пока тело идёт над ней. Здесь они уже
  // переведены в систему тела — формуле от фазы шага их отдавать нельзя,
  // иначе опора снова поедет за тазом и шаг опять станет косметикой.
  //
  // По горизонтали стопа ставится ровно туда, куда её поставила походка,
  // а вот высоту ей досчитывает нога: она цельная, и другой высоты у стопы
  // при таком выносе просто нет. Дуга подъёма из походки здесь не нужна —
  // маховая стопа поднимается сама, потому что таз перевалился на опорную.
  //
  // Формула остаётся только для опорной стойки, из которой собирается
  // скелет: там шага нет вовсе.
  const phaseL = stepPhase * Math.PI * 2;
  if (footL) {
    hangFoot(pose.footLeft, footL, pose.hipLeft);
    hangFoot(pose.footRight, footR, pose.hipRight);
  } else {
    const half = HipHalfWidth + T.stanceWidth;
    foot(pose.footLeft, -half, phaseL, stride, lift);
    foot(pose.footRight, half, phaseL + Math.PI, stride, lift);
  }

  const a = clubAngleDeg * DEG;
  const flatX = Math.sin(a);
  const flatZ = Math.cos(a);

  // Хват выносится по горизонтали — там, где кисти действительно окажутся.
  const anchorY = GripY + bob - drop + clubHeight;
  pose.grip.set(flatX * clubReach, anchorY, lean * 0.12 + flatZ * clubReach);

  // Руки в стойке держатся ПЕРЕД телом, а не висят по швам. Опущенные вдоль
  // корпуса руки — это поза человека в очереди, а не бойца; по ней вообще
  // не читается, что он собирается драться.
  //
  // Кисти качаются в противофазе своим ногам: вынесена левая нога — вперёд
  // идёт правая рука. Без этого руки едут вдоль тела досками и выдают всю
  // походку.
  const swing = Math.cos(phaseL) * T.armSwing * stride / Math.max(1e-4, ArmLength);
  guardHand(pose.handRight, pose.shoulderRight, 1, lean, swing);
  guardHand(pose.handLeft, pose.shoulderLeft, -1, lean, -swing);
  if (roll !== 0) rollX(pose.grip, hipSide, base, rs, rc);

  // Дубина всегда в одной и той же руке — правой. Ни перехвата между
  // ударами, ни подхвата второй рукой на тяжёлом замахе: боец правша,
  // и это его свойство, а не следствие геометрии позы.
  //
  // Раньше держащая рука выбиралась по знаку grip.x, то есть менялась
  // вместе со стороной дуги, и оружие перекладывалось из руки в руку
  // после каждого удара.
  if (T.withClub) pose.handRight.set(pose.grip.x, pose.grip.y, pose.grip.z);

  // Кисть — ровно на длину руки от плеча. Рука тоже одна деталь, и всё,
  // что сказано про ногу, верно и здесь: цель, до которой рука не достаёт,
  // это не «почти дотянулся», а постоянная тяга мышцы в одну сторону
  // и связи в другую. Хват после этого берётся у кисти, а не наоборот:
  // держит оружие рука, а не оружие руку.
  onSphere(pose.shoulderRight, pose.handRight, ArmLength);
  onSphere(pose.shoulderLeft, pose.handLeft, ArmLength);
  if (T.withClub) pose.grip.copy(pose.handRight);

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

// --------------------------------------------------------------- цельная нога
//
// Всё, что ниже, существует ради одного свойства: нога — ОДНА деталь.
// Расстояние от бедра до стопы не «примерно длина ноги», а ровно она,
// всегда. Любое место, где поза просит другого, немедленно превращается
// в постоянную драку с решателем, а драка с решателем на прибитой к настилу
// стопе — это самоход.

/** На какой высоте обязано быть бедро, чтобы прямая нога достала до этой стопы. */
function hipNeed(foot, hipX, hipZ) {
  const d = Math.min(Math.hypot(foot.x - hipX, foot.z - hipZ), LegLength - 1e-3);
  return foot.y + Math.sqrt(LegLength * LegLength - d * d);
}

/** Предел перекоса: синус угла. 0.35 — это 20 градусов. */
const MAX_LIST = 0.35;

/**
 * Глубже этого таз не проседает, что бы ни делали ноги.
 *
 * Страховка, а не настройка: при исправной походке опора не успевает уехать
 * так далеко. Нужна потому, что просадка — это положительная обратная связь.
 * Уехала опора — цель таза ниже — мышца тянет таз вниз — прямая нога
 * переводит падение в ход вперёд — опора уезжает ещё дальше. Замерено,
 * во что это выливается без предела: 3.5 м/с при заданных 1.7 и подскоки
 * корпуса на три с лишним метра.
 */
const MAX_DIP = () => LegLength * 0.14;

/**
 * Насколько таз НЕ доходит до полного выпрямления ноги.
 *
 * Без этого он на середине опоры въезжает на самый верх дуги, а на разножке
 * падает на её низ, и получается подпрыгивание в 11 сантиметров на каждом
 * шаге. Человек гасит его тем же способом — на середине опоры колено чуть
 * согнуто, — и нам он стал доступен ровно тогда, когда у ноги появился излом.
 */
const RIDE = () => LegLength * 0.05;

/**
 * Подсед включается только на ходу.
 *
 * Стоящему он не нужен и вреден: цель таза уходит ниже, чем даёт прямая
 * нога, и получается ровно то постоянное расхождение, из-за которого боец
 * когда-то уезжал сам. Замерено: 3.2 см расхождения стоя и уезд с 2 до 12 см.
 */
function ride(stride) {
  const full = Math.max(1e-4, T.stepLength * LegLength);
  return RIDE() * clamp(stride / full, 0, 1);
}

const _pelvis = { base: 0, roll: 0 };

/**
 * Высота и перекос таза. Оба — не выбор, а следствие.
 *
 * Каждая нога требует своей высоты бедра: чем дальше вынесена её стопа,
 * тем ниже. Требования разные, а таз один — значит он обязан ВСТАТЬ
 * НАКОСО, и ровно так, чтобы оба требования выполнились разом. Отсюда
 * две строчки: высота есть среднее требований, перекос есть их разность.
 *
 * Из этих же двух строчек берётся вся походка. Опорная нога вынесена
 * назад — таз просел. Маховая пошла вверх по дуге — таз перевалился
 * на опорную, приподняв маховое бедро ровно настолько, чтобы стопе
 * было где пронестись. Никакого подскока, никакой раскачки и никакого
 * переваливания задавать отдельно не нужно: они и есть решение.
 *
 * Заметить это стоило нескольких попыток назначить перекос вручную,
 * ползунком. Все они были хуже: назначенный перекос спорит с ногами,
 * а спор с ногой на прибитой стопе — это самоход.
 */
function solvePelvis(footL, footR, legOut, hipSide, hipFwd, sink) {
  const out = _pelvis;
  out.base = HipJointY - T.stanceCrouch;
  out.roll = 0;
  if (!footL || !footR) return out;

  // Настаивает на своей высоте только та нога, что СТОИТ. Чем выше поднята
  // стопа, тем меньше её мнение весит: полностью оторванная не держит ничего
  // и просто соглашается с опорной.
  //
  // Раньше её мнение учитывалось наравне, и дорого за это платилось. Маховая
  // стопа поднята, значит «нужная» высота её бедра выше — таз послушно
  // переваливался на опорную ногу. Пока колена не было, другого способа
  // пронести ногу и не существовало; теперь есть — колено гнётся, маховая
  // нога подбирается сама. Замерено, чем обходилась старая схема: корпус
  // качало на 20 градусов с частотой шага, и это читалось не походкой
  // вразвалку, а тряской.
  //
  // Переход обязан быть ПЛАВНЫМ, и это не косметика. Переключи мнение ноги
  // разом в момент отрыва — и цель таза скакнёт, а мышца ответит на скачок
  // рывком: ровно так и появлялась дрожь на каждом шаге.
  // Переход резкий, но не мгновенный. Резкий потому, что стопа в сантиметре
  // над настилом уже не несёт ничего: держать вес и висеть — состояния
  // без середины. Не мгновенный потому, что скачок цели мышца отыгрывает
  // рывком. Растянуть его на всю высоту подъёма нельзя: замерено, тогда
  // половина мнения поднятой ноги доходит до таза и качание корпуса
  // возвращается — 15 градусов вместо 7.
  const lift = Math.max(1e-4, T.stepLift * LegLength * 0.2);
  const liftL = clamp((footL.y - FootY) / lift, 0, 1);
  const liftR = clamp((footR.y - FootY) / lift, 0, 1);
  if (liftL >= 1 && liftR >= 1) return out;

  let sin = 0;
  // Два прохода: на первом таз ещё стоит ровно и горизонтальный вынос
  // бедра завышен, на втором уже с поправкой на наклон. Третий ничего
  // не меняет — зависимость от косинуса слабая.
  for (let pass = 0; pass < 2; pass++) {
    const cos = Math.sqrt(Math.max(0, 1 - sin * sin));
    const needL = hipNeed(footL, hipSide - legOut * cos, hipFwd);
    const needR = hipNeed(footR, hipSide + legOut * cos, hipFwd);
    // Поднятая нога тем меньше настаивает на своём, чем выше поднята.
    const nL = needL + (needR - needL) * liftL;
    const nR = needR + (needL - needR) * liftR;
    out.base = clamp((nL + nR) * 0.5, HipJointY - MAX_DIP(), HipJointY - sink);
    sin = clamp((nR - nL) / (2 * legOut), -MAX_LIST, MAX_LIST);
  }

  out.roll = Math.asin(sin);
  return out;
}

/**
 * Стопу — на сферу вокруг бедра. По горизонтали она остаётся ровно там,
 * куда её поставила походка; высота у неё не своя, а та единственная,
 * которую позволяет длина ноги.
 */
function hangFoot(out, raw, hip) {
  const dx = raw.x - hip.x;
  const dz = raw.z - hip.z;
  const flat = Math.hypot(dx, dz);
  const d = Math.min(flat, LegLength - 1e-3);
  const k = flat > 1e-6 ? d / flat : 0;
  // Ниже прямой ноги стопе не достать — а ВЫШЕ сколько угодно: колено
  // согнётся. Поэтому берётся большее из двух: куда её поставила походка
  // и куда дотягивается прямая нога. Без этого стопа на ступеньке
  // утыкалась бы в невидимый пол на уровне настила.
  const straight = hip.y - Math.sqrt(LegLength * LegLength - d * d);
  return out.set(hip.x + dx * k, Math.max(raw.y, straight), hip.z + dz * k);
}

/** Завалить точку вбок вокруг оси взгляда: поворот в плоскости XY. */
function rollX(v, cx, cy, sin, cos) {
  const dx = v.x - cx;
  const dy = v.y - cy;
  v.x = cx + dx * cos - dy * sin;
  v.y = cy + dx * sin + dy * cos;
}

/**
 * Конец конечности — ровно на длину кости от её корня.
 *
 * Для цельной кости это не подгонка, а определение. Замерено, к чему
 * приводит пренебрежение: цель кисти в стойке отстояла от плеча на 0.64
 * при руке длиной 0.54 — десять сантиметров, которые мышца тянула
 * в одну сторону, а связь в другую, каждый кадр. Ровно это и читалось
 * как «руки мнутся».
 */
function onSphere(root, end, length) {
  _delta.copy(end).sub(root);
  const d = _delta.length();
  if (d < 1e-6) _delta.set(0, -1, 0);
  else _delta.divideScalar(d);
  return end.copy(root).addScaledVector(_delta, length);
}

/** Поворот вокруг вертикали. Та же формула, по которой поза уходит в мир. */
function twistY(v, sin, cos) {
  const x = v.x * cos + v.z * sin;
  const z = -v.x * sin + v.z * cos;
  v.x = x;
  v.z = z;
}

/**
 * Кисть в стойке — НАПРАВЛЕНИЕМ от плеча, а не точкой в метрах.
 *
 * Длину всё равно задаёт кость: рука цельная, и кисть окажется ровно
 * на ArmLength от плеча, куда её ни целься. Значит осмысленно только
 * направление, и настройки здесь безразмерные — на другом теле метры
 * не значили бы ничего, а доля размаха значит то же самое.
 *
 * @param {number} side  +1 правая, -1 левая
 * @param {number} swing вклад шага: вперёд-назад в противофазе своей ноге
 */
function guardHand(out, shoulder, side, lean, swing) {
  const outward = side * T.guardOut;
  const forward = T.guardForward + lean * 0.08 + swing;
  const flat = outward * outward + forward * forward;
  const down = Math.sqrt(Math.max(0.04, 1 - flat));
  return out.set(
    shoulder.x + outward * ArmLength,
    shoulder.y - down * ArmLength,
    shoulder.z + forward * ArmLength);
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

/**
 * Где встанет сустав между двумя равными половинками.
 *
 * Пока конец на полной длине от корня, ответ — ровно середина отрезка,
 * и конечность прямая. Стоит концу подойти ближе (стопа встала на ступеньку,
 * кисть уткнулась в чужой корпус), и сустав обязан отойти от прямой — иначе
 * половинкам просто не разместиться. Насколько отойти, считает теорема
 * Пифагора, а в какую сторону — полюс.
 *
 * Это та же двухзвенная IK, что была здесь раньше, но с важной разницей:
 * она больше не тянет конец к границе досягаемости и не сгибает ничего
 * по своей воле. Сгиб появляется ровно тогда, когда прямой конечности
 * места не осталось.
 */
export function flexJoint(root, end, half, pole, out) {
  _axis.copy(end).sub(root);
  const d = _axis.length();
  out.copy(root).add(end).multiplyScalar(0.5);
  const sag = Math.sqrt(Math.max(0, half * half - d * d * 0.25));
  if (sag < 1e-4 || d < 1e-5) return out;

  _axis.divideScalar(d);
  // Полюс — поперёк оси конечности: вдоль он ничего не значит.
  _pole.copy(pole).addScaledVector(_axis, -pole.dot(_axis));
  if (_pole.lengthSq() < 1e-8) {
    _pole.set(-_axis.y, _axis.x, 0);
    if (_pole.lengthSq() < 1e-8) _pole.set(1, 0, 0);
  }
  return out.addScaledVector(_pole.normalize(), sag);
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
  // Конец кости отправляется на её полную длину, и это не косметика стойки,
  // а определение длин связей: из этой позы body.js снимает restLength.
  //
  // Пока здесь стояла двухзвенная IK, она честно сгибала конечность под
  // ту цель, которую ей давали, и получалось вот что: половинки ноги
  // по 0.360, а связь бедро↔стопа 0.672 вместо 0.720 по выкройке. Три
  // связи такой длины — это не отрезок, а жёсткий треугольник с намертво
  // согнутым на 13 сантиметров коленом, да ещё и с двумя зеркальными
  // решениями, между которыми он щёлкает. Никакой «цельной кости»
  // в теле при этом не было вовсе.
  onSphere(pose.shoulderRight, pose.handRight, ArmLength);
  onSphere(pose.shoulderLeft, pose.handLeft, ArmLength);
  onSphere(pose.hipLeft, pose.footLeft, LegLength);
  onSphere(pose.hipRight, pose.footRight, LegLength);
  flexJoint(pose.shoulderRight, pose.handRight, HalfArm, ARM_POLE_RIGHT, pose.elbowRight);
  flexJoint(pose.shoulderLeft, pose.handLeft, HalfArm, ARM_POLE_LEFT, pose.elbowLeft);
  flexJoint(pose.hipLeft, pose.footLeft, HalfLeg, LEG_POLE, pose.kneeLeft);
  flexJoint(pose.hipRight, pose.footRight, HalfLeg, LEG_POLE, pose.kneeRight);
  return pose;
}
