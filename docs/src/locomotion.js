import * as THREE from 'three';
import { tuning as T } from 'tk/tuning.js';
import { DEG, RAD, deltaAngle, clamp } from 'tk/mathx.js';

// Движение и разворот управляемого бойца. Порт Locomotion.cs.
//
// В Unity этим двигали Rigidbody с FreezeRotation; здесь Rigidbody нет,
// поэтому те же несколько строк движения написаны прямо — скорость по земле,
// гравитация, проверка опоры и разворот. Ничего сверх этого контроллеру
// персонажа и не нужно: пока боец под управлением, стоять ему помогать не надо,
// вся настоящая физика начинается в момент, когда он становится тряпкой.

const _wish = new THREE.Vector3();
const _planar = new THREE.Vector3();

export class Locomotion {
  constructor(fighter, arena) {
    this.f = fighter;
    this.arena = arena;
    this.grounded = false;
    this.planarSpeed = 0;
  }

  tick(dt, controlEnabled) {
    const f = this.f;

    this.probeGround();
    this.applyMovement(dt, controlEnabled);
    this.applyFacing(dt);

    f.position.addScaledVector(f.velocity, dt);

    if (this.grounded && f.velocity.y <= 0) {
      f.position.y = 0;
      f.velocity.y = 0;
    }
  }

  probeGround() {
    const f = this.f;
    // Опора есть, только если под ногами настил. Шагнул за кромку — опоры нет,
    // и дальше это уже не ходьба, а падение.
    const overDeck = this.arena.isOverDeck(f.position.x, f.position.z, -0.05);
    this.grounded = overDeck && f.position.y <= 0.02;
  }

  applyMovement(dt, controlEnabled) {
    const f = this.f;

    _wish.set(0, 0, 0);
    if (controlEnabled) _wish.set(f.moveInput.x, 0, f.moveInput.y);
    if (_wish.lengthSq() > 1) _wish.normalize();

    // Пронос забирает управление: удар должен чего-то стоить, иначе им можно
    // размахивать на бегу без всякого риска.
    if (f.swing.striking) _wish.multiplyScalar(T.swingMoveLock);
    // Пока копишь замах — идёшь медленно. Полная скорость только у того,
    // кто дубину не поднимал: выбор между «быстро» и «готов ударить» и есть
    // главное решение в бою.
    else if (f.swing.held) _wish.multiplyScalar(T.chargeMoveSlow);

    _planar.set(f.velocity.x, 0, f.velocity.z);

    if (this.grounded) {
      const rate = _wish.lengthSq() > 0.01 ? T.moveAccel : T.moveBrake;
      moveTowardsVec(_planar, _wish.multiplyScalar(T.maxRunSpeed), rate * dt);
    } else {
      f.velocity.y += T.gravity * dt;
      if (_wish.lengthSq() > 0.01) {
        // В воздухе управление слабое: сбитый боец должен долетать до края,
        // а не выруливать обратно на арену.
        moveTowardsVec(_planar, _wish.multiplyScalar(T.maxRunSpeed), T.airControl * dt);
      }
    }

    this.planarSpeed = _planar.length();
    f.velocity.x = _planar.x;
    f.velocity.z = _planar.z;
  }

  /**
   * Разворот к прицелу. Тело расставляется формулами, поэтому поворот задаётся
   * напрямую поворотом корня — никакой инерции дубины, за которую цеплялась
   * прошлая схема.
   */
  applyFacing(dt) {
    const f = this.f;
    const want = f.facingTarget;
    if (want.x * want.x + want.z * want.z < 1e-8) return;

    const target = Math.atan2(want.x, want.z) * RAD;
    const current = f.yaw * RAD;
    const step = T.turnSpeed * dt;
    const diff = deltaAngle(current, target);
    f.yaw = (current + clamp(diff, -step, step)) * DEG;
  }
}

function moveTowardsVec(current, target, maxDelta) {
  const dx = target.x - current.x;
  const dy = target.y - current.y;
  const dz = target.z - current.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist <= maxDelta || dist < 1e-9) {
    current.copy(target);
    return current;
  }
  const k = maxDelta / dist;
  current.x += dx * k;
  current.y += dy * k;
  current.z += dz * k;
  return current;
}
