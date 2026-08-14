import * as THREE from 'three';
import { tuning as T } from 'tk/tuning.js';
import { clamp01, noiseSigned, DEG } from 'tk/mathx.js';

// The camera is isometric: an orthographic projection at a fixed angle.
//
// There is no perspective anymore, and it is not stylization for its own
// sake. In perspective, identical fighters at opposite ends of the arena
// are different sizes, and verticals keel over harder the farther they are
// from the frame's center — both interfere with reading the only thing
// that decides anything in this game: who stands where relative to the
// edge. Orthography shows everyone the same.
//
// The classic isometric angle — tilt 35.264°, turn 45°. The first number
// is not invented: it is arctan(1/√2), the exact tilt at which a cube's
// three axes meet the screen at equal 120°. Hence the look of a "column"
// with three faces, each its own lightness.
//
// The turn deliberately never changes during play. The aim point comes
// from a camera ray, so the moment the camera turned, "mouse right" would
// stop meaning "strike right". The camera only travels.
//
// The arena is small and must fit the frame whole, or opponents arrive out
// of nowhere. The camera stands not behind the player but between the
// arena's center and the player — the share is camFollowWeight.

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
   * Screen axes projected onto the deck: WASD binds to what the player
   * sees, not to world coordinates.
   *
   * The sign on `right` is not a typo. Unity is left-handed, three.js is
   * right-handed, and a camera standing on −Z looking at +Z shows world +X
   * on opposite sides of the screen in the two systems. The formula
   * carried over from Unity verbatim gave mirrored A and D.
   *
   * The axes are computed from camYaw rather than read off the camera
   * matrix on purpose: the matrix also carries the shake, and the controls
   * would get nudged along with the frame on every hit.
   */
  groundBasis(out) {
    const yaw = T.camYaw * DEG;
    out.forward.set(Math.sin(yaw), 0, Math.cos(yaw));
    out.right.set(-Math.cos(yaw), 0, Math.sin(yaw));
    return out;
  }

  /**
   * The frame bounds that fit the whole arena.
   *
   * Orthography has no dolly: distance changes nothing, the frame size is
   * set directly by its bounds. So instead of "how far to pull back" the
   * question is "how wide a frame to take".
   *
   * Vertically the disc is flattened by the tilt and needs less — but
   * exactly as much less as the camera is tilted. Plus headroom above for
   * the fighter's height: forget it and the disc fits while the head pokes
   * out of frame.
   */
  applyFrustum(aspect) {
    if (aspect) this.aspect = aspect;
    const a = Math.max(0.2, this.aspect);
    const r = T.arenaRadius * T.camFitMargin;
    const tall = r * Math.sin(T.camPitch * DEG) + T.camHeadroom;

    // The frame must hold both the width and the height: take whichever is
    // larger and stretch the other side by the screen's aspect.
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
    // The camera looks down-forward, so it stands behind and above the
    // point of attention.
    _dir.set(0, 0, 1).applyQuaternion(_quat);
    // Distance changes nothing in an orthographic image — it only matters
    // that everything stays between near and far. Taken with margin.
    return out.copy(focus).addScaledVector(_dir, -T.camDistance);
  }

  /**
   * dt here is deliberately unscaled: in slow motion the camera must stay
   * responsive, or the frame trails the player with a lag.
   */
  tick(dt, target) {
    // The arena radius and the tilt are live sliders, and the frame bounds
    // depend on them.
    this.applyFrustum();

    _focus.copy(this.center);
    if (target) {
      _focus.copy(target).addScaledVector(this.lookAhead, T.camLookAhead);
      _focus.lerpVectors(this.center, _focus, clamp01(T.camFollowWeight));
    }

    this.desiredPosition(_focus, _desired);

    // Critically damped smoothing — the same SmoothDamp as Unity's: the
    // camera catches up without overshoot, and a sharp turn does not whip
    // the frame.
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
