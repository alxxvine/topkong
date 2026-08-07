import * as THREE from 'three';
import { tuning as T } from 'tk/tuning.js';
import { clamp, clamp01, lerp, moveTowards, deltaAngle, noiseSigned, inverseLerp, RAD } from 'tk/mathx.js';
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

// Опорные точки цепей держим по отдельности: solveTwoBone читает root уже
// после того, как в него что-то записали, и общий временный вектор
// перетирался бы между вызовами.
const _shoulderR = new THREE.Vector3();
const _shoulderL = new THREE.Vector3();
const _hipL = new THREE.Vector3();
const _hipR = new THREE.Vector3();

export class PoseDriver {
  constructor(fighter) {
    this.f = fighter;

    this.stepPhase = 0;
    this.bob = 0;
    this.stride = 0;
    this.lean = 0;
    this.sway = 0;
    this.clubLag = 0;
    this.lastYaw = 0;
    this.lastSpeed = 0;
    this.noiseSeed = Math.random() * 100;

    this.pose = Rig.makePose();
  }

  /**
   * Пересчитать цель. Скорость и опора берутся у тела, а не у ввода:
   * шаг должен идти под то, как боец едет на самом деле, иначе ноги
   * заскользят, едва его толкнут.
   */
  tick(dt, planarSpeed, grounded) {
    const swing = this.f.swing;

    // Шаг крутится тем быстрее, чем быстрее боец едет. В покое фаза
    // подтягивается к целому, чтобы ноги вставали ровно.
    const normalized = clamp01(planarSpeed / Math.max(0.1, T.maxRunSpeed));
    const targetStride = normalized * T.stepLength;
    this.stride = moveTowards(this.stride, grounded ? targetStride : 0, dt * 3);

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

    Rig.computePose(this.pose, this.bob, this.stepPhase, this.stride,
      swing.angle + this.clubLag, swing.reach, swing.lean + this.lean, this.sway,
      swing.height, swing.pitch);

    this.solveJoints();
    return this.pose;
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
    Rig.solveTwoBone(Rig.shoulder(true, _shoulderR), pose.handRight,
      Rig.UpperArmLength, Rig.ForeArmLength, Rig.armPole(true),
      pose.elbowRight, pose.handRight);
    Rig.solveTwoBone(Rig.shoulder(false, _shoulderL), pose.handLeft,
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
    // наблюдать его.
    const yaw = this.f.yaw * RAD;
    const yawRate = deltaAngle(this.lastYaw, yaw) / Math.max(1e-5, dt);
    this.lastYaw = yaw;

    const striking = this.f.swing.striking;
    const lagTarget = striking ? 0 : clamp(-yawRate * T.limbLag, -60, 60);
    this.clubLag = lerp(this.clubLag, lagTarget, clamp01((striking ? 25 : 9) * dt));
  }

  /** Сбросить накопленное — при спавне. */
  reset() {
    this.stepPhase = 0;
    this.bob = 0;
    this.stride = 0;
    this.lean = 0;
    this.sway = 0;
    this.clubLag = 0;
    this.lastSpeed = 0;
    this.lastYaw = this.f.yaw * RAD;
  }
}
