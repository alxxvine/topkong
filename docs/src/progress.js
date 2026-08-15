// Progression. Deathmatch is endless by design, and endless needs a spine:
// lifetime counters, achievements, and rewards that unlock things in the
// character menu. Everything lives in localStorage, like the rest of the
// player's identity — no server, no accounts.
//
// Deliberately a CLEAN demo ladder: every achievement is visible and its
// requirement spelled out — hover a locked reward and the menu tells you
// exactly what to do. No hidden entries, no mystery slots; that layer of
// intrigue was cut to keep the demo honest and legible.

const KEY = 'tk-progress';

// Reward types: { color: 0x??????, label } unlocks a swatch in the menu;
// { club: 'skinName', label } unlocks a club skin (see CLUB_SKINS in
// fighter.js).
export const ACHIEVEMENTS = [
  { id: 'first',   name: 'First Blood',  desc: 'Knock somebody off',
    need: 1, of: (p) => p.kills,
    reward: { club: 'bat', label: 'Bat' } },
  { id: 'gold',    name: 'Bouncer',      desc: '25 knock-offs',
    need: 25, of: (p) => p.kills,
    reward: { color: 0xf5c542, label: 'Gold' } },
  { id: 'ink',     name: 'Untouchable',  desc: '10 kills without dying once',
    need: 10, of: (p) => p.bestStreak,
    reward: { color: 0x23262e, label: 'Ink' } },
  { id: 'gild',    name: 'Marathon',     desc: '30 minutes in the arena',
    need: 1800, of: (p) => p.timePlayed, time: true,
    reward: { club: 'gilded', label: 'Gilded club' } },
  { id: 'century', name: 'Century',      desc: '100 knock-offs',
    need: 100, of: (p) => p.kills,
    reward: { color: 0xff2d75, label: 'Magma' } },
  { id: 'void',    name: 'Collector',    desc: '250 knock-offs',
    need: 250, of: (p) => p.kills,
    reward: { club: 'void', label: 'Void club' } },
];

function load() {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (p && typeof p.kills === 'number' && p.unlocked) return p;
  } catch { /* corrupt — start over */ }
  return null;
}

export class Progress {
  constructor() {
    this.p = load() || {
      kills: 0, deaths: 0, fistKills: 0,
      streak: 0, bestStreak: 0,
      timePlayed: 0,
      unlocked: {},
    };
    this._since = 0;
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.p)); } catch { /* full */ }
  }

  /** Real seconds of unpaused play; throttles its own saves. */
  beat(dt) {
    if (document.hidden) return;
    this.p.timePlayed += dt;
    this._since += dt;
    if (this._since > 5) { this._since = 0; this.save(); }
  }

  kill(armed) {
    this.p.kills++;
    if (!armed) this.p.fistKills++;
    this.p.streak++;
    if (this.p.streak > this.p.bestStreak) this.p.bestStreak = this.p.streak;
    this.save();
  }

  death() {
    this.p.deaths++;
    this.p.streak = 0;
    this.save();
  }

  /** Evaluate everything; returns the achievements unlocked JUST NOW. */
  check() {
    const fresh = [];
    for (const a of ACHIEVEMENTS) {
      if (!this.p.unlocked[a.id] && a.of(this.p) >= a.need) {
        this.p.unlocked[a.id] = true;
        fresh.push(a);
      }
    }
    if (fresh.length) this.save();
    return fresh;
  }

  has(id) { return !!this.p.unlocked[id]; }

  /** Is this reward color available to pick? */
  colorUnlocked(hex) {
    for (const a of ACHIEVEMENTS) {
      if (a.reward && a.reward.color === hex) return this.has(a.id);
    }
    return true;
  }

  clubUnlocked(skin) {
    if (skin === 'classic') return true;
    for (const a of ACHIEVEMENTS) {
      if (a.reward && a.reward.club === skin) return this.has(a.id);
    }
    return false;
  }
}
