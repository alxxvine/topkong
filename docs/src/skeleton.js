import * as THREE from 'three';

// Скелет отдельно от тела.
//
// До этого пропорции куклы были рассыпаны константами по четырём файлам:
// размеры панелей в риге, массы и радиусы в физике, ширина шага в походке.
// Поменять телосложение значило пройтись по всем четырём и не забыть ни одной
// связи — а связей у скелета двадцать восемь, и каждая знает свою длину.
//
// Здесь наоборот: тело задаётся ТАБЛИЦЕЙ ЧИСЕЛ, а всё остальное из неё
// выводится. Пропорции — это клетки выкройки: голова 5x5, нога 8 длиной,
// рука 6. Из них считаются высоты, массы, радиусы касания, длины связей
// и опорная стойка. Ни физика, ни походка, ни отрисовка своих размеров
// больше не держат.
//
// Проверка тут простая и жёсткая: чтобы наложить на скелет другое тело,
// достаточно дописать сюда строчку с пропорциями. Если для этого пришлось
// тронуть что-то ещё — разделение не состоялось.

/** Индексы частиц. Порядок фиксирован: по нему собираются связи и цели. */
export const J = {
  Head: 0, Chest: 1, Hips: 2,
  HipL: 3, KneeL: 4, FootL: 5,
  HipR: 6, KneeR: 7, FootR: 8,
  ShoulderR: 9, ElbowR: 10, HandR: 11,
  ShoulderL: 12, ElbowL: 13, HandL: 14,
  ClubTip: 15,
};
export const JOINT_COUNT = 16;

// Сила мышцы у каждого сустава. ЭТО НЕ ПРОПОРЦИИ, а роли, и потому одно
// на все тела: у любой куклы корпус держится крепко, а дальние концы
// конечностей отпущены и болтаются на своих связях. Меняются размеры —
// роли остаются.
//
// Колену и локтю силы прибавлено против прежнего. Пока сквозная связь была
// жёсткой, она держала конечность прямой сама, и суставу оставалось только
// не выворачиваться; теперь связь — предел, и провиснув, выпрямлять ногу
// она перестаёт.
//
// Перебрано замером: при 0.3, 0.5, 0.85 и 1.2 нога стоя одинаково прямая
// (изгиб 0.0 см) — таз и так висит ровно на её длине, и связь-предел
// натянута. Разница видна на ступеньке: при 0.5 колено сгибается на 4.3 см,
// при 1.2 только на 2.9 — слишком крепкий сустав мешает как раз тому,
// ради чего излом и делался.
//
// У локтя своя мера. Стоя рука прямая при любой силе (0.6–1.5 см от прямой
// при размахе 54), а вот на ходу слабый локоть складывается до 6.5 см —
// рука начинает вилять на каждом махе. При 0.7 остаётся 3.5: видно, что
// сустав есть, но рука не болтается.
//
// Кисти тоже прибавлено, и по той же причине. Раньше её держала на отлёте
// сама кость: сквозная связь была жёсткой, и как бы слабо кисть ни тянуло,
// уехать внутрь она не могла. Теперь может — и локоть от этого ломается
// на ровном месте: у корня квадратного производная в нуле бесконечна,
// недотяг в семь миллиметров уводит сустав вбок на четыре сантиметра,
// и рука видимо изгибается там, где на деле почти прямая.
//
// И ещё раз прибавлено обоим — уже не ради прямизны, а ради спокойствия.
// Мягкая рука на развороте отставала от своей цели на 10–13 см и мотала
// концом вокруг тела; на ходу отставание доходило до 21. Рэгдольность
// от этого не появляется, появляется суматоха. Перебрано замером:
// при 1.2 отставание падает до 1.3 см на развороте и 2.9 на ходу,
// при 1.6 рука уже почти жёсткая и отыгрыша не остаётся вовсе.
const MUSCLE = [
  0.90, 1.30, 1.50,
  1.40, 0.50, 1.00,
  1.40, 0.50, 1.00,
  1.20, 1.20, 1.10,
  1.20, 1.20, 1.10,
  0.45,
];

// Мышцы ВТОРОЙ итерации тела: активный ragdoll, где позу держит всё
// одинаково крепко. Переключается на ходу через bodyMode.
const MUSCLE_SOFT = [
  0.40, 1.00, 1.30,
  1.20, 1.10, 1.10,
  1.20, 1.10, 1.10,
  0.80, 1.00, 1.10,
  0.80, 1.00, 1.10,
  0.45,
];

