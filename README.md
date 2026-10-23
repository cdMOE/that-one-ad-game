# That One Ad Game

> The one from the ads. Now without the ad.

An open-source crowd runner for the browser. Steer your crowd through math gates (`+10`, `×2`,
`−5`, `÷2`), dodge obstacles, crush enemy crowds and beat the boss. Mobile-first, plain
TypeScript, 2D canvas for the runner and [Three.js](https://threejs.org) (WebGL) for the shooter,
no framework, no ads.

_Screenshots: coming soon (put captures in `docs/screenshots/` and link them here)._

## One engine, several game modes

The core is mode-agnostic. A level's `"mode"` field picks the variant:

| Mode           | Idea                                                                                          | Status            |
| -------------- | --------------------------------------------------------------------------------------------- | ----------------- |
| `runner`       | Auto-run forward, steer left/right through gates, obstacles and enemy crowds.                 | ready (10 levels) |
| `stationary`   | You slide the squad, every soldier shoots; smash HP blocks, the power-ups behind them fly in. | ready (5 levels)  |
| `gates_choice` | Risk vs. reward: every gate row offers upgrades _and_ downgrades.                             | planned           |

New modes are one file plus a registry entry, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Run it locally

Requires Node 20+.

```bash
npm install
npm run dev
```

Open the printed URL (on a phone: use the network URL on the same Wi-Fi). Add `?debug` to the URL
for an FPS overlay, and `?unlock=all` to unlock every level (and pick any shooter level).

Controls: drag with finger or mouse, or use `A`/`D` or the arrow keys.

### Scripts

| Command                        | What it does                                                   |
| ------------------------------ | -------------------------------------------------------------- |
| `npm run dev`                  | Dev server with hot reload                                     |
| `npm run build`                | Type-check and build to `dist/`                                |
| `npm test`                     | Unit tests (gate math, battle resolution, swarm, level checks) |
| `npm run validate:levels`      | Validates every level file and checks that it can be won       |
| `npm run simulate:campaign`    | Plays the shooter levels in order and prints runs per level    |
| `npm run compare:runlog`       | Replays a logged playtest with the bot, run by run             |
| `npm run build:shooter-levels` | Writes the five shooter levels from their template             |
| `npm run lint`                 | ESLint                                                         |
| `npm run format`               | Prettier                                                       |

## Creating a level

Levels are JSON files in [`src/levels`](src/levels). Drop a new file in, named so it sorts where you
want it (`04-my-level.json`), and it shows up in the game. A runner level looks like this:

```json
{
  "id": "runner-01",
  "name": "First Steps",
  "mode": "runner",
  "length": 100,
  "speed": 5.5,
  "startCount": 5,
  "gates": [
    {
      "at": 18,
      "options": [
        { "op": "+", "value": 10 },
        { "op": "x", "value": 2 }
      ]
    }
  ],
  "enemies": [{ "at": 60, "count": 12, "x": 0 }],
  "obstacles": [{ "at": 30, "kind": "spikes", "x": 0, "width": 0.3, "damage": 5 }],
  "boss": { "name": "Blobbo", "count": 25 }
}
```

| Field             | Meaning                                                                            |
| ----------------- | ---------------------------------------------------------------------------------- |
| `id`              | Unique and stable (progress is saved by id)                                        |
| `length`          | Track length; the boss (or finish line) is here                                    |
| `speed`           | Units per second (default 6)                                                       |
| `startCount`      | Crowd size at the start                                                            |
| `gates[].options` | 1 to 3 gates side by side. `op` is `+`, `-`, `x` or `/`. The crowd picks a lane.   |
| `enemies[]`       | Enemy crowd at distance `at`, lateral position `x` from -1 (left) to 1 (right)     |
| `obstacles[]`     | `spikes` or `saw`; `x`, `width` (fraction of the track), `damage`; optional `sway` |
| `boss`            | Optional final enemy at `length`. Without it, reaching `length` wins.              |

Rules worth knowing: a fight removes units one-to-one from both sides and the larger crowd keeps
the difference. A draw is a loss. `÷` rounds to nearest and never takes a living crowd to zero.
Enemy crowds always engage when the crowd reaches them, wherever they stand (`x` only decides
where they come from), so they cannot be skipped. Stars (1 to 3) depend on how much of the best
possible crowd survives.

### Stationary (shooter) levels

`"mode": "stationary"` levels have **two separate lanes**: an **upgrade lane** (left by default,
`"side": "right"` flips it) and a **monster lane** (the rest of the field). Monsters come as
**marching ranks**: row after row walks out of the haze far down the road (`SPAWN_FAR` in `sim.ts`),
enters the field and then walks slowly (about 7 seconds across it) straight down its own lane, never
entering the upgrade lane. There is no gate: you see the horde coming long before your bullets reach
it. There is no breather, so every second spent on the upgrade lane costs you. The squad slides left
and right (drag a finger, move the mouse, or `A`/`D`) and **every soldier fires one bullet dead
straight ahead** from its own position; there is no aiming. The squad stands in a narrow formation, at most
six soldiers wide (`GRID_COLS`), so a full squad standing under a tank, a block or a boss puts every
bullet into it. The camera sits low behind the squad and follows it sideways, like the ad shooters;
far away the road fades into fog.

The upgrade lane is a column that slides towards the squad: the **front block** (HP counter, stops
bullets) holds close to the squad until it is shot to pieces, and the **power-ups behind it are
all visible**. Once no block stands in front of a power-up, it flies to the squad on its own. A chain like
block, +1, +1, bigger block, weapon, block, +1 is just a list. Whatever monster reaches the bottom
bites the squad, wherever the squad is, so you have to sweep between both lanes.

```json
{
  "id": "stationary-01",
  "name": "First Blood",
  "mode": "stationary",
  "startCount": 1,
  "weapon": "pistol",
  "lane": {
    "side": "left",
    "elements": [
      { "type": "block", "hp": 10 },
      { "type": "item", "item": { "kind": "crowd", "op": "+", "value": 1 } },
      { "type": "item", "item": { "kind": "crowd", "op": "+", "value": 1 } },
      { "type": "block", "hp": 24, "grow": 1 },
      { "type": "item", "item": { "kind": "weapon", "weapon": "rifle" } }
    ]
  },
  "monsters": [
    { "kind": "grunt", "count": 60, "hp": 3, "interval": 1.2, "delay": 3, "columns": 5 },
    { "kind": "miniboss", "count": 1, "hp": 90, "interval": 1, "delay": 18 }
  ]
}
```

| Field        | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `weapon`     | `pistol`, `rifle`, `minigun`, `laser` (its shots go through the horde); each soldier carries one. Squads above 40 still hit harder per bullet.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `lane`       | `side` (`left`/`right`) and `elements`, listed front first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `elements[]` | `{ "type": "block", "hp", "grow"? }` or `{ "type": "item", "item": ... }`. `grow` = HP gained per second while it is the front block and has not been hit for a second (up to twice its HP).                                                                                                                                                                                                                                                                                                                                                                               |
| `item`       | `crowd` (a gate effect like `+1` or `x2`), `upgrade` (`rate`, `damage`, `pellets`: extra shots in a wide fan, +2 is the TRIPLE SHOT) or `weapon`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `monsters[]` | Streams: `kind` (`grunt`, `runner`, `tank`, `miniboss`, `boss`), `count` (up to 2000), `hp`, `interval` seconds apart, optional `delay` (from level start). Times say when a monster enters the field; it sets off from the haze earlier, so it arrives on time. `columns` turns the stream into marching ranks: every `interval` seconds a whole row of that many monsters enters side by side. `x` (-1..1) and `spread` (0..1) say where in the monster lane they enter (default: the whole lane); a narrow formation (small `spread`) is easy for one soldier to cover. |

The level is won as soon as the last monster is dead (or has bitten); blocks and power-ups still on
the lane do not have to be cleared. It is lost when the squad reaches zero.

**Coins and upgrades.** Every kill (and every smashed block) drops coins, and coins are kept even
when a run is lost or left early from the pause screen. Coins are inflated on purpose (see `COIN_SCALE` in `src/core/shop.ts`: payouts
and prices are scaled together, so it only feels richer). Four upgrade cards (damage, fire rate,
extra start soldiers, coin bonus) sit at the bottom of the shooter level select and result screens:
tap a card to buy, then tap RETRY. **Every upgrade has a cap** (10 levels for damage and fire rate,
5 for soldiers and coin bonus), so the strongest possible squad is a known quantity and levels get
hard through their design (the swarm, thick blocks, elites) instead of through ever bigger numbers.
Prices start low and climb moderately to the cap (`src/core/shop.ts`): the design rule is that the
next upgrade is one or two runs away, and every card shows a thin bar of how close the wallet is.
The result screen has a "next goal" bar that fills with the coins of the run, so even a run that buys
nothing visibly moves you forward. The first win of a level pays a one-off bonus (`firstClearBonus`).
Every shooter level pays 40% more per kill and per block than the one before
(`LEVEL_COIN_GROWTH`), so income keeps up with the climbing prices, also for a player who never
buys the coin bonus. The coin bonus is +10% per level (+61% maxed): a nice extra, not a must. Only the current shooter level
is played: the strip at the top of the shooter screen shows the campaign but picks nothing (a lost
run pays anyway, so an old level has nothing to offer). Once every level is beaten, PLAY replays the
last one at half pay. Every level but The Flood starts with the pistol; the rifle and the minigun wait on its lane.
`npm run simulate:campaign` prints the runs per level and the longest stretch without a purchase.

**The first shooter level teaches the loop** in about five runs. Like the ads, it starts with a
single soldier that grows fast (`+2`, `+2`, the rifle, `+3`). The first run is lost in the horde a
bit before the halfway mark, but pays for the first few upgrades; with them every run gets clearly
further: through the horde, to the boss, the boss bar a little lower each time, then the win. Its
lane is long enough that the winning run still has blocks to smash until the end. Every later
level can **not** be won on the first run either: you lose, bank the coins, buy upgrades and try
again. They are meant to take a number of runs each, rising in waves (see `CAMPAIGN` below), and
each has a face of its own: its own lane, its own pace and one new thing. Heavy Crates is a
breather after the tutorial (few thick crates with big rewards, an `x2` right after the rifle,
the TRIPLE SHOT right with the minigun, a wide fan that melts the tank pairs, no miniboss, the boss
and its tanks as the wall), Growing Pains the first real wall (blocks that grow back while nobody
shoots them, DAMAGE as the reward, runners down the far flank, a second miniboss that calls them,
the longest level), The Flood mass against mass (armed from the start, a reward every few seconds,
a second `x2` for the biggest squad of the game, three times as many monsters, the end phase as
full-width walls sloshing from side to side) and Big Boss the chapter boss (two minibosses on guard, a boss that calls every kind of
monster at once, and the LASER as the prize a strong run reaches just before the boss). A
lost run shows how far it got, against the level's record, and what finished it (the horde or a
boss volley). The record also sits on the HUD bar as a white line; the moment a run passes it, the
line turns gold and NEW RECORD! pops. The bar counts ordinary monsters one each and elites by the
health they lose (`progressShare`: a boss is a quarter of the bar, a miniboss a twentieth), so a
boss fight moves it instead of parking it at 99%.

