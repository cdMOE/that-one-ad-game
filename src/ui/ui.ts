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
  /** Returns the new muted state. */
  onToggleMute(): boolean;
  onClick(): void;
  /** Buys the next level of an upgrade (the game checks the price and saves). */
  onBuy(kind: UpgradeKind): void;
  /** Throws away all progress, coins and upgrades (the UI has already asked twice). */
  onReset(): void;
}

type ElChild = Node | string;

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
const ICON_BACK =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/** DOM overlay on top of the game canvas: menu, level select, HUD and result screens. */
export class Ui {
  private readonly menu: HTMLElement;
  private readonly levelScreen: HTMLElement;
  private readonly levelGrid: HTMLElement;
  private readonly hud: HTMLElement;
  private readonly hudName: HTMLElement;
  private readonly hudBar: HTMLElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly result: HTMLElement;
  private readonly resultTitle: HTMLElement;
  private readonly resultSub: HTMLElement;
  private readonly resultStars: HTMLElement;
  private readonly hint: HTMLElement;
  private hintTimer = 0;
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
      this.levelBar,
      this.levelGrid,
    );

    // HUD
    this.hudName = h('div', { class: 'hud-name' });
    this.hudBar = h('div', { class: 'hud-bar-fill' });
    this.muteBtn = h('button', { class: 'icon-btn', title: 'Mute / unmute' });
    this.muteBtn.addEventListener('click', () => {
      this.setMuted(handlers.onToggleMute());
    });
    const closeBtn = h('button', { class: 'icon-btn', title: 'Back to menu' });
    closeBtn.innerHTML = ICON_BACK;
    closeBtn.addEventListener(
      'click',
      click(() => handlers.onMenu()),
    );
    this.hud = h(
      'div',
      { class: 'hud' },
      h(
        'div',
        { class: 'hud-top' },
        closeBtn,
        h('div', { class: 'hud-mid' }, this.hudName, h('div', { class: 'hud-bar' }, this.hudBar)),
        this.muteBtn,
      ),
    );

    // result
    this.resultTitle = h('h2', { class: 'result-title' });
    this.resultSub = h('p', { class: 'result-sub' });
    this.resultStars = h('div', { class: 'stars' });
    this.hint = h('div', { class: 'hint' });
    this.hint.hidden = true;
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
    root.append(this.hud, this.hint, this.menu, this.levelScreen, this.result);
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
    this.muteBtn.innerHTML = muted ? ICON_SOUND_OFF : ICON_SOUND_ON;
    this.muteBtn.setAttribute('aria-pressed', String(muted));
  }

  private hideAll(): void {
    for (const el of [this.menu, this.levelScreen, this.result, this.hud]) el.hidden = true;
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
   * A wallet line and one card per permanent upgrade. Tapping an affordable card buys the next
   * level on the spot, so upgrading and retrying happen on the same screen.
   */
  private makeUpgradeBar(): HTMLElement {
    const wallet = h('span', { class: 'up-wallet' });
    const cards = h('div', { class: 'up-cards' });
    const bar = h(
      'div',
      { class: 'upgrade-bar' },
      h('div', { class: 'up-head' }, h('span', { class: 'up-label', text: 'UPGRADES' }), wallet),
      cards,
    );
    this.barRenderers.push(() => {
      wallet.textContent = `${formatCount(this.save.coins)} coins`;
      cards.replaceChildren();
      for (const kind of UPGRADE_KINDS) {
        const info = UPGRADES[kind];
        const level = this.save.upgrades[kind];
        const maxed = isMaxed(kind, level);
        const cost = upgradeCost(kind, level);
        const affordable = !maxed && this.save.coins >= cost;
        const card = h(
          'button',
          { class: `up-card${affordable ? ' can' : ''}${maxed ? ' maxed' : ''}` },
          h('span', { class: 'up-title', text: info.title.toUpperCase() }),
          h('span', { class: 'up-lv', text: maxed ? 'MAX' : `Lv ${level}` }),
          h('span', {
            class: 'up-gain',
            text: maxed
              ? upgradeEffect(kind, level)
              : `${upgradeEffect(kind, level)} \u2192 ${upgradeEffect(kind, level + 1)}`,
          }),
          h('span', { class: 'up-cost', text: maxed ? 'MAXED' : formatCount(cost) }),
          h('span', { class: 'up-fill' }),
        );
        // a thin bar along the bottom shows how close the wallet is to the price
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
    this.levelBar.hidden = mode !== 'stationary';
    this.levelScreen.classList.toggle('has-bar', mode === 'stationary');
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
    this.setProgress(0);
    this.hud.hidden = false;
    this.hint.hidden = true;
  }

  /** Short instruction text over the track that fades out by itself. */
  showHint(text: string, ms = 3500): void {
    this.hint.textContent = text;
    this.hint.hidden = false;
    this.hint.classList.remove('fade');
    window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => this.hint.classList.add('fade'), ms);
  }

  setProgress(p: number): void {
    this.hudBar.style.transform = `scaleX(${Math.max(0, Math.min(1, p))})`;
  }

  showResult(
    won: boolean,
    survivors: number,
    hasNext: boolean,
    stars: number,
    coins = 0,
    upgradesAvailable = false,
    bonus = 0,
    walletBefore = this.save.coins,
  ): void {
    const total = coins + bonus;
    this.resultCoins.textContent =
      bonus > 0
        ? `+${formatCount(coins)} coins  +${formatCount(bonus)} first clear!`
        : total > 0
          ? `+${formatCount(coins)} coins`
          : '';
    this.resultCoins.hidden = total <= 0;
    this.showGoal(upgradesAvailable, walletBefore);
    this.resultBar.hidden = !upgradesAvailable;
    this.result.classList.toggle('has-bar', upgradesAvailable);
    this.renderBars();
    this.hud.hidden = true;
    this.hint.hidden = true;
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
        ? 'Tap a card to upgrade, then try again.'
        : 'Your crowd was wiped out. Try another path through the gates.';
    this.nextBtn.hidden = !(won && hasNext);
    this.result.hidden = false;
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
