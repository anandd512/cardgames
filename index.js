'use strict';

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const spadesEngine = require('./server/spades');
const judgementEngine = require('./server/judgement');
const dehlaEngine = require('./server/dehla');
const { botBid, botChooseCard, botChooseTrump, BOT_NAMES, BOT_AVATARS } = require('./server/bot');

const ENGINES = {
  spades: spadesEngine,
  judgement: judgementEngine,
  dehla: dehlaEngine,
};

// ─── Server Setup ─────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ─── State ────────────────────────────────────────────────────────────────────
const rooms    = new Map(); // roomId → game
const clients  = new Map(); // socketId → { roomId, seat, name, isSpectator }
const turnTimers = new Map(); // roomId -> timeout

// ─── Bot tick delay (ms between bot actions) ──────────────────────────────────
const BOT_BID_MS_MIN = 1800;
const BOT_BID_MS_MAX = 3200;
const BOT_PLAY_MS_MIN = 1400;
const BOT_PLAY_MS_MAX = 2500;
const TRICK_PAUSE_MS = 1800;
const BIDDING_PAUSE_MS = 2000;
const ROUND_PAUSE_MS = 5000;
const TURN_TIMEOUT_MS = 15000;
const BIDDING_TURN_TIMEOUT_MS = 60000;

const ALLOWED_REACTIONS = new Set(['laugh', 'cry', 'well_played', 'angry', 'waiting', 'fire']);
const ALLOWED_AVATARS = {
  ironman: 'Iron man',
  captain: 'Captain America',
  thor: 'Thor',
  hulk: 'Hulk',
  blackwidow: 'Black widow',
  hawkeye: 'Hawk eye',
  strange: 'Doctor strange',
  panther: 'Black panther',
  scarletwitch: 'Scarlet witch',
  thanos: 'Thanos',
  spiderman: 'Spiderman',
  captainmarvel: 'Captain Marvel',
};

function botDelay(phase) {
  if (phase === 'bidding') {
    return BOT_BID_MS_MIN + Math.random() * (BOT_BID_MS_MAX - BOT_BID_MS_MIN);
  }
  return BOT_PLAY_MS_MIN + Math.random() * (BOT_PLAY_MS_MAX - BOT_PLAY_MS_MIN);
}

function normalizeGameType(gameType) {
  if (gameType === 'judgement') return 'judgement';
  if (gameType === 'dehla') return 'dehla';
  return 'spades';
}

function getEngine(typeOrGame) {
  const type = typeof typeOrGame === 'string'
    ? normalizeGameType(typeOrGame)
    : normalizeGameType(typeOrGame && typeOrGame.gameType);
  return ENGINES[type] || ENGINES.spades;
}

function getPhases(game) {
  return getEngine(game).GAME_PHASES;
}

function createGameByType(roomId, gameType, options = {}) {
  const engine = getEngine(gameType);
  return engine.createGame(roomId, options);
}

function dealRoundForGame(game) {
  return getEngine(game).dealRound(game);
}

function placeBidForGame(game, seat, bid) {
  return getEngine(game).placeBid(game, seat, bid);
}

function chooseTrumpForGame(game, seat, suit) {
  const engine = getEngine(game);
  if (!engine.chooseTrump) return { error: 'Trump selection is not available' };
  return engine.chooseTrump(game, seat, suit);
}

function playCardForGame(game, seat, cardId) {
  return getEngine(game).playCard(game, seat, cardId);
}

function advanceAfterTrickPauseForGame(game) {
  return getEngine(game).advanceAfterTrickPause(game);
}

function advanceAfterBiddingPauseForGame(game) {
  const engine = getEngine(game);
  if (!engine.advanceAfterBiddingPause) return null;
  return engine.advanceAfterBiddingPause(game);
}

function getPublicStateForGame(game, seat) {
  return getEngine(game).getPublicState(game, seat);
}

