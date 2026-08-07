import * as THREE from 'three';
import { tuning as T } from 'tk/tuning.js';
import { clamp, clamp01 } from 'tk/mathx.js';
import * as Rig from 'tk/fighterRig.js';

// Физическое тело бойца. Симулируется ВСЕГДА — деления на «под управлением»
// и «тряпку» больше нет.
//
// Частицы Верле со связями по расстоянию держат скелет, а позу держат
// «мышцы»: пружины, тянущие каждую частицу к её цели. Цель считает
// fighterRig.computePose — та же формула, что раньше писала кости напрямую.
// Разница в одном слове: раньше поза БЫЛА результатом, теперь она ЦЕЛЬ,
// а результат добывается физикой.
//
// Из этой одной механики вырастает половина роадмапа: баланс — это общая
// сила мышц, урон по частям тела — сила мышц конечности, усталость —
// скорость её восстановления, падение — сила, дошедшая до нуля.
//
// Почему это не повторение неудачи Unity-версии. Там пружины дрались
// с ConfigurableJoint от PhysX: замкнутая петля двуручного хвата, стабильность
// решателя вне моего контроля и отдельный корень-капсула поверх тряпки —
// две конкурирующие правды об одном теле. Здесь решатель свой, хват
// одноручный, а корень остаётся авторитетным: ввод мгновенно двигает цель,
// тело её догоняет. Отсюда и требуемое ощущение — отзывчиво, но телом
// чуть позже.

// Индексы частиц. Порядок фиксирован — по нему собираются связи, цели и кости.
export const P = {
  Head: 0, Chest: 1, Hips: 2,
  HipL: 3, KneeL: 4, FootL: 5,
  HipR: 6, KneeR: 7, FootR: 8,
  ShoulderR: 9, ElbowR: 10, HandR: 11,
  ShoulderL: 12, ElbowL: 13, HandL: 14,
  ClubTip: 15,
};
const COUNT = 16;
export const PARTICLE_COUNT = COUNT;

// Радиусы для касания настила и массы для решателя. Голова лёгкая, грудь
// тяжёлая, дубина весит как нога — от этого зависит, что кого тащит.
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

// Сила мышцы у каждой частицы. Таз и корпус держат позу жёстко — на них
// стоит вся стойка; кисть и дубина мягкие, чтобы у оружия читался вес,
// а рука за ним тянулась, а не телепортировалась.
//
// Голова и плечи держат себя слабее прочего намеренно. Держи они позу так же
// крепко, как таз, — вся верхняя часть шла бы за целью кадр в кадр, и физика
// сверху не добавляла бы ничего: замерено, скрут корпуса за разворот на 180°
// составлял 3.6 градуса. Геометрически они всё равно никуда не денутся,
// их держат связи голова↔плечи и раскос голова↔таз.
const MUSCLE = [
  0.40, 1.00, 1.30,
  1.20, 0.85, 1.00,
  1.20, 0.85, 1.00,
  0.55, 0.55, 0.70,
  0.55, 0.55, 0.70,
  0.45,
];

/** Масса набалдашника, когда дубина убрана: почти ничего. */
const CLUB_OFF_MASS = 0.25;

// Ядро: частицы, которым локомоция задаёт скорость напрямую. Всё остальное
// тянется за ними мышцами и связями — отсюда и берётся отставание корпуса
// от направления движения, которого требует замысел.
const CORE = [P.Hips, P.HipL, P.HipR, P.Chest];

// Связи скелета. Кроме очевидных костей есть раскосы по корпусу:
// без них тело складывается пополам и выглядит мешком, а не человеком.
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
  // Дубина висит на одной правой кисти: хват одноручный.
  [P.HandR, P.ClubTip],
];

const _v = new THREE.Vector3();
const _side = new THREE.Vector3();
const _center = new THREE.Vector3();
const _rot = new THREE.Quaternion();
const _dir = new THREE.Vector3();
const AXIS_Y = new THREE.Vector3(0, 1, 0);

/**
 * Разложить позу по частицам. Одно место на весь файл: и опорная стойка,
 * и цели мышц каждый кадр берутся отсюда, поэтому разъехаться не могут.
 *
 * out обязан быть уже заполнен векторами, и значения именно КОПИРУЮТСЯ.
 * Первая версия принимала колбэк и складывала в out то, что он вернёт, —
 * а возвращал он общий временный вектор. В итоге цели левого и правого
 * бедра оказывались одним объектом, преобразование в мир применялось к нему
 * дважды и накапливалось каждый кадр: боец уезжал сам по себе на шесть
 * метров за три секунды, ни на что при этом не реагируя.
 */
