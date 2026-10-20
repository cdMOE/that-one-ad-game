import { GAME_TAGLINE, GAME_TITLE } from '../config';
import {
  UPGRADE_KINDS,
  UPGRADES,
  upgradeCost,
  upgradeMultiplier,
  type UpgradeKind,
} from '../core/shop';
import type { SaveData } from '../core/storage';
import type { Level } from '../levels';

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
}

type ElChild = Node | string;

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
  private readonly playBtn: HTMLButtonElement;
  private readonly fpsEl: HTMLElement | null;
  private readonly shop: HTMLElement;
  private readonly shopCoins: HTMLElement;
  private readonly shopList: HTMLElement;
  private readonly resultCoins: HTMLElement;
  private readonly shopBtn: HTMLButtonElement;
  private readonly resultShopBtn: HTMLButtonElement;
  private shopBack: () => void = () => {};

  constructor(
    root: HTMLElement,
    private readonly handlers: UiHandlers,
    debug: boolean,
  ) {
    const click = (fn: () => void) => () => {
      handlers.onClick();
      fn();
    };

    // shop (permanent upgrades bought with coins)
    this.shopCoins = h('div', { class: 'shop-coins' });
    this.shopList = h('div', { class: 'shop-list' });
    this.shop = h(
      'section',
      { class: 'screen shop' },
      h('h2', { text: 'Upgrades' }),
      this.shopCoins,
      this.shopList,
      h('button', {
        class: 'btn btn-secondary',
        text: 'BACK',
        onclick: click(() => this.shopBack()),
      }),
    );
    this.shopBtn = h('button', {
      class: 'btn btn-secondary btn-shop',
      onclick: click(() => this.openShop(() => this.showMenu())),
    });

    // main menu
    this.playBtn = h('button', { class: 'btn btn-primary', text: 'PLAY' });
    this.menu = h(
      'section',
      { class: 'screen menu' },
      h('h1', { class: 'title' }, h('span', { text: 'THAT ONE' }), h('span', { text: 'AD GAME' })),
      h('p', { class: 'tagline', text: GAME_TAGLINE }),
      this.playBtn,
      h('button', {
        class: 'btn btn-secondary',
        text: 'LEVELS',
        onclick: click(() => this.openLevels()),
      }),
      this.shopBtn,
      h('p', { class: 'fine', text: 'Open source. MIT licensed. No ads. Promise.' }),
    );

    // level select
    this.levelGrid = h('div', { class: 'level-grid' });
    this.levelScreen = h(
      'section',
      { class: 'screen levels' },
      h('h2', { text: 'Select level' }),
      this.levelGrid,
      h('button', {
        class: 'btn btn-secondary',
        text: 'BACK',
        onclick: click(() => this.showMenu()),
      }),
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
    this.resultShopBtn = h('button', {
      class: 'btn btn-primary',
      text: 'UPGRADES',
      onclick: click(() => this.openShop(() => (this.result.hidden = false))),
    });
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
      this.resultShopBtn,
      this.nextBtn,
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
    );

    this.fpsEl = debug ? h('div', { class: 'fps' }) : null;
    root.append(this.hud, this.hint, this.menu, this.levelScreen, this.shop, this.result);
    if (this.fpsEl) root.append(this.fpsEl);
    document.title = GAME_TITLE;
    this.hideAll();
  }

  private levels: Level[] = [];
  private save: SaveData = {
    completed: {},
    muted: false,
    coins: 0,
    upgrades: { damage: 0, rate: 0, coins: 0 },
  };
  private unlockAll = false;

  setData(levels: Level[], save: SaveData, unlockAll: boolean): void {
    this.levels = levels;
    this.save = save;
    this.unlockAll = unlockAll;
    this.setMuted(save.muted);
  }

  isUnlocked(index: number): boolean {
    if (this.unlockAll || index === 0) return true;
    return this.save.completed[this.levels[index - 1].id] !== undefined;
  }

  /** First level the player has not beaten yet (or the last one when everything is done). */
  nextLevelIndex(): number {
    const i = this.levels.findIndex((l) => this.save.completed[l.id] === undefined);
    return i === -1 ? this.levels.length - 1 : i;
  }

  setMuted(muted: boolean): void {
    this.muteBtn.innerHTML = muted ? ICON_SOUND_OFF : ICON_SOUND_ON;
    this.muteBtn.setAttribute('aria-pressed', String(muted));
  }

  private hideAll(): void {
    for (const el of [this.menu, this.levelScreen, this.shop, this.result, this.hud])
      el.hidden = true;
  }

  showMenu(): void {
    this.hideAll();
    const next = this.nextLevelIndex();
    const started = Object.keys(this.save.completed).length > 0;
    this.playBtn.textContent = started ? `PLAY LEVEL ${next + 1}` : 'PLAY';
    this.playBtn.onclick = () => {
      this.handlers.onClick();
      this.handlers.onStartLevel(next);
    };
    this.shopBtn.textContent = `UPGRADES \u00b7 ${this.save.coins} coins`;
    this.menu.hidden = false;
  }

  /** Shop screen; `back` runs when the player leaves it. */
  openShop(back: () => void): void {
    this.shopBack = back;
    this.result.hidden = true;
    this.menu.hidden = true;
    this.renderShop();
    this.shop.hidden = false;
  }

  /** Redraws the shop (called after a purchase). */
  renderShop(): void {
    this.shopCoins.textContent = `${this.save.coins} coins`;
    this.shopList.replaceChildren();
    for (const kind of UPGRADE_KINDS) {
      const info = UPGRADES[kind];
      const level = this.save.upgrades[kind];
      const cost = upgradeCost(kind, level);
      const now = Math.round((upgradeMultiplier(kind, level) - 1) * 100);
      const next = Math.round((upgradeMultiplier(kind, level + 1) - 1) * 100);
      const buy = h('button', { class: 'btn btn-primary buy', text: `${cost}` });
      buy.disabled = this.save.coins < cost;
      buy.addEventListener('click', () => {
        this.handlers.onClick();
        this.handlers.onBuy(kind);
        this.renderShop();
      });
      this.shopList.append(
        h(
          'div',
          { class: 'shop-row' },
          h(
            'div',
            { class: 'shop-info' },
            h('div', { class: 'shop-title', text: `${info.title}  Lv ${level}` }),
            h('div', { class: 'shop-blurb', text: `${info.blurb}: +${now}% \u2192 +${next}%` }),
          ),
          buy,
        ),
      );
    }
  }

  openLevels(): void {
    this.hideAll();
    this.levelGrid.replaceChildren();
    this.levels.forEach((level, i) => {
      const unlocked = this.isUnlocked(i);
      const result = this.save.completed[level.id];
      const cell = h(
        'button',
        { class: `level-cell${result ? ' done' : ''}${unlocked ? '' : ' locked'}` },
        h('span', { class: 'level-num', text: String(i + 1) }),
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
    this.hudName.textContent = `${index + 1}. ${level.name}`;
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
    shopAvailable = false,
  ): void {
    this.resultCoins.textContent = coins > 0 ? `+${coins} coins` : '';
    this.resultCoins.hidden = coins <= 0;
    this.resultShopBtn.hidden = !shopAvailable;
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
      : shopAvailable
        ? 'Spend your coins on upgrades and try again.'
        : 'Your crowd was wiped out. Try another path through the gates.';
    this.nextBtn.hidden = !(won && hasNext);
    this.result.hidden = false;
  }

  hideMenus(): void {
    this.hideAll();
  }

  setFps(fps: number, extra: string): void {
    if (this.fpsEl) this.fpsEl.textContent = `${Math.round(fps)} fps  ${extra}`;
  }
}
