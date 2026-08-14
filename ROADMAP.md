# TOPKONG — combat and gameplay

## The vision

TopKong is not yet another physics party game.

The goal is combat fought with body weight, inertia, balance and position —
not with health bars and animation chains. The feel sits somewhere between:

- **UFC** — timing, punishment, the price of committing to a strike;
- **Chivalry** — readable melee;
- **Party Animals** — a funny physical body;
- **Gang Beasts** — situations nobody scripted.

There should be more mastery in it than in Party Animals while the entry
barrier stays low. The player must feel they are steering a living, heavy
creature — not losing to an animation.

Simple controls. Deep physical interactions. No combo inputs. Depth comes
from timing, position and physics.

---

## The foundation: a body on muscles

The decision is deliberate and it shapes the architecture: **the body is
simulated at all times**, as an active ragdoll. We tried exactly this in
Unity and walked away — the controls fought the physics there. But that
failure had specific causes, and they do not reproduce here.

In Unity the springs fought PhysX's `ConfigurableJoint`: the closed loop of
a two-handed grip, solver stability outside my control, a separate root
capsule above the ragdoll — two competing truths about one body.

Here the solver is ours (Verlet with distance links), the grip is
one-handed, and the pose is already computed by formulas. So the scheme is
different:

> **`computePose` stops writing bones and becomes the TARGET. Particles are
> pulled toward it by "muscles" — springs of adjustable strength. The body
> is physical at all times; the only question is how firmly the muscles hold
> the pose.**

Half of the roadmap grows out of this single mechanism:

| Game mechanic | What it turns out to be in code |
|---|---|
| Balance | overall muscle strength |
| Reaction by hit location | impulse into a particle, muscles fight locally |
| Per-limb damage | that limb's muscle strength |
| Fatigue | muscle strength recovery rate |
| Falling | strength that reached zero |

**What protects the controls.** The root stays authoritative: input instantly
moves the *target* — where the fighter wants to stand and where he looks —
and the physical body catches up. That is the "responsive but not robotic;
the body slightly lags the direction" requirement. If the controls turn out
viscous, the muscle-strength knob takes them to rigid without a rewrite.

As a side effect a whole class of bugs disappears — like the body flashing at
the arena's center: it only existed because the body switched between two
representations. The representation becomes one.

---

## Iterations

Strictly one at a time. The next one does not start until the previous one
feels right.

### I1 — The physical body

So that it is interesting before there is any combat.

- The Verlet body is simulated at all times; the "controlled" vs "ragdoll"
  split disappears.
- `poseDriver` outputs the target pose instead of writing bones. The jelly
  springs are removed — the muscles do the same thing, honestly.
- Muscles: a spring per particle toward its target, per-joint strength.
- Input drives the pelvis target and the facing target; the body catches up.
- Turn inertia: currently a flat 420°/s with no ramp-up.
- The club becomes real mass in the chain and visibly drags the torso.
- Feet: constant deck contact and friction.

**Done when** running stops looking like an animation, the body lags the
direction, the turn has a ramp-up, the heavy weapon visibly drags the torso —
and the controls have not turned viscous.

#### I1 is finished on a clean body, without the weapon

The first playthrough showed a wooden body, and the investigation found
causes that were not on the original list at all:

- Shoulders and head **did not turn with the body in rendering**. Bone
  rotation came from `aim(head − chest)` — a nearly vertical vector — so
  rotation around it stayed undefined. Measured: the face's divergence from
  the fighter's heading equaled his turn angle one-to-one, up to 180°.
- **Torso twist did not exist** as a degree of freedom: all particles turned
  by one angle, and the shoulder and hip targets were constants.
- **One muscle stiffness answered for two things** — jelly and the fighter's
  height. A soft spring settles below its target under weight, so softness
  came bundled with a slouch.
- **The guard stance was "arms at the seams"** — a man in a queue, not
  a fighter.

The second playthrough added the main one: **the feet did not stand on the
ground.** Their target was computed in the pelvis frame, so support did not
exist and the gait was sliding with a step cycle painted on. That was
rewritten whole (`docs/src/gait.js`); slippage fell from 87% to 17%.

That is why the club is removed with the `withClub` toggle, and the gait,
turns and jelly are tuned on a clean body. Nine kilograms on the right wrist
skew exactly what we are trying to judge. The weapon returns with one
checkbox — neither the pose nor the skeleton get rebuilt — and that is when
"the club visibly drags the torso" gets finished.

