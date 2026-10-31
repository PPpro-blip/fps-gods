import {
  BUNDLE_BY_ID,
  BUNDLE_INFO,
  BUNDLE_UNLOCK_KILLS,
  DEFAULT_BUNDLE_ID,
  WEAPON_PRESENTATION,
} from '../shared/bundles.js';
import { formatCredits } from '../shared/economy.js';
import { ROOM_MODES } from '../shared/events.js';
import {
  BOT_DIFFICULTIES,
  BOT_DIFFICULTY_IDS,
  DEFAULT_BOT_DIFFICULTY,
  getBotDifficultyConfig,
  resolveBotDifficulty,
} from '../shared/gameConfig.js';
import { DEFAULT_MAP_ID, MAP_LIST, getMap, resolveMapId } from '../shared/maps.js';
import { WEAPON_MODEL_FILE } from '../shared/weaponModels.js';
import { CROSSHAIR_STYLES, DEFAULT_SETTINGS, QUALITY_PRESETS } from './settings.js';

const CONNECTION_TOAST_COOLDOWN_MS = 6_000;
const ROOM_POLL_INTERVAL_MS = 5_000;
const ACTION_TIMEOUT_MS = 12_000;
const ONBOARDED_KEY = 'fps-gods-onboarded';

const NAV_SCREENS = ['play', 'rooms', 'inventory', 'store', 'profile', 'settings'];

// All presentation is plain DOM. Socket payloads go in through textContent, so
// a player name can never become markup.
export class GameUI {
  constructor({ profileId = null, settings = DEFAULT_SETTINGS, onChange = null } = {}) {
    this.handlers = {};
    this.onSettingsChange = onChange;
    this.settings = settings;
    this.room = null;
    this.selfId = null;
    this.screen = 'play';
    this.profile = {
      profileId: profileId ?? null,
      accountId: null,
      authenticated: false,
      emailMasked: '',
      callsign: '',
      lifetimeKills: 0,
      godsTierUnlocked: false,
      matchesPlayed: 0,
      matchesWon: 0,
    };
    this.authState = {
      loading: false,
      restoring: true,
      otpConfigured: true,
      emailProvider: 'unknown',
      pendingEmail: '',
      step: 'email',
    };
    this.wallet = {
      authenticated: false,
      loading: false,
      error: '',
      balance: 0,
      lifetimeEarned: 0,
      recentTransactions: [],
    };
    this.rewardPopTimer = null;
    this.rooms = { status: 'idle', entries: [], error: '' };
    this.selectedMapId = DEFAULT_MAP_ID;
    this.botDifficulty = resolveBotDifficulty(settings?.botDifficulty ?? DEFAULT_BOT_DIFFICULTY);
    this.arena = getMap(DEFAULT_MAP_ID);
    this.roomPollTimer = null;
    this.actionTimer = null;
    this.toastTimeout = null;
    this.hitMarkerTimer = null;
    this.feedTimers = new Map();
    this.wheelWeapons = [];
    this.selectedWheelWeaponId = null;
    this.activeWheelWeaponId = null;
    this.scoreboardOpen = false;
    this.scoreboardSignature = null;
    this.lastHudPlayer = null;
    this.lastHealth = null;
    this.lastAmmoCount = null;
    this.damageTimer = null;
    this.elimBannerTimer = null;
    this.ammoPopTimer = null;
    this.fps = 0;
    this.startedAt = Date.now();

    const savedBundle = localStorage.getItem('fps-gods-bundle');
    this.selectedBundleId = BUNDLE_BY_ID[savedBundle] ? savedBundle : DEFAULT_BUNDLE_ID;

    this.el = {};
    for (const id of [
      'app-shell', 'game-canvas', 'connection-pill', 'connection-label',
      'topbar-credits-button', 'topbar-credits-value', 'profile-chip',
      'profile-avatar', 'profile-callsign', 'profile-kills', 'brand-home', 'nav-rail',
      'menu-shell', 'hero-copy', 'stage-note', 'play-bundle-tag', 'play-now-button',
      'play-now-sub', 'bot-difficulty-picker', 'bot-difficulty-grid', 'bot-difficulty-note',
      'create-room-button', 'browse-rooms-button', 'join-room-form', 'room-code-input',
      'join-room-button', 'play-error', 'play-loadout-line', 'play-server-line',
      'refresh-rooms-button', 'room-list', 'rooms-create-button', 'rooms-join-button',
      'rooms-error', 'inventory-kills-tag', 'bundle-grid', 'inventory-error',
      'store-wallet-status', 'store-wallet-balance', 'store-wallet-lifetime',
      'store-auth-button', 'store-ledger-list',
      'store-kills-value', 'store-kills-fill', 'store-goto-play', 'profile-title',
      'profile-tier-tag', 'account-status-badge', 'profile-stat-credits',
      'profile-key', 'profile-stat-kills', 'profile-stat-unlock',
      'profile-stat-bundle', 'profile-server-target', 'profile-progress',
      'profile-progress-value', 'profile-progress-fill',
      'auth-guest-panel', 'auth-provider-note', 'auth-email-form', 'auth-email-input',
      'auth-send-code-button', 'auth-verify-form', 'auth-code-input',
      'auth-verify-button', 'auth-back-email-button', 'auth-account-panel',
      'auth-account-email', 'auth-account-matches', 'auth-logout-button', 'auth-message',
      'profile-callsign-form',
      'profile-callsign-input', 'profile-message', 'settings-reset',
      'setting-sensitivity', 'setting-sensitivity-value', 'setting-fov',
      'setting-fov-value', 'setting-volume', 'setting-volume-value', 'setting-bot-difficulty',
      'setting-quality', 'setting-crosshair', 'setting-invert', 'setting-reduced-motion', 'setting-fps', 'onboarding',
      'onboarding-identity', 'onboarding-loadout', 'step-one', 'step-two',
      'player-name', 'callsign-error', 'callsign-continue-button', 'onboarding-bundles',
      'bundle-error', 'bundle-back-button', 'bundle-continue-button', 'lobby-shell',
      'lobby-room-code', 'lobby-room-code-small', 'lobby-mode-tag', 'copy-room-code-button',
      'lobby-player-list', 'lobby-hint', 'room-error', 'leave-room-button', 'ready-button',
      'start-button', 'match-hud', 'hud-room', 'hud-room-code', 'hud-room-copy',
      'hud-arena-name', 'hud-bot-difficulty', 'map-grid', 'map-picker', 'map-picker-note',
      'lobby-arena', 'lobby-map-name', 'lobby-map-grid',
      'lobby-map-note', 'target-kills', 'alive-count', 'ping-value',
      'hud-credits-pill', 'hud-credits-value', 'hud-reward-pop', 'hud-elim-banner',
      'ads-scope-overlay', 'ads-scope-label', 'hud-loadout-strip',
      'fps-value', 'kill-feed', 'name-tags', 'crosshair', 'health-value', 'health-fill',
      'health-state', 'shield-state', 'spawn-note', 'weapon-name', 'weapon-bundle',
      'ammo-mode', 'ammo-value', 'ammo-total', 'ammo-status', 'reload-hint',
      'weapon-wheel', 'weapon-wheel-options', 'wheel-center-name', 'wheel-center-state',
      'pause-panel', 'pause-bot-difficulty', 'pause-bot-difficulty-grid',
      'resume-button', 'quit-match-button', 'quit-match-note', 'death-panel', 'respawn-countdown',
      'scoreboard-panel', 'scoreboard-room', 'scoreboard-body', 'end-panel', 'end-kicker',
      'winner-name', 'winner-summary', 'end-scoreboard', 'return-lobby-button',
      'end-waiting', 'loading-overlay', 'loading-label', 'loading-fill', 'toast',
      'webgl-warning', 'asset-warning', 'asset-warning-title', 'asset-warning-note',
      'asset-warning-list', 'asset-warning-dismiss', 'damage-vignette', 'build-stamp',
    ]) {
      this.el[id] = document.getElementById(id);
    }
    // Camel-case aliases for the hyphenated ids used by hot-path render code.
    this.el.bundleGrid = this.el['bundle-grid'];
    this.el.onboardingBundles = this.el['onboarding-bundles'];
    this.el.onboarding = this.el['onboarding'];
    this.el.crosshair = this.el['crosshair'];
    this.el.toast = this.el['toast'];
    // A renamed id in index.html used to fail silently, because every renderer
    // simply skipped a null element. Collect them once and shout about it.
    this.missingElements = Object.entries(this.el)
      .filter(([, node]) => !node)
      .map(([id]) => id);
    if (this.missingElements.length) {
      console.warn(`[ui] index.html is missing: ${this.missingElements.join(', ')}`);
    }
    this.el.ammoWidget = document.querySelector('.ammo');
    this.el.healthTrack = document.querySelector('.health-track');
    this.el.vitalState = document.querySelector('.vitals-head em');

    this.loadCallsign();
    this.renderBundles(this.el.bundleGrid, { compact: false });
    this.renderBundles(this.el.onboardingBundles, { compact: true });
    this.bindNavigation();
    this.bindPlayControls();
    this.bindOnboarding();
    this.bindSettings();
    this.bindProfile();
    this.bindAuth();
    this.bindRoomControls();
    this.bindMapControls();
    this.bindHud();
    this.el['asset-warning-dismiss'].addEventListener('click', () => this.hideAssetWarning());
    this.applySettings(this.settings);
    this.updateProfileChipsToBundle();
    this.renderWallet();
    this.renderAuth();
    this.renderHudLoadoutStrip(this.selectedBundleId, null);
    this.el['build-stamp'].textContent = `v1.0 · ${new Date(this.startedAt).getFullYear()}`;

    const onboarded = localStorage.getItem(ONBOARDED_KEY) === '1' && Boolean(this.playerName);
    this.showOnboarding(!onboarded);
    if (onboarded) this.showScreen('play');
  }

  /* ─────────────────────────────── settings ─────────────────────────────── */

