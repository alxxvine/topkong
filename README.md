# Top Kong

A top-down arena brawler. The fighter carries a heavy club and opponents fly
off the arena with real ragdoll physics.

There is no damage in the game at all. No health, no bars. The only goal is to
shove everyone else off a small round disc. Fall off — you're out. Last one
standing wins.

The project lives in two versions. **Web** — the working laboratory: opens from
a link on any device, every setting is a live slider right in the game.
**Unity** — what all of this will eventually be assembled into. The logic and
the setting names match on purpose, so anything found in the web version ports
back by substitution.

Where all of this is heading is in [ROADMAP.md](ROADMAP.md): the combat vision,
the muscle-driven body design and the ten iterations we move through strictly
one at a time.

---

# Web version

Lives in `docs/`, needs no build step: open the page and it runs.

- **Locally:** any static server from the repo root, e.g.
  `npx http-server docs -p 8080 -c-1`, then open `http://localhost:8080`.
  Double-clicking `index.html` won't work — browsers refuse to load
  ES modules from `file://`.
- **From a link:** GitHub Pages serves `main` + `/docs`. Enabled once:
  **Settings → Pages → Source: Deploy from a branch → Branch: `main` / `/docs`**.
  After that the page updates itself on every push.

The three.js library is **vendored into the repository**
(`docs/vendor/three.module.js`) rather than pulled from a CDN: Pages serves
static files, and an external dependency would mean the game breaks exactly
when the CDN is unreachable.

## Build number

The bottom of the screen says `build N`. It is the first thing to check when
a change seems to have not arrived: the number in the frame is the only way
to know which version a browser has actually loaded.

Pages serves files with `max-age=600`, and every module is cached
**independently**. On its own that would produce a mix of old and new files:
function signatures and bone names changed between versions, so the mix would
not crash — it would quietly misbehave. That is why all modules go through an
import map in `docs/index.html`, where each has its own versioned URL. The
number is bumped with one command and all URLs change at once — an in-between
state cannot exist by construction:

```
./docs/bump-build.sh
```

Inside `docs/src` the modules import each other by bare names (`tk/tuning.js`)
resolved by that map, so the sources themselves are untouched by a version
bump.

## What's already here

**This is already playable.** A brawl to the last: several fighters on the
arena, each with a club, fall off the edge — you're out, last one standing
wins, then a new round. Wins and losses in the HUD, kills counted CS-style.
A **Deathmatch** toggle switches to an endless mode where the fallen respawn
and kills are the score.

The opponents are bots (`docs/src/bot.js`). They have no physics and no pose
of their own: a bot writes exactly the same three fields as a live player —
where to walk, where to look, whether to hold the wind-up. That is not economy
but a test: if a bot ever needed something extra, the player's controls would
be built wrong.

It has three skills and picks between them by distance — to the opponent and
to the edge. The third one stands apart: **near the edge the bot drops
everything and heads for the center.** Without it, it would stubbornly walk
into a fight while standing heels-over-the-drop, and go down all by itself
without showing any fight at all.

The round is run by `docs/src/match.js`: countdown, brawl, result. Victory is
"at most one left", not "exactly one left" — a single blow can carry two
fighters off, and then nobody won.

## Controls

The service layer — counters, hints, the settings panel — is hidden by
default: the frame should show the game, not a dashboard. **H** brings it back.

| | |
|---|---|
| **W A S D** / arrows | walk, screen-relative |
| **mouse** | aim; the fighter turns toward the point |
| **LMB** | the base side sweep; hold to charge, release to strike |
| **wheel up / down** | instant overhead slam / rising scoop |
| **RMB** (hold) | block: a hit slides you back instead of toppling you |
| **Space** | a soft dash along the move direction |
| **H** | show/hide the settings panel and counters |
| **F** | slow motion: shows the arc shape and the moment of contact |
| **R** | reset the round |

## On a phone

Opens from the same link, nothing to install. A move stick appears on the
left (with a DASH button above it), an aim stick on the right with the strike
cluster next to it — HIT (hold to charge), ▲ overhead, ▼ rising, and a BLK
hold button. The widgets only show on devices without a mouse.

The frame fits itself to the screen. `camDistance` was tuned on a wide
monitor, and in portrait the arena was cropped on every side — while the whole
game is about the edge, which was exactly what you couldn't see. The
bottleneck is the horizontal field of view: it derives from the vertical one
through the aspect ratio and is half as wide in portrait. The camera now pulls
back exactly far enough for the whole disc to fit: about 36 m in portrait
versus 21 on a laptop or in landscape, where the base distance remains the
floor. The margin around the disc is `camFitMargin`.

On a narrow screen the settings panel moves into a bottom sheet so the top of
the frame stays visible while you drag a slider, and the touch widgets step
aside for it.

Verified with Playwright device emulation — with real touch input, not
a mouse: the stick drives, the charge builds, the aim turns the fighter.

## Sliders

The Settings panel sits in the top right corner. Values are read every frame,
so the result is visible immediately, and they persist in the browser — tuned
numbers survive a reload. **Copy JSON** exports the whole set to carry back
into `GameTuning.cs`.

## The body

Arms and legs are two-segment with real two-bone IK: the distance to the
target gives the base of a triangle, the segment lengths give the sides, the
pole decides which way the joint bends. Elbow out, knee forward.

The key consequence is not beauty but correctness: **a segment is always its
own length**, and an unreachable target is honestly pulled to the edge of
reach instead of pretending the arm got there. Before this, the arm was
a single capsule of constant length, the pose dragged the wrist anywhere it
liked, and in the guard stance the shoulder and the wrist were 1.13 m apart on
an arm 0.45 long — the capsule floated in between, touching neither.

For the same reason the pose specifies the position of the **grip**, not the
center of the club: the grip is the point the hands must reach, so it has to
be reachable. The club then seats itself into the actual hands and takes its
direction from its own jelly point — it keeps its lag and its weight, but it
can no longer separate from the hands.

And hence the **one-handed grip, always the right hand**. A club hanging low
cannot be held with both hands: the far hand can't reach it. While the grip
was always two-handed, the only spot both hands could reach was a point
exactly behind the back at center — and the club had to be carried there, in
an awkward hug.