**How a shooter level is built: a slope, not a cliff.** All five shooter levels share one shape
(they are built by `npm run build:shooter-levels`, see below), so a stronger squad always gets a
little further instead of flipping a run from "lost at 60%" to "won without a scratch":

- **The lane is a ladder.** The rifle after the first few blocks, the minigun soon after (every run
  that is not lost in the opening gets it: it is the power fantasy, not the deciding wall), then
  many small steps (`+3` to `+10` soldiers, `+15%` fire rate) behind blocks that get thicker the
  deeper they sit. 20% more damage means a step or two further, never "won instead of lost". There
  is no late `x2`: one gate that doubles the squad is a cliff.
- **The end phase comes in pulses.** The horde arrives in short, dense waves with a breather after
  each, so a squad that falls a little behind loses a few soldiers and catches up instead of being
  overrun in two seconds. Tanks come between the pulses, not with the boss.
- **The boss is the one wall at the end.** A run that gets there with too little firepower brings
  it down part of the way before its horde and volleys win: lost runs end at "boss 20% left", the
  near-miss that makes you retry. The unit tests check that the run before every win came close
  (`NEAR_MISS`). The fight takes 20-35 s on the run that wins (`npm run simulate:campaign` shows it):
  its health is set for that, the difficulty of a level comes from its toughness `k`.

