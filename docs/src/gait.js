import * as THREE from 'three';
import { tuning as T } from 'tk/tuning.js';
import { clamp, clamp01, lerp } from 'tk/mathx.js';
import * as Rig from 'tk/fighterRig.js';

// Все расстояния походки — В ДОЛЯХ ДЛИНЫ НОГИ, а не в метрах. Метры имели
// смысл, пока тело было одно; на каланче с ногой в метр тот же шаг в 15 см
// превратился бы в семенение, а на коротышке с ногой в 45 см — в шпагат.
const L = () => Rig.LegLength;

// Шаг с настоящей опорой.
//
// До этого стопы жили в системе таза: их цель считалась формулой от фазы
// шага и вместе со всем телом уезжала за тазом. Значит опоры не было вообще —
// таз ехал, стопы волочились следом, а цикл шага был чистой косметикой
// поверх скольжения. Отсюда и ощущение, что бойца тянет, а не что он идёт.
//
// Здесь наоборот. У каждой стопы есть МИРОВАЯ точка опоры, и пока стопа
// стоит, эта точка не двигается вообще: тело проходит над ней. Когда опора
// уезжает слишком далеко от того места, где ей полагается быть, стопа
// отрывается, переносится по дуге вперёд и втыкается в новую точку.
//
// Порог по расстоянию, а не таймер по расписанию, выбран намеренно: одним
// правилом закрываются все случаи разом. Стоит на месте — опоры на месте,
// шагов нет. Пошёл — шаги пошли сами, тем чаще, чем быстрее. Крутится
// на месте — опора уезжает вбок по дуге, и боец переступает. Толкнули —
// делает восстанавливающий шаг. Ничего из этого не пришлось описывать
// отдельно.

const _v = new THREE.Vector3();
const _t = new THREE.Vector3();

/** Плавный старт и плавная посадка: линейный перенос читается как подёргивание. */
const ease = (t) => t * t * (3 - 2 * t);

export class Gait {
  constructor(fighter, arena) {
    this.f = fighter;
    this.arena = arena;

    // side: −1 левая, +1 правая.
    this.feet = [
      { side: -1, plant: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(), t: 1, swinging: false },
      { side: 1, plant: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(), t: 1, swinging: false },
    ];
    /** Мировые цели стоп — то, ради чего всё считается. */
    this.world = [new THREE.Vector3(), new THREE.Vector3()];

    /**
     * Фаза шага 0..1. В отличие от прежней она не тикает по таймеру,
     * а двигается ТОЛЬКО когда нога действительно в воздухе. Поэтому
     * подскок корпуса и мах рук теперь привязаны к настоящим шагам,
     * а не идут своим чередом поверх скольжения.
     */
    this.phase = 0;
    /** Насколько высоко сейчас поднята маховая стопа, метры. Для отладки. */
    this.lift = 0;
    this.steps = 0;
    this.sinceStep = 99;
    /** Стопы, приземлившиеся на этом кадре: им гасят скорость. */
    this.landed = [false, false];
  }

  /** Воткнуть обе стопы под бойца. Вызывается на спавне. */
  reset(x, z, yaw) {
    for (const foot of this.feet) {
      this.ideal(foot, x, z, yaw, _v);
      foot.plant.copy(_v);
      foot.from.copy(_v);
      foot.to.copy(_v);
      foot.t = 1;
      foot.swinging = false;
    }
    this.world[0].copy(this.feet[0].plant);
    this.world[1].copy(this.feet[1].plant);
    this.phase = 0;
    this.steps = 0;
    this.sinceStep = 99;
  }

  /**
   * Куда этой стопе полагается стоять прямо сейчас.
   *
   * Смещение вбок разворачивается вместе с бойцом — из этого и берутся
   * переступания на развороте. Вперёд добавляется предсказание: пока идёт
   * перенос, тело уедет, и втыкать стопу надо туда, где тело окажется,
   * а не туда, где оно было.
   */
  ideal(foot, x, z, yaw, out) {
    const half = Rig.HipHalfWidth + T.stanceWidth * L();
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const sx = foot.side * half;
    return out.set(x + sx * cos, Rig.FootY, z - sx * sin);
  }