The holding hand used to be picked by the sign of `grip.x`, i.e. it switched
with the side of the arc, and the weapon hopped from hand to hand after every
strike. The side is now fixed: the club hangs on the right, the arc always
goes from there through the aim to the left, and the second hand never comes
to the handle at all. The free arm swings at the hip in counter-phase with its
leg.

In the second half of the sweep the arm straightens to the edge of reach and
travels extended — that is not an IK glitch but the normal path of
a one-handed swing; the club stays in the hand. The club head's peak speed
(about 40 m/s) lands in the first third of the arc, exactly where it passes
through the aim.

## Physics: a body on muscles

The body is simulated **always**. There is no split into "controlled" and
"ragdoll": Verlet particles with distance links hold the skeleton, and the
pose is held by muscles — springs pulling every particle toward its target
(`docs/src/body.js`).

`computePose` stopped writing bones and became the **target**. The pose used
to be the result; now it is the assignment, and the result is earned by
physics. Half the roadmap grows out of this single mechanism: balance is
overall muscle strength, per-limb damage is that limb's muscle strength,
fatigue is its recovery rate, falling is strength that reached zero. Getting
up off the floor is no longer separate code: the muscles refill with strength,
their target is still "stand", and the body raises itself.

The controls are protected by the root staying authoritative: input moves the
target instantly, the body catches up. It is the picture that lags, not the
response — exactly what the Unity version lacked, where the drives fought
PhysX.

Two details without which the scheme does not work, both paid for in
debugging:

- **The target's height reference is deck level, not the current pelvis
  height.** Tying it to the body is tempting, but then the target slides down
  with the sagging pelvis, no restoring force remains and the fighter folds
  onto the floor.
- **The damper kills velocity relative to the target, not absolute
  velocity.** An absolute one braked the whole body like molasses and ate 43%
  of the speed per step: locomotion ordered four meters per second and got
  seventeen centimeters.

## Body firmness: two knobs instead of one

Softness was stuck because one muscle stiffness answered for two things at
once. Measured by sweep: at stiffness 900 the torso gave 2.9 cm, at 200 it
gave 9.8 — but the pelvis sagged from 0.85 to 0.74 along with the softness.
Decoupled with two changes:

- **A muscle carries its own weight** (`muscleLift`). The compensation goes
  through `strength`, so a downed fighter loses it and honestly falls. The
  pelvis stays put across the whole stiffness range; the knobs are
  independent.
- **The damper is a fraction of critical**, not an absolute number. One means
  arriving at the target without overshoot; less overshoots and oscillates.

A separate sweep finding: **link softness (`linkStiffness`) decides almost
nothing while the muscles hold the pose** — the sag changes by half
a centimeter between 1.0 and 0.35. The links simply aren't loaded. Their
domain is the fall, when the muscles are released.

### Why the cardboard doll's muscles are stiff

Soft muscles suited a solid soft body. On the cardboard doll a panel is drawn
over its bone, and the bone stands where the particle ended up: fall short and
the panels drift apart and clip into each other. Measured at stiffness 200:
the wrist trailed its target by 11 cm, the elbow by 8, and the body visibly
crumpled while walking and turning. At 700 that is 3.5 and 2.4 cm.

We do not go above 700, and that too was found by measurement, not caution.
At 1400 a stiff leg on a foot nailed to the deck starts working as a lever,
the body rolls over it, and the fighter **drives off on his own**: 6 meters
while standing still, accelerating to 4.8 m/s with 1.6 ordered.

The head and shoulders stay soft: they form no long chains, there is nothing
for them to break, and all the liveliness of the torso rests on them.

## The parts hang on a thread

Panels are shorter than their bones by a gap at each end — body parts do not
hang flush. At a bend they stop driving into each other, and in the gap you
can see the glowing thread everything hangs on.

The thread runs the full length of every bone, not in patches at the joints:
the panels cover it almost everywhere, and it shows exactly in the gaps.
No code decides where to display it — the geometry does that by itself. It is
drawn as additive glow without writing to the depth buffer, so it shines
through and never argues with the panels about who is closer.

The panel helper validates sizes as numbers. Not paranoia: a lost setting
arrives in geometry as NaN, and NaN is not a console error but a silently
vanished part. That is exactly how every panel disappeared at once when
`partGap` didn't make it to `tuning.js` — with a perfectly clean console.

## The body: a cardboard doll from a pattern sheet

The fighter is assembled from flat trapezoids — one panel per bone. The sizes
are taken **directly off the pattern sheet** and converted to meters by
a single multiplier `CM`, declared explicitly in `fighterRig.js`: a five on
the drawing is `5 * CM` meters, never "roughly the same". The drawing and the
code are compared by eye.

| part | drawing | meters |
|---|---|---|
| head | 5 × 5 | 0.60 × 0.60 |
| torso | height 3, width 3 → 2.2 | 0.36, 0.36 → 0.264 |
| thigh | 3, width 3 → 2.5 | 0.36, 0.36 → 0.30 |
| shin | 3, width 2.5 → 2 | 0.36, 0.30 → 0.24 |
| arm | 5, width 2 → 1.5 | 0.60, 0.24 → 0.18 |

The height comes to 14 cells: leg 6 plus torso 3 plus head 5, i.e. 1.84 m.

Two things had to be invented, and they are marked in the code: **panel
depth** (a flat pattern sheet has none at all — taken as about one cell from
photos of assembled dolls) and **splitting the arm's five** across our two
segments, divided in half.

A panel is built as a four-sided "cylinder": with four segments its faces are
exactly a box's, and different top and bottom radii give the trapezoid for
free — no custom geometry needed.

One correction against the literal drawing: the head on it is wider than the
torso, five cells versus three, and with a narrow stance it hides the arms
completely from the front. The hands are spread outside its silhouette.

Before this there was an attempt at a seamless body — a distance-field shell
skinned onto the bones. It worked, but looked like the wrong thing, and was
removed along with its whole layer. On a cardboard doll the seam at a bend is
not a flaw; it is what the doll is made of.

## A step with real support

The feet used to live in the pelvis frame: their target was a formula of the
step phase and drove off with the body. There was no support at all — the
pelvis slid, the feet dragged behind, and the step cycle was cosmetics over
sliding. Measured: **87% slippage** — the support foot traveled almost the
whole path of the body.