function fillFromPose(out, pose) {
  out[P.Head].copy(pose.head);
  out[P.Chest].copy(pose.chest);
  out[P.Hips].copy(pose.hips);
  out[P.HipL].copy(pose.hipLeft);
  out[P.HipR].copy(pose.hipRight);
  out[P.KneeL].copy(pose.kneeLeft);
  out[P.KneeR].copy(pose.kneeRight);
  out[P.FootL].copy(pose.footLeft);
  out[P.FootR].copy(pose.footRight);
  out[P.ShoulderR].copy(pose.shoulderRight);
  out[P.ShoulderL].copy(pose.shoulderLeft);
  out[P.ElbowR].copy(pose.elbowRight);
  out[P.ElbowL].copy(pose.elbowLeft);
  out[P.HandR].copy(pose.handRight);
  out[P.HandL].copy(pose.handLeft);
  // Набалдашник — вдоль оси дубины от её центра.
  out[P.ClubTip].copy(pose.club).addScaledVector(pose.clubDir, Rig.ClubHeadLocal.y);
  return out;
}

function newPoints() {
  const out = [];
  for (let i = 0; i < COUNT; i++) out.push(new THREE.Vector3());
  return out;
}

const REST = fillFromPose(newPoints(), Rig.restPose());
const LINK_LENGTH = LINKS.map(([a, b]) => REST[a].distanceTo(REST[b]));

export class Body {
  constructor(arena) {
    this.arena = arena;
    this.pos = newPoints();
    this.prev = newPoints();
    this.target = newPoints();
    this.prevTarget = newPoints();
    this.local = newPoints();
    this.invMass = [];
    for (let i = 0; i < COUNT; i++) this.invMass.push(1 / MASS[i]);
    this.restLength = LINK_LENGTH.slice();

    /** 0..1 — насколько мышцы держат позу. Ноль означает тряпку. */
    this.strength = 1;
    /** Диагностика: максимальное растяжение связи за последний шаг, метры. */
    this.maxStretch = 0;
  }

  // ------------------------------------------------------------------ старт

  /** Поставить тело в стойку: спавн и полный сброс. */
  reset(x, z, yaw) {
    fillFromPose(this.local, Rig.restPose());
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    for (let i = 0; i < COUNT; i++) {
      const l = this.local[i];
      this.pos[i].set(x + l.x * cos + l.z * sin, l.y, z - l.x * sin + l.z * cos);
      this.prev[i].copy(this.pos[i]);
      this.target[i].copy(this.pos[i]);
      this.prevTarget[i].copy(this.pos[i]);
    }
    this.strength = 1;
    this.maxStretch = 0;
  }

  // ------------------------------------------------------------------- цели

  /**
   * Разложить локальную позу в мировые цели мышц.
   *
   * Опора по горизонтали — сам таз тела, а не отдельно интегрируемая точка.
   * Будь у цели своя позиция, она могла бы уехать от тела сколь угодно далеко
   * (боец во что-то упёрся, а цель ушла), и мышцы растягивались бы
   * бесконечно. Привязка к собственному тазу означает, что мышцы держат
   * ФОРМУ и высоту, а не тащат бойца к «правильной» точке мира.
   */
  setTargets(pose, yaw) {
    const hips = this.pos[P.Hips];

    // Опора по высоте — уровень настила, а НЕ текущая высота таза.
    // Соблазнительно привязать её к телу, но тогда цель едет вниз вместе
    // с проседающим тазом, восстанавливающей силы не остаётся вовсе,
    // и боец просто складывается на пол — что и произошло с первой версией.
    //
    // За кромкой опоры нет, и там цель обязана падать вместе с телом:
    // иначе сбитого тянуло бы обратно наверх резиновым тросом.
    const baseY = this.arena.isOverDeck(hips.x, hips.z, 0.4)
      ? 0
      : hips.y - Rig.HipsY;

    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    fillFromPose(this.local, pose);

    // Прошлая цель нужна демпферу: он гасит скорость относительно неё,
    // а не абсолютную, иначе идущее тело тормозит само себя.
    for (let i = 0; i < COUNT; i++) this.prevTarget[i].copy(this.target[i]);

    for (let i = 0; i < COUNT; i++) {
      const l = this.local[i];
      this.target[i].set(
        hips.x + l.x * cos + l.z * sin,
        baseY + l.y,
        hips.z - l.x * sin + l.z * cos
      );
    }

    // Таз и есть опора, поэтому по горизонтали его цель обязана совпадать
    // с ним самим. Любое ненулевое смещение здесь стало бы постоянной тягой
    // в одну сторону, и боец медленно уезжал бы сам.
    this.target[P.Hips].x = hips.x;
    this.target[P.Hips].z = hips.z;
  }

