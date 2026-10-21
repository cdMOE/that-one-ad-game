# That One Ad Game

> The one from the ads. Now without the ad.

An open-source crowd runner for the browser. Steer your crowd through math gates (`+10`, `×2`,
`−5`, `÷2`), dodge obstacles, crush enemy crowds and beat the boss. Mobile-first, plain
TypeScript, 2D canvas for the runner and [Three.js](https://threejs.org) (WebGL) for the shooter,
no framework, no ads.

_Screenshots: coming soon (put captures in `docs/screenshots/` and link them here)._

## One engine, several game modes

The core is mode-agnostic. A level's `"mode"` field picks the variant:

| Mode           | Idea                                                                                         | Status            |
| -------------- | -------------------------------------------------------------------------------------------- | ----------------- |
| `runner`       | Auto-run forward, steer left/right through gates, obstacles and enemy crowds.                | ready (10 levels) |
| `stationary`   | You slide the squad, every soldier shoots; smash HP blocks, catch the power-ups behind them. | ready (5 levels)  |
| `gates_choice` | Risk vs. reward: every gate row offers upgrades _and_ downgrades.                            | planned           |

New modes are one file plus a registry entry, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Run it locally

Requires Node 20+.

```bash
npm install
npm run dev
```

Open the printed URL (on a phone: use the network URL on the same Wi-Fi). Add `?debug` to the URL
for an FPS overlay, and `?unlock=all` to unlock every level.

Controls: drag with finger or mouse, or use `A`/`D` or the arrow keys.

### Scripts

| Command                     | What it does                                                   |
| --------------------------- | -------------------------------------------------------------- |
| `npm run dev`               | Dev server with hot reload                                     |
| `npm run build`             | Type-check and build to `dist/`                                |
| `npm test`                  | Unit tests (gate math, battle resolution, swarm, level checks) |
| `npm run validate:levels`   | Validates every level file and checks that it can be won       |
| `npm run simulate:campaign` | Plays the shooter levels in order and prints runs per level    |
| `npm run lint`              | ESLint                                                         |
| `npm run format`            | Prettier                                                       |

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
**marching ranks**: row after row walks slowly (about 7 seconds across the field) straight down its own
lane and never enters the upgrade lane. There is no breather, so every second spent on the upgrade
lane costs you. The squad slides left and right
(drag a finger, move the mouse, or `A`/`D`) and **every soldier fires one bullet dead straight
ahead** from its own position; there is no aiming.

The upgrade lane is a column that slides towards the squad: the **front block** (HP counter, stops
bullets) holds close to the squad until it is shot to pieces, and the **power-ups behind it are
all visible**. A power-up at the front falls, and you catch it by moving underneath. A chain like
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

| Field        | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `weapon`     | `pistol`, `rifle`, `minigun`; each soldier carries one. Squads above 40 still hit harder per bullet.                                                                                                                                                                                                                                                                                                                                                                   |
| `lane`       | `side` (`left`/`right`) and `elements`, listed front first.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `elements[]` | `{ "type": "block", "hp", "grow"? }` or `{ "type": "item", "item": ... }`. `grow` = HP gained per second while it is the front block.                                                                                                                                                                                                                                                                                                                                  |
| `item`       | `crowd` (a gate effect like `+1` or `x2`), `upgrade` (`rate`, `damage`, `pellets`) or `weapon`                                                                                                                                                                                                                                                                                                                                                                         |
| `monsters[]` | Streams: `kind` (`grunt`, `runner`, `tank`, `miniboss`, `boss`), `count` (up to 2000), `hp`, `interval` seconds apart, optional `delay` (from level start). `columns` turns the stream into marching ranks: every `interval` seconds a whole row of that many monsters appears side by side. `x` (-1..1) and `spread` (0..1) say where in the monster lane they enter (default: the whole lane); a narrow formation (small `spread`) is easy for one soldier to cover. |

The level is won as soon as the last monster is dead (or has bitten); blocks and power-ups still on
the lane do not have to be cleared. It is lost when the squad reaches zero.

**Coins and upgrades.** Every kill (and every smashed block) drops coins, and coins are kept even
when a run is lost. Coins are inflated on purpose (see `COIN_SCALE` in `src/core/shop.ts`: payouts
and prices are scaled together, so it only feels richer). Four upgrade cards (damage, fire rate,
extra start soldiers, coin bonus) sit at the bottom of the shooter level select and result screens:
tap a card to buy, then tap RETRY. **Every upgrade has a cap** (10 levels for damage and fire rate,
5 for soldiers and coin bonus), so the strongest possible squad is a known quantity and levels get
hard through their design (the swarm, thick blocks, elites) instead of through ever bigger numbers.
Prices start low and climb moderately to the cap (`src/core/shop.ts`): the design rule is that the
next upgrade is one or two runs away, and every card shows a thin bar of how close the wallet is.
The result screen has a "next goal" bar that fills with the coins of the run, so even a run that buys
nothing visibly moves you forward. The first win of a level pays a one-off bonus (`firstClearBonus`).
A level that was already beaten pays half, so replaying it is no way around the wall.
`npm run simulate:campaign` prints the runs per level and the longest stretch without a purchase.

Stationary levels can **not** be won on the first run: you lose, bank the coins, buy upgrades and
try again. They are meant to take a number of runs each. Monsters die to one bullet and come in the
thousands; the wall comes from lane blocks that get thicker the deeper they sit (where weapon damage
matters) and from the elites.

**Minibosses and bosses are elites.** Every elite comes at its own `delay`, whatever else is on the
field: there is no queue, no breather, and two bosses can be out at once. They walk in to a hold
line well inside the field (`holdY` in `sim.ts`) and never bite. Instead they stay until you kill
them and fire volleys at intervals: red zones light up, and a moment later they land, costing a share of your soldiers (once per volley) unless
you have slid out of all of them. The first zone is aimed at your squad with a chance (`aimedChance`),
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

`npm run validate:levels` plays every stationary level with a bot (5 runs per upgrade tier, tier 10 =
everything at its cap) and reports the **upgrade tier the level needs**. It rejects levels the bot
cannot win with a fully upgraded squad and warns about levels it wins without any upgrades (the unit
tests fail for those, and for levels whose first run pays less than a third of the first upgrade).

`npm run simulate:campaign` plays all shooter levels in order with one shared wallet (buying the
cheapest upgrade after every run) and prints how many runs each level took. The bot is better than
most people, so expect a person to need about half as many runs.

Check your level before opening a pull request:

```bash
npm run validate:levels
```

It prints readable errors (`gates[2].options[0].op: expected one of ...`) and checks that the level
can be won (a perfect-player walk for runner levels, a bot for stationary levels).

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
wide desktop the sky and the road continue beside the phone-shaped game column. The menu's
attract mode is a silent, self-steering shooter level rendered the same way. The runner is still
pure 2D canvas.

## Deploying

Pushes to `main` build and deploy to GitHub Pages via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). The Vite `base` is relative
(`./`), so it works under any repository name. In the repository settings, set
**Pages → Source** to **GitHub Actions**.

## License

[MIT](LICENSE). Credits: [CREDITS.md](CREDITS.md).
