export const GAME_TITLE = 'That One Ad Game';
export const GAME_TAGLINE = 'The one from the ads. Now without the ad.';
/** Where the game lives; the share button and the link previews point here. */
export const GAME_URL = 'https://cdmoe.github.io/that-one-ad-game/';
/** The author's X (Twitter) handle, without the @: news about new levels and modes. */
export const X_HANDLE = 'moe_zerr';

/** Track width in world units. The lateral axis runs from -HALF_TRACK to +HALF_TRACK. */
export const TRACK_WIDTH = 10;
export const HALF_TRACK = TRACK_WIDTH / 2;
/** Horizontal world units that fit on screen (track plus a small margin). */
export const VIEW_WIDTH = TRACK_WIDTH + 2;

/** Hard cap of units we simulate and draw per crowd. */
export const MAX_VISIBLE_UNITS = 1000;
/** Crowd counters never exceed this, so labels stay readable and math stays safe. */
export const MAX_COUNT = 1_000_000;

export const COLORS = {
  bg: '#0d1024',
  track: '#181d3b',
  trackEdge: '#2fe6d2',
  player: '#2fe6d2',
  playerDark: '#0a7d72',
  enemy: '#ff5d73',
  enemyDark: '#9c1d36',
  runner: '#ff9f43',
  runnerDark: '#a35a10',
  tank: '#e0508f',
  tankDark: '#7a1c4a',
  boss: '#b388ff',
  bossDark: '#4f2a9a',
  good: '#3b82ff',
  bad: '#ff4d6d',
  gold: '#ffd166',
  white: '#ffffff',
} as const;

export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';
