import { GAME_TAGLINE, GAME_TITLE } from '../config';
import { formatCount } from '../core/rules';
import {
  isMaxed,
  noUpgrades,
  UPGRADE_KINDS,
  UPGRADES,
  upgradeCost,
  upgradeEffect,
  type UpgradeKind,
} from '../core/shop';
import type { SaveData } from '../core/storage';
import type { Level } from '../levels';
import { LEVEL_MODES, type LevelMode } from '../levels/schema';

export interface UiHandlers {
  onStartLevel(index: number): void;
  onRetry(): void;
  onNext(): void;
  onMenu(): void;
  /** The round button at the top left of the HUD: pauses a shooter run, leaves a runner run. */
  onClose(): void;
  /** Continues a paused run. */
  onResume(): void;
  /** Returns the new muted state. */
  onToggleMute(): boolean;
  onClick(): void;
  /** Buys the next level of an upgrade (the game checks the price and saves). */
  onBuy(kind: UpgradeKind): void;
  /** Throws away all progress, coins and upgrades (the UI has already asked twice). */
  onReset(): void;
}

type ElChild = Node | string;

/** Everything the result screen shows. */
export interface ResultInfo {
  won: boolean;
  survivors: number;
  hasNext: boolean;
  stars: number;
  /** Coins of the run (before the first-clear bonus). */
  coins: number;
  /** Shooter screens carry the upgrade cards and the "next goal" bar. */
  upgradesAvailable: boolean;
  /** One-off first-clear bonus. */
  bonus: number;
  /** Wallet before the run's coins were added (the goal bar fills from there). */
  walletBefore: number;
  /** How far a lost run got (0..1), with the record before this run; shooter only. */
  progress?: { reached: number; bestBefore: number };
  /** Why a lost run ended. */
  lossReason?: string;
}

const MODE_INFO: Record<LevelMode, { title: string; blurb: string }> = {
  runner: { title: 'RUNNER', blurb: 'Run, pick the right gates, crush the boss' },
  stationary: { title: 'SHOOTER', blurb: 'Slide, shoot, earn coins, buy upgrades' },
};

const starText = (n: number) => '\u2605'.repeat(n) + '\u2606'.repeat(3 - n);

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; onclick?: () => void; title?: string } = {},
  ...children: ElChild[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.title) el.title = props.title;
  if (props.onclick) el.addEventListener('click', props.onclick);
  for (const c of children) el.append(c);
  return el;
}

// Static, trusted markup only (no user data ever goes through innerHTML).
const ICON_SOUND_ON =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M15.5 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M18.5 5.5a9 9 0 0 1 0 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_SOUND_OFF =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M16 9l6 6M22 9l-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_PAUSE =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>';
const ICON_FLAG =
  '<svg viewBox="0 0 24 28" width="24" height="28"><path d="M5 2v24" stroke="#0f2f66" stroke-width="4" stroke-linecap="round"/><path d="M6 3h14l-4 5 4 5H6z" fill="#fff" stroke="#0f2f66" stroke-width="2.5" stroke-linejoin="round"/></svg>';
const ICON_BACK =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/** One bullet pointing right, for the fire rate picture. */
const BULLET =
  '<rect width="11" height="11" rx="1.5" fill="#c98a1c"/><path d="M11 0h7c6 0 10 3 13 5.5C28 8 24 11 18 11h-7z" fill="#f5c04a"/>';
