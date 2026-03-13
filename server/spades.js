'use strict';

/**
 * Spades Game Engine
 * 4 players, 2 teams: North/South (Team 0) vs East/West (Team 1)
 * Standard Spades rules: bid, play tricks, score.
 * Seat positions: 0=South, 1=West, 2=North, 3=East
 */

const { createDeck, shuffle, RANK_VALUES } = require('./deck');

const SEATS = ['South', 'West', 'North', 'East'];
// Team assignments: South(0) & North(2) = Team 0 | West(1) & East(3) = Team 1
const TEAM_OF = [0, 1, 0, 1];

const GAME_PHASES = {
  WAITING:   'waiting',
  BIDDING:   'bidding',
  PLAYING:   'playing',
  TRICK_PAUSE: 'trick_pause',
  ROUND_END: 'round_end',
  GAME_OVER: 'game_over',
};

function createGame(roomId) {
  return {
    roomId,
    gameType: 'spades',
    phase: GAME_PHASES.WAITING,
    players: [null, null, null, null], // { id, name, isBot }
    hands: [[], [], [], []],
    bids: [null, null, null, null],
    tricks: [0, 0, 0, 0],          // tricks won this round per seat
    teamScore: [0, 0],              // cumulative score per team
    teamBags: [0, 0],               // bags (overtricks) per team
    spadesBroken: false,
    currentTrick: [],               // [{ seat, card }]
    trickHistory: [],               // completed tricks
    currentSeat: 0,                 // whose turn it is
    dealerSeat: 0,
    roundNumber: 0,
    targetScore: 500,
    lastTrickWinner: null,
    lastBidWinnerSeat: null,
    roundSummaries: [],
    lastRoundSummary: null,
    turnDeadlineTs: null,
    turnDurationMs: 15000,
    log: [],
  };
}

// ---------- DEAL ----------
function dealRound(game) {
  const deck = shuffle(createDeck());
  game.hands = [[], [], [], []];
  game.bids = [null, null, null, null];
  game.tricks = [0, 0, 0, 0];
  game.spadesBroken = false;
  game.currentTrick = [];
  game.trickHistory = [];
  game.lastTrickWinner = null;
  game.lastBidWinnerSeat = null;
  game.roundNumber++;

  // Deal 13 cards to each player
  for (let i = 0; i < 52; i++) {
    game.hands[i % 4].push(deck[i]);
  }
  // Sort each hand
  for (let s = 0; s < 4; s++) {
    game.hands[s].sort((a, b) => {
      const si = ['spades','hearts','diamonds','clubs'].indexOf(a.suit) -
                 ['spades','hearts','diamonds','clubs'].indexOf(b.suit);
      return si !== 0 ? si : a.value - b.value;
    });
  }

  // Bidding starts left of dealer
  game.currentSeat = (game.dealerSeat + 1) % 4;
  game.phase = GAME_PHASES.BIDDING;
  _log(game, `Round ${game.roundNumber} dealt. Bidding starts with ${SEATS[game.currentSeat]}.`);
}

// ---------- BID ----------
function placeBid(game, seat, bid) {
  if (game.phase !== GAME_PHASES.BIDDING) return { error: 'Not in bidding phase' };
  if (game.currentSeat !== seat) return { error: 'Not your turn to bid' };
  if (typeof bid !== 'number' || bid < 0 || bid > 13) return { error: 'Invalid bid (0-13)' };

  game.bids[seat] = bid;
  _log(game, `${SEATS[seat]} bids ${bid === 0 ? 'NIL' : bid}.`);

  game.currentSeat = (seat + 1) % 4;

  // All bids placed?
  if (game.bids.every(b => b !== null)) {
    game.phase = GAME_PHASES.PLAYING;
    game.lastBidWinnerSeat = _computeBidWinnerSeat(game);
    const bidWinner = game.lastBidWinnerSeat;
    if (bidWinner !== null) {
      _log(game, `${SEATS[bidWinner]} wins the bidding with ${game.bids[bidWinner] === 0 ? 'NIL' : game.bids[bidWinner]}.`);
    }
    _log(game, `Team 1 bid total: ${_teamBidTotal(game, 0)}. Team 2 bid total: ${_teamBidTotal(game, 1)}.`);
    // Play starts left of dealer
    game.currentSeat = (game.dealerSeat + 1) % 4;
    _log(game, `All bids in. Play starts with ${SEATS[game.currentSeat]}.`);
  }

  return { ok: true };
}

