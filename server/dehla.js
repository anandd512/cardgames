'use strict';

/**
 * Dehla Pakad (custom fast variant)
 * 4 players, fixed teams: South/North (Team 0) vs West/East (Team 1)
 */

const { createDeck, shuffle } = require('./deck');

const SEATS = ['South', 'West', 'North', 'East'];
const TEAM_OF = [0, 1, 0, 1];
const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];

const GAME_PHASES = {
  WAITING: 'waiting',
  PLAYING: 'playing',
  TRICK_PAUSE: 'trick_pause',
  ROUND_END: 'round_end',
  GAME_OVER: 'game_over',
};

function createGame(roomId, options = {}) {
  const totalRounds = clampRounds(options.totalRounds);
  return {
    roomId,
    gameType: 'dehla',
    phase: GAME_PHASES.WAITING,
    players: [null, null, null, null],
    hands: [[], [], [], []],
    tricks: [0, 0, 0, 0],
    currentTrick: [],
    trickHistory: [],
    currentSeat: 0,
    dealerSeat: 0,
    roundNumber: 0,
    totalRounds,
    roundWins: [0, 0],
    roundDraws: 0,
    teamTensCaptured: [0, 0],
    trumpSuit: null,
    potentialTrumpSuit: null,
    lastTrickWinner: null,
    lastRoundSummary: null,
    roundSummaries: [],
    turnDeadlineTs: null,
    turnDurationMs: 15000,
    log: [],
  };
}

function clampRounds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 7;
  return Math.max(1, Math.min(20, Math.floor(n)));
}

function dealRound(game) {
  const deck = shuffle(createDeck());
  game.hands = [[], [], [], []];
  game.tricks = [0, 0, 0, 0];
  game.currentTrick = [];
  game.trickHistory = [];
  game.teamTensCaptured = [0, 0];
  game.trumpSuit = null;
  game.potentialTrumpSuit = null;
  game.lastTrickWinner = null;
  game.lastRoundSummary = null;
  game.roundNumber++;

  for (let i = 0; i < 52; i++) {
    game.hands[i % 4].push(deck[i]);
  }

  for (let s = 0; s < 4; s++) {
    game.hands[s].sort((a, b) => {
      const si = SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
      return si !== 0 ? si : a.value - b.value;
    });
  }

  // First lead is player to dealer's right.
  game.currentSeat = (game.dealerSeat + 3) % 4;
  game.phase = GAME_PHASES.PLAYING;
  _log(game, `Round ${game.roundNumber} dealt. ${SEATS[game.currentSeat]} leads.`);
}

function playCard(game, seat, cardId) {
  if (game.phase !== GAME_PHASES.PLAYING) return { error: 'Not in playing phase' };
  if (game.currentSeat !== seat) return { error: 'Not your turn' };

  const handIdx = game.hands[seat].findIndex((c) => `${c.rank}_${c.suit}` === cardId);
  if (handIdx === -1) return { error: 'Card not in hand' };

  const card = game.hands[seat][handIdx];
  const legal = getLegalCards(game, seat);
  if (!legal.find((c) => `${c.rank}_${c.suit}` === cardId)) {
    return { error: 'Illegal card play' };
  }

  game.hands[seat].splice(handIdx, 1);

  const leadSuit = game.currentTrick.length > 0 ? game.currentTrick[0].card.suit : null;
  if (leadSuit && game.trumpSuit === null && card.suit !== leadSuit) {
    game.potentialTrumpSuit = card.suit;
  }

  game.currentTrick.push({ seat, card });
  _log(game, `${SEATS[seat]} plays ${card.rank} of ${card.suit}.`);

  if (game.currentTrick.length === 4) {
    return _completeTrick(game);
  }

  game.currentSeat = (seat + 1) % 4;
  return { ok: true };
}

function getLegalCards(game, seat) {
  const hand = game.hands[seat];
  if (game.currentTrick.length === 0) return hand;

  const ledSuit = game.currentTrick[0].card.suit;
  const matching = hand.filter((c) => c.suit === ledSuit);
  return matching.length > 0 ? matching : hand;
}

function _completeTrick(game) {
  const trick = game.currentTrick;
  const ledSuit = trick[0].card.suit;
  const activeTrumpSuit = game.trumpSuit || game.potentialTrumpSuit;
  let winner = trick[0];

  for (let i = 1; i < trick.length; i++) {
    const entry = trick[i];
    if (_beats(entry.card, winner.card, ledSuit, activeTrumpSuit)) {
      winner = entry;
    }
  }

  if (game.trumpSuit === null && game.potentialTrumpSuit) {
    game.trumpSuit = game.potentialTrumpSuit;
    _log(game, `Trump revealed: ${game.trumpSuit}.`);
  }
  game.potentialTrumpSuit = null;

  game.tricks[winner.seat]++;
  const winnerTeam = TEAM_OF[winner.seat];
  const tensInTrick = trick.reduce((sum, t) => sum + (t.card.rank === '10' ? 1 : 0), 0);
  game.teamTensCaptured[winnerTeam] += tensInTrick;

  game.trickHistory.push({ trick: [...trick], winner: winner.seat });
  game.lastTrickWinner = winner.seat;
  game.phase = GAME_PHASES.TRICK_PAUSE;
  game.currentSeat = winner.seat;

  _log(game, `${SEATS[winner.seat]} wins the trick and captures ${tensInTrick} ten(s).`);

  const roundWillEnd = game.hands.every((h) => h.length === 0);
  return { ok: true, trickComplete: true, trickWinner: winner.seat, roundWillEnd };
}