  // ----------------------------------------------------------------- физика

  step(dt) {
    // Без дубины набалдашник остаётся в скелете, но почти невесомым: он
    // болтается под кистью и ничего не тянет. Выкидывать частицу целиком
    // значило бы пересобирать связи и их длины прямо на ходу, а так
    // оружие возвращается одним переключателем.
    this.invMass[P.ClubTip] = 1 / (T.withClub ? MASS[P.ClubTip] : CLUB_OFF_MASS);

    const keep = Math.pow(1 - clamp01(T.ragdollDrag), dt);
    const g = T.gravity * dt * dt;
    const strength = clamp01(this.strength);
    const stiff = T.muscleStiffness * strength;
    // Демпфер задаётся ДОЛЕЙ от критического, а не абсолютным числом.
    // Абсолютный жил своей жизнью: стоило тронуть жёсткость, и тело
    // из вязкого становилось дребезжащим или наоборот. В долях две ручки
    // независимы — жёсткость отвечает за скорость, демпфер за отыгрыш.
    // Единица — критическое демпфирование, тело приходит к цели без
    // перелёта. Меньше единицы — проскакивает и качается обратно,
    // из этого и получается желе.
    const damp = 2 * Math.sqrt(Math.max(0, stiff)) * T.muscleDamping;
    // Вес, который мышца несёт сама. Без этого жёсткость и желейность
    // оказывались одной ручкой: слабая пружина уравновешивает вес НИЖЕ
    // цели, и боец вместе с мягкостью получал сутулость — замерено,
    // при жёсткости 200 таз проседал с 0.85 до 0.74. Компенсация идёт
    // через strength, поэтому сбитый боец её теряет и честно падает.
    const lift = -T.gravity * strength * clamp01(T.muscleLift);
    const maxAccel = T.muscleMaxAccel;
    const dt2 = dt * dt;

    for (let i = 0; i < COUNT; i++) {
      const p = this.pos[i];
      const q = this.prev[i];

      const vx = (p.x - q.x) * keep;
      const vy = (p.y - q.y) * keep;
      const vz = (p.z - q.z) * keep;

      let ax = 0;
      let ay = 0;
      let az = 0;

      if (stiff > 0) {
        const t = this.target[i];
        const o = this.prevTarget[i];
        // Хват вынесен в настройку: от него зависит, насколько тяжело
        // ощущается оружие. Слабый — дубина волочится и не долетает
        // до соперника, сильный — идёт за рукой как приклеенная.
        const m = i === P.ClubTip ? MUSCLE[i] * T.clubGrip : MUSCLE[i];
        const k = stiff * m;
        const d = damp * Math.sqrt(m);

        // Демпфер гасит скорость ОТНОСИТЕЛЬНО цели, а не абсолютную.
        // Это не тонкость, а условие того, что боец вообще может ходить:
        // абсолютный демпфер тормозил всё тело как в смоле и съедал 43%
        // скорости каждый шаг — локомоция задавала четыре метра в секунду,
        // а получалось семнадцать сантиметров.
        ax = (t.x - p.x) * k - (vx - (t.x - o.x)) / dt * d;
        // Вес мышца несёт полностью, а не в долю своей силы: иначе слабые
        // места вроде головы просаживались бы, и связка «мягче = ниже»
        // вернулась бы через чёрный ход. Набалдашник — исключение,
        // он обязан висеть по-настоящему, в этом весь смысл оружия.
        ay = (t.y - p.y) * k - (vy - (t.y - o.y)) / dt * d
          + (i === P.ClubTip ? 0 : lift);
        az = (t.z - p.z) * k - (vz - (t.z - o.z)) / dt * d;

        // Потолок ускорения — единственное, что стоит между жёсткой мышцей
        // и взрывом решателя. Сбитого уносит на метры, и без клампа мышца
        // ответила бы на такую ошибку рывком, которого Верле не переживёт.
        const a = Math.sqrt(ax * ax + ay * ay + az * az);
        if (a > maxAccel) {
          const s = maxAccel / a;
          ax *= s; ay *= s; az *= s;
        }
      }

      q.copy(p);
      p.set(
        p.x + vx + ax * dt2,
        p.y + vy + g + ay * dt2,
        p.z + vz + az * dt2
      );
    }

    this.groundResponse(dt);

    const iterations = Math.max(1, Math.round(T.ragdollIterations));
    this.maxStretch = 0;
    for (let k = 0; k < iterations; k++) {
      this.solveLinks(k === iterations - 1);
      this.clampGround();
    }
  }