// Как масса детали делится между её частицами. Тоже роли, а не размеры.
const LEG_SHARE = [0.40, 0.32, 0.28];   // бедро, колено, дальний конец
const ARM_SHARE = [0.44, 0.31, 0.25];   // плечо, локоть, кисть
const TORSO_SHARE = { hips: 0.45, chest: 0.55 };

// Масса детали считается по ПЛОЩАДИ панели, а не по объёму. Панель — согнутый
// картон, она полая: у коротышки голова кубом в шестьдесят сантиметров,
// и по объёму на неё пришлось бы больше половины веса всего тела.
// По площади выходит треть — что для картонной коробки на плечах честно.
//
// Число подобрано так, чтобы картонная кукла весила столько же, сколько
// весила до разделения скелета и тела. Иначе пришлось бы заново настраивать
// отбрасывание при ударе, а оно к этой работе отношения не имеет.
const AREAL = 19.5;

/** Площадь поверхности коробки — по ней и считается масса детали. */
const shell = (h, w, d) => 2 * (h * w + h * d + w * d) * AREAL;

// Связь бывает двух родов, и разница между ними — это и есть колено.
//
// ЖЁСТКАЯ держит расстояние ровно, в обе стороны. ПРЕДЕЛ держит только
// сверху: длиннее нельзя, короче сколько угодно.
//
// Сквозная связь конечности — предел. Отсюда сразу оба нужных свойства.
// Стоя боец распрямлён: таз висит ровно на длине ноги, связь натянута
// и держит его как одна цельная кость — та самая устойчивость, ради
// которой цельная кость и делалась. А стоит стопе оказаться выше (ступенька,
// кочка, чужая нога) — расстояние сокращается, предел отпускает, и колено
// спокойно сгибается. Назад оно при этом не выгибается никогда: связь
// не даст разойтись дальше прямой.
//
// Раньше эта связь была жёсткой, и нога не гнулась вообще ни при каких
// обстоятельствах: наступить на что-то выше настила боец физически не мог.
export const LINK_LIMIT = 1;

const LINKS = [
  [J.Head, J.Chest], [J.Chest, J.Hips],
  [J.Head, J.Hips],                                     // раскос корпуса
  [J.Hips, J.HipL], [J.Hips, J.HipR], [J.HipL, J.HipR], // жёсткий таз
  [J.Chest, J.HipL], [J.Chest, J.HipR],
  [J.HipL, J.KneeL], [J.KneeL, J.FootL],
  [J.HipR, J.KneeR], [J.KneeR, J.FootR],
  // Предел, а не жёсткая связь: см. выше про колено и локоть.
  [J.HipL, J.FootL, LINK_LIMIT], [J.HipR, J.FootR, LINK_LIMIT],
  [J.ShoulderR, J.HandR, LINK_LIMIT], [J.ShoulderL, J.HandL, LINK_LIMIT],
  [J.Chest, J.ShoulderL], [J.Chest, J.ShoulderR], [J.ShoulderL, J.ShoulderR],
  [J.Head, J.ShoulderL], [J.Head, J.ShoulderR],
  [J.ShoulderL, J.HipR], [J.ShoulderR, J.HipL],         // X-раскос корпуса
  [J.ShoulderR, J.ElbowR], [J.ElbowR, J.HandR],
  [J.ShoulderL, J.ElbowL], [J.ElbowL, J.HandL],
  [J.HandR, J.ClubTip],                                 // хват одноручный
];

// --------------------------------------------------------------- телосложения
//
// Всё в клетках выкройки; cm переводит клетку в метры. Читать так же, как
// чертёж: голова 5 — значит куб пять на пять клеток.
//
// Три тела здесь не для красоты, а как проверка. Они нарочно разные по тому,
// что для походки и равновесия важнее всего: по длине ноги и по тому, где
// у куклы центр тяжести. Каланча высокая и лёгкая наверху, коротышка
// приземистый с тяжёлой головой — если поза и баланс считаются правильно,
// пойдут оба, и ни одной цифры под них подгонять не придётся.
export const BODIES = {
  картон: {
    title: 'Картонная кукла',
    cm: 0.09, spring: 0.35, depth: 1,
    head: 5, chestH: 2.5, chestTop: 2, chestBottom: 3, hips: 3,
    arm: 6, armTop: 2, armBottom: 3,
    leg: 8, legTop: 2, legBottom: 3,
  },
  каланча: {
    title: 'Каланча',
    cm: 0.085, spring: 0.4, depth: 0.8,
    head: 3.5, chestH: 4, chestTop: 2, chestBottom: 2.4, hips: 2.2,
    arm: 5, armTop: 1.3, armBottom: 1.8,
    leg: 12, legTop: 1.4, legBottom: 2,
  },
  коротышка: {
    title: 'Коротышка',
    cm: 0.1, spring: 0.3, depth: 1.3,
    head: 6, chestH: 2.2, chestTop: 3, chestBottom: 4, hips: 3.6,
    arm: 8, armTop: 2.4, armBottom: 3.4,
    leg: 4.5, legTop: 2.6, legBottom: 3.4,
  },
};

/** Оружие — не часть тела: одна дубина на любую куклу. */
export const CLUB = {
  headLocal: new THREE.Vector3(0, 0.36, 0),
  headRadius: 0.17,
  length: 0.80,
  radius: 0.06,
  gripOffset: 0.30,
  restReach: 0.38,
  mass: 9,
  /** Масса набалдашника, когда дубина убрана: почти ничего. */
  offMass: 0.25,
};

/**
 * Собрать скелет по пропорциям.
 *
 * Возвращает всё, что о теле нужно знать остальным: размеры для отрисовки,
 * высоты для позы, массы и радиусы для физики, длины связей для решателя.
 */
export function makeSkeleton(name, prop) {
  const cm = prop.cm;
  const s = {
    name,
    title: prop.title || name,
    prop,

    Spring: prop.spring * cm,
    PanelDepth: prop.depth * cm,
    HeadSize: prop.head * cm,
    ChestHeight: prop.chestH * cm,
    ChestTopWidth: prop.chestTop * cm,
    ChestBottomWidth: prop.chestBottom * cm,
    HipsSize: prop.hips * cm,
    ArmLength: prop.arm * cm,
    ArmTopWidth: prop.armTop * cm,
    ArmBottomWidth: prop.armBottom * cm,
    LegLength: prop.leg * cm,
    LegTopWidth: prop.legTop * cm,
    LegBottomWidth: prop.legBottom * cm,
  };

  // Рост складывается снизу вверх, деталь за деталью, с зазором на пружину
  // между ними. Ни одна высота не написана числом.
  s.FootY = s.PanelDepth * 0.6;
  s.HipJointY = s.FootY + s.LegLength;
  s.HipsY = s.HipJointY + s.Spring + s.HipsSize * 0.5;
  s.ChestY = s.HipsY + s.HipsSize * 0.5 + s.Spring + s.ChestHeight * 0.5;
  s.ShoulderY = s.ChestY + s.ChestHeight * 0.35;
  s.NeckY = s.ChestY + s.ChestHeight * 0.5;
  s.HeadY = s.NeckY + s.Spring + s.HeadSize * 0.5;
  s.HeadRadius = s.HeadSize * 0.5;
  s.Height = s.HeadY + s.HeadSize * 0.5;

  // Ноги стоят под тазом, руки подвешены снаружи груди — как на выкройке,
  // где пружины уходят от верхних углов груди в стороны.
  s.HipHalfWidth = s.LegTopWidth * 0.62;
  s.ShoulderHalfWidth = s.ChestTopWidth * 0.5 + s.Spring + s.ArmTopWidth * 0.5;
  s.ArmSpan = s.ArmLength;
  s.GripY = s.ShoulderY - s.ArmSpan * 0.55;

  // Массы — из объёма панелей, а не из таблицы. Иначе большая голова у
  // коротышки весила бы столько же, сколько маленькая у каланчи, и весь
  // смысл разных телосложений пропал бы: центр тяжести решает, устоит тело
  // или нет, куда сильнее, чем длина шага.
  const headMass = shell(s.HeadSize, s.HeadSize, s.HeadSize * 0.85);
  const torsoMass = shell(s.ChestHeight, (s.ChestBottomWidth + s.ChestTopWidth) * 0.5, s.PanelDepth * 2)
    + shell(s.HipsSize, s.HipsSize, s.PanelDepth * 2);
  const legMass = shell(s.LegLength, (s.LegTopWidth + s.LegBottomWidth) * 0.5, s.PanelDepth * 1.4);
  const armMass = shell(s.ArmLength, (s.ArmTopWidth + s.ArmBottomWidth) * 0.5, s.PanelDepth);

  s.mass = new Array(JOINT_COUNT);
  s.mass[J.Head] = headMass;
  s.mass[J.Chest] = torsoMass * TORSO_SHARE.chest;
  s.mass[J.Hips] = torsoMass * TORSO_SHARE.hips;
  for (const [hip, knee, foot] of [[J.HipL, J.KneeL, J.FootL], [J.HipR, J.KneeR, J.FootR]]) {
    s.mass[hip] = legMass * LEG_SHARE[0];
    s.mass[knee] = legMass * LEG_SHARE[1];
    s.mass[foot] = legMass * LEG_SHARE[2];
  }
  for (const [sh, el, hand] of [[J.ShoulderR, J.ElbowR, J.HandR], [J.ShoulderL, J.ElbowL, J.HandL]]) {
    s.mass[sh] = armMass * ARM_SHARE[0];
    s.mass[el] = armMass * ARM_SHARE[1];
    s.mass[hand] = armMass * ARM_SHARE[2];
  }
  s.mass[J.ClubTip] = CLUB.mass;
  s.bodyMass = s.mass.reduce((a, m, i) => a + (i === J.ClubTip ? 0 : m), 0);
  // Ширина стопы на настиле. Опора у куклы без стоп — это срез ноги,
  // и от его размера прямо зависит, насколько далеко можно завалиться,
  // не падая. Балансу без этого числа не обойтись.
  s.FootPrint = s.LegBottomWidth * 0.5;

  // Радиусы касания настила. У стопы он ОБЯЗАН совпадать с высотой, на
  // которую её ставит поза: пока они расходились, прибитая стопа каждый
  // кадр оказывалась выше цели, мышца тянула тело вниз, настил толкал
  // стопу вверх, и всё это разводилось вбок. Отсюда брался самоход.
  s.radius = new Array(JOINT_COUNT);
  s.radius[J.Head] = s.HeadSize * 0.44;
  s.radius[J.Chest] = s.ChestBottomWidth * 0.5 + s.PanelDepth;
  s.radius[J.Hips] = s.HipsSize * 0.5 + s.PanelDepth * 0.4;
  for (const [hip, knee, foot] of [[J.HipL, J.KneeL, J.FootL], [J.HipR, J.KneeR, J.FootR]]) {
    s.radius[hip] = s.LegTopWidth * 0.6;
    s.radius[knee] = (s.LegTopWidth + s.LegBottomWidth) * 0.28;
    s.radius[foot] = s.FootY;
  }
  for (const [sh, el, hand] of [[J.ShoulderR, J.ElbowR, J.HandR], [J.ShoulderL, J.ElbowL, J.HandL]]) {
    s.radius[sh] = s.ArmTopWidth * 0.55;
    s.radius[el] = (s.ArmTopWidth + s.ArmBottomWidth) * 0.22;
    s.radius[hand] = s.ArmBottomWidth * 0.25;
  }
  s.radius[J.ClubTip] = CLUB.headRadius;

  // Половинки конечности и ширина панели на изломе. Трапеция режется
  // ровно посередине, поэтому ширина в месте разреза — среднее концов:
  // сложи половинки обратно, и получится прежняя целая деталь.
  s.HalfLeg = s.LegLength * 0.5;
  s.HalfArm = s.ArmLength * 0.5;
  s.LegMidWidth = (s.LegTopWidth + s.LegBottomWidth) * 0.5;
  s.ArmMidWidth = (s.ArmTopWidth + s.ArmBottomWidth) * 0.5;

  s.muscle = MUSCLE;
  s.muscleSoft = MUSCLE_SOFT;
  s.links = LINKS;
  /** Какие связи держат только сверху. Индексы совпадают с links. */
  s.linkLimit = LINKS.map((l) => l[2] === LINK_LIMIT);
  return s;
}

// ------------------------------------------------------------- выбор тела
//
// Тело выбирается ОДИН РАЗ при загрузке. Менять его на ходу можно было бы,
// но пришлось бы пересобирать и панели, и связи, и опоры походки прямо
// посреди кадра — а выигрыш только в том, чтобы не нажимать перезагрузку.
// Перезагрузка честнее.

const STORAGE_KEY = 'topkong.body';

function stored() {
  try {
    const name = localStorage.getItem(STORAGE_KEY);
    return name && BODIES[name] ? name : null;
  } catch (e) {
    return null;
  }
}

export const bodyNames = Object.keys(BODIES);
export const currentBody = stored() || bodyNames[0];

/** Выбрать другое тело и перезагрузиться. */
export function chooseBody(name) {
  if (!BODIES[name]) return;
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch (e) { /* приватный режим — переживём */ }
  location.reload();
}

/** Скелет, на котором всё построено. Один на страницу. */
export const S = makeSkeleton(currentBody, BODIES[currentBody]);
