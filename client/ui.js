import { BUNDLE_BY_ID, BUNDLE_INFO, BUNDLE_UNLOCK_KILLS, DEFAULT_BUNDLE_ID, WEAPON_PRESENTATION } from '../shared/bundles.js';
import { ROOM_MODES } from '../shared/events.js';

// Minimum gap between connection toasts. The badge is the persistent signal; the
// toast only has to land once per verdict change.
const CONNECTION_TOAST_COOLDOWN_MS = 6_000;

// All presentation is plain DOM/CSS. Socket payloads are inserted with
// textContent rather than HTML so player names never become markup.
export class GameUI {
  constructor({ profileId } = {}) {
    this.handlers = {};
    this.room = null;
    this.profile = { profileId: profileId ?? null, lifetimeKills: 0, godsTierUnlocked: false };
    const savedBundle = localStorage.getItem('fps-gods-bundle');
    this.selectedBundleId = BUNDLE_BY_ID[savedBundle] ? savedBundle : DEFAULT_BUNDLE_ID;
    this.wheelWeapons = [];
    this.activeWheelWeaponId = null;
    this.selectedWheelWeaponId = null;
    this.selfId = null;
    this.scoreboardOpen = false;
    this.toastTimeout = null;
    this.feedTimers = new Map();
    this.lastHudPlayer = null;
    this.latestScoreboard = null;
    this.scoreboardSignature = null;

    this.elements = {
      shell: document.querySelector('.app-shell'),
      callsignScreen: document.querySelector('#callsign-screen'),
      callsignContinue: document.querySelector('#callsign-continue-button'),
      callsignError: document.querySelector('#callsign-error'),
      cryzenNav: document.querySelector('#cryzen-nav'),
      modeSelectorModal: document.querySelector('#mode-selector-modal'),
      modeCards: document.querySelectorAll('.mode-card'),
      modeSelectorClose: document.querySelector('#mode-selector-close'),
      roomUrlDisplay: document.querySelector('#room-url-display'),
      roomUrlText: document.querySelector('#room-url-text'),
      bundleScreen: document.querySelector('#bundle-screen'),
      bundleOptions: document.querySelector('#bundle-options'),
      bundleBack: document.querySelector('#bundle-back-button'),
      bundleContinue: document.querySelector('#bundle-continue-button'),
      bundleError: document.querySelector('#bundle-error'),
      lifetimeKills: document.querySelector('#lifetime-kills'),
      godsUnlockProgress: document.querySelector('#gods-unlock-progress'),
      home: document.querySelector('#home-screen'),
      lobby: document.querySelector('#lobby-screen'),
      match: document.querySelector('#match-hud'),
      connection: document.querySelector('#connection-pill'),
      connectionLabel: document.querySelector('#connection-label'),
      name: document.querySelector('#player-name'),
      roomCodeInput: document.querySelector('#room-code-input'),
      playNow: document.querySelector('#play-now-button'),
      create: document.querySelector('#create-room-button'),
      joinForm: document.querySelector('#join-room-form'),
      homeError: document.querySelector('#home-error'),
      roomError: document.querySelector('#room-error'),
      lobbyCode: document.querySelector('#lobby-room-code'),
      lobbyCodeSmall: document.querySelector('#lobby-room-code-small'),
      copyCode: document.querySelector('#copy-room-code-button'),
      playerList: document.querySelector('#lobby-player-list'),
      playerCount: document.querySelector('#player-count'),
      leaveRoom: document.querySelector('#leave-room-button'),
      ready: document.querySelector('#ready-button'),
      start: document.querySelector('#start-button'),
      lobbyHint: document.querySelector('#lobby-hint'),
      hudCode: document.querySelector('#hud-room-code'),
      targetKills: document.querySelector('#target-kills'),
      aliveCount: document.querySelector('#alive-count'),
      healthValue: document.querySelector('#health-value'),
      healthFill: document.querySelector('#health-fill'),
      healthTrack: document.querySelector('.health-track'),
      healthState: document.querySelector('#health-state'),
      ammo: document.querySelector('#ammo-value'),
      ammoTotal: document.querySelector('#ammo-total'),
      ammoStatus: document.querySelector('#ammo-status'),
      ammoWidget: document.querySelector('.ammo-widget'),
      reloadHint: document.querySelector('#reload-hint'),
      weaponIcon: document.querySelector('#weapon-icon'),
      weaponName: document.querySelector('#weapon-name'),
      weaponBundle: document.querySelector('#weapon-bundle'),
      weaponWheel: document.querySelector('#weapon-wheel'),
      weaponWheelOptions: document.querySelector('#weapon-wheel-options'),
      wheelCenterIcon: document.querySelector('#wheel-center-icon'),
      wheelCenterName: document.querySelector('#wheel-center-name'),
      wheelCenterState: document.querySelector('#wheel-center-state'),
      killFeed: document.querySelector('#kill-feed'),
      crosshair: document.querySelector('#crosshair'),
      pause: document.querySelector('#pause-panel'),
      resume: document.querySelector('#resume-button'),
      death: document.querySelector('#death-panel'),
      countdown: document.querySelector('#respawn-countdown'),
      scoreboard: document.querySelector('#scoreboard-panel'),
      scoreboardBody: document.querySelector('#scoreboard-body'),
      scoreboardRoom: document.querySelector('#scoreboard-room'),
      end: document.querySelector('#end-panel'),
      winner: document.querySelector('#winner-name'),
      winnerSummary: document.querySelector('#winner-summary'),
      endScoreboard: document.querySelector('#end-scoreboard'),
      returnLobby: document.querySelector('#return-lobby-button'),
      endWaiting: document.querySelector('#end-waiting'),
      toast: document.querySelector('#toast'),
      webglWarning: document.querySelector('#webgl-warning'),
    };

    this.loadCallsign();
    this.buildBundleOptions();
    this.bindControls();
    this.bindCryzenNavigation();
    this.showCallsign();
  }