  solveLinks(measure) {
    const relax = clamp01(T.linkStiffness);
    for (let i = 0; i < LINKS.length; i++) {
      const a = LINKS[i][0];
      const b = LINKS[i][1];
      const pa = this.pos[a];
      const pb = this.pos[b];

      _v.copy(pb).sub(pa);
      const dist = _v.length();
      if (dist < 1e-6) continue;

      const rest = this.restLength[i];
      if (measure) this.maxStretch = Math.max(this.maxStretch, Math.abs(dist - rest));

      const wa = this.invMass[a];
      const wb = this.invMass[b];
      // Коррекция делится обратно пропорционально массе: лёгкую кисть
      // дёргает сильнее, чем грудь.
      //
      // linkStiffness — доля ошибки, снимаемая за один проход. При единице
      // скелет жёсткий как проволока: шесть проходов сводят растяжение
      // в ноль, и тело не проминается вообще ни от чего. Это и читается
      // деревянностью. Ниже единицы связь остаётся слегка растянутой,
      // и тело проминается и отыгрывает обратно.
      const c = ((dist - rest) / dist) / (wa + wb) * relax;
      pa.addScaledVector(_v, c * wa);
      pb.addScaledVector(_v, -c * wb);
    }
  }

  /** Реакция настила: трение и отскок. Один раз за шаг. */
  groundResponse(dt) {
    const friction = 1 - Math.pow(1 - clamp01(T.ragdollFriction), dt);
    const bounce = clamp01(T.ragdollBounce);

    for (let i = 0; i < COUNT; i++) {
      const p = this.pos[i];
      if (p.y >= RADIUS[i]) continue;
      // Опоры нет за кромкой — именно поэтому сбитый и улетает вниз.
      if (!this.arena.isOverDeck(p.x, p.z)) continue;

      const q = this.prev[i];
      const vy = p.y - q.y;
      q.x += (p.x - q.x) * friction;
      q.z += (p.z - q.z) * friction;
      if (vy < 0) q.y = p.y + vy * bounce;
    }
  }

  /** Выталкивание из настила. Внутри решателя — только позиции. */
  clampGround() {
    for (let i = 0; i < COUNT; i++) {
      const p = this.pos[i];
      if (p.y >= RADIUS[i]) continue;
      if (!this.arena.isOverDeck(p.x, p.z)) continue;
      const q = this.prev[i];
      const shift = RADIUS[i] - p.y;
      p.y = RADIUS[i];
      // Прошлая позиция едет следом, иначе выталкивание читается
      // как скорость вверх и тело подпрыгивает на ровном месте.
      q.y += shift;
    }
  }

  // --------------------------------------------------------------- движение

  /**
   * Задать ядру горизонтальную скорость. Конечности подтягиваются мышцами
   * и связями сами — из этого запаздывания и берётся вес походки.
   */
  drive(vx, vz, rate, dt) {
    const step = rate * dt;
    for (const i of CORE) {
      const p = this.pos[i];
      const q = this.prev[i];
      const cx = (p.x - q.x) / dt;
      const cz = (p.z - q.z) / dt;

      const dx = vx - cx;
      const dz = vz - cz;
      const len = Math.hypot(dx, dz);
      const s = len > step && len > 1e-6 ? step / len : 1;

      q.x = p.x - (cx + dx * s) * dt;
      q.z = p.z - (cz + dz * s) * dt;
    }
  }

  /** Толчок в конкретную частицу — так прилетает удар по месту. */
  push(index, impulse, dt) {
    this.prev[index].addScaledVector(impulse, -dt);
  }

  /** Толчок всему телу, с добавкой избранным частицам. */
  pushAll(impulse, dt, extraIndices, extraScale) {
    for (let i = 0; i < COUNT; i++) this.prev[i].addScaledVector(impulse, -dt);
    if (!extraIndices) return;
    for (const i of extraIndices) this.prev[i].addScaledVector(impulse, -dt * extraScale);
  }

  // -------------------------------------------------------------- состояние

  /** Средняя скорость тела. По ней видно, что боец успокоился. */
  speed(dt) {
    let sum = 0;
    for (let i = 0; i < COUNT; i++) sum += this.pos[i].distanceTo(this.prev[i]);
    return sum / COUNT / Math.max(1e-5, dt);
  }

  /** Насколько тело сейчас стоит: 1 — вертикально, 0 — лежит. */
  uprightness() {
    _v.copy(this.pos[P.Head]).sub(this.pos[P.Hips]);
    const len = _v.length();
    return len < 1e-5 ? 0 : clamp(_v.y / len, 0, 1);
  }