  /**
   * Куда втыкать стопу, когда она отрывается: вперёд по ходу от того места,
   * где ей полагается стоять.
   *
   * Вынос ОБЯЗАН быть ограничен радиусом досягаемости, и это не перестраховка.
   * Первая версия просто умножала скорость на время шага и на полном ходу
   * уносила опору на 64 сантиметра вперёд, тогда как нога по горизонтали
   * достаёт лишь на сорок с небольшим: бедро на высоте 0.81, длина ноги 0.82.
   * IK честно подтягивала недостижимую цель обратно к границе, стопа
   * уезжала вместе с телом — и опоры снова не было. Замерено: 87%
   * проскальзывания, ровно как без всякой походки.
   */
  foothold(foot, ideal, x, z, yaw, vx, vz, lead, out) {
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);

    // Куда хочется встать — от таза, в системе бойца: forward вдоль взгляда,
    // side вправо. Считать в мировых осях нельзя: пределы у ноги разные
    // вперёд и вбок, а в мире они перемешаны разворотом.
    let wantX = ideal.x + vx * T.stepTime * lead - x;
    let wantZ = ideal.z + vz * T.stepTime * lead - z;
    let side = wantX * cos - wantZ * sin;
    let forward = wantX * sin + wantZ * cos;

    const reach = T.stepReach * L();
    forward = clamp(forward, -reach, reach);

    // Вбок пределы свои и несимметричные. Наружу нога уходит недалеко:
    // при боковом ходе размах опоры доходил до 108 см, то есть по 54 см
    // от таза, боец раскорячивался и IK снова тащила стопу. Внутрь стопа
    // не заходит за среднюю линию вовсе — иначе ноги перекрещиваются.
    const home = foot.side * (Rig.HipHalfWidth + T.stanceWidth * L());
    const cross = T.stanceCross * L();
    const outward = T.stepSide * L();
    side = foot.side > 0
      ? clamp(side, cross, home + outward)
      : clamp(side, home - outward, -cross);

    out.set(
      x + side * cos + forward * sin,
      Rig.FootY,
      z - side * sin + forward * cos
    );