function advanceAfterTrickPause(game) {
  if (game.phase !== GAME_PHASES.TRICK_PAUSE) return { error: 'No trick pause to advance' };

  const winnerSeat = game.lastTrickWinner;
  game.currentTrick = [];

  if (game.hands.every((h) => h.length === 0)) {
    return _scoreRound(game);
  }

  game.phase = GAME_PHASES.PLAYING;
  game.currentSeat = winnerSeat;
  return { ok: true, trickWinner: winnerSeat };
}

function _scoreRound(game) {
  const t0 = game.teamTensCaptured[0];
  const t1 = game.teamTensCaptured[1];
  let roundWinnerTeam = null;

  if (t0 >= 3) roundWinnerTeam = 0;
  else if (t1 >= 3) roundWinnerTeam = 1;

  if (roundWinnerTeam === null) {
    game.roundDraws++;
    _log(game, `Round ${game.roundNumber} is a draw (2-2 tens).`);
  } else {
    game.roundWins[roundWinnerTeam]++;
    _log(game, `Round ${game.roundNumber}: Team ${roundWinnerTeam + 1} wins with ${game.teamTensCaptured[roundWinnerTeam]} ten(s).`);
  }

  game.lastRoundSummary = {
    roundNumber: game.roundNumber,
    roundWinnerTeam,
    roundWins: [...game.roundWins],
    teamTensCaptured: [...game.teamTensCaptured],
    trumpSuit: game.trumpSuit,
    roundDraws: game.roundDraws,
  };
  game.roundSummaries.push(game.lastRoundSummary);

  game.phase = GAME_PHASES.ROUND_END;

  if (game.roundNumber >= game.totalRounds) {
    game.phase = GAME_PHASES.GAME_OVER;
    let winningTeam = null;
    if (game.roundWins[0] !== game.roundWins[1]) {
      winningTeam = game.roundWins[0] > game.roundWins[1] ? 0 : 1;
    }
    _log(game, winningTeam === null ? 'GAME OVER! Match tied.' : `GAME OVER! Team ${winningTeam + 1} wins the match.`);
    return { ok: true, roundEnd: true, gameOver: true, winningTeam, scores: [...game.roundWins] };
  }

  game.dealerSeat = (game.dealerSeat + 1) % 4;
  return { ok: true, roundEnd: true, gameOver: false, scores: [...game.roundWins] };
}

function _beats(challenger, current, ledSuit, trumpSuit) {
  if (trumpSuit) {
    if (challenger.suit === trumpSuit && current.suit !== trumpSuit) return true;
    if (current.suit === trumpSuit && challenger.suit !== trumpSuit) return false;
  }

  if (challenger.suit === current.suit) return challenger.value > current.value;

  if (challenger.suit === ledSuit && current.suit !== ledSuit) return true;
  return false;
}

function _buildCompetitionSummary(game) {
  const leaderTeam = game.roundWins[0] === game.roundWins[1]
    ? null
    : (game.roundWins[0] > game.roundWins[1] ? 0 : 1);
  const leadBy = Math.abs(game.roundWins[0] - game.roundWins[1]);
  const roundsLeft = Math.max(0, game.totalRounds - game.roundNumber);

  return {
    leaderTeam,
    leadBy,
    roundsLeft,
    roundsToWin: [
      Math.max(0, game.roundWins[1] - game.roundWins[0] + 1),
      Math.max(0, game.roundWins[0] - game.roundWins[1] + 1),
    ],
  };
}

function getPublicState(game, viewerSeat) {
  return {
    roomId: game.roomId,
    gameType: game.gameType,
    phase: game.phase,
    players: game.players,
    hands: game.hands.map((hand, s) => {
      if (viewerSeat === null || viewerSeat === undefined) {
        if (s === 0) return hand;
        if (game.phase === GAME_PHASES.ROUND_END || game.phase === GAME_PHASES.GAME_OVER) return hand;
        return hand.map(() => ({ hidden: true }));
      }
      return s === viewerSeat ? hand : hand.map(() => ({ hidden: true }));
    }),
    handCounts: game.hands.map((h) => h.length),
    tricks: game.tricks,
    teamScore: [...game.roundWins],
    teamBags: [0, 0],
    roundWins: [...game.roundWins],
    totalRounds: game.totalRounds,
    roundDraws: game.roundDraws,
    teamTensCaptured: [...game.teamTensCaptured],
    currentTrick: game.currentTrick,
    trickHistory: game.trickHistory.slice(-5),
    currentSeat: game.currentSeat,
    dealerSeat: game.dealerSeat,
    roundNumber: game.roundNumber,
    trumpSuit: game.trumpSuit,
    potentialTrumpSuit: game.potentialTrumpSuit,
    lastTrickWinner: game.lastTrickWinner,
    lastBidWinnerSeat: null,
    lastRoundSummary: game.lastRoundSummary,
    competition: _buildCompetitionSummary(game),
    turnDeadlineTs: game.turnDeadlineTs,
    turnDurationMs: game.turnDurationMs,
    legalCards: viewerSeat !== null && viewerSeat !== undefined && game.phase === GAME_PHASES.PLAYING && game.currentSeat === viewerSeat
      ? getLegalCards(game, viewerSeat).map((c) => `${c.rank}_${c.suit}`)
      : [],
    log: game.log.slice(-20),
  };
}

function _log(game, msg) {
  const entry = { time: Date.now(), msg };
  game.log.push(entry);
  if (game.log.length > 200) game.log.shift();
}

function placeBid(game, seat, bid) {
  // Dehla Pakad has no bidding phase — this stub prevents crashes if called
  return { error: 'Dehla Pakad has no bidding' };
}

module.exports = {
  GAME_PHASES,
  SEATS,
  TEAM_OF,
  SUITS,
  createGame,
  dealRound,
  playCard,
  placeBid,
  advanceAfterTrickPause,
  getLegalCards,
  getPublicState,
};