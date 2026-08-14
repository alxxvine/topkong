import * as THREE from 'three';
import { S } from 'tk/skeleton.js';
import { tuning as T, loadTuning } from 'tk/tuning.js';
import { clamp01, lerp } from 'tk/mathx.js';
import { Arena, VOID_COLOR } from 'tk/arena.js';
import { CameraRig } from 'tk/cameraRig.js';
import { Fighter, BodyState } from 'tk/fighter.js';
import { Bot, BOT_ROSTER } from 'tk/bot.js';
import { BODIES, bodyNames, currentBody, chooseBody } from 'tk/skeleton.js';
import { resolveContacts } from 'tk/contact.js';
import { Match } from 'tk/match.js';
import { P } from 'tk/body.js';
import { Input } from 'tk/input.js';
import { Ui } from 'tk/ui.js';
import { Sound } from 'tk/sound.js';
import { Telemetry } from 'tk/telemetry.js';
import { Progress, ACHIEVEMENTS } from 'tk/progress.js';

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
  // Deathmatch is THE game for now. Rounds mode is hidden from the UI but
  // its code is alive — flip TopKong.tuning.deathmatch from the console
  // to compare. Forced here so a stale saved value can't resurrect rounds.
  T.deathmatch = true;

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
  const sound = new Sound();
  // Телеметрия локальная: Pages статический, слать события некуда.
  // Дашборд — metrics.html; чужие данные приезжают кодом с паузы.
  const telem = new Telemetry(globalThis.TK_BUILD);
  // Прогресс: пожизненные счётчики, достижения и замки в меню персонажа.
  // Смысл бесконечного deathmatch живёт здесь.
  const prog = new Progress();
  // Browsers keep AudioContext suspended until a user gesture; unlock is
  // idempotent, so it simply rides on every input the page gets anyway.
  addEventListener('pointerdown', () => sound.unlock(), { passive: true });
  addEventListener('keydown', () => sound.unlock());

  const player = new Fighter(scene, arena, {
    isPlayer: true, name: 'You', color: 0xff8a5c, x: 0, z: -2, yaw: 0,
  });
  // Прицел собирается ПОСЛЕ игрока: он красится его цветом.
  const aim = new AimCursor(scene, player.color);
  const fighters = [player];
  const dummies = [];

  syncDummies(scene, arena, dummies, fighters);

  // Матч перезапускает раунд сам, поэтому расстановка отдаётся ему целиком.
  // Второй колбэк — точечный respawn для deathmatch: одного бойца, в самое
  // свободное место, пока остальные продолжают драться.
  const match = new Match(fighters, player,
    () => placeRound(fighters, arena),
    (f) => respawnOne(f, fighters, arena));

  ui.onTuned = () => telem.add('settings');

  // «Код статистики» на паузе: телеметрия друга доезжает до дашборда
  // без сервера — скопировал, прислал, владелец вставил в metrics.html.
  const statsBtn = document.getElementById('statsCopy');
  if (statsBtn) {
    statsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const code = telem.export();
      const done = () => { statsBtn.textContent = 'copied!'; };
      if (navigator.clipboard) navigator.clipboard.writeText(code).then(done, done);
      setTimeout(() => { statsBtn.textContent = 'copy stats code'; }, 1500);
    });
  }

  // Экран персонажа. Пока он открыт, отсчёт матча не заканчивается;
  // кнопка FIGHT применяет выбор, прячет экран и начинает бой заново.
  const setupState = initSetup(player, aim, match, telem, prog);

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
  let sndKills = 0;
  let prevDeaths = 0;
  let dashCd = 0;

  ui.onPauseToggle = () => {
    paused = !paused;
    if (paused) telem.add('pauses');
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
    // Меню персонажа с паузой несовместимо: его предпросмотр — живая
    // сцена, поэтому открытое меню паузу снимает.
    if (paused && !setupState.done) {
      paused = false;
      ui.setPaused(false);
      accumulator = 0;
      last = time;
    }
    if (paused) {
      renderer.render(scene, camera);
      return;
    }
    fps = lerp(fps, 1 / Math.max(1e-4, real), 0.08);
    telem.beat(real);
    prog.beat(real);

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
    // На экране персонажа игрок УЖЕ управляем: походить, помахать, послушать
    // звук — всё пробуется прямо в меню, на стоящих вокруг ботах, а не в бою.
    const playerFree = match.controlEnabled || !setupState.done;

    // Блок (ПКМ): пока держится — ударов нет, дубина поперёк корпуса,
    // а принятый удар отталкивает, но не роняет (см. checkHits).
    player.blocking = input.blockHeld && playerFree
      && player.state === BodyState.Standing;
    // Fists block too — both hands up in a boxing shell (poseDriver).
    player.swing.blockPose = player.blocking;

    // Удары целиком на мыши: ЛКМ — боковой (держи для заряда), колесо
    // вверх/вниз — рубящий сверху / черпающий снизу одним тиком.
    player.swing.held = input.swingHeld && playerFree && !player.blocking;
    if (player.swing.held && player.swing.state === 'guard') {
      player.swing.wantStyle = 0;
    }
    // Same slots armed and bare-handed: 1 is the overhead/overhand,
    // 2 is the scoop/uppercut.
    const wheel = input.consumeWheelStrike();
    if (wheel && playerFree && !player.blocking) {
      player.swing.cast(wheel === 'overhead' ? 1 : 2);
    }

    // Рывок (пробел): мягкая прибавка скорости по направлению хода —
    // темп игры вязкий, и телепорт-дэш из него выпадал бы. Без ввода
    // хода рывок идёт туда, куда боец смотрит.
    dashCd = Math.max(0, dashCd - real);
    if (input.consumeDash() && playerFree && dashCd <= 0
        && player.state === BodyState.Standing) {
      let dx = player.moveInput.x;
      let dz = player.moveInput.y;
      const len = Math.hypot(dx, dz);
      if (len < 0.1) { dx = Math.sin(player.yaw); dz = Math.cos(player.yaw); }
      else { dx /= len; dz /= len; }
      player.locomotion.shove(dx * T.dashPower, dz * T.dashPower);
      dashCd = T.dashCooldown;
      sound.whoosh(0.45);
    }

    if (!playerFree) player.moveInput.set(0, 0);

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

      for (const f of fighters) {
        f.tick(STEP, match.controlEnabled || (f.isPlayer && !setupState.done));
      }

      for (const f of fighters) {
        f.checkHits(fighters, STEP, now, (attacker, victim, point, strength, blocked) => {
          fx.spawn(point, strength);
          rig.addShake((blocked ? 0.15 : 0.25) + strength * 0.75 * T.shakeMul);
          hitStop = T.hitStopMax * (blocked ? 0.2 : 0.4 + strength * 0.6);
          if (blocked) sound.block();
          else {
            sound.impact(strength);
            if (attacker === player) telem.add('hits');
          }
          // Remember when the hit sounded, so the fall that follows the
          // same blow does not add a second, duplicate thud.
          victim.sndHitAt = now;
        });
      }

      match.tick(STEP);
    }
    // The character screen holds the match at the countdown's door: the
    // timer never runs out while the player is still picking a color.
    // Falling off during the menu test drive costs nothing — straight back
    // to the center, like a sandbox.
    if (!setupState.done) {
      if (match.phase === 'ready') match.timer = Math.max(match.timer, 1.5);
      if (!player.alive && player.deadTime > 0.7) player.spawn(0, 0, Math.PI * 0.25);
    }

    // Sound is edge-triggered off state the simulation already keeps:
    // no controller tells the mixer anything, the mixer watches the game.
    for (const f of fighters) {
      const striking = f.swing.striking;
      if (striking && !f.sndStriking) {
        // A fist cuts less air than a club head.
        sound.whoosh(f.swing.power * (f.hasClub ? 1 : 0.55));
        if (f.isPlayer) telem.swing(f.swing.style.name);
      }
      f.sndStriking = striking;

      // A body that went down WITHOUT a club hit in the last quarter
      // second fell to a ram or a shove — that one gets the soft thud.
      const downed = f.state === BodyState.Downed;
      if (downed && !f.sndDowned && now - (f.sndHitAt || -1) > 0.25) sound.thud();
      f.sndDowned = downed;

      if (!f.alive && f.sndAlive) sound.fall();
      // The rebirth blip belongs to deathmatch only: in rounds everyone
      // respawns at once each round and four blips in chorus are noise.
      if (f.alive && f.sndAlive === false && match.deathmatch) sound.respawn();
      f.sndAlive = f.alive;
    }
    if (player.kills > sndKills) {
      sound.kill();
      telem.add('kills', player.kills - sndKills);
      for (let n = player.kills - sndKills; n > 0; n--) prog.kill(player.hasClub);
    }
    sndKills = player.kills;
    if (player.deaths > prevDeaths) {
      telem.add('deaths', player.deaths - prevDeaths);
      prog.death();
    }
    prevDeaths = player.deaths;
    // Достижения проверяются каждый кадр (их семь, это дёшево); свежие
    // объявляются тостом, и меню — если открыто — тут же перерисовывает замки.
    for (const a of prog.check()) {
      toast(`Achievement: ${a.name}${a.reward ? ' — ' + a.reward.label + ' unlocked' : ''}`);
      setupState.refresh?.();
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
    ui.setBanner(setupState.done ? match.banner : null);
    // The combat buttons stay up bare-handed too: fists punch now, and
    // the wheel slots map to overhand/uppercut.
    renderer.render(scene, camera);
  }

  requestAnimationFrame(frame);

  // Пригодится из консоли браузера и из автотеста.
  const api = { scene, camera, renderer, arena, rig, player, fighters, dummies, input, match, ui, sound, telemetry: telem, progress: prog, tuning: T };
  globalThis.TopKong = api;
  return api;
}

