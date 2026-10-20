# Contributing

Thanks for helping out! Small, focused pull requests are easiest to review.

## Setup

```bash
npm install
npm run dev
```

Before you push, run:

```bash
npm run lint && npm run format:check && npm run validate:levels && npm test && npm run build
```

## Adding a level

1. Copy an existing file in `src/levels/` and give it a new name that sorts where you want it,
   for example `04-my-level.json`. Use a **unique `id`**.
2. Edit it. The format is described in the [README](README.md#creating-a-level).
3. Run `npm run validate:levels`. It must pass: the file has to be valid and winnable by a
   perfect player.
4. Play it (`npm run dev`, add `?unlock=all` to the URL). Check that the right choice is not
   completely obvious and that a bad choice actually hurts.

Only original levels, please. Do not copy levels, names or art from other games.

## Adding a game mode

A mode is a class that implements `GameMode` (`src/modes/mode.ts`):

1. Add the mode id to `LEVEL_MODES` in `src/levels/schema.ts` and describe its level data there
   (extend the `Level` union).
2. Add a reader for the new shape in `src/levels/validate.ts` (`MODE_READERS`).
3. Implement `GameMode` in `src/modes/<name>.ts`. Use the shared pieces: `core/rules.ts`
   (gate math, fights), `core/swarm.ts` (crowds), `core/particles.ts`, and the services in
   `GameContext` (camera, particles, popups, sound, input).
4. Register it in `src/modes/index.ts`. The registry is typed, so TypeScript tells you if you
   forget.
5. Add a level or two with `"mode": "<name>"` and tests for any new pure logic.

Keep game rules in pure functions (no DOM, no time) so they can be unit tested.

## Style

- TypeScript, formatted by Prettier (`npm run format`), linted by ESLint.
- Code and comments in English.
- No per-unit DOM elements or per-frame allocations in hot paths (see Performance notes in the
  README).

## Assets and licenses

Everything is generated in code (shapes, WebAudio). If you add third-party assets, they must be
CC0 or CC-BY and listed in [CREDITS.md](CREDITS.md) in the same pull request.