#### Four iterations of body physics

The body was rewritten four times, and every version stayed in history —
they can be pulled out and compared, not just remembered.

| | what it is | where to get it |
|---|---|---|
| **1. Kinematic** | the pose writes bones directly, the ragdoll engages only after a hit | commit `401d802` |
| **2. Muscles** | the pose became a target, particles chase it on springs; balance, per-limb damage and fatigue grow from this | commit `00a6c7e` |
| **3. Panels on strings** | the torso holds firm, elbows and wrists nearly released; links inextensible. Two-segment limbs with IK | `bodyMode: 3`, commit `5043394` |
| **4. Solid bones** | current. Arm and leg are one part each, as on the pattern sheet. They cannot bend, and the whole gait grows out of that | branch `claude/solid-limbs` |

`bodyMode` in the settings switches 2 and 3 live; solid bones live in the
geometry and do not switch on the fly.

#### The fourth iteration: the solid bone

One rule: **the end of a bone is always exactly its length from the root.**
Not "roughly", not "pulled to the edge of reach" — exactly. Everything else
is derived from it.

It turned out there had been no solid bone in the body at all. Link lengths
were taken from the reference stance, and the stance was laid out by two-bone
IK, which dutifully bent the leg toward whatever target it was given: halves
of 0.360, but a hip↔foot link of 0.672 against the sheet's 0.720. Three
links of those lengths are not a segment but a rigid triangle with the knee
locked bent by 13 cm, plus two mirror solutions it clicks between.

**The support leg sets the pelvis height.** The hip-to-foot distance is
fixed, so an arbitrary pelvis height cannot be demanded: the solver would
shove the pelvis around the sphere of the nailed foot every frame, spherical
shoving has a sideways component, and it accumulates. That was where the
self-propulsion came from. The height is now computed from geometry, and the
vertical bob of walking comes free — the pelvis rises over the support and
dips at mid-stride.

**Pelvis tilt is computed, not chosen.** Each leg demands its own hip height,
the demands differ, the pelvis is one — so it must stand tilted, exactly so
both demands hold at once. Height is the mean of the demands, tilt is their
difference. Those two lines also give the heel-over onto the support leg:
the swing leg has no way to tuck, and only pelvis tilt gives it clearance.

**A step starts from intent, not from anchor lag.** With both feet planted,
two rigid legs to two nailed points leave the pelvis zero horizontal freedom:
it slides eight centimeters sideways and jams. The lift threshold never
arrives, and the fighter stands stuck, honestly trying to walk. Humans work
the same way — first you decide to step, and only then you fall into the
step.

**The swing leg's muscle is internal.** A muscle pulls a particle toward
a world target, so its force is external, taken from nowhere. While the leg
bent, the knee ate that force; a solid leg passes it straight into the
pelvis, and the fighter rode his own swing. A leg in the air has no support
and nothing to push from, so its momentum returns into the hip.

How it is measured:

| | before (build 63) | after |
|---|---|---|
| hip↔foot link | 0.672 against the sheet's 0.720 | 0.720 |
| standing self-drive | 0.14 m per 4 s | 0.01 m |
| standing pose-vs-leg mismatch | 7.7 cm | 0.0 cm |
| walking self-drive | 5.7 m per 6 s | none |
| body hops | up to 14 m | 5 cm |
| forward / backward speed | — | 1.5 of 1.7 / 0.90 of 0.94 m/s |

What the solid bone costs: the fighter does not walk sideways, he shuffles —
about a third of a meter per second against the ordered 0.85. In a side-step
the trailing leg must come under the body, and it may not cross the midline —
the panels would clip. No knees, and this is exactly their price.

#### The skeleton apart from the body

The body became a table of numbers (`docs/src/skeleton.js`), and everything
else derives from it: heights, masses, radii, link lengths, step width, the
reference stance. To fit a new build it must be enough to add a row to
`BODIES` — if anything else had to be touched, the separation failed.

The three bundled bodies are not decoration but a test: they differ on
purpose in what matters most to gait and balance — leg length and where the
center of mass sits.

| | leg | arm | height | weight | head |
|---|---|---|---|---|---|
| Cardboard doll | 0.72 | 0.54 | 1.81 | 70 kg | 21 kg |
| Beanpole | 1.02 | 0.43 | 1.99 | 45 kg | 9 kg |
| Shorty | 0.45 | 0.80 | 1.80 | 109 kg | 38 kg |

