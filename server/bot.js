'use strict';

/**
 * Bot AI for card games in this app.
 */

const { getLegalCards: getSpadesLegalCards } = require('./spades');
const { getLegalCards: getJudgementLegalCards } = require('./judgement');
const { getLegalCards: getDehlaLegalCards } = require('./dehla');

const BOT_NAMES = ['Aria', 'Magnus', 'Sofia', 'Lucas'];
const BOT_AVATARS = ['thanos', 'thor', 'scarletwitch', 'spiderman'];

/**
 * Compute a bot bid based on hand strength.
 */
function botBid(game, seat) {
  if (game && game.gameType === 'judgement') {
    return judgementBid(game, seat);
  }

  const hand = game.hands[seat];
  let bid = 0;

  for (const card of hand) {
    if (card.suit === 'spades') {
      if (card.value >= 11) bid++;          // J, Q, K, A of spades = almost certain trick
      else if (card.value >= 9) bid += 0.5; // 9, 10 = likely trick
    } else {
      if (card.value === 14) bid++;         // Ace of any suit
      if (card.value === 13) bid += 0.7;   // King
      if (card.value === 12) bid += 0.4;   // Queen
    }
  }

  // Count singleton/void suits (ruffing potential)
  const suitCounts = { spades: 0, hearts: 0, diamonds: 0, clubs: 0 };
  for (const c of hand) suitCounts[c.suit]++;
  for (const [suit, count] of Object.entries(suitCounts)) {
    if (suit !== 'spades') {
      if (count === 0) bid += 1.5;
      else if (count === 1) bid += 0.5;
    }
  }

  bid = Math.round(bid);
  return Math.max(1, Math.min(13, bid));
}

function judgementBid(game, seat) {
  const hand = game.hands[seat] || [];
  let score = 0;

  for (const card of hand) {
    if (card.value === 14) score += 1.3;
    else if (card.value === 13) score += 1.0;
    else if (card.value === 12) score += 0.75;
    else if (card.value === 11) score += 0.5;

    if (card.suit === 'spades') score += 0.25;
    if (card.suit === 'hearts' && card.value >= 11) score += 0.1;
  }

  const bid = Math.round(Math.max(6, Math.min(13, score / 1.25)));
  return bid;
}

/**
 * Choose which card the bot should play.
 * Strategy tiers:
 *   1. If leading: play lowest non-spade (if spades not broken), or lead with a high card
 *   2. If following: win cheaply if partner is winning, otherwise dump low
 *   3. If able to ruff: ruff with lowest spade if partner is losing
 */
function botChooseCard(game, seat) {
  if (game && game.gameType === 'dehla') {
    return dehlaChooseCard(game, seat);
  }

  if (game && game.gameType === 'judgement') {
    return judgementChooseCard(game, seat);
  }

  const legal = getSpadesLegalCards(game, seat);
  const trick = game.currentTrick;
  const TEAM_OF = [0, 1, 0, 1];

  if (legal.length === 1) return `${legal[0].rank}_${legal[0].suit}`;

  // Leading the trick
  if (trick.length === 0) {
    return _leadCard(legal, game, seat);
  }

  // Determine current winner of trick
  const currentWinner = _trickCurrentWinner(trick);
  const partnerSeat = (seat + 2) % 4;
  const partnerWinning = currentWinner === partnerSeat;

  // Following
  const ledSuit = trick[0].card.suit;
  const canFollow = legal.some(c => c.suit === ledSuit);

  if (canFollow) {
    if (partnerWinning) {
      // Partner is winning — throw off lowest
      return _cardId(legal.filter(c => c.suit === ledSuit).sort((a,b) => a.value - b.value)[0]);
    } else {
      // Try to win cheaply
      const winning = legal.filter(c => c.suit === ledSuit && _beats(c, _currentHighCard(trick), ledSuit));
      if (winning.length > 0) {
        return _cardId(winning.sort((a,b) => a.value - b.value)[0]); // cheapest winner
      }
      // Can't win — dump lowest
      return _cardId(legal.filter(c => c.suit === ledSuit).sort((a,b) => a.value - b.value)[0]);
    }
  }

  // Can't follow suit — discard or ruff with spade
  const spades = legal.filter(c => c.suit === 'spades');
  const others = legal.filter(c => c.suit !== 'spades');

  if (!partnerWinning && spades.length > 0) {
    // Ruff with lowest spade that beats current high
    const highCard = _currentHighCard(trick);
    if (highCard.suit === 'spades') {
      const overRuffs = spades.filter(c => c.value > highCard.value);
      if (overRuffs.length > 0) return _cardId(overRuffs.sort((a,b) => a.value - b.value)[0]);
    } else {
      return _cardId(spades.sort((a,b) => a.value - b.value)[0]);
    }
  }

  // Dump lowest value card
  return _cardId(legal.sort((a,b) => a.value - b.value)[0]);
}

