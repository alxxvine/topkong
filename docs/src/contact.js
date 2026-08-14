import * as THREE from 'three';
import { tuning as T } from 'tk/tuning.js';
import { P } from 'tk/body.js';
import { clamp, lerp } from 'tk/mathx.js';

// Fighters finally occupy space.
//
// Until this file, bodies passed clean through each other, and the
// "invisible wall" opponents seemed to hit was exactly that: there was no
// wall at all. The bot keeps its distance by itself (bot.js), and from the
// outside that read as leaning on nothing — walks up, stops, goes no
// further.
//
// There are three rules, and they differ not for variety's sake but
// because a standing body and a downed one are different obstacles:
//
//   standing ↔ standing   push apart and trade momentum. This is the
//                         shoulder shove: walk into an opponent and you
//                         drive them ahead of you — all the way to the rim,
//                         no weapon needed.
//   standing → downed     does NOT collide. A ragdoll is rolled ahead:
//                         walk up, scoop, shove off. Were there a wall
//                         here, a downed body would become a pillar in the
//                         middle of the arena — and the complaint was
//                         precisely about not being able to walk past one.
//   downed ↔ downed       nothing. Two ragdolls pushing each other can
//                         only tremble in unison.
//
// This runs BEFORE the fighters' ticks: a tick puts the pelvis where the
// root points, so a position correction must be seen by the tick, not by
// the next frame.

const _n = new THREE.Vector3();

export function resolveContacts(fighters, dt) {
  for (let i = 0; i < fighters.length; i++) {
    for (let j = i + 1; j < fighters.length; j++) {
      pair(fighters[i], fighters[j], dt);
    }
  }
}

/** Is this one down: the same threshold at which a fighter loses control. */
function isDown(f) {
  return f.body.strength < T.controlStrength;
}

function pair(a, b, dt) {
  if (!a.alive || !b.alive) return;
  const aDown = isDown(a);
  const bDown = isDown(b);
  if (aDown && bDown) return;
  if (aDown) return roll(b, a, dt);
  if (bDown) return roll(a, b, dt);
  block(a, b, dt);
}

/**
 * Ram pressure: the victim is being CARRIED faster than they want to go.
 *
 * That is exactly what tells a ram from two people running together. The
 * fighter's velocity along the line from the opponent is compared with
 * their own ORDERED velocity the same way: whoever runs by choice gets
 * nothing, whoever is carried against their will gets rattled. Below the
 * speed threshold pressure does not accrue at all, so propping an opponent
 * with a shoulder is possible while toppling them with a step is not.
 *
 * Rattle at its limit releases the muscles: the fighter falls ALONG the
 * ram. That is what "ram them to the end" means.
 */
function ramPressure(f, attacker, nx, nz, dt) {
  const l = f.locomotion;
  const v = l.velX * nx + l.velZ * nz;
  const want = Math.max(0, l.wantX * nx + l.wantZ * nz);
  const press = v - want - T.shoveStaggerAt;
  if (press <= 0) return;
  f.stagger = Math.min(1, f.stagger + press * T.shoveStaggerRate * dt);
  // Where the fall is heading is remembered for the pose: the victim leans
  // WHERE they are being pushed and falls out of the lean, not out of an
  // upright stance.
  const k = Math.min(1, 10 * dt);
  f.staggerDirX += (nx - f.staggerDirX) * k;
  f.staggerDirZ += (nz - f.staggerDirZ) * k;
  if (f.stagger >= 1) {
    // A modest push. By this moment the body is already leaning along the
    // ram, and releasing the muscles is enough: a big impulse read as
    // "sent flying", and the need is "buckled".
    _n.set(nx * T.shoveTopple, T.shoveTopple * 0.35, nz * T.shoveTopple);
    f.takeHit(_n, dt);
    f.credit(attacker);
    f.stagger = 0;
  }
}

/**
 * Two on their feet: separation plus a momentum trade along the normal.
 *
 * The trade is deliberately inelastic, toward the shared velocity. An
 * elastic bounce would read as billiards, and the need is the opposite:
 * the fighter walking forward PRESSES, and the opponent rides ahead of him
 * exactly as long as he keeps walking. The shoveTransfer knob is the share
 * of that trade: at zero the bodies merely refuse to interpenetrate.
 */