Now every foot has a world anchor point, and while the foot stands, that
point does not move: the body passes over it (`docs/src/gait.js`). Lift-off
is by a distance threshold, not a schedule, and that one rule covers walking,
turning in place, side-stepping, stopping and recovering from a shove all at
once.

Four things the scheme would not work without, each paid for with
a measurement:

- **The anchor is limited by leg reach.** Hip at 0.81, leg 0.82 — about 0.41
  horizontally. The first version simply multiplied speed by step time and
  carried the anchor 64 cm out; IK dutifully pulled the unreachable target to
  the reach boundary, and the foot slid with the body again.
- **Lag is measured along the direction of travel, signed.** The foot plants
  a third of a meter AHEAD, and to an unsigned threshold it is instantly
  "far" — the leg begged to step again right after landing.
- **A landed foot grips**: its horizontal velocity is killed. Otherwise it
  arrives at full swing speed and keeps going — measured: planted at 2.58,
  drifted to 2.71.
- **A standing foot becomes heavy for the solver.** The knee link is stiffer
  than the muscle, and correction splits inversely to mass: the light foot
  took more than half and rode off with the body. Now the displacement goes
  to the knee — which is the thing that is supposed to bend.

Speed is derived from the same geometry: the body advances 0.34 m per step;
a human does 0.37. Sideways and backwards the fighter is slower — with
a side-step the foot cannot go far: reach blocks the outside, the other leg
blocks the inside.

What remains: 17% slippage while walking and 0% standing.

## The skeleton apart from the body

The doll's proportions used to be scattered as constants across four files:
panel sizes in the rig, masses and radii in physics, step width in the gait,
link lengths in the reference stance. Fitting a different build onto the
skeleton meant walking all four and forgetting none of the twenty-eight
links.

Now a body is a **table of numbers** (`docs/src/skeleton.js`) and everything
else derives from it: heights, masses, contact radii, link lengths, step
width, reference stance. The test is strict: to add a new body it must be
enough to add a row to `BODIES`. If anything else had to be touched, the
separation failed.

| | leg | arm | height | weight | head |
|---|---|---|---|---|---|
| Cardboard doll | 0.72 | 0.54 | 1.81 | 70 kg | 21 kg |
| Beanpole | 1.02 | 0.43 | 1.99 | 45 kg | 9 kg |
| Shorty | 0.45 | 0.80 | 1.80 | 109 kg | 38 kg |

Switched with buttons in the settings panel (the page reloads: a body changes
link lengths and panels, and swapping those mid-frame would mean rebuilding
the fighter on the fly).

What had to become dimensionless for this to work:

- **Gait distances — in fractions of leg length.** A 15 cm step would be
  a shuffle on the beanpole with its meter-long leg, and a split on the
  shorty with a 45 cm one.
- **The guard stance — a direction from the shoulder, not a point.** The arm
  is a solid piece; the hand will land exactly one arm-length from the
  shoulder anyway; only the direction is meaningful.
- **Masses — by panel area, not volume.** A panel is folded cardboard, it is
  hollow. By volume the shorty's head (a 60 cm cube) would take more than
  half the body's weight; by area it comes to a third.
- **What stayed shared between bodies:** per-joint muscle strength and the
  fractions that split a limb's mass across its particles. Those are roles,
  not sizes: on any doll the torso holds firm and the far ends of the limbs
  are relaxed.

## Balance instead of a marionette

"Standing upright" used to rest on one thing: muscles pulled every particle
to its target and the target was at the right height. That is not balance,
that is a marionette on strings — the body stays up because it is held up,
not because it stands.

`docs/src/balance.js` computes what balance actually depends on.

**The capture point.** Falling starts not when the center of mass leaves the
support, but earlier — when the point the center will coast to by inertia
leaves it:

```
capture point = center of mass + velocity / sqrt(g / height)
```

Lean while standing — you hold; lean while walking — you fall, though the
center of mass is in the same place both times. Only this formula sees the
difference, and no angle threshold can replace it.

**The support** is the segment between STANDING feet, inflated by the leg's
cross-section. The swing leg holds nothing, and that is no small print:
exactly when it is in the air the support is half as wide, and that is when
the fighter goes over.

Both strategies fall out of this at once, with no separate rules: inside the
support — torso correction; past its edge — a step, and a step exactly where
the fall is heading. The same two cover a shove in the back, stopping from
a run, and standing at the arena's edge.

Three things cost a measurement:

- **The center-of-mass velocity must be smoothed.** The swinging leg and
  flailing arms are part of the center; a landing foot grips the deck and its
  velocity is killed in one step — the center twitches, and the capture
  point, where velocity is divided by a small number, twitches tenfold.
  Unsmoothed, it jumped 42 cm outside the support on a fighter standing
  still, and he started stepping in place.
- **The goal is not "over the support" but "where you are heading".**
  Walking is controlled falling: a walker is falling forward the whole time.
  Demanding the capture point stay over the support means demanding he stand
  still — measured, speed dropped from 1.49 to 1.00 m/s, the faster the gait
  the worse. The ordered velocity enters the goal through the same pendulum
  formula, so at steady walk the error is zero.
- **Losing balance means falling where you did NOT intend to go.** Along the
  intent the gait steps fine on its own; what needs catching is what goes
  sideways or backward. While the catch fired on any excursion, it was active
  78% of walking time, drove the step rate to its cap and made the steps
  tiny.

**The sway is real.** The center of mass slowly and randomly drifts off the
support and the body actually catches itself — it is not cosmetics over
a pose. The drift is scaled by the STEP THRESHOLD, not the foot width: that
is exactly how far the body is allowed to wander before the gait starts
stepping. It was first scaled by the foot — and the shorty, wide foot and
short leg, swayed at a third of his threshold, chased himself off the spot
and stepped twice a second while standing with no input.

No formula knows the body's dimensions: leg length, head weight and foot
width enter as numbers from the skeleton. That is why balance dropped onto
the beanpole and the shorty without a single adjustment — all three stand
still (1–3 cm drift over four seconds) and all three walk.

## The knee: one bone outside, two inside

A limb is again two halves but still reads as one piece: the trapezoid is cut
exactly in the middle and spread by a gap, with the thread showing in the
slot. The width at the cut is the mean of the ends, so fold the halves back
together and you get the original part.