    // За кромкой опоры нет. Втыкать туда стопу — значит поставить бойца
    // на воздух: шаг укорачивается, пока опора не вернётся на настил.
    for (let i = 0; i < 4 && !this.arena.isOverDeck(out.x, out.z, L() * 0.17); i++) {
      side *= 0.5;
      forward *= 0.5;
      out.set(
        x + side * cos + forward * sin,
        Rig.FootY,
        z - side * sin + forward * cos
      );
    }
    return out;
  }

  /**
   * @param {number} vx,vz  скорость тела — по ней предсказывается опора
   * @param {number} speed  модуль горизонтальной скорости
   */
  tick(dt, x, z, yaw, vx, vz, speed, grounded) {
    this.sinceStep += dt;
    this.landed[0] = false;
    this.landed[1] = false;

    // Куда боец СОБИРАЕТСЯ идти — отдельно от того, куда он едет.
    //
    // Настоящей скорости для наводки шага не хватает, и это не мелочь.
    // Пока на настиле обе стопы, две цельные ноги к двум прибитым точкам
    // не оставляют тазу ни одной степени свободы по горизонтали: замерено,
    // вбок он проезжает восемь сантиметров и упирается намертво. Порог
    // отрыва при этом восемнадцать — и не наступает никогда. Боец
    // застревал на месте, честно пытаясь идти.
    //
    // У человека тут то же самое, и решается оно так же: сперва решаешь
    // шагнуть, и только потом падаешь в шаг. Шаг начинается от намерения.
    const loco = this.f.locomotion;
    const spin = loco ? Math.abs(loco.yawSpeed) : 0;
    const wantX = loco ? loco.wantX : 0;
    const wantZ = loco ? loco.wantZ : 0;
    const wanted = Math.hypot(wantX, wantZ);

    // Тело едет заметно медленнее заказанного — значит оно упёрлось
    // в собственные ноги, и ждать от опоры отставания бессмысленно.
    const stuck = wanted > 0.05 && speed < wanted * 0.4 && this.sinceStep > T.stepTime * 1.2;

    // Наводка идёт по тому из двух, что больше: застрявшее тело метит шаг
    // по намерению, идущее — по настоящему ходу.
    let lead = speed >= wanted ? speed : wanted;
    let lx = speed >= wanted ? vx : wantX;
    let lz = speed >= wanted ? vz : wantZ;

    // Равновесие перебивает и то, и другое.
    //
    // Когда точка перехвата вышла за опору, устоять уже нельзя — можно
    // только успеть подставить ногу, и подставить именно ТУДА, куда валит.
    // Направление падения тут важнее и намерения игрока, и текущего хода:
    // шагнуть «куда шёл» в этот момент значит просто лечь.
    const bal = this.f.balance;
    const catching = !!(bal && bal.needStep && grounded);
    if (catching) {
      lx = bal.fallX;
      lz = bal.fallZ;
      lead = Math.max(lead, T.maxRunSpeed * 0.5);
    }

    // Заброс стопы вперёд по скорости нужен и на развороте тоже. Пробовал
    // отключать его без ввода движения — рассуждение было, что остаточная
    // скорость забрасывает стопу в сторону и тело идёт за ней. Стало хуже:
    // стопа приземляется под тело, дуга разворота не предугадана, боец
    // добирает переступаниями, и уносит его сильнее — 2.1 м против 0.7.
    const predict = T.stepLead;

    const norm = clamp01(lead / Math.max(0.1, T.maxRunSpeed));

    // Длину шага по скорости НЕ подгоняем, хотя соблазн есть и он понятен.
    // Проверено: частота шага подстраивается сама, и ход остаётся тем же.
    // Укорачивание заднего шага втрое не изменило задний ход вовсе,
    // а боковой при этом упал вчетверо. Разницу скоростей по направлениям
    // задаёт локомоция, и этого достаточно — замерено, назад выходит
    // 0.90 м/с при заказанных 0.94.

    // Перенос тем быстрее, чем быстрее идёт боец: иначе на бегу нога
    // не успевает вернуться под тело и он начинает загребать.
    const stepTime = T.stepTime * lerp(1.5, 0.65, norm);
    const swinging = this.feet.find((f) => f.swinging);

    for (let i = 0; i < 2; i++) {
      const foot = this.feet[i];
      this.ideal(foot, x, z, yaw, _v);

      if (foot.swinging) {
        foot.t = Math.min(1, foot.t + dt / Math.max(0.02, stepTime));
        // Цель переноса подтягивается на лету: пока нога в воздухе, тело
        // успевает и ускориться, и повернуть. Пересчитывается через тот же
        // ограничитель, иначе на разгоне цель уползёт за предел досягаемости.
        this.foothold(foot, _v, x, z, yaw, lx, lz, predict, _t);
        foot.to.lerp(_t, clamp01(8 * dt));

        const k = ease(foot.t);
        const up = Math.sin(Math.PI * foot.t) * T.stepLift * L();
        this.world[i].set(
          lerp(foot.from.x, foot.to.x, k),
          Rig.FootY + up,
          lerp(foot.from.z, foot.to.z, k)
        );
        this.lift = up;

        // Фаза идёт вперёд ровно на половину цикла за шаг: левая нога
        // ведёт первую половину, правая вторую.
        this.phase = (foot.side < 0 ? 0 : 0.5) + foot.t * 0.5;

        if (foot.t >= 1) {
          foot.swinging = false;
          foot.plant.copy(foot.to);
          this.world[i].copy(foot.plant);
          this.landed[i] = true;
        }
        continue;
      }

      // Стопа стоит: её мировая цель не меняется вообще. Это и есть опора.
      this.world[i].copy(foot.plant);
      if (!grounded) continue;

      const dx = foot.plant.x - _v.x;
      const dz = foot.plant.z - _v.z;
      const away = Math.hypot(dx, dz);

      // Отставание считается ВДОЛЬ ХОДА, со знаком, а не просто расстоянием.
      // Это не тонкость: стопа втыкается на треть метра ВПЕРЁД, и для
      // ненаправленного порога она в тот же миг оказывается «далеко» —
      // нога просилась шагать сразу после приземления. Замерено: шесть
      // шагов в секунду и шаг длиной в треть метра на любой скорости,
      // хоть на полутора метрах в секунду, хоть на трёх с половиной.
      //
      // Позади — шагаем. Впереди — стоим и ждём, пока тело подойдёт.
      let behind = away;
      if (lead > 0.25) {
        const ix = lx / lead;
        const iz = lz / lead;
        behind = -(dx * ix + dz * iz);
      }

      // Опора вне досягаемости — отрываемся немедленно, не считаясь ни
      // с очередью, ни с паузой. Иначе быстрый боец не успевает переставлять
      // ноги: пока одна в воздухе, вторая уже вне предела, IK подтягивает
      // её цель к границе и стопа едет юзом.
      const stranded = away > (T.stepReach + T.stepTrigger) * L();

      // У разворота порог свой и меньший. Основной считается ВДОЛЬ ХОДА,
      // а на месте хода нет — опора уезжает вбок по дуге, и ждать от неё
      // отставания по направлению движения бессмысленно. С длинным шагом
      // это стало заметно: боец доворачивался юзом, пока опора не уедет
      // на 28 сантиметров, и только потом переставлял ногу рывком.
      // Только когда боец ДЕЙСТВИТЕЛЬНО ВЕРТИТСЯ. Одного «хода нет» мало:
      // стоящий боец качается сам по себе, и опора уезжает от положенного
      // места без всякого разворота — замерено, он принимался переступать
      // на ровном месте. А на ходу этот порог сработал бы раньше основного
      // и съел бы всю длину шага: частота подскакивала с 2.7 до 6.5.
      const pivot = spin > T.stepPivotRate && away > T.stepPivot * L();

      if (!stranded && (swinging || this.sinceStep < T.stepGap)) continue;

      // Порог у правой ноги чуть больше: иначе обе, оказавшись симметрично,
      // спорят за право шагнуть и боец мелко семенит на месте.
      const bias = i === 0 ? 1 : 1.08;
      // Застрявшему телу шагает та нога, что отстала сильнее: иначе право
      // на шаг достаётся просто первой в списке, и боец уходит вбок,
      // приволакивая вторую.
      const urge = (stuck || catching)
        && behind >= this.behindOther(i, x, z, yaw, lx, lz, lead);
      if (!stranded && !pivot && !urge && behind < T.stepTrigger * L() * bias) continue;

      foot.swinging = true;
      foot.t = 0;
      foot.from.copy(foot.plant);
      this.foothold(foot, _v, x, z, yaw, lx, lz, predict, foot.to);
      this.sinceStep = 0;
      this.steps++;
    }

    if (!this.feet[0].swinging && !this.feet[1].swinging) this.lift = 0;
  }

  /** Отставание ВТОРОЙ стопы. Нужно, чтобы шагала та, что отстала сильнее. */
  behindOther(i, x, z, yaw, lx, lz, lead) {
    const other = this.feet[1 - i];
    if (other.swinging) return -Infinity;
    this.ideal(other, x, z, yaw, _t);
    const dx = other.plant.x - _t.x;
    const dz = other.plant.z - _t.z;
    if (lead <= 0.25) return Math.hypot(dx, dz);
    return -(dx * lx + dz * lz) / lead;
  }

  /** Насколько далеко опора уехала от положенного — по ней видно, что пора шагать. */
  strain(x, z, yaw) {
    let worst = 0;
    for (const foot of this.feet) {
      this.ideal(foot, x, z, yaw, _v);
      worst = Math.max(worst, Math.hypot(foot.plant.x - _v.x, foot.plant.z - _v.z));
    }
    return worst;
  }
}
