import * as THREE from 'three';
import { tuning as T } from 'tk/tuning.js';
import { clamp, clamp01, lerp, moveTowards, deltaAngle, noiseSigned, inverseLerp, RAD, DEG } from 'tk/mathx.js';
import * as Rig from 'tk/fighterRig.js';

// Считает ЦЕЛЕВУЮ позу бойца — ту, которую тело пытается принять.
//
// Раньше этот файл расставлял кости напрямую, и поза была результатом.
// Теперь она задание: формулы говорят, где боец хочет держать таз, стопы,
// кисти и дубину, а добирается ли он туда — решает физика в body.js.
// Мышца может и не дотянуть, если бойца сбили или держат.
//
// Вместе с прежней схемой отсюда ушёл целый слой — желейные пружины
// по ключевым точкам. Они имитировали вес у жёсткого тела; теперь вес
// настоящий, и вторая имитация поверх него только спорила бы с ней.
//
// Анимаций в проекте по-прежнему нет ни одной: стойка, шаг с подскоком
// и дуга удара — это формулы.

// Опорные точки ног держим по отдельности: solveTwoBone читает root уже
// после того, как в него что-то записали, и общий временный вектор
// перетирался бы между вызовами. Плечи в этом больше не нуждаются —
// они лежат в самой позе.
const _hipL = new THREE.Vector3();
const _hipR = new THREE.Vector3();

export class PoseDriver {
  constructor(fighter) {
    this.f = fighter;

    this.stepPhase = 0;
    this.bob = 0;
    this.stride = 0;
    this.lift = 0;
    this.lean = 0;
    this.sway = 0;
    this.clubLag = 0;
    this.lastYaw = 0;
    this.yawRate = 0;
    this.lastSpeed = 0;
    this.noiseSeed = Math.random() * 100;

    /** Разворот плечевого пояса относительно таза, градусы. */
    this.twist = 0;
    /** Доворот головы относительно плеч, радианы. Читает его отрисовка. */
    this.headTurn = 0;
    /** Фаза дыхания. В покое тело иначе стоит абсолютно неподвижно. */
    this.breath = Math.random();

    this.pose = Rig.makePose();
  }

  /**
   * Пересчитать цель. Скорость и опора берутся у тела, а не у ввода:
   * шаг должен идти под то, как боец едет на самом деле, иначе ноги
   * заскользят, едва его толкнут.
   */
  tick(dt, planarSpeed, grounded) {
    const swing = this.f.swing;

    // Разворот считается движением наравне с ходьбой. Иначе на месте
    // цикл шага стоит, стопы едут юзом вокруг оси, и боец проворачивается
    // как статуя на поворотном круге — замерено, по 27 см проскальзывания
    // на разворот в 180 градусов.
    const yaw = this.f.yaw * RAD;
    this.yawRate = deltaAngle(this.lastYaw, yaw) / Math.max(1e-5, dt);
    this.lastYaw = yaw;
    const pivotSpeed = Math.abs(this.yawRate) * DEG * Rig.PivotRadius;

    // Длина шага — только от перемещения: на месте боец переступает,
    // а не вышагивает вперёд.
    const strideNorm = clamp01(planarSpeed / Math.max(0.1, T.maxRunSpeed));
    const normalized = clamp01((planarSpeed + pivotSpeed) / Math.max(0.1, T.maxRunSpeed));

    const targetStride = strideNorm * T.stepLength;
    this.stride = moveTowards(this.stride, grounded ? targetStride : 0, dt * 3);
    this.lift = moveTowards(this.lift, grounded ? normalized * T.stepLift : 0, dt * 0.6);

    if (normalized > 0.05 && grounded) {
      this.stepPhase += dt * T.stepRate * normalized;
      this.stepPhase -= Math.floor(this.stepPhase);
    } else {
      this.stepPhase = moveTowards(this.stepPhase, Math.round(this.stepPhase), dt * 2);
    }

    // Подскок вдвое чаще шага: две ноги — два толчка за цикл.
    const targetBob = grounded
      ? Math.abs(Math.sin(this.stepPhase * Math.PI * 2)) * T.stepBob * normalized
      : 0;
    this.bob = lerp(this.bob, targetBob, clamp01(12 * dt));

    this.updateWobble(dt, planarSpeed, normalized);
    this.updateTwist(dt, strideNorm, grounded);

    Rig.computePose(this.pose, this.bob, this.stepPhase, this.stride,
      swing.angle + this.clubLag, swing.reach, swing.lean + this.lean, this.sway,
      swing.height, swing.pitch, this.lift, this.twist);

    this.solveJoints();
    return this.pose;
  }

