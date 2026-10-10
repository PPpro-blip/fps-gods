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

    this.elements = {
      home: document.querySelector('#home-screen'),
      lobby: document.querySelector('#lobby-screen'),
      match: document.querySelector('#match-hud'),
      connection: document.querySelector('#connection-pill'),
      connectionLabel: document.querySelector('#connection-label'),
      name: document.querySelector('#player-name'),
      roomCodeInput: document.querySelector('#room-code-input'),
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
      ammo: document.querySelector('#ammo-value'),
      ammoMax: document.querySelector('#ammo-max'),
      ammoStatus: document.querySelector('#ammo-status'),
      ammoWidget: document.querySelector('.ammo-widget'),
      reloadHint: document.querySelector('#reload-hint'),
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
    this.elements.create.addEventListener('click', () => this.handlers.onCreate?.(this.playerName));
    this.elements.joinForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const code = this.elements.roomCodeInput.value.trim().toUpperCase();
      if (code.length !== 6) {
        this.showError('Enter all six characters of the room code.');
        return;
      }
      this.handlers.onJoin?.(this.playerName, code);
    });
    this.elements.roomCodeInput.addEventListener('input', () => {
      this.elements.roomCodeInput.value = this.elements.roomCodeInput.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6);
      this.clearError();
    });
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
    this.elements.connection.classList.toggle('is-connected', connected);
    this.elements.connection.classList.toggle('is-offline', offline);
    this.elements.connectionLabel.textContent = connected
      ? 'SERVER CONNECTED'
      : offline
        ? 'CONNECTION LOST'
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
    this.elements.lobby.hidden = true;
    this.elements.match.hidden = true;
    this.elements.end.hidden = true;
    this.elements.pause.hidden = true;
    this.elements.death.hidden = true;
    this.elements.scoreboard.hidden = true;
    this.scoreboardOpen = false;
  }

  showLobby(room = this.room, selfId = this.selfId) {
    if (!room) return;
    this.room = room;
    this.selfId = selfId;
    this.lastHudPlayer = null;
    this.elements.home.hidden = true;
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
    const everyoneReady = room.players.length >= room.minPlayers && room.players.every((player) => player.ready);
    const waitingCount = room.players.filter((player) => !player.ready).length;

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
      subtitle.textContent = player.id === selfId ? 'YOU' : 'OPERATOR';
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

    if (room.players.length < room.minPlayers) {
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
    this.elements.ammo.textContent = String(player.ammo ?? 12);
    this.elements.ammoMax.textContent = String(player.maxAmmo ?? 12);
    this.elements.ammoWidget.classList.toggle('is-reloading', Boolean(player.reloading));
    this.elements.ammoStatus.textContent = player.reloading ? 'RELOADING' : 'READY';
    this.elements.reloadHint.textContent = player.reloading ? 'MAGAZINE INCOMING' : 'R TO RELOAD';

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
      name.textContent = `${index + 1}. ${player.name}`;
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