  bindSettings() {
    const { el } = this;
    el['setting-sensitivity'].addEventListener('input', () => {
      this.emitSettings({ sensitivity: Number(el['setting-sensitivity'].value) });
    });
    el['setting-fov'].addEventListener('input', () => {
      this.emitSettings({ fov: Number(el['setting-fov'].value) });
    });
    el['setting-volume'].addEventListener('input', () => {
      this.emitSettings({ volume: Number(el['setting-volume'].value) });
    });
    el['setting-bot-difficulty'].addEventListener('change', () => {
      this.selectBotDifficulty(el['setting-bot-difficulty'].value, { fromSettings: true });
    });
    el['setting-quality'].addEventListener('change', () => {
      this.emitSettings({ quality: el['setting-quality'].value });
    });
    el['setting-crosshair'].addEventListener('change', () => {
      this.emitSettings({ crosshair: el['setting-crosshair'].value });
    });
    el['setting-invert'].addEventListener('change', () => {
      this.emitSettings({ invertY: el['setting-invert'].checked });
    });
    el['setting-reduced-motion']?.addEventListener('change', () => {
      this.emitSettings({ reducedMotion: el['setting-reduced-motion'].checked });
    });
    el['setting-fps'].addEventListener('change', () => {
      this.emitSettings({ showFps: el['setting-fps'].checked });
    });
    el['settings-reset'].addEventListener('click', () => {
      this.emitSettings({ ...DEFAULT_SETTINGS });
      this.showToast('Settings restored to defaults.');
    });
  }

  emitSettings(patch) {
    this.playUiSound();
    const next = this.onSettingsChange ? this.onSettingsChange(patch) : { ...this.settings, ...patch };
    this.applySettings(next);
  }

  /** Reflect settings in the controls and in the live HUD. */
  applySettings(settings) {
    this.settings = { ...this.settings, ...settings };
    const { el } = this;
    const s = this.settings;
    el['setting-sensitivity'].value = String(s.sensitivity);
    el['setting-sensitivity-value'].textContent = `${s.sensitivity.toFixed(2)}×`;
    el['setting-fov'].value = String(s.fov);
    el['setting-fov-value'].textContent = `${s.fov}°`;
    el['setting-volume'].value = String(s.volume);
    el['setting-volume-value'].textContent = `${Math.round(s.volume * 100)}%`;
    const resolvedDifficulty = resolveBotDifficulty(s.botDifficulty ?? this.botDifficulty);
    this.botDifficulty = resolvedDifficulty;
    if (el['setting-bot-difficulty']) el['setting-bot-difficulty'].value = resolvedDifficulty;
    this.syncBotDifficultyUI();
    el['setting-quality'].value = QUALITY_PRESETS[s.quality] ? s.quality : 'high';
    el['setting-crosshair'].value = CROSSHAIR_STYLES.includes(s.crosshair) ? s.crosshair : 'standard';
    el['setting-invert'].checked = s.invertY === true;
    if (el['setting-reduced-motion']) el['setting-reduced-motion'].checked = s.reducedMotion === true;
    el['setting-fps'].checked = s.showFps === true;
    el.crosshair.dataset.crosshair = s.crosshair;
    el['fps-value'].hidden = !s.showFps;
  }

  playUiSound() {
    this.handlers.onUiSound?.();
  }

  /* ────────────────────────────── navigation ────────────────────────────── */

  bindNavigation() {
    const navigate = (screen) => {
      if (!screen) return;
      this.playUiSound();
      this.showScreen(screen);
    };

    for (const button of this.el['nav-rail'].querySelectorAll('[data-nav]')) {
      button.addEventListener('click', () => navigate(button.dataset.nav));
    }
    this.el['profile-chip'].addEventListener('click', () => navigate('profile'));
    this.el['topbar-credits-button'].addEventListener('click', () => {
      navigate(this.profile.authenticated ? 'store' : 'profile');
    });
    this.el['store-auth-button'].addEventListener('click', () => {
      if (this.profile.authenticated) {
        this.playUiSound();
        this.handlers.onRefreshWallet?.();
      } else {
        navigate('profile');
        this.el['auth-email-input']?.focus?.();
      }
    });
    this.el['brand-home'].addEventListener('click', (event) => {
      event.preventDefault();
      navigate('play');
    });
    this.el['browse-rooms-button'].addEventListener('click', () => navigate('rooms'));
    this.el['rooms-join-button'].addEventListener('click', () => {
      navigate('play');
      this.el['room-code-input'].focus();
    });
    this.el['rooms-create-button'].addEventListener('click', () => this.requestCreateRoom());
    this.el['create-room-button'].addEventListener('click', () => this.requestCreateRoom());
    this.el['store-goto-play'].addEventListener('click', () => navigate('play'));

    this.el['refresh-rooms-button'].addEventListener('click', () => this.loadRooms(true));
  }

  setScreenState(screen) {
    this.screen = screen;
    this.el['app-shell'].dataset.screen = screen;
    for (const name of NAV_SCREENS) {
      const panel = document.getElementById(`screen-${name}`);
      if (panel) {
        panel.hidden = name !== screen;
        panel.classList.toggle('is-active', name === screen);
      }
    }
    for (const button of this.el['nav-rail'].querySelectorAll('[data-nav]') || []) {
      button.classList.toggle('is-active', button.dataset.nav === screen);
    }
  }

  showScreen(screen) {
    // A live match owns the viewport. The menu screens are only reachable once
    // the match has been torn down (clearMatchPresentation hides the HUD first),
    // so a stray click can never drop a player into the lobby mid-firefight.
    if (!this.el['match-hud'].hidden) return;
    const target = NAV_SCREENS.includes(screen) ? screen : 'play';
    this.setScreenState(target);
    this.setMenuVisible(true);
    this.setLobbyVisible(false);
    this.setMatchVisible(false);
    this.clearErrors();
    if (target === 'rooms') {
      this.loadRooms();
      this.startRoomPolling();
    } else {
      this.stopRoomPolling();
    }
    if (target === 'inventory') this.renderBundles(this.el.bundleGrid, { compact: false });
    if (target === 'profile') this.renderProfile();
    if (target === 'play') this.refreshPlaySummary();
  }

  /* ────────────────────────────── onboarding ────────────────────────────── */

  bindOnboarding() {
    const { el } = this;
    el['player-name'].addEventListener('input', () => {
      localStorage.setItem('fps-gods-callsign', el['player-name'].value.slice(0, 16));
      el['callsign-error'].hidden = true;
    });

    el['callsign-continue-button'].addEventListener('click', () => {
      const name = this.playerName;
      if (!name) {
        this.showOnboardingError('callsign-error', 'Enter a callsign to continue.');
        el['player-name'].focus();
        return;
      }
      this.playUiSound();
      this.handlers.onCallsignContinue?.(name, this.profileId);
      el['onboarding-identity'].hidden = true;
      el['onboarding-loadout'].hidden = false;
      el['step-one'].classList.remove('is-active');
      el['step-two'].classList.add('is-active');
      this.renderBundles(el['onboarding-bundles'], { compact: true });
    });

    el['bundle-back-button'].addEventListener('click', () => {
      el['onboarding-identity'].hidden = false;
      el['onboarding-loadout'].hidden = true;
      el['step-one'].classList.add('is-active');
      el['step-two'].classList.remove('is-active');
    });

    el['bundle-continue-button'].addEventListener('click', () => {
      if (!BUNDLE_BY_ID[this.selectedBundleId]
        || (this.selectedBundleId === 'GODS_TIER' && !this.isGodsTierUnlocked)) {
        this.showOnboardingError('bundle-error', 'Choose an unlocked bundle to continue.');
        return;
      }
      this.playUiSound();
      this.handlers.onBundleSelected?.(this.selectedBundleId);
      localStorage.setItem(ONBOARDED_KEY, '1');
      this.showOnboarding(false);
      this.showScreen('play');
      if (!this.profile.authenticated) this.handlers.onProfileCallsign?.(this.playerName);
    });
  }

  showOnboarding(visible) {
    this.el.onboarding.hidden = !visible;
    if (visible) {
      this.el['player-name'].value = this.playerName;
      this.el['onboarding-identity'].hidden = false;
      this.el['onboarding-loadout'].hidden = true;
      this.el['step-one'].classList.add('is-active');
      this.el['step-two'].classList.remove('is-active');
    }
  }

  showOnboardingError(id, message) {
    const target = this.el[id];
    if (!target) return;
    target.textContent = message;
    target.hidden = false;
  }

  /* ──────────────────────────────── arenas ──────────────────────────────── */

