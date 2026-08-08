import * as THREE from 'three';
import { tuning as T } from 'tk/tuning.js';
import { clamp01, noiseSigned, DEG } from 'tk/mathx.js';

// Камера изометрическая: ортографическая проекция под фиксированным углом.
//
// Перспективы здесь больше нет, и это не стилизация ради стилизации.
// В перспективе одинаковые бойцы в разных концах арены разного размера,
// а вертикали заваливаются тем сильнее, чем дальше от центра кадра, — и то,
// и другое мешает читать единственное, что в этой игре решает: кто где стоит
// относительно края. Ортография показывает всех одинаково.
//
// Классический изометрический угол — наклон 35.264° и разворот 45°. Первое
// число не выдумано: это arctg(1/√2), тот самый наклон, при котором три оси
// куба сходятся на экране под равными 120°. Отсюда и вид «колонны» из трёх
// граней, каждая своей светлоты.
//
// Разворот принципиально не меняется во время игры. Позиция прицела берётся
// лучом из камеры, так что стоит камере повернуться — и «мышь вправо»
// перестанет означать «удар вправо». Поэтому камера только ездит.
//
// Арена маленькая и должна помещаться в кадр целиком, иначе соперник
// прилетает из ниоткуда. Камера стоит не за игроком, а между центром арены
// и игроком — доля задаётся camFollowWeight.

const _desired = new THREE.Vector3();
const _focus = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _quat = new THREE.Quaternion();

export class CameraRig {
  constructor(camera) {
    this.cam = camera;
    this.center = new THREE.Vector3(0, 0, 0);
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.lookAhead = new THREE.Vector3();
    this.shake = 0;
    this.shakeSeed = Math.random() * 100;

    this.cam.near = -60;
    this.cam.far = 260;
    this.aspect = 1;
    this.applyFrustum();

    this.desiredPosition(this.center, this.position);
    this.cam.position.copy(this.position);
    this.cam.lookAt(this.center);
  }

  addShake(amount) {
    this.shake = Math.min(1.2, this.shake + amount);
  }

  /**
   * Экранные оси, спроецированные на настил: по ним WASD привязывается к тому,
   * что игрок видит, а не к мировым координатам.
   *
   * Знак у right не описка. Unity левосторонняя, three.js правосторонняя,
   * и камера, стоящая на −Z и смотрящая на +Z, показывает мировой +X
   * в этих двух системах по разные стороны экрана. Формула, перенесённая
   * из Unity дословно, давала зеркальные A и D.
   *
   * Оси считаются из camYaw, а не читаются с матрицы камеры намеренно:
   * в матрице живёт ещё и тряска, и на каждом попадании управление
   * подкручивалось бы вместе с кадром.
   */
  groundBasis(out) {
    const yaw = T.camYaw * DEG;
    out.forward.set(Math.sin(yaw), 0, Math.cos(yaw));
    out.right.set(-Math.cos(yaw), 0, Math.sin(yaw));
    return out;
  }

  /**
   * Рамка кадра, в которую арена влезает целиком.
   *
   * У ортографии нет отъезда: расстояние ничего не меняет, размер кадра
   * задаётся рамкой напрямую. Поэтому вместо «куда отъехать» считается
   * «какой ширины взять кадр».
   *
   * По вертикали диск сплющен наклоном, и требуется меньше — но ровно
   * настолько, насколько наклонена камера. Плюс запас сверху под рост
   * бойца: диск влезает, а голова торчит за кадр, если про неё забыть.
   */
  applyFrustum(aspect) {
    if (aspect) this.aspect = aspect;
    const a = Math.max(0.2, this.aspect);
    const r = T.arenaRadius * T.camFitMargin;
    const tall = r * Math.sin(T.camPitch * DEG) + T.camHeadroom;

    // Кадр обязан вместить и ширину, и высоту: берём то, что больше,
    // и растягиваем недостающую сторону по соотношению экрана.
    const halfH = Math.max(tall, r / a);
    const halfW = halfH * a;

    const c = this.cam;
    c.left = -halfW; c.right = halfW;
    c.top = halfH; c.bottom = -halfH;
    c.updateProjectionMatrix();
  }

  desiredPosition(focus, out) {
    _euler.set(T.camPitch * DEG, T.camYaw * DEG, 0);
    _quat.setFromEuler(_euler);
    // Камера смотрит вниз-вперёд, значит стоит она позади и выше точки внимания.
    _dir.set(0, 0, 1).applyQuaternion(_quat);
    // Расстояние у ортографии на картинку не влияет вовсе — важно лишь,
    // чтобы всё осталось между near и far. Берём с запасом.
    return out.copy(focus).addScaledVector(_dir, -T.camDistance);
  }

  /**
   * dt здесь нарочно нескалированный: в замедленном режиме камера должна
   * оставаться отзывчивой, иначе кадр «уезжает» вслед за игроком с задержкой.
   */
  tick(dt, target) {
    // Радиус арены и наклон крутятся ползунками на ходу, а от них зависит
    // рамка кадра.
    this.applyFrustum();

    _focus.copy(this.center);
    if (target) {
      _focus.copy(target).addScaledVector(this.lookAhead, T.camLookAhead);
      _focus.lerpVectors(this.center, _focus, clamp01(T.camFollowWeight));
    }

    this.desiredPosition(_focus, _desired);

    // Критически задемпфированное сглаживание — тот же SmoothDamp, что в Unity:
    // камера догоняет без перелёта, и на резком развороте кадр не хлещет.
    const smooth = Math.max(0.0001, T.camSmooth);
    const omega = 2 / smooth;
    const x = omega * dt;
    const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

    _dir.copy(this.position).sub(_desired);
    const tempX = (this.velocity.x + omega * _dir.x) * dt;
    const tempY = (this.velocity.y + omega * _dir.y) * dt;
    const tempZ = (this.velocity.z + omega * _dir.z) * dt;
    this.velocity.set(
      (this.velocity.x - omega * tempX) * exp,
      (this.velocity.y - omega * tempY) * exp,
      (this.velocity.z - omega * tempZ) * exp
    );
    this.position.set(
      _desired.x + (_dir.x + tempX) * exp,
      _desired.y + (_dir.y + tempY) * exp,
      _desired.z + (_dir.z + tempZ) * exp
    );

    this.cam.position.copy(this.position);
    this.cam.lookAt(_focus);

    if (this.shake > 0.001) {
      const time = performance.now() * 0.001 * 26;
      const nx = noiseSigned(this.shakeSeed, time);
      const ny = noiseSigned(this.shakeSeed + 13.7, time);
      const nz = noiseSigned(this.shakeSeed + 27.1, time);

      _dir.set(nx, ny, 0).multiplyScalar(this.shake * 0.35);
      _dir.applyQuaternion(this.cam.quaternion);
      this.cam.position.add(_dir);
      this.cam.rotateZ(nz * this.shake * 0.035);

      this.shake = Math.max(0, this.shake - dt * 3.2);
    }
  }
}
