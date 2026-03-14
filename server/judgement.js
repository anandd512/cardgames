'use strict';

/**
 * Judgement Game Engine (custom variant)
 * 4 players, fixed teams: South/North (Team 0) vs West/East (Team 1)
 */

const { createDeck, shuffle } = require('./deck');

const SEATS = ['South', 'West', 'North', 'East'];
const TEAM_OF = [0, 1, 0, 1];
const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];
const MIN_BID = 6;
const MAX_BID = 13;

const GAME_PHASES = {
  BIDDING_PAUSE: 'bidding_pause',
  WAITING: 'waiting',
  BIDDING: 'bidding',
  TRUMP_SELECTION: 'trump_selection',
  PLAYING: 'playing',
  TRICK_PAUSE: 'trick_pause',
  ROUND_END: 'round_end',
  GAME_OVER: 'game_over',
};

function createGame(roomId, options = {}) {
  const totalRounds = clampRounds(options.totalRounds);
  return {
    roomId,
    gameType: 'judgement',
    phase: GAME_PHASES.WAITING,
    players: [null, null, null, null],
    hands: [[], [], [], []],
    bids: [null, null, null, null],
    tricks: [0, 0, 0, 0],
    currentTrick: [],
    trickHistory: [],
    currentSeat: 0,
    dealerSeat: 0,
    roundNumber: 0,
    totalRounds,
    maxRoundWinsToClinch: Math.floor(totalRounds / 2) + 1,
    roundWins: [0, 0],
    biddingWinnerTeam: null,
    trumpChooserSeat: null,
    trumpSuit: null,
    contractTeam: null,
    defenderTeam: null,
    contractTarget: null,
    defenderTarget: null,
    pendingRoundWinnerTeam: null,
    lastBidWinnerSeat: null,
    lastTrickWinner: null,
    lastRoundSummary: null,
    roundSummaries: [],
    turnDeadlineTs: null,
    turnDurationMs: 30000,
    log: [],
  };
}

function clampRounds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 7;
  return Math.max(1, Math.min(11, Math.floor(n)));
}

function dealRound(game) {
  const deck = shuffle(createDeck());
  game.hands = [[], [], [], []];
  game.bids = [null, null, null, null];
  game.tricks = [0, 0, 0, 0];
  game.currentTrick = [];
  game.trickHistory = [];
  game.biddingWinnerTeam = null;
  game.trumpChooserSeat = null;
  game.trumpSuit = null;
  game.contractTeam = null;
  game.defenderTeam = null;
  game.contractTarget = null;
  game.defenderTarget = null;
  game.pendingRoundWinnerTeam = null;
  game.lastBidWinnerSeat = null;
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

  game.currentSeat = (game.dealerSeat + 1) % 4;
  game.phase = GAME_PHASES.BIDDING;
  _log(game, `Round ${game.roundNumber} dealt. Bidding starts with ${SEATS[game.currentSeat]}.`);
}

function placeBid(game, seat, bid) {
  if (game.phase !== GAME_PHASES.BIDDING) return { error: 'Not in bidding phase' };
  if (game.currentSeat !== seat) return { error: 'Not your turn to bid' };
  if (typeof bid !== 'number' || bid < MIN_BID || bid > MAX_BID) {
    return { error: `Invalid bid (${MIN_BID}-${MAX_BID})` };
  }

  game.bids[seat] = bid;
  _log(game, `${SEATS[seat]} bids ${bid}.`);

  game.currentSeat = (seat + 1) % 4;

  if (game.bids.every((b) => b !== null)) {
    const team0Sum = game.bids[0] + game.bids[2];
    const team1Sum = game.bids[1] + game.bids[3];

    game.biddingWinnerTeam = team0Sum >= team1Sum ? 0 : 1;
    game.trumpChooserSeat = _pickTrumpChooserSeat(game, game.biddingWinnerTeam);
    game.lastBidWinnerSeat = game.trumpChooserSeat;
    game.phase = GAME_PHASES.BIDDING_PAUSE;
    game.currentSeat = game.trumpChooserSeat;
    return { ok: true, biddingComplete: true };

    _log(game, `Team 1 bid sum: ${team0Sum}. Team 2 bid sum: ${team1Sum}.`);
    if (team0Sum === team1Sum) {
      _log(game, 'Bid sums tied. Team 1 wins tie advantage.');
    }
    _log(game, `${SEATS[game.trumpChooserSeat]} will choose trump.`);
  }

  return { ok: true };
}