/** Big pictures on the upgrade cards (64x64, outlined like the rest of the ad look). */
const UPGRADE_ART: Record<UpgradeKind, string> = {
  damage:
    '<svg viewBox="0 0 64 64"><path d="M32 5L37 21L51.8 13.2L44 28L60 33L44 38L51.8 52.8L37 45L32 61L27 45L12.2 52.8L20 38L4 33L20 28L12.2 13.2L27 21Z" fill="#ffd23f" stroke="#1b1b1b" stroke-width="3" stroke-linejoin="round"/><circle cx="32" cy="33" r="8" fill="#ff7a1a"/></svg>',
  rate:
    '<svg viewBox="0 0 64 64"><g stroke="#fff" stroke-width="2.5" stroke-linecap="round" opacity="0.8"><path d="M4 18h12M2 34h12M6 50h12"/></g>' +
    `<g stroke="#1b1b1b" stroke-width="2" stroke-linejoin="round"><g transform="translate(22 11)">${BULLET}</g><g transform="translate(18 27)">${BULLET}</g><g transform="translate(22 43)">${BULLET}</g></g></svg>`,
  soldiers:
    '<svg viewBox="0 0 64 64"><g stroke="#1b1b1b" stroke-width="2.5" stroke-linejoin="round"><path d="M12 60c0-13 8-19 18-19s18 6 18 19z" fill="#e3e9f5"/><circle cx="30" cy="31" r="11" fill="#ffd2a6"/><path d="M17 30a13 13 0 0 1 26 0z" fill="#2f7bff"/></g><path d="M50 10v16M42 18h16" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>',
  coins:
    '<svg viewBox="0 0 64 64"><g stroke="#1b1b1b" stroke-width="2.5" fill="#ffd21f">' +
    [46, 37, 28]
      .map(
        (y) =>
          `<path d="M8 ${y}v6a18 7 0 0 0 36 0v-6" fill="#e9a300"/><ellipse cx="26" cy="${y}" rx="18" ry="7"/>`,
      )
      .join('') +
    '<circle cx="46" cy="40" r="14"/><circle cx="46" cy="40" r="8" fill="#ffe680" stroke-width="2"/></g></svg>',
};

/** DOM overlay on top of the game canvas: menu, level select, HUD and result screens. */
export class Ui {
  private readonly menu: HTMLElement;
  private readonly levelScreen: HTMLElement;
  private readonly levelGrid: HTMLElement;
  private readonly hud: HTMLElement;
  private readonly hudName: HTMLElement;
  private readonly hudBar: HTMLElement;
  /** Shooter HUD: the progress in per cent, the wallet and what this run has added to it. */
  private readonly hudPct: HTMLElement;
  private readonly hudCoins: HTMLElement;
  private readonly hudGain: HTMLElement;
  private readonly pauseSound: HTMLButtonElement;
  private shownCoins = -1;
  private shownGain = -1;
  private readonly muteBtn: HTMLButtonElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly pause: HTMLElement;
  private readonly pauseSub: HTMLElement;
  private readonly result: HTMLElement;
  private readonly resultTitle: HTMLElement;
  private readonly resultSub: HTMLElement;
  private readonly resultStars: HTMLElement;
  private readonly hint: HTMLElement;
  /** Shooter tutorial: a hand swiping between two arrows, like the ad shooters show it. */
  private readonly hand: HTMLElement;
  private hintTimer = 0;
  /** When the hint fades (`performance.now()`), and what is left of it while the game is paused. */
  private hintDue = 0;
  private hintLeft = 0;
  private readonly nextBtn: HTMLButtonElement;
  private readonly modeList: HTMLElement;
  private readonly levelTitle: HTMLElement;
  private readonly levelBar: HTMLElement;
  private readonly fpsEl: HTMLElement | null;
  private readonly resultBar: HTMLElement;
  private readonly resultCoins: HTMLElement;
  private readonly resultGoal: HTMLElement;
  private readonly resultGoalLabel: HTMLElement;
  private readonly resultGoalFill: HTMLElement;
  private readonly resultProgress: HTMLElement;
  private readonly resultProgressLabel: HTMLElement;
  private readonly resultProgressFill: HTMLElement;
  private readonly resultProgressBest: HTMLElement;
  private readonly resetBtn: HTMLButtonElement;
  private resetTimer = 0;
  /** Redraw functions of every upgrade bar on screen (they all show the same wallet). */
  private readonly barRenderers: Array<() => void> = [];