function botChooseTrump(game, seat) {
  const hand = game.hands[seat] || [];
  const suitStrength = { clubs: 0, diamonds: 0, hearts: 0, spades: 0 };

  for (const card of hand) {
    suitStrength[card.suit] += card.value;
    if (card.value >= 11) suitStrength[card.suit] += 3;
  }

  return Object.entries(suitStrength).sort((a, b) => b[1] - a[1])[0][0];
}

function judgementChooseCard(game, seat) {
  const legal = getJudgementLegalCards(game, seat);
  if (legal.length === 1) return _cardId(legal[0]);

  if (game.currentTrick.length === 0) {
    const preferredSuit = game.trumpSuit || 'spades';
    const nonTrump = legal.filter((c) => c.suit !== preferredSuit);
    if (nonTrump.length > 0) {
      return _cardId(nonTrump.sort((a, b) => b.value - a.value)[0]);
    }
    return _cardId(legal.sort((a, b) => b.value - a.value)[0]);
  }

  return _cardId(legal.sort((a, b) => a.value - b.value)[0]);
}

function dehlaChooseCard(game, seat) {
  const legal = getDehlaLegalCards(game, seat);
  if (legal.length === 1) return _cardId(legal[0]);

  // Prefer preserving tens when possible.
  const nonTens = legal.filter((c) => c.rank !== '10');
  if (nonTens.length > 0) {
    return _cardId(nonTens.sort((a, b) => a.value - b.value)[0]);
  }
  return _cardId(legal.sort((a, b) => a.value - b.value)[0]);
}

function _leadCard(legal, game, seat) {
  // Lead highest non-spade, or if all spades, highest spade
  const nonSpades = legal.filter(c => c.suit !== 'spades');
  if (nonSpades.length > 0) {
    // Lead from strongest suit — highest card
    const sorted = nonSpades.sort((a,b) => b.value - a.value);
    return _cardId(sorted[0]);
  }
  return _cardId(legal.sort((a,b) => b.value - a.value)[0]);
}

function _trickCurrentWinner(trick) {
  const ledSuit = trick[0].card.suit;
  let winner = trick[0];
  for (let i = 1; i < trick.length; i++) {
    if (_beats(trick[i].card, winner.card, ledSuit)) winner = trick[i];
  }
  return winner.seat;
}

function _currentHighCard(trick) {
  const ledSuit = trick[0].card.suit;
  let high = trick[0].card;
  for (let i = 1; i < trick.length; i++) {
    if (_beats(trick[i].card, high, ledSuit)) high = trick[i].card;
  }
  return high;
}

function _beats(challenger, current, ledSuit) {
  if (challenger.suit === 'spades' && current.suit !== 'spades') return true;
  if (current.suit === 'spades' && challenger.suit !== 'spades') return false;
  if (challenger.suit === current.suit) return challenger.value > current.value;
  return false;
}

function _cardId(card) {
  return `${card.rank}_${card.suit}`;
}

module.exports = { botBid, botChooseCard, botChooseTrump, BOT_NAMES, BOT_AVATARS };