**Stars** measure how much of the biggest squad of the run is still standing at the end (80% or more:
three stars, 45% or more: two, otherwise one), so a run without bites and volleys earns three stars
whatever upgrades you own.

**Pause.** The button at the top left (or `Esc` / `P`) pauses a shooter run, and it pauses by itself
when the tab or app goes to the background. From the pause screen you can resume, retry or go to the
menu; leaving keeps the coins of the run.

**Minibosses and bosses are elites.** Every elite comes at its own `delay`, whatever else is on the
field: there is no queue, no breather, and two bosses can be out at once. They walk in to a hold
line well inside the field (`holdY` in `sim.ts`) and never bite. Instead they stay until you kill
them and fire volleys at intervals: red zones light up, and a moment later they land, costing a share of your soldiers (once per volley) unless
you have slid out of all of them. A boss fight comes in phases: while a horde stands on the field in
front of the boss (enough to bite `HORDE_HOLD` soldiers, a tank counts as four), it holds its fire,
and once it clears it opens fire at once, so you fight the horde, then dodge and hit the boss, never
both at full strength. A miniboss fires through the horde: it is where you learn to dodge. The first zone is aimed at your squad with a chance (`aimedChance`),
otherwise it lands at random, and the boss adds a second random zone (`zones`); a volley always
leaves a gap the squad fits into. The upgrade lane is never struck. Everything else (grunts, runners, tanks)
still walks down and bites. Bullets have a limited range (`BULLET_RANGE` in `sim.ts`): they reach
almost to the top of the field, not all the way.