  buildBundleOptions() {
    this.elements.bundleOptions.replaceChildren();
    const godsUnlocked = this.profile.godsTierUnlocked === true
      || this.profile.lifetimeKills >= BUNDLE_UNLOCK_KILLS;

    for (const bundle of BUNDLE_INFO) {
      const locked = bundle.id === 'GODS_TIER' && !godsUnlocked;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `bundle-card${locked ? ' is-locked' : ''}`;
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', String(this.selectedBundleId === bundle.id));
      card.disabled = locked;
      card.style.setProperty('--bundle-accent', bundle.accent);
      card.dataset.bundleId = bundle.id;

      const heading = document.createElement('span');
      heading.className = 'bundle-card-heading';
      const name = document.createElement('strong');
      name.textContent = bundle.name;
      const state = document.createElement('small');
      state.textContent = locked ? 'LOCKED' : this.selectedBundleId === bundle.id ? 'SELECTED' : 'AVAILABLE';
      heading.append(name, state);

      const title = document.createElement('span');
      title.className = 'bundle-card-title';
      title.textContent = bundle.title;
      const description = document.createElement('span');
      description.className = 'bundle-card-description';
      description.textContent = bundle.description;

      const weaponList = document.createElement('span');
      weaponList.className = 'bundle-weapon-list';
      for (const weapon of bundle.weapons) {
        const row = document.createElement('span');
        row.className = 'bundle-weapon-row';
        const icon = document.createElement('span');
        icon.className = 'bundle-weapon-icon';
        icon.textContent = weapon.icon;
        const copy = document.createElement('span');
        copy.className = 'bundle-weapon-copy';
        const weaponName = document.createElement('strong');
        weaponName.textContent = weapon.name;
        const role = document.createElement('small');
        role.textContent = weapon.role;
        copy.append(weaponName, role);
        row.append(icon, copy);
        weaponList.append(row);
      }

      card.append(heading, title, description, weaponList);
      if (locked) {
        const unlock = document.createElement('span');
        unlock.className = 'bundle-unlock-message';
        const remaining = Math.max(0, BUNDLE_UNLOCK_KILLS - this.profile.lifetimeKills);
        unlock.textContent = `${remaining} MORE LIFETIME KILLS TO UNLOCK`;
        card.append(unlock);
      }
      card.addEventListener('click', () => this.selectBundle(bundle.id));
      this.elements.bundleOptions.append(card);
    }

    this.updateBundleSelection();
    this.elements.lifetimeKills.textContent = String(this.profile.lifetimeKills ?? 0);
    this.elements.godsUnlockProgress.textContent = godsUnlocked
      ? 'GODS TIER UNLOCKED'
      : `${Math.max(0, BUNDLE_UNLOCK_KILLS - (this.profile.lifetimeKills ?? 0))} kills to GODS TIER`;
  }

  updateBundleSelection() {
    for (const card of this.elements.bundleOptions.querySelectorAll('.bundle-card')) {
      const selected = card.dataset.bundleId === this.selectedBundleId;
      card.classList.toggle('is-selected', selected);
      card.setAttribute('aria-checked', String(selected));
      const label = card.querySelector('.bundle-card-heading small');
      if (label && !card.disabled) label.textContent = selected ? 'SELECTED' : 'AVAILABLE';
    }
  }

  selectBundle(bundleId) {
    const bundle = BUNDLE_BY_ID[bundleId];
    if (!bundle || (bundleId === 'GODS_TIER' && !this.isGodsTierUnlocked)) return false;
    this.selectedBundleId = bundleId;
    localStorage.setItem('fps-gods-bundle', bundleId);
    this.updateBundleSelection();
    this.clearError();
    this.handlers.onBundleChange?.(bundleId);
    return true;
  }

  get isGodsTierUnlocked() {
    return this.profile.godsTierUnlocked === true || this.profile.lifetimeKills >= BUNDLE_UNLOCK_KILLS;
  }

  get profileId() {
    return this.profile.profileId;
  }