Gait distances had to become dimensionless (fractions of leg length), the
arm stance a direction from the shoulder rather than a point, and masses by
panel area rather than volume — a panel is hollow. What stayed shared across
bodies is per-joint muscle strength and the fractions splitting a limb's mass
across its particles: those are roles, not sizes.

#### Balance instead of a marionette

`docs/src/balance.js`. It computes the capture point — where the center of
mass will coast to by inertia — and compares it with the support beneath:
the segment between STANDING feet. Inside the support, torso correction is
enough; past its edge a step is needed, and a step exactly where the fall is
heading. This one pair covers a shove in the back, stopping from a run,
standing at the edge and the idle sway.

No formula knows the body's dimensions — they all come from the skeleton, so
balance dropped onto all three bodies without adjustment: all stand still
(1–3 cm drift over four seconds), all walk.

What remains: turning in place walks the fighter off by 0.6–1.2 m per eight
full turns. It is wandering, not drift — the direction differs run to run.

#### The knee: one bone outside, two inside

A limb is again two halves but reads as one piece: the trapezoid is cut in
the middle and spread by a gap, with the thread showing in the slot.

The contradiction between "the leg must stand as a strut" and "the leg must
bend on a step" is resolved by a limit link: longer is forbidden, shorter is
free. Standing, the fighter is straight and the leg holds as one bone
(measured: 0.0 cm from straight); the foot above the deck — the link lets
go, the knee bends (7.5 cm at a 20 cm rise); it never bends backwards.

There are no real steps on the arena yet — tested by raising a world anchor
point.

#### Smoothness

The first run with the knee showed shaking and mincing. Decomposed into
numbers: torso rocking fell from 20° at 2.5 Hz to 7–10° at 0.7–1.1 Hz, jerk
per meter of speed from 122 to 41, step rate from 7.7 to 5–6 at higher
speed, arm lag on turns from 2.9 to 1.3 cm.

The main findings: the pelvis tilt that used to carry the swing leg became
unnecessary with the knee; the support handover between legs must be
continuous, or the pelvis target jumps and the muscle answers with a jerk;
mincing is cured by step length, not speed.

The third iteration is not "muscles, but stiffer". It has a different idea,
straight from how a cardboard doll is glued: **a panel does not bend or
crumple; only the joints bend, and a string holds them.** Three consequences,
each of which had to be made explicit:

- **Links are inextensible** (`linkStiffness` is ignored). All of the body's
  give lives in joint angles, not panel lengths.
- **The far ends of the limbs are nearly released** — elbow and wrist hang
  on the string. That is exactly what gives the dangle from walking, turning
  and striking.
- **Arms are kept out of the torso** geometrically. The muscle cannot hold
  them out — there is barely any, that is the point — so the ban is
  separate: an arm does not come closer than `torsoClearance` to the
  pelvis↔chest axis.

The knee keeps a little strength after all: fully free, it bends backwards,
because the hip→foot chain folds equally well either way.

### I1.5 — The console: full, predictable control over the body

Inserted before I2 deliberately. Tuning balance and strikes without power
over the body and without seeing what the knobs do is turning them blind.

**Goal:** the fighter's shape and manner are set by a human hand, not a code
edit. Different builds — big, small, short-legged, long-armed — are
assembled with sliders and behave according to their shape.

#### What is impossible today, and why

Not "not done yet" — built differently, hence listed separately.

1. **The pose is symmetric by construction.** `guardOut` and `guardForward`
   are shared by both arms, step limits by both legs. Separate settings have
   nowhere to go: the pose formula has no place where left differs from
   right.
2. **Per-joint muscle strength is not exposed at all.** It lives as
   constants in `skeleton.js` — and that is exactly the knob that fixed limb
   dangle this iteration: the elbow was raised, the knee forgotten, and the
   legs flailed for three more builds.
3. **Weight does not affect posture AT ALL.** `muscleLift` compensates
   gravity one hundred percent, so a heavy body stands exactly as straight
   as a light one. Sagging under load does not exist as a phenomenon — it
   cannot be tuned, it must first be introduced.
4. **Proportions change only by editing code** — the `BODIES` table.
5. **There are ninety-two sliders already, and half of them interact.** This
   iteration showed where that leads: step length changes frequency,
   frequency changes double support, the speed cap breaks leg alternation —
   and none of it is written on the slider. Forty more knobs without
   feedback will bring less predictability, not more.

#### The work

**1. Feedback. Built first.**