**Bodies collide.** An elite is immovable and always comes down the middle of the monster lane
(its `x` is ignored); two or more queue up in a column, one behind the other, so both sides of the
lane stay free. The horde is pushed out of an elite and slides around it, so a boss splits the
stream in two, and what stands behind it is shielded because a bullet hits the first thing in its
path. An elite that has others in front of it steps up when they fall. Ordinary monsters also shove each other apart a little (`BODY_STIFFNESS`), so a
crowd looks like a crowd. A few monster slots are reserved for elites (`ELITE_RESERVE`), so a jam of
grunts can never hold a boss back.

`npm run validate:levels` plays every stationary level with a bot (20 runs per upgrade tier, tier 10 =
everything at its cap) and reports the **upgrade tier the level needs**: the lowest tier at which the
bot wins 60% of its runs (`WIN_RATE_TARGET` and `VALIDATION_RUNS` in `bot.ts`). It rejects levels
that do not reach that bar with a fully upgraded squad. The first level has its own rule
(`TUTORIAL` in `bot.ts`): without upgrades the bot loses every run, with a median progress between
25% and 50%, and it wins at tier 3 at the latest. Every level also has to keep its **upgrade lane
going until the end of the run that wins it**: at the lowest winning tier the lane must still have
something on it for 85% of a won run (`LANE_LASTS`), so the winning run never turns into watching. The unit tests check the same bars with the same
seeds, and in addition that the first level's first run pays for the first damage and fire-rate
upgrade, that every later level is never won without upgrades, and that its first run pays at least
a third of the first upgrade.

