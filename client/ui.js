import {
  BUNDLES,
  GODS_TIER_UNLOCK_KILLS,
  getWeapon,
  isBundleUnlocked,
} from '../shared/weapons.js';

const LIFETIME_KILLS_KEY = 'fps-gods-lifetime-kills';

export function getLifetimeKills() {
  const stored = Number.parseInt(localStorage.getItem(LIFETIME_KILLS_KEY) ?? '0', 10);
  return Number.isFinite(stored) ? Math.max(0, stored) : 0;
}

export function addLifetimeKills(count) {
  const total = getLifetimeKills() + Math.max(0, Math.trunc(Number(count) || 0));
  localStorage.setItem(LIFETIME_KILLS_KEY, String(total));
  return total;
}

// All presentation is plain DOM/CSS. Socket payloads are inserted with
// textContent rather than HTML so player names never become markup.
export class GameUI {
  constructor() {
    this.handlers = {};
    this.room = null;
    this.selfId = null;
    this.scoreboardOpen = false;
    this.toastTimeout = null;
    this.feedTimers = new Map();
    this.lastHudPlayer = null;
    this.pendingAction = { action: null, code: null };
    this.selectedBundleId = 'rusher';
    this.wheelOpen = false;
    this.wheelSelection = 0;
    this.wheelVector = { x: 0, y: -1 };
    this.wheelSlots = [];

    this.elements = {
      home: document.querySelector('#home-screen'),
      bundle: document.querySelector('#bundle-screen'),
      bundleCards: document.querySelector('#bundle-cards'),
      bundleBack: document.querySelector('#bundle-back-button'),
      bundleConfirm: document.querySelector('#bundle-confirm-button'),
      bundleError: document.querySelector('#bundle-error'),
      lifetimeKillsValue: document.querySelector('#lifetime-kills-value'),
      killsProgressFill: document.querySelector('#kills-progress-fill'),
      killsProgressHint: document.querySelector('#kills-progress-hint'),
      lobby: document.querySelector('#lobby-screen'),
      match: document.querySelector('#match-hud'),
      connection: document.querySelector('#connection-pill'),
      connectionDot: document.querySelector('#connection-pill .connection-dot'),
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
      weaponIcon: document.querySelector('#weapon-icon'),
      weaponName: document.querySelector('#weapon-name'),
      ammo: document.querySelector('#ammo-value'),
      ammoMax: document.querySelector('#ammo-max'),
      ammoStatus: document.querySelector('#ammo-status'),
      ammoWidget: document.querySelector('.ammo-widget'),
      heatTrack: document.querySelector('#heat-track'),
      heatFill: document.querySelector('#heat-fill'),
      reloadHint: document.querySelector('#reload-hint'),
      weaponWheel: document.querySelector('#weapon-wheel'),
      weaponWheelSlots: document.querySelector('#weapon-wheel-slots'),
      wheelHubName: document.querySelector('#wheel-hub-name'),
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
    this.bindControls();
  }

  bindControls() {
    this.elements.name.addEventListener('input', () => {
      localStorage.setItem('fps-gods-callsign', this.elements.name.value.slice(0, 16));
      this.clearError();
    });

    this.elements.playNow.addEventListener('click', () => {
      if (!this.requireName()) return;
      this.openBundleScreen('solo');
    });
    this.elements.create.addEventListener('click', () => {
      if (!this.requireName()) return;
      this.openBundleScreen('create');
    });
    this.elements.joinForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const code = this.elements.roomCodeInput.value.trim().toUpperCase();
      if (code.length !== 6) {
        this.showError('Enter all six characters of the room code.');
        return;
      }
      if (!this.requireName()) return;
      this.openBundleScreen('join', code);
    });
    this.elements.roomCodeInput.addEventListener('input', () => {
      this.elements.roomCodeInput.value = this.elements.roomCodeInput.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6);
      this.clearError();
    });

    this.elements.bundleBack.addEventListener('click', () => {
      this.pendingAction = { action: null, code: null };
      this.showHome();
    });
    this.elements.bundleConfirm.addEventListener('click', () => this.confirmBundle());

    this.elements.ready.addEventListener('click', () => {
      const self = this.room?.players.find((player) => player.id === this.selfId);
      this.handlers.onReady?.(!(self?.ready ?? false));
    });
    this.elements.start.addEventListener('click', () => this.handlers.onStart?.());
    this.elements.copyCode.addEventListener('click', () => this.copyRoomCode());
    this.elements.resume.addEventListener('click', () => this.handlers.onResume?.());
    this.elements.returnLobby.addEventListener('click', () => this.handlers.onReturnToLobby?.());

    window.addEventListener('keydown', (event) => {
      if (event.code === 'Tab' && !event.repeat && !this.elements.match.hidden) {
        event.preventDefault();
        this.setScoreboard(!this.scoreboardOpen);
      }
    });
  }

  requireName() {
    if (this.playerName.length > 0) return true;
    this.showError('Enter a callsign before deploying.');
    this.elements.name.focus();
    return false;
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

  // ── Connection indicator ─────────────────────────────────────────────────
  // Green dot = connected. Red dot = lost; the network layer retries every 3 s.

  setConnectionState(state, detail = '') {
    const connected = state === 'connected';
    const offline = state === 'offline';
    this.elements.connection.classList.toggle('is-connected', connected);
    this.elements.connection.classList.toggle('is-offline', offline);
    this.elements.connectionDot.classList.toggle('is-connected', connected);
    this.elements.connectionDot.classList.toggle('is-offline', offline);
    this.elements.connectionLabel.textContent = connected
      ? 'SERVER CONNECTED'
      : offline
        ? 'CONNECTION LOST · RETRYING'
        : 'CONNECTING TO SERVER';
    if (detail && !connected) this.showToast(detail);
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

  showHome() {
    this.elements.home.hidden = false;
    this.elements.bundle.hidden = true;
    this.elements.lobby.hidden = true;
    this.elements.match.hidden = true;
    this.elements.end.hidden = true;
    this.elements.pause.hidden = true;
    this.elements.death.hidden = true;
    this.elements.scoreboard.hidden = true;
    this.scoreboardOpen = false;
  }

  // ── Bundle select screen ────────────────────────────────────────────────

  openBundleScreen(action, code = null) {
    this.pendingAction = { action, code };
    this.elements.home.hidden = true;
    this.elements.bundle.hidden = false;
    this.elements.lobby.hidden = true;
    this.elements.match.hidden = true;
    this.elements.end.hidden = true;
    this.elements.pause.hidden = true;
    this.elements.death.hidden = true;
    this.elements.bundleError.hidden = true;
    this.renderBundleCards();

    const labels = {
      solo: 'DEPLOY SOLO <span>↗</span>',
      create: 'CREATE ROOM <span>↗</span>',
      join: 'JOIN ROOM <span>↗</span>',
    };
    this.elements.bundleConfirm.innerHTML = labels[action] ?? labels.create;
  }

  renderBundleCards() {
    const kills = getLifetimeKills();
    this.elements.lifetimeKillsValue.textContent = String(kills);
    this.elements.killsProgressFill.style.width = `${Math.min(100, (kills / GODS_TIER_UNLOCK_KILLS) * 100)}%`;
    if (kills >= GODS_TIER_UNLOCK_KILLS) {
      this.elements.killsProgressHint.textContent = 'GODS TIER unlocked. Choose your power.';
    } else {
      this.elements.killsProgressHint.textContent
        = `Reach ${GODS_TIER_UNLOCK_KILLS} lifetime kills to unlock GODS TIER. ${GODS_TIER_UNLOCK_KILLS - kills} to go.`;
    }

    if (!isBundleUnlocked(this.selectedBundleId, kills)) this.selectedBundleId = 'rusher';
    this.elements.bundleCards.replaceChildren();

    for (const bundle of Object.values(BUNDLES)) {
      const unlocked = isBundleUnlocked(bundle.id, kills);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `bundle-card${this.selectedBundleId === bundle.id ? ' is-selected' : ''}${unlocked ? '' : ' is-locked'}`;
      card.style.setProperty('--bundle-accent', bundle.accent);

      const head = document.createElement('div');
      head.className = 'bundle-card-head';
      const title = document.createElement('strong');
      title.textContent = bundle.name;
      const lock = document.createElement('span');
      lock.className = 'bundle-lock-chip';
      lock.textContent = unlocked ? 'READY' : `LOCKED · ${bundle.unlockKills} KILLS`;
      head.append(title, lock);

      const tagline = document.createElement('p');
      tagline.className = 'bundle-tagline';
      tagline.textContent = bundle.tagline;

      const list = document.createElement('ul');
      list.className = 'bundle-weapon-list';
      for (const weaponId of bundle.slots) {
        const weapon = getWeapon(weaponId);
        const item = document.createElement('li');

        const icon = document.createElement('span');
        icon.className = 'bundle-weapon-icon';
        icon.textContent = weapon.icon;
        const info = document.createElement('span');
        info.className = 'bundle-weapon-info';
        const weaponName = document.createElement('span');
        weaponName.className = 'bundle-weapon-name';
        weaponName.textContent = weapon.name;
        const blurb = document.createElement('span');
        blurb.className = 'bundle-weapon-blurb';
        blurb.textContent = weapon.blurb;
        info.append(weaponName, blurb);

        const stats = document.createElement('span');
        stats.className = 'bundle-weapon-stats';
        const damageText = weapon.type === 'melee'
          ? 'MELEE'
          : weapon.type === 'grenade'
            ? 'UTILITY'
            : weapon.type === 'shield'
              ? 'DEFENSE'
              : `DMG ${weapon.damage}${weapon.pellets ? `×${weapon.pellets}` : ''}`;
        const rateText = weapon.unlimited
          ? '∞ AMMO'
          : weapon.magSize > 0
            ? `${weapon.magSize} MAG`
            : '—';
        stats.textContent = `${damageText} · ${rateText}`;

        item.append(icon, info, stats);
        list.append(item);
      }

      card.append(head, tagline, list);
      card.addEventListener('click', () => {
        if (!unlocked) {
          this.elements.bundleError.textContent = `GODS TIER unlocks at ${bundle.unlockKills} lifetime kills.`;
          this.elements.bundleError.hidden = false;
          return;
        }
        this.elements.bundleError.hidden = true;
        this.selectedBundleId = bundle.id;
        this.renderBundleCards();
      });
      this.elements.bundleCards.append(card);
    }
  }

  confirmBundle() {
    const { action, code } = this.pendingAction;
    if (!action) return;
    const kills = getLifetimeKills();
    if (!isBundleUnlocked(this.selectedBundleId, kills)) {
      this.elements.bundleError.textContent = 'That bundle is still locked. Keep fighting.';
      this.elements.bundleError.hidden = false;
      return;
    }
    this.elements.bundleError.hidden = true;
    this.handlers.onBundleConfirmed?.(this.selectedBundleId, action, code);
  }

  showLobby(room = this.room, selfId = this.selfId) {
    if (!room) return;
    this.room = room;
    this.selfId = selfId;
    this.lastHudPlayer = null;
    this.elements.home.hidden = true;
    this.elements.bundle.hidden = true;
    this.elements.lobby.hidden = false;
    this.elements.match.hidden = true;
    this.elements.pause.hidden = true;
    this.elements.death.hidden = true;
    this.elements.scoreboard.hidden = true;
    this.elements.end.hidden = true;
    this.scoreboardOpen = false;
    this.clearError();

    this.elements.lobbyCode.textContent = room.code;
    this.elements.lobbyCodeSmall.textContent = room.code;
    this.elements.hudCode.textContent = room.code;
    this.elements.playerCount.textContent = `${room.players.length} / ${room.maxPlayers}`;
    this.elements.playerList.replaceChildren();

    const isHost = room.hostId === selfId;
    const self = room.players.find((player) => player.id === selfId);
    const humans = room.players.filter((player) => !player.isBot);
    const everyoneReady = humans.length >= room.minPlayers && humans.every((player) => player.ready);
    const waitingCount = humans.filter((player) => !player.ready).length;

    for (const player of room.players) {
      const row = document.createElement('li');
      row.className = 'lobby-player-row';

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
      subtitle.textContent = player.id === selfId ? 'YOU' : player.isBot ? 'ARENA BOT' : 'OPERATOR';
      information.append(name, document.createElement('br'), subtitle);

      const spacer = document.createElement('span');
      spacer.className = 'player-row-spacer';
      if (player.isBot) {
        const botTag = document.createElement('span');
        botTag.className = 'player-bot-tag';
        botTag.textContent = '[BOT]';
        row.append(swatch, avatar, information, spacer, botTag);
      } else if (player.id === room.hostId) {
        const hostTag = document.createElement('span');
        hostTag.className = 'player-host-tag';
        hostTag.textContent = 'HOST';
        row.append(swatch, avatar, information, spacer, hostTag);
      } else {
        row.append(swatch, avatar, information, spacer);
      }

      const ready = document.createElement('span');
      ready.className = `player-ready-status${player.ready ? ' is-ready' : ''}`;
      const check = document.createElement('span');
      check.className = 'status-check';
      check.textContent = player.ready ? '✓' : '·';
      const status = document.createElement('span');
      status.textContent = player.ready ? 'READY' : 'NOT READY';
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

    if (humans.length < room.minPlayers) {
      this.elements.lobbyHint.textContent = 'Waiting for one more operator. At least 2 players are required.';
    } else if (everyoneReady) {
      this.elements.lobbyHint.textContent = isHost ? 'All operators ready. Launch when you are.' : 'All operators ready. The host can launch the match.';
    } else {
      this.elements.lobbyHint.textContent = `${waitingCount} operator${waitingCount === 1 ? '' : 's'} still need to ready up.`;
    }
  }

  showMatch(room = this.room) {
    if (room) {
      this.room = room;
      this.elements.hudCode.textContent = room.code;
      this.elements.targetKills.textContent = String(room.targetKills ?? 30);
      this.elements.scoreboardRoom.textContent = room.code;
    }
    this.elements.home.hidden = true;
    this.elements.bundle.hidden = true;
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
  }

  // ── HUD ─────────────────────────────────────────────────────────────────

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

    const weaponId = player.weaponId ?? 'pistol';
    const weapon = getWeapon(weaponId);
    this.elements.weaponIcon.textContent = weapon.icon;
    this.elements.weaponName.textContent = weapon.name;

    if (weapon.unlimited) {
      this.elements.ammo.textContent = '∞';
      this.elements.ammoMax.textContent = '∞';
    } else if (weapon.magSize <= 0) {
      this.elements.ammo.textContent = '—';
      this.elements.ammoMax.textContent = '—';
    } else {
      this.elements.ammo.textContent = String(player.ammo ?? weapon.magSize);
      this.elements.ammoMax.textContent = String(player.maxAmmo ?? weapon.magSize);
    }

    const overheated = Boolean(player.overheated);
    this.elements.ammoWidget.classList.toggle('is-reloading', Boolean(player.reloading));
    this.elements.ammoWidget.classList.toggle('is-overheated', overheated);
    this.elements.ammoStatus.textContent = overheated ? 'OVERHEATED' : player.reloading ? 'RELOADING' : 'READY';
    this.elements.reloadHint.textContent = overheated
      ? 'BARREL COOLING'
      : player.reloading
        ? 'MAGAZINE INCOMING'
        : weapon.unlimited
          ? 'UNLIMITED AMMO'
          : weapon.magSize > 0
            ? 'R TO RELOAD'
            : 'MELEE READY';

    const showHeat = Boolean(weapon.overheatAfterMs);
    this.elements.heatTrack.hidden = !showHeat;
    if (showHeat) {
      const heat = Math.max(0, Math.min(1, player.heat ?? 0));
      this.elements.heatFill.style.width = `${heat * 100}%`;
      this.elements.heatFill.classList.toggle('is-hot', heat > 0.8 || overheated);
    }

    if (!player.alive && player.respawnAt) {
      this.elements.death.hidden = false;
      this.elements.pause.hidden = true;
      const remaining = Math.max(0, player.respawnAt - estimatedServerNow) / 1_000;
      this.elements.countdown.textContent = remaining.toFixed(1);
    } else if (player.alive) {
      this.elements.death.hidden = true;
    }
  }

  // ── Weapon wheel ────────────────────────────────────────────────────────
  // Hold Q: three slots on a dark/cyan ring. Mouse direction picks the slot,
  // releasing Q equips it (main.js issues the SWITCH_WEAPON request).

  openWeaponWheel(slots, activeSlot = 0) {
    if (this.wheelOpen) return;
    this.wheelOpen = true;
    this.wheelSlots = slots;
    this.wheelSelection = activeSlot;
    this.wheelVector = { x: 0, y: -1 };
    this.elements.weaponWheel.hidden = false;
    this.elements.weaponWheel.classList.add('is-open');
    this.elements.weaponWheelSlots.replaceChildren();

    const angles = [-Math.PI / 2, Math.PI / 6, (5 * Math.PI) / 6];
    slots.forEach((slot, index) => {
      const weapon = getWeapon(slot.weaponId);
      const item = document.createElement('div');
      item.className = `wheel-slot${index === activeSlot ? ' is-active' : ''}`;
      item.dataset.slot = String(index);
      const angle = angles[index];
      const radius = 118;
      item.style.setProperty('--slot-x', `${Math.cos(angle) * radius}px`);
      item.style.setProperty('--slot-y', `${Math.sin(angle) * radius}px`);

      const icon = document.createElement('span');
      icon.className = 'wheel-slot-icon';
      icon.textContent = weapon.icon;
      const name = document.createElement('span');
      name.className = 'wheel-slot-name';
      name.textContent = weapon.name;
      const key = document.createElement('span');
      key.className = 'wheel-slot-key';
      key.textContent = String(index + 1);
      item.append(key, icon, name);
      this.elements.weaponWheelSlots.append(item);
    });

    this.refreshWheelSelection();
  }

  moveWeaponWheel(deltaX, deltaY) {
    if (!this.wheelOpen) return;
    this.wheelVector.x += deltaX;
    this.wheelVector.y += deltaY;
    const length = Math.hypot(this.wheelVector.x, this.wheelVector.y);
    if (length < 18) {
      this.refreshWheelSelection();
      return;
    }
    const angle = Math.atan2(this.wheelVector.y, this.wheelVector.x);
    // Slots sit at -90°, 30°, 150°; snap the vector angle to the nearest.
    const slotAngles = [-Math.PI / 2, Math.PI / 6, (5 * Math.PI) / 6];
    let best = this.wheelSelection;
    let bestDistance = Infinity;
    slotAngles.forEach((slotAngle, index) => {
      let delta = Math.abs(((angle - slotAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (delta < bestDistance) {
        bestDistance = delta;
        best = index;
      }
    });
    this.wheelSelection = best;
    this.refreshWheelSelection();
  }

  refreshWheelSelection() {
    const slots = [...this.elements.weaponWheelSlots.children];
    slots.forEach((item, index) => item.classList.toggle('is-active', index === this.wheelSelection));
    const weapon = this.wheelSlots[this.wheelSelection];
    if (weapon) this.elements.wheelHubName.textContent = getWeapon(weapon.weaponId).name;
  }

  closeWeaponWheel() {
    if (!this.wheelOpen) return null;
    this.wheelOpen = false;
    this.elements.weaponWheel.classList.remove('is-open');
    this.elements.weaponWheel.hidden = true;
    return this.wheelSelection;
  }

  // ── Scoreboard & kill feed ──────────────────────────────────────────────

  updateScoreboard(players, localId = this.selfId) {
    if (!Array.isArray(players)) return;
    const sorted = [...players].sort((left, right) => right.kills - left.kills || left.deaths - right.deaths || left.name.localeCompare(right.name));
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
      status.className = `scoreboard-status${player.alive === false ? ' is-down' : ''}`;
      status.textContent = player.alive === false ? 'DOWN' : 'ACTIVE';
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
    if (entry.killerIsBot || entry.victimIsBot) {
      const botTag = document.createElement('span');
      botTag.className = 'feed-bot';
      botTag.textContent = '[BOT]';
      row.append(botTag);
    }
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
    crosshair.classList.remove('is-hit', 'is-kill', 'is-headshot', 'is-blocked');
    if (hit.blocked) crosshair.classList.add('is-blocked');
    else if (hit.killed) crosshair.classList.add('is-kill');
    else crosshair.classList.add('is-hit');
    if (hit.headshot) crosshair.classList.add('is-headshot');
    window.clearTimeout(this.hitMarkerTimer);
    this.hitMarkerTimer = window.setTimeout(() => crosshair.classList.remove('is-hit', 'is-kill', 'is-headshot', 'is-blocked'), 180);
  }

  showGameEnd(data, localId = this.selfId) {
    const winner = data?.winner ?? { name: 'Unknown operator', kills: 30 };
    this.elements.end.hidden = false;
    this.elements.pause.hidden = true;
    this.elements.death.hidden = true;
    this.elements.scoreboard.hidden = true;
    this.scoreboardOpen = false;
    this.elements.winner.textContent = winner.name;
    this.elements.winnerSummary.textContent = `${winner.kills} eliminations secured${winner.id === localId ? ' — that was you.' : winner.isBot ? ' — the bots took this one.' : '.'}`;
    this.renderEndScoreboard(data.scoreboard ?? []);

    const isHost = this.room?.hostId === localId;
    this.elements.returnLobby.hidden = !isHost;
    this.elements.endWaiting.hidden = isHost;
  }

  renderEndScoreboard(players) {
    this.elements.endScoreboard.replaceChildren();
    [...players].slice(0, 5).forEach((player, index) => {
      const row = document.createElement('div');
      row.className = 'end-score-row';
      const name = document.createElement('span');
      name.className = index === 0 ? 'champion-name' : '';
      name.textContent = `${index + 1}. ${player.isBot ? '[BOT] ' : ''}${player.name}`;
      const kills = document.createElement('span');
      kills.textContent = `${player.kills} K`;
      const deaths = document.createElement('span');
      deaths.textContent = `${player.deaths} D`;
      row.append(name, kills, deaths);
      this.elements.endScoreboard.append(row);
    });
  }

  showError(message) {
    const inLobby = !this.elements.lobby.hidden;
    const target = inLobby ? this.elements.roomError : this.elements.homeError;
    const other = inLobby ? this.elements.homeError : this.elements.roomError;
    other.hidden = true;
    target.textContent = String(message || 'Something went wrong. Please try again.');
    target.hidden = false;
  }

  clearError() {
    this.elements.homeError.hidden = true;
    this.elements.roomError.hidden = true;
    this.elements.bundleError.hidden = true;
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
      await navigator.clipboard.writeText(code);
      this.elements.copyCode.innerHTML = 'COPIED <span>✓</span>';
      window.setTimeout(() => { this.elements.copyCode.innerHTML = 'COPY <span>▣</span>'; }, 1_500);
    } catch {
      this.showToast(`Room code: ${code}`);
    }
  }
}
