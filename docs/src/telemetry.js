// Telemetry. Local-first: GitHub Pages is static hosting, there is no
// server to send events to, so every player's game keeps its own record
// in localStorage — an anonymous player id plus a rolling log of sessions.
//
// The private dashboard (metrics.html, passphrase-gated) reads this same
// storage on the owner's device, and other people's data travels as
// a compact "stats code": one tap on the pause screen copies it, the owner
// pastes it into the dashboard's import box. When a real backend appears
// (a Worker, Supabase), this module is the single place to add a POST.
//
// The record is deliberately aggregate-per-session, not a raw event
// stream: a session row already answers every question the dashboard
// asks, stays tiny (a few hundred bytes), and never grows unbounded.

const KEY = 'tk-metrics';
const CAP = 300;

function rid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (d && d.v === 1 && d.player && Array.isArray(d.sessions)) return d;
  } catch { /* corrupt — start over */ }
  return null;
}

export class Telemetry {
  constructor(build) {
    this.data = load() || {
      v: 1,
      player: { id: rid(), firstSeen: Date.now() },
      sessions: [],
    };

    /** The live session row. Everything below mutates this one object. */
    this.s = {
      id: rid(),
      t0: Date.now(),
      build: String(build || '?'),
      device: matchMedia('(pointer: coarse)').matches ? 'touch' : 'desktop',
      dur: 0,           // seconds actually played (unpaused, tab visible)
      fights: 0,        // FIGHT presses
      menuTime: null,   // seconds from load to the first FIGHT
      menuReturns: 0,   // Home button uses
      pauses: 0,
      settings: 0,      // slider/checkbox touches
      kills: 0,
      deaths: 0,
      hits: 0,          // club hits landed by the player
      swings: {},       // strikes thrown, by style name
      name: '',
      weapon: '',
      color: '',
      body: '',
    };
    this.data.sessions.push(this.s);
    if (this.data.sessions.length > CAP) {
      this.data.sessions.splice(0, this.data.sessions.length - CAP);
    }

    this._since = 0;
    this.save();
    // The tab can die without warning — persist on every hide.
    addEventListener('visibilitychange', () => { if (document.hidden) this.save(); });
    addEventListener('pagehide', () => this.save());
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* full */ }
  }

  /** Called every frame with real seconds; throttles its own saves. */
  beat(dt) {
    if (document.hidden) return;
    this.s.dur += dt;
    this._since += dt;
    if (this._since > 5) { this._since = 0; this.save(); }
  }

  add(field, n = 1) { this.s[field] += n; }

  swing(style) { this.s.swings[style] = (this.s.swings[style] || 0) + 1; }

  /** FIGHT pressed: what the player goes in as. */
  fight(info) {
    this.s.fights++;
    if (this.s.menuTime === null) {
      this.s.menuTime = Math.round((Date.now() - this.s.t0) / 1000);
    }
    Object.assign(this.s, info);
    this.save();
  }

  /** Compact share code for the pause screen: this player, recent sessions. */
  export() {
    const blob = {
      v: 1,
      player: this.data.player,
      sessions: this.data.sessions.slice(-120),
    };
    return btoa(unescape(encodeURIComponent(JSON.stringify(blob))));
  }
}