  constructor(
    root: HTMLElement,
    private readonly handlers: UiHandlers,
    debug: boolean,
  ) {
    const click = (fn: () => void) => () => {
      handlers.onClick();
      fn();
    };

    // the permanent upgrades live in a bar of cards on the shooter screens (no menu of their own)
    this.resultBar = this.makeUpgradeBar();
    this.levelBar = this.makeUpgradeBar();

    // erasing everything needs two taps; the button goes back to normal after a few seconds
    this.resetBtn = h('button', {
      class: 'btn btn-ghost btn-reset',
      onclick: () => this.pressReset(),
    });
    this.resetLabel(false);

    // main menu
    this.modeList = h('div', { class: 'mode-list' });
    this.menu = h(
      'section',
      { class: 'screen menu' },
      h('h1', { class: 'title' }, h('span', { text: 'THAT ONE' }), h('span', { text: 'AD GAME' })),
      h('p', { class: 'tagline', text: GAME_TAGLINE }),
      h('p', { class: 'pick', text: 'Choose a game mode' }),
      this.modeList,
      this.resetBtn,
      h('p', { class: 'fine', text: 'Open source. MIT licensed. No ads. Promise.' }),
    );

    // level select
    this.levelGrid = h('div', { class: 'level-grid' });
    this.levelTitle = h('h2');
    this.levelScreen = h(
      'section',
      { class: 'screen levels' },
      h(
        'div',
        { class: 'levels-head' },
        h('button', {
          class: 'btn btn-secondary btn-small btn-back',
          text: '‹ BACK',
          onclick: click(() => this.showMenu()),
        }),
        this.levelTitle,
      ),
      this.levelGrid,
      // the upgrade cards sit at the bottom of the mode screen, where the thumb is
      this.levelBar,
    );

    // HUD
    this.hudName = h('div', { class: 'hud-name' });
    this.hudBar = h('div', { class: 'hud-bar-fill' });
    this.muteBtn = h('button', { class: 'icon-btn btn-mute', title: 'Mute / unmute' });
    this.muteBtn.addEventListener('click', () => {
      this.setMuted(handlers.onToggleMute());
    });
    const closeBtn = h('button', { class: 'icon-btn', title: 'Back to menu' });
    closeBtn.innerHTML = ICON_BACK;
    closeBtn.addEventListener(
      'click',
      click(() => handlers.onClose()),
    );
    this.closeBtn = closeBtn;
    this.hudPct = h('span', { class: 'hud-pct' });
    this.hudCoins = h('span', { class: 'hud-coins-num' });
    this.hudGain = h('div', { class: 'hud-gain' });
    const flag = h('span', { class: 'hud-flag' });
    flag.innerHTML = ICON_FLAG;

    // pause (shooter): leaving from here keeps the coins of the run; the sound switch lives here too,
    // because the shooter HUD has no room for it
    this.pauseSound = h('button', {
      class: 'btn btn-ghost btn-sound',
      onclick: () => this.setMuted(handlers.onToggleMute()),
    });
    this.pauseSub = h('p', { class: 'result-sub' });
    this.pause = h(
      'section',
      { class: 'screen pause' },
      h('h2', { class: 'pause-title', text: 'PAUSED' }),
      this.pauseSub,
      h(
        'div',
        { class: 'pause-actions' },
        h('button', {
          class: 'btn btn-primary',
          text: 'RESUME',
          onclick: click(() => handlers.onResume()),
        }),
        h('button', {
          class: 'btn btn-secondary',
          text: 'RETRY',
          onclick: click(() => handlers.onRetry()),
        }),
        h('button', {
          class: 'btn btn-ghost',
          text: 'MENU',
          onclick: click(() => handlers.onMenu()),
        }),
        this.pauseSound,
      ),
    );
    this.hud = h(
      'div',
      { class: 'hud' },
      h(
        'div',
        { class: 'hud-top' },
        closeBtn,
        h(
          'div',
          { class: 'hud-mid' },
          this.hudName,
          h(
            'div',
            { class: 'hud-barrow' },
            h('div', { class: 'hud-bar' }, this.hudBar, this.hudPct),
            flag,
          ),
        ),
        this.muteBtn,
        h(
          'div',
          { class: 'hud-wallet' },
          h('div', { class: 'hud-coins' }, this.hudCoins, h('span', { class: 'hud-coin' })),
          this.hudGain,
        ),
      ),
    );

    // result
    this.resultTitle = h('h2', { class: 'result-title' });
    this.resultSub = h('p', { class: 'result-sub' });
    this.resultStars = h('div', { class: 'stars' });
    this.hint = h('div', { class: 'hint' });
    this.hint.hidden = true;
    this.hand = h(
      'div',
      { class: 'hint-hand' },
      h('span', { class: 'hand-arrow left', text: '\u2B05' }),
      h('span', { class: 'hand', text: '\u{1F446}' }),
      h('span', { class: 'hand-arrow right', text: '\u27A1' }),
    );
    this.hand.hidden = true;
    this.resultCoins = h('p', { class: 'result-coins' });
    this.resultGoalLabel = h('span', { class: 'goal-label' });
    this.resultGoalFill = h('div', { class: 'goal-fill' });
    this.resultGoal = h(
      'div',
      { class: 'result-goal' },
      this.resultGoalLabel,
      h('div', { class: 'goal-track' }, this.resultGoalFill),
    );
    this.resultGoal.hidden = true;
    // how far a lost shooter run got, against the record
    this.resultProgressLabel = h('span', { class: 'goal-label' });
    this.resultProgressFill = h('div', { class: 'goal-fill progress-fill' });
    this.resultProgressBest = h('div', { class: 'progress-best' });
    this.resultProgress = h(
      'div',
      { class: 'result-goal result-progress' },
      this.resultProgressLabel,
      h('div', { class: 'goal-track' }, this.resultProgressFill, this.resultProgressBest),
    );
    this.resultProgress.hidden = true;
    this.nextBtn = h('button', {
      class: 'btn btn-primary',
      text: 'NEXT LEVEL',
      onclick: click(() => handlers.onNext()),
    });
    this.result = h(
      'section',
      { class: 'screen result' },
      this.resultTitle,
      this.resultStars,
      this.resultSub,
      this.resultProgress,
      this.resultCoins,
      this.resultGoal,
      // actions sit side by side and the upgrade cards follow directly below them
      h(
        'div',
        { class: 'result-actions' },
        this.nextBtn,
        h('button', {
          class: 'btn btn-secondary btn-retry',
          text: 'RETRY',
          onclick: click(() => handlers.onRetry()),
        }),
        h('button', {
          class: 'btn btn-ghost btn-menu',
          text: 'MENU',
          onclick: click(() => handlers.onMenu()),
        }),
      ),
      this.resultBar,
    );

    this.fpsEl = debug ? h('div', { class: 'fps' }) : null;
    root.append(
      this.hud,
      this.hint,
      this.hand,
      this.menu,
      this.levelScreen,
      this.result,
      this.pause,
    );
    if (this.fpsEl) root.append(this.fpsEl);
    document.title = GAME_TITLE;
    this.hideAll();
  }

