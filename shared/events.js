// One shared event registry keeps the browser and Node server in lockstep.
export const EVENTS = Object.freeze({
  CREATE_ROOM: 'CREATE_ROOM',
  JOIN_ROOM: 'JOIN_ROOM',
  PLAY_NOW: 'PLAY_NOW',
  // Read-only lobby browser. The server answers with public multiplayer rooms
  // only; solo bot rooms and resume tokens are never part of that payload.
  LIST_ROOMS: 'LIST_ROOMS',
  ROOM_LIST: 'ROOM_LIST',
  ROOM_STATE: 'ROOM_STATE',
  ROOM_ERROR: 'ROOM_ERROR',
  ROOM_SESSION: 'ROOM_SESSION',
  ROOM_RESUME: 'ROOM_RESUME',
  ROOM_RESUME_FAILED: 'ROOM_RESUME_FAILED',
  LEAVE_ROOM: 'LEAVE_ROOM',
  ROOM_LEFT: 'ROOM_LEFT',
  PLAYER_INPUT: 'PLAYER_INPUT',
  GAME_STATE_UPDATE: 'GAME_STATE_UPDATE',
  SHOOT: 'SHOOT',
  HIT_CONFIRMED: 'HIT_CONFIRMED',
  HITBOX_TRACE: 'HITBOX_TRACE',
  OPPONENT_HEALTH: 'OPPONENT_HEALTH',
  PLAYER_DIED: 'PLAYER_DIED',
  PLAYER_RESPAWNED: 'PLAYER_RESPAWNED',
  KILL_FEED_UPDATE: 'KILL_FEED_UPDATE',
  SCORE_UPDATE: 'SCORE_UPDATE',
  GAME_START: 'GAME_START',
  GAME_END: 'GAME_END',
  RETURN_TO_LOBBY: 'RETURN_TO_LOBBY',
  PLAY_AGAIN: 'PLAY_AGAIN',
  // Host-only arena change while the room is still in its lobby. Additive: a
  // client that never sends it keeps playing whatever the room created with.
  SET_ROOM_MAP: 'SET_ROOM_MAP',
  // Host-only bot difficulty preset change for solo-vs-bots matches.
  SET_BOT_DIFFICULTY: 'SET_BOT_DIFFICULTY',

  // Lobby and weapon actions are explicit, shared socket contracts.
  PLAYER_READY: 'PLAYER_READY',
  START_GAME: 'START_GAME',
  PLAYER_RELOAD: 'PLAYER_RELOAD',
  AMMO_UPDATE: 'AMMO_UPDATE',
  HEALTH_UPDATE: 'HEALTH_UPDATE',
  WEAPON_SWITCH: 'WEAPON_SWITCH',
  WEAPON_UPDATE: 'WEAPON_UPDATE',
  WEAPON_OVERHEATED: 'WEAPON_OVERHEATED',
  WEAPON_FIRED: 'WEAPON_FIRED',
  PROJECTILE_IMPACT: 'PROJECTILE_IMPACT',
  PROFILE_REQUEST: 'PROFILE_REQUEST',
  PROFILE_UPDATE: 'PROFILE_UPDATE',
  SMOKE_UPDATE: 'SMOKE_UPDATE',
  COVER_DESTROYED: 'COVER_DESTROYED',
  NET_PING: 'NET_PING',
  NET_PONG: 'NET_PONG',
  AUTH_SYNC: 'AUTH_SYNC',
  WALLET_UPDATE: 'WALLET_UPDATE',
  REWARD_EARNED: 'REWARD_EARNED',
});

export const ROOM_STATES = Object.freeze({
  LOBBY: 'LOBBY',
  PLAYING: 'PLAYING',
  ENDED: 'ENDED',
});

export const ROOM_MODES = Object.freeze({
  MULTIPLAYER: 'MULTIPLAYER',
  SOLO_VS_BOTS: 'SOLO_VS_BOTS',
});