// ---------------------------------------------------------------------- тост

let _toastTimer = 0;

/** Плашка на пару секунд: достижения объявляют себя сами. */
function toast(text) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('on'), 4200);
}

// ------------------------------------------------------------- экран персонажа

/**
 * Character setup. Shown once at load: the arena with the fighters is
 * already live behind it, the player stands centered facing the camera,
 * and every choice applies INSTANTLY to the real fighter — the preview
 * is the game itself, not a mockup. FIGHT hides the card and restarts
 * the match countdown. Choices persist in localStorage.
 */
function initSetup(player, aim, match, telem, prog) {
  const root = document.getElementById('setup');
  const state = { done: !root };
  if (!root) return state;

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('tk-player') || '{}'); } catch { /* fresh */ }

  const nameEl = document.getElementById('setupName');
  nameEl.value = typeof saved.name === 'string' ? saved.name : '';

  // Палитра общая с базой ботов по духу — приглушённая пастель — но своя.
  // Дальше идут НАГРАДНЫЕ цвета из достижений: закрытый показывается
  // с замком, скрытый — тёмным «?», и что за ним, меню не говорит.
  const FREE_COLORS = [0xff8a5c, 0xe4533f, 0xdcb64a, 0x4fbf8b,
                       0x4bc4c4, 0x5b8def, 0x8b7ee0, 0xc46fb0];
  const rewardOf = (kind) => ACHIEVEMENTS.filter((a) => a.reward && a.reward[kind]);

  const WEAPONS = [
    { id: 'club',   label: 'Club',  skin: 'classic' },
    { id: 'fists',  label: 'Fists', skin: 'classic' },
    ...rewardOf('club').map((a) => ({
      id: a.reward.club, label: a.reward.label, skin: a.reward.club, ach: a,
    })),
  ];

  const colorOk = (c) => FREE_COLORS.includes(c) || prog.colorUnlocked(c);
  const weaponOk = (w) => {
    const def = WEAPONS.find((x) => x.id === w);
    return !!def && (!def.ach || prog.has(def.ach.id));
  };

  let color = colorOk(saved.color) && (FREE_COLORS.includes(saved.color)
    || rewardOf('color').some((a) => a.reward.color === saved.color))
    ? saved.color : FREE_COLORS[0];
  let weapon = weaponOk(saved.weapon) ? saved.weapon : 'club';

  const applyColor = (c) => {
    color = c;
    player.setColor(c);
    aim.setColor(c);
    for (const b of document.querySelectorAll('#setupColors button')) {
      b.classList.toggle('sel', +b.dataset.c === c);
    }
  };
  const applyWeapon = (w) => {
    weapon = w;
    const def = WEAPONS.find((x) => x.id === w) || WEAPONS[0];
    player.armed = w !== 'fists';
    player.setClubSkin(def.skin);
    for (const b of document.querySelectorAll('#setupWeapon button')) {
      b.classList.toggle('sel', b.dataset.w === w);
    }
  };

  // Пикеры перерисовываемые: достижение может открыться прямо во время
  // пробы в меню, и замок обязан отпереться на глазах.
  const buildPickers = () => {
    const colorsEl = document.getElementById('setupColors');
    colorsEl.innerHTML = '';
    const addSwatch = (c, ach) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.c = c;
      const open = !ach || prog.has(ach.id);
      if (open) {
        b.style.background = '#' + c.toString(16).padStart(6, '0');
        b.addEventListener('click', () => applyColor(c));
        if (ach) b.title = ach.reward.label;
      } else if (ach.hidden) {
        // Супер-редкое даже не показывается: тёмный «?», и всё.
        b.className = 'mystery';
        b.textContent = '?';
        b.title = '???';
        b.disabled = true;
      } else {
        b.className = 'lock';
        b.style.background = '#' + c.toString(16).padStart(6, '0');
        b.textContent = '🔒';
        b.title = `${ach.reward.label} — ${ach.desc}`;
        b.disabled = true;
      }
      colorsEl.appendChild(b);
    };
    for (const c of FREE_COLORS) addSwatch(c, null);
    for (const a of rewardOf('color')) addSwatch(a.reward.color, a);

    const weaponEl = document.getElementById('setupWeapon');
    weaponEl.innerHTML = '';
    for (const def of WEAPONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.w = def.id;
      const open = !def.ach || prog.has(def.ach.id);
      if (open) {
        b.textContent = def.label;
        b.addEventListener('click', () => applyWeapon(def.id));
      } else if (def.ach.hidden) {
        b.textContent = '?';
        b.title = '???';
        b.disabled = true;
      } else {
        b.textContent = '🔒 ' + def.label;
        b.title = def.ach.desc;
        b.disabled = true;
      }
      weaponEl.appendChild(b);
    }

    // Прогресс: открытые с галкой, видимые — с числами, скрытые — «???».
    const progEl = document.getElementById('setupProg');
    progEl.innerHTML = '';
    for (const a of ACHIEVEMENTS) {
      const row = document.createElement('div');
      const got = prog.has(a.id);
      if (got) {
        row.className = 'got';
        row.textContent = `✓ ${a.name}${a.reward ? ' — ' + a.reward.label : ''}`;
      } else if (a.hidden) {
        row.className = 'hid';
        row.textContent = '??? — hidden';
      } else {
        const cur = Math.min(a.need, Math.floor(a.of(prog.p)));
        const show = a.time
          ? `${Math.floor(cur / 60)}/${Math.floor(a.need / 60)}m`
          : `${cur}/${a.need}`;
        row.textContent = `${a.name} · ${a.desc} · ${show}`;
      }
      progEl.appendChild(row);
    }

    applyColor(color);
    applyWeapon(weapon);
  };
  buildPickers();
  state.refresh = buildPickers;

  // Телосложение меняет длины связей и панели — страница перезагружается
  // (так устроен выбор тела и в панели настроек). Выбор экрана переживает
  // перезагрузку через localStorage, так что это безопасно посреди setup.
  const bodyEl = document.getElementById('setupBody');
  for (const key of bodyNames) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = BODIES[key].title;
    if (key === currentBody) b.classList.add('sel');
    b.addEventListener('click', () => chooseBody(key));
    bodyEl.appendChild(b);
  }

  applyColor(color);
  applyWeapon(weapon);
  // Лицом к камере, в центре: экран персонажа должен показывать персонажа.
  player.spawn(0, 0, Math.PI * 0.25);

  const menuBtn = document.getElementById('menu');

  document.getElementById('setupGo').addEventListener('click', () => {
    player.name = (nameEl.value || '').trim().slice(0, 12) || 'You';
    try {
      localStorage.setItem('tk-player',
        JSON.stringify({ name: player.name === 'You' ? '' : player.name, color, weapon }));
    } catch { /* private mode */ }
    root.classList.add('gone');
    if (menuBtn) menuBtn.classList.remove('gone');
    state.done = true;
    telem.fight({
      name: player.name,
      weapon,
      color: color.toString(16).padStart(6, '0'),
      body: currentBody,
    });
    // Пробы в меню — бесплатные: всё, что игрок навалял ботам, пока
    // примерял цвет, в счёт боя не идёт.
    for (const f of match.fighters) { f.kills = 0; f.deaths = 0; }
    match.begin();
  });

  /** Вернуться с поля в меню: карточка открывается, бой встаёт у отсчёта. */
  state.open = () => {
    if (!state.done) return;
    state.done = false;
    telem.add('menuReturns');
    root.classList.remove('gone');
    if (menuBtn) menuBtn.classList.add('gone');
    match.phase = 'ready';
    match.timer = 2;
    match.winner = null;
    player.spawn(0, 0, Math.PI * 0.25);
  };
  if (menuBtn) menuBtn.addEventListener('click', () => state.open());

  return state;
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
    // Соперники — из базы характеров, своя случайная раздача на сессию:
    // каждая игра встречает другим составом. Колода тасуется один раз,
    // добавленные позже боты продолжают ту же раздачу.
    const p = drawPersona(index);
    const d = new Fighter(scene, arena, {
      name: p.name, color: p.color, armed: p.club,
    });
    d.bot = new Bot(d, arena, p);
    dummies.push(d);
    fighters.push(d);
  }

  placeRound(fighters, arena);
}