  private levels: Level[] = [];
  private save: SaveData = {
    completed: {},
    muted: false,
    coins: 0,
    upgrades: noUpgrades(),
    progress: {},
  };
  private unlockAll = false;

  setData(levels: Level[], save: SaveData, unlockAll: boolean): void {
    this.levels = levels;
    this.save = save;
    this.unlockAll = unlockAll;
    this.setMuted(save.muted);
    this.renderBars();
  }

  /** Global indices of the levels of one mode, in order. */
  private indicesOf(mode: LevelMode): number[] {
    const out: number[] = [];
    this.levels.forEach((l, i) => {
      if (l.mode === mode) out.push(i);
    });
    return out;
  }

  /** A level unlocks when the previous level of the same mode has been beaten. */
  isUnlocked(index: number): boolean {
    const list = this.indicesOf(this.levels[index].mode);
    const pos = list.indexOf(index);
    if (this.unlockAll || pos <= 0) return true;
    return this.save.completed[this.levels[list[pos - 1]].id] !== undefined;
  }

  private resetLabel(armed: boolean): void {
    this.resetBtn.textContent = armed ? 'TAP AGAIN: ERASE EVERYTHING' : 'RESET PROGRESS';
    this.resetBtn.classList.toggle('armed', armed);
  }

  private pressReset(): void {
    this.handlers.onClick();
    if (this.resetBtn.classList.contains('armed')) {
      window.clearTimeout(this.resetTimer);
      this.resetLabel(false);
      this.handlers.onReset();
      return;
    }
    this.resetLabel(true);
    window.clearTimeout(this.resetTimer);
    this.resetTimer = window.setTimeout(() => this.resetLabel(false), 4000);
  }

  setMuted(muted: boolean): void {
    this.pauseSound.textContent = muted ? 'SOUND: OFF' : 'SOUND: ON';
    this.muteBtn.innerHTML = muted ? ICON_SOUND_OFF : ICON_SOUND_ON;
    this.muteBtn.setAttribute('aria-pressed', String(muted));
  }

  private hideAll(): void {
    for (const el of [this.menu, this.levelScreen, this.result, this.hud, this.pause]) {
      el.hidden = true;
    }
    this.hideHint();
  }

  private hideHint(): void {
    window.clearTimeout(this.hintTimer);
    this.hintLeft = 0;
    this.hint.hidden = true;
    this.hand.hidden = true;
  }