function getTurnTimeoutMs(game) {
  if (!game) return TURN_TIMEOUT_MS;
  const phases = getPhases(game);
  if (game.phase === phases.BIDDING || game.phase === phases.TRUMP_SELECTION) return BIDDING_TURN_TIMEOUT_MS;
  return TURN_TIMEOUT_MS;
}

function isActionPhase(game) {
  const phases = getPhases(game);
  return game.phase === phases.BIDDING || game.phase === phases.PLAYING || game.phase === phases.TRUMP_SELECTION;
}

function maybeAutoStartJudgement(game) {
  const phases = getPhases(game);
  if (game.gameType !== 'judgement') return false;
  if (game.phase !== phases.WAITING) return false;
  if (game.players.some((p) => p === null)) return false;

  dealRoundForGame(game);
  scheduleTurnTimer(game);
  broadcastState(game);
  scheduleBot(game);
  return true;
}

function maybeAutoStartDehla(game) {
  const phases = getPhases(game);
  if (game.gameType !== 'dehla') return false;
  if (game.phase !== phases.WAITING) return false;
  if (game.players.some((p) => p === null)) return false;

  dealRoundForGame(game);
  scheduleTurnTimer(game);
  broadcastState(game);
  scheduleBot(game);
  return true;
}

function maybeAutoStartByGameType(game) {
  if (game.gameType === 'judgement') {
    return maybeAutoStartJudgement(game);
  }
  if (game.gameType === 'dehla') {
    return maybeAutoStartDehla(game);
  }
  return false;
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function broadcastState(game) {
  // Send each human player their personalised state
  for (const [socketId, info] of clients) {
    if (info.roomId !== game.roomId) continue;
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;
    const seat = info.isSpectator ? null : info.seat;
    socket.emit('gameState', getPublicStateForGame(game, seat));
  }
}

function makeRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function normalizeAvatar(avatarId) {
  if (typeof avatarId !== 'string') return 'ironman';
  return ALLOWED_AVATARS[avatarId] ? avatarId : 'ironman';
}

function clearTurnTimer(roomId) {
  const t = turnTimers.get(roomId);
  if (t) {
    clearTimeout(t);
    turnTimers.delete(roomId);
  }
}

function scheduleTurnTimer(game) {
  clearTurnTimer(game.roomId);
  if (!isActionPhase(game)) {
    game.turnDeadlineTs = null;
    return;
  }

  const timeoutMs = getTurnTimeoutMs(game);
  game.turnDurationMs = timeoutMs;
  game.turnDeadlineTs = Date.now() + timeoutMs;
  const deadlineSnapshot = game.turnDeadlineTs;
  const phases = getPhases(game);

  const handle = setTimeout(() => {
    if (!rooms.has(game.roomId)) return;
    const g = rooms.get(game.roomId);
    if (g.turnDeadlineTs !== deadlineSnapshot) return;
    if (!isActionPhase(g)) return;

    const seat = g.currentSeat;
    if (seat === null || seat === undefined) return;

    let result;
    if (g.phase === phases.BIDDING) {
      const bid = g.gameType === 'judgement' ? 6 : botBid(g, seat);
      result = placeBidForGame(g, seat, bid);
    } else if (g.phase === phases.TRUMP_SELECTION) {
      result = chooseTrumpForGame(g, seat, 'spades');
    } else {
      result = playCardForGame(g, seat, botChooseCard(g, seat));
    }

    broadcastState(g);
    if (result && !result.error) {
      handleActionResult(g, result);
    }
  }, timeoutMs + 20);

  turnTimers.set(game.roomId, handle);
}

function handleActionResult(game, result) {
  if (result && result.biddingComplete) {
    clearTurnTimer(game.roomId);
    // Show a live countdown during the pause so the clock drains on clients
    game.turnDeadlineTs = Date.now() + BIDDING_PAUSE_MS;
    game.turnDurationMs = BIDDING_PAUSE_MS;
    broadcastState(game);
    setTimeout(() => {
      if (!rooms.has(game.roomId)) return;
      const g = rooms.get(game.roomId);
      if (g.phase !== 'bidding_pause') return;
      advanceAfterBiddingPauseForGame(g);
      broadcastState(g);
      scheduleTurnTimer(g);
      scheduleBot(g);
    }, BIDDING_PAUSE_MS);
    return;
  }

  if (result && result.trickComplete) {
    clearTurnTimer(game.roomId);
    game.turnDeadlineTs = null;
    setTimeout(() => {
      if (!rooms.has(game.roomId)) return;
      const gx = rooms.get(game.roomId);
      const advance = advanceAfterTrickPauseForGame(gx);
      broadcastState(gx);

      if (advance && advance.roundEnd) {
        clearTurnTimer(gx.roomId);
        if (advance.gameOver) {
          gx._endedAt = Date.now();
          io.to(gx.roomId).emit('gameOver', {
            winningTeam: advance.winningTeam,
            scores: advance.scores,
          });
          return;
        }
        setTimeout(() => {
          if (!rooms.has(gx.roomId)) return;
          dealRoundForGame(gx);
          scheduleTurnTimer(gx);
          broadcastState(gx);
          scheduleBot(gx);
        }, ROUND_PAUSE_MS);
        return;
      }

      scheduleTurnTimer(gx);
      broadcastState(gx);
      scheduleBot(gx);
    }, TRICK_PAUSE_MS);
    return;
  }

  if (result && result.roundEnd) {
    clearTurnTimer(game.roomId);
    game.turnDeadlineTs = null;
    if (result.gameOver) {
      game._endedAt = Date.now();
      io.to(game.roomId).emit('gameOver', {
        winningTeam: result.winningTeam,
        scores: result.scores,
      });
    } else {
      setTimeout(() => {
        if (!rooms.has(game.roomId)) return;
        dealRoundForGame(game);
        scheduleTurnTimer(game);
        broadcastState(game);
        scheduleBot(game);
      }, ROUND_PAUSE_MS);
    }
    return;
  }

  scheduleTurnTimer(game);
  broadcastState(game);
  scheduleBot(game);
}

// ─── Bot Scheduler ────────────────────────────────────────────────────────────
function scheduleBot(game) {
  const seat = game.currentSeat;
  if (seat === undefined || seat === null) return;
  const player = game.players[seat];
  if (!player || !player.isBot) return;

  // Only act in phases that require action
  if (!isActionPhase(game)) return;
  const phases = getPhases(game);

  setTimeout(() => {
    // Re-validate; human may have acted in between
    if (!rooms.has(game.roomId)) return;
    const g = rooms.get(game.roomId);
    if (g.currentSeat !== seat) return;
    if (!isActionPhase(g)) return;

    let result;
    if (g.phase === phases.BIDDING) {
      const bid = botBid(g, seat);
      result = placeBidForGame(g, seat, bid);
    } else if (g.phase === phases.TRUMP_SELECTION) {
      result = chooseTrumpForGame(g, seat, botChooseTrump(g, seat));
    } else if (g.phase === phases.PLAYING) {
      const cardId = botChooseCard(g, seat);
      result = playCardForGame(g, seat, cardId);
    }

    if (result && !result.error) {
      broadcastState(g);
      handleActionResult(g, result);
    }
  }, botDelay(game.phase));
}

// ─── Socket Events ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── Create Room ──────────────────────────────────────────────────────────
  socket.on('createRoom', ({ playerName, gameType, totalRounds, avatar }, cb) => {
    const roomId = makeRoomId();
    const selectedGameType = normalizeGameType(gameType);
    const game   = createGameByType(roomId, selectedGameType, { totalRounds });
    rooms.set(roomId, game);

    // Creator takes seat 0 (South)
    const name   = sanitize(playerName) || 'Player';
    const avatarId = normalizeAvatar(avatar);
    game.players[0] = { id: socket.id, name, avatar: avatarId, avatarEmoji: ALLOWED_AVATARS[avatarId], isBot: false };
    clients.set(socket.id, { roomId, seat: 0, name, isSpectator: false });

    socket.join(roomId);
    cb({ ok: true, roomId, seat: 0 });
    broadcastState(game);
    console.log(`[Room] ${roomId} created by ${name} (${selectedGameType})`);
  });

  // ── Join Room ────────────────────────────────────────────────────────────
  socket.on('joinRoom', ({ roomId, playerName, avatar }, cb) => {
    const id   = roomId.toUpperCase();
    const game = rooms.get(id);
    if (!game) return cb({ error: 'Room not found' });
    const phases = getPhases(game);
    if (game.phase !== phases.WAITING) return cb({ error: 'Game already started' });

    const freeSeat = game.players.findIndex(p => p === null);
    if (freeSeat === -1) return cb({ error: 'Room is full' });

    const name = sanitize(playerName) || 'Player';
    const avatarId = normalizeAvatar(avatar);
    game.players[freeSeat] = { id: socket.id, name, avatar: avatarId, avatarEmoji: ALLOWED_AVATARS[avatarId], isBot: false };
    clients.set(socket.id, { roomId: id, seat: freeSeat, name, isSpectator: false });

    socket.join(id);
    cb({ ok: true, roomId: id, seat: freeSeat });
    broadcastState(game);
    const seats = getEngine(game).SEATS || ['South', 'West', 'North', 'East'];
    console.log(`[Room] ${name} joined ${id} as seat ${freeSeat} (${seats[freeSeat]})`);
    maybeAutoStartByGameType(game);
  });

  // ── Watch Room (Spectator) ───────────────────────────────────────────────
  socket.on('watchRoom', ({ roomId }, cb) => {
    const id   = roomId.toUpperCase();
    const game = rooms.get(id);
    if (!game) return cb({ error: 'Room not found' });

    clients.set(socket.id, { roomId: id, seat: null, name: 'Spectator', isSpectator: true });
    socket.join(id);
    cb({ ok: true, roomId: id });
    socket.emit('gameState', getPublicStateForGame(game, null));
    console.log(`[Room] Spectator watching ${id}`);
  });

  // ── Start Simulation (all bots) ──────────────────────────────────────────
  socket.on('startSimulation', ({ roomId, gameType, totalRounds }, cb) => {
    const id   = roomId ? roomId.toUpperCase() : null;
    let game;

    if (id && rooms.has(id)) {
      game = rooms.get(id);
    } else {
      // Create a fresh simulation room
      const newId = makeRoomId();
      game = createGameByType(newId, normalizeGameType(gameType), { totalRounds });
      rooms.set(newId, game);
      clients.set(socket.id, { roomId: newId, seat: null, name: 'Spectator', isSpectator: true });
      socket.join(newId);
    }

    // Fill all seats with bots
    for (let s = 0; s < 4; s++) {
      if (!game.players[s]) {
        const avatarId = BOT_AVATARS[s] || 'captain';
        game.players[s] = { id: `bot_${s}`, name: BOT_NAMES[s], avatar: avatarId, avatarEmoji: ALLOWED_AVATARS[avatarId], isBot: true };
      } else if (!game.players[s].isBot) {
        // Leave human players as-is
      }
    }

    cb({ ok: true, roomId: game.roomId });
    if (!id || id !== game.roomId) {
      socket.emit('gameState', getPublicStateForGame(game, null));
    }

    dealRoundForGame(game);
    scheduleTurnTimer(game);
    broadcastState(game);
    scheduleBot(game);
    console.log(`[Sim] Simulation started in room ${game.roomId}`);
  });

  // ── Fill Empty Seats with Bots ───────────────────────────────────────────
  socket.on('fillBots', ({ roomId }, cb) => {
    const id   = roomId.toUpperCase();
    const game = rooms.get(id);
    if (!game) return cb({ error: 'Room not found' });
    const phases = getPhases(game);
    if (game.phase !== phases.WAITING) return cb({ error: 'Game already started' });

    for (let s = 0; s < 4; s++) {
      if (!game.players[s]) {
        const avatarId = BOT_AVATARS[s] || 'captain';
        game.players[s] = { id: `bot_${s}`, name: BOT_NAMES[s], avatar: avatarId, avatarEmoji: ALLOWED_AVATARS[avatarId], isBot: true };
      }
    }

    cb({ ok: true });
    broadcastState(game);
    maybeAutoStartByGameType(game);
  });

  // ── Start Game ───────────────────────────────────────────────────────────
  socket.on('startGame', ({ roomId }, cb) => {
    const id   = roomId.toUpperCase();
    const game = rooms.get(id);
    if (!game) return cb({ error: 'Room not found' });
    const phases = getPhases(game);
    if (game.phase !== phases.WAITING) return cb({ error: 'Already started' });
    if (game.players.some(p => p === null)) return cb({ error: 'Need 4 players' });

    const info = clients.get(socket.id);
    if (!info || info.seat !== 0) return cb({ error: 'Only the host can start' });

    dealRoundForGame(game);
    scheduleTurnTimer(game);
    broadcastState(game);
    scheduleBot(game);
    cb({ ok: true });
    console.log(`[Room] Game started in ${id}`);
  });

  // ── Place Bid ────────────────────────────────────────────────────────────
  socket.on('placeBid', ({ bid }, cb) => {
    const info = clients.get(socket.id);
    if (!info || info.isSpectator) return cb && cb({ error: 'Not a player' });
    const game = rooms.get(info.roomId);
    if (!game) return cb && cb({ error: 'No game' });

    const result = placeBidForGame(game, info.seat, bid);
    if (result.error) return cb && cb(result);
    broadcastState(game);
    cb && cb({ ok: true });
    handleActionResult(game, result);
  });

  // ── Choose Trump ─────────────────────────────────────────────────────────
  socket.on('chooseTrump', ({ suit }, cb) => {
    const info = clients.get(socket.id);
    if (!info || info.isSpectator) return cb && cb({ error: 'Not a player' });
    const game = rooms.get(info.roomId);
    if (!game) return cb && cb({ error: 'No game' });

    const result = chooseTrumpForGame(game, info.seat, suit);
    if (result.error) return cb && cb(result);
    broadcastState(game);
    cb && cb({ ok: true });
    handleActionResult(game, result);
  });

  // ── Play Card ────────────────────────────────────────────────────────────
  socket.on('playCard', ({ cardId }, cb) => {
    const info = clients.get(socket.id);
    if (!info || info.isSpectator) return cb && cb({ error: 'Not a player' });
    const game = rooms.get(info.roomId);
    if (!game) return cb && cb({ error: 'No game' });

    const result = playCardForGame(game, info.seat, cardId);
    if (result.error) return cb && cb(result);
    broadcastState(game);
    cb && cb({ ok: true });
    handleActionResult(game, result);
  });

  // ── Next Round (after round_end confirmation) ────────────────────────────
  socket.on('nextRound', ({ roomId }) => {
    const id   = (roomId || '').toUpperCase();
    const game = rooms.get(id);
    if (!game) return;
    const phases = getPhases(game);
    if (game.phase !== phases.ROUND_END) return;
    dealRoundForGame(game);
    scheduleTurnTimer(game);
    broadcastState(game);
    scheduleBot(game);
  });

  // ── Live Reactions ───────────────────────────────────────────────────────
  socket.on('sendReaction', ({ reaction }, cb) => {
    const info = clients.get(socket.id);
    if (!info) return cb && cb({ error: 'Not in room' });
    const game = rooms.get(info.roomId);
    if (!game) return cb && cb({ error: 'No game' });
    if (!ALLOWED_REACTIONS.has(reaction)) return cb && cb({ error: 'Invalid reaction' });

    const payload = {
      reaction,
      seat: info.isSpectator ? null : info.seat,
      name: info.name || (info.isSpectator ? 'Spectator' : 'Player'),
      at: Date.now(),
    };
    io.to(info.roomId).emit('reactionEvent', payload);
    cb && cb({ ok: true });
  });

  // ── Reconnect (restore socket after disconnect) ─────────────────────────
  socket.on('reconnectRoom', ({ roomId, playerName }, cb) => {
    const id = (roomId || '').toUpperCase();
    const game = rooms.get(id);
    if (!game) return cb && cb({ error: 'Room not found' });
    const phases = getPhases(game);
    if (game.phase === phases.GAME_OVER) return cb && cb({ error: 'Game already over' });

    const name = sanitize(playerName || '');

    // Case 1: seat is held by a bot placeholder from this player's disconnect
    let seat = game.players.findIndex(p => p && p._originalName === name);

    // Case 2: player reconnected before bot takeover — slot still human
    if (seat === -1) {
      seat = game.players.findIndex(p => p && !p.isBot && p.name === name);
      if (seat !== -1) {
        // Just update the socket reference
        game.players[seat].id = socket.id;
        clients.set(socket.id, { roomId: id, seat, name: game.players[seat].name, isSpectator: false });
        socket.join(id);
        cb && cb({ ok: true, roomId: id, seat });
        socket.emit('gameState', getPublicStateForGame(game, seat));
        console.log(`[Room] ${name} re-registered in ${id} as seat ${seat}`);
        return;
      }
      return cb && cb({ error: 'Player not found in room' });
    }

    // Restore the human from the bot placeholder
    const placeholder = game.players[seat];
    const restoredAvatar = placeholder._originalAvatar || 'ironman';
    game.players[seat] = {
      id: socket.id,
      name: placeholder._originalName,
      avatar: restoredAvatar,
      avatarEmoji: ALLOWED_AVATARS[restoredAvatar] || '',
      isBot: false,
    };
    clients.set(socket.id, { roomId: id, seat, name: placeholder._originalName, isSpectator: false });
    socket.join(id);
    cb && cb({ ok: true, roomId: id, seat });
    socket.emit('gameState', getPublicStateForGame(game, seat));
    broadcastState(game);
    console.log(`[Room] ${name} reconnected to ${id} as seat ${seat}`);
  });

  // ── Disconnect ───────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const info = clients.get(socket.id);
    if (info && !info.isSpectator) {
      const game = rooms.get(info.roomId);
      const phases = game ? getPhases(game) : null;
      if (game && game.phase === phases.WAITING) {
        game.players[info.seat] = null;
        broadcastState(game);
      } else if (game && phases && game.phase !== phases.GAME_OVER) {
        // Replace disconnected seat with a bot so the game can continue
        const disconnectedPlayer = game.players[info.seat] || {};
        const avatarId = BOT_AVATARS[info.seat] || 'captain';
        game.players[info.seat] = {
          id: `bot_${info.seat}`,
          name: BOT_NAMES[info.seat],
          _originalName: disconnectedPlayer.name || info.name,
          _originalAvatar: disconnectedPlayer.avatar || 'ironman',
          avatar: avatarId,
          avatarEmoji: ALLOWED_AVATARS[avatarId],
          isBot: true,
        };
        broadcastState(game);
        scheduleBot(game);
      }
    }
    if (info && info.roomId) {
      const game = rooms.get(info.roomId);
      if (game && isActionPhase(game)) {
        scheduleTurnTimer(game);
      } else {
        clearTurnTimer(info.roomId);
      }
    }
    clients.delete(socket.id);
    console.log(`[-] Disconnected: ${socket.id}`);
  });
});

// ─── Input sanitization ───────────────────────────────────────────────────────
function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'&]/g, '').slice(0, 20).trim();
}

// ─── Periodic room cleanup (prevent memory leak) ─────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [roomId, game] of rooms) {
    const hasClients = [...clients.values()].some(c => c.roomId === roomId);
    if (!hasClients) {
      rooms.delete(roomId);
      clearTurnTimer(roomId);
      continue;
    }
    // Remove finished games that have been sitting for 10 minutes
    if ((game.phase === 'game_over') && game._endedAt && (now - game._endedAt > 10 * 60 * 1000)) {
      rooms.delete(roomId);
      clearTurnTimer(roomId);
    }
  }
}, 60 * 1000);

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🃏  CardGames running at http://localhost:${PORT}\n`);
});
