import * as THREE from 'three';
import { tuning as T } from 'tk/tuning.js';
import { clamp, clamp01, lerp, moveTowards, deltaAngle, noiseSigned, inverseLerp, RAD, DEG } from 'tk/mathx.js';
import * as Rig from 'tk/fighterRig.js';
import { P } from 'tk/body.js';

// Стопы приходят из походки в мировых координатах, а поза считается
// в локальных: здесь они и переводятся.
const _footL = new THREE.Vector3();
const _footR = new THREE.Vector3();
const _hand = new THREE.Vector3();

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
    this.leanVel = 0;
    this.swayVel = 0;
    this.clubLag = 0;
    this.lastYaw = 0;
    this.yawRate = 0;
    this.lastSpeed = 0;
    this.noiseSeed = Math.random() * 100;
    /** Своя медленная фаза пьяного качания. */
    this.drunkPhase = Math.random() * 100;

    /** Разворот плечевого пояса относительно таза, градусы. */
    this.twist = 0;
    /** Рывок скрута от задевания. Затухает сам, входит в цель скрута. */
    this.grazeJolt = 0;
    /** Доворот головы относительно плеч, радианы. Читает его отрисовка. */
    this.headTurn = 0;
    /** Фаза дыхания. В покое тело иначе стоит абсолютно неподвижно. */
    this.breath = Math.random();

    /** How far the hands are overridden away from the stock pose:
     *  a punch in flight and a held block. Blended so entering and
     *  leaving never snaps. */
    this.punchBlend = 0;
    this.blockBlend = 0;
    /** Dash pulse 1→0: a crouch-and-lunge that sells the hop. Set by
     *  main on the dash, decays here. */
    this.dashKick = 0;

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

    // The dash pulse decays here, BEFORE the body-mode split: both pose
    // paths read it (a lean term at their computePose calls plus a dip
    // of the hips). Without it the dash read as "walking, but briefly
    // faster".
    this.dashKick = Math.max(0, this.dashKick - 5 * dt);

    // Кинематическая походка — первая итерация тела, вернувшаяся режимом.
    //
    // Стопы считаются формулой от фазы, а фаза крутится тем быстрее, чем
    // быстрее едет боец. Опоры в мире нет, проскальзывание есть — и всё же
    // читается это ходьбой лучше, чем настоящая походка на мышцах: цикл
    // нарисован, а не собран из десятка спорящих чисел. В покое фаза
    // подтягивается к целому, чтобы ноги вставали ровно.
    if (T.bodyMode <= 1) {
      this.kinematicTick(dt, strideNorm, grounded);
      return this.pose;
    }

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

    this.bob -= this.dashKick * 0.1;

    this.updateWobble(dt, planarSpeed, strideNorm);
    this.updateTwist(dt, strideNorm, grounded);

    Rig.computePose(this.pose, this.bob, this.stepPhase, this.stride,
      swing.angle + this.clubLag, swing.reach,
      swing.lean + this.lean + this.dashKick * 0.55, this.sway,
      swing.height, swing.pitch, this.lift, this.twist, _footL, _footR,
      this.f.hasClub);

    this.overrideHands(dt);
    this.solveJoints();
    return this.pose;
  }

  /**
   * Поза первой итерации: цикл шага от фазовых часов, без мировых опор.
   */
  kinematicTick(dt, strideNorm, grounded) {
    const swing = this.f.swing;
    if (strideNorm > 0.05 && grounded) {
      this.stepPhase += dt * T.stepRate * strideNorm;
      this.stepPhase -= Math.floor(this.stepPhase);
    } else {
      this.stepPhase = moveTowards(this.stepPhase, Math.round(this.stepPhase), dt * 2);
    }

    this.stride = moveTowards(this.stride,
      grounded ? strideNorm * T.stepLength * Rig.LegLength : 0, dt * 3);
    this.lift = T.stepLift * Rig.LegLength * strideNorm;

    // Подскок вдвое чаще шага: две ноги — два толчка за цикл.
    const targetBob = grounded
      ? Math.abs(Math.sin(this.stepPhase * Math.PI * 2)) * T.stepBobKinematic
        * Rig.LegLength * strideNorm
      : 0;
    this.bob = lerp(this.bob, targetBob, clamp01(12 * dt * this.softness()));
    this.bob -= this.dashKick * 0.1;

    this.updateWobble(dt, this.f.locomotion.planarSpeed, strideNorm);
    this.updateTwist(dt, strideNorm, grounded);

    // Стопы НЕ передаются: computePose посчитает их формулой от фазы.
    Rig.computePose(this.pose, this.bob, this.stepPhase, this.stride,
      swing.angle + this.clubLag, swing.reach,
      swing.lean + this.lean + this.dashKick * 0.55, this.sway,
      swing.height, swing.pitch, this.lift, this.twist, null, null,
      this.f.hasClub);

    this.overrideHands(dt);
    this.solveJoints();
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

    // 5. Задевание: плечи крутануло за проходящим. Рывок сидит в ЦЕЛИ,
    // а не в самом скруте — иначе сглаживание съедало его за десятую
    // секунды, и от касания оставалось пять градусов вместо двадцати.
    this.grazeJolt *= Math.max(0, 1 - 4 * dt);
    const target = fromTurn + fromStep + fromSwing + fromBreath + this.grazeJolt;
    // Плечи набирают скрут не мгновенно: масса корпуса своё берёт.
    this.twist = lerp(this.twist, target, clamp01(11 * dt * this.softness()));

    // Голова доворачивается ОТ ПЛЕЧ, поэтому из её угла вычитается скрут:
    // плечи и так уже уехали. Ограничение накладывается на итог, а не
    // на слагаемое — иначе на быстром развороте отставание плеч и вынос
    // головы складывались бы и шея выворачивалась.
    const headOffset = clamp(headLead - this.twist, -T.headTurnMax, T.headTurnMax);
    this.headTurn = lerp(this.headTurn, headOffset * DEG, clamp01(9 * dt * this.softness()));
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
    // Конечность из двух половинок, но прямая, пока прямой быть можно:
    // flexJoint кладёт сустав ровно на середину отрезка, если конец
    // на полной длине, и отводит его в сторону полюса, только если конец
    // подошёл ближе. Стоящий боец распрямлён; согнётся он, когда стопа
    // окажется выше настила.
    Rig.flexJoint(pose.shoulderRight, pose.handRight, Rig.HalfArm, Rig.armPole(true), pose.elbowRight);
    Rig.flexJoint(pose.shoulderLeft, pose.handLeft, Rig.HalfArm, Rig.armPole(false), pose.elbowLeft);
    Rig.flexJoint(pose.hipLeft, pose.footLeft, Rig.HalfLeg, Rig.legPole(), pose.kneeLeft);
    Rig.flexJoint(pose.hipRight, pose.footRight, Rig.HalfLeg, Rig.legPole(), pose.kneeRight);
  }

  /**
   * Hand overrides on top of the stock pose: punches and the block.
   *
   * computePose knows two hand jobs — carrying the club and the guard
   * stance — and both keep the arm at full length (see onSphere there).
   * The two poses that NEED a bent elbow live here instead, applied after
   * the formula and before the joint solve, so flexJoint sees the final
   * hand and bends the elbow toward its pole:
   *
   *  - a punch: the striking fist rides the swing timeline. The swing
   *    fields already describe a hand (direction, reach, height); the
   *    club-less fighter just applies them to the alternating fist while
   *    the other hand stays in guard.
   *  - the block: with a club the right hand pulls in to the chest, club
   *    upright — held like a shield, not wound up. Bare-handed both
   *    fists come up in front of the chin, a boxing shell.
   */
  overrideHands(dt) {
    const f = this.f;
    const sw = f.swing;
    const pose = this.pose;

    const punching = !f.hasClub
      && (sw.state === 'windup' || sw.state === 'strike' || sw.state === 'recover');
    this.punchBlend = lerp(this.punchBlend, punching ? 1 : 0, clamp01(14 * dt));
    this.blockBlend = lerp(this.blockBlend, sw.blockPose ? 1 : 0, clamp01(12 * dt));
    if (this.punchBlend > 0.01) {
      const a = sw.angle * DEG;
      // Reach caps past the arm: the fist lands straight-armed with the
      // shoulder rolled in, and anything shorter keeps the elbow bent —
      // the chamber before the hit. The forward lean of the strike adds
      // its own reach: a punch is thrown with the body, not the arm.
      const r = Math.min(Rig.ArmLength * 1.3, Math.max(0.16, sw.reach));
      // The lateral term mirrors for the left fist, so a left punch is a
      // true mirror of a right one, not a cross-body reach.
      _hand.set(Math.sin(a) * r * sw.hand, Rig.GripY + sw.height + 0.08,
        Math.cos(a) * r + Math.max(0, sw.lean) * 0.2);
      const target = sw.hand >= 0 ? pose.handRight : pose.handLeft;
      target.lerp(_hand, this.punchBlend);
    }
    if (this.blockBlend > 0.01) {
      if (f.hasClub) {
        _hand.set(0.12, 1.14, 0.32);
        pose.handRight.lerp(_hand, this.blockBlend);
        // The grip was welded to the hand by computePose — re-weld it.
        pose.grip.copy(pose.handRight);
      } else {
        _hand.set(0.17, 1.34, 0.28);
        pose.handRight.lerp(_hand, this.blockBlend);
        _hand.set(-0.17, 1.34, 0.28);
        pose.handLeft.lerp(_hand, this.blockBlend);
      }
    }
  }

  /**
   * Довести наклон до цели ПРУЖИНОЙ, а не сглаживанием.
   *
   * Сглаживание (lerp к цели) инерции не даёт вовсе: у него нет своей
   * скорости, поэтому тело не отстаёт на старте и не проскакивает
   * на остановке — оно просто быстро оказывается там, где велено.
   * Отсюда и ощущение робота даже при верно посчитанном наклоне.
   *
   * У пружины скорость есть. Демпфер задан ДОЛЕЙ от критического: единица —
   * приход к цели без перелёта, меньше — тело проскакивает вертикаль
   * и качается обратно. Ровно это и читается весом: встал — корпус
   * догоняет остановку и отыгрывает назад в отвес.
   *
   * Цель при нулевой скорости равна нулю, поэтому отвес получается сам:
   * специального «выпрямиться, когда стоишь» не нужно.
   */
  springTo(key, target, dt) {
    const soft = this.softness();
    const stiff = T.leanStiffness * soft * soft;
    const damp = 2 * Math.sqrt(Math.max(0, stiff)) * T.leanDamping;
    const vKey = key + 'Vel';
    let v = this[vKey] || 0;
    const x = this[key];
    v += ((target - x) * stiff - v * damp) * dt;
    this[vKey] = v;
    return x + v * dt;
  }

  /**
   * Во сколько раз медленнее тело доводит позу до цели.
   *
   * Одно число на все доводки разом. Порознь их крутить нельзя: корпус,
   * плечи, голова и подскок обязаны отставать СОГЛАСОВАННО, иначе выходит
   * не вялость, а рассинхрон — часть тела уже приехала, часть ещё едет.
   */
  softness() {
    return 1 / (1 + T.drunk * T.drunkSoft * 2.2);
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
    // Скорость В СИСТЕМЕ БОЙЦА: вдоль взгляда и вбок от него. Мировые оси
    // тут не годятся — наклон должен зависеть от того, куда боец повёрнут,
    // а не от того, куда смотрит камера.
    const loco = this.f.locomotion;
    const sinY = Math.sin(this.f.yaw);
    const cosY = Math.cos(this.f.yaw);
    const vForward = loco.velX * sinY + loco.velZ * cosY;
    const vSide = loco.velX * cosY - loco.velZ * sinY;

    // Расшатка от тарана: наклон ТУДА, КУДА ТОЛКАЮТ, — телеграф падения.
    // Мировое направление тарана раскладывается по осям бойца и входит
    // и в наклон вперёд-назад, и в завал вбок. Поверх — мелкая дрожь:
    // без неё наклон читается позой, а не борьбой за равновесие.
    const stag = this.f.stagger || 0;
    let staggerLean = 0;
    let staggerSway = 0;
    if (stag > 0.02) {
      const tilt = stag * T.staggerLean;
      staggerLean = (this.f.staggerDirX * sinY + this.f.staggerDirZ * cosY) * tilt;
      staggerSway = (this.f.staggerDirX * cosY - this.f.staggerDirZ * sinY) * tilt
        + noiseSigned(this.noiseSeed + 47.7, performance.now() * 0.0028) * stag * 0.5;
    }

    // 1а. НАКЛОН В СТОРОНУ ХОДА — от самой скорости, а не от её изменения.
    //
    // Раньше наклон брался только от ускорения, и это и был весь «робот»:
    // качнуло на старте, качнуло на остановке, а между ними боец ехал
    // стоймя, как деталь на конвейере. Человек же весь путь идёт наклонённым
    // туда, куда идёт, — иначе он бы не шёл, а падал назад.
    const leanSpeed = vForward * T.leanFromSpeed * T.leanAmount;

    // 1б. Инерция: разгоняешься — корпус отстаёт назад, тормозишь — валится
    // вперёд. Складывается с наклоном от скорости, а не заменяет его:
    // на старте боец сперва отваливается назад, потом входит в наклон.
    //
    // Множитель тот же, что и у наклона от скорости: ручка обязана усиливать
    // ОБА, иначе на большом наклоне инерция теряется на его фоне.
    const acceleration = (planarSpeed - this.lastSpeed) / Math.max(1e-5, dt);
    this.lastSpeed = planarSpeed;
    const leanTarget = clamp(
      leanSpeed + staggerLean - acceleration * T.leanFromAccel * T.leanAmount,
      -1.8, 1.8);
    this.lean = this.springTo('lean', leanTarget, dt);

    // 2. Покачивание, усиленное у края.
    const dist = Math.hypot(this.f.position.x, this.f.position.z);
    const edge = inverseLerp(T.arenaRadius * 0.55, T.arenaRadius, dist);
    const amount = T.wobbleAmount * (0.4 + normalized) * (1 + edge * 2);
    const n = noiseSigned(this.noiseSeed, performance.now() * 0.001 * T.wobbleRate);
    const stepSway = Math.sin(this.stepPhase * Math.PI * 2) * 0.5 * normalized;

    // Наклон ВБОК — тот же закон, что и вперёд: идёшь боком, валишься боком.
    // sway разносит тело тем сильнее, чем выше точка (таз 0.02, грудь 0.10,
    // голова 0.22), то есть это именно завал, а не съезд вбок целиком.
    const listSpeed = vSide * T.listFromSpeed * T.leanAmount;

    // Пьяная добавка живёт в том же канале: своя медленная частота
    // и завал ОТ ХОДА, когда корпус отстаёт от собственных ног.
    this.drunkPhase += dt * T.drunkRate;
    const drunkNoise = noiseSigned(this.noiseSeed + 91.3, this.drunkPhase);
    const drunkSway = T.drunk
      * (drunkNoise * T.drunkSway * 2.2 - vSide * T.drunkList * 0.9);

    this.sway = this.springTo('sway',
      (n + stepSway) * amount + listSpeed + drunkSway + staggerSway, dt);

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
    this.leanVel = 0;
    this.swayVel = 0;
    this.clubLag = 0;
    this.punchBlend = 0;
    this.blockBlend = 0;
    this.dashKick = 0;
    this.lastSpeed = 0;
    this.lastYaw = this.f.yaw * RAD;
    this.twist = 0;
    this.grazeJolt = 0;
    this.headTurn = 0;
  }
}