  showMenu(): void {
    this.hideAll();
    this.modeList.replaceChildren();
    for (const mode of LEVEL_MODES) {
      const list = this.indicesOf(mode);
      if (list.length === 0) continue;
      const done = list.filter((i) => this.save.completed[this.levels[i].id]).length;
      const info = MODE_INFO[mode];
      this.modeList.append(
        h(
          'button',
          {
            class: `mode-card mode-${mode}`,
            onclick: () => {
              this.handlers.onClick();
              this.openLevels(mode);
            },
          },
          h('span', { class: 'mode-title', text: info.title }),
          h('span', { class: 'mode-blurb', text: info.blurb }),
          h('span', { class: 'mode-progress', text: `${done}/${list.length} levels` }),
        ),
      );
    }
    window.clearTimeout(this.resetTimer);
    this.resetLabel(false);
    this.menu.hidden = false;
  }

  /**
   * A wallet line and one big, coloured card per permanent upgrade, ad-game style: a picture,
   * the level as pips and a chunky price button. Tapping an affordable card buys the next level
   * on the spot, so upgrading and retrying happen on the same screen.
   */
  private makeUpgradeBar(): HTMLElement {
    const wallet = h('span', { class: 'up-wallet' });
    const cards = h('div', { class: 'up-cards' });
    const bar = h(
      'div',
      { class: 'upgrade-bar' },
      h(
        'div',
        { class: 'up-head' },
        h('span', { class: 'up-label', text: 'UPGRADES' }),
        h('span', { class: 'up-purse' }, wallet, h('span', { class: 'up-coin' })),
      ),
      cards,
    );
    this.barRenderers.push(() => {
      wallet.textContent = formatCount(this.save.coins);
      cards.replaceChildren();
      for (const kind of UPGRADE_KINDS) {
        const info = UPGRADES[kind];
        const level = this.save.upgrades[kind];
        const maxed = isMaxed(kind, level);
        const cost = upgradeCost(kind, level);
        const affordable = !maxed && this.save.coins >= cost;
        const art = h('span', { class: 'up-art' });
        art.innerHTML = UPGRADE_ART[kind];
        art.append(h('span', { class: 'up-badge', text: String(level) }));
        if (level > 0)
          art.append(h('span', { class: 'up-effect', text: upgradeEffect(kind, level) }));
        const pips = h('span', { class: 'up-pips' });
        for (let i = 0; i < info.maxLevel; i++) {
          pips.append(h('span', { class: i < level ? 'pip on' : 'pip' }));
        }
        const card = h(
          'button',
          {
            class: `up-card up-${kind}${affordable ? ' can' : ''}${maxed ? ' maxed' : ''}`,
            title: info.blurb,
          },
          h('span', { class: 'up-title', text: info.title.toUpperCase() }),
          art,
          pips,
          h(
            'span',
            { class: 'up-buy' },
            h('span', { class: 'up-buy-label', text: maxed ? 'MAX' : 'UPGRADE' }),
            maxed
              ? ''
              : h(
                  'span',
                  { class: 'up-price' },
                  h('span', { class: 'up-coin' }),
                  formatCount(cost),
                ),
          ),
        );
        // the grey price button fills with gold as the wallet gets closer to the price
        card.style.setProperty(
          '--fill',
          `${maxed ? 0 : Math.min(100, (this.save.coins / cost) * 100)}%`,
        );
        card.disabled = !affordable;
        card.addEventListener('click', () => {
          this.handlers.onClick();
          this.handlers.onBuy(kind);
          this.renderBars();
          // restart the pop animation on the card that was just bought
          const bought = cards.children[UPGRADE_KINDS.indexOf(kind)];
          bought?.classList.add('pop');
        });
        cards.append(card);
      }
    });
    return bar;
  }

  /** Redraws every upgrade bar (called after a purchase, a result and a reset). */
  private renderBars(): void {
    for (const render of this.barRenderers) render();
  }