  /**
   * Render one selectable arena card per registered map. The picker is the only
   * place a local map choice is made; in a room the server's `mapId` wins and
   * this list reflects it.
   */
  renderMapPicker(container, { compact = false, selected = this.selectedMapId, locked = false } = {}) {
    if (!container) return;
    container.replaceChildren();
    for (const map of MAP_LIST) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `map-card${map.id === selected ? ' is-selected' : ''}${compact ? ' is-compact' : ''}`;
      card.dataset.map = map.id;
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', String(map.id === selected));
      card.disabled = locked;
      if (locked) card.setAttribute('aria-disabled', 'true');

      const name = document.createElement('strong');
      name.textContent = map.name;
      const tag = document.createElement('small');
      tag.textContent = map.tagline;
      card.append(name, tag);

      if (!compact) {
        const copy = document.createElement('p');
        copy.textContent = map.description;
        card.append(copy);
      }

      card.addEventListener('click', () => {
        if (locked) return;
        this.playUiSound();
        this.selectedMapId = map.id;
        // Update the existing cards in place instead of re-rendering the grid.
        // Re-rendering from inside a card's own click handler left a stale card
        // appended after the rebuild, so the highlighted arena and the reported
        // selection could disagree.
        this.syncMapSelection();
        this.handlers.onSelectMap?.(map.id);
      });

      container.append(card);
    }
  }

  /** Re-apply the selected state to every rendered map card, in place. */
  syncMapSelection() {
    for (const grid of [this.el['map-grid'], this.el['lobby-map-grid']]) {
      if (!grid) continue;
      for (const card of grid.querySelectorAll('.map-card')) {
        const selected = card.dataset.map === this.selectedMapId;
        card.classList.toggle('is-selected', selected);
        card.setAttribute('aria-checked', String(selected));
      }
    }
  }

  bindMapControls() {
    this.renderMapPicker(this.el['map-grid'], { selected: this.selectedMapId });
    this.el['hud-room-copy'].addEventListener('click', () => this.copyRoomCode());
  }

  /** Keep the HUD/lobby arena labels in sync with the authoritative arena. */
  setArena(map) {
    const resolved = map ?? getMap(this.selectedMapId);
    this.arena = resolved;
    if (this.el['hud-arena-name']) this.el['hud-arena-name'].textContent = resolved.name;
    if (this.el['lobby-map-name']) this.el['lobby-map-name'].textContent = resolved.name;
  }

  /** Refresh the lobby's arena block for the room the server just sent. */
  renderLobbyArena(room, { isHost = false } = {}) {
    const map = getMap(room?.mapId ?? this.selectedMapId);
    this.setArena(map);
    const note = this.el['lobby-map-note'];
    if (note) {
      note.textContent = isHost
        ? 'Your choice applies to everyone who joins this room.'
        : 'Only the host can change the arena.';
    }
    this.renderMapPicker(this.el['lobby-map-grid'], {
      compact: true,
      selected: map.id,
      locked: !isHost || room?.state !== 'LOBBY',
    });
  }

  /* ────────────────────────────── room actions ──────────────────────────── */

  renderDifficultyPicker(container, { compact = false } = {}) {
    if (!container) return;
    container.replaceChildren();
    for (const id of BOT_DIFFICULTY_IDS) {
      const preset = BOT_DIFFICULTIES[id];
      const button = document.createElement('button');
      button.type = 'button';
      const selected = id === this.botDifficulty;
      button.className = `difficulty-pill${selected ? ' is-selected' : ''}`;
      button.dataset.botDifficulty = id;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(selected));

      const title = document.createElement('strong');
      title.textContent = preset.label;
      button.append(title);
      if (!compact) {
        const sub = document.createElement('small');
        sub.textContent = id === 'easy' ? 'CASUAL' : id === 'normal' ? 'BALANCED' : 'INTENSE';
        button.append(sub);
      }

      button.addEventListener('click', () => {
        this.selectBotDifficulty(id);
      });
      container.append(button);
    }
  }

  selectBotDifficulty(value, { fromSettings = false } = {}) {
    const resolved = resolveBotDifficulty(value);
    this.botDifficulty = resolved;
    this.emitSettings({ botDifficulty: resolved });
    if (!fromSettings && this.el['setting-bot-difficulty']) {
      this.el['setting-bot-difficulty'].value = resolved;
    }
    this.handlers.onBotDifficultyChange?.(resolved);
  }

  syncBotDifficultyUI(authoritativeDifficulty = null) {
    const active = resolveBotDifficulty(authoritativeDifficulty ?? this.room?.botDifficulty ?? this.botDifficulty);
    const preset = getBotDifficultyConfig(this.botDifficulty);
    const matchPreset = getBotDifficultyConfig(active);
    if (this.el['play-now-sub']) {
      this.el['play-now-sub'].textContent = `SOLO · 5 BOTS · ${preset.label}`;
    }
    if (this.el['bot-difficulty-note']) {
      this.el['bot-difficulty-note'].textContent = preset.summary;
    }
    for (const [grid, selectedId] of [
      [this.el['bot-difficulty-grid'], this.botDifficulty],
      [this.el['pause-bot-difficulty-grid'], active],
    ]) {
      if (!grid) continue;
      for (const pill of grid.querySelectorAll('.difficulty-pill')) {
        const isSelected = pill.dataset.botDifficulty === selectedId;
        pill.classList.toggle('is-selected', isSelected);
        pill.setAttribute('aria-checked', String(isSelected));
      }
    }
    const isSolo = this.room?.mode === ROOM_MODES.SOLO_VS_BOTS;
    if (this.el['hud-bot-difficulty']) {
      this.el['hud-bot-difficulty'].hidden = !isSolo;
      this.el['hud-bot-difficulty'].textContent = `BOTS · ${matchPreset.label}`;
    }
    if (this.el['pause-bot-difficulty']) {
      this.el['pause-bot-difficulty'].hidden = !isSolo;
    }
  }

  bindPlayControls() {
    this.renderDifficultyPicker(this.el['bot-difficulty-grid'], { compact: false });
    this.renderDifficultyPicker(this.el['pause-bot-difficulty-grid'], { compact: true });
    this.syncBotDifficultyUI();

    this.el['play-now-button'].addEventListener('click', () => {
      this.playUiSound();
      this.beginAction('play-now-button');
      this.handlers.onPlayNow?.(this.playerName, this.selectedBundleId, this.profileId, this.selectedMapId);
    });

    this.el['join-room-form'].addEventListener('submit', (event) => {
      event.preventDefault();
      const code = this.el['room-code-input'].value.trim().toUpperCase();
      if (code.length !== 6) {
        this.showError('Enter all six characters of the room code.');
        return;
      }
      this.playUiSound();
      this.beginAction('join-room-button');
      this.handlers.onJoin?.(this.playerName, code, this.selectedBundleId, this.profileId);
    });

    this.el['room-code-input'].addEventListener('input', () => {
      this.el['room-code-input'].value = this.el['room-code-input'].value
        .toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6);
      this.clearErrors();
    });
  }

  requestCreateRoom() {
    this.playUiSound();
    this.beginAction('create-room-button');
    this.handlers.onCreate?.(this.playerName, this.selectedBundleId, this.profileId, this.selectedMapId);
  }

  bindRoomControls() {
    this.el['leave-room-button'].addEventListener('click', () => {
      this.playUiSound();
      this.handlers.onLeaveRoom?.();
    });
    this.el['ready-button'].addEventListener('click', () => {
      const self = this.room?.players?.find((player) => player.id === this.selfId);
      this.playUiSound();
      this.handlers.onReady?.(!(self?.ready ?? false));
    });
    this.el['start-button'].addEventListener('click', () => {
      this.playUiSound();
      this.handlers.onStart?.();
    });
    this.el['copy-room-code-button'].addEventListener('click', () => this.copyRoomCode());
    this.el['resume-button'].addEventListener('click', () => {
      this.resetQuitConfirmation();
      this.handlers.onResume?.();
    });
    this.el['quit-match-button'].addEventListener('click', () => {
      if (!this.quitConfirmation) {
        this.quitConfirmation = true;
        this.el['quit-match-note'].hidden = false;
        this.el['quit-match-button'].textContent = 'CONFIRM QUIT TO MENU';
        return;
      }
      this.handlers.onQuitMatch?.();
    });
    this.el['return-lobby-button'].addEventListener('click', () => {
      if (this.room?.mode === ROOM_MODES.SOLO_VS_BOTS) {
        this.handlers.onPlayAgain?.();
        return;
      }
      this.handlers.onReturnToLobby?.();
    });
  }

  /** Disable the pressed control until the server answers, then re-enable. */
  beginAction(buttonId) {
    this.clearErrors();
    const button = this.el[buttonId];
    if (button) {
      button.dataset.pending = '1';
      button.disabled = true;
    }
    window.clearTimeout(this.actionTimer);
    this.actionTimer = window.setTimeout(() => {
      this.clearAction();
      this.showError('The server did not answer in time. Check your connection and try again.');
    }, ACTION_TIMEOUT_MS);
  }

  clearAction() {
    window.clearTimeout(this.actionTimer);
    this.actionTimer = null;
    for (const button of document.querySelectorAll('[data-pending="1"]')) {
      button.disabled = false;
      delete button.dataset.pending;
    }
  }

  /* ──────────────────────────────── rooms ───────────────────────────────── */

  loadRooms(force = false) {
    if (this.rooms.status === 'loading' && !force) return;
    this.rooms = { ...this.rooms, status: 'loading', error: '' };
    this.renderRoomList();
    this.handlers.onListRooms?.();
    window.clearTimeout(this.roomListTimeout);
    this.roomListTimeout = window.setTimeout(() => {
      if (this.rooms.status !== 'loading') return;
      this.rooms = { ...this.rooms, status: 'error', error: 'No answer from the game server.' };
      this.renderRoomList();
    }, ACTION_TIMEOUT_MS);
  }

  startRoomPolling() {
    this.stopRoomPolling();
    this.roomPollTimer = window.setInterval(() => {
      if (this.screen === 'rooms' && !document.hidden) this.loadRooms();
    }, ROOM_POLL_INTERVAL_MS);
  }

  stopRoomPolling() {
    if (this.roomPollTimer) window.clearInterval(this.roomPollTimer);
    this.roomPollTimer = null;
  }

  setRoomList(payload) {
    if (!payload || !Array.isArray(payload.rooms)) {
      this.rooms = { ...this.rooms, status: 'error', error: 'Malformed room list from the server.' };
      this.renderRoomList();
      return;
    }
    this.rooms = { status: 'ready', entries: payload.rooms, error: '', receivedAt: payload.now ?? Date.now() };
    this.renderRoomList();
  }

  setRoomListError(message) {
    this.rooms = { ...this.rooms, status: 'error', error: String(message || 'Could not load rooms.') };
    this.renderRoomList();
  }

  renderRoomList() {
    const container = this.el['room-list'];
    if (!container) return;
    container.replaceChildren();
    const { status, entries, error } = this.rooms;

    if (status === 'loading' && !entries.length) {
      for (let index = 0; index < 3; index += 1) {
        const skeleton = document.createElement('div');
        skeleton.className = 'room-skeleton';
        container.append(skeleton);
      }
      return;
    }

    if (status === 'error') {
      const banner = document.createElement('div');
      banner.className = entries.length ? 'room-banner is-error' : 'room-empty';
      const title = document.createElement('strong');
      title.textContent = 'Room list unavailable';
      const copy = document.createElement('span');
      copy.textContent = entries.length
        ? `${error} Showing the last list received.`
        : error;
      const retry = document.createElement('button');
      retry.className = 'button button-secondary';
      retry.type = 'button';
      retry.textContent = 'TRY AGAIN';
      retry.addEventListener('click', () => this.loadRooms(true));
      banner.append(title, copy, retry);
      container.append(banner);
      if (!entries.length) return;
    }

    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'room-empty';
      const title = document.createElement('strong');
      title.textContent = 'No open lobbies right now';
      const copy = document.createElement('span');
      copy.textContent = 'Create a room and share its six-character code, or deploy solo against bots.';
      empty.append(title, copy);
      container.append(empty);
      return;
    }

    for (const room of entries) {
      const row = document.createElement('div');
      row.className = 'room-row';

      const code = document.createElement('span');
      code.className = 'room-code';
      code.textContent = room.code;

      const meta = document.createElement('span');
      meta.className = 'room-meta';
      const host = document.createElement('strong');
      host.textContent = `${room.hostName}’s lobby`;
      const detail = document.createElement('small');
      const arenaName = room.mapName ?? (room.mapId ? getMap(room.mapId).name : null);
      const rules = room.joinable
        ? `${room.mode === 'MULTIPLAYER' ? 'DEATHMATCH' : room.mode} · FIRST TO ${room.targetKills}`
        : `${room.state === 'LOBBY' ? 'FULL' : 'IN PROGRESS'} · FIRST TO ${room.targetKills}`;
      detail.textContent = arenaName ? `${arenaName} · ${rules}` : rules;
      meta.append(host, detail);

      const capacity = document.createElement('span');
      capacity.className = 'room-capacity';
      capacity.textContent = `${room.players}/${room.maxPlayers}`;

      const join = document.createElement('button');
      join.className = 'button button-secondary room-join';
      join.type = 'button';
      join.textContent = room.joinable ? 'JOIN' : 'LOCKED';
      join.disabled = !room.joinable;
      join.addEventListener('click', () => {
        this.playUiSound();
        this.beginAction('join-room-button');
        this.handlers.onJoin?.(this.playerName, room.code, this.selectedBundleId, this.profileId);
      });

      row.append(code, meta, capacity, join);
      container.append(row);
    }
  }

  /* ─────────────────────────────── bundles ─────────────────────────────── */

  get isGodsTierUnlocked() {
    return this.profile.godsTierUnlocked === true || this.profile.lifetimeKills >= BUNDLE_UNLOCK_KILLS;
  }

  renderBundles(container, { compact = false } = {}) {
    if (!container) return;
    container.replaceChildren();
    for (const bundle of BUNDLE_INFO) {
      const locked = bundle.id === 'GODS_TIER' && !this.isGodsTierUnlocked;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'bundle-card';
      card.dataset.bundleId = bundle.id;
      card.style.setProperty('--bundle-accent', bundle.accent);
      card.setAttribute('aria-pressed', String(this.selectedBundleId === bundle.id));
      card.disabled = locked;
      card.classList.toggle('is-locked', locked);
      card.classList.toggle('is-selected', this.selectedBundleId === bundle.id);
      card.addEventListener('click', () => this.selectBundle(bundle.id));

      const head = document.createElement('span');
      head.className = 'bundle-card-head';
      const name = document.createElement('strong');
      name.textContent = bundle.name;
      const state = document.createElement('small');
      state.className = 'bundle-select-label';
      state.textContent = 'EQUIPPED';
      head.append(name, state);

      const title = document.createElement('h3');
      title.textContent = bundle.title;

      const weapons = document.createElement('span');
      weapons.className = 'bundle-weapons';
      for (const weapon of bundle.weapons) {
        const row = document.createElement('span');
        row.className = 'bundle-weapon';
        const glyph = document.createElement('span');
        glyph.className = 'glyph';
        glyph.textContent = weapon.icon;
        const label = document.createElement('strong');
        label.textContent = weapon.name;
        const model = document.createElement('em');
        model.textContent = WEAPON_MODEL_FILE[weapon.id] ?? '';
        const role = document.createElement('small');
        role.textContent = weapon.role;
        row.append(glyph, label, role);
        if (!compact) row.append(model);
        weapons.append(row);
      }

      card.append(head, title, weapons);

      if (!compact) {
        const description = document.createElement('p');
        description.textContent = bundle.description;
        card.append(description);
      }

      if (bundle.id === 'GODS_TIER') {
        const lock = document.createElement('span');
        lock.className = 'bundle-lock';
        lock.textContent = locked
          ? `LOCKED · ${Math.max(0, BUNDLE_UNLOCK_KILLS - this.profile.lifetimeKills)} MORE LIFETIME ELIMS`
          : 'UNLOCKED · SERVER VERIFIED';
        card.append(lock);
      }

      container.append(card);
    }
  }

  selectBundle(bundleId) {
    const bundle = BUNDLE_BY_ID[bundleId];
    if (!bundle) return false;
    if (bundleId === 'GODS_TIER' && !this.isGodsTierUnlocked) {
      this.showToast(`GODS TIER unlocks at ${BUNDLE_UNLOCK_KILLS} lifetime eliminations.`);
      return false;
    }
    this.playUiSound();
    this.selectedBundleId = bundleId;
    localStorage.setItem('fps-gods-bundle', bundleId);
    this.renderBundles(this.el.bundleGrid, { compact: false });
    this.renderBundles(this.el.onboardingBundles, { compact: true });
    this.clearErrors();
    this.updateProfileChipsToBundle();
    this.refreshPlaySummary();
    this.renderProfile();
    this.handlers.onBundleChange?.(bundleId);
    this.showToast(`${bundle.name} equipped. The server validates it when you join.`);
    return true;
  }

  updateProfileChipsToBundle() {
    const bundle = BUNDLE_BY_ID[this.selectedBundleId] ?? BUNDLE_BY_ID[DEFAULT_BUNDLE_ID];
    this.el['play-bundle-tag'].textContent = bundle.name;
    this.el['play-loadout-line'].textContent = `${bundle.name} — ${bundle.weapons.map((weapon) => weapon.name).join(' · ')}`;
  }

  refreshPlaySummary() {
    const bundle = BUNDLE_BY_ID[this.selectedBundleId] ?? BUNDLE_BY_ID[DEFAULT_BUNDLE_ID];
    this.el['play-bundle-tag'].textContent = bundle.name;
    this.el['play-loadout-line'].textContent = `${bundle.name} — ${bundle.weapons.map((weapon) => weapon.name).join(' · ')}`;
  }

  /* ─────────────────────────────── profile ─────────────────────────────── */

  bindProfile() {
    this.el['profile-callsign-form'].addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = this.el['profile-callsign-input'].value.trim().slice(0, 16);
      if (!name) {
        this.setProfileMessage('Enter a callsign first.', true);
        return;
      }
      try {
        await this.handlers.onProfileCallsign?.(name);
        localStorage.setItem('fps-gods-callsign', this.profile.authenticated ? this.profile.callsign : name);
        const saved = this.profile.authenticated ? this.profile.callsign : name;
        this.el['player-name'].value = saved;
        this.el['profile-callsign'].textContent = saved;
        this.el['profile-avatar'].textContent = [...saved][0]?.toUpperCase() ?? 'R';
        this.el['profile-title'].textContent = saved;
        this.setProfileMessage('Callsign saved.', false);
      } catch (error) {
        this.setProfileMessage(error?.message || 'Could not update callsign.', true);
      }
    });
  }

  setProfileMessage(message, isError) {
    const target = this.el['profile-message'];
    target.textContent = message;
    target.className = `inline-message${isError ? ' is-error' : ' is-success'}`;
    target.hidden = false;
    window.clearTimeout(this.profileMessageTimer);
    this.profileMessageTimer = window.setTimeout(() => { target.hidden = true; }, 4_000);
  }

  bindAuth() {
    this.el['auth-email-form'].addEventListener('submit', async (event) => {
      event.preventDefault();
      const email = this.el['auth-email-input'].value.trim();
      if (!email) {
        this.setAuthMessage('Enter your email address first.', true);
        return;
      }
      this.setAuthBusy(true);
      try {
        await this.handlers.onRequestOtp?.(email);
        this.authState.pendingEmail = email;
        this.authState.step = 'verify';
        this.renderAuth();
        this.setAuthMessage('Verification code sent. Enter the 6-digit code from your inbox.', false);
        this.el['auth-code-input']?.focus?.();
      } catch (error) {
        this.setAuthMessage(error?.message || 'Could not send verification code.', true);
      } finally {
        this.setAuthBusy(false);
      }
    });

    this.el['auth-verify-form'].addEventListener('submit', async (event) => {
      event.preventDefault();
      const email = this.authState.pendingEmail || this.el['auth-email-input'].value.trim();
      const code = this.el['auth-code-input'].value.trim();
      if (!/^\d{6}$/.test(code)) {
        this.setAuthMessage('Enter the 6-digit numeric verification code.', true);
        return;
      }
      this.setAuthBusy(true);
      try {
        await this.handlers.onVerifyOtp?.({
          email,
          code,
          callsign: this.playerName || this.profile.callsign,
          selectedBundle: this.selectedBundleId,
        });
        this.el['auth-code-input'].value = '';
        this.authState.step = 'email';
        this.renderAuth();
        this.setAuthMessage('Signed in. Your SHARZS wallet and operator record are now persistent.', false);
      } catch (error) {
        this.setAuthMessage(error?.message || 'Invalid or expired verification code.', true);
      } finally {
        this.setAuthBusy(false);
      }
    });

    this.el['auth-back-email-button'].addEventListener('click', () => {
      this.playUiSound();
      this.authState.step = 'email';
      this.el['auth-code-input'].value = '';
      this.renderAuth();
      this.el['auth-email-input']?.focus?.();
    });

    this.el['auth-logout-button'].addEventListener('click', async () => {
      this.playUiSound();
      this.setAuthBusy(true);
      try {
        await this.handlers.onLogout?.();
        this.setAuthMessage('Signed out. Playing in isolated guest mode.', false);
      } catch (error) {
        this.setAuthMessage(error?.message || 'Sign-out failed.', true);
      } finally {
        this.setAuthBusy(false);
      }
    });
  }

  setAuthBusy(busy) {
    this.authState.loading = Boolean(busy);
    this.el['auth-send-code-button'].disabled = this.authState.loading || !this.authState.otpConfigured;
    this.el['auth-verify-button'].disabled = this.authState.loading;
    this.el['auth-logout-button'].disabled = this.authState.loading;
  }

  setAuthMessage(message, isError = false) {
    const target = this.el['auth-message'];
    if (!message) {
      target.hidden = true;
      target.textContent = '';
      return;
    }
    target.textContent = String(message);
    target.className = `inline-message${isError ? ' is-error' : ' is-success'}`;
    target.hidden = false;
  }

  setAuthStatus(status = {}) {
    if (!status || typeof status !== 'object') return;
    if (typeof status.otpConfigured === 'boolean') {
      this.authState.otpConfigured = status.otpConfigured;
    }
    if (typeof status.emailProvider === 'string') {
      this.authState.emailProvider = status.emailProvider;
    }
    if (Number.isSafeInteger(status.callsignChangeFee)) {
      const note = document.getElementById('callsign-fee-note');
      if (note) note.textContent = `Account callsign changes cost ${status.callsignChangeFee} SHARZS; cooldown ${Math.ceil((status.callsignCooldownSeconds || 0) / 86400)} days.`;
    }
    this.renderAuth();
  }

  setAuthRestoring(restoring) {
    this.authState.restoring = Boolean(restoring);
    this.renderAuth();
    this.renderWallet();
  }

  renderAuth() {
    const signedIn = this.profile.authenticated === true;
    this.el['auth-guest-panel'].hidden = signedIn || this.authState.restoring;
    this.el['auth-account-panel'].hidden = !signedIn;
    this.el['account-status-badge'].textContent = this.authState.restoring ? 'RESTORING SESSION…' : signedIn ? 'VERIFIED ACCOUNT' : 'GUEST SESSION';
    this.el['account-status-badge'].style.color = signedIn ? 'var(--ok)' : '';

    if (signedIn) {
      this.el['auth-account-email'].textContent = this.profile.emailMasked || 'Verified email';
      this.el['auth-account-matches'].textContent = `${this.profile.matchesPlayed ?? 0} matches · ${this.profile.matchesWon ?? 0} wins`;
      return;
    }

    const verifying = this.authState.step === 'verify';
    this.el['auth-email-form'].hidden = verifying;
    this.el['auth-verify-form'].hidden = !verifying;
    this.el['auth-send-code-button'].disabled = this.authState.loading || !this.authState.otpConfigured;
    if (!this.authState.otpConfigured) {
      this.el['auth-provider-note'].textContent = 'Email OTP delivery is not configured on this server yet (set RESEND_API_KEY and AUTH_EMAIL_FROM on the backend). Guest play remains fully active.';
    } else {
      this.el['auth-provider-note'].textContent = 'Sign in with a one-time 6-digit email code to persist your SHARZS wallet, callsign, and lifetime unlocks across devices.';
    }
  }

  setWallet(walletPayload, { loading = false, error = '' } = {}) {
    this.wallet.loading = Boolean(loading);
    this.wallet.error = String(error || '');
    if (walletPayload && typeof walletPayload === 'object') {
      const authed = Boolean(walletPayload.accountId) && walletPayload.authenticated !== false;
      this.wallet.authenticated = authed;
      this.wallet.balance = Math.max(0, Math.floor(Number(walletPayload.balance) || 0));
      this.wallet.lifetimeEarned = Math.max(0, Math.floor(Number(walletPayload.lifetimeEarned) || 0));
      this.wallet.recentTransactions = Array.isArray(walletPayload.recentTransactions)
        ? walletPayload.recentTransactions
        : [];
    }
    this.renderWallet();
  }

  renderWallet() {
    const signedIn = this.profile.authenticated === true || this.wallet.authenticated === true;
    const balanceLabel = this.authState.restoring ? 'RESTORING…' : this.wallet.loading
      ? 'SYNCING…'
      : this.wallet.error
        ? 'WALLET ERR'
        : signedIn
          ? `${formatCredits(this.wallet.balance, { compact: true })} SHARZS`
          : 'GUEST · 0 SHARZS';

    this.el['topbar-credits-value'].textContent = balanceLabel;
    this.el['topbar-credits-button'].classList.toggle('is-authenticated', signedIn);
    this.el['hud-credits-value'].textContent = signedIn
      ? `${formatCredits(this.wallet.balance, { compact: true })} SHARZS`
      : 'GUEST';
    this.el['profile-stat-credits'].textContent = signedIn
      ? formatCredits(this.wallet.balance, { includeName: true })
      : '◈ 0 (SIGN IN TO SAVE)';

    this.el['store-wallet-status'].textContent = this.wallet.loading
      ? 'SYNCING'
      : signedIn
        ? 'PERSISTENT'
        : 'GUEST';
    this.el['store-wallet-balance'].textContent = signedIn
      ? formatCredits(this.wallet.balance, { includeName: true })
      : '◈ 0 SHARZS (Guest)';
    this.el['store-wallet-lifetime'].textContent = formatCredits(this.wallet.lifetimeEarned);
    this.el['store-auth-button'].textContent = signedIn ? 'REFRESH WALLET' : 'SIGN IN TO SAVE SHARZS';

    const list = this.el['store-ledger-list'];
    list.replaceChildren();
    if (this.wallet.error) {
      const li = document.createElement('li');
      li.className = 'ledger-empty';
      li.textContent = this.wallet.error;
      list.append(li);
      return;
    }
    if (!signedIn) {
      const li = document.createElement('li');
      li.className = 'ledger-empty';
      li.textContent = 'Sign in with Email OTP on the Profile tab to earn and persist SHARZS.';
      list.append(li);
      return;
    }
    if (!this.wallet.recentTransactions.length) {
      const li = document.createElement('li');
      li.className = 'ledger-empty';
      li.textContent = 'No SHARZS earned yet. Complete matches or score eliminations to populate your ledger.';
      list.append(li);
      return;
    }
    const reasonLabels = {
      elimination: 'Elimination reward',
      assist: 'Combat assist bonus',
      match_completion: 'Match completion',
      match_victory: 'Match victory bonus',
      callsign_change: 'Callsign change',
    };
    for (const tx of this.wallet.recentTransactions.slice(0, 8)) {
      const li = document.createElement('li');
      li.className = 'ledger-row';
      const label = document.createElement('span');
      label.textContent = reasonLabels[tx.reason] ?? tx.reason;
      const gain = document.createElement('strong');
      gain.textContent = `${tx.amount > 0 ? '+' : ''}${tx.amount} SHARZS`;
      li.append(label, gain);
      list.append(li);
    }
  }

  showRewardEarned(reward) {
    if (!reward || !(reward.amount > 0)) return;
    const labels = {
      elimination: reward.headshot ? 'HEADSHOT ELIM' : 'ELIMINATION',
      assist: 'ASSIST',
      match_completion: 'MATCH COMPLETE',
      match_victory: 'VICTORY',
    };
    const pop = this.el['hud-reward-pop'];
    pop.textContent = `+${reward.amount} SHARZS · ${labels[reward.reason] ?? 'REWARD'}`;
    pop.hidden = false;
    pop.classList.add('is-active');
    window.clearTimeout(this.rewardPopTimer);
    this.rewardPopTimer = window.setTimeout(() => {
      pop.classList.remove('is-active');
      pop.hidden = true;
    }, 2_100);
  }

  renderProfile() {
    const { profile } = this;
    const kills = profile.lifetimeKills ?? 0;
    const unlocked = this.isGodsTierUnlocked;
    const bundle = BUNDLE_BY_ID[this.selectedBundleId] ?? BUNDLE_BY_ID[DEFAULT_BUNDLE_ID];
    const percent = Math.min(100, (kills / BUNDLE_UNLOCK_KILLS) * 100);

    this.el['profile-title'].textContent = profile.callsign || this.playerName || 'Operator';
    this.el['profile-key'].textContent = profile.profileId ?? 'not assigned yet';
    this.el['profile-stat-kills'].textContent = String(kills);
    this.el['profile-stat-unlock'].textContent = unlocked ? 'UNLOCKED' : 'LOCKED';
    this.el['profile-stat-unlock'].style.color = unlocked ? 'var(--ok)' : '';
    this.el['profile-stat-bundle'].textContent = bundle.name;
    this.el['profile-tier-tag'].textContent = unlocked ? 'GODS TIER' : 'TIER 1';
    this.el['profile-progress-value'].textContent = `${Math.min(kills, BUNDLE_UNLOCK_KILLS)} / ${BUNDLE_UNLOCK_KILLS}`;
    this.el['profile-progress-fill'].style.width = `${percent}%`;
    this.el['profile-server-target'].textContent = this.serverTarget ?? 'resolving…';
    this.el['profile-callsign-input'].value = profile.callsign || this.playerName || '';

    this.el['store-kills-value'].textContent = `${Math.min(kills, BUNDLE_UNLOCK_KILLS)} / ${BUNDLE_UNLOCK_KILLS}`;
    this.el['store-kills-fill'].style.width = `${percent}%`;
    this.el['inventory-kills-tag'].textContent = `${kills} LIFETIME`;
    this.el['profile-kills'].textContent = String(kills);
    this.el['profile-callsign'].textContent = profile.callsign || this.playerName || 'OPERATOR';
    this.el['profile-avatar'].textContent = [...(profile.callsign || this.playerName || 'R')][0]?.toUpperCase() ?? 'R';
  }

  setServerTarget(label) {
    this.serverTarget = label;
    this.el['play-server-line'].textContent = label;
    this.el['profile-server-target'].textContent = label;
  }

  setProfile(profile) {
    if (!profile || typeof profile !== 'object') return;
    const lifetimeKills = Math.max(0, Math.floor(Number(profile.lifetimeKills) || 0));
    const authenticated = profile.authenticated === true && Boolean(profile.accountId);
    this.profile = {
      profileId: typeof profile.profileId === 'string' ? profile.profileId : this.profile.profileId,
      accountId: authenticated ? profile.accountId : null,
      authenticated,
      emailMasked: authenticated ? String(profile.emailMasked || '') : '',
      callsign: typeof profile.callsign === 'string' && profile.callsign
        ? profile.callsign
        : this.profile.callsign,
      lifetimeKills,
      godsTierUnlocked: profile.godsTierUnlocked === true || lifetimeKills >= BUNDLE_UNLOCK_KILLS,
      matchesPlayed: Number(profile.matchesPlayed) || 0,
      matchesWon: Number(profile.matchesWon) || 0,
    };
    if (!authenticated && this.profile.profileId && !this.profile.profileId.startsWith('acct_')) {
      localStorage.setItem('fps-gods-profile-id', this.profile.profileId);
    }
    if (authenticated && this.profile.callsign) {
      this.el['player-name'].value = this.profile.callsign.slice(0, 16);
    }
    if (authenticated && typeof profile.selectedBundle === 'string' && BUNDLE_BY_ID[profile.selectedBundle]) {
      this.selectedBundleId = profile.selectedBundle;
    }
    if (this.selectedBundleId === 'GODS_TIER' && !this.isGodsTierUnlocked) {
      this.selectedBundleId = DEFAULT_BUNDLE_ID;
      localStorage.setItem('fps-gods-bundle', DEFAULT_BUNDLE_ID);
    }
    this.renderBundles(this.el.bundleGrid, { compact: false });
    this.renderBundles(this.el.onboardingBundles, { compact: true });
    this.renderProfile();
    this.renderAuth();
    this.renderWallet();
    this.updateProfileChipsToBundle();
  }

  resetToGuestProfile(guestProfileId = null) {
    this.profile = {
      profileId: guestProfileId,
      accountId: null,
      authenticated: false,
      emailMasked: '',
      callsign: localStorage.getItem('fps-gods-callsign') || this.playerName || 'Operator',
      lifetimeKills: 0,
      godsTierUnlocked: false,
      matchesPlayed: 0,
      matchesWon: 0,
    };
    if (this.selectedBundleId === 'GODS_TIER') {
      this.selectedBundleId = DEFAULT_BUNDLE_ID;
    }
    this.setWallet({ accountId: null, authenticated: false, balance: 0, lifetimeEarned: 0, recentTransactions: [] });
    this.renderBundles(this.el.bundleGrid, { compact: false });
    this.renderBundles(this.el.onboardingBundles, { compact: true });
    this.renderProfile();
    this.renderAuth();
    this.updateProfileChipsToBundle();
  }

  /* ──────────────────────────────── HUD ────────────────────────────────── */

  bindHud() {
    window.addEventListener('keydown', (event) => {
      if (event.code !== 'Tab' || event.repeat) return;
      if (this.el['match-hud'].hidden) return;
      event.preventDefault();
      this.setScoreboard(!this.scoreboardOpen);
    });
  }

  setConnectionState(state, detail = '') {
    const connected = state === 'connected';
    const offline = state === 'offline';
    const unreachable = state === 'unreachable';
    const pill = this.el['connection-pill'];
    pill.classList.toggle('is-connected', connected);
    pill.classList.toggle('is-offline', offline);
    pill.classList.toggle('is-unreachable', unreachable);
    const label = connected
      ? 'LIVE ARENA'
      : offline
        ? 'CONNECTION LOST'
        : unreachable
          ? 'SERVER OFFLINE'
          : 'CONNECTING';
    const changed = label !== this.el['connection-label'].textContent;
    this.el['connection-label'].textContent = label;
    if (connected) {
      this.lastConnectionToastAt = 0;
      this.clearAction();
    }

    const now = Date.now();
    if (!detail || connected || !changed
      || now - (this.lastConnectionToastAt ?? 0) < CONNECTION_TOAST_COOLDOWN_MS) return;
    this.lastConnectionToastAt = now;
    this.showToast(detail);
  }

  setMenuVisible(visible) {
    this.el['menu-shell'].hidden = !visible;
  }

  setLobbyVisible(visible) {
    this.el['lobby-shell'].hidden = !visible;
  }

  setMatchVisible(visible) {
    this.el['match-hud'].hidden = !visible;
    if (!visible) {
      this.setScoreboard(false);
      this.setAimPresentation(null);
      this.el['pause-panel'].hidden = true;
      this.el['death-panel'].hidden = true;
      this.el['weapon-wheel'].hidden = true;
      this.el['hud-reward-pop'].hidden = true;
      if (this.el['hud-elim-banner']) this.el['hud-elim-banner'].hidden = true;
    }
  }

  setAimPresentation(state = null) {
    const scopeOverlay = this.el['ads-scope-overlay'];
    const crosshair = this.el.crosshair;
    if (!state || !(state.rawAmount > 0.12)) {
      scopeOverlay.hidden = true;
      delete scopeOverlay.dataset.scope;
      delete crosshair.dataset.ads;
      crosshair.hidden = false;
      return;
    }
    if (state.scopeActive && (state.scope === 'optic' || state.scope === 'rail')) {
      scopeOverlay.hidden = false;
      scopeOverlay.dataset.scope = state.scope;
      this.el['ads-scope-label'].textContent = `${state.magnification ?? '4.0×'} ${state.scope === 'rail' ? 'RAIL OPTIC' : 'OPTIC'}`;
      crosshair.hidden = state.scope === 'optic';
      crosshair.dataset.ads = state.reticle || 'optic';
      return;
    }
    scopeOverlay.hidden = true;
    delete scopeOverlay.dataset.scope;
    crosshair.hidden = false;
    crosshair.dataset.ads = state.reticle || 'iron';
  }

  renderHudLoadoutStrip(bundleId, activeWeaponId) {
    const strip = this.el['hud-loadout-strip'];
    if (!strip) return;
    const key = `${bundleId}:${activeWeaponId}`;
    if (this.lastLoadoutStripKey === key) return;
    this.lastLoadoutStripKey = key;
    const bundle = BUNDLE_BY_ID[bundleId] ?? BUNDLE_BY_ID[DEFAULT_BUNDLE_ID];
    strip.replaceChildren();
    bundle.weapons.forEach((weapon, idx) => {
      const slot = document.createElement('span');
      slot.className = `loadout-slot${weapon.id === activeWeaponId ? ' is-active' : ''}`;
      const num = document.createElement('kbd');
      num.textContent = String(idx + 1);
      const glyph = document.createElement('em');
      glyph.className = 'loadout-slot-glyph';
      glyph.textContent = weapon.icon ?? '';
      const name = document.createElement('strong');
      name.textContent = weapon.name;
      slot.append(num, glyph, name);
      strip.append(slot);
    });
  }

  setPing(rttMs) {
    if (!this.el['ping-value']) return;
    const safe = Number.isFinite(rttMs) && rttMs > 0 ? Math.round(rttMs) : 0;
    this.el['ping-value'].textContent = `${safe} MS`;
  }

  showLobby(room = this.room, selfId = this.selfId) {
    if (!room) return;
    this.room = room;
    this.selfId = selfId;
    this.stopRoomPolling();
    this.setMenuVisible(false);
    this.setMatchVisible(false);
    this.setLobbyVisible(true);
    this.clearErrors();

    this.el['lobby-room-code'].textContent = room.code;
    this.el['lobby-room-code-small'].textContent = room.code;
    this.el['lobby-mode-tag'].textContent = room.mode === ROOM_MODES.SOLO_VS_BOTS ? 'SOLO' : 'MULTIPLAYER';

    const list = this.el['lobby-player-list'];
    list.replaceChildren();
    const connectedPlayers = room.players.filter((player) => player.connected !== false);
    const everyoneReady = connectedPlayers.length >= (room.minPlayers ?? 2)
      && room.players.length === connectedPlayers.length
      && room.players.every((player) => player.ready);
    const isHost = room.hostId === selfId;
    const self = room.players.find((player) => player.id === selfId);

    for (const player of room.players) {
      const row = document.createElement('li');
      row.className = `lobby-player-row${player.connected === false ? ' is-offline' : ''}`;

      const identity = document.createElement('span');
      identity.className = 'lobby-identity';
      const avatar = document.createElement('span');
      avatar.className = 'player-avatar';
      avatar.style.setProperty('--player-color', player.color);
      avatar.textContent = [...player.name][0]?.toUpperCase() ?? '?';
      const copy = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = player.name;
      const sub = document.createElement('small');
      sub.textContent = player.id === selfId ? 'YOU' : player.isBot ? 'BOT' : 'OPERATOR';
      copy.append(name, document.createElement('br'), sub);
      identity.append(avatar, copy);

      const bundle = document.createElement('span');
      bundle.className = 'lobby-bundle';
      bundle.textContent = BUNDLE_BY_ID[player.bundleId]?.name ?? 'BUNDLE';

      const status = document.createElement('span');
      status.className = 'player-status';
      if (player.connected === false) {
        status.classList.add('is-offline');
        status.textContent = 'OFFLINE';
      } else if (player.id === room.hostId) {
        status.classList.add('is-host');
        status.textContent = 'HOST';
      } else if (player.ready) {
        status.classList.add('is-ready');
        status.textContent = 'READY';
      } else {
        status.textContent = 'WAITING';
      }

      row.append(identity, bundle, status);
      list.append(row);
    }

    // The arena is whatever the server says it is: a joining player never
    // overrides the host's choice locally.
    this.renderLobbyArena(room, { isHost });

    this.el['ready-button'].textContent = self?.ready ? 'CANCEL READY' : 'MARK READY';
    this.el['ready-button'].disabled = self?.connected === false;
    this.el['start-button'].hidden = !isHost;
    this.el['start-button'].disabled = !everyoneReady;
    this.el['lobby-hint'].textContent = !isHost
      ? 'The host launches once every operator is ready.'
      : everyoneReady
        ? 'Everyone is ready. Launch when you are.'
        : `At least ${room.minPlayers ?? 2} operators, all ready. ${room.players.length}/${room.maxPlayers ?? 16} connected.`;
    this.el['player-name']?.blur?.();
    this.clearAction();
  }

  showMatch(room = this.room) {
    if (room) this.room = room;
    this.setLobbyVisible(false);
    this.setMenuVisible(false);
    this.setMatchVisible(true);
    this.el['hud-room-code'].textContent = room?.code ?? '------';
    this.el['scoreboard-room'].textContent = room?.code ?? '------';
    this.el['target-kills'].textContent = String(room?.targetKills ?? 30);
    this.setArena(getMap(room?.mapId ?? this.selectedMapId));
    this.syncBotDifficultyUI(room?.botDifficulty ?? null);
    this.lastHealth = null;
  }

  resetQuitConfirmation() {
    this.quitConfirmation = false;
    this.el['quit-match-note'].hidden = true;
    this.el['quit-match-note'].textContent = 'Press QUIT TO MENU again to confirm.';
    this.el['quit-match-button'].textContent = 'QUIT TO MENU';
    this.el['quit-match-button'].disabled = false;
    this.el['resume-button'].disabled = false;
  }

  setPaused(paused) {
    if (this.el['match-hud'].hidden) {
      this.el['pause-panel'].hidden = true;
      return;
    }
    this.syncBotDifficultyUI(this.room?.botDifficulty ?? null);
    this.el['pause-panel'].hidden = !paused;
    if (!paused) this.resetQuitConfirmation();
  }

  updateHud(player, estimatedServerNow = Date.now(), aliveCount = 0) {
    if (!player) return;
    this.lastHudPlayer = player;
    const maxHealth = player.maxHealth || 100;
    const health = Math.max(0, Math.min(maxHealth, player.health ?? maxHealth));
    const percent = (health / maxHealth) * 100;

    if (this.lastHealth !== null && health < this.lastHealth) this.flashDamage();
    this.lastHealth = health;

    this.el['health-value'].textContent = String(Math.ceil(health));
    this.el['health-fill'].style.width = `${percent}%`;
    this.el.healthTrack.classList.toggle('is-low', percent <= 32);
    const state = health <= 0 ? 'DOWN' : percent <= 32 ? 'CRITICAL' : 'READY';
    this.el['health-state'].textContent = state;
    this.el.vitalState.classList.toggle('is-low', percent <= 32);
    this.el['shield-state'].textContent = player.spawnProtected ? 'SPAWN SHIELD ACTIVE' : player.blocking ? 'FRONTAL GUARD ACTIVE' : 'NO SHIELD';
    this.el['spawn-note'].textContent = player.alive ? `ALIVE · ${aliveCount}` : 'REDEPLOYING';
    this.el['alive-count'].textContent = String(aliveCount);

    const weaponId = player.currentWeaponId ?? 'SMG';
    const weapon = WEAPON_PRESENTATION[weaponId];
    this.renderHudLoadoutStrip(player.bundleId ?? this.selectedBundleId, weaponId);
    const noMagazine = !player.unlimitedAmmo && !(player.maxAmmo > 0);
    this.el['weapon-name'].textContent = player.currentWeaponName ?? weapon?.name ?? weaponId;
    this.el['weapon-bundle'].textContent = BUNDLE_BY_ID[player.bundleId]?.name ?? 'BUNDLE';
    this.el['ammo-mode'].textContent = player.auto ? 'AUTO' : 'SEMI';
    const currentAmmo = player.unlimitedAmmo || noMagazine ? null : (player.ammo ?? 0);
    if (currentAmmo !== null && this.lastAmmoCount !== null && currentAmmo < this.lastAmmoCount) {
      this.el['ammo-value'].classList.add('is-pop');
      window.clearTimeout(this.ammoPopTimer);
      this.ammoPopTimer = window.setTimeout(() => this.el['ammo-value']?.classList.remove('is-pop'), 95);
    }
    this.lastAmmoCount = currentAmmo;

    this.el['ammo-value'].textContent = player.unlimitedAmmo ? '∞' : noMagazine ? '—' : String(player.ammo ?? 0);
    this.el['ammo-total'].textContent = player.unlimitedAmmo
      ? '∞'
      : noMagazine
        ? '—'
        : String(player.totalAmmo ?? ((player.ammo ?? 0) + (player.reserveAmmo ?? 0)));

    const lowAmmo = !player.unlimitedAmmo && !noMagazine && player.maxAmmo > 0
      && (player.ammo ?? 0) > 0 && (player.ammo / player.maxAmmo) <= 0.25;
    this.el.ammoWidget.classList.toggle('is-reloading', Boolean(player.reloading));
    this.el.ammoWidget.classList.toggle('is-overheated', Boolean(player.overheated));
    this.el.ammoWidget.classList.toggle('is-low', lowAmmo);
    this.el.ammoWidget.classList.toggle(
      'is-empty',
      !player.unlimitedAmmo && !noMagazine && (player.ammo ?? 0) <= 0,
    );

    this.el['ammo-status'].textContent = player.reloading
      ? 'RELOADING'
      : player.overheated
        ? 'OVERHEATED'
        : weaponId === 'COMBAT_SHIELD'
          ? (player.blocking ? 'GUARD UP' : 'HOLD RMB TO GUARD')
          : weaponId === 'KNIFE' || weaponId === 'GOD_FIST'
            ? 'MELEE'
            : (player.ammo ?? 0) <= 0 && !noMagazine
              ? 'EMPTY'
              : 'READY';
    this.el['reload-hint'].textContent = player.overheated
      ? 'COOLING DOWN'
      : player.reloading
        ? 'MAGAZINE INBOUND'
        : noMagazine
          ? 'Q WEAPON WHEEL'
          : 'R RELOAD';

    if (!player.alive && player.respawnAt) {
      this.el['death-panel'].hidden = false;
      this.el['pause-panel'].hidden = true;
      const remaining = Math.max(0, player.respawnAt - estimatedServerNow) / 1_000;
      this.el['respawn-countdown'].textContent = remaining.toFixed(1);
    } else if (player.alive) {
      this.el['death-panel'].hidden = true;
    }
  }

  flashDamage() {
    const vignette = this.el['damage-vignette'];
    vignette.classList.add('is-active');
    window.clearTimeout(this.damageTimer);
    this.damageTimer = window.setTimeout(() => vignette.classList.remove('is-active'), 140);
  }

  setFps(value) {
    this.fps = value;
    this.el['fps-value'].textContent = `${Math.round(value)} FPS`;
    this.el['fps-value'].hidden = !this.settings.showFps;
  }

  updateScoreboard(players, localId = this.selfId) {
    if (!Array.isArray(players)) return;
    this.latestScoreboard = { players, localId };
    if (!this.scoreboardOpen) return;

    const sorted = [...players].sort((left, right) => right.kills - left.kills
      || left.deaths - right.deaths || left.name.localeCompare(right.name));
    const signature = sorted.map((player) => [
      player.id, player.kills, player.deaths, player.alive, player.connected, player.isBot,
    ].join(':')).join('|');
    if (signature === this.scoreboardSignature) return;
    this.scoreboardSignature = signature;

    const body = this.el['scoreboard-body'];
    body.replaceChildren();
    sorted.forEach((player, index) => {
      const row = document.createElement('div');
      row.className = `scoreboard-row${player.id === localId ? ' is-self' : ''}`;

      const identity = document.createElement('div');
      identity.className = 'scoreboard-player';
      const rank = document.createElement('span');
      rank.className = 'scoreboard-rank';
      rank.textContent = String(index + 1).padStart(2, '0');
      const swatch = document.createElement('span');
      swatch.className = 'scoreboard-swatch';
      swatch.style.setProperty('--player-color', player.color || '#59d8ff');
      const name = document.createElement('span');
      name.className = 'scoreboard-player-name';
      name.textContent = player.name;
      identity.append(rank, swatch, name);
      if (player.isBot) {
        const tag = document.createElement('span');
        tag.className = 'scoreboard-bot-tag';
        tag.textContent = 'BOT';
        identity.append(tag);
      }

      const kills = document.createElement('span');
      kills.textContent = String(player.kills ?? 0);
      const deaths = document.createElement('span');
      deaths.textContent = String(player.deaths ?? 0);
      const status = document.createElement('span');
      status.className = `scoreboard-status${player.connected === false ? ' is-offline' : player.alive === false ? ' is-down' : ''}`;
      status.textContent = player.connected === false ? 'OFFLINE' : player.alive === false ? 'DOWN' : 'ACTIVE';
      row.append(identity, kills, deaths, status);
      body.append(row);
    });
  }

  setScoreboard(open) {
    this.scoreboardOpen = Boolean(open);
    this.el['scoreboard-panel'].hidden = !this.scoreboardOpen;
    if (this.scoreboardOpen) {
      this.scoreboardSignature = null;
      if (this.latestScoreboard) {
        this.updateScoreboard(this.latestScoreboard.players, this.latestScoreboard.localId);
      }
    }
  }

  addKillFeed(entry, localId = this.selfId) {
    const row = document.createElement('div');
    row.className = `kill-feed-entry${entry.killerId === localId ? ' is-self' : ''}`;
    const killer = document.createElement('span');
    killer.className = 'feed-killer';
    killer.textContent = entry.killerName;
    const cross = document.createElement('span');
    cross.className = 'feed-cross';
    cross.textContent = '×';
    const victim = document.createElement('span');
    victim.className = 'feed-victim';
    victim.textContent = entry.victimName;
    row.append(killer, cross, victim);
    if (entry.headshot) {
      const tag = document.createElement('span');
      tag.className = 'feed-headshot';
      tag.textContent = 'HEADSHOT';
      row.append(tag);
    }

    this.el['kill-feed'].prepend(row);
    while (this.el['kill-feed'].children.length > 6) this.el['kill-feed'].lastElementChild.remove();
    const fadeTimer = window.setTimeout(() => row.classList.add('is-fading'), 3_400);
    const removeTimer = window.setTimeout(() => {
      row.remove();
      this.feedTimers.delete(row);
    }, 3_900);
    this.feedTimers.set(row, [fadeTimer, removeTimer]);
  }

  showHitMarker(hit) {
    if (!hit?.hit) {
      if (hit?.weaponId === 'KNIFE' || hit?.weaponId === 'GOD_FIST') {
        const crosshair = this.el.crosshair;
        crosshair.classList.add('is-melee-miss');
        window.clearTimeout(this.hitMarkerTimer);
        this.hitMarkerTimer = window.setTimeout(() => crosshair.classList.remove('is-melee-miss'), 300);
      }
      return;
    }
    this.el.crosshair.classList.remove('is-melee-miss');
    const crosshair = this.el.crosshair;
    crosshair.classList.remove('is-hit', 'is-kill', 'is-headshot', 'is-blocked');
    if (hit.protected || hit.blockedByShield) {
      crosshair.classList.add('is-blocked');
    } else if (hit.killed) {
      crosshair.classList.add('is-kill');
    } else {
      crosshair.classList.add('is-hit');
    }
    if (hit.headshot && !hit.protected && !hit.blockedByShield) {
      crosshair.classList.add('is-headshot');
    }
    window.clearTimeout(this.hitMarkerTimer);
    this.hitMarkerTimer = window.setTimeout(
      () => crosshair.classList.remove('is-hit', 'is-kill', 'is-headshot', 'is-blocked'),
      hit.killed ? 240 : 180,
    );
  }

  /**
   * Compact authoritative elimination banner triggered strictly by server
   * `KILL_FEED_UPDATE` when `entry.killerId === localId`.
   */
  showEliminationBanner(entry) {
    const banner = this.el['hud-elim-banner'];
    if (!banner || !entry?.victimName) return;
    banner.replaceChildren();
    const kicker = document.createElement('span');
    kicker.className = 'elim-kicker';
    kicker.textContent = 'ELIMINATED';
    const victim = document.createElement('strong');
    victim.className = 'elim-victim';
    victim.textContent = entry.victimName;
    banner.append(kicker, victim);
    if (entry.headshot) {
      const hs = document.createElement('em');
      hs.className = 'elim-headshot';
      hs.textContent = 'HEADSHOT';
      banner.append(hs);
    }
    banner.hidden = false;
    banner.classList.remove('is-active');
    void banner.offsetWidth;
    banner.classList.add('is-active');
    window.clearTimeout(this.elimBannerTimer);
    this.elimBannerTimer = window.setTimeout(() => {
      banner.classList.remove('is-active');
      banner.hidden = true;
    }, 1_650);
  }

  showGameEnd(data, localId = this.selfId) {
    const winner = data?.winner ?? null;
    this.el['end-panel'].hidden = false;
    this.el['pause-panel'].hidden = true;
    this.el['death-panel'].hidden = true;
    this.el['scoreboard-panel'].hidden = true;
    this.scoreboardOpen = false;

    this.el['end-kicker'].textContent = data?.reason ? 'MATCH STOPPED' : 'MATCH COMPLETE';
    this.el['winner-name'].textContent = winner?.name ?? 'NO CONTEST';
    this.el['winner-summary'].textContent = winner
      ? `${winner.kills ?? 0} eliminations secured${winner.id === localId ? ' — that was you.' : '.'}`
      : data?.reason ?? 'The match ended without a winner.';
    this.renderEndScoreboard(data?.scoreboard ?? []);

    const solo = (data?.mode ?? this.room?.mode) === ROOM_MODES.SOLO_VS_BOTS;
    const isHost = this.room?.hostId === localId;
    this.el['return-lobby-button'].textContent = solo ? 'REDEPLOY' : 'RETURN TO LOBBY';
    this.el['return-lobby-button'].hidden = !isHost;
    this.el['end-waiting'].hidden = isHost;
  }

  renderEndScoreboard(players) {
    const container = this.el['end-scoreboard'];
    container.replaceChildren();
    [...players].slice(0, 5).forEach((player, index) => {
      const row = document.createElement('div');
      row.className = 'end-score-row';
      const name = document.createElement('span');
      name.className = index === 0 ? 'champion-name' : '';
      name.textContent = `${index + 1}. ${player.name}${player.isBot ? ' [BOT]' : ''}`;
      const kills = document.createElement('span');
      kills.textContent = `${player.kills} K`;
      const deaths = document.createElement('span');
      deaths.textContent = `${player.deaths} D`;
      row.append(name, kills, deaths);
      container.append(row);
    });
  }

  /* ───────────────────────────── weapon wheel ───────────────────────────── */

  openWeaponWheel(bundleId = this.selectedBundleId, currentWeaponId = null) {
    const bundle = BUNDLE_BY_ID[bundleId] ?? BUNDLE_BY_ID[DEFAULT_BUNDLE_ID];
    this.wheelWeapons = bundle.weapons;
    this.activeWheelWeaponId = currentWeaponId ?? bundle.weapons[0]?.id ?? null;
    this.selectedWheelWeaponId = this.activeWheelWeaponId;
    const container = this.el['weapon-wheel-options'];
    container.replaceChildren();
    for (const weapon of this.wheelWeapons) {
      const option = document.createElement('div');
      option.className = 'wheel-option';
      option.dataset.weaponId = weapon.id;
      option.classList.toggle('is-current', weapon.id === this.activeWheelWeaponId);
      const glyph = document.createElement('span');
      glyph.className = 'glyph';
      glyph.textContent = weapon.icon;
      const name = document.createElement('span');
      name.textContent = weapon.name;
      option.append(glyph, name);
      container.append(option);
    }
    this.el['wheel-center-name'].textContent = WEAPON_PRESENTATION[this.activeWheelWeaponId]?.name ?? '—';
    this.el['wheel-center-state'].textContent = 'ACTIVE';
    this.el['weapon-wheel'].hidden = false;
    this.paintWheelSelection();
  }

  paintWheelSelection() {
    for (const option of this.el['weapon-wheel-options'].children) {
      const selected = option.dataset.weaponId === this.selectedWheelWeaponId;
      option.classList.toggle('is-selected', selected);
      if (selected) {
        this.el['wheel-center-name'].textContent = WEAPON_PRESENTATION[option.dataset.weaponId]?.name ?? '—';
        this.el['wheel-center-state'].textContent = option.dataset.weaponId === this.activeWheelWeaponId
          ? 'ACTIVE'
          : 'SELECT';
      }
    }
  }

  selectWeaponByDirection(x, y) {
    if (!this.wheelWeapons.length) return;
    const distance = Math.hypot(x, y);
    if (distance < 18) return;
    const angle = Math.atan2(y, x);
    const normalized = (angle + Math.PI * 2.5) % (Math.PI * 2);
    const index = Math.round((normalized / (Math.PI * 2)) * this.wheelWeapons.length) % this.wheelWeapons.length;
    const weapon = this.wheelWeapons[index];
    if (!weapon || weapon.id === this.selectedWheelWeaponId) return;
    this.selectedWheelWeaponId = weapon.id;
    this.paintWheelSelection();
  }

  closeWeaponWheel() {
    this.el['weapon-wheel'].hidden = true;
    const selected = this.selectedWheelWeaponId;
    this.wheelWeapons = [];
    this.selectedWheelWeaponId = null;
    this.activeWheelWeaponId = null;
    return selected;
  }

  /* ─────────────────────────── messaging ──────────────────────────────── */

  activeErrorTarget() {
    if (!this.el['lobby-shell'].hidden) return this.el['room-error'];
    if (this.screen === 'rooms') return this.el['rooms-error'];
    if (this.screen === 'inventory') return this.el['inventory-error'];
    if (this.screen === 'profile') return this.el['profile-message'];
    if (!this.el.onboarding.hidden && !this.el['onboarding-loadout'].hidden) return this.el['bundle-error'];
    if (!this.el.onboarding.hidden) return this.el['callsign-error'];
    return this.el['play-error'];
  }

  showError(message) {
    this.clearAction();
    const target = this.activeErrorTarget();
    this.clearErrors();
    target.textContent = String(message || 'Something went wrong. Please try again.');
    target.className = 'inline-message is-error';
    target.hidden = false;
  }

  clearErrors() {
    for (const id of ['play-error', 'rooms-error', 'inventory-error', 'room-error', 'callsign-error', 'bundle-error']) {
      const node = this.el[id];
      if (!node) continue;
      node.hidden = true;
      node.textContent = '';
    }
  }

  showToast(message) {
    this.el.toast.textContent = String(message);
    this.el.toast.classList.add('is-visible');
    window.clearTimeout(this.toastTimeout);
    this.toastTimeout = window.setTimeout(() => this.el.toast.classList.remove('is-visible'), 3_200);
  }

  showWebGLWarning() {
    this.el['webgl-warning'].hidden = false;
  }

  /**
   * Persistent, specific notice that a required GLB did not load. A transient
   * toast was not enough: a missing operator model silently degrades every
   * operator in the match, and the only evidence used to be in the console.
   */
  showAssetWarning(lines = [], { title = 'ASSET LOAD FAILURE', note = '' } = {}) {
    const items = Array.isArray(lines) ? lines.filter(Boolean) : [String(lines)].filter(Boolean);
    if (!items.length) {
      this.hideAssetWarning();
      return;
    }
    this.el['asset-warning-title'].textContent = title;
    this.el['asset-warning-note'].textContent = note
      || 'A required 3D asset is missing from this deployment, so the match is running on fallbacks.';
    this.el['asset-warning-list'].replaceChildren();
    for (const line of items) {
      const item = document.createElement('li');
      item.textContent = line;
      this.el['asset-warning-list'].append(item);
    }
    this.el['asset-warning'].hidden = false;
  }

  hideAssetWarning() {
    this.el['asset-warning'].hidden = true;
  }

  setLoadingProgress(progress) {
    if (!progress) return;
    const percent = Math.min(100, Math.round((progress.loaded / Math.max(1, progress.total)) * 100));
    this.el['loading-label'].textContent = progress.label ?? 'LOADING';
    this.el['loading-fill'].style.width = `${percent}%`;
  }

  finishLoading() {
    this.el['loading-overlay'].classList.add('is-done');
    window.setTimeout(() => { this.el['loading-overlay'].hidden = true; }, 500);
  }

  async copyRoomCode() {
    const code = this.room?.code;
    if (!code) return;
    const url = `${window.location.origin}${window.location.pathname}?room=${code}`;
    try {
      await navigator.clipboard.writeText(url);
      this.showToast(`Room link copied — ${url}`);
    } catch {
      this.showToast(`Room code: ${code}`);
    }
  }

  /* ─────────────────────────────── identity ───────────────────────────── */

  get playerName() {
    return this.el['player-name'].value.trim().slice(0, 16);
  }

  get profileId() {
    return this.profile.profileId;
  }

  get bundleId() {
    return this.selectedBundleId;
  }

  loadCallsign() {
    const saved = localStorage.getItem('fps-gods-callsign');
    if (saved) this.el['player-name'].value = saved.slice(0, 16);
  }

  setHandlers(handlers) {
    this.handlers = { ...this.handlers, ...handlers };
  }

  dispose() {
    this.stopRoomPolling();
    window.clearTimeout(this.actionTimer);
    window.clearTimeout(this.toastTimeout);
    window.clearTimeout(this.hitMarkerTimer);
    window.clearTimeout(this.damageTimer);
    window.clearTimeout(this.rewardPopTimer);
    window.clearTimeout(this.elimBannerTimer);
    window.clearTimeout(this.ammoPopTimer);
    for (const timers of this.feedTimers.values()) timers.forEach((timer) => window.clearTimeout(timer));
    this.feedTimers.clear();
  }
}