A live panel section with the cycle's numbers: steps per second, double
support share, flight share, leg alternation, pelvis bob, each limb's lag
behind its target, stability margin, weight and sag. Turn a knob — see
immediately what happened to the gait.

First, because without it every other item is a blind knob. All of these
quantities are already computed in the measurement scripts; the work is
bringing them into the frame.

**2. A panel organized by body part.**

Groups: Walking · Turning · Torso · Head · Left arm · Right arm · Left leg ·
Right leg · Weight · Balance. Collapsible groups, a "mirror L↔R" button,
named setting presets next to the existing "Copy JSON".

**3. Separate limbs.**

A table of four limbs instead of shared fields. Each gets its own: tilt and
offset from the joint, muscle strength for its three joints, and legs also
their step limits. Symmetry becomes a button, not a property of the code.

This is the most expensive part: `computePose` will have to be rewritten so
both arms and both legs run through one function with a side parameter.

**4. Weight and sag.**

A "how much the leg can carry" parameter. The muscle compensates gravity not
fully but up to a limit: `muscleLift` stops being a fraction and becomes
load capacity. Overload — the pelvis settles by exactly what the legs could
not lift.

Much comes free from this: a big head gives a slouch, long thin legs buckle,
and "balance is muscle strength" from the roadmap's foundation gains
a physical meaning for the first time, because lost strength means lost
carrying capacity.

**5. A proportions editor.**

The same pattern-sheet cells as sliders: head, chest, pelvis, arm and leg
length and width, panel thickness, overall scale. Rebuild by button —
swapping links mid-frame serves nobody.

#### Done when

In five minutes of sliders you can assemble a short-legged giant and
a long-armed weakling; both stand still and both walk; and the panel's
numbers show what exactly distinguishes their gaits — in digits, not by eye.

#### What this iteration will NOT include

**Knobs for things derived from other things.** Step length is already
defined in fractions of leg length — a separate "step in meters" knob will
not appear, or the two will drift apart and the predictability this is all
for dies first. If some derived number begs to be turned directly, that is
a reason to revisit the derivation, not to add a second source of truth.

### I2 — Balance instead of an instant ragdoll

No health bars. Balance instead.

- Balance 0..1, hidden: read off the body, not off the UI.
- Spent on taking hits, missing with a heavy strike, blocking a heavy one,
  running, repeated dashes. Recovers slowly under careful play.
- Zero — muscles off, the fighter falls. Getting up costs balance.
- **A sparring partner:** a bot that approaches and strikes on a timer.
  Reuses the existing `SwingAction` and `Locomotion`; no combat logic of its
  own yet.

The bot is not a checkbox item: until somebody hits back, balance cannot be
felt out.

**Done when** a series of light hits rattles but does not topple; one heavy
hit topples; and the gait visibly swims.

### I3 — Reactions by hit location

A strike acts on the body part it landed on.

- Leg — buckles, the body loses support, tripping is possible.
- Arm — knocked aside, the strike is broken.
- Head — the body is shaken, brief instability.
- Torso — knocked back, balance dips.

The body never flies off as a whole: force spreads through the links.

**Done when** one glance tells where the hit landed.

### I4 — The strike arsenal

Exactly five actions, no combo systems.

| Input | Strike |
|---|---|
| LMB | medium: fast, safe |
| LMB hold | heavy: long recovery, full commitment |
| Wheel down | low, at the legs |
| Wheel up | high, at the head |
| RMB | block |

**Done when** every strike carries its own weight and reads from the
wind-up.

**Groundwork from the styles (build 173+):** three random manners already
exist, all from the right side — side, overhead, rising — with the pull-back
mechanic (an uncharged wind-up finishes inside the strike, so a click swings
the full arc with no arm teleport) and per-style hit character (the rising
scoop launches, the overhead slams harder). Shelved ideas to return to here:

- **The combo chain — tried, postponed.** A working
  "horizontal → backhand → overhead" chain with a 0.75 s window lives in git
  history (commit `2acfee2`, removed in `1cf3694`): too complex for the
  current pace. A candidate for heavy weapons (I7), where a slow tempo begs
  for sequences.
- **The backhand** exists only as part of a chain — opening with it from the
  stance reads unnatural (play-tested).

### I5 — The price of a miss, and timing

- Every strike has a category: the poke (fast, weak, safe, good for
  interrupting) and the commitment (slow, powerful, dangerous on a miss).