// ---------- PLAY CARD ----------
function playCard(game, seat, cardId) {
  if (game.phase !== GAME_PHASES.PLAYING) return { error: 'Not in playing phase' };
  if (game.currentSeat !== seat) return { error: 'Not your turn' };

  const handIdx = game.hands[seat].findIndex(c => `${c.rank}_${c.suit}` === cardId);
  if (handIdx === -1) return { error: 'Card not in hand' };

  const card = game.hands[seat][handIdx];

  // Validate legal play
  const legal = getLegalCards(game, seat);
  if (!legal.find(c => `${c.rank}_${c.suit}` === cardId)) {
    return { error: 'Illegal card play' };
  }

  // Remove from hand
  game.hands[seat].splice(handIdx, 1);

  // Track spades broken
  if (card.suit === 'spades' && !game.spadesBroken) {
    game.spadesBroken = true;
    _log(game, 'Spades have been broken!');
  }

  game.currentTrick.push({ seat, card });
  _log(game, `${SEATS[seat]} plays ${card.rank} of ${card.suit}.`);

  // Trick complete?
  if (game.currentTrick.length === 4) {
    return _completeTrick(game);
  }

  game.currentSeat = (seat + 1) % 4;
  return { ok: true };
}

function getLegalCards(game, seat) {
  const hand = game.hands[seat];
  const trick = game.currentTrick;

  // Leading the trick
  if (trick.length === 0) {
    if (!game.spadesBroken) {
      const nonSpades = hand.filter(c => c.suit !== 'spades');
      // Must lead non-spade unless only spades in hand
      return nonSpades.length > 0 ? nonSpades : hand;
    }
    return hand;
  }

  // Following: must follow suit if possible
  const ledSuit = trick[0].card.suit;
  const matching = hand.filter(c => c.suit === ledSuit);
  return matching.length > 0 ? matching : hand;
}

// ---------- SCORE TRICK ----------
function _completeTrick(game) {
  const trick = game.currentTrick;
  const ledSuit = trick[0].card.suit;
  let winner = trick[0];

  for (let i = 1; i < trick.length; i++) {
    const entry = trick[i];
    if (_beats(entry.card, winner.card, ledSuit)) {
      winner = entry;
    }
  }

  game.tricks[winner.seat]++;
  game.trickHistory.push({ trick: [...trick], winner: winner.seat });
  game.lastTrickWinner = winner.seat;
  game.phase = GAME_PHASES.TRICK_PAUSE;

  _log(game, `${SEATS[winner.seat]} wins the trick. (${game.tricks[winner.seat]} total)`);

  const roundWillEnd = game.hands.every(h => h.length === 0);
  return { ok: true, trickComplete: true, trickWinner: winner.seat, roundWillEnd };
}

function advanceAfterTrickPause(game) {
  if (game.phase !== GAME_PHASES.TRICK_PAUSE) return { error: 'No trick pause to advance' };

  const winnerSeat = game.lastTrickWinner;
  game.currentTrick = [];

  // Round over?
  if (game.hands.every(h => h.length === 0)) {
    return _scoreRound(game);
  }

  game.phase = GAME_PHASES.PLAYING;
  game.currentSeat = winnerSeat;
  return { ok: true, trickWinner: winnerSeat };
}

function _beats(challenger, current, ledSuit) {
  if (challenger.suit === 'spades' && current.suit !== 'spades') return true;
  if (current.suit === 'spades' && challenger.suit !== 'spades') return false;
  if (challenger.suit === current.suit) return challenger.value > current.value;
  // challenger is off-suit non-spade, current is led suit — challenger loses
  if (challenger.suit !== current.suit && challenger.suit !== 'spades') return false;
  return false;
}

