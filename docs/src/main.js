import * as THREE from '../vendor/three.module.js';
import { tuning as T, loadTuning } from './tuning.js';
import { clamp01, lerp } from './mathx.js';
import { Arena, VOID_COLOR } from './arena.js';
import { CameraRig } from './cameraRig.js';
import { Fighter, BodyState } from './fighter.js';
import { Input } from './input.js';
import { Ui } from './ui.js';

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
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(T.camFov, 1, 0.3, 200);

  const arena = new Arena(scene);
  const rig = new CameraRig(camera);
  const input = new Input(canvas);
  const ui = new Ui();
  const fx = new HitFx(scene);
  const aim = new AimCursor(scene);

  const player = new Fighter(scene, arena, {
    isPlayer: true, name: 'Игрок', color: 0xffb347, x: 0, z: -2, yaw: 0,
  });
  const fighters = [player];
  const dummies = [];

  syncDummies(scene, arena, dummies, fighters);

  resize();
  addEventListener('resize', resize);
  document.getElementById('boot').classList.add('gone');

  function resize() {
    const w = innerWidth;
    const h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  let last = performance.now();
  let accumulator = 0;
  let now = 0;
  let hitStop = 0;
  let fps = 60;

  function frame(time) {
    requestAnimationFrame(frame);

    const real = Math.min(0.1, (time - last) / 1000);
    last = time;
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
    player.facingTarget.copy(input.aim).sub(player.position);
    player.facingTarget.y = 0;
    player.swing.held = input.swingHeld;

    if (input.consumeReset()) {
      resetRound(player, dummies, arena);
    }

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

      for (const f of fighters) f.tick(STEP, f === player);

      for (const f of fighters) {
        f.checkHits(fighters, STEP, now, (attacker, victim, point, strength) => {
          fx.spawn(point, strength);
          rig.addShake(0.25 + strength * 0.75 * T.shakeMul);
          hitStop = T.hitStopMax * (0.4 + strength * 0.6);
        });
      }

      respawnFallen(fighters, arena);
    }
    // Хвост накопителя не копится бесконечно: после долгого залипания вкладки
    // иначе прилетает пачка шагов и всё разлетается.
    if (accumulator > STEP * MAX_STEPS) accumulator = 0;

    aim.update(input.aim, player);
    scene.userData.camQuat = camera.quaternion;
    fx.tick(real);

    rig.lookAhead.copy(player.facingTarget).setY(0);
    if (rig.lookAhead.lengthSq() > 1) rig.lookAhead.normalize();
    rig.tick(real, player.alive ? player.position : null);

    ui.setHud(hudText(player, arena, fps, input));
    renderer.render(scene, camera);
  }

  requestAnimationFrame(frame);

  // Пригодится из консоли браузера и из автотеста.
  const api = { scene, camera, renderer, arena, rig, player, fighters, input, tuning: T };
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
      color: [0x6f9ce8, 0x7fd48c, 0xd97ec2, 0xe0d27a, 0x8ae0d8, 0xd88a6f][index % 6],
    });
    dummies.push(d);
    fighters.push(d);
  }

  for (let i = 0; i < dummies.length; i++) {
    dummies[i].spawnIndex = i;
    dummies[i].spawnTotal = dummies.length;
    placeDummy(dummies[i], arena);
  }
}

function placeDummy(dummy, arena) {
  const angle = (dummy.spawnIndex / Math.max(1, dummy.spawnTotal)) * Math.PI * 2 + 0.4;
  const r = arena.radius * 0.5;
  dummy.spawn(Math.sin(angle) * r, Math.cos(angle) * r, angle + Math.PI);
}

/**
 * Выбывшие возвращаются: раундов пока нет, а стенд без соперника
 * перестаёт быть стендом уже через минуту.
 */
function respawnFallen(fighters, arena) {
  for (const f of fighters) {
    if (f.alive || f.state !== BodyState.Dead) continue;
    if (f.deadTime < T.dummyRespawnDelay) continue;

    if (f.isPlayer) f.spawn(0, -2, 0);
    else placeDummy(f, arena);
  }
}

function resetRound(player, dummies, arena) {
  player.spawn(0, -2, 0);
  for (const d of dummies) placeDummy(d, arena);
}

// -------------------------------------------------------------------- прицел

/**
 * Точка прицела и линия к ней. Без неё поворот бойца читается как «сам по себе»:
 * именно этого не хватало в Unity-версии, пока курсора не было.
 */
class AimCursor {
  constructor(scene) {
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.16, 0.23, 28),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthTest: false })
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.renderOrder = 5;
    scene.add(this.ring);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.link = new THREE.Line(geometry, new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.22, depthTest: false,
    }));
    this.link.frustumCulled = false;
    this.link.renderOrder = 5;
    scene.add(this.link);
  }

  update(point, player) {
    this.ring.position.set(point.x, 0.02, point.z);

    this.link.visible = T.showAimLink && player.state !== BodyState.Ragdoll;
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

function hudText(player, arena, fps, input) {
  const dist = Math.hypot(player.position.x, player.position.z);
  const edge = Math.max(0, arena.radius - dist);
  const state = {
    [BodyState.Controlled]: 'стоит',
    [BodyState.Ragdoll]: 'ТРЯПКА',
    [BodyState.StandingUp]: 'встаёт',
    [BodyState.Dead]: 'выбыл',
  }[player.state];

  const swing = player.swing.state === 'guard' && !player.swing.held
    ? 'несёт'
    : player.swing.state === 'windup'
      ? 'замах ' + Math.round(player.swing.charge * 100) + '%'
      : player.swing.state === 'strike' ? 'УДАР' : 'возврат';

  return [
    `fps ${fps.toFixed(0)}   ${input.slowMotion ? 'замедление (F)' : ''}`,
    `тело      ${state}`,
    `дубина    ${swing}`,
    `скорость  ${player.locomotion.planarSpeed.toFixed(2)} м/с`,
    `набалдашник ${player.swingSpeed.toFixed(1)} м/с`,
    `до края   ${edge.toFixed(2)} м`,
  ].join('\n');
}
