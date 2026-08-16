import * as THREE from 'three';
import { tuning as T } from 'tk/tuning.js';
import { clamp01, lerp } from 'tk/mathx.js';

// The opponent.
//
// It has no physics and no pose of its own at all: it writes exactly the
// same three fields as a live player — where to walk, where to look,
// whether to hold the wind-up. Everything else is done by the same
// locomotion, gait and strike. That is not economy but a test: if a bot
// ever needed something extra, the player's controls would be built wrong.
//
// It has three skills and picks between them by distance — to the opponent
// and to the edge. No behavior tree: on an arena with no cover there is
// little to choose from, and an extra layer would only hide why the bot
// did what it did.

const _to = new THREE.Vector3();
const _away = new THREE.Vector3();

// The roster. Each session draws its opponents from here at random — same
// bot brain, different characters. `temper` is aggression: hot heads rest
// less between swings and release early pokes, patient ones wind up heavy
// hits. `fear` is edge caution: cowards turn back far from the rim, the
// reckless fight with their heels over it. club: false makes a brawler
// who rams with the body and throws bare-knuckle punches up close.
export const BOT_ROSTER = [
  { name: 'Boulder', color: 0x5b8def, club: true,  temper: 0.35, fear: 0.5 },
  { name: 'Pepper',  color: 0xc46fb0, club: true,  temper: 0.9,  fear: 0.3 },
  { name: 'Moose',   color: 0x4fbf8b, club: false, temper: 0.55, fear: 0.2 },
  { name: 'Whisper', color: 0x8b7ee0, club: true,  temper: 0.5,  fear: 0.85 },
  { name: 'Sparky',  color: 0xdcb64a, club: true,  temper: 0.95, fear: 0.45 },
  { name: 'Anvil',   color: 0x4bc4c4, club: true,  temper: 0.25, fear: 0.35 },
  { name: 'Button',  color: 0xe58f6f, club: true,  temper: 0.4,  fear: 0.7 },
  { name: 'Grudge',  color: 0x9aa56b, club: false, temper: 0.75, fear: 0.15 },
  { name: 'Tiptoe',  color: 0x6fa8dc, club: true,  temper: 0.6,  fear: 0.9 },
  { name: 'Rhubarb', color: 0xa06fd6, club: true,  temper: 0.7,  fear: 0.55 },
];

export class Bot {
  constructor(fighter, arena, persona = null) {
    this.f = fighter;
    this.arena = arena;
    /** Its own reaction delay: identical bots read as one bot in three bodies. */
    this.lag = 0.12 + Math.random() * 0.18;
    this.think = Math.random() * this.lag;
    this.target = null;
    this.wantSwing = false;
    /** Waits after its own strike — otherwise it hammers non-stop. */
    this.rest = 0;
    /** How long we have been leaning into the opponent with no headway. */
    this.clinch = 0;
    /** How much longer to back off after a clinch, and which side to circle. */
    this.backoff = 0;
    this.side = 1;
    this.clinchLimit = 0.5 + Math.random() * 0.8;

    // Character. Neutral defaults when no persona is given (test dummies).
    const temper = persona ? persona.temper : 0.5;
    const fear = persona ? persona.fear : 0.5;
    /** Rest between own swings: hot heads barely pause. */
    this.restMul = 1.7 - 1.2 * temper;
    /** Skews the charge draw: >1 favors quick pokes, <1 heavy wind-ups. */
    this.chargePow = 0.6 + 1.2 * temper;
    /** Added to the edge-fear radius: cowards bail out early. */
    this.fearBias = -0.10 + 0.22 * fear;

    // Defense. A read wind-up gets ANSWERED now: the timid raise the
    // shell, the hot-blooded hop aside or poke first. Reaction cooldown
    // keeps the bot from twitching at every raised club.
    /** Chance to answer a read wind-up at all. */
    this.defChance = 0.5 + 0.4 * fear;
    /** Of the answers, how many are a dodge instead of a block. */
    this.dodgeShare = 0.2 + 0.45 * temper;
    /** Chance to hurl a YOUNG charge as a counter-poke at a wind-up. */
    this.counterBias = 0.3 + 0.5 * temper;
    this.defCd = 0;
    this.blockHold = 0;
    this.threat = null;
  }

  reset() {
    this.target = null;
    this.wantSwing = false;
    this.rest = 0;
    this.clinch = 0;
    this.backoff = 0;
    this.defCd = 0;
    this.blockHold = 0;
    this.f.blocking = false;
  }