function advanceAfterBiddingPause(game) {
  if (game.phase !== GAME_PHASES.BIDDING_PAUSE) return { error: 'Not in bidding pause' };
  game.phase = GAME_PHASES.TRUMP_SELECTION;
  game.currentSeat = game.trumpChooserSeat;
  return { ok: true };
}

function chooseTrump(game, seat, suit) {
  if (game.phase !== GAME_PHASES.TRUMP_SELECTION) return { error: 'Not in trump selection phase' };
  if (game.currentSeat !== seat) return { error: 'Not your turn to choose trump' };
  if (!SUITS.includes(suit)) return { error: 'Invalid trump suit' };

  game.trumpSuit = suit;
  game.contractTeam = game.biddingWinnerTeam;
  game.defenderTeam = game.contractTeam === 0 ? 1 : 0;

  const teamSeats = [0, 1, 2, 3].filter((s) => TEAM_OF[s] === game.contractTeam);
  const contractBidA = game.bids[teamSeats[0]];
  const contractBidB = game.bids[teamSeats[1]];
  game.contractTarget = Math.max(contractBidA, contractBidB);
  game.defenderTarget = 14 - game.contractTarget;

  game.phase = GAME_PHASES.PLAYING;
  game.currentSeat = seat;

  _log(game, `${SEATS[seat]} selects ${suit} as trump.`);
  _log(game, `Contract team: Team ${game.contractTeam + 1}, target ${game.contractTarget} tricks.`);
  _log(game, `Defenders: Team ${game.defenderTeam + 1}, target ${game.defenderTarget} tricks.`);

  return { ok: true };
}

function playCard(game, seat, cardId) {
  if (game.phase !== GAME_PHASES.PLAYING) return { error: 'Not in playing phase' };
  if (game.currentSeat !== seat) return { error: 'Not your turn' };

  const handIdx = game.hands[seat].findIndex((c) => `${c.rank}_${c.suit}` === cardId);
  if (handIdx === -1) return { error: 'Card not in hand' };

  const legal = getLegalCards(game, seat);
  if (!legal.find((c) => `${c.rank}_${c.suit}` === cardId)) {
    return { error: 'Illegal card play' };
  }

  const card = game.hands[seat][handIdx];
  game.hands[seat].splice(handIdx, 1);

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
  let winner = trick[0];

  for (let i = 1; i < trick.length; i++) {
    const entry = trick[i];
    if (_beats(entry.card, winner.card, ledSuit, game.trumpSuit)) {
      winner = entry;
    }
  }

  game.tricks[winner.seat]++;
  game.trickHistory.push({ trick: [...trick], winner: winner.seat });
  game.lastTrickWinner = winner.seat;
  game.phase = GAME_PHASES.TRICK_PAUSE;
  game.currentSeat = winner.seat;

  const contractTricks = _teamTricks(game, game.contractTeam);
  const defenderTricks = _teamTricks(game, game.defenderTeam);

  if (contractTricks >= game.contractTarget) {
    game.pendingRoundWinnerTeam = game.contractTeam;
  } else if (defenderTricks >= game.defenderTarget) {
    game.pendingRoundWinnerTeam = game.defenderTeam;
  }

  _log(game, `${SEATS[winner.seat]} wins the trick.`);

  const roundWillEnd = !!game.pendingRoundWinnerTeam || game.hands.every((h) => h.length === 0);
  return { ok: true, trickComplete: true, trickWinner: winner.seat, roundWillEnd };
}

function advanceAfterTrickPause(game) {
  if (game.phase !== GAME_PHASES.TRICK_PAUSE) return { error: 'No trick pause to advance' };

  const winnerSeat = game.lastTrickWinner;
  game.currentTrick = [];

  if (game.pendingRoundWinnerTeam !== null || game.hands.every((h) => h.length === 0)) {
    return _scoreRound(game);
  }

  game.phase = GAME_PHASES.PLAYING;
  game.currentSeat = winnerSeat;
  return { ok: true, trickWinner: winnerSeat };
}