  openLevels(mode: LevelMode): void {
    this.hideAll();
    this.levelTitle.textContent = MODE_INFO[mode].title;
    // the cards show from the very first visit, so a newcomer knows what the coins are for
    const bar = mode === 'stationary';
    this.levelBar.hidden = !bar;
    this.levelScreen.classList.toggle('has-bar', bar);
    this.renderBars();
    this.levelGrid.replaceChildren();
    this.indicesOf(mode).forEach((i, pos) => {
      const level = this.levels[i];
      const unlocked = this.isUnlocked(i);
      const result = this.save.completed[level.id];
      const cell = h(
        'button',
        { class: `level-cell${result ? ' done' : ''}${unlocked ? '' : ' locked'}` },
        h('span', { class: 'level-num', text: String(pos + 1) }),
        h('span', { class: 'level-name', text: level.name }),
        h('span', {
          class: 'level-best',
          text: result ? starText(result.stars) : unlocked ? '' : 'locked',
        }),
      );
      cell.disabled = !unlocked;
      cell.addEventListener('click', () => {
        this.handlers.onClick();
        this.handlers.onStartLevel(i);
      });
      this.levelGrid.append(cell);
    });
    this.levelScreen.hidden = false;
  }

  showHud(level: Level, index: number): void {
    this.hideAll();
    const pos = this.indicesOf(level.mode).indexOf(index);
    this.hudName.textContent = `${pos + 1}. ${level.name}`;
    // a shooter run can be paused (and left from the pause screen); a runner run is left directly
    const pausable = level.mode === 'stationary';
    this.closeBtn.innerHTML = pausable ? ICON_PAUSE : ICON_BACK;
    this.closeBtn.title = pausable ? 'Pause' : 'Back to menu';
    // the shooter gets the chunky ad-game HUD: per cent, flag and a coin wallet
    this.hud.classList.toggle('shooter', pausable);
    this.shownCoins = this.shownGain = -1;
    this.setProgress(0);
    this.hud.hidden = false;
    this.hint.hidden = true;
    this.hand.hidden = true;
  }

  /** Pause screen over a running level; `coins` is what the run has earned so far. */
  showPause(coins: number): void {
    this.pauseSub.textContent =
      coins > 0
        ? `+${formatCount(coins)} coins so far. You keep them if you leave.`
        : 'Take a breath.';
    this.pause.hidden = false;
    // the tutorial hint waits with the game instead of running out behind the pause screen
    if (!this.hint.hidden && !this.hint.classList.contains('fade')) {
      window.clearTimeout(this.hintTimer);
      this.hintLeft = Math.max(0, this.hintDue - performance.now());
      this.hand.classList.add('paused');
    }
  }

  hidePause(): void {
    this.pause.hidden = true;
    if (this.hintLeft > 0) {
      this.armHint(this.hintLeft);
      this.hintLeft = 0;
      this.hand.classList.remove('paused');
    }
  }

  /**
   * Short instruction text that fades out by itself: over the track (runner) or low, just above
   * the squad, where it does not cover what comes down the field (shooter).
   */
  showHint(text: string, ms = 3500, low = false): void {
    this.hint.textContent = text;
    this.hint.classList.toggle('low', low);
    this.hint.classList.remove('notice');
    this.hint.hidden = false;
    this.hint.classList.remove('fade');
    // the shooter shows the swipe with a hand as well, the way the ad shooters teach it
    this.hand.hidden = !low;
    this.hand.classList.remove('fade', 'paused');
    this.hintLeft = 0;
    this.armHint(ms);
  }

  /** The hint as a notice on top of the menu screens, e.g. when the shooter cannot run here. */
  showNotice(text: string, ms = 6000): void {
    this.showHint(text, ms);
    this.hint.classList.add('notice');
  }

  private armHint(ms: number): void {
    window.clearTimeout(this.hintTimer);
    this.hintDue = performance.now() + ms;
    this.hintTimer = window.setTimeout(() => {
      this.hint.classList.add('fade');
      this.hand.classList.add('fade');
    }, ms);
  }

  /** Shooter HUD wallet: everything owned (including this run) and what the run has added. */
  setCoins(total: number, gain: number): void {
    if (total !== this.shownCoins) {
      this.shownCoins = total;
      this.hudCoins.textContent = formatCount(total);
    }
    if (gain !== this.shownGain) {
      this.shownGain = gain;
      this.hudGain.textContent = gain > 0 ? `+${formatCount(gain)}` : '';
    }
  }

  setProgress(p: number): void {
    const share = Math.max(0, Math.min(1, p));
    this.hudBar.style.transform = `scaleX(${share})`;
    this.hudPct.textContent = `${Math.floor(share * 100)}%`;
  }