  /**
   * Скрут корпуса: насколько плечевой пояс развёрнут относительно таза
   * и куда при этом смотрит голова.
   *
   * До этого такой степени свободы не было вовсе — вся поза разворачивалась
   * на один угол, и корпус проворачивался цельным бруском. Замерено: за
   * разворот на 180 градусов плечи уходили от таза на 3.6°, при ходьбе
   * на 5.9°. У человека при обычном шаге это градусов пятнадцать.
   *
   * Складывается из четырёх независимых вкладов.
   */
  updateTwist(dt, strideNorm, grounded) {
    const swing = this.f.swing;
    // yawRate уже в градусах в секунду: RAD в этом проекте переводит ИЗ
    // радиан, а не в них. Домножение на DEG здесь давало 0.4° вместо 23.
    const yawRateDeg = this.yawRate;

    // 1. Разворот. Плечи отстают от таза, голова наоборот забегает вперёд:
    // человек сначала смотрит, куда поворачивается, и только потом доводит
    // корпус. Из этой встречной пары и читается, что тело живое.
    const fromTurn = clamp(-yawRateDeg * T.twistFromTurn, -T.twistMax, T.twistMax);
    const headLead = yawRateDeg * T.headLead;

    // 2. Шаг. Плечи идут в противофазе ногам: вынесена левая нога — вперёд
    // уходит правое плечо. Знак отрицательный именно поэтому, а не случайно:
    // при фазе 0 левая стопа впереди, и правое плечо должно уйти следом.
    const fromStep = grounded
      ? -Math.cos(this.stepPhase * Math.PI * 2) * T.twistFromStep * strideNorm
      : 0;

    // 3. Замах. Удар идёт от корпуса, а не от одной руки: на зарядке плечи
    // закручиваются назад, на проносе раскручиваются вслед за дугой.
    const fromSwing = (swing.angle - T.carryAngle) * T.twistFromSwing
      + swing.charge * T.twistFromCharge;

    // 4. Дыхание. Без него боец в покое стоит абсолютно неподвижно —
    // ровно то, из-за чего он и читается манекеном.
    this.breath += dt * T.breathRate;
    const idle = clamp01(1 - strideNorm * 3);
    const fromBreath = Math.sin(this.breath * Math.PI * 2) * T.breathTwist * idle;

    const target = fromTurn + fromStep + fromSwing + fromBreath;
    // Плечи набирают скрут не мгновенно: масса корпуса своё берёт.
    this.twist = lerp(this.twist, target, clamp01(11 * dt));

    // Голова доворачивается ОТ ПЛЕЧ, поэтому из её угла вычитается скрут:
    // плечи и так уже уехали. Ограничение накладывается на итог, а не
    // на слагаемое — иначе на быстром развороте отставание плеч и вынос
    // головы складывались бы и шея выворачивалась.
    const headOffset = clamp(headLead - this.twist, -T.headTurnMax, T.headTurnMax);
    this.headTurn = lerp(this.headTurn, headOffset * DEG, clamp01(9 * dt));
  }

  /**
   * Досчитать локти и колени.
   *
   * Мышцы тянут каждую частицу к своей цели, значит цель нужна и суставам —
   * иначе локоть остался бы без задания и болтался бы там, куда его случайно
   * поставят связи.
   */
  solveJoints() {
    const pose = this.pose;
    // Корень руки — плечо из позы, а не постоянная точка рига: плечо теперь
    // ездит вместе со скрутом, и IK обязана считать от того места,
    // где оно оказалось.
    Rig.solveTwoBone(pose.shoulderRight, pose.handRight,
      Rig.UpperArmLength, Rig.ForeArmLength, Rig.armPole(true),
      pose.elbowRight, pose.handRight);
    Rig.solveTwoBone(pose.shoulderLeft, pose.handLeft,
      Rig.UpperArmLength, Rig.ForeArmLength, Rig.armPole(false),
      pose.elbowLeft, pose.handLeft);
    Rig.solveTwoBone(Rig.hipJoint(false, _hipL), pose.footLeft,
      Rig.ThighLength, Rig.ShinLength, Rig.legPole(), pose.kneeLeft, pose.footLeft);
    Rig.solveTwoBone(Rig.hipJoint(true, _hipR), pose.footRight,
      Rig.ThighLength, Rig.ShinLength, Rig.legPole(), pose.kneeRight, pose.footRight);
  }

  /**
   * Вторичная неровность цели: завал корпуса, покачивание и отставание дубины.
   *
   * Часть этого тело теперь делает само — ядро едет, конечности отстают.
   * Но покачивание у края арены остаётся авторским: это единственный честный
   * способ показать риск, не отбирая у игрока контроль. Значения здесь ниже
   * прежних — физика уже добавляет своё.
   */
  updateWobble(dt, planarSpeed, normalized) {
    // 1. Инерция: разгоняешься — корпус отстаёт назад, тормозишь — валится вперёд.
    const acceleration = (planarSpeed - this.lastSpeed) / Math.max(1e-5, dt);
    this.lastSpeed = planarSpeed;
    const leanTarget = clamp(-acceleration * T.leanFromAccel, -1.2, 1.2);
    this.lean = lerp(this.lean, leanTarget, clamp01(8 * dt));

    // 2. Покачивание, усиленное у края.
    const dist = Math.hypot(this.f.position.x, this.f.position.z);
    const edge = inverseLerp(T.arenaRadius * 0.55, T.arenaRadius, dist);
    const amount = T.wobbleAmount * (0.4 + normalized) * (1 + edge * 2);
    const n = noiseSigned(this.noiseSeed, performance.now() * 0.001 * T.wobbleRate);
    const stepSway = Math.sin(this.stepPhase * Math.PI * 2) * 0.5 * normalized;
    this.sway = lerp(this.sway, (n + stepSway) * amount, clamp01(6 * dt));

    // 3. Дубина отстаёт от разворота. Физически она отстаёт и сама, но здесь
    // отставание задаётся в цели — так им можно управлять, а не только
    // наблюдать его. Скорость разворота уже посчитана в tick.
    const yawRate = this.yawRate;
    const striking = this.f.swing.striking;
    const lagTarget = striking ? 0 : clamp(-yawRate * T.limbLag, -60, 60);
    this.clubLag = lerp(this.clubLag, lagTarget, clamp01((striking ? 25 : 9) * dt));
  }

  /** Сбросить накопленное — при спавне. */
  reset() {
    this.stepPhase = 0;
    this.bob = 0;
    this.stride = 0;
    this.lift = 0;
    this.lean = 0;
    this.sway = 0;
    this.clubLag = 0;
    this.lastSpeed = 0;
    this.lastYaw = this.f.yaw * RAD;
    this.twist = 0;
    this.headTurn = 0;
  }
}
