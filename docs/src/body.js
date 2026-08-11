import * as THREE from 'three';
import { tuning as T } from 'tk/tuning.js';
import { clamp, clamp01 } from 'tk/mathx.js';
import * as Rig from 'tk/fighterRig.js';
import { S, J, JOINT_COUNT, CLUB } from 'tk/skeleton.js';

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

// Частицы, их массы, радиусы и связи приходят из скелета (skeleton.js).
// Здесь они больше не написаны: физика не должна знать, какое тело на неё
// наложено. Имена оставлены прежними, чтобы остальной код не заметил.
export const P = J;
export const PARTICLE_COUNT = JOINT_COUNT;
const COUNT = JOINT_COUNT;

const RADIUS = S.radius;
const MASS = S.mass;

// Сила мышцы у каждой частицы — роль, а не размер, поэтому она в скелете
// одна на все тела. Корпус держится крепко, дальние концы конечностей
// отпущены и болтаются на своих связях: панель не гнётся и не мнётся,
// гнутся только суставы, и держит их верёвка.
//
// Голова и плечи слабые намеренно. Держи они позу так же крепко, как таз, —
// вся верхняя часть шла бы за целью кадр в кадр, и физика сверху не давала
// бы ничего: замерено, скрут корпуса за разворот на 180° составлял 3.6°.
const MUSCLE = S.muscleSoft;
const MUSCLE_ROPE = S.muscle;

/** Масса набалдашника, когда дубина убрана: почти ничего. */
const CLUB_OFF_MASS = CLUB.offMass;

/** Стопа тела ↔ стопа походки. */
const FOOT_INDEX = [[P.FootL, 0], [P.FootR, 1]];

// Какой ноге принадлежит частица: 0 левая, 1 правая. Нужно, чтобы вернуть
// в бедро импульс, отданный маховой ноге, — см. реакцию в step().
const LEG_OF = [];
LEG_OF[P.KneeL] = 0;
LEG_OF[P.FootL] = 0;
LEG_OF[P.KneeR] = 1;
LEG_OF[P.FootR] = 1;
const HIP_OF_LEG = [P.HipL, P.HipR];

// Ядро: частицы, которым локомоция задаёт скорость напрямую. Всё остальное
// тянется за ними мышцами и связями — отсюда и берётся отставание корпуса
// от направления движения, которого требует замысел.
const CORE = [P.Hips, P.HipL, P.HipR, P.Chest];

const LINKS = S.links;
const LINK_LIMIT = S.linkLimit;

