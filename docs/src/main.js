import * as THREE from 'three';
import { S } from 'tk/skeleton.js';
import { tuning as T, loadTuning } from 'tk/tuning.js';
import { clamp01, lerp } from 'tk/mathx.js';
import { Arena, VOID_COLOR } from 'tk/arena.js';
import { CameraRig } from 'tk/cameraRig.js';
import { Fighter, BodyState, EYE_STYLES, HEAD_SHAPES, TORSO_SHAPES, ARM_SHAPES, LEG_SHAPES, CLUB_SKINS } from 'tk/fighter.js';
import { Bot, BOT_ROSTER } from 'tk/bot.js';
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
      const done = () => { statsBtn.textContent = 'Copied — send it to the author!'; };
      if (navigator.clipboard) navigator.clipboard.writeText(code).then(done, done);
      setTimeout(() => { statsBtn.textContent = '📊 Copy my stats'; }, 2200);
    });
  }

  // Экран персонажа. Пока он открыт, отсчёт матча не заканчивается;
  // кнопка FIGHT применяет выбор, прячет экран и начинает бой заново.
  const setupState = initSetup(player, aim, match, telem, prog, camera);

  // On the character screen the hero faces the CAMERA until the mouse
  // takes over: a menu where the fighter shows you his back is no menu.
  // Camera yaw is 45°, so the camera sits toward (-1, -1) on the deck.
  const faceCamera = () => {
    input.hasPointer = false;
    input.aim.set(player.position.x - 6, 0, player.position.z - 6);
  };
  // The close-up frames the hero alone: opponents caught standing next
  // to him read as photobombers. Distance alone is no cure — the camera
  // is orthographic, so anything near the CAMERA AXIS projects straight
  // onto the hero no matter how far away it stands. The menu parks the
  // bots into the two side sectors, clear of the axis corridor; FIGHT
  // re-seats everyone through match.begin anyway.
  const parkDummies = () => {
    let slot = 0;
    for (const f of fighters) {
      if (f.isPlayer || !f.alive) continue;
      // Lateral offset from the camera axis (axis runs along (1,1)/√2).
      const lat = Math.abs(f.position.x - f.position.z) * 0.7071;
      const r = Math.hypot(f.position.x, f.position.z);
      if (r < 4.2 || lat < 2.8) {
        const side = slot % 2 ? 1 : -1;
        const a = (side > 0 ? 2.356 : -0.785) + Math.floor(slot / 2) * 0.5 * side;
        f.spawn(Math.sin(a) * 5.4, Math.cos(a) * 5.4, a + Math.PI);
      }
      slot++;
    }
  };
  faceCamera();
  const openSetup = setupState.open;
  setupState.open = () => { openSetup(); faceCamera(); };

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
  /** Block-broken latch: an empty pool keeps the shell down until
   *  stamina climbs back over the floor. */
  let blockBroken = false;
  /** The strike buffer: a click during a swing fires on the next guard. */
  let strikeBuf = 0;
  let prevSwingHeld = false;
  const stamEl = document.getElementById('stam');
  const stamBar = document.getElementById('stamBar');

  // The shooter chrome is ONE panel now: the live scoreboard. The kill
  // feed was tried and cut — with four fighters the KILLS board already
  // tells the story, and the feed doubled it as noise. The board
  // re-renders only when the standings actually change.
  const scoreEl = document.getElementById('score');
  let scoreSig = '';
  const updateScore = (on) => {
    if (!scoreEl) return;
    scoreEl.classList.toggle('on', on);
    if (!on) { scoreSig = ''; return; }
    const rows = [...fighters]
      .filter((f) => f.kills > 0 || f.isPlayer)
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
      .slice(0, 5);
    const sig = rows.map((f) => `${f.name}:${f.kills}:${f.deaths}`).join('|');
    if (sig === scoreSig) return;
    scoreSig = sig;
    // A tiny caption plus a pill per count: a bare digit next to a name
    // read as noise, a labeled pill reads as a score.
    scoreEl.innerHTML = '<i>Kills</i>' + rows.map((f) =>
      `<div${f.isPlayer ? ' class="me"' : ''}><b>${f.name}</b><span>${f.kills}</span></div>`
    ).join('');
  };

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
      // The pause veil doubles as the manual: keep the controls card up.
      document.body.classList.add('showctrl');
      renderer.render(scene, camera);
      return;
    }
    fps = lerp(fps, 1 / Math.max(1e-4, real), 0.08);
    // The three flags everything else keys off. Practice is the arena
    // with the countdown held forever: free player, mannequin bots,
    // and nothing feeding the stats.
    const practice = setupState.done && setupState.practice;
    // The menu hero only follows the cursor with his eyes — no walking,
    // no swinging on the character screen.
    const playerFree = match.controlEnabled || practice;
    const inGame = setupState.done && !practice;
    telem.beat(real);
    // Playtime achievements tick in the game, not on the menu screen.
    if (inGame) prog.beat(real);

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


    if (setupState.done) {
      player.facingTarget.copy(input.aim).sub(player.position);
      player.facingTarget.y = 0;
      player.poseDriver.menuLook = 0;
      player.poseDriver.menuLookPitch = 0;
    } else {
      // In the menu the mouse steers only the GAZE. The body holds its
      // pose toward the camera; the head alone tracks the cursor, clamped
      // so the neck never wrings.
      player.facingTarget.set(-1, 0, -1);
      // The gaze comes from SCREEN space: at the menu's flat camera tilt
      // a deck raycast is degenerate — upper-half rays graze the plane
      // and land kilometers out. The cursor's screen X/Y are enough,
      // taken window-level so the head keeps tracking over the UI too.
      const nx = input.hasScreen
        ? Math.max(-1, Math.min(1, (input.screenX / innerWidth) * 2 - 1))
        : 0;
      const ny = input.hasScreen
        ? Math.max(-1, Math.min(1, (input.screenY / innerHeight) * 2 - 1))
        : 0;
      player.poseDriver.menuLook = nx * 0.9;
      // Cursor high — chin up, cursor low — eyes down. Shallower range
      // than the yaw: necks nod less than they turn.
      player.poseDriver.menuLookPitch = ny * 0.4;
    }

    // Блок (ПКМ): пока держится — ударов нет, дубина поперёк корпуса,
    // а принятый удар отталкивает, но не роняет (см. checkHits).
    // A strike thrown while the block is held WINS: the block drops the
    // same tick and the swing fires. Making the player release RMB first
    // cost a beat, and that beat killed the counter feel — striking out
    // of the block is the UFC rule. The block also stays down through
    // the swing itself: blocking WHILE hitting would be having it both
    // ways. RMB still held when the swing ends — the shell comes back up.
    const wheel = input.consumeWheelStrike();
    const strikeAsked = input.swingHeld || wheel !== null
      || player.swing.state === 'windup' || player.swing.state === 'strike';
    // An empty pool breaks the block, and it stays broken until stamina
    // climbs back over the floor — no flickering shell at zero.
    if (player.stamina <= 0.01) blockBroken = true;
    else if (player.stamina >= T.staminaFloor) blockBroken = false;
    player.blocking = input.blockHeld && !strikeAsked && playerFree
      && !(T.staminaOn && blockBroken)
      && player.state === BodyState.Standing;
    // Fists block too — both hands up in a boxing shell (poseDriver).
    player.swing.blockPose = player.blocking;

    // Удары целиком на мыши: ЛКМ — боковой (держи для заряда), колесо
    // вверх/вниз — рубящий сверху / черпающий снизу одним тиком.
    player.swing.held = input.swingHeld && playerFree;
    if (player.swing.held && player.swing.state === 'guard') {
      player.swing.wantStyle = 0;
    }
    // Same slots armed and bare-handed: 1 is the overhead/overhand,
    // 2 is the scoop/uppercut.
    if (wheel && playerFree) {
      player.swing.cast(wheel === 'overhead' ? 1 : 2);
    }

    // The strike buffer. A click that lands DURING a swing used to
    // vanish, and chaining punches meant timing every click into the
    // exact guard frame — the pause the chain complaints were about.
    // Now the press is remembered for a beat and fires the moment the
    // fighter is ready: mashing LMB gives left-right-left as fast as
    // the machine and the stamina allow.
    if (input.swingHeld && !prevSwingHeld
        && (player.swing.state !== 'guard' || player.swing.cooldown > 0)) {
      strikeBuf = 0.4;
    }
    prevSwingHeld = input.swingHeld;
    strikeBuf = Math.max(0, strikeBuf - real);
    if (strikeBuf > 0 && playerFree && player.swing.state === 'guard'
        && player.swing.cooldown <= 0) {
      player.swing.cast(0);
      strikeBuf = 0;
    }

    // Рывок (пробел): короткий ПРЫЖОК-выпад по направлению хода, со своей
    // ценой в стамине. Без ввода хода рывок идёт туда, куда боец смотрит.
    dashCd = Math.max(0, dashCd - real);
    if (input.consumeDash() && playerFree && dashCd <= 0
        && (!T.staminaOn || player.stamina >= T.staminaDashCost)
        && player.state === BodyState.Standing) {
      let dx = player.moveInput.x;
      let dz = player.moveInput.y;
      const len = Math.hypot(dx, dz);
      if (len < 0.1) { dx = Math.sin(player.yaw); dz = Math.cos(player.yaw); }
      else { dx /= len; dz /= len; }
      player.locomotion.shove(dx * T.dashPower, dz * T.dashPower);
      dashCd = T.dashCooldown;
      if (T.staminaOn) {
        player.stamina = Math.max(0, player.stamina - T.staminaDashCost);
        player.staminaWait = T.staminaDelay;
      }
      // The body sells the hop: a quick crouch-and-lunge pulse in the
      // pose, so the dash reads as a leap and not as fast walking.
      player.poseDriver.dashKick = 1;
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
        f.tick(STEP, match.controlEnabled || (f.isPlayer && playerFree));
      }

      for (const f of fighters) {
        f.checkHits(fighters, STEP, now, (attacker, victim, point, strength, blocked) => {
          fx.spawn(point, strength);
          rig.addShake((blocked ? 0.15 : 0.25) + strength * 0.75 * T.shakeMul);
          hitStop = T.hitStopMax * (blocked ? 0.2 : 0.4 + strength * 0.6);
          if (blocked) sound.block();
          else {
            sound.impact(strength);
            if (attacker === player && inGame) telem.add('hits');
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
      // The hero poses on the CAMERA-NEAR side of the deck: from the
      // center the far rim cut across the backdrop right behind his
      // head, from here twelve meters of deck run out past the frame.
      // Catches every center placement — boot, placeRound, respawn.
      if (player.state === BodyState.Standing
          && player.moveInput.lengthSq() < 0.01
          && player.position.x * player.position.x
            + player.position.z * player.position.z < 0.4) {
        player.spawn(-3.2, -3.2, -Math.PI * 0.75);
      }
      // Photobomber patrol: a no-op scan once everyone is parked wide.
      parkDummies();
    } else if (practice) {
      // Practice holds the match at the countdown's door forever; the
      // player and the mannequins come back on their own after falls.
      if (match.phase === 'ready') match.timer = Math.max(match.timer, 1.5);
      if (!player.alive && player.deadTime > 0.7) player.spawn(0, 0, Math.PI * 0.25);
      for (const f of fighters) {
        if (!f.isPlayer && !f.alive && f.deadTime > 1.2) respawnOne(f, fighters, arena);
      }
    }
    // The camera: hero close-up while the menu is open, the arena after.
    rig.menuTarget = setupState.done ? 0 : 1;
    document.body.classList.toggle('insetup', !setupState.done);
    // The controls card shows while the start countdown holds the player
    // still (and on pause, handled above) — the only manual the game has.
    document.body.classList.toggle('showctrl',
      setupState.done && !practice && match.phase === 'ready');

    // Sound is edge-triggered off state the simulation already keeps:
    // no controller tells the mixer anything, the mixer watches the game.
    for (const f of fighters) {
      const striking = f.swing.striking;
      if (striking && !f.sndStriking) {
        // A fist cuts less air than a club head.
        sound.whoosh(f.swing.power * (f.hasClub ? 1 : 0.55));
        // Menu swings are rehearsal: they make sound but leave no stats.
        if (f.isPlayer && inGame) telem.swing(f.swing.style.name);
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
    // Progression and stats accrue IN THE GAME only: the menu test drive
    // is a sandbox, and sandbox kills counting toward achievements made
    // the menu the best farming spot.
    if (player.kills > sndKills && inGame) {
      sound.kill();
      telem.add('kills', player.kills - sndKills);
      for (let n = player.kills - sndKills; n > 0; n--) prog.kill(player.hasClub);
    }
    sndKills = player.kills;
    if (player.deaths > prevDeaths && inGame) {
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
    // The world ring is the FIGHT's cursor. The menu uses the crosshair
    // pointer instead (body.insetup #view in the styles): the ring lies
    // flat on the deck far below the hero close-up, so in the menu it
    // read as a mystery decal, not as a pointer.
    aim.setVisible(overField && setupState.done);
    aim.update(input.aim, player);
    scene.userData.camQuat = camera.quaternion;
    fx.tick(real);

    rig.lookAhead.copy(player.facingTarget).setY(0);
    if (rig.lookAhead.lengthSq() > 1) rig.lookAhead.normalize();
    rig.tick(real, player.alive ? player.position : null);

    // The stamina sliver: visible only while the pool is not full, red
    // once the block would break. The one meter in the game.
    if (stamBar) {
      stamBar.style.width = `${Math.round(player.stamina * 100)}%`;
      stamEl.classList.toggle('show',
        T.staminaOn && setupState.done && player.stamina < 0.97);
      stamEl.classList.toggle('low', blockBroken || player.stamina < T.staminaFloor);
    }
    updateScore(inGame);
    ui.setHud(hudText(player, arena, fps, input, match));
    ui.setBanner(inGame ? match.banner : null);
    // The combat buttons stay up bare-handed too: fists punch now, and
    // the wheel slots map to overhand/uppercut.
    renderer.render(scene, camera);
    // The customization dots ride the freshly rendered pose: render has
    // just updated every world matrix, so the projection is this frame's.
    if (!setupState.done) setupState.placeSpots?.(input);
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
function initSetup(player, aim, match, telem, prog, camera) {
  const root = document.getElementById('setup');
  const state = { done: !root, practice: false };
  if (!root) return state;

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('tk-player') || '{}'); } catch { /* fresh */ }

  // Part customization: a SHAPE per body part plus the face style.
  // Restored from the save up front so the hero boots dressed. Unknown
  // names (including last build's shade ids) fall back to classic.
  const partPick = {
    eyes: EYE_STYLES[saved.eyes] ? saved.eyes : 'classic',
    head: HEAD_SHAPES[saved.head] ? saved.head : 'classic',
    torso: TORSO_SHAPES[saved.torso] ? saved.torso : 'classic',
    arms: ARM_SHAPES[saved.arms] ? saved.arms : 'classic',
    legs: LEG_SHAPES[saved.legs] ? saved.legs : 'classic',
  };
  player.setEyes(partPick.eyes);
  for (const p of ['head', 'torso', 'arms', 'legs']) player.setPart(p, partPick[p]);

  // The demo character is a COLOR and a CLUB SKIN, nothing else: no name,
  // no bodies, no weapon choice — everyone swings the same club, and the
  // skins are trophies from achievements. Fewer knobs, cleaner screen.
  const FREE_COLORS = [0xff8a5c, 0xe4533f, 0x4fbf8b, 0x5b8def, 0xc46fb0,
    0x45c1b8, 0x9a86ec, 0xa9c74d, 0xe9e2cf];
  const rewardOf = (kind) => ACHIEVEMENTS.filter((a) => a.reward && a.reward[kind]);

  const colorKnown = (c) => FREE_COLORS.includes(c)
    || rewardOf('color').some((a) => a.reward.color === c);

  let color = colorKnown(saved.color) && prog.colorUnlocked(saved.color)
    ? saved.color : FREE_COLORS[0];

  const applyColor = (c) => {
    color = c;
    player.setColor(c);
    aim.setColor(c);
    for (const b of document.querySelectorAll('#setupColors button')) {
      b.classList.toggle('sel', +b.dataset.c === c);
    }
  };

  // Пикеры перерисовываемые: достижение может открыться прямо во время
  // пробы в меню, и замок обязан отпереться на глазах. Every locked
  // reward SAYS what it takes — hover the lock and read the recipe;
  // the mystery "?" slots are gone along with hidden achievements.
  const buildPickers = () => {
    const colorsEl = document.getElementById('setupColors');
    colorsEl.innerHTML = '';
    const addSwatch = (c, ach) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.c = c;
      b.style.background = '#' + c.toString(16).padStart(6, '0');
      if (!ach || prog.has(ach.id)) {
        b.addEventListener('click', () => applyColor(c));
        if (ach) b.title = ach.reward.label;
      } else {
        // Same glass card as the popover locks — recipe plus progress.
        b.className = 'lock';
        b.textContent = '🔒';
        bindTip(b, ach, ach.reward.label);
      }
      colorsEl.appendChild(b);
    };
    for (const c of FREE_COLORS) addSwatch(c, null);
    for (const a of rewardOf('color')) addSwatch(a.reward.color, a);


    applyColor(color);
    applySkin(skin);
  };

  // Achievements have no button and no pop-up anymore: progress announces
  // itself in toasts, and every locked reward — a "?" pill in a part
  // popover, a padlocked color swatch — says on hover exactly what it
  // takes. The screen owns nothing but the character.
  // The weapon rack: two free looks and the achievement trophies. All of
  // them share the club's grip, reach and physics — variety, not stats.
  const SKINS = [
    { id: 'classic', label: 'Classic' },
    { id: 'hammer', label: 'Sledge' },
    { id: 'mallet', label: 'Mallet' },
    { id: 'ember', label: 'Ember' },
    { id: 'frost', label: 'Frost' },
    ...rewardOf('club').map((a) => ({
      id: a.reward.club, label: a.reward.label, ach: a,
    })),
  ];
  const skinOpen = (d) => !d.ach || prog.has(d.ach.id);
  let skin = SKINS.some((d) => d.id === saved.skin && skinOpen(d))
    ? saved.skin : 'classic';
  const applySkin = (sk) => {
    skin = sk;
    player.setClubSkin(sk);
    if (popFor === 'club') refreshSel(spots.club.def);
  };

  // ------------------------------------------------------ lock tooltip
  // Locked rewards wear a padlock; hovering (or tapping) one raises a
  // glass card: what the reward is, which achievement pays it, and a live
  // progress bar — a lock with no visible progress reads as "never".
  const tipEl = document.getElementById('lockTip');
  let tipFor = null;
  const showTip = (el, ach, label) => {
    if (!tipEl || !ach) return;
    tipFor = el;
    const cur = Math.min(ach.need, Math.floor(ach.of(prog.p)));
    const pct = Math.round((cur / ach.need) * 100);
    const count = ach.time
      ? `${Math.floor(cur / 60)}/${Math.floor(ach.need / 60)} min`
      : `${cur}/${ach.need}`;
    tipEl.innerHTML = `<b>${label}</b><span>${ach.name} — ${ach.desc}</span>`
      + `<div class="row"><div class="bar"><i style="width:${pct}%"></i></div>`
      + `<em>${count}</em></div>`;
    tipEl.classList.remove('gone');
    const r = el.getBoundingClientRect();
    const w = tipEl.offsetWidth || 200;
    const h = tipEl.offsetHeight || 70;
    const x = Math.min(innerWidth - w - 8, Math.max(8, r.x + r.width / 2 - w / 2));
    const y = r.y - h - 10 < 8 ? r.bottom + 10 : r.y - h - 10;
    tipEl.style.left = `${Math.round(x)}px`;
    tipEl.style.top = `${Math.round(y)}px`;
  };
  const hideTip = (el) => {
    if (el && tipFor !== el) return;
    tipFor = null;
    tipEl?.classList.add('gone');
  };
  const bindTip = (el, ach, label) => {
    el.addEventListener('pointerenter', () => showTip(el, ach, label));
    el.addEventListener('pointerleave', () => hideTip(el));
    // No hover on touch: a tap on the lock raises the same card.
    el.addEventListener('click', () => showTip(el, ach, label));
  };

  // ----------------------------------------------------------- hotspots
  // Five glass dots pinned to the hero's body parts. Click one and a
  // popover offers that part's SHAPES — silhouette variants cut from the
  // same skeleton — plus the face styles on the head and the earned skins
  // on the club. The dots track the bones through the camera every frame
  // (state.placeSpots), so they sit on the character, not on guessed
  // screen coordinates.
  const LABELS = {
    classic: 'Classic', brick: 'Brick', tower: 'Tower', ball: 'Ball',
    hero: 'Hero', barrel: 'Barrel', wiry: 'Wiry',
    beefy: 'Beefy', noodle: 'Noodle', slab: 'Slab',
    stumpy: 'Stumpy', lanky: 'Lanky',
    dot: 'Dot', mean: 'Mean', sleepy: 'Sleepy',
  };
  const named = (set) => () => Object.keys(set)
    .map((id) => ({ id, label: LABELS[id] || id }));
  const shapeGroup = (part, set) => ({
    title: 'Shape', opts: named(set),
    get: () => partPick[part],
    set: (id) => { partPick[part] = id; player.setPart(part, id); },
  });
  const PART_DEFS = [
    { part: 'head', label: 'Head', bone: 'head', lift: 0.14,
      groups: [
        shapeGroup('head', HEAD_SHAPES),
        { title: 'Face', opts: named(EYE_STYLES),
          get: () => partPick.eyes,
          set: (id) => { partPick.eyes = id; player.setEyes(id); } },
      ] },
    { part: 'torso', label: 'Torso', bone: 'chest', lift: 0,
      groups: [shapeGroup('torso', TORSO_SHAPES)] },
    { part: 'arms', label: 'Arms', bone: 'armLFore', lift: 0,
      groups: [shapeGroup('arms', ARM_SHAPES)] },
    { part: 'legs', label: 'Legs', bone: 'legRLower', lift: 0,
      groups: [shapeGroup('legs', LEG_SHAPES)] },
    // The club dot rides the tracked head-of-club world point, not the
    // bone origin — the origin is the grip, down in the fist.
    { part: 'club', label: 'Club', bone: 'club', lift: 0, world: (v) => v.copy(player.clubHead),
      groups: [{
        title: 'Weapon',
        opts: () => SKINS.map((d) => ({
          id: d.id, label: d.label,
          lock: skinOpen(d) ? null : d.ach,
        })),
        get: () => skin,
        set: (id) => applySkin(id),
      }] },
  ];
  const spotsEl = document.getElementById('spots');
  const popEl = document.getElementById('partPop');
  const popTitle = document.getElementById('partPopTitle');
  const popOpts = document.getElementById('partPopOpts');
  const spots = {};
  let popFor = null;
  const closePop = () => {
    popFor = null;
    if (popEl) popEl.classList.add('gone');
    hideTip();
    for (const s of Object.values(spots)) s.el.classList.remove('on');
  };
  /** Re-mark the selected pill in every group of the open popover. */
  const refreshSel = (def) => {
    if (!popOpts) return;
    for (const b of popOpts.querySelectorAll('button')) {
      const g = def.groups[+b.dataset.gi];
      b.classList.toggle('sel', g && g.get() === b.dataset.id);
    }
  };
  const openPop = (def) => {
    if (!popEl) return;
    popFor = def.part;
    popTitle.textContent = def.label;
    popOpts.innerHTML = '';
    def.groups.forEach((g, gi) => {
      // Group captions only when there is more than one group to tell apart.
      if (def.groups.length > 1) {
        const t = document.createElement('i');
        t.className = 'gt';
        t.textContent = g.title;
        popOpts.appendChild(t);
      }
      const row = document.createElement('div');
      row.className = 'grow';
      for (const o of g.opts()) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.id = o.id;
        b.dataset.gi = gi;
        if (o.lock) {
          // A locked look keeps its name behind a padlock; hover raises
          // the glass card with the recipe and the live progress bar.
          // NOT disabled: disabled buttons swallow the hover events.
          b.textContent = `🔒 ${o.label}`;
          b.className = 'lock';
          bindTip(b, o.lock, o.label);
        } else {
          b.textContent = o.label;
          b.addEventListener('click', () => { g.set(o.id); refreshSel(def); });
        }
        row.appendChild(b);
      }
      popOpts.appendChild(row);
    });
    refreshSel(def);
    for (const [p, s] of Object.entries(spots)) s.el.classList.toggle('on', p === def.part);
    popEl.classList.remove('gone');
    placePop(def);
  };
  const placePop = (def) => {
    const s = spots[def.part];
    if (!s || !popEl) return;
    // Beside the dot, on the side AWAY from the body column: the dots run
    // down the hero's middle, and a card opened below its dot sat exactly
    // on top of the next dot. The viewport edge flips the side back.
    const w = popEl.offsetWidth || 180;
    const h = popEl.offsetHeight || 90;
    const all = Object.values(spots);
    const centerX = all.reduce((a, q) => a + q.x, 0) / Math.max(1, all.length);
    const fits = (px) => px >= 8 && px + w <= innerWidth - 8;
    let x = s.x >= centerX ? s.x + 26 : s.x - 26 - w;
    let y = s.y - h * 0.5;
    if (!fits(x)) {
      const other = s.x >= centerX ? s.x - 26 - w : s.x + 26;
      if (fits(other)) {
        x = other;
      } else {
        // A phone fits the card on neither side: drop it under the dot.
        x = Math.min(innerWidth - w - 8, Math.max(8, s.x - w * 0.5));
        y = s.y + 18;
      }
    }
    y = Math.min(innerHeight - h - 8, Math.max(8, y));
    popEl.style.left = `${Math.round(x)}px`;
    popEl.style.top = `${Math.round(y)}px`;
  };
  if (spotsEl) {
    for (const def of PART_DEFS) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'spot';
      el.dataset.part = def.part;
      el.title = def.label;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (popFor === def.part) closePop();
        else openPop(def);
      });
      spotsEl.appendChild(el);
      spots[def.part] = { el, def, x: 0, y: 0 };
    }
    // A click anywhere off the popover folds it — the dots stop the
    // bubbling themselves, and clicks INSIDE the popover stay inside.
    addEventListener('pointerdown', (e) => {
      if (popFor && popEl && !popEl.contains(e.target)) closePop();
    });
  }
  const _spotV = new THREE.Vector3();
  // No hover on touch — there the dots simply stay visible.
  const coarsePointer = matchMedia('(hover: none)').matches;
  /** Pin the dots to the bones through the live camera. Runs every menu
   *  frame after render, when the world matrices are fresh. The dots
   *  only SHOW while the cursor is near the body (or a popover is open):
   *  five permanent rings over the hero read as a rash, not as an
   *  invitation — proximity makes them an answer to intent. */
  state.placeSpots = (inp) => {
    if (!spotsEl) return;
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const s of Object.values(spots)) {
      if (s.def.world) {
        s.def.world(_spotV);
      } else {
        const bone = player.bones[s.def.bone];
        if (!bone) continue;
        _spotV.setFromMatrixPosition(bone.matrixWorld);
        _spotV.y += s.def.lift;
      }
      _spotV.project(camera);
      s.x = (_spotV.x * 0.5 + 0.5) * innerWidth;
      s.y = (-_spotV.y * 0.5 + 0.5) * innerHeight;
      s.el.style.left = `${Math.round(s.x)}px`;
      s.el.style.top = `${Math.round(s.y)}px`;
      minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
      minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
    }
    let near = coarsePointer || !!popFor || !inp?.hasScreen;
    if (!near) {
      const pad = 90;
      near = inp.screenX > minX - pad && inp.screenX < maxX + pad
        && inp.screenY > minY - pad && inp.screenY < maxY + pad;
    }
    spotsEl.classList.toggle('far', !near);
    if (popFor) placePop(spots[popFor].def);
  };


  buildPickers();
  state.refresh = buildPickers;

  applyColor(color);
  player.armed = true;
  applySkin(skin);
  // Лицом к камере, в центре: экран персонажа должен показывать персонажа.
  player.spawn(0, 0, Math.PI * 0.25);

  const menuBtn = document.getElementById('menu');

  document.getElementById('setupGo').addEventListener('click', () => {
    player.name = 'You';
    try {
      localStorage.setItem('tk-player', JSON.stringify({ color, skin, ...partPick }));
    } catch { /* private mode */ }
    closePop();
    root.classList.add('gone');
    if (menuBtn) menuBtn.classList.remove('gone');
    state.done = true;
    state.practice = false;
    telem.fight({ skin, color: color.toString(16).padStart(6, '0') });
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
    // Everyone carries a club — equal footing. The roster's bare-hand
    // brawlers keep their tempers, they just get armed like the rest.
    const d = new Fighter(scene, arena, {
      name: p.name, color: p.color, armed: true,
    });
    dressBot(d, p.name);
    d.bot = new Bot(d, arena, p);
    dummies.push(d);
    fighters.push(d);
  }

  placeRound(fighters, arena);
}

/**
 * Bots sample the same shape catalog the player customizes from, seeded
 * by their name: Boulder always wears Boulder's head. The roster color
 * stays the identity; the shapes keep the crowd from being clones.
 */
function dressBot(fighter, name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  // fmix32 avalanche: the raw sum's bits are too tame — and a SIGNED
  // shift on a hash past 2^31 dealt negative indexes, which dressed half
  // the roster in silent all-classic. Unsigned shifts only.
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  const pick = (set, shift) => {
    const keys = Object.keys(set);
    return keys[(h >>> shift) % keys.length];
  };
  fighter.setEyes(pick(EYE_STYLES, 0));
  fighter.setPart('head', pick(HEAD_SHAPES, 2));
  fighter.setPart('torso', pick(TORSO_SHAPES, 5));
  fighter.setPart('arms', pick(ARM_SHAPES, 8));
  fighter.setPart('legs', pick(LEG_SHAPES, 11));
  // Weapons too — a wall of identical spiked clubs read as a factory
  // floor. Bots draw from the FULL rack, trophies included: seeing a
  // gilded club across the arena is the advertisement for earning one.
  fighter.setClubSkin(pick(CLUB_SKINS, 14));
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