function drawPersona(index) {
  if (!drawPersona.deck) {
    drawPersona.deck = [...BOT_ROSTER];
    for (let i = drawPersona.deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [drawPersona.deck[i], drawPersona.deck[j]] = [drawPersona.deck[j], drawPersona.deck[i]];
    }
  }
  return drawPersona.deck[index % drawPersona.deck.length];
}

/**
 * Respawn одного бойца посреди идущего боя (deathmatch).
 *
 * Точка — лучшая из шести случайных: та, до которой живым дальше всего.
 * Честный worst-case перебором, а не отталкивание после спавна: возникший
 * внутри чужой свалки боец получает по голове раньше, чем поймёт, где он.
 */
function respawnOne(fighter, fighters, arena) {
  let bestX = 0, bestZ = 0, bestYaw = 0, bestScore = -1;
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = arena.radius * (0.4 + Math.random() * 0.26);
    const x = Math.sin(a) * r;
    const z = Math.cos(a) * r;
    let nearest = Infinity;
    for (const f of fighters) {
      if (f === fighter || !f.alive) continue;
      nearest = Math.min(nearest, Math.hypot(f.position.x - x, f.position.z - z));
    }
    if (nearest > bestScore) {
      bestScore = nearest;
      bestX = x; bestZ = z;
      // Лицом к центру с разбросом — как и на общей расстановке.
      bestYaw = a + Math.PI + (Math.random() * 2 - 1) * 0.5;
    }
  }
  fighter.spawn(bestX, bestZ, bestYaw);
}

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

  /** Прицел принадлежит бойцу и перекрашивается вместе с ним. */
  setColor(c) {
    this.ring.material.color.set(c);
    this.ghost.material.color.set(c);
    this.link.material.color.set(c);
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
    [BodyState.Standing]: 'standing',
    [BodyState.Downed]: 'DOWN',
    [BodyState.Dead]: 'out',
  }[player.state];

  // Прогиб корпуса — насколько грудь ушла от вертикали над тазом. Это
  // и есть та самая желейность в одном числе: по нему видно, живёт тело
  // или едет бруском.
  const hips = player.body.pos[P.Hips];
  const chest = player.body.pos[P.Chest];
  const bend = Math.hypot(chest.x - hips.x, chest.z - hips.z);

  const swing = player.swing.state === 'guard' && !player.swing.held
    ? 'carrying'
    : player.swing.state === 'windup'
      ? 'wind-up ' + Math.round(player.swing.charge * 100) + '%'
      : player.swing.state === 'strike' ? 'STRIKE' : 'recover';

  return [
    // Номер сборки в кадре — не украшение. Проверить, что открыто в чужом
    // браузере, я не могу: гейтвей не пускает наружу. По этой строке
    // на любом скриншоте сразу видно, дошла правка или висит старый кэш.
    `build ${globalThis.TK_BUILD || '?'}    fps ${fps.toFixed(0)}   ${input.slowMotion ? 'slow motion (F)' : ''}`,
    match ? match.score : '',
    `body      ${S.title}   ${state}   muscles ${(player.body.strength * 100).toFixed(0)}%`,
    // Запас устойчивости — не украшение: по нему видно, что боец СТОИТ,
    // а не висит на мышцах. Единица означает, что точка перехвата ровно
    // над опорой, ноль — что устоять уже нельзя и нужен шаг.
    `balance   ${(player.balance.margin * 100).toFixed(0)}%   tilt ${player.balance.tilt.toFixed(0)}°`,
    // Без дубины строки про неё нет вовсе: пустое «несёт» на экране
    // сбивает с толку сильнее, чем отсутствие строки.
    player.hasClub ? `club      ${swing}` : 'club      none (fists)',
    `speed     ${player.locomotion.planarSpeed.toFixed(2)} m/s`,
    ...(player.hasClub ? [`club head ${player.swingSpeed.toFixed(1)} m/s`] : []),
    `twist     ${player.poseDriver.twist.toFixed(0)}°   bend ${(bend * 100).toFixed(1)} cm`,
    `to edge   ${edge.toFixed(2)} m    stretch ${(player.body.maxStretch * 100).toFixed(1)} cm`,
  ].join('\n');
}