  lowestY() {
    let y = Infinity;
    for (let i = 0; i < COUNT; i++) y = Math.min(y, this.pos[i].y);
    return y;
  }

  // ------------------------------------------------------------------ кости

  /**
   * Разложить частицы в кости. Единственный способ, которым тело рисуется.
   *
   * Таз, грудь и голова разворачиваются по полному базису, а не по одной оси.
   * Разница не косметическая: к груди прикручены шары плеч, к голове — морда,
   * и пока поворот брался из aim(голова − грудь), разворот вокруг вертикали
   * оставался никаким. Плечи и лицо застывали в мировых координатах — боец
   * поворачивался, а они смотрели всё туда же.
   *
   * headTurn — единственная величина, приходящая не из частиц. Голова у нас
   * одна точка, а у точки нет разворота, поэтому доворот лица приходится
   * задавать снаружи. Всё остальное по-прежнему выводится из тела.
   */
  writeBones(bones, headTurn = 0) {
    const p = this.pos;

    // Поперечная ось таза — линия бёдер, груди — линия плеч. Отсюда
    // и берётся видимый скрут корпуса.
    _side.copy(p[P.HipR]).sub(p[P.HipL]);
    Rig.orient(_v.copy(p[P.Chest]).sub(p[P.Hips]), _side, _rot);
    bones.hips.position.copy(p[P.Hips]);
    bones.hips.quaternion.copy(_rot);

    _side.copy(p[P.ShoulderR]).sub(p[P.ShoulderL]);
    _v.copy(p[P.Head]).sub(p[P.Chest]);
    Rig.orient(_v, _side, _rot);
    bones.chest.position.copy(p[P.Chest]);
    bones.chest.quaternion.copy(_rot);

    // Голова доворачивается от линии плеч: смотреть она может и не туда,
    // куда развёрнут корпус.
    if (headTurn !== 0) {
      const s = Math.sin(headTurn);
      const c = Math.cos(headTurn);
      const x = _side.x * c + _side.z * s;
      _side.z = -_side.x * s + _side.z * c;
      _side.x = x;
    }
    Rig.orient(_v, _side, _rot);
    bones.head.position.copy(p[P.Head]);
    bones.head.quaternion.copy(_rot);

    limbTo(bones.legLUpper, p[P.HipL], p[P.KneeL]);
    limbTo(bones.legLLower, p[P.KneeL], p[P.FootL]);
    limbTo(bones.legRUpper, p[P.HipR], p[P.KneeR]);
    limbTo(bones.legRLower, p[P.KneeR], p[P.FootR]);
    limbTo(bones.armRUpper, p[P.ShoulderR], p[P.ElbowR]);
    limbTo(bones.armRFore, p[P.ElbowR], p[P.HandR]);
    limbTo(bones.armLUpper, p[P.ShoulderL], p[P.ElbowL]);
    limbTo(bones.armLFore, p[P.ElbowL], p[P.HandL]);

    // Стопы держатся горизонтально и смотрят туда же, куда таз: ботинок,
    // кувыркающийся вокруг щиколотки, читается как поломка.
    //
    // Направление берётся из линии бёдер, а не из наклона корпуса. Наклон —
    // это несколько сантиметров в произвольную сторону, и atan2 от них
    // выдавал стопам случайный разворот на каждом кадре.
    _v.copy(p[P.HipR]).sub(p[P.HipL]);
    _v.y = 0;
    const footYaw = _v.lengthSq() > 1e-8 ? Math.atan2(_v.x, _v.z) - Math.PI / 2 : 0;
    bones.footL.position.copy(p[P.FootL]);
    bones.footL.quaternion.setFromAxisAngle(AXIS_Y, footYaw);
    bones.footR.position.copy(p[P.FootR]);
    bones.footR.quaternion.setFromAxisAngle(AXIS_Y, footYaw);

    // Дубина: ось от кисти к набалдашнику, центр — на длине хвата.
    _dir.copy(p[P.ClubTip]).sub(p[P.HandR]);
    Rig.aim(_dir, _rot);
    if (_dir.lengthSq() > 1e-8) _dir.normalize();
    bones.club.position.copy(p[P.HandR]).addScaledVector(_dir, Rig.ClubGripOffset);
    bones.club.quaternion.copy(_rot);
  }
}

function limbTo(bone, from, to) {
  Rig.limb(from, to, _center, _rot);
  bone.position.copy(_center);
  bone.quaternion.copy(_rot);
}