  get bundleId() {
    return this.selectedBundleId;
  }

  setProfile(profile) {
    if (!profile || typeof profile !== 'object') return;
    const lifetimeKills = Math.max(0, Math.floor(Number(profile.lifetimeKills) || 0));
    this.profile = {
      profileId: typeof profile.profileId === 'string' ? profile.profileId : this.profile.profileId,
      lifetimeKills,
      godsTierUnlocked: profile.godsTierUnlocked === true || lifetimeKills >= BUNDLE_UNLOCK_KILLS,
    };
    if (this.profile.profileId) localStorage.setItem('fps-gods-profile-id', this.profile.profileId);
    if (this.selectedBundleId === 'GODS_TIER' && !this.isGodsTierUnlocked) this.selectedBundleId = DEFAULT_BUNDLE_ID;
    this.buildBundleOptions();
  }

  bindControls() {
    this.elements.name.addEventListener('input', () => {
      localStorage.setItem('fps-gods-callsign', this.elements.name.value.slice(0, 16));
      this.clearError();
    });
    this.elements.callsignContinue.addEventListener('click', () => {
      if (!this.playerName) {
        this.elements.callsignError.textContent = 'Enter a callsign before choosing a weapon bundle.';
        this.elements.callsignError.hidden = false;
        this.elements.name.focus();
        return;
      }
      this.elements.callsignError.hidden = true;
      this.handlers.onCallsignContinue?.(this.playerName, this.profileId);
      this.showBundleSelect();
    });
    this.elements.bundleBack.addEventListener('click', () => this.showCallsign());
    this.elements.bundleContinue.addEventListener('click', () => {
      if (!BUNDLE_BY_ID[this.selectedBundleId] || (this.selectedBundleId === 'GODS_TIER' && !this.isGodsTierUnlocked)) {
        this.elements.bundleError.textContent = 'Choose an unlocked weapon bundle to continue.';
        this.elements.bundleError.hidden = false;
        return;
      }
      this.handlers.onBundleSelected?.(this.selectedBundleId);
      this.showHome();
    });
    this.elements.playNow.addEventListener('click', () => this.handlers.onPlayNow?.(this.playerName, this.selectedBundleId, this.profileId));
    this.elements.create.addEventListener('click', () => this.handlers.onCreate?.(this.playerName, this.selectedBundleId, this.profileId));
    this.elements.joinForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const code = this.elements.roomCodeInput.value.trim().toUpperCase();
      if (code.length !== 6) {
        this.showError('Enter all six characters of the room code.');
        return;
      }
      this.handlers.onJoin?.(this.playerName, code, this.selectedBundleId, this.profileId);
    });
    this.elements.roomCodeInput.addEventListener('input', () => {
      this.elements.roomCodeInput.value = this.elements.roomCodeInput.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6);
      this.clearError();
    });
    this.elements.leaveRoom.addEventListener('click', () => this.handlers.onLeaveRoom?.());
    this.elements.ready.addEventListener('click', () => {
      const self = this.room?.players.find((player) => player.id === this.selfId);
      this.handlers.onReady?.(!(self?.ready ?? false));
    });
    this.elements.start.addEventListener('click', () => this.handlers.onStart?.());
    this.elements.copyCode.addEventListener('click', () => this.copyRoomCode());
    this.elements.resume.addEventListener('click', () => this.handlers.onResume?.());
    this.elements.returnLobby.addEventListener('click', () => {
      if (this.room?.mode === ROOM_MODES.SOLO_VS_BOTS) {
        this.handlers.onPlayAgain?.();
        return;
      }
      this.handlers.onReturnToLobby?.();
    });

    window.addEventListener('keydown', (event) => {
      if (event.code === 'Tab' && !event.repeat && !this.elements.match.hidden) {
        event.preventDefault();
        this.setScoreboard(!this.scoreboardOpen);
      }
    });
  }

  bindCryzenNavigation() {
    if (!this.elements.cryzenNav) return;
    
    // Navigation item click handlers
    this.elements.cryzenNav.querySelectorAll('.nav-item').forEach((item) => {
      item.addEventListener('click', () => {
        const mode = item.dataset.mode;
        this.handleNavItemClick(mode);
      });
    });
    
    // Mode selector handlers
    if (this.elements.modeCards) {
      this.elements.modeCards.forEach((card) => {
        card.addEventListener('click', () => {
          const mode = card.dataset.mode;
          this.handleModeSelect(mode);
        });
      });
    }
    
    // Close button
    if (this.elements.modeSelectorClose) {
      this.elements.modeSelectorClose.addEventListener('click', () => {
        this.hideModeSelector();
      });
    }
  }

  handleNavItemClick(mode) {
    switch (mode) {
      case 'play':
        this.showModeSelector();
        break;
      case 'inventory':
        this.showToast('Inventory coming soon!');
        break;
      case 'store':
        this.showToast('Store coming soon!');
        break;
      case 'profile':
        this.showToast('Profile coming soon!');
        break;
      case 'rooms':
        // Show room creation/join
        if (this.handlers.onCreate) {
          this.handlers.onCreate(this.playerName, this.selectedBundleId, this.profileId);
        }
        break;
      case 'settings':
        this.showToast('Settings coming soon!');
        break;
    }
  }

  showModeSelector() {
    if (this.elements.modeSelectorModal) {
      this.elements.modeSelectorModal.hidden = false;
    }
  }

  hideModeSelector() {
    if (this.elements.modeSelectorModal) {
      this.elements.modeSelectorModal.hidden = true;
    }
  }

  handleModeSelect(mode) {
    this.hideModeSelector();
    this.showToast(`Selected: ${mode}`);
    
    // For now, all modes play the same - in the future we can differentiate
    switch (mode) {
      case 'DEATHMATCH':
      case 'TEAM_DEATHMATCH':
      case 'KNIFE_ONLY':
        if (this.handlers.onPlayNow) {
          this.handlers.onPlayNow(this.playerName, this.selectedBundleId, this.profileId);
        }
        break;
    }
  }

  get playerName() {
    return this.elements.name.value.trim().slice(0, 16);
  }

  loadCallsign() {
    const saved = localStorage.getItem('fps-gods-callsign');
    if (saved) this.elements.name.value = saved.slice(0, 16);
  }

  setHandlers(handlers) {
    this.handlers = { ...this.handlers, ...handlers };
  }

  setConnectionState(state, detail = '') {
    const connected = state === 'connected';
    const offline = state === 'offline';
    // A dead host and a misaimed client both fail the handshake, but only one of
    // them fixes itself by waiting, so they must not share a label.
    const unreachable = state === 'unreachable';
    this.elements.connection.classList.toggle('is-connected', connected);
    this.elements.connection.classList.toggle('is-offline', offline);
    this.elements.connection.classList.toggle('is-unreachable', unreachable);
    const label = connected
      ? 'LIVE ARENA'
      : offline
        ? 'CONNECTION LOST'
        : unreachable
          ? 'SERVER OFFLINE'
          : 'CONNECTING TO SERVER';
    const changed = label !== this.elements.connectionLabel.textContent;
    this.elements.connectionLabel.textContent = label;
    if (connected) this.lastConnectionToastAt = 0;

    // The badge carries the state permanently, so a toast is only worth its
    // interruption the first time a verdict changes. Reconnection retries flip
    // between offline and unreachable as probes time out, and without this
    // cooldown the player gets a toast on every backoff attempt.
    const now = Date.now();
    if (!detail || connected || !changed || now - (this.lastConnectionToastAt ?? 0) < CONNECTION_TOAST_COOLDOWN_MS) return;
    this.lastConnectionToastAt = now;
    this.showToast(detail);
  }

  setRoom(room, selfId) {
    this.room = room;
    this.selfId = selfId;
    if (!room) return;

    if (room.state === 'LOBBY') {
      this.showLobby(room, selfId);
    } else if (room.state === 'PLAYING') {
      this.showMatch(room);
    } else if (room.state === 'ENDED' && !this.elements.end.hidden) {
      this.showGameEnd({ winner: room.winner, scoreboard: room.players }, selfId);
    }
  }

  showCallsign() {
    this.elements.shell.classList.remove('is-in-match');
    this.elements.callsignScreen.hidden = false;
    this.elements.bundleScreen.hidden = true;
    this.elements.home.hidden = true;
    this.elements.lobby.hidden = true;
    this.elements.match.hidden = true;
    this.elements.end.hidden = true;
    this.elements.pause.hidden = true;
    this.elements.death.hidden = true;
    this.elements.scoreboard.hidden = true;
    this.elements.weaponWheel.hidden = true;
    this.scoreboardOpen = false;
  }

  showBundleSelect() {
    if (this.selectedBundleId === 'GODS_TIER' && !this.isGodsTierUnlocked) this.selectedBundleId = DEFAULT_BUNDLE_ID;
    this.buildBundleOptions();
    this.elements.shell.classList.remove('is-in-match');
    this.elements.callsignScreen.hidden = true;
    this.elements.bundleScreen.hidden = false;
    this.elements.home.hidden = true;
    this.elements.lobby.hidden = true;
    this.elements.match.hidden = true;
    this.elements.end.hidden = true;
    this.elements.pause.hidden = true;
    this.elements.death.hidden = true;
    this.elements.scoreboard.hidden = true;
    this.elements.weaponWheel.hidden = true;
    this.scoreboardOpen = false;
  }

  showHome() {
    this.elements.shell.classList.remove('is-in-match');
    this.elements.callsignScreen.hidden = true;
    this.elements.bundleScreen.hidden = true;
    this.elements.home.hidden = false;
    this.elements.lobby.hidden = true;
    this.elements.match.hidden = true;
    this.elements.end.hidden = true;
    this.elements.pause.hidden = true;
    this.elements.death.hidden = true;
    this.elements.scoreboard.hidden = true;
    this.elements.weaponWheel.hidden = true;
    this.scoreboardOpen = false;
    // Hide room URL display
    if (this.elements.roomUrlDisplay) {
      this.elements.roomUrlDisplay.hidden = true;
    }
  }

  showLobby(room = this.room, selfId = this.selfId) {
    if (!room) return;
    this.elements.shell.classList.remove('is-in-match');
    this.room = room;
    this.selfId = selfId;
    this.lastHudPlayer = null;
    this.elements.callsignScreen.hidden = true;
    this.elements.bundleScreen.hidden = true;
    this.elements.home.hidden = true;
    this.elements.lobby.hidden = false;
    this.elements.match.hidden = true;
    this.elements.pause.hidden = true;
    this.elements.death.hidden = true;
    this.elements.scoreboard.hidden = true;
    this.elements.end.hidden = true;
    this.scoreboardOpen = false;
    this.clearError();
    
    // Show room URL
    if (this.elements.roomUrlDisplay) {
      const roomUrl = `${window.location.origin}?room=${room.code}`;
      this.elements.roomUrlText.textContent = roomUrl;
      this.elements.roomUrlDisplay.hidden = false;
    }

    this.elements.lobbyCode.textContent = room.code;
    this.elements.lobbyCodeSmall.textContent = room.code;
    this.elements.hudCode.textContent = room.code;
    
    // Show room URL
    if (this.elements.roomUrlDisplay) {
      const roomUrl = `${window.location.origin}?room=${room.code}`;
      this.elements.roomUrlText.textContent = roomUrl;
      this.elements.roomUrlDisplay.hidden = false;
    }
    this.elements.playerCount.textContent = `${room.players.length} / ${room.maxPlayers}`;
    this.elements.playerList.replaceChildren();

    const isHost = room.hostId === selfId;
    const self = room.players.find((player) => player.id === selfId);
    const connectedPlayers = room.players.filter((player) => player.connected !== false);
    const offlineCount = room.players.length - connectedPlayers.length;
    const everyoneReady = connectedPlayers.length >= room.minPlayers && offlineCount === 0
      && room.players.every((player) => player.ready);
    const waitingCount = room.players.filter((player) => player.connected === false || !player.ready).length;

    for (const player of room.players) {
      const row = document.createElement('li');
      row.className = `lobby-player-row${player.connected === false ? ' is-offline' : ''}`;

      const swatch = document.createElement('span');
      swatch.className = 'player-color-swatch';
      swatch.style.setProperty('--player-color', player.color);
      const avatar = document.createElement('span');
      avatar.className = 'player-avatar';
      avatar.style.setProperty('--player-color', player.color);
      avatar.textContent = [...player.name][0]?.toUpperCase() ?? '?';
      const information = document.createElement('span');
      const name = document.createElement('span');
      name.className = 'player-name';
      name.textContent = player.name;
      const subtitle = document.createElement('span');
      subtitle.className = 'player-subtitle';
      const bundleName = BUNDLE_BY_ID[player.bundleId]?.name ?? 'BUNDLE';
      subtitle.textContent = `${player.id === selfId ? 'YOU' : 'OPERATOR'} · ${bundleName}`;
      information.append(name, document.createElement('br'), subtitle);

      const spacer = document.createElement('span');
      spacer.className = 'player-row-spacer';
      if (player.id === room.hostId) {
        const hostTag = document.createElement('span');
        hostTag.className = 'player-host-tag';
        hostTag.textContent = 'HOST';
        row.append(swatch, avatar, information, spacer, hostTag);
      } else {
        row.append(swatch, avatar, information, spacer);
      }

      const ready = document.createElement('span');
      ready.className = `player-ready-status${player.ready ? ' is-ready' : ''}${player.connected === false ? ' is-offline' : ''}`;
      const check = document.createElement('span');
      check.className = 'status-check';
      check.textContent = player.connected === false ? '↻' : player.ready ? '✓' : '·';
      const status = document.createElement('span');
      status.textContent = player.connected === false ? 'RECONNECTING' : player.ready ? 'READY' : 'NOT READY';
      ready.append(check, status);
      row.append(ready);
      this.elements.playerList.append(row);
    }

    this.elements.ready.hidden = false;
    this.elements.start.hidden = !isHost;
    this.elements.ready.textContent = self?.ready ? 'READY' : 'MARK READY';
    this.elements.ready.classList.toggle('is-ready', Boolean(self?.ready));
    this.elements.ready.querySelector('span')?.remove();
    const readyMark = document.createElement('span');
    readyMark.textContent = '✓';
    this.elements.ready.append(readyMark);
    this.elements.ready.setAttribute('aria-pressed', String(Boolean(self?.ready)));
    this.elements.start.disabled = !everyoneReady;
    this.elements.start.title = everyoneReady ? 'Start the free-for-all' : 'Wait for at least two ready players';
    this.elements.start.querySelector('span')?.remove();
    const startArrow = document.createElement('span');
    startArrow.textContent = '↗';
    this.elements.start.append(startArrow);
    this.elements.start.parentElement.classList.toggle('is-host', isHost);

    if (offlineCount > 0) {
      this.elements.lobbyHint.textContent = `${offlineCount} operator${offlineCount === 1 ? ' is' : 's are'} reconnecting. The room is reserved for 45 seconds.`;
    } else if (connectedPlayers.length < room.minPlayers) {
      this.elements.lobbyHint.textContent = 'Waiting for one more operator. At least 2 connected players are required.';
    } else if (everyoneReady) {
      this.elements.lobbyHint.textContent = isHost ? 'All operators ready. Launch when you are.' : 'All operators ready. The host can launch the match.';
    } else {
      this.elements.lobbyHint.textContent = `${waitingCount} operator${waitingCount === 1 ? '' : 's'} still need to ready up.`;
    }
  }

  showMatch(room = this.room) {
    this.elements.shell.classList.add('is-in-match');
    if (room) {
      this.room = room;
      this.elements.hudCode.textContent = room.code;
      this.elements.targetKills.textContent = String(room.targetKills ?? 30);
      this.elements.scoreboardRoom.textContent = room.code;
    }
    this.elements.callsignScreen.hidden = true;
    this.elements.bundleScreen.hidden = true;
    this.elements.home.hidden = true;
    this.elements.lobby.hidden = true;
    this.elements.match.hidden = false;
    this.elements.end.hidden = true;
    if (!this.lastHudPlayer || this.lastHudPlayer.alive) this.elements.death.hidden = true;
  }

  setPaused(paused) {
    this.elements.pause.hidden = !paused || this.elements.match.hidden || !this.elements.end.hidden;
  }

  setScoreboard(open) {
    this.scoreboardOpen = Boolean(open);
    this.elements.scoreboard.hidden = !this.scoreboardOpen;
    // Scores are buffered while the panel is hidden so the 20 Hz game state
    // never causes DOM churn. Opening Tab renders the freshest buffered list.
    if (this.scoreboardOpen && this.latestScoreboard) {
      this.scoreboardSignature = null;
      this.updateScoreboard(this.latestScoreboard.players, this.latestScoreboard.localId);
    }
  }

  openWeaponWheel(bundleId, activeWeaponId) {
    const bundle = BUNDLE_BY_ID[bundleId];
    if (!bundle) return null;
    this.wheelWeapons = bundle.weapons;
    this.activeWheelWeaponId = activeWeaponId;
    this.selectedWheelWeaponId = activeWeaponId;
    this.elements.weaponWheelOptions.replaceChildren();

    const radius = Math.min(116, window.innerWidth * 0.29, window.innerHeight * 0.25);
    this.wheelWeapons.forEach((weapon, index) => {
      const angle = -Math.PI / 2 + (index * Math.PI * 2) / this.wheelWeapons.length;
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'weapon-wheel-option';
      option.dataset.weaponId = weapon.id;
      option.style.setProperty('--wheel-x', `${Math.cos(angle) * radius}px`);
      option.style.setProperty('--wheel-y', `${Math.sin(angle) * radius}px`);
      option.setAttribute('aria-label', `${weapon.name}${weapon.id === activeWeaponId ? ', active' : ''}`);

      const icon = document.createElement('span');
      icon.className = 'weapon-wheel-option-icon';
      icon.textContent = weapon.icon;
      const name = document.createElement('span');
      name.className = 'weapon-wheel-option-name';
      name.textContent = weapon.name;
      const state = document.createElement('span');
      state.className = 'weapon-wheel-option-state';
      state.textContent = weapon.id === activeWeaponId ? 'ACTIVE' : 'SELECT';
      option.append(icon, name, state);
      option.addEventListener('click', () => this.selectWheelWeapon(weapon.id));
      this.elements.weaponWheelOptions.append(option);
    });

    this.elements.weaponWheel.hidden = false;
    this.updateWeaponWheel();
    return this.selectedWheelWeaponId;
  }

  selectWheelWeapon(weaponId) {
    if (!this.wheelWeapons.some((weapon) => weapon.id === weaponId)) return;
    this.selectedWheelWeaponId = weaponId;
    this.updateWeaponWheel();
  }

  selectWeaponByDirection(x, y) {
    if (Math.hypot(x, y) < 15 || this.wheelWeapons.length === 0) return;
    let nearestIndex = 0;
    let nearestDot = -Infinity;
    const magnitude = Math.hypot(x, y);
    const directionX = x / magnitude;
    const directionY = y / magnitude;
    this.wheelWeapons.forEach((_weapon, index) => {
      const angle = -Math.PI / 2 + (index * Math.PI * 2) / this.wheelWeapons.length;
      const dot = directionX * Math.cos(angle) + directionY * Math.sin(angle);
      if (dot > nearestDot) {
        nearestDot = dot;
        nearestIndex = index;
      }
    });
    this.selectWheelWeapon(this.wheelWeapons[nearestIndex].id);
  }

  updateWeaponWheel() {
    for (const option of this.elements.weaponWheelOptions.querySelectorAll('.weapon-wheel-option')) {
      const active = option.dataset.weaponId === this.activeWheelWeaponId;
      const selected = option.dataset.weaponId === this.selectedWheelWeaponId;
      option.classList.toggle('is-active', active);
      option.classList.toggle('is-selected', selected);
      option.setAttribute('aria-pressed', String(selected));
      const state = option.querySelector('.weapon-wheel-option-state');
      if (state) state.textContent = selected ? (active ? 'ACTIVE' : 'RELEASE TO EQUIP') : active ? 'CURRENT' : 'SELECT';
    }
    const selectedWeapon = this.wheelWeapons.find((weapon) => weapon.id === this.selectedWheelWeaponId);
    if (selectedWeapon) {
      this.elements.wheelCenterIcon.textContent = selectedWeapon.icon;
      this.elements.wheelCenterName.textContent = selectedWeapon.name;
      this.elements.wheelCenterState.textContent = selectedWeapon.id === this.activeWheelWeaponId ? 'ACTIVE' : 'RELEASE Q';
    }
  }

  closeWeaponWheel() {
    const weaponId = this.selectedWheelWeaponId;
    this.elements.weaponWheel.hidden = true;
    this.wheelWeapons = [];
    this.activeWheelWeaponId = null;
    this.selectedWheelWeaponId = null;
    return weaponId;
  }

  updateHud(player, estimatedServerNow = Date.now(), playerCount = 0) {
    if (!player) return;
    this.lastHudPlayer = player;
    const maxHealth = player.maxHealth || 100;
    const health = Math.max(0, Math.min(maxHealth, player.health ?? maxHealth));
    const percent = (health / maxHealth) * 100;
    this.elements.healthValue.textContent = String(Math.ceil(health));
    this.elements.healthFill.style.width = `${percent}%`;
    this.elements.healthTrack.classList.toggle('is-low', percent <= 32);
    this.elements.healthState.textContent = health <= 0 ? 'OPERATOR DOWN' : percent <= 32 ? 'CRITICAL' : 'COMBAT READY';
    this.elements.aliveCount.textContent = String(playerCount);

    const weaponId = player.currentWeaponId ?? 'SMG';
    const weapon = WEAPON_PRESENTATION[weaponId];
    const noMagazine = !player.unlimitedAmmo && !(player.maxAmmo > 0);
    this.elements.weaponIcon.textContent = player.currentWeaponIcon ?? weapon?.icon ?? '◌';
    this.elements.weaponName.textContent = player.currentWeaponName ?? weapon?.name ?? weaponId;
    this.elements.weaponBundle.textContent = BUNDLE_BY_ID[player.bundleId]?.name ?? 'BUNDLE';
    this.elements.ammo.textContent = player.unlimitedAmmo ? '∞' : noMagazine ? '—' : String(player.ammo ?? 0);
    this.elements.ammoTotal.textContent = player.unlimitedAmmo
      ? '∞'
      : noMagazine
        ? '—'
        : String(player.totalAmmo ?? ((player.ammo ?? 0) + (player.reserveAmmo ?? 0)));
    this.elements.ammoWidget.classList.toggle('is-reloading', Boolean(player.reloading));
    this.elements.ammoWidget.classList.toggle('is-overheated', Boolean(player.overheated));
    this.elements.ammoStatus.textContent = player.reloading
      ? 'RELOADING'
      : player.overheated
        ? 'OVERHEATED'
        : weaponId === 'COMBAT_SHIELD'
          ? 'FRONTAL GUARD'
          : weaponId === 'KNIFE' || weaponId === 'GOD_FIST'
            ? 'MELEE READY'
            : 'READY';
    this.elements.reloadHint.textContent = player.overheated
      ? 'COOLING DOWN'
      : player.reloading
        ? 'MAGAZINE INCOMING'
        : noMagazine
          ? 'Q WEAPON WHEEL'
          : 'R RELOAD · Q WHEEL';

    if (!player.alive && player.respawnAt) {
      this.elements.death.hidden = false;
      this.elements.pause.hidden = true;
      const remaining = Math.max(0, player.respawnAt - estimatedServerNow) / 1_000;
      this.elements.countdown.textContent = remaining.toFixed(1);
    } else if (player.alive) {
      this.elements.death.hidden = true;
    }
  }

  updateScoreboard(players, localId = this.selfId) {
    if (!Array.isArray(players)) return;
    this.latestScoreboard = { players, localId };
    if (!this.scoreboardOpen) return;

    const sorted = [...players].sort((left, right) => right.kills - left.kills || left.deaths - right.deaths || left.name.localeCompare(right.name));
    const signature = sorted.map((player) => [
      player.id,
      player.kills,
      player.deaths,
      player.alive,
      player.connected,
      player.isBot,
    ].join(':')).join('|');
    if (signature === this.scoreboardSignature) return;
    this.scoreboardSignature = signature;
    this.elements.scoreboardBody.replaceChildren();

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
        const botTag = document.createElement('span');
        botTag.className = 'scoreboard-bot-tag';
        botTag.textContent = '[BOT]';
        identity.append(botTag);
      }

      const kills = document.createElement('span');
      kills.textContent = String(player.kills ?? 0);
      const deaths = document.createElement('span');
      deaths.textContent = String(player.deaths ?? 0);
      const status = document.createElement('span');
      status.className = `scoreboard-status${player.connected === false ? ' is-offline' : player.alive === false ? ' is-down' : ''}`;
      status.textContent = player.connected === false ? 'OFFLINE' : player.alive === false ? 'DOWN' : 'ACTIVE';
      row.append(identity, kills, deaths, status);
      this.elements.scoreboardBody.append(row);
    });
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

    this.elements.killFeed.prepend(row);
    while (this.elements.killFeed.children.length > 6) this.elements.killFeed.lastElementChild.remove();
    const timer = window.setTimeout(() => row.classList.add('is-fading'), 3_500);
    const removeTimer = window.setTimeout(() => {
      row.remove();
      this.feedTimers.delete(row);
    }, 4_000);
    this.feedTimers.set(row, [timer, removeTimer]);
  }

  showHitMarker(hit) {
    if (!hit?.hit) return;
    const crosshair = this.elements.crosshair;
    crosshair.classList.remove('is-hit', 'is-kill', 'is-headshot');
    if (hit.killed) crosshair.classList.add('is-kill');
    else crosshair.classList.add('is-hit');
    if (hit.headshot) crosshair.classList.add('is-headshot');
    window.clearTimeout(this.hitMarkerTimer);
    this.hitMarkerTimer = window.setTimeout(() => crosshair.classList.remove('is-hit', 'is-kill', 'is-headshot'), 180);
  }

  showGameEnd(data, localId = this.selfId) {
    const winner = data?.winner ?? { name: 'Unknown operator', kills: 30 };
    this.elements.end.hidden = false;
    this.elements.pause.hidden = true;
    this.elements.death.hidden = true;
    this.elements.scoreboard.hidden = true;
    this.scoreboardOpen = false;
    this.elements.winner.textContent = winner.name;
    this.elements.winnerSummary.textContent = `${winner.kills} eliminations secured${winner.id === localId ? ' — that was you.' : '.'}`;
    this.renderEndScoreboard(data.scoreboard ?? []);

    const mode = data?.mode ?? this.room?.mode;
    const solo = mode === ROOM_MODES.SOLO_VS_BOTS;
    const isHost = this.room?.hostId === localId;
    this.setEndActionLabel(solo ? 'REDEPLOY' : 'RETURN TO LOBBY');
    this.elements.returnLobby.hidden = !isHost;
    this.elements.endWaiting.hidden = isHost;
  }

  setEndActionLabel(label) {
    const first = this.elements.returnLobby.firstChild;
    if (first?.nodeType === Node.TEXT_NODE) first.textContent = `${label} `;
    else this.elements.returnLobby.prepend(document.createTextNode(`${label} `));
  }

  renderEndScoreboard(players) {
    this.elements.endScoreboard.replaceChildren();
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
      this.elements.endScoreboard.append(row);
    });
  }

  showError(message) {
    const target = !this.elements.lobby.hidden
      ? this.elements.roomError
      : !this.elements.bundleScreen.hidden
        ? this.elements.bundleError
        : !this.elements.callsignScreen.hidden
          ? this.elements.callsignError
          : this.elements.homeError;
    this.clearError();
    target.textContent = String(message || 'Something went wrong. Please try again.');
    target.hidden = false;
  }

  clearError() {
    this.elements.callsignError.hidden = true;
    this.elements.bundleError.hidden = true;
    this.elements.homeError.hidden = true;
    this.elements.roomError.hidden = true;
  }

  showToast(message) {
    this.elements.toast.textContent = String(message);
    this.elements.toast.classList.add('is-visible');
    window.clearTimeout(this.toastTimeout);
    this.toastTimeout = window.setTimeout(() => this.elements.toast.classList.remove('is-visible'), 3_000);
  }

  showWebGLWarning() {
    this.elements.webglWarning.hidden = false;
  }

  async copyRoomCode() {
    const code = this.room?.code;
    if (!code) return;
    try {
      // Copy the full room URL
      const roomUrl = `${window.location.origin}?room=${code}`;
      await navigator.clipboard.writeText(roomUrl);
      this.elements.copyCode.innerHTML = 'COPIED <span>✓</span>';
      window.setTimeout(() => { this.elements.copyCode.innerHTML = 'COPY <span>▣</span>'; }, 1_500);
      this.showToast(`Room link copied! Share: ${roomUrl}`);
    } catch {
      this.showToast(`Room code: ${code}`);
    }
  }
}