const _v = new THREE.Vector3();
const _side = new THREE.Vector3();
const _center = new THREE.Vector3();
const _rot = new THREE.Quaternion();
const _dir = new THREE.Vector3();
// Импульс маховой ноги: [левая x, левая z, правая x, правая z].
const _kick = [0, 0, 0, 0];
// Суммарный горизонтальный импульс всех мышц за кадр: [x, z].
const _selfPush = [0, 0];
const TOTAL_MASS = MASS.reduce((a, b) => a + b, 0);
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
    /** Какие стопы сейчас стоят на опоре. Ставит походка. */
    this.footAnchored = [false, false];
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
  /**
   * Уровень, от которого отсчитывается высота цели.
   *
   * Настил, а НЕ текущая высота таза. Привязать её к телу соблазнительно,
   * но тогда цель едет вниз вместе с проседающим тазом, восстанавливающей
   * силы не остаётся вовсе, и боец просто складывается на пол — что
   * и произошло с первой версией.
   *
   * За кромкой опоры нет, и там цель обязана падать вместе с телом:
   * иначе сбитого тянуло бы обратно наверх резиновым тросом.
   */
  baseY() {
    const hips = this.pos[P.Hips];
    return this.arena.isOverDeck(hips.x, hips.z, 0.4) ? 0 : hips.y - Rig.HipsY;
  }

  /**
   * Мировая точка — в систему тела. Обратное преобразование к тому, которым
   * setTargets раскладывает позу в мир, и написано рядом с ним намеренно:
   * разъехавшись, эти двое дали бы стопу, которая втыкается не туда,
   * куда её поставили.
   *
   * Нужно для шага: опора стопы живёт в мире и стоит на месте, а IK колена
   * считается в локальных координатах.
   */
  toLocal(world, yaw, out) {
    const hips = this.pos[P.Hips];
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const dx = world.x - hips.x;
    const dz = world.z - hips.z;
    return out.set(dx * cos - dz * sin, world.y - this.baseY(), dx * sin + dz * cos);
  }

  setTargets(pose, yaw) {
    const hips = this.pos[P.Hips];
    const baseY = this.baseY();

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

  /**
   * Поставить все частицы ровно в их цели.
   *
   * Это и есть первая итерация тела, вернувшаяся режимом: поза не задание
   * для мышц, а результат — кости стоят там, где их посчитали формулы,
   * и ни физика, ни инерция в них не вмешиваются.
   *
   * Стоит это предсказуемости ради. Настоящая походка на мышцах выходит
   * живее, но её цикл собирается из десятка спорящих чисел, и на глаз она
   * читается вознёй. Кинематическая нарисована прямо: как посчитали,
   * так и встало.
   *
   * Частицы при этом остаются на месте и наготове. Сбили бойца — мышцы
   * отпускаются, физика подхватывает тело ровно из той позы, в которой
   * оно было, и никакого перехода писать не нужно.
   */
  snap() {
    for (let i = 0; i < COUNT; i++) {
      this.pos[i].copy(this.target[i]);
      this.prev[i].copy(this.target[i]);
    }
    this.maxStretch = 0;
  }

  /** Поставить таз в заданную точку — корень при кинематике ведёт ввод. */
  placeHips(x, y, z) {
    this.pos[P.Hips].set(x, y, z);
    this.prev[P.Hips].copy(this.pos[P.Hips]);
  }

  // ----------------------------------------------------------------- физика

  step(dt) {
    // Без дубины набалдашник остаётся в скелете, но почти невесомым: он
    // болтается под кистью и ничего не тянет. Выкидывать частицу целиком
    // значило бы пересобирать связи и их длины прямо на ходу, а так
    // оружие возвращается одним переключателем.
    this.invMass[P.ClubTip] = 1 / (T.withClub ? MASS[P.ClubTip] : CLUB_OFF_MASS);

    // Стоящая стопа упирается в настил и становится для решателя тяжёлой.
    //
    // Без этого её утаскивает собственная нога: связь колена жёсткая,
    // мышца по сравнению с ней мягкая, а коррекция делится обратно
    // пропорционально массам — лёгкая стопа забирает больше половины
    // и едет за телом. Замерено: 42% проскальзывания при совершенно
    // исправной опоре. Теперь смещение достаётся колену, как и положено:
    // это оно сгибается, пока тело проходит над стопой.
    // Стоящая стопа тяжелеет для решателя: связь колена гнёт ногу,
    // а не тащит стопу.
    //
    // Пробовал жёстче — прибивать её намертво, нулевой обратной массой
    // и обнулением скорости. Стало хуже: решатель больше не мог развести
    // цепь вокруг закреплённой точки, растяжение связей подскочило
    // с 1.1 до 13.4 см, а самоход при этом никуда не делся. Значит дело
    // не в способе крепления стопы.
    const anchor = clamp01(T.footAnchor);
    for (const [pi, gi] of FOOT_INDEX) {
      const planted = this.footAnchored[gi];
      this.invMass[pi] = (1 / MASS[pi]) * (planted ? anchor : 1);
    }

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

    // Импульс, отданный мышцей НОГЕ В ВОЗДУХЕ. Копится в цикле и сразу
    // после него возвращается в бедро — см. applySwingReaction.
    _kick[0] = 0; _kick[1] = 0; _kick[2] = 0; _kick[3] = 0;
    // То же самое для всего тела сразу — на случай, когда опоры нет вовсе.
    _selfPush[0] = 0; _selfPush[1] = 0;

    for (let i = 0; i < COUNT; i++) {
      const p = this.pos[i];
      const q = this.prev[i];

      const vx = (p.x - q.x) * keep;
      const vy = (p.y - q.y) * keep;
      const vz = (p.z - q.z) * keep;

      let ax = 0;
      let ay = 0;
      let az = 0;

      // К закреплённой стопе мышца не применяется вовсе: она уже там,
      // где нужно, и любая её тяга уходит рычагом в таз.
      if (stiff > 0) {
        const t = this.target[i];
        const o = this.prevTarget[i];
        // Хват вынесен в настройку: от него зависит, насколько тяжело
        // ощущается оружие. Слабый — дубина волочится и не долетает
        // до соперника, сильный — идёт за рукой как приклеенная.
        // Стопам хватка нужна отдельная и заметно крепче прочего. Общая
        // жёсткость уведена вниз ради желейного корпуса, а опора от этого
        // перестаёт держаться: тело тянет ногу через колено, мягкая мышца
        // не спорит, и стопа едет юзом. Замерено — 83% проскальзывания.
        let m = (T.bodyMode >= 3 ? MUSCLE_ROPE : MUSCLE)[i];
        if (i === P.ClubTip) {
          m *= T.clubGrip;
        } else if (i === P.FootL || i === P.FootR) {
          m *= T.footGrip;
        }
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

        // Сколько мышца толкнула ногу, которая сейчас в воздухе.
        const leg = LEG_OF[i];
        const w = MASS[i] * dt2;
        if (leg !== undefined && !this.footAnchored[leg]) {
          _kick[leg * 2] += ax * w;
          _kick[leg * 2 + 1] += az * w;
        }
        _selfPush[0] += ax * w;
        _selfPush[1] += az * w;
      }

      q.copy(p);
      p.set(
        p.x + vx + ax * dt2,
        p.y + vy + g + ay * dt2,
        p.z + vz + az * dt2
      );
    }

    if (this.standing) this.applySwingReaction();
    else this.applyBodyReaction();
    this.groundResponse(dt);

    const iterations = Math.max(1, Math.round(T.ragdollIterations));
    this.maxStretch = 0;
    for (let k = 0; k < iterations; k++) {
      this.solveLinks(k === iterations - 1);
      this.clampGround();
    }
    if (T.bodyMode >= 3) this.clearTorso();
  }

  /**
   * Вернуть в бедро импульс, отданный мышцей ноге в воздухе.
   *
   * Мышца тянет частицу к МИРОВОЙ цели, то есть сила у неё внешняя, взятая
   * ниоткуда. Пока нога гнулась, эту силу съедало колено; цельная нога
   * передаёт её прямо в таз, и боец едет от собственного маха ногой.
   * Замерено: 1.95 м/с при заданных 1.7 вперёд и 1.29 при 0.85 вбок,
   * и разгон этот не зависел от того, что просит локомоция.
   *
   * У ноги в воздухе опоры нет и толкаться ей не от чего — значит её мышца
   * обязана быть ВНУТРЕННЕЙ: сколько импульса ушло в стопу и колено,
   * столько же возвращается в бедро. Стоящая нога — случай другой,
   * она упирается в настил, и внешняя сила ей положена по праву.
   *
   * Только по горизонтали. Вертикаль трогать нельзя: там в ускорении сидит
   * компенсация веса, и её возврат означал бы, что боец проседает всякий
   * раз, когда поднимает ногу.
   */
  applySwingReaction() {
    for (let leg = 0; leg < 2; leg++) {
      const kx = _kick[leg * 2];
      const kz = _kick[leg * 2 + 1];
      if (kx === 0 && kz === 0) continue;
      const hip = HIP_OF_LEG[leg];
      const inv = 1 / MASS[hip];
      const p = this.pos[hip];
      p.x -= kx * inv;
      p.z -= kz * inv;
    }
  }

  /**
   * Есть ли у мышцы вообще опора, от которой она вправе отталкиваться.
   *
   * Одного «стопа лежит низко» мало, а именно это и означает footAnchored:
   * его ставит походка по высоте частицы над настилом. У СБИТОГО бойца оно
   * тоже верно — он лежит, и стопы у него, разумеется, внизу. Стойки при
   * этом никакой нет: тело не стоит на ноге, оно её просто уронило рядом.
   */
  get standing() {
    return (this.footAnchored[0] || this.footAnchored[1])
      && this.strength >= T.controlStrength;
  }

  /**
   * Обнулить горизонтальный самоход тела без опоры.
   *
   * Это тот же закон, что и в applySwingReaction, только для всего тела
   * разом: мышца тянет частицу к МИРОВОЙ цели, и пока телу не от чего
   * оттолкнуться, эта тяга обязана быть внутренней. У сбитого бойца
   * опоры нет ни одной, а цель у мышц всё та же — стоять; выходило, что
   * лежащий подтягивал к себе раскинутые конечности и уезжал в другую
   * сторону всем телом. Замерено: сбитого импульсом на +X относило
   * на 2.4 м вперёд, а потом, пока он поднимался, утаскивало на 6.4 м
   * НАЗАД — против удара, без единого касания и без всякого ввода.
   * Ровно это и читалось как «встал и сам куда-то пошёл».
   *
   * Возврат идёт долей массы, то есть центр масс остаётся на месте.
   * Поза при этом складывается ровно как складывалась: относительные
   * движения частиц не тронуты, снят только общий снос.
   *
   * По вертикали, как и у маховой ноги, не трогаем ничего: там в мышце
   * сидит компенсация веса, и её возврат означал бы, что боец не может
   * подняться с земли вовсе.
   */
  applyBodyReaction() {
    const kx = _selfPush[0] / TOTAL_MASS;
    const kz = _selfPush[1] / TOTAL_MASS;
    if (kx === 0 && kz === 0) return;
    for (let i = 0; i < COUNT; i++) {
      const p = this.pos[i];
      p.x -= kx;
      p.z -= kz;
    }
  }

  /**
   * Не пускать свободно висящие руки внутрь корпуса.
   *
   * У третьей итерации локоть и кисть почти отпущены и болтаются на верёвке —
   * значит рано или поздно они качнутся в корпус, и панель руки войдёт
   * в панель торса. Мышца этого не удержит: её тут почти нет, в том и смысл.
   * Поэтому запрет геометрический: ближе радиуса к оси таз↔грудь не подходим.
   */
  clearTorso() {
    const hips = this.pos[P.Hips];
    const chest = this.pos[P.Chest];
    const r = T.torsoClearance * Rig.ChestBottomWidth;
    if (r <= 0) return;

    _v.copy(chest).sub(hips);
    const len2 = _v.lengthSq();
    for (const i of [P.ElbowL, P.ElbowR, P.HandL, P.HandR]) {
      const p = this.pos[i];
      _side.copy(p).sub(hips);
      let h = len2 > 1e-9 ? _side.dot(_v) / len2 : 0;
      h = h < 0 ? 0 : h > 1 ? 1 : h;
      // Горизонтальное отклонение от оси корпуса: по высоте не отталкиваем,
      // иначе рука поедет вверх вместо того чтобы отойти вбок.
      const ax = hips.x + _v.x * h;
      const az = hips.z + _v.z * h;
      const dx = p.x - ax;
      const dz = p.z - az;
      const d = Math.hypot(dx, dz);
      if (d >= r) continue;
      const q = this.prev[i];
      const push = d > 1e-5 ? (r - d) / d : 0;
      const ox = d > 1e-5 ? dx * push : r;
      const oz = d > 1e-5 ? dz * push : 0;
      p.x += ox;
      p.z += oz;
      q.x += ox;
      q.z += oz;
    }
  }

  solveLinks(measure) {
    // У третьей итерации верёвки нерастяжимые: панели не должны менять
    // длину вообще, вся податливость тела живёт в углах суставов.
    const relax = T.bodyMode >= 3 ? 1 : clamp01(T.linkStiffness);
    for (let i = 0; i < LINKS.length; i++) {
      const a = LINKS[i][0];
      const b = LINKS[i][1];
      const pa = this.pos[a];
      const pb = this.pos[b];

      _v.copy(pb).sub(pa);
      const dist = _v.length();
      if (dist < 1e-6) continue;

      const rest = this.restLength[i];
      // Связь-предел держит только сверху: короче — не её дело. Ею и сделано
      // колено. Стоя боец распрямлён, связь натянута и работает как цельная
      // кость; наступил на что-то выше настила — расстояние сократилось,
      // связь отпустила, колено согнулось. Назад оно не выгибается никогда.
      if (LINK_LIMIT[i] && dist <= rest) continue;
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
      const wsum = wa + wb;
      if (wsum <= 0) continue;
      const c = ((dist - rest) / dist) / wsum * relax;
      pa.addScaledVector(_v, c * wa);
      pb.addScaledVector(_v, -c * wb);
    }
  }

  /** Реакция настила: трение и отскок. Один раз за шаг. */
  groundResponse(dt) {
    const friction = 1 - Math.pow(1 - clamp01(T.ragdollFriction), dt);
    const bounce = clamp01(T.ragdollBounce);

    const budget = Math.max(0.02, T.deckCatchDepth);
    for (let i = 0; i < COUNT; i++) {
      const p = this.pos[i];
      if (p.y >= RADIUS[i]) continue;
      // Тереться можно только о то, чего касаешься: провалившаяся за кромку
      // частица летит мимо настила, а не по нему.
      if (p.y < RADIUS[i] - budget) continue;
      // Опоры нет за кромкой — именно поэтому сбитый и улетает вниз.
      if (!this.arena.isOverDeck(p.x, p.z)) continue;

      const q = this.prev[i];
      const vy = p.y - q.y;
      q.x += (p.x - q.x) * friction;
      q.z += (p.z - q.z) * friction;
      if (vy < 0) q.y = p.y + vy * bounce;
    }
  }

  /**
   * Лежит ли тело на настиле хоть чем-нибудь.
   *
   * Не то же самое, что «стоит на ногах», и путать их дорого. Опора
   * у бойца до сих пор считалась ТОЛЬКО по стопам, а лежачему стопы
   * не нужны — он опирается спиной, плечом, головой. У кромки ноги вообще
   * свешиваются за край, и тело, спокойно лежащее на арене, считалось
   * висящим в воздухе: мышцы отпускались насовсем, таймеры подъёма
   * сбрасывались каждый кадр, и боец не вставал НИКОГДА. Замерено —
   * корпус на настиле (низ 0.07, таз 0.17), а «в воздухе» полторы секунды
   * и дальше без предела.
   *
   * Порог с запасом: частица, вытолкнутая clampGround, стоит ровно
   * на своём радиусе, и точное сравнение ловило бы её через раз.
   */
  touchesDeck() {
    const budget = Math.max(0.02, T.deckCatchDepth);
    for (let i = 0; i < COUNT; i++) {
      const p = this.pos[i];
      if (p.y > RADIUS[i] + 0.05) continue;
      // Улетевшая за кромку вниз частица какое-то время остаётся над диском
      // по горизонтали. Опорой она не является: под ней уже пустота.
      if (p.y < RADIUS[i] - budget) continue;
      if (this.arena.isOverDeck(p.x, p.z)) return true;
    }
    return false;
  }

  /**
   * Выталкивание из настила. Внутри решателя — только позиции.
   *
   * Выталкивается только то, что провалилось НЕГЛУБОКО. Настил — не
   * бесконечная плоскость, а диск с обрывом по кромке, и частица,
   * ушедшая за край вниз, по горизонтали ещё какое-то время остаётся
   * «над» ним. Без ограничения по глубине она считалась провалившейся
   * сквозь пол и телепортировалась наверх — на всю глубину разом,
   * а связи выдёргивали за ней остальное тело.
   *
   * Отсюда и брался рывок у кромки: замерено, сбитый у края повисал
   * низом на −0.46, а на следующем кадре всё тело оказывалось на +1.28 —
   * подброс на метр семьдесят, из которого боец уже падал по-настоящему.
   * Ровно это и видно как «повис и залагал».
   */
  clampGround() {
    const budget = Math.max(0.02, T.deckCatchDepth);
    for (let i = 0; i < COUNT; i++) {
      const p = this.pos[i];
      if (p.y >= RADIUS[i]) continue;
      const shift = RADIUS[i] - p.y;
      if (shift > budget) continue;
      if (!this.arena.isOverDeck(p.x, p.z)) continue;
      const q = this.prev[i];
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

  /**
   * Погасить горизонтальную скорость частицы: стопа встала и вцепилась.
   *
   * Без этого нога прилетает на опору с полной скоростью переноса и по
   * инерции проезжает дальше — замерено, приземлившись на 2.58, стопа
   * уходила на 2.71. Мышца и трение о настил её потом возвращают, но
   * пятнадцать сантиметров проскальзывания успевают случиться, и походка
   * читается как скольжение при совершенно исправной опоре.
   */
  grip(index) {
    // Гасится не вся скорость разом, а её часть. Обнуление в один кадр —
    // это разрыв: стопа летит на полной скорости переноса и в следующем
    // кадре стоит намертво, а связь ноги передаёт этот скачок в таз.
    // Отсюда и бралась дрожь на каждом шаге. Остаток гасят трение
    // о настил и мышца, им на это хватает пары кадров.
    const keep = clamp01(1 - T.footGripBite);
    const p = this.pos[index];
    const q = this.prev[index];
    q.x = p.x - (p.x - q.x) * keep;
    q.z = p.z - (p.z - q.z) * keep;
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

    // Голова держится ровно, а не заваливается вслед за шеей. Вертикаль
    // для неё подмешивается к направлению шеи: у картонной куклы голова
    // насажена сверху и на ниточке висит отвесно, как бы ни повело корпус.
    const level = clamp01(T.headLevel);
    if (level > 0) {
      if (_v.lengthSq() > 1e-9) _v.normalize();
      _v.x += (0 - _v.x) * level;
      _v.z += (0 - _v.z) * level;
      _v.y += (1 - _v.y) * level;
    }

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

    // Панелей на конечность снова две — по половинке на кость. Пока
    // конечность прямая, они лежат на одной линии и читаются как прежняя
    // цельная деталь с прорезью посередине; согнётся колено — разойдутся
    // углом, а нить в прорези останется натянутой.
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
