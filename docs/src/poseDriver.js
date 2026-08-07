import * as THREE from '../vendor/three.module.js';
import { tuning as T } from './tuning.js';
import { clamp, clamp01, lerp, moveTowards, deltaAngle, noiseSigned, inverseLerp, RAD } from './mathx.js';
import * as Rig from './fighterRig.js';

// Расставляет кости бойца, пока он под управлением. Порт PoseDriver.cs.
//
// Анимаций в проекте нет ни одной, поэтому поза считается формулами: стойка,
// шаг с подскоком по скорости и дуга удара из SwingAction. Кости в это время
// ничем не управляются кроме этого кода, так что поза получается ровно такой,
// какой задумана — ни физика, ни суставы в неё не вмешиваются.
//
// Это и есть главное отличие от прежней схемы: раньше поза была результатом
// борьбы приводов с инерцией, и предсказать её было нельзя.
//
// Тот же код используется для вставания: Fighter запоминает позу, в которой
// боец дошатался на земле, и просит подмешивать её к стойке с убывающим весом.

// Пружины по ключевым точкам позы. Жёсткость падает по мере удаления от опоры,
// поэтому движение прокатывается по телу волной, а не приходит везде разом.
// Порядок: таз, грудь, голова, дубина, стопа Л, стопа П, кисть П, кисть Л.
const POINT_COUNT = 8;
const STIFFNESS = [2.4, 1.0, 0.6, 0.4, 2.0, 2.0, 0.55, 0.55];