- A missed heavy opens a real punishment window. Heavy spam must not work.
- A fast hit into someone's wind-up interrupts, micro-stuns and drains
  balance. Not a random crit — only a consequence of correct timing.
- The bot learns both to poke and to commit.

**Done when** landing a hit into someone's wind-up feels earned.

### I6 — Body wear instead of health

The condition of every body part is its muscle strength.

- Leg — slower movement and dashes.
- Working arm — slower and weaker strikes.
- Torso — balance is easier to lose.
- Head — slower recovery, unsteady movement.

Plus overall fatigue: fresh → tired → exhausted. Fighting is possible in any
state — everything just costs more. Health never runs out; fighting capacity
does.

**Done when** by the end of a fight the fighter is visibly wrecked, without
a single number.

### I7 — Weapons

Start with fists; weapons lie on the arena. A weapon changes style, not
power:

| Weapon | Style |
|---|---|
| Club | balanced |
| Hammer | enormous commitment, monstrous knockback |
| Axe | faster, easier to interrupt |
| Spear | range, helplessness up close |

A hit on the wrist disarms; the weapon physically flies away.

> Starting with fists changes the character's identity — the game began with
> "the arm-club". To be confirmed when we get there.

### I8 — Movement as part of combat

- **Shift** — run: faster, but more inertia, worse turns, a costlier miss.
- **Space** — a dash along the input direction (W+Space forward, A+Space
  left). Spends stamina and drains balance when spammed.

### I9 — The match

Several bots, rounds, a victory condition, elimination. Without it
everything above stays a sandbox.

**Done and extended (build 174):** two modes behind one toggle.

- **Rounds** — the classic last-one-standing, a win/loss score.
- **Deathmatch** — Chivalry-style: death does not eliminate, the fighter
  respawns after a couple of seconds at a clear spot, the game is endless,
  the score is the goal.
- **CS-style kills** in both modes: down someone or drive them to the fall
  (a club hit, a ram topple, rolling a downed body to the edge) — the kill
  goes to whoever acted last within the credit window.

### I10 — Camera and sound

- The camera sits farther while many are alive, closer toward the finale,
  cinematic in a duel.
- It reacts to heavy hits, counters, falls and long knockbacks — amplifying
  the blow without distracting.
- Sound: impact, footsteps, sweep whoosh, the fall. Half the feeling of
  weight is sound. Can be pulled forward if weight is lacking as early
  as I1.

**Sound is pulled forward and done (build 176):** six effects synthesized in
Web Audio — sweep whoosh, impact, ram-topple thud, the drop whistle, respawn
blips, the kill ding. No files: the mixer watches the simulation and fires on
state edges.

---

## Acceptance

Not an iteration — the readiness bar for everything. A fight must fold
itself into a story like this, without a single scripted scene:

> A misses with a heavy → loses balance → B strikes the arm → the weapon
> flies away → B sweeps the leg → A falls → B shoves him off the arena.

## Principles

1. No health bars.
2. Balance over damage.
3. Timing beats clicking.
4. A miss is dangerous.
5. Body parts matter.
6. Every weapon has its own weight.
7. Mastery comes from physics, not randomness.
8. Simple controls, deep interactions.
9. The funny emerges by itself, out of simulation.
10. Competitive enough to grow in, clear enough to play at once.

---

## How the work is done

The whole roadmap is built in the browser. Unity is a separate porting task
for when the game plays end to end.

Each iteration: the game is run in Chromium, behavior is measured in numbers
rather than eyeballed, screenshots are sent before a change ships. The build
number is bumped via `docs/bump-build.sh` — the tag at the bottom of the
screen shows whether the change reached the browser.

## Differences from the first edition of this document

The order was reassembled because some items relied on code that did not
exist.

- **Balance moved from 4th place to 2nd.** Per-part reactions are
  meaningless while there is no state between "intact" and "ragdoll".
  Balance is that state.
- **The sparring bot was added to I2.** The original list had none, and
  without someone hitting back, balance cannot be felt out.
- **"Commitment vs poke" and "counter timing" were merged.** One defines the
  punishment window, the other what punishes; they cannot be tuned apart.
- **"Per-part damage" and "fatigue" were merged.** They are one mechanism —
  muscle strength degradation, local and global.
- **The match was added.** The original list had neither rounds nor victory,
  though the camera iteration already relied on "how many players remain".
- **Sound was added.** Half the feeling of weight is sound, and it was
  nowhere.
- **"Emergent combat" was removed from the iterations.** It is not a step —
  it is the acceptance bar for everything else.