// ---------- SCORE ROUND ----------
function _scoreRound(game) {
  game.phase = GAME_PHASES.ROUND_END;
  const roundLog = [];

  const teamRoundPoints = [0, 0];
  for (let team = 0; team < 2; team++) {
    const seats = [0, 1, 2, 3].filter(s => TEAM_OF[s] === team);
    const teamBid = seats.reduce((sum, s) => sum + (game.bids[s] || 0), 0);
    const teamTricks = seats.reduce((sum, s) => sum + game.tricks[s], 0);

    // Nil bids evaluated per player
    let nilBonus = 0;
    for (const s of seats) {
      if (game.bids[s] === 0) {
        if (game.tricks[s] === 0) {
          nilBonus += 100;
          _log(game, `${SEATS[s]} made NIL! +100 for Team ${team + 1}.`);
        } else {
          nilBonus -= 100;
          _log(game, `${SEATS[s]} failed NIL! -100 for Team ${team + 1}.`);
        }
      }
    }

    const nonNilBid = seats.reduce((sum, s) => sum + (game.bids[s] === 0 ? 0 : game.bids[s]), 0);

    let points = 0;
    if (teamTricks >= nonNilBid) {
      points = nonNilBid * 10 + (teamTricks - nonNilBid); // overtricks = bags
      const bags = teamTricks - nonNilBid;
      game.teamBags[team] += bags;

      // Bag penalty: -100 every 10 bags
      const prevBagPenalties = Math.floor((game.teamBags[team] - bags) / 10);
      const newBagPenalties  = Math.floor(game.teamBags[team] / 10);
      if (newBagPenalties > prevBagPenalties) {
        points -= 100;
        _log(game, `Team ${team + 1} hit 10 bags! -100 penalty.`);
      }
    } else {
      points = -(nonNilBid * 10);
      _log(game, `Team ${team + 1} set! -${nonNilBid * 10} points.`);
    }

    const totalRoundPoints = points + nilBonus;
    teamRoundPoints[team] = totalRoundPoints;
    game.teamScore[team] += totalRoundPoints;
    roundLog.push({
      team, teamBid, teamTricks, points: totalRoundPoints,
      totalScore: game.teamScore[team],
    });

    _log(game, `Team ${team + 1}: bid ${teamBid}, took ${teamTricks} tricks → ${points + nilBonus > 0 ? '+' : ''}${points + nilBonus} pts (total: ${game.teamScore[team]})`);
  }

  const roundWinnerTeam = teamRoundPoints[0] === teamRoundPoints[1]
    ? null
    : (teamRoundPoints[0] > teamRoundPoints[1] ? 0 : 1);
  game.lastRoundSummary = {
    roundNumber: game.roundNumber,
    teamRoundPoints,
    roundWinnerTeam,
    teamScores: [...game.teamScore],
  };
  game.roundSummaries.push(game.lastRoundSummary);

  // Check win condition
  const winner = game.teamScore.findIndex(s => s >= game.targetScore);
  if (winner !== -1) {
    // Edge: both teams hit target — highest score wins
    if (game.teamScore[0] >= game.targetScore && game.teamScore[1] >= game.targetScore) {
      const w = game.teamScore[0] > game.teamScore[1] ? 0 : 1;
      game.phase = GAME_PHASES.GAME_OVER;
      _log(game, `GAME OVER! Team ${w + 1} wins with ${game.teamScore[w]} points!`);
      return { ok: true, roundEnd: true, gameOver: true, winningTeam: w, scores: game.teamScore, roundLog };
    }
    game.phase = GAME_PHASES.GAME_OVER;
    _log(game, `GAME OVER! Team ${winner + 1} wins with ${game.teamScore[winner]} points!`);
    return { ok: true, roundEnd: true, gameOver: true, winningTeam: winner, scores: game.teamScore, roundLog };
  }

  // Next round
  game.dealerSeat = (game.dealerSeat + 1) % 4;
  return { ok: true, roundEnd: true, gameOver: false, roundLog };
}