function block(a, b, dt) {
  const r = T.bodyRadius;
  let dx = b.position.x - a.position.x;
  let dz = b.position.z - a.position.z;
  let d = Math.hypot(dx, dz);
  const gap = r * 2;
  if (d >= gap) return;

  // Exactly inside each other — push apart in any direction, so long as
  // they separate.
  if (d < 1e-4) { dx = 1; dz = 0; d = 1; }
  const nx = dx / d;
  const nz = dz / d;
  const half = (gap - d) * 0.5;

  a.position.x -= nx * half;
  a.position.z -= nz * half;
  b.position.x += nx * half;
  b.position.z += nz * half;

  const la = a.locomotion;
  const lb = b.locomotion;
  const va = la.velX * nx + la.velZ * nz;
  const vb = lb.velX * nx + lb.velZ * nz;
  // Moving apart — nothing to catch on.
  if (va - vb <= 0) return;

  const shared = (va + vb) * 0.5;
  const ta = lerp(va, shared, T.shoveTransfer) - va;
  const tb = lerp(vb, shared, T.shoveTransfer) - vb;
  la.velX += nx * ta;
  la.velZ += nz * ta;
  lb.velX += nx * tb;
  lb.velZ += nz * tb;

  // After the trade both ride almost together — and each is checked for
  // being carried. Each gets his own normal: "away from the opponent".
  ramPressure(a, b, -nx, -nz, dt);
  ramPressure(b, a, nx, nz, dt);

  // A glancing graze — a reaction of the BODY, not of an invisible field.
  //
  // When one passes by and clips the other with a shoulder, the collision
  // has a TANGENTIAL component — the contact sliding sideways. It turns
  // both around the contact point (the clipped one, standing, is dragged
  // around after the passer-by) and briefly rocks the clipped one. That is
  // exactly how "clipped by a shoulder" reads: not a wall, but a person
  // who got spun.
  const tx = -nz;
  const tz = nx;
  const relT = (la.velX - lb.velX) * tx + (la.velZ - lb.velZ) * tz;
  if (Math.abs(relT) > 0.15) {
    const spin = relT * T.grazeSpin * dt;
    a.yaw += spin;
    b.yaw += spin;
    // The facing controller will straighten the root turn within a fraction
    // of a second — rightly so, "staggered and recovered". The SHOULDER
    // TWIST though lives in the pose: the shoulders got spun after the
    // passer-by, and they play themselves back.
    const jolt = relT * T.grazeTwist * dt;
    if (a.poseDriver) a.poseDriver.grazeJolt = clamp(a.poseDriver.grazeJolt + jolt, -40, 40);
    if (b.poseDriver) b.poseDriver.grazeJolt = clamp(b.poseDriver.grazeJolt + jolt, -40, 40);
    // A light shake for the clipped one — whoever moves SLOWER: he is the
    // one rocked. The cap is below toppling: a graze rattles, never fells.
    const slower = Math.hypot(la.velX, la.velZ) < Math.hypot(lb.velX, lb.velZ) ? a : b;
    if (slower.stagger < 0.35) {
      slower.stagger = Math.min(0.35, slower.stagger + Math.abs(relT) * 0.6 * dt);
      const sn = slower === a ? -1 : 1;
      const k = Math.min(1, 10 * dt);
      slower.staggerDirX += (sn * nx - slower.staggerDirX) * k;
      slower.staggerDirZ += (sn * nz - slower.staggerDirZ) * k;
    }
  }

  // There is NO mutual clinch wear, and that is a game decision, not an
  // omission. Tried it: a stalemate where both press head-on wore both
  // down equally — and both fell at the same instant. It looked absurd:
  // only the one being carried should fall, and head-to-head is an honest
  // deadlock. The way out is to come in from the side, and the bots do.
}

/**
 * A standing fighter rolls a downed one.
 *
 * What gets pushed is not the pelvis but THE PART that was reached: run
 * into the legs and the legs get turned. Otherwise the downed body would
 * slide flat like a crate, with no ragdoll left in it at all.
 *
 * The push is strong enough to roll — not to launch. Shoving somebody off
 * the arena with the body works, but you must walk them to the edge, and
 * that is time enough to be answered.
 */
function roll(mover, downed, dt) {
  const speed = Math.hypot(mover.locomotion.velX, mover.locomotion.velZ);
  if (speed < T.shoveMinSpeed) return;

  const reach = T.bodyRadius + T.shoveReach;
  const body = downed.body;
  const power = (speed - T.shoveMinSpeed) * T.shovePower;
  let touched = false;

  for (let i = 0; i < body.pos.length; i++) {
    const p = body.pos[i];
    const dx = p.x - mover.position.x;
    const dz = p.z - mover.position.z;
    const d = Math.hypot(dx, dz);
    if (d >= reach) continue;
    // Push ALONG the mover's travel, not radially away: pushed apart, the
    // downed body scatters and spins in place instead of riding ahead of
    // the feet.
    _n.set(mover.locomotion.velX / speed, 0, mover.locomotion.velZ / speed);
    // Closer to the mover — stronger: the body pivots around its far end
    // instead of sliding flat.
    const bite = 1 - d / reach;
    body.push(i, _n.multiplyScalar(power * bite), dt);
    touched = true;
  }
  // Rolling a downed body toward the edge is "driving them to the fall":
  // the credit refreshes for as long as the pushing actually lands.
  if (touched) downed.credit(mover);
}
