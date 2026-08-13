import { tuning as T } from 'tk/tuning.js';

// Match flow. Two modes, switched live by the Deathmatch toggle:
//
// - Rounds (default): fall off the arena and you are out; last one standing
//   wins the round. The score is rounds won and lost.
// - Deathmatch: nobody is ever out — the fallen respawn after a short pause
//   and the fight never ends. The score is kills, CS-style: whoever downed
//   the victim (or drove them to the fall) within the credit window owns it.
//
// Kills are counted in BOTH modes — in rounds they simply accumulate
// alongside the round score. Flipping the mode resets every score: kills
// from an endless brawl and kills from rounds mean different things.
//
// There is deliberately no other state here: everything the outside needs
// is the phase, the score line and the banner to display.

export const Phase = {
  /** Countdown before the brawl: enough to see who stands where. */
  Ready: 'ready',
  Fight: 'fight',
  /** Round finished (rounds mode only): show the result, wait, restart. */
  Over: 'over',
};

export class Match {
  constructor(fighters, player, onRestart, onRespawn) {
    this.fighters = fighters;
    this.player = player;
    this.onRestart = onRestart;
    /** Places ONE fighter back mid-fight; deathmatch is the only caller. */
    this.onRespawn = onRespawn;
    this.round = 0;
    this.wins = 0;
    this.losses = 0;
    this.deathmatch = !!T.deathmatch;
    this.begin();
  }

  begin() {
    this.round++;
    this.phase = Phase.Ready;
    this.timer = T.matchReadyTime;
    this.winner = null;
    this.onRestart();
  }

  /** The toggle flipped: scores from one mode make no sense in the other. */
  switchMode() {
    this.deathmatch = !!T.deathmatch;
    this.round = 0;
    this.wins = 0;
    this.losses = 0;
    for (const f of this.fighters) { f.kills = 0; f.deaths = 0; }
    this.begin();
  }

  get alive() {
    let n = 0;
    for (const f of this.fighters) if (f.alive) n++;
    return n;
  }

  /** Fighters have control only during the fight — everyone waits out the countdown. */
  get controlEnabled() {
    return this.phase === Phase.Fight;
  }

  tick(dt) {
    if (this.deathmatch !== !!T.deathmatch) return this.switchMode();
    this.timer -= dt;

    if (this.phase === Phase.Ready) {
      if (this.timer <= 0) {
        this.phase = Phase.Fight;
        this.timer = 0;
      }
      return;
    }

    if (this.phase === Phase.Fight) {
      if (this.deathmatch) {
        // Death only costs time. The pause matters: an instant respawn
        // erases the fall — nobody registers that anything was lost.
        for (const f of this.fighters) {
          if (!f.alive && f.deadTime >= T.respawnTime) this.onRespawn(f);
        }
        return;
      }

      // Victory is «at most one left», not «exactly one»: a single blow
      // can carry two fighters off the edge, and then nobody won.
      if (this.alive > 1) return;
      this.phase = Phase.Over;
      this.timer = T.matchOverTime;
      this.winner = this.fighters.find((f) => f.alive) || null;
      if (this.winner === this.player) this.wins++;
      else this.losses++;
      return;
    }

    if (this.timer <= 0) this.begin();
  }

  /** Top killer — the one to beat in deathmatch. */
  get leader() {
    let best = this.fighters[0];
    for (const f of this.fighters) if (f.kills > best.kills) best = f;
    return best;
  }

  /** Big line mid-screen. Null — nothing to show. */
  get banner() {
    if (this.phase === Phase.Ready) {
      const left = Math.max(1, Math.ceil(this.timer));
      return {
        big: String(left),
        small: this.deathmatch ? 'Deathmatch' : 'Round ' + this.round,
      };
    }
    if (this.phase === Phase.Over) {
      if (!this.winner) return { big: 'Draw', small: 'Everybody fell' };
      return this.winner === this.player
        ? { big: 'Victory', small: 'Last one standing' }
        : { big: 'Defeat', small: this.winner.name + ' outlasted everyone' };
    }
    return null;
  }

  /** Short score line for the HUD. */
  get score() {
    const p = this.player;
    if (this.deathmatch) {
      const top = this.leader;
      const who = top.kills > 0 ? `   leader ${top.name} ${top.kills}` : '';
      return `kills ${p.kills}   deaths ${p.deaths}${who}`;
    }
    return `round ${this.round}   score ${this.wins}:${this.losses}   kills ${p.kills}   arena ${this.alive}`;
  }
}