  tick(dt, fighters) {
    const f = this.f;
    if (!f.alive) {
      f.moveInput.set(0, 0);
      f.swing.held = false;
      f.blocking = false;
      f.swing.blockPose = false;
      return;
    }

    this.defCd = Math.max(0, this.defCd - dt);
    // A held shell overrides everything else this tick: stand, face the
    // threat, keep the guard up. An empty pool cannot hold it.
    if (this.blockHold > 0) {
      this.blockHold -= dt;
      if (f.stamina <= 0.02) this.blockHold = 0;
    }
    f.blocking = this.blockHold > 0 && f.state === 'standing';
    f.swing.blockPose = f.blocking;
    if (f.blocking) {
      const t = this.threat && this.threat.alive ? this.threat : this.target;
      if (t) {
        f.facingTarget.set(
          t.position.x - f.position.x, 0, t.position.z - f.position.z);
      }
      f.moveInput.set(0, 0);
      f.swing.held = false;
      return;
    }

    this.rest = Math.max(0, this.rest - dt);
    this.think -= dt;
    if (this.think <= 0) {
      this.think = this.lag;
      this.target = this.pickTarget(fighters);
    }

    const myEdge = Math.hypot(f.position.x, f.position.z) / Math.max(0.1, this.arena.radius);
    const victim = this.target;
    const victimEdge = victim
      ? Math.hypot(victim.position.x, victim.position.z) / Math.max(0.1, this.arena.radius)
      : 0;
    const victimDown = victim && victim.body.strength < T.controlStrength;

    // 1. Survive. At the very edge nothing else matters: a fighter who
    // stubbornly walks into a fight while standing heels-over-the-drop
    // simply goes down and shows no fight at all.
    //
    // BUT the fear recedes while the bot is the one pushing: the victim
    // lies (or stands) FARTHER from the center than he does — so their
    // body is between him and the drop, and walking them to the rim is
    // safer than it looks. Without this correction the bot abandoned its
    // prey on the approach and the prey calmly got up: measured, it rolled
    // them to radius 5.6 of 7.5 and turned away.
    const pushingOut = victim && (victimDown || !f.hasClub) && victimEdge > myEdge + 0.03;
    const fearAt = pushingOut ? 0.93
      : Math.min(0.92, Math.max(0.4, T.botEdgeFear + this.fearBias));
    if (myEdge > fearAt) {
      _away.set(-f.position.x, 0, -f.position.z).normalize();
      f.moveInput.set(_away.x, _away.z);
      f.facingTarget.copy(_away);
      f.swing.held = false;
      return;
    }

    if (!victim) {
      f.moveInput.set(0, 0);
      f.swing.held = false;
      // Without an opponent it turns toward the center: at least it is not
      // standing with its back to the arena.
      f.facingTarget.set(-f.position.x, 0, -f.position.z);
      return;
    }

    // Is THIS bot armed: its own roster choice plus the global toggles.
    const armed = f.hasClub;

    _to.copy(victim.position).sub(f.position);
    _to.y = 0;
    const dist = _to.length();
    if (dist > 1e-4) _to.divideScalar(dist);
    f.facingTarget.copy(_to);

    // 2. Keep distance. There is no point coming closer than strike range:
    // that way lies close-quarters jostling nobody wins.
    //
    // With a DOWNED victim it is the opposite: walk right in and roll them
    // to the edge with the body. While the rule was shared, the bot stood
    // a meter from the fallen and shuffled there — from the outside it
    // looked like leaning on an invisible wall, all the more so when
    // bodies did not collide at all and there was no wall of any kind.
    const hit = T.botStrikeRange;

    // A downed victim is ROLLED TO THE EDGE, not approached. A course at
    // the body itself ended in shuffling next to it: arrived — target
    // underfoot — standing. The target is placed BEYOND the victim, out
    // from the arena's center, and the bot walks through, pushing the body
    // ahead. Near the rim the edge fear above turns him around.
    if (victimDown) {
      const vlen = Math.hypot(victim.position.x, victim.position.z);
      const ox = vlen > 0.3 ? victim.position.x / vlen : _to.x;
      const oz = vlen > 0.3 ? victim.position.z / vlen : _to.z;
      _away.set(victim.position.x + ox * 1.6 - f.position.x, 0,
                victim.position.z + oz * 1.6 - f.position.z).normalize();
      f.moveInput.set(_away.x, _away.z);
      f.facingTarget.copy(_away);
      f.swing.held = false;
      return;
    }

    // The clinch. A head-on ram is sumo: neither is carried anywhere, no
    // rattle accrues, and that is physically honest. So head-to-head does
    // not decide — a bot that has leaned in for a second backs off and
    // comes in from the SIDE: a victim carried sideways is not saved by
    // their own stride.
    if (!armed) {
      const gap = dist - T.bodyRadius * 2;
      if (gap < 0.15 && f.locomotion.planarSpeed < 0.35) this.clinch += dt;
      else this.clinch = Math.max(0, this.clinch - dt * 2);
      // Each clinch gets its own limit. Two identical bots with the same
      // limit backed off IN SYNC and danced like that forever: nobody was
      // there to break the symmetry.
      if (this.clinch > this.clinchLimit) {
        this.clinch = 0;
        this.clinchLimit = 0.5 + Math.random() * 0.8;
        this.backoff = 0.8 + Math.random() * 0.5;
        this.side = Math.random() < 0.5 ? -1 : 1;
      }
      if (this.backoff > 0) {
        this.backoff -= dt;
        // Back and sideways at once: leaving the clinch along an arc,
        // not a bounce.
        f.moveInput.set(
          -_to.x * 0.7 + _to.z * this.side * 0.7,
          -_to.z * 0.7 - _to.x * this.side * 0.7);
        f.swing.held = false;
        return;
      }
    }

    let drive = 0;
    // Unarmed, distance is meaningless: nothing to strike with, the whole
    // fight is the ram.
    if (!armed) drive = 1;
    else if (dist > hit) drive = 1;
    else if (dist < hit * 0.72) drive = -1;

    // After its own strike it backs off: a pause the opponent can answer
    // in, and it is what makes the fight read as an exchange, not a scrum.
    if (this.rest > 0) drive = -1;

    f.moveInput.set(_to.x * drive, _to.z * drive);

    // 2.6 Answer a read wind-up. The swing telegraphs by design — the
    // bot reads it too: somebody near, facing us, is raising a club.
    // The timid raise the shell, the hot-blooded hop aside or hurl what
    // they have banked; the cooldown keeps the bot from twitching at
    // every lifted arm.
    const threat = this.readThreat(fighters);
    if (threat && this.defCd <= 0 && f.swing.state === 'guard') {
      this.defCd = 0.7 + Math.random() * 0.7;
      if (Math.random() < this.defChance) {
        if (Math.random() < this.dodgeShare
            && f.stamina > T.staminaDashCost * 0.5) {
          // A dash-flavored sidestep off the strike line.
          const side = Math.random() < 0.5 ? -1 : 1;
          const dx = f.position.x - threat.position.x;
          const dz = f.position.z - threat.position.z;
          const len = Math.hypot(dx, dz) || 1;
          f.locomotion.shove((dz / len) * side * T.dashPower,
            (-dx / len) * side * T.dashPower);
          f.poseDriver.dashKick = 1;
          f.stamina = Math.max(0, f.stamina - T.staminaDashCost * 0.5);
        } else if (f.stamina > 0.25) {
          // Long enough to actually CATCH the slow swings of this game.
          this.blockHold = 0.7 + Math.random() * 0.5;
          this.threat = threat;
          f.swing.held = false;
          return;
        }
      }
    }
    // A young charge answers a wind-up with a QUICK poke instead of a
    // patience contest — the hot-blooded release early on purpose.
    if (threat && this.defCd <= 0 && f.swing.state === 'windup'
        && f.swing.held && f.swing.charge < 0.4) {
      this.defCd = 0.7 + Math.random() * 0.7;
      if (Math.random() < this.counterBias) {
        f.swing.held = false;
        this.rest = T.botRest * this.restMul * 0.6;
        return;
      }
    }

    // 3. Strike. The charge builds while the opponent is in reach and is
    // released once the intended amount is banked. Release EARLY — the
    // sweep takes time, and a point-blank release always arrives late.
    // Unarmed bots throw punches: same machine, PUNCH_STYLES, and a much
    // tighter release window — a fist is as short as the arm.
    const range = armed ? hit * 1.25 : 1.05;
    const inRange = dist < range && this.rest <= 0;
    if (!inRange) {
      if (f.swing.held) f.swing.held = false;
      this.wantSwing = false;
      return;
    }

    if (!f.swing.held && f.swing.state === 'guard') {
      // Wait-and-see: a club is already coming up across the line. Do
      // not start a charge INTO it — the guard stays free, and the next
      // reaction window can raise the shell or hop. This is also what
      // finally makes bot blocks VISIBLE: before it, a bot in range was
      // always mid-charge and the defense window never opened.
      if (threat) return;
      f.swing.held = true;
      // How much to bank this time. The spread is deliberate: a bot with
      // a constant charge reads as a metronome. The exponent is character:
      // hot heads skew the draw toward quick pokes, the patient toward
      // full wind-ups.
      this.wantSwing = lerp(T.botChargeMin, T.botChargeMax,
        Math.pow(Math.random(), this.chargePow));
    }

    if (f.swing.held && f.swing.charge >= this.wantSwing) {
      f.swing.held = false;
      this.rest = T.botRest * this.restMul;
    }
  }

  /** Somebody near, FACING us, mid wind-up or swing — a readable threat. */
  readThreat(fighters) {
    const f = this.f;
    for (const o of fighters) {
      if (o === f || !o.alive) continue;
      const st = o.swing.state;
      if (st !== 'windup' && st !== 'strike') continue;
      const dx = f.position.x - o.position.x;
      const dz = f.position.z - o.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 3.2 * 3.2) continue;
      const len = Math.sqrt(d2) || 1;
      if ((dx * Math.sin(o.yaw) + dz * Math.cos(o.yaw)) / len > 0.55) return o;
    }
    return null;
  }

  /** The nearest living fighter other than itself. */
  pickTarget(fighters) {
    let best = null;
    let bestDist = Infinity;
    for (const other of fighters) {
      if (other === this.f || !other.alive) continue;
      const d = other.position.distanceToSquared(this.f.position);
      if (d < bestDist) { bestDist = d; best = other; }
    }
    return best;
  }
}