function _scoreRound(game) {
  let winnerTeam = game.pendingRoundWinnerTeam;
  if (winnerTeam === null) {
    const contractTricks = _teamTricks(game, game.contractTeam);
    winnerTeam = contractTricks >= game.contractTarget ? game.contractTeam : game.defenderTeam;
  }

  game.roundWins[winnerTeam]++;

  const contractTricks = _teamTricks(game, game.contractTeam);
  const defenderTricks = _teamTricks(game, game.defenderTeam);

  game.lastRoundSummary = {
    roundNumber: game.roundNumber,
    roundWinnerTeam: winnerTeam,
    roundWins: [...game.roundWins],
    contractTeam: game.contractTeam,
    contractTarget: game.contractTarget,
    contractTricks,
    defenderTeam: game.defenderTeam,
    defenderTarget: game.defenderTarget,
    defenderTricks,
  };
  game.roundSummaries.push(game.lastRoundSummary);

  _log(game, `Round ${game.roundNumber}: Team ${winnerTeam + 1} wins.`);
  _log(game, `Round wins -> Team 1: ${game.roundWins[0]}, Team 2: ${game.roundWins[1]}.`);

  game.phase = GAME_PHASES.ROUND_END;
  game.pendingRoundWinnerTeam = null;

  const clinch = game.roundWins.findIndex((w) => w >= game.maxRoundWinsToClinch);
  if (clinch !== -1) {
    game.phase = GAME_PHASES.GAME_OVER;
    _log(game, `GAME OVER! Team ${clinch + 1} wins the match.`);
    return { ok: true, roundEnd: true, gameOver: true, winningTeam: clinch, scores: [...game.roundWins] };
  }

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

function _teamTricks(game, team) {
  return [0, 1, 2, 3]
    .filter((seat) => TEAM_OF[seat] === team)
    .reduce((sum, seat) => sum + game.tricks[seat], 0);
}

function _pickTrumpChooserSeat(game, winningTeam) {
  const seats = [0, 1, 2, 3].filter((s) => TEAM_OF[s] === winningTeam);
  const a = seats[0];
  const b = seats[1];

  if (game.bids[a] > game.bids[b]) return a;
  if (game.bids[b] > game.bids[a]) return b;

  const startSeat = (game.dealerSeat + 1) % 4;
  const da = (a - startSeat + 4) % 4;
  const db = (b - startSeat + 4) % 4;

  return da > db ? a : b;
}

function _beats(challenger, current, ledSuit, trumpSuit) {
  if (challenger.suit === trumpSuit && current.suit !== trumpSuit) return true;
  if (current.suit === trumpSuit && challenger.suit !== trumpSuit) return false;

  if (challenger.suit === current.suit) return challenger.value > current.value;

  if (challenger.suit === ledSuit && current.suit !== ledSuit) return true;
  return false;
}

function _buildCompetitionSummary(game) {
  const leaderTeam = game.roundWins[0] === game.roundWins[1]
    ? null
    : (game.roundWins[0] > game.roundWins[1] ? 0 : 1);
  const leadBy = Math.abs(game.roundWins[0] - game.roundWins[1]);
  const roundsToClinch = [
    Math.max(0, game.maxRoundWinsToClinch - game.roundWins[0]),
    Math.max(0, game.maxRoundWinsToClinch - game.roundWins[1]),
  ];

  return {
    leaderTeam,
    leadBy,
    roundsToClinch,
    roundsLeft: Math.max(0, game.totalRounds - game.roundNumber),
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
    bids: game.bids,
    tricks: game.tricks,
    teamScore: [...game.roundWins],
    teamBags: [0, 0],
    roundWins: [...game.roundWins],
    totalRounds: game.totalRounds,
    maxRoundWinsToClinch: game.maxRoundWinsToClinch,
    currentTrick: game.currentTrick,
    trickHistory: game.trickHistory.slice(-5),
    currentSeat: game.currentSeat,
    dealerSeat: game.dealerSeat,
    roundNumber: game.roundNumber,
    trumpSuit: game.trumpSuit,
    biddingWinnerTeam: game.biddingWinnerTeam,
    trumpChooserSeat: game.trumpChooserSeat,
    contractTeam: game.contractTeam,
    defenderTeam: game.defenderTeam,
    contractTarget: game.contractTarget,
    defenderTarget: game.defenderTarget,
    lastTrickWinner: game.lastTrickWinner,
    lastBidWinnerSeat: game.lastBidWinnerSeat,
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

module.exports = {
  GAME_PHASES,
  SEATS,
  TEAM_OF,
  MIN_BID,
  MAX_BID,
  SUITS,
  createGame,
  dealRound,
  placeBid,
  chooseTrump,
  advanceAfterBiddingPause,
  playCard,
  advanceAfterTrickPause,
  getLegalCards,
  getPublicState,
};