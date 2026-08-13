import * as THREE from 'three';
import { S } from 'tk/skeleton.js';
import { tuning as T, loadTuning } from 'tk/tuning.js';
import { clamp01, lerp } from 'tk/mathx.js';
import { Arena, VOID_COLOR } from 'tk/arena.js';
import { CameraRig } from 'tk/cameraRig.js';
import { Fighter, BodyState } from 'tk/fighter.js';
import { Bot } from 'tk/bot.js';
import { resolveContacts } from 'tk/contact.js';
import { Match } from 'tk/match.js';
import { P } from 'tk/body.js';
import { Input } from 'tk/input.js';
import { Ui } from 'tk/ui.js';

// Точка сборки: сцена, цикл, спавн и всё, что связывает модули между собой.
//
// Геймплея здесь намеренно нет — ни раундов, ни победы, ни ботов. Сейчас это
// стенд для физики: один управляемый боец, несколько манекенов и панель
// настроек. Всё остальное встанет сюда позже, когда ощущение удара сойдётся.

// Шаг физики фиксированный. Верле с плавающим шагом ведёт себя по-разному
// на 60 и 144 Гц, а подбирать ощущения на плавающей физике бессмысленно.
const STEP = 1 / 120;
const MAX_STEPS = 10;

const _basis = { forward: new THREE.Vector3(), right: new THREE.Vector3() };

export async function start() {
  loadTuning();

  const canvas = document.getElementById('view');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Нейтральный тонмаппинг вместо киношного ACES. ACES тянет картинку
  // в контраст и подкрашивает света — для тёмной сцены это было кстати,
  // для светлой матовой он съедает как раз те полутона, на которых она
  // и держится. Если в этой сборке three его нет, откатываемся на ACES.
  renderer.toneMapping = THREE.NeutralToneMapping || THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  // Ортографическая: изометрия. Рамку кадра задаёт CameraRig — здесь
  // ставятся заглушки, они всё равно будут переписаны на первом resize.
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -60, 260);

  const arena = new Arena(scene);
  const rig = new CameraRig(camera);
  const input = new Input(canvas);
  const ui = new Ui();
  const fx = new HitFx(scene);

  const player = new Fighter(scene, arena, {
    isPlayer: true, name: 'Игрок', color: 0xff8a5c, x: 0, z: -2, yaw: 0,
  });
  // Прицел собирается ПОСЛЕ игрока: он красится его цветом.
  const aim = new AimCursor(scene, player.color);
  const fighters = [player];
  const dummies = [];

  syncDummies(scene, arena, dummies, fighters);

  // Матч перезапускает раунд сам, поэтому расстановка отдаётся ему целиком.
  const match = new Match(fighters, player, () => placeRound(fighters, arena));

  resize();
  addEventListener('resize', resize);
  document.getElementById('boot').classList.add('gone');

  function resize() {
    const w = innerWidth;
    const h = innerHeight;
    renderer.setSize(w, h, false);
    rig.applyFrustum(w / h);
  }

  let last = performance.now();
  let accumulator = 0;
  let now = 0;
  let hitStop = 0;
  let fps = 60;
  let paused = false;
  let lastOverField = null;

  ui.onPauseToggle = () => {
    paused = !paused;
    ui.setPaused(paused);
    // Накопитель обнуляется на выходе: за время паузы кадры шли, а шаги
    // физики нет, и без сброса игра доганяла бы пропущенное пачкой шагов.
    if (!paused) { accumulator = 0; last = performance.now(); }
  };

  function frame(time) {
    requestAnimationFrame(frame);

    const real = Math.min(0.1, (time - last) / 1000);
    last = time;

    // Пауза останавливает ВСЁ: физику, ботов, матч, эффекты и камеру.
    // Кадр при этом продолжает рисоваться — иначе окно замирает мёртвой
    // картинкой и непонятно, игра встала или вкладка.
    if (paused) {
      renderer.render(scene, camera);
      return;
    }
    fps = lerp(fps, 1 / Math.max(1e-4, real), 0.08);

    arena.tick();
    if (dummies.length !== Math.round(T.dummyCount)) {
      syncDummies(scene, arena, dummies, fighters);
    }

    // Прицел считается до физики: боец должен разворачиваться туда, куда
    // мышь смотрит в этом кадре, а не в прошлом.
    if (input.updateAim(camera, innerWidth, innerHeight)) {
      const limit = arena.radius * T.aimMaxRadiusFactor;
      const len = Math.hypot(input.aim.x, input.aim.z);
      if (len > limit) input.aim.multiplyScalar(limit / len);
    }

    rig.groundBasis(_basis);
    const move = input.updateMove();
    // Ход привязан к экрану, а не к бойцу: на виде сверху «вверх» обязано
    // означать «от камеры», иначе управление вращается вместе с персонажем.
    player.moveInput.set(
      _basis.right.x * move.x + _basis.forward.x * move.y,
      _basis.right.z * move.x + _basis.forward.z * move.y
    );
    // Прицел: с телефона его ведёт правый стик, с мыши — курсор.
    // Стик отдаёт направление в экранных осях, и в мир оно переводится
    // тем же базисом, что и ход, — иначе «вправо» на стике означало бы
    // не то же самое, что «вправо» на экране.
    if (input.aimStickHeld && input.aimVector.lengthSq() > 0.04) {
      const ax = _basis.right.x * input.aimVector.x + _basis.forward.x * input.aimVector.y;
      const az = _basis.right.z * input.aimVector.x + _basis.forward.z * input.aimVector.y;
      const len = Math.hypot(ax, az) || 1;
      input.aim.set(
        player.position.x + (ax / len) * 6, 0, player.position.z + (az / len) * 6);
    }

    player.facingTarget.copy(input.aim).sub(player.position);
    player.facingTarget.y = 0;
    player.swing.held = input.swingHeld && match.controlEnabled;
    if (!match.controlEnabled) player.moveInput.set(0, 0);

    if (input.consumeReset()) match.begin();

    // Замедление и хит-стоп — одно и то же: время идёт медленнее, ввод нет.
    let scale = input.slowMotion ? T.slowMotion : 1;
    if (hitStop > 0) {
      hitStop = Math.max(0, hitStop - real);
      scale *= 0.15;
    }

    accumulator += real * scale;
    let steps = 0;
    while (accumulator >= STEP && steps < MAX_STEPS) {
      accumulator -= STEP;
      steps++;
      now += STEP;

      // Боты думают ДО физики: они пишут те же поля ввода, что и игрок,
      // и тик бойца обязан увидеть уже свежие.
      // Выключенные боты не «думают ноль» — они не думают вовсе и стоят:
      // удобно спокойно пробовать управление, удары и толчки.
      if (match.controlEnabled && T.botsActive) {
        for (const d of dummies) if (d.bot) d.bot.tick(STEP, fighters);
      } else {
        for (const d of dummies) { d.moveInput.set(0, 0); d.swing.held = false; }
      }

      // Тела занимают место — ДО тика: тик ставит таз туда, куда указывает
      // корень, и правку положения должен увидеть он, а не следующий кадр.
      resolveContacts(fighters, STEP);

      for (const f of fighters) f.tick(STEP, match.controlEnabled);

      for (const f of fighters) {
        f.checkHits(fighters, STEP, now, (attacker, victim, point, strength) => {
          fx.spawn(point, strength);
          rig.addShake(0.25 + strength * 0.75 * T.shakeMul);
          hitStop = T.hitStopMax * (0.4 + strength * 0.6);
        });
      }

      match.tick(STEP);
    }
    // Хвост накопителя не копится бесконечно: после долгого залипания вкладки
    // иначе прилетает пачка шагов и всё разлетается.
    if (accumulator > STEP * MAX_STEPS) accumulator = 0;

    // Метка живёт только над настилом: за кромкой ей лежать не на чем,
    // она упирается в предел и перестаёт следовать за мышью. Там её
    // подменяет системный курсор — см. body.offfield в стилях.
    const overField = arena.isOverDeck(input.aim.x, input.aim.z);
    if (overField !== lastOverField) {
      lastOverField = overField;
      document.body.classList.toggle('offfield', !overField);
    }
    aim.setVisible(overField);
    aim.update(input.aim, player);
    scene.userData.camQuat = camera.quaternion;
    fx.tick(real);

    rig.lookAhead.copy(player.facingTarget).setY(0);
    if (rig.lookAhead.lengthSq() > 1) rig.lookAhead.normalize();
    rig.tick(real, player.alive ? player.position : null);

    ui.setHud(hudText(player, arena, fps, input, match));
    ui.setBanner(match.banner);
    if (ui.swingButton) ui.swingButton.style.display = T.withClub ? '' : 'none';
    renderer.render(scene, camera);
  }

  requestAnimationFrame(frame);

  // Пригодится из консоли браузера и из автотеста.
  const api = { scene, camera, renderer, arena, rig, player, fighters, dummies, input, match, ui, tuning: T };
  globalThis.TopKong = api;
  return api;
}

// ------------------------------------------------------------------ манекены

function syncDummies(scene, arena, dummies, fighters) {
  const want = Math.max(0, Math.round(T.dummyCount));

  while (dummies.length > want) {
    const d = dummies.pop();
    d.dispose();
    fighters.splice(fighters.indexOf(d), 1);
  }

  while (dummies.length < want) {
    const index = dummies.length;
    const d = new Fighter(scene, arena, {
      name: 'Манекен ' + (index + 1),
      // Приглушённая пастель: на светлой сцене насыщенные цвета кричат,
      // а фигуры должны отличаться друг от друга, а не спорить с фоном.
      color: [0x5b8def, 0x4fbf8b, 0xc46fb0, 0xdcb64a, 0x4bc4c4, 0x8b7ee0][index % 6],
    });
    d.bot = new Bot(d, arena);
    dummies.push(d);
    fighters.push(d);
  }

  placeRound(fighters, arena);
}

// Функции respawnFallen больше нет. Выбывшие не возвращаются: раунд
// кончается тем, что кто-то остался один, а возврат упавших означал бы,
// что он не кончается никогда. Перезапуском занимается match.js.

/**
 * Расстановка на раунд — случайная, но не как попало.
 *
 * Фиксированная расстановка приедалась за десяток раундов: игрок всегда
 * внизу, соперники всегда по тем же точкам, и бой начинался одинаково.
 * Чистый случай, однако, тоже не годится — он регулярно ставит двоих
 * вплотную, и раунд открывается толкотнёй вместо схватки.
 *
 * Поэтому сектора равные, а случайны поворот всего круга, дрожание
 * внутри сектора и удаление от центра. Минимальный разъезд при этом
 * гарантирован самой геометрией, а не проверками и переброcами.
 */
function placeRound(fighters, arena) {
  const n = Math.max(1, fighters.length);
  const base = Math.random() * Math.PI * 2;
  const sector = (Math.PI * 2) / n;
  // Дрожание — доля сектора, а не абсолютный угол: на двоих сектор в 180°,
  // на шестерых в 60°, и одна и та же добавка означала бы разное.
  const jitter = sector * 0.28;

  for (let i = 0; i < n; i++) {
    const angle = base + sector * i + (Math.random() * 2 - 1) * jitter;
    const r = arena.radius * (0.42 + Math.random() * 0.24);
    // Лицом к центру, с разбросом: строй, глядящий строго в середину,
    // читается расстановкой, а не случайностью.
    const yaw = angle + Math.PI + (Math.random() * 2 - 1) * 0.5;
    fighters[i].spawn(Math.sin(angle) * r, Math.cos(angle) * r, yaw);
  }
}

// -------------------------------------------------------------------- прицел

/**
 * Точка прицела и линия к ней. Без неё поворот бойца читается как «сам по себе»:
 * именно этого не хватало в Unity-версии, пока курсора не было.
 */
class AimCursor {
  constructor(scene, color) {
    // Прицел лежит НА НАСТИЛЕ и честно закрывается бойцами.
    //
    // Раньше он рисовался поверх всего (depthTest выключен) и наезжал
    // кружком на фигуры, оказываясь то на груди, то на голове. Метка
    // на полу, за которую заходят ногами, читается местом; метка поверх
    // всех — наклейкой на экране.
    //
    // Сдвиг полигонов вместо подъёма повыше: поднимать метку над настилом
    // нельзя, иначе на косом ракурсе она уползает от точки, которую метит.
    //
    // Цвет — СВОЙ У ИГРОКА, а не фирменный синий интерфейса. Метка
    // принадлежит бойцу, а не панели, и общий с ним цвет связывает их
    // без единой подписи. Синий вдобавок совпадал с цветом манекена,
    // и в свалке прицел путался с чужой фигурой.
    //
    // Тонкая и полупрозрачная намеренно. Жирное кольцо в полную силу
    // тянуло взгляд на себя сильнее, чем соперник, за которым и надо
    // следить: прицел обязан подсказывать, а не солировать.
    const geo = new THREE.RingGeometry(0.185, 0.215, 40);
    this.ring = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.5,
      depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.renderOrder = 5;
    scene.add(this.ring);

    // Точка в центре — единственное, что рисуется СКВОЗЬ всё.
    //
    // Системного курсора над ареной нет, и прицел остался единственным
    // указателем — потерять его нельзя. А потерялся бы он ровно тогда,
    // когда целишься в соперника: кольцо лежит на полу и честно уходит
    // бойцу за ноги.
    //
    // Пробовал держать сквозным само кольцо в четверть силы: на снимке
    // его на фигуре не разглядеть вовсе, а подними прозрачность — и это
    // снова наклейка на груди, из-за которой всё и затевалось. Точка
    // работает лучше обоих: на полу она центр прицела, на фигуре —
    // курсор, и ни в одном из случаев не круг поверх персонажа.
    this.ghost = new THREE.Mesh(new THREE.CircleGeometry(0.032, 16),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.7,
        depthTest: false, depthWrite: false,
      }));
    this.ghost.rotation.x = -Math.PI / 2;
    this.ghost.renderOrder = 6;
    scene.add(this.ghost);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.link = new THREE.Line(geometry, new THREE.LineBasicMaterial({
      color, transparent: true, opacity: 0.16, depthWrite: false,
    }));
    this.link.frustumCulled = false;
    this.link.renderOrder = 5;
    scene.add(this.link);
  }

  /** Показывать ли мировую метку вообще: за кромкой её место занимает курсор. */
  setVisible(on) {
    this.ring.visible = on;
    this.ghost.visible = on;
    if (!on) this.link.visible = false;
  }

  update(point, player) {
    if (!this.ring.visible) return;
    this.ring.position.set(point.x, 0.02, point.z);
    this.ghost.position.copy(this.ring.position);

    this.link.visible = T.showAimLink && player.state === BodyState.Standing;
    if (!this.link.visible) return;

    const arr = this.link.geometry.getAttribute('position').array;
    arr[0] = player.position.x; arr[1] = 0.03; arr[2] = player.position.z;
    arr[3] = point.x; arr[4] = 0.03; arr[5] = point.z;
    this.link.geometry.getAttribute('position').needsUpdate = true;
  }
}

// -------------------------------------------------------------------- эффект

/** Вспышка в точке касания. Единственная задача — подтвердить, что попал. */
class HitFx {
  constructor(scene) {
    this.pool = [];
    this.live = [];
    this.scene = scene;
    this.geometry = new THREE.RingGeometry(0.1, 0.34, 20);
  }

  spawn(point, strength) {
    const mesh = this.pool.pop() || new THREE.Mesh(this.geometry,
      new THREE.MeshBasicMaterial({ color: 0xfff0c0, transparent: true, depthTest: false, side: THREE.DoubleSide }));
    mesh.position.copy(point);
    mesh.scale.setScalar(0.4);
    mesh.material.opacity = 0.95;
    mesh.renderOrder = 6;
    this.scene.add(mesh);
    this.live.push({ mesh, life: 0, power: 0.5 + strength });
  }

  tick(dt) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const item = this.live[i];
      item.life += dt;
      const k = clamp01(item.life / 0.28);
      item.mesh.scale.setScalar(0.4 + k * 3.2 * item.power);
      item.mesh.material.opacity = (1 - k) * 0.95;
      // Кольцо всегда развёрнуто к камере — иначе на виде сверху
      // половина вспышек видна ребром.
      item.mesh.quaternion.copy(this.scene.userData.camQuat || item.mesh.quaternion);
      if (k >= 1) {
        this.scene.remove(item.mesh);
        this.pool.push(item.mesh);
        this.live.splice(i, 1);
      }
    }
  }
}

// ----------------------------------------------------------------------- HUD


function hudText(player, arena, fps, input, match) {
  const dist = Math.hypot(player.position.x, player.position.z);
  const edge = Math.max(0, arena.radius - dist);
  const state = {
    [BodyState.Standing]: 'стоит',
    [BodyState.Downed]: 'СБИТ',
    [BodyState.Dead]: 'выбыл',
  }[player.state];

  // Прогиб корпуса — насколько грудь ушла от вертикали над тазом. Это
  // и есть та самая желейность в одном числе: по нему видно, живёт тело
  // или едет бруском.
  const hips = player.body.pos[P.Hips];
  const chest = player.body.pos[P.Chest];
  const bend = Math.hypot(chest.x - hips.x, chest.z - hips.z);

  const swing = player.swing.state === 'guard' && !player.swing.held
    ? 'несёт'
    : player.swing.state === 'windup'
      ? 'замах ' + Math.round(player.swing.charge * 100) + '%'
      : player.swing.state === 'strike' ? 'УДАР' : 'возврат';

  return [
    // Номер сборки в кадре — не украшение. Проверить, что открыто в чужом
    // браузере, я не могу: гейтвей не пускает наружу. По этой строке
    // на любом скриншоте сразу видно, дошла правка или висит старый кэш.
    `сборка ${globalThis.TK_BUILD || '?'}    fps ${fps.toFixed(0)}   ${input.slowMotion ? 'замедление (F)' : ''}`,
    match ? match.score : '',
    `тело      ${S.title}   ${state}   мышцы ${(player.body.strength * 100).toFixed(0)}%`,
    // Запас устойчивости — не украшение: по нему видно, что боец СТОИТ,
    // а не висит на мышцах. Единица означает, что точка перехвата ровно
    // над опорой, ноль — что устоять уже нельзя и нужен шаг.
    `равновесие ${(player.balance.margin * 100).toFixed(0)}%   завал ${player.balance.tilt.toFixed(0)}°`,
    // Без дубины строки про неё нет вовсе: пустое «несёт» на экране
    // сбивает с толку сильнее, чем отсутствие строки.
    T.withClub ? `дубина    ${swing}` : 'дубина    снята (настройки)',
    `скорость  ${player.locomotion.planarSpeed.toFixed(2)} м/с`,
    ...(T.withClub ? [`набалдашник ${player.swingSpeed.toFixed(1)} м/с`] : []),
    `скрут     ${player.poseDriver.twist.toFixed(0)}°   прогиб ${(bend * 100).toFixed(1)} см`,
    `до края   ${edge.toFixed(2)} м    растяжение ${(player.body.maxStretch * 100).toFixed(1)} см`,
  ].join('\n');
}