// ---------- HELPERS ----------
function _log(game, msg) {
  const entry = { time: Date.now(), msg };
  game.log.push(entry);
  // Keep last 200 log entries
  if (game.log.length > 200) game.log.shift();
}

function getPublicState(game, viewerSeat) {
  const competition = _buildCompetitionSummary(game);
  // Returns state safe to send to a specific seat (hide other hands)
  return {
    roomId: game.roomId,
    gameType: game.gameType || 'spades',
    phase: game.phase,
    players: game.players,
    hands: game.hands.map((hand, s) => {
      if (viewerSeat === null || viewerSeat === undefined) {
        // Spectator: always reveal South hand for cinematic simulation viewing.
        if (s === 0) return hand;
        if (game.phase === GAME_PHASES.ROUND_END || game.phase === GAME_PHASES.GAME_OVER) return hand;
        return hand.map(() => ({ hidden: true }));
      }
      return s === viewerSeat ? hand : hand.map(() => ({ hidden: true }));
    }),
    handCounts: game.hands.map(h => h.length),
    bids: game.bids,
    tricks: game.tricks,
    teamScore: game.teamScore,
    teamBags: game.teamBags,
    spadesBroken: game.spadesBroken,
    currentTrick: game.currentTrick,
    trickHistory: game.trickHistory.slice(-5),
    currentSeat: game.currentSeat,
    dealerSeat: game.dealerSeat,
    roundNumber: game.roundNumber,
    targetScore: game.targetScore,
    lastTrickWinner: game.lastTrickWinner,
    lastBidWinnerSeat: game.lastBidWinnerSeat,
    lastRoundSummary: game.lastRoundSummary,
    competition,
    turnDeadlineTs: game.turnDeadlineTs,
    turnDurationMs: game.turnDurationMs,
    legalCards: viewerSeat !== null && viewerSeat !== undefined && game.phase === GAME_PHASES.PLAYING && game.currentSeat === viewerSeat
      ? getLegalCards(game, viewerSeat).map(c => `${c.rank}_${c.suit}`)
      : [],
    log: game.log.slice(-20),
  };
}

function _computeBidWinnerSeat(game) {
  let winner = null;
  let maxBid = -1;
  for (let s = 0; s < 4; s++) {
    const b = game.bids[s];
    if (b !== null && b > maxBid) {
      maxBid = b;
      winner = s;
    }
  }
  return winner;
}

function _teamBidTotal(game, team) {
  return [0, 1, 2, 3]
    .filter(s => TEAM_OF[s] === team)
    .reduce((sum, s) => sum + (game.bids[s] || 0), 0);
}

function _buildCompetitionSummary(game) {
  const leaderTeam = game.teamScore[0] === game.teamScore[1]
    ? null
    : (game.teamScore[0] > game.teamScore[1] ? 0 : 1);
  const leadBy = Math.abs(game.teamScore[0] - game.teamScore[1]);
  const pointsToWin = [
    Math.max(0, game.targetScore - game.teamScore[0]),
    Math.max(0, game.targetScore - game.teamScore[1]),
  ];
  const avgRoundGain = game.roundSummaries.length > 0
    ? Math.max(1, Math.round(
      game.roundSummaries.reduce((sum, r) => sum + Math.max(r.teamRoundPoints[0], r.teamRoundPoints[1]), 0) /
      game.roundSummaries.length
    ))
    : 60;
  const estRoundsRemaining = Math.max(1, Math.ceil(Math.max(pointsToWin[0], pointsToWin[1]) / avgRoundGain));
  return { leaderTeam, leadBy, pointsToWin, estRoundsRemaining };
}

module.exports = {
  GAME_PHASES,
  SEATS,
  TEAM_OF,
  createGame,
  dealRound,
  placeBid,
  playCard,
  advanceAfterTrickPause,
  getLegalCards,
  getPublicState,
};