`npm run simulate:campaign` plays all shooter levels in order with one shared wallet and prints how
many runs each level took and how far each run got (`runs: 26% > 50% > won (lane 100%)`, the lane
share as above), next to the level's target. It plays the campaign once for each player profile
(`PROFILES` in `src/modes/stationary/campaign.ts`) and then shows them side by side: `good` is a
strong player who knows the game (the `GOOD` pilot, buying like the user did: one of each card per
round, soldiers first, then the coin bonus, then damage and fire rate), `casual` plays now and then
(the `CASUAL` pilot, buying the cheapest card that makes it stronger right away, never the coin
bonus); `--profile=good` plays only one. The table at the end shows the median of the `CAMPAIGN_SEEDS`
campaigns (one campaign is a single draw of the random spawns), as the unit tests check it. The targets live in `CAMPAIGN`: a range of runs per level
and profile, rising in waves (a breather after every wall). The `good` ranges are the agreed
design; the `casual` ranges are what the casual model needs today (about one and a half times the
runs in all: as many in the tutorial, where the shop decides, up to four times as many in The
Flood, where handling a mass is the skill), a guard rail rather than a goal until a casual playtest
calibrates it. The unit tests play the same campaigns and hold every level to its range, to at most
`MAX_DRY` runs in a row that buy nothing and to a near miss before every win; a level `pending`
for a profile has not been tuned for it yet and shows up as a todo.

The `GOOD` pilot is calibrated against a real playtest: open the game with `?debug`, play, save the
log with EXPORT RUN LOG, then `npm run compare:runlog -- runlog.json` replays every logged run with
exactly the upgrades it had, over several seeds (`--pilot=good,casual`, `--seeds=N`,
`--level=stationary-05`). Where the player won, the bot should win most seeds; where they lost, it
should get about as far and earn about as much. A log only says something about the level versions
it was played on: after the levels change, play a new one.

`npm run build:shooter-levels` writes the five shooter level files from one template (the opening
crowd, the pulses, the boss) plus each level's own lane, pace and toughness `k`
(`scripts/build-shooter-levels.ts`).
Tune the numbers there, not in the JSON files, which it overwrites; then check the result with
`npm run simulate:campaign`.

Check your level before opening a pull request:

```bash
npm run validate:levels
```

It prints readable errors (`gates[2].options[0].op: expected one of ...`) and checks that the level
can be won (a perfect-player walk for runner levels, a bot for stationary levels, see above).

## Project structure

```
src/
  core/      game loop, input, 2D camera, WebGL layer, swarm simulation, particles, pure rules
  modes/     GameMode interface, registry, one file per mode (stationary/ holds its headless sim, weapons, bot, and the 3D scene + procedural models)
  entities/  gates, obstacles, enemy crowds
  levels/    level JSON files, types, validation, solvability check
  ui/        DOM overlay: menu, level select, HUD, result screen
  audio/     WebAudio sound effects (all synthesized, no audio files)
tests/       unit tests
scripts/     level validation CLI
```

### Performance notes

Crowds are stored as typed arrays (structure of arrays), not objects, and units follow slots in a
spiral formation with a spring instead of using O(n²) boids. The counter and the number of drawn
units are separate: a crowd of 1,000,000 is shown as under 1,000 sprites. Particles and popups
live in fixed-size pools, so nothing is allocated while playing.

The shooter is drawn in 3D with Three.js (pinned version, procedural low-poly models, no asset
files). The simulation stays headless and 2D; `stationary/scene.ts` only mirrors its state into
`InstancedMesh`es (one draw call per monster kind, plus soldiers, bullets, particles and blob
shadows) by writing straight into the instance buffers. Numbers (HP, counters, popups) are painted
on a transparent 2D canvas above the WebGL canvas. The WebGL canvas fills the whole window, so on a
wide desktop the sky, the sea and the bridge continue beside the phone-shaped game column. The menu's
attract mode is a silent, self-steering shooter level rendered the same way. The runner is still
pure 2D canvas.

## Deploying

Pushes to `main` build and deploy to GitHub Pages via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). The Vite `base` is relative
(`./`), so it works under any repository name. In the repository settings, set
**Pages → Source** to **GitHub Actions**.

## License

[MIT](LICENSE). Credits: [CREDITS.md](CREDITS.md).
