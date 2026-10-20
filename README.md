# That One Ad Game

> The one from the ads. Now without the ad.

An open-source crowd runner for the browser. Steer your crowd through math gates (`+10`, `×2`,
`−5`, `÷2`), dodge obstacles, crush enemy crowds and beat the boss. Mobile-first, plain
TypeScript, 2D canvas, no framework, no ads.

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

| Command                   | What it does                                                   |
| ------------------------- | -------------------------------------------------------------- |
| `npm run dev`             | Dev server with hot reload                                     |
| `npm run build`           | Type-check and build to `dist/`                                |
| `npm test`                | Unit tests (gate math, battle resolution, swarm, level checks) |
| `npm run validate:levels` | Validates every level file and checks that it can be won       |
| `npm run lint`            | ESLint                                                         |
| `npm run format`          | Prettier                                                       |

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

`"mode": "stationary"` levels are a list of waves. The squad slides left and right (drag a
finger, move the mouse, or `A`/`D`) and **every soldier fires one bullet dead straight ahead** from
its own position, so sliding the squad sweeps the fire across the field.
Monsters come down from the top (by default the right side). A block with an HP counter stops
bullets; the **power-up hidden behind it** (more soldiers, an upgrade or a better weapon) falls
towards the squad once the block breaks, and you have to move under it to catch it. A wave is
cleared when all monsters, blocks and falling items are resolved. Give later blocks more HP (or
let them `grow`) to raise the pressure.

```json
{
  "id": "stationary-02",
  "name": "Heavy Crates",
  "mode": "stationary",
  "startCount": 10,
  "weapon": "rifle",
  "waves": [
    {
      "monsters": [{ "kind": "grunt", "count": 10, "hp": 20, "interval": 1.2 }],
      "obstacles": [
        { "x": -0.55, "y": 8, "hp": 90, "item": { "kind": "crowd", "op": "+", "value": 5 } }
      ]
    },
    {
      "monsters": [{ "kind": "grunt", "count": 12, "hp": 30, "interval": 1.0, "x": 0.7 }],
      "obstacles": [
        {
          "x": -0.55,
          "y": 8,
          "hp": 160,
          "grow": 3,
          "item": { "kind": "weapon", "weapon": "shotgun" }
        }
      ]
    }
  ]
}
```

| Field               | Meaning                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `weapon`            | `pistol`, `rifle`, `shotgun`, `minigun`; each soldier carries one. Squads above 40 still hit harder per bullet.           |
| `monsters[].kind`   | `grunt`, `runner` (fast), `tank` (slow, bites hard), `boss`                                                               |
| `monsters[]` timing | `count` monsters, `interval` seconds apart, optional `delay`                                                              |
| `monsters[].x`      | Lane from -1 (left) to 1 (right), default 0.6; `spread` scatters them around it                                           |
| `obstacles[]`       | Block at `x` (-1..1) and `y` (4..15 in front of the squad) with `hp`, optional `width`, `grow` (HP gained per second)     |
| `obstacles[].item`  | Power-up behind the block: `crowd` (a gate effect like `+5` or `x2`), `upgrade` (`rate`, `damage`, `pellets`) or `weapon` |

**Coins and upgrades.** Every kill (and every smashed block) drops coins, and coins are kept even
when a run is lost. In the shop (menu or result screen) they buy permanent upgrades for damage,
fire rate and coin bonus; each level costs more than the one before (`src/core/shop.ts`).
Stationary levels are meant to be lost at first and need several runs plus upgrades.

`npm run validate:levels` plays every stationary level with a bot (5 runs per upgrade tier) and
reports the **upgrade tier the level needs** and the coins a run earns. It rejects levels the bot
cannot win even with maximum upgrades and warns about levels it wins without any upgrades.

Check your level before opening a pull request:

```bash
npm run validate:levels
```

It prints readable errors (`gates[2].options[0].op: expected one of ...`) and checks that the level
can be won (a perfect-player walk for runner levels, a bot for stationary levels).

## Project structure

```
src/
  core/      game loop, input, camera, swarm simulation, particles, pure rules
  modes/     GameMode interface, registry, one file per mode (stationary/ holds its headless sim, weapons, bot)
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

## Deploying

Pushes to `main` build and deploy to GitHub Pages via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). The Vite `base` is relative
(`./`), so it works under any repository name. In the repository settings, set
**Pages → Source** to **GitHub Actions**.

## License

[MIT](LICENSE). Credits: [CREDITS.md](CREDITS.md).