  showResult(info: ResultInfo): void {
    const { won, survivors, stars, coins, upgradesAvailable, bonus } = info;
    const total = coins + bonus;
    this.resultCoins.textContent =
      bonus > 0
        ? `+${formatCount(coins)} coins  +${formatCount(bonus)} first clear!`
        : total > 0
          ? `+${formatCount(coins)} coins`
          : '';
    this.resultCoins.hidden = total <= 0;
    this.showGoal(upgradesAvailable, info.walletBefore);
    this.showProgress(won ? undefined : info.progress);
    this.resultBar.hidden = !upgradesAvailable;
    this.result.classList.toggle('has-bar', upgradesAvailable);
    this.renderBars();
    this.hud.hidden = true;
    this.hint.hidden = true;
    this.hand.hidden = true;
    this.pause.hidden = true;
    this.resultStars.hidden = !won;
    this.resultStars.replaceChildren(
      ...[1, 2, 3].map((n) =>
        h('span', { class: n <= stars ? 'star on' : 'star', text: '\u2605' }),
      ),
    );
    this.result.classList.toggle('won', won);
    this.result.classList.toggle('lost', !won);
    this.resultTitle.textContent = won ? 'VICTORY!' : 'DEFEATED';
    this.resultSub.textContent = won
      ? `${survivors} survivor${survivors === 1 ? '' : 's'} made it`
      : upgradesAvailable
        ? `${info.lossReason ?? 'Your squad was wiped out.'} ${this.canBuy() ? 'Upgrade, then try again.' : 'Try again!'}`
        : 'Your crowd was wiped out. Try another path through the gates.';
    this.nextBtn.hidden = !(won && info.hasNext);
    this.result.hidden = false;
  }

  /** True when the wallet pays for at least one upgrade. */
  private canBuy(): boolean {
    return UPGRADE_KINDS.some((k) => this.save.coins >= upgradeCost(k, this.save.upgrades[k]));
  }

  /** How far a lost run got, with a marker at the old record and a cheer when it was beaten. */
  private showProgress(p: ResultInfo['progress']): void {
    this.resultProgress.hidden = !p;
    if (!p) return;
    // rounded down like the HUD, so a run lost at the very end never reads 100%
    const pct = (x: number) => `${Math.floor(Math.max(0, Math.min(1, x)) * 100)}%`;
    const record = p.reached > p.bestBefore && p.bestBefore > 0;
    this.resultProgressLabel.textContent = record
      ? `New record: ${pct(p.reached)} of the level!`
      : p.bestBefore > 0
        ? `Reached ${pct(p.reached)} of the level · best ${pct(p.bestBefore)}`
        : `Reached ${pct(p.reached)} of the level`;
    this.resultProgress.classList.toggle('ready', record);
    this.resultProgressFill.style.width = pct(p.reached);
    this.resultProgressBest.hidden = p.bestBefore <= 0;
    this.resultProgressBest.style.left = pct(p.bestBefore);
  }

  /**
   * "Next goal" bar under the payout: the cheapest upgrade that is still available, filling from
   * where the wallet was before the run to where it is now. A run that does not buy anything
   * still visibly moves the bar, and a near miss makes the next run tempting.
   */
  private showGoal(show: boolean, walletBefore: number): void {
    let goal: { kind: UpgradeKind; cost: number } | null = null;
    for (const kind of UPGRADE_KINDS) {
      const cost = upgradeCost(kind, this.save.upgrades[kind]);
      if (Number.isFinite(cost) && (!goal || cost < goal.cost)) goal = { kind, cost };
    }
    this.resultGoal.hidden = !show || !goal;
    if (!show || !goal) return;
    const pct = (coins: number) => `${Math.min(100, (coins / goal.cost) * 100)}%`;
    const ready = this.save.coins >= goal.cost;
    const info = UPGRADES[goal.kind];
    this.resultGoalLabel.textContent = ready
      ? `${info.title} is ready! Tap its card`
      : `${info.title}: ${Math.floor((this.save.coins / goal.cost) * 100)}% to the next level`;
    this.resultGoal.classList.toggle('ready', ready);
    // start at the old fill, then let the transition run to the new one
    const fill = this.resultGoalFill;
    fill.style.transition = 'none';
    fill.style.width = pct(walletBefore);
    void fill.offsetWidth;
    fill.style.transition = '';
    fill.style.width = pct(this.save.coins);
  }

  hideMenus(): void {
    this.hideAll();
  }

  setFps(fps: number, extra: string): void {
    if (this.fpsEl) this.fpsEl.textContent = `${Math.round(fps)} fps  ${extra}`;
  }
}