The cut is not cosmetic. While the part was single, the hip-to-foot distance
held rigidly and the fighter physically could not step onto anything above
the deck. But the stiffness cannot simply be dropped either: the whole
stability stands on it — the pelvis hangs on the leg's length, the leg works
as a strut.

The contradiction is resolved by a **limit link**. It only holds from above:
longer is forbidden, shorter is free.

- Standing, the fighter is straight, the link is taut and works as one solid
  bone. Measured: **the leg is 0.0 cm short of straight**, the pelvis at the
  same height as the reference stance.
- The foot ended up higher (a step, a bump, someone's leg) — the distance
  shrank, the link let go, the knee bent. Measured on a raised anchor: at
  10 cm it bends 1.7 cm, at 20 cm it bends 7.5 — and the fighter stands in
  both cases.
- The knee never bends backwards: the link won't let it spread past
  straight.

There are no real steps on the arena yet, so this was tested by raising
a world anchor point — physics does not care where it came from.

Two things had to be fixed right after, both because a rigid link used to
hold them, not a muscle:

- **The knee and the elbow got more strength.** Swept by measurement: at 0.3,
  0.5, 0.85 and 1.2 the standing leg is equally straight, but on the step the
  knee bends 4.3 cm at 0.5 and only 2.9 at 1.2 — a joint too strong defeats
  the very thing the cut was made for.
- **The wrist too.** The bone itself used to hold it out; now it can drift
  inward, and the elbow breaks sideways out of nowhere: the square root's
  derivative at zero is infinite, a seven-millimeter shortfall shoves the
  joint four centimeters sideways, and the arm visibly kinks where it is in
  fact almost straight.

The panel gap was also halved: there are four times as many cuts now, and
with the old gap a leg read as a stack of bricks, not a trapezoid with
a slot.

## The camera is isometric

Orthographic projection at a fixed angle. There is no perspective anymore,
and it is not stylization for its own sake: in perspective, identical
fighters at opposite ends of the arena are different sizes, and verticals
keel over harder the farther they are from the frame's center. Both interfere
with reading the only thing that decides anything in this game — who stands
where relative to the edge. Orthography shows everyone the same.

The angle is classic: tilt **35.264°**, turn **45°**. The first number is not
invented — it is arctan(1/√2), the exact tilt at which a cube's three axes
meet the screen at equal 120°. Hence the look of a column with three faces,
each its own lightness.

Orthography has no dolly: distance does not affect the image at all; the
frame size is set directly by its bounds. So instead of "how far to pull
back" the code computes "how wide a frame to take" — with headroom above for
the fighter's height (`camHeadroom`), otherwise the disc fits and the head
pokes out.

Verified that ray-aiming from an ortho camera works: the four screen corners
give four distinct deck points, and the fighter's turn follows the mouse
(45°, −55°, −121° at three positions).

## The arena is a well

The arena is not a disc but a pipe running down and dissolving into the void.
A flat disc a meter thick read as a tabletop, and falling off it looked like
falling off a table.

There is no edge outline and no circles on the deck, and both left for the
same reason: they were crutches under the flat disc. Without hints it lost
both where the footing ends and how far away that is.

On the well, geometry does that work. The top is lit from above and almost
white, the wall falls into shadow and dissolves — the boundary between them
IS the edge, visible as a change of lightness, not a drawn line. An outline
on top of that read as foreign: the only black contour in a frame where
everything else lives on half-tones.

One consequence surfaced immediately: **the void must be noticeably darker
than the deck.** When they differed by two percent, the far edge of the disc
vanished entirely — white on white, half the arena invisible. With the line
gone, the lightness gap had to grow.

The well's wall is NOT lit at all. While it was a regular material, its shadow
side picked up cool sky bounce and warm fill, with the fade to background
layered on top — instead of a clean gradient you got murky grey, different
around the circumference. Unlit, exactly one vertical ramp remains, from the
rim into the void. The column's shape survives: it is defined by the top
face's lightness against the wall, not by shimmer on the wall itself.

The dissolve is a fragment-shader patch, not a separate shader. Two things
there cost debugging:

- **It must key off world height, not camera distance.** Fog would tint the
  near and far rim alike, and the need is the opposite: the deeper, the less
  visible, no matter where you look from.
- **The void color must be in sRGB.** It is mixed in after the color-space
  conversion, and the working linear color gave a noticeably darker grey: the
  wall faded to not-the-background, leaving a dense wedge with a hard bottom
  edge — you saw geometry, not a drop.

The wall fades out within a few meters of the rim (`arenaFade`), not over the
pipe's full depth: the pipe goes far down, but it must vanish right away.

## The look: a light matte scene

A dark arena with a glowing orange rim read as an arcade cabinet. The current
approach is the inverse: nearly everything is almost white, surfaces differ
by half a tone, and only the figures speak in color. The eye catches
a fighter's silhouette and the line of the edge — exactly what the game is
made of.

What stands behind it besides the palette:

- **The void is lighter and cooler than the deck, not darker.** On a dark
  background the edge read as a glowing strip, i.e. a hint; on a light one it
  reads as a drop — which is what it is. They must differ decisively: when
  deck and background were half a tone apart, the disc looked painted on
  a table.
- **Light from almost everywhere.** The fill does nearly all the work; the
  directional light only adds the shadow that tells where a body is relative
  to the deck. The old scheme was the inverse — weak fill and a hard key —
  and the doll looked not like a toy on a table but a figure in a back
  alley. Overdo it the other way and the fighter floats over the arena,
  anchored to nothing.
- **Neutral tone mapping instead of filmic ACES.** ACES pulls toward contrast
  and tints the highlights; on a dark scene that helped, on a light matte one
  it eats exactly the half-tones the scene stands on.
- **The interface is glass, not a panel.** A translucent blurred layer with
  saturation boost, rounded corners, the system font, a blue accent instead
  of orange. The HUD got its own card: on a light scene a drop shadow under
  letters doesn't save legibility, it needs its own background.
- **The weapon matches the scene.** Light ash and matte graphite instead of
  dark wood with a black head: the old club was the darkest patch in the
  frame and pulled the eye off the fighter onto itself.

## Kinematic walking: the first iteration returned as a mode

`bodyMode: 1`. The pose writes the bones directly; physics engages only when
the fighter is knocked down.

The real muscle-driven gait is livelier, but its cycle is assembled from
a dozen arguing numbers — step length changes frequency, frequency changes
double support, the speed cap breaks leg alternation — and to the eye it
reads as fidgeting. The kinematic one is drawn outright: the step cycle is
a formula of phase, and the phase spins faster the faster the fighter moves.

What that means in numbers:

| | physical (`bodyMode: 3`) | kinematic (`bodyMode: 1`) |
|---|---|---|
| forward speed | 0.75 of 1.3 m/s | 1.30 of 1.30 |
| strafe / backward | 0.32 / 0.73 | 0.67 / 0.71 — exactly as ordered |
| pelvis path vs displacement | 1.43 vs 0.80 | 1.29 vs 1.29 |
| pelvis bob | 10.8 cm | 3.0 |
| drift during turn-in-place | 0.7 m per eight turns | 0.00 |
| link stretch | 0.7 cm | 0.0 |

The feet have no world anchors, slippage exists — that is the price of
predictability. Physics does not go anywhere: the particles settle into the
pose every frame and stand ready, so a knocked-down fighter is picked up by
physics from the very pose he was in, and no transition code had to be
written. Fall and rise — 3.3 s, as before.

Switched live with the `bodyMode` slider: 1 — kinematics, 2 — muscles, 3 —
panels on strings.

## Why the limbs flailed

Three causes, and not one of them was the one I suspected.

**The foot flew two-to-five times higher than ordered.** The pose pulled an
unreachable anchor not horizontally but up the sphere around the hip. On an
overshoot the leg kicked up almost to the waist — measured, the foot rose
36 cm with 6.5 ordered. Now an unreachable target is shortened horizontally
and keeps the height the gait gave it.

**The knee stayed three times softer than the elbow.** The elbow got its
strength raised when the arms flailed — the knee didn't. So the arms stopped
flailing and the legs kept going. They now match.

**The turn ran at 420 degrees per second** — more than a full turn. Legs
can't keep up with that: the anchor slides sideways along the arc faster than
the fighter can re-step, and he spins while endlessly shuffling. It is 220
now.

## Why the fighter drifted on turns

The drift came from the **balance torso correction**, and not by force but by
formula: it aimed at the NEAREST point of the support, which itself chases
the error. The center of mass moved — so did that point, the error stayed,
and the correction kept pushing the body the same way. During a turn, where
the support also re-plants every third of a second, this integrated into
steady drift.

Measured: with the correction the drift was 1.64 m per eight turns, without
it 0.23. Aiming at the support's center left 0.74; halving the correction
strength removed some more. It is not fully cured — see below.

## What makes a gait a walk

For a long time the wrong thing was being fixed. Averages were smoothed —
torso sway, jerk, arm lag — and they all duly improved while the gait still
didn't read as walking. Because the defect was not in the averages but in the
STRUCTURE OF THE CYCLE, and it could only be seen by looking at the cycle
whole.

What distinguishes walking from running is **double support**: part of the
cycle both feet are on the deck. Without it, it is running, however slowly
the legs shuffle. Measured on what already seemed decent: **1% double
support, and 22% of the time the fighter was airborne on both feet**, with
lift-off intervals jumping from 70 to 217 milliseconds. That was the whole
"oddness".

It is fixed with three numbers, all three about the cycle, not smoothing:

- **Step length.** Full anchor throw (`stepReach + stepTrigger`) raised to
  0.78 of leg length. A human's step is also about 0.78 of leg length — the
  match is no accident, the geometry is the same.
- **Swing duration.** This is what tunes double support: while one leg is in
  the air, the other carries the body alone. A swing of 0.34 gives 32% double
  support and a ragged rhythm; 0.20 gives 62% and a steady one.
- **The speed cap.** The old 1.7 m/s for a 72 cm leg was a run. The cap must
  match what the legs deliver: raise it and locomotion drives the core faster
  than the legs re-plant — measured, the fighter started stepping with the
  same leg twice in a row.

Now: **2.7–3.3 steps per second, double support 51–59% of the cycle, no
flight, legs alternate**. Speed around 0.75 m/s is the price of true walking,
and the cap remains a slider.

## What makes a gait smooth

The body shook and the fighter minced. Both complaints decomposed into
numbers, and each turned out to be its own thing.

**Pelvis tilt is no longer needed.** While there was no knee, the only way to
lift the swing foot was to heel over onto the support leg, and the pelvis
duly tilted every step. With a knee the swing leg tucks itself, and the
raised foot's opinion of pelvis height is no longer counted. Measured: torso
rocking went **from 20° at 2.5 Hz to 7–10° at 0.7–1.1 Hz**.

**The support handover must be smooth.** Flipping a leg's opinion at the
instant of lift-off means a step-change in the pelvis target, and a muscle
answers a step with a jerk: that was exactly the per-step shudder. But
stretching the handover over the whole lift height is wrong too — half the
raised leg's opinion reaches the pelvis and the rocking returns. The
handover is sharp but not instant: a foot a centimeter off the deck already
carries nothing.

**Mincing is cured by step length, not speed** — but truly cured only
together with the speed cap, see the section above.

**The balance catch must not meddle in normal walking.** It fired 42% of the
time and drove the step rate to its cap. The threshold was doubled — now
0–1%.

**A landing foot is not stopped instantly.** Zeroing velocity in one frame is
a discontinuity: the foot flies at full swing speed and next frame stands
dead, and the leg's link passes the jolt into the pelvis. 70% is absorbed;
friction and the muscle chew the rest. Slippage did not grow (3.5 cm vs 3.3)
and the jerk dropped.

**A soft arm is not ragdollness, it is commotion.** On a turn the wrist
trailed its target by 10–13 cm and whipped its end around the body; walking,
up to 21 cm. Wrist and elbow muscles were raised, the swing halved. Swept by
measurement: at 1.2 the lag falls to 1.3 cm on a turn; at 1.6 the arm is
already nearly rigid and no play remains at all.

| | before | after |
|---|---|---|
| steps per second | 7.7 at 1.18 m/s | 5–6 at 1.3–1.7 m/s |
| torso rocking | 20° at 2.5 Hz | 7–10° at 0.7–1.1 Hz |
| jerk per meter of speed | 122 | 41 |
| same during a turn | 80 | 16–20 |
| arm lag on a turn | 2.9 cm, up to 13 | 1.3 cm, up to 8 |
| strafe speed | 0.55 m/s | 1.11 |

A side effect: the pelvis path per frame almost matched its displacement
(1.29 vs 1.04 forward, 1.14 vs 1.11 sideways). The path used to be half again
as long — that difference was the visible side-to-side thrashing.

## A gait on solid bones

Arm and leg are one part each, as on the pattern sheet. They have nowhere to
bend, and from that single fact the whole gait had to be rebuilt: what was
a trifle for a bending leg is a wall for a straight one.

**At first there was no solid bone in the body at all.** Link lengths are
taken from the reference stance, and the stance was laid out by two-bone IK —
which dutifully bent the leg toward the target it was given. Halves of 0.360,
but the hip↔foot link at 0.672 against the sheet's 0.720. Three links of
those lengths make a rigid triangle with the knee locked bent by 13 cm, plus
two mirror solutions it clicks between. The IK was deleted outright: while it
stayed in the file, it kept being used.

**The support leg sets the pelvis height.** The hip-to-foot distance is fixed
— demand a different pelvis height and the solver starts shoving it around
the sphere of the nailed foot every frame. Spherical shoving has a sideways
component and it accumulates: that was the source of self-propulsion. The
height is now computed from geometry, and the vertical bob of walking comes
free — over the support the pelvis rises, at mid-stride it dips.

From the same sphere came **the most expensive small thing of the whole
investigation**: the foot's deck contact radius was 0.10 while the pose put
it at 0.054. The nailed foot ended up 4.6 cm above its target every frame,
the muscle pulled the body down, the deck pushed the foot up — and all of it
resolved sideways. Matching those two numbers cut standing self-drive from
0.14 m to 0.01 and the mismatch from 7.7 cm to zero.

**Pelvis tilt is computed, not chosen.** Each leg demands its own hip height,
the demands differ, the pelvis is one — so it must stand tilted, precisely so
both demands hold at once: height is the mean of the demands, tilt is their
difference. Those two lines also give the whole waddle. The heel-over is not
for looks: the swing leg has no way to tuck, and only pelvis tilt gives it
deck clearance. The response exceeds the request — the foot rises three
times higher than ordered.

**A step starts from intent.** With both feet planted, two rigid legs to two
nailed points leave the pelvis zero horizontal freedom: it slides 8 cm
sideways and jams, while the lift threshold is 18 — never reached. The
fighter stood stuck, honestly trying to walk. Humans do exactly the same:
first you decide to step, then you fall into the step.

**The swing leg's muscle is internal.** A muscle pulls a particle to a world
target — its force is external, taken from nowhere. While the leg bent, the
knee ate that force; a solid leg passes it straight into the pelvis, and the
fighter rode his own swing. A leg in the air has no support and nothing to
push against, so its momentum is returned into the hip.

**Sag is positive feedback and must be capped.** The anchor slid — the
pelvis target is lower — the muscle pulls down — the straight leg turns
falling into forward motion — the anchor slides further. Uncapped, this gave
3.5 m/s with 1.7 ordered and three-meter body hops. The cure is a short step:
a full anchor throw of 0.25 at leg 0.72 dips the pelvis 4.5 cm; a throw of
0.42 already 13.5 — and there sits the breakdown.

| | before (build 63) | after |
|---|---|---|
| hip↔foot link | 0.672 against the sheet's 0.720 | 0.720 |
| standing self-drive | 0.14 m per 4 s | 0.01 m |
| standing pose-vs-leg mismatch | 7.7 cm | 0.0 cm |
| walking self-drive | 5.7 m per 6 s | none |
| body hops | up to 14 m | 5 cm |
| forward / backward speed | — | 1.5 of 1.7 / 0.90 of 0.94 m/s |

The price paid: the fighter does not walk sideways, he shuffles — about
a third of a meter per second against the ordered 0.85. In a side-step the
trailing leg must come under the body, and it may not cross the midline, the
panels would clip. There are no knees, and this is exactly what that costs.

What did NOT work, so nobody tries again: fitting step length to speed. The
step rate adapts by itself and the speed stays the same — shortening the
backward step threefold did not change backward speed at all, while the side
speed fell fourfold.

## Torso twist

The shoulder girdle is rotated relative to the pelvis — a degree of freedom
the body at first did not have at all. Without it the torso turned as one
solid brick: measured, over a 180° turn the shoulders left the pelvis by
3.6°, walking by 5.9°. That is what made the body read as wooden.

The twist is a sum of four independent inputs: the shoulders lag the turn
while the head runs ahead of it; walking swings the shoulders in
counter-phase with the legs; a strike is led by the torso, not one arm; at
rest, breathing remains. Currently it is 22° walking, 18° turning and 29° on
a strike — the last overshooting the target, because the club carries it
through on its own mass.

**Rendering** had to be fixed separately: chest and head rotation came from
`aim(head − chest)` — a nearly vertical vector — so rotation around it stayed
undefined. The chest carries the shoulder spheres, the head carries the face
— and they froze in world coordinates. The fighter turned 180° while the
face and shoulders kept pointing exactly where they had before. A bone now
receives a full basis (`fighterRig.orient`): the vertical from the bone
chain, the lateral axis from the line of the shoulders or hips.

## Structure

```
docs/
├── index.html
├── vendor/three.module.js
└── src/
    ├── main.js          scene, loop, spawn, effects
    ├── tuning.js        every number — GameTuning.cs counterpart
    ├── mathx.js         Mathf: clamp, lerp, noise
    ├── arena.js         disc, rim, light, fog
    ├── cameraRig.js     fixed-angle camera
    ├── fighterRig.js    body geometry and pose — FighterRig.cs port
    ├── poseDriver.js    target pose: stance, step, strike arc
    ├── swingAction.js   strike timeline        — SwingAction.cs port
    ├── locomotion.js    intent: core velocity and turn with inertia
    ├── body.js          physical body: Verlet, links, muscles
    ├── fighter.js       bones, muscle strength, hits
    ├── bot.js           opponents: same three input fields as the player
    ├── match.js         rounds and deathmatch, kills
    ├── contact.js       body-vs-body: shove, ram, graze, roll
    ├── sound.js         synthesized audio, no files
    ├── input.js         keyboard, mouse, touch
    └── ui.js            HUD and settings panel
```

## What the move to the browser bought

The whole Unity part was written blind: I cannot run the editor in my
environment and only checked syntax. In the browser the game runs right where
I work, and the very first run found three things that would otherwise have
shipped unverified:

- **Ragdoll damping was applied per step, not per second.** At 120 Hz
  a knocked-down fighter lost all his speed in tenths of a second and fell
  right where he stood.
- **Deck friction was applied inside the solver loop** — six times per step.
  The ragdoll stuck to the floor instead of rolling toward the edge.
- **`minImpactSpeed`/`maxImpactSpeed` sat below the working range.** The club
  head crosses 50 m/s mid-sweep with a cap of 24 — every touch counted as
  maximal and there was no difference between the start of the arc and its
  tail.

---

# Unity version

## How to run

1. Unity Hub → **Add** → **Add project from disk** → pick this repository's
   folder.
2. Open the project. If the Hub says the version differs — agree to open with
   yours, that is fine (`ProjectSettings/ProjectVersion.txt` says 6000.0.32f1).
3. Press **Play**. From any scene, even an empty one.

No scene to open, nothing to place. The arena, light, camera, fighters and UI
are assembled by code at startup — the project has not a single prefab and
not a single binary asset, only scripts.

If you want the game to live in its own scene (handy: settings visible in the
inspector before Play) — **Tools → Top Kong → Create arena scene**.

## Controls

| | |
|---|---|
| **W A S D** or **arrows** | walking. Always screen-relative: W is up |
| **mouse** | aim. The fighter turns toward the point |
| **LMB** | hold — wind up, release — strike. Held longer hits harder |
| **R** | new round |
| **Esc** | release the cursor, **click** — recapture |

The aim ring is visible on the arena, with a thin line from the fighter to
it. The line matters more than the ring: the ring shows where the mouse is,
the line shows where the fighter is turned.

Aiming is absolute: the cursor's screen position maps one-to-one to a world
point. Nothing accumulates, the "zero" does not drift after a series of
strikes. The system cursor is hidden and confined to the window — the ring is
drawn instead.

The strike is discrete. At rest the club **drags behind the back** — one look
at the pose says the fighter is not ready to hit. Hold LMB and he raises it
from behind, the higher the more charge, leaning back. Release — he sweeps it
in an arc through the aim. The arc side alternates.

The core combat decision comes from this: **full speed belongs only to the
one who is not charging.** Club raised — you walk half as fast, but you are
ready to strike. An uncharged strike is about half as strong as a full one,
so button-mashing does not pay either.

## How it works

**The body lives in two modes.** Under control the fighter is kinematic:
a character capsule moves, and the body's pose — stance, step, strike arc —
is computed every frame. At the moment of a hit the bodies turn dynamic and
continue from that very pose with real physics. The whole ragdoll is saved
for what it is for: the flight off the arena.

It was not always so. At first the body was physical at all times and the
strike emerged from how the player moved the mouse — an idea from VR, where
the player has a real hand with real velocity. A mouse has no such hand, and
the controls fought the physics the whole way: turning came out viscous, the
wind-up rocked the torso, and the result could not be predicted. Together
with that scheme the code lost the under-pelvis suspension, the vertical PD
controller and the physical get-up — they existed only to hold a ragdoll
upright.

**The strike is a script, not physics.** Hold LMB and the fighter draws the
club back, building charge; release and he sweeps it along an arc in fixed
time. Not a single coefficient to guess: the timing is exactly what is set.

The hit force is honest nonetheless — it comes from the club head's speed,
measured by its per-frame displacement. A fast sweep hits harder than a slow
one, full charge harder than partial.

**A fallen fighter always gets up.** After lying a moment, the ragdoll
returns to the stance by interpolation over `standUpTime`. That is
a guarantee, not a hope for lucky coefficients: the get-up used to be
physical, and there was always some pose it could not rise from.

**The body is jelly, but the control is firm.** The key pose points — pelvis,
chest, head, hands, feet, club — do not snap to their targets; they chase
them with an under-damped spring. Stiffness falls with distance from the
support, so motion rolls through the body as a wave: the pelvis goes, the
torso lags, the head sways after, the club tops it off. Torso rotations are
never set explicitly — they derive from the pelvis→chest and chest→head
directions, so the pose always stays coherent.

The layer is purely visual: it touches neither collision, movement nor strike
timing. During the sweep the jelly nearly switches off — that is where exact
timing matters, and the exact club-head position the hit force is computed
from.

**Weight is secondary animation, not physics.** A kinematic body is perfectly
even, and the sense of weight vanishes. Bringing physics back for its sake is
off the table — the controls already fought it once. Instead there are three
cheap sources of unevenness: torso keel from acceleration and braking, sway
(it grows near the arena's edge — that is how you see risk) and club lag on
turns. Each is fully controllable and breaks nothing.

The inertia is real: acceleration and braking take time, so you cannot stop
instantly at the very edge. The sweep also takes away control — a strike must
cost something.

**Bots play with the same muscles.** A bot has no teleports and no free hits:
it walks at the same speed, turns with the same code and charges with the
same timeline — a timer just presses the button for it.

## Sandbox

A separate mode for studying the feel of the swing without bots trying to
kill you in the meantime.

**Tools → Top Kong → Create sandbox scene** → Play.

You are alone at the center, dummies around you. The round never ends, you
cannot be eliminated: fall off the arena and you are instantly back at the
center. Dummies respawn on their own.

| | |
|---|---|
| **F2** | slow motion |
| **F3** | return to center |
| **R** | reset everything |

What helps to look at:

- **The club trail.** The ribbon shows the swing's shape. It makes instantly
  visible whether the club travels a wide arc or gets yanked along
  a straight line — hard to describe in words.
- **The right-side panel.** Club head speed right now, the peak of the
  current swing, the last hit's speed and its strength from 0 to 1, body
  state. It turns "the hit feels weak" into "the peak was 9 and the hit
  registered at 5" — and with that you know which knob to turn.
- **Slow motion.** At normal speed a swing lasts fractions of a second, and
  what exactly is wrong with the trajectory cannot be seen.

A dummy is a regular fighter that was not given a controller: it takes hits,
flies as a ragdoll, gets up and falls off the arena like a real one, but does
not walk or strike on its own.

The sandbox can also be enabled without a separate scene — the `sandboxMode`
checkbox in the settings.

## Tuning

Everything tunable lives in one place — the **GameBootstrap** component on
the `TopKong` object in the Hierarchy. Values are read every frame, so they
can be changed **during Play** with immediate effect.

If something feels off, start here:

| Feeling | What to turn |
|---|---|
| Walks slowly or accelerates sluggishly | `maxRunSpeed`, `moveAccel` |
| Walks too evenly and safely | `wobbleAmount`, `leanFromAccel`, `limbLag` |
| Not enough jelly | `jellyDamping` down, `jellyStiffness` down |
| Body flops like a rag | `jellyAmount` down (0 — fully rigid) |
| The club drags wrong | `carryAngle`, `carryReach`, `carryDrop` |
| Wind-up slows too much / too little | `chargeMoveSlow` |
| Too easy to brake at the edge | lower `moveBrake` |
| The strike locks movement too hard | raise `swingMoveLock` |
| Turns slowly | `turnSpeed` (degrees per second) |
| The step doesn't look like a step | `stepRate`, `stepLength`, `stepBob` |
| Strike too slow or too abrupt | `swingStrikeTime` |
| Charge takes too long | `swingChargeTime`, `swingWeakestPower` |
| Arc too small or club falls short | `swingArcDegrees`, `handMaxReach` |
| Hits don't launch / launch too easily | `minKnockback`, `maxKnockback`, `knockUpBias` |
| Takes too long to get up | `standUpSettle`, `standUpTime` |
| Ragdoll looks too stiff | lower `driveSpringMul` |
| Aim won't go far past the edge | `aimMaxRadiusFactor` |
| The aim line is distracting | disable `showAimLink` |
| Want the camera to lead the turn | enable `camFollowFacing` |
| Bots too mean or too dumb | `botSkill`, `botSwingRange`, `botReaction` |
| Too few/many opponents | `botCount` (restart the round with **R**) |

## Updates arrive on their own

An `AutoUpdater` lives in the editor: once a minute and on every return to
the Unity window it checks the repository, does `git pull --ff-only` and
calls `AssetDatabase.Refresh()`. New changes land in the game with zero
actions — just leave Play mode.

It is deliberately careful, because it touches your working directory:

- it **never** touches your changes. Uncommitted edits in tracked files —
  the update is skipped, with an explanation in the console;
- `--ff-only` only: if history diverged, git refuses rather than merging;
- does nothing in Play mode or during compilation;
- git runs on a background thread, the editor does not hitch;
- no git or no repository — it says so once and disables itself.

Turned off in **Tools → Top Kong → Auto-update**. **Update now** lives there
too, for when waiting a minute is too long.

## Rolling back to a working version

Applies to both versions: they live in one repository and one branch.

Development happens in `main`. Versions confirmed live are marked with
marker branches `stable/v1`, `stable/v2` and so on. They never move — they
are the points to return to when a change breaks something.

**The `stable/*` branches must not be deleted** — with them goes the ability
to roll back. The prefix is not decoration: in GitHub's branch list they
group together and do not look like clutter begging to be cleaned up.

```
git checkout stable/v1   # return to the verified version
git checkout main        # return to current development
```

| Marker | What it is |
|---|---|
| `stable/v1` | First working version: arena, ragdoll, club-arm, bots, rounds |

Branches rather than tags for a prosaic reason: the proxy in the environment
where this project is built does not let tag pushes through — verified,
branches pass, tags fail. It changes nothing about rollback; the only
difference is that markers show up in the branch list.

## The scene

`Assets/TopKong/Scenes/Arena.unity` is created automatically on first open.
It is optional — the game boots from any scene — but with it the Scene view
stops being empty: the `TopKong` object draws gizmos for the arena edge, the
spawn circle, fighter positions and the height below which a fall counts.

The game objects appear in the Hierarchy only after Play — arena, light,
camera and fighters are assembled by code at runtime, which is how the
project is built, not an unfinished corner.

## Render pipeline

The project opens on Built-in — that is what Unity configures by itself, and
on it the project is guaranteed to run without a single extra file.

The game works identically on URP: `MaterialFactory` picks the shader at
runtime. If you want URP:

1. Window → Package Manager → Unity Registry → **Universal RP** → Install
2. **Tools → Top Kong → Enable URP**

The menu item creates a pipeline asset and sets it in Graphics Settings. If
it can't, it says plainly in the console what to do by hand.

## Unity part structure

```
Assets/TopKong/Scripts/
├── Core/            entry point, settings, compatibility, materials, sound
├── Arena/           arena and camera
├── Fighters/
│   ├── FighterRig.cs        body geometry and pose computation
│   ├── FighterBuilder.cs    assembly: character capsule + ragdoll beneath
│   ├── Fighter.cs           body states and the ragdoll transition
│   ├── PoseDriver.cs        controlled pose: stance, step, strike arc
│   ├── Locomotion.cs        movement and turning
│   ├── SwingAction.cs       strike timeline
│   └── ClubImpact.cs        hit → impulse and ragdoll
├── Control/         aiming, player input, bot AI
├── Match/           round and sandbox
└── UI/              OnGUI interface
```

## If something goes wrong

**Everything is pink.** A shader was not found. Check the console —
`MaterialFactory` logs a warning about it. Usually means the URP package is
installed but no pipeline asset is assigned: Tools → Top Kong → Enable URP.

**Everything is pink, but only in a build.** Materials are created at runtime
via `Shader.Find`, and shaders with no references in the project are stripped
from builds. The editor never shows this. Fixed by adding the needed Lit
shader to Project Settings → Graphics → **Always Included Shaders**. For
editor play it is a non-issue.

**Errors about `Input.GetKey` and the Input System.** The project is switched
to the new Input System. The code survives either way (`UnityCompat.cs`
compiles the right branch), but if errors persist — Project Settings →
Player → Active Input Handling → **Both**.

**Fighters jitter or drift apart.** Lower `fixedTimestep` (e.g. to 1/90)
and/or raise `solverIterations`.

**The game starts twice.** A `TopKong` object already sits in the scene and
the bootstrap hook raised a second one. This should not happen —
`GameBootstrap` watches for it — but if it did, just delete the object from
the scene: the game will assemble itself.