const _v = new THREE.Vector3();
const _center = new THREE.Vector3();
const _rot = new THREE.Quaternion();
const _handMid = new THREE.Vector3();
const _clubDir = new THREE.Vector3();
const _hipsRot = new THREE.Quaternion();
const _chestRot = new THREE.Quaternion();
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
    this.point = [];
    this.pointVel = [];
    for (let i = 0; i < POINT_COUNT; i++) {
      this.point.push(new THREE.Vector3());
      this.pointVel.push(new THREE.Vector3());
    }
    this.jellyReady = false;
    this.rigid = 0;

    /** 1 — чистая вычисленная поза, 0 — поза, запомненная при вставании. */
    this.blendFromStart = 1;
    this.startPositions = null;
    this.startRotations = null;
    this.writeIndex = 0;
  }

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
      swing.height, swing.pitch, swing.twoHanded);

    // На проносе желе почти выключается: там важен точный тайминг и точное
    // положение набалдашника — по его смещению считается сила попадания,
    // и мягкие пружины начали бы влиять на неё.
    this.rigid = moveTowards(this.rigid, swing.striking ? 1 : 0, dt / 0.08);

    this.jelly(this.pose, dt);
    this.apply(this.pose);
  }

  /**
   * Пропускает ключевые точки позы через пружины.
   *
   * Жёстко расставленное тело приходит в новое положение всеми частями разом
   * и без запаздывания — именно это читается как «деталь», а не «тело».
   * Пружина с недодемпфированием даёт перелёт и отставание, а разная жёсткость
   * по частям превращает это в волну: таз пошёл, корпус отстал, голова
   * качнулась следом, дубина довесила.
   *
   * Слой чисто визуальный. Ни столкновения, ни движение, ни тайминг удара
   * он не трогает — иначе мы вернулись бы к физическому телу, из которого
   * только что вылезли.
   */
  jelly(pose, dt) {
    const targets = [
      pose.hips, pose.chest, pose.head, pose.club,
      pose.footLeft, pose.footRight, pose.handRight, pose.handLeft,
    ];

    if (!this.jellyReady) {
      for (let i = 0; i < POINT_COUNT; i++) {
        this.point[i].copy(targets[i]);
        this.pointVel[i].set(0, 0, 0);
      }
      this.jellyReady = true;
    }

    const amount = clamp01(T.jellyAmount) * (1 - this.rigid);
    const stiffBoost = lerp(1, 8, this.rigid);

    for (let i = 0; i < POINT_COUNT; i++) {
      const k = T.jellyStiffness * STIFFNESS[i] * stiffBoost;
      const d = T.jellyDamping * Math.sqrt(STIFFNESS[i] * stiffBoost);

      // vel += ((target - point) * k - vel * d) * dt
      _v.copy(targets[i]).sub(this.point[i]).multiplyScalar(k)
        .addScaledVector(this.pointVel[i], -d).multiplyScalar(dt);
      this.pointVel[i].add(_v);
      this.point[i].addScaledVector(this.pointVel[i], dt);

      targets[i].lerp(this.point[i], amount);
    }
  }

  /**
   * Сбросить пружины в текущую позу. Нужно перед вставанием: иначе накопленные
   * скорости выстрелят конечностями в момент перехода.
   */
  resetJelly() {
    this.jellyReady = false;
    this.rigid = 0;
  }

  /**
   * Вторичная анимация: завал корпуса от разгона, покачивание и отставание дубины.
   *
   * Тело расставляется формулами и потому идеально ровное — из-за этого
   * пропадало ощущение веса и риска. Возвращать ради этого физику нельзя,
   * с ней управление уже воевало; вместо неё здесь три дешёвых источника
   * неровности, каждый из которых полностью управляем.
   */
  updateWobble(dt, planarSpeed, normalized) {
    // 1. Инерция: разгоняешься — корпус отстаёт назад, тормозишь — валится вперёд.
    const acceleration = (planarSpeed - this.lastSpeed) / Math.max(1e-5, dt);
    this.lastSpeed = planarSpeed;
    const leanTarget = clamp(-acceleration * T.leanFromAccel, -1.2, 1.2);
    this.lean = lerp(this.lean, leanTarget, clamp01(8 * dt));

    // 2. Покачивание. У края арены усиливается — это единственный честный способ
    // показать риск, не отбирая у игрока контроль.
    const dist = Math.hypot(this.f.position.x, this.f.position.z);
    const edge = inverseLerp(T.arenaRadius * 0.55, T.arenaRadius, dist);
    const amount = T.wobbleAmount * (0.4 + normalized) * (1 + edge * 2);
    const n = noiseSigned(this.noiseSeed, performance.now() * 0.001 * T.wobbleRate);
    // Плюс раскачка в такт шагу: на каждый шаг тело кренится в свою сторону.
    const stepSway = Math.sin(this.stepPhase * Math.PI * 2) * 0.5 * normalized;
    this.sway = lerp(this.sway, (n + stepSway) * amount, clamp01(6 * dt));

    // 3. Дубина отстаёт от разворота — только так у неё читается вес.
    // На проносе отставание гасится: там важен точный тайминг, а не инерция.
    const yaw = this.f.yaw * RAD;
    const yawRate = deltaAngle(this.lastYaw, yaw) / Math.max(1e-5, dt);
    this.lastYaw = yaw;

    const striking = this.f.swing.striking;
    const lagTarget = striking ? 0 : clamp(-yawRate * T.limbLag, -60, 60);
    this.clubLag = lerp(this.clubLag, lagTarget, clamp01((striking ? 25 : 9) * dt));
  }

  /** Поставить бойца в чистую стойку — используется при спавне. */
  snapToRest() {
    this.stepPhase = 0;
    this.bob = 0;
    this.stride = 0;
    this.lean = 0;
    this.sway = 0;
    this.clubLag = 0;
    this.lastSpeed = 0;
    this.lastYaw = this.f.yaw * RAD;
    this.blendFromStart = 1;
    this.startPositions = null;
    this.startRotations = null;
    this.resetJelly();
    this.apply(Rig.restPose(this.pose));
  }

  apply(pose) {
    const b = this.f.bones;
    this.writeIndex = 0;

    // Повороты выводятся из уже сработавших точек, а не пружинятся отдельно.
    // Отдельная пружина на кватернион дала бы второй источник правды
    // и рассинхрон с позициями; так поза остаётся связной сама собой.
    Rig.aim(_v.copy(pose.chest).sub(pose.hips), _hipsRot);
    Rig.aim(_v.copy(pose.head).sub(pose.chest), _chestRot);

    // Сначала конечности. IK подтягивает недостижимую кисть к границе
    // досягаемости и пишет фактическое положение обратно в позу — дальше
    // с ним работают все, включая ragdoll.
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

    // Дубина садится в фактические кисти, а направление берёт из своей
    // желейной точки: отставание и вес у неё остаются, но оторваться
    // от рук она больше не может.
    //
    // Точка хвата — не середина между кистями: при одноручном хвате
    // свободная рука висит у бедра, и середина утащила бы дубину к животу.
    // Поэтому середина подмешивается ровно настолько, насколько вторая рука
    // уже пришла на рукоять.
    const hold = pose.holdRight ? pose.handRight : pose.handLeft;
    _handMid.copy(pose.handLeft).add(pose.handRight).multiplyScalar(0.5);
    _handMid.lerpVectors(hold, _handMid, clamp01(pose.twoHanded));

    _clubDir.copy(pose.club).sub(_handMid);
    if (_clubDir.lengthSq() < 1e-6) _clubDir.copy(pose.clubDir);
    _clubDir.normalize();
    pose.club.copy(_handMid).addScaledVector(_clubDir, Rig.ClubGripOffset);

    this.set(b.hips, pose.hips, _hipsRot);
    this.set(b.chest, pose.chest, _chestRot);
    this.set(b.head, pose.head, _chestRot);
    this.set(b.club, pose.club, Rig.aim(_clubDir, _rot));

    this.placeLimb(b.legLUpper, _hipL, pose.kneeLeft);
    this.placeLimb(b.legLLower, pose.kneeLeft, pose.footLeft);
    this.placeLimb(b.legRUpper, _hipR, pose.kneeRight);
    this.placeLimb(b.legRLower, pose.kneeRight, pose.footRight);

    // Стопа стоит ровно и смотрит вперёд, как бы ни была согнута нога.
    _rot.identity();
    this.set(b.footL, pose.footLeft, _rot);
    this.set(b.footR, pose.footRight, _rot);

    this.placeLimb(b.armRUpper, _shoulderR, pose.elbowRight);
    this.placeLimb(b.armRFore, pose.elbowRight, pose.handRight);
    this.placeLimb(b.armLUpper, _shoulderL, pose.elbowLeft);
    this.placeLimb(b.armLFore, pose.elbowLeft, pose.handLeft);
  }

  placeLimb(bone, from, to) {
    Rig.limb(from, to, _center, _rot);
    this.set(bone, _center, _rot);
  }

  set(bone, localPos, localRot) {
    const index = this.writeIndex++;
    if (!bone) return;

    if (this.blendFromStart < 1 && this.startPositions && index < this.startPositions.length) {
      bone.position.copy(this.startPositions[index]).lerp(localPos, this.blendFromStart);
      bone.quaternion.copy(this.startRotations[index]).slerp(localRot, this.blendFromStart);
      return;
    }

    bone.position.copy(localPos);
    bone.quaternion.copy(localRot);
  }
}
