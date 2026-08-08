import * as THREE from 'three';
import { tuning as T } from 'tk/tuning.js';
import { clamp, clamp01, lerp, moveTowards, deltaAngle, noiseSigned, inverseLerp, RAD, DEG } from 'tk/mathx.js';
import * as Rig from 'tk/fighterRig.js';
import { P } from 'tk/body.js';

// Стопы приходят из походки в мировых координатах, а поза считается
// в локальных: здесь они и переводятся.
const _footL = new THREE.Vector3();
const _footR = new THREE.Vector3();

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
    const body = this.f.body;
    const gait = this.f.gait;

    // yaw бойца хранится в радианах; RAD переводит ИЗ них, поэтому
    // yawDeg — градусы, а yawRate — градусы в секунду.
    const yawDeg = this.f.yaw * RAD;
    this.yawRate = deltaAngle(this.lastYaw, yawDeg) / Math.max(1e-5, dt);
    this.lastYaw = yawDeg;
    const yaw = this.f.yaw;

    const strideNorm = clamp01(planarSpeed / Math.max(0.1, T.maxRunSpeed));

    // Походка живёт в мире и решает сама, когда отрывать стопу. Никаких
    // подмешиваний скорости разворота в цикл шага здесь больше нет:
    // разворот сам уводит опору вбок по дуге, и порог по расстоянию
    // срабатывает без единой отдельной строчки про повороты.
    const hips = body.pos[P.Hips];
    const prev = body.prev[P.Hips];
    const vx = (hips.x - prev.x) / Math.max(1e-5, dt);
    const vz = (hips.z - prev.z) / Math.max(1e-5, dt);
    gait.tick(dt, hips.x, hips.z, yaw, vx, vz, planarSpeed, grounded);

    // Приземлившаяся стопа вцепляется в настил: гасим ей скорость, иначе
    // она приезжает на опору с полной скоростью переноса и проскакивает
    // дальше по инерции.
    if (gait.landed[0]) body.grip(P.FootL);
    if (gait.landed[1]) body.grip(P.FootR);

    // Стоящая стопа упирается в настил: решателю она тяжёлая, и связь
    // колена гнёт колено, а не тащит стопу.
    body.footAnchored[0] = grounded && !gait.feet[0].swinging;
    body.footAnchored[1] = grounded && !gait.feet[1].swinging;

    // Тот же угол, которым setTargets раскладывает позу в мир, иначе
    // стопа воткнётся не туда, куда её поставила походка.
    body.toLocal(gait.world[0], yaw, _footL);
    body.toLocal(gait.world[1], yaw, _footR);

    // Фаза шага теперь приходит от походки и двигается ТОЛЬКО пока нога
    // в воздухе. Раньше она тикала по таймеру своим чередом, поэтому
    // подскок корпуса и мах рук шли поверх скольжения и с настоящими
    // шагами не совпадали ничем.
    this.stepPhase = gait.phase;
    this.stride = strideNorm * T.stepLength * Rig.LegLength;
    this.lift = gait.lift;

    // Подскок привязан к переносу: корпус проседает в момент, когда вес
    // переходит с ноги на ногу, и подбирается на середине шага.
    const targetBob = grounded ? gait.lift * T.stepBob / Math.max(0.01, T.stepLift) : 0;
    this.bob = lerp(this.bob, targetBob, clamp01(14 * dt));

    this.updateWobble(dt, planarSpeed, strideNorm);
    this.updateTwist(dt, strideNorm, grounded);

    Rig.computePose(this.pose, this.bob, this.stepPhase, this.stride,
      swing.angle + this.clubLag, swing.reach, swing.lean + this.lean, this.sway,
      swing.height, swing.pitch, this.lift, this.twist, _footL, _footR);

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
    // Конечности цельные: сгибаться им негде, поэтому и досчитывать
    // нечего — «сустав» просто лежит на середине отрезка. Цель конца при
    // этом НЕ подтягивается к длине кости: пусть остаётся там, куда её
    // поставила походка, а разницу разрешит жёсткая связь, приподняв
    // или опустив таз. Из этого и берётся раскачка на шаге.
    Rig.midJoint(pose.shoulderRight, pose.handRight, pose.elbowRight);
    Rig.midJoint(pose.shoulderLeft, pose.handLeft, pose.elbowLeft);
    Rig.midJoint(pose.hipLeft, pose.footLeft, pose.kneeLeft);
    Rig.midJoint(pose.hipRight, pose.footRight, pose.kneeRight);
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
