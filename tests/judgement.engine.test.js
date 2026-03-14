'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const judgement = require('../server/judgement');

const { GAME_PHASES } = judgement;

function card(rank, suit, value) {
  return { rank, suit, value };
}

function playOneTrick(game, idsInSeatOrder) {
  for (const id of idsInSeatOrder) {
    const seat = game.currentSeat;
    const result = judgement.playCard(game, seat, id);
    assert.ok(!result.error, result.error || 'Expected valid card play');
  }
  const after = judgement.advanceAfterTrickPause(game);
  assert.ok(!after.error, after.error || 'Expected trick pause advance to succeed');
  return after;
}

test('Judgement: bidding tie goes to Team 1 and Team 1 later seat chooses on partner tie', () => {
  const game = judgement.createGame('TIE001', { totalRounds: 7 });
  game.dealerSeat = 3;
  game.phase = GAME_PHASES.BIDDING;
  game.currentSeat = 0;

  judgement.placeBid(game, 0, 8);
  judgement.placeBid(game, 1, 6);
  judgement.placeBid(game, 2, 8);
  judgement.placeBid(game, 3, 10);

  assert.equal(game.biddingWinnerTeam, 0);
  assert.equal(game.trumpChooserSeat, 2);
  // Phase is bidding_pause until server advances it
  assert.equal(game.phase, GAME_PHASES.BIDDING_PAUSE);
  judgement.advanceAfterBiddingPause(game);
  assert.equal(game.currentSeat, 2);
  assert.equal(game.phase, GAME_PHASES.TRUMP_SELECTION);
});

test('Judgement: team 2 partner tie chooses later seat (East)', () => {
  const game = judgement.createGame('TIE002', { totalRounds: 7 });
  game.phase = GAME_PHASES.BIDDING;
  game.currentSeat = 0;

  judgement.placeBid(game, 0, 6);
  judgement.placeBid(game, 1, 8);
  judgement.placeBid(game, 2, 7);
  judgement.placeBid(game, 3, 8);

  assert.equal(game.biddingWinnerTeam, 1);
  assert.equal(game.trumpChooserSeat, 3);
  assert.equal(game.phase, GAME_PHASES.BIDDING_PAUSE);
  judgement.advanceAfterBiddingPause(game);
  assert.equal(game.phase, GAME_PHASES.TRUMP_SELECTION);
});

test('Judgement: defender can win early when defender target is reached', () => {
  const game = judgement.createGame('EARLYD', { totalRounds: 3 });
  game.roundNumber = 1;
  game.phase = GAME_PHASES.PLAYING;
  game.currentSeat = 1;
  game.contractTeam = 0;
  game.defenderTeam = 1;
  game.contractTarget = 10;
  game.defenderTarget = 4;
  game.trumpSuit = 'spades';
  game.bids = [7, 9, 10, 8];

  // Four deterministic hearts tricks won by seat 1 (West).
  game.hands = [
    [card('2', 'hearts', 2), card('3', 'hearts', 3), card('4', 'hearts', 4), card('5', 'hearts', 5)],
    [card('A', 'hearts', 14), card('K', 'hearts', 13), card('Q', 'hearts', 12), card('J', 'hearts', 11)],
    [card('6', 'hearts', 6), card('7', 'hearts', 7), card('8', 'hearts', 8), card('9', 'hearts', 9)],
    [card('10', 'hearts', 10), card('2', 'clubs', 2), card('3', 'clubs', 3), card('4', 'clubs', 4)],
  ];

  let result;
  result = playOneTrick(game, ['A_hearts', '6_hearts', '10_hearts', '2_hearts']);
  assert.equal(result.roundEnd, undefined);

  result = playOneTrick(game, ['K_hearts', '7_hearts', '2_clubs', '3_hearts']);
  assert.equal(result.roundEnd, undefined);

  result = playOneTrick(game, ['Q_hearts', '8_hearts', '3_clubs', '4_hearts']);
  assert.equal(result.roundEnd, undefined);

  result = playOneTrick(game, ['J_hearts', '9_hearts', '4_clubs', '5_hearts']);
  assert.equal(result.roundEnd, true);
  assert.equal(result.gameOver, false);
  assert.deepEqual(result.scores, [0, 1]);
  assert.equal(game.phase, GAME_PHASES.ROUND_END);
});

test('Judgement: contract team can win before all cards are used', () => {
  const game = judgement.createGame('EARLYC', { totalRounds: 3 });
  game.roundNumber = 1;
  game.phase = GAME_PHASES.PLAYING;
  game.currentSeat = 0;
  game.contractTeam = 0;
  game.defenderTeam = 1;
  game.contractTarget = 6;
  game.defenderTarget = 8;
  game.trumpSuit = 'spades';
  game.bids = [6, 6, 6, 6];

  game.hands = [
    [card('A', 'clubs', 14), card('K', 'clubs', 13), card('Q', 'clubs', 12), card('J', 'clubs', 11), card('10', 'clubs', 10), card('9', 'clubs', 9), card('8', 'clubs', 8)],
    [card('7', 'clubs', 7), card('6', 'clubs', 6), card('5', 'clubs', 5), card('4', 'clubs', 4), card('3', 'clubs', 3), card('2', 'clubs', 2), card('2', 'hearts', 2)],
    [card('A', 'diamonds', 14), card('K', 'diamonds', 13), card('Q', 'diamonds', 12), card('J', 'diamonds', 11), card('10', 'diamonds', 10), card('9', 'diamonds', 9), card('8', 'diamonds', 8)],
    [card('A', 'hearts', 14), card('K', 'hearts', 13), card('Q', 'hearts', 12), card('J', 'hearts', 11), card('10', 'hearts', 10), card('9', 'hearts', 9), card('8', 'hearts', 8)],
  ];

  let result;
  result = playOneTrick(game, ['A_clubs', '7_clubs', 'A_diamonds', 'A_hearts']);
  assert.equal(result.roundEnd, undefined);
  result = playOneTrick(game, ['K_clubs', '6_clubs', 'K_diamonds', 'K_hearts']);
  assert.equal(result.roundEnd, undefined);
  result = playOneTrick(game, ['Q_clubs', '5_clubs', 'Q_diamonds', 'Q_hearts']);
  assert.equal(result.roundEnd, undefined);
  result = playOneTrick(game, ['J_clubs', '4_clubs', 'J_diamonds', 'J_hearts']);
  assert.equal(result.roundEnd, undefined);
  result = playOneTrick(game, ['10_clubs', '3_clubs', '10_diamonds', '10_hearts']);
  assert.equal(result.roundEnd, undefined);
  result = playOneTrick(game, ['9_clubs', '2_clubs', '9_diamonds', '9_hearts']);

  assert.equal(result.roundEnd, true);
  assert.equal(result.gameOver, false);
  assert.deepEqual(result.scores, [1, 0]);
  assert.equal(game.hands[0].length, 1);
  assert.equal(game.hands[1].length, 1);
  assert.equal(game.hands[2].length, 1);
  assert.equal(game.hands[3].length, 1);
});

test('Judgement: match can end as tie after max rounds', () => {
  const game = judgement.createGame('TIEEND', { totalRounds: 2 });
  game.roundNumber = 2;
  game.roundWins = [1, 0];
  game.phase = GAME_PHASES.TRICK_PAUSE;
  game.pendingRoundWinnerTeam = 1;
  game.contractTeam = 0;
  game.defenderTeam = 1;
  game.contractTarget = 6;
  game.defenderTarget = 8;
  game.tricks = [0, 1, 0, 0];
  game.lastTrickWinner = 1;

  const result = judgement.advanceAfterTrickPause(game);
  assert.equal(result.roundEnd, true);
  assert.equal(result.gameOver, true);
  assert.equal(result.winningTeam, null);
  assert.deepEqual(result.scores, [1, 1]);
  assert.equal(game.phase, GAME_PHASES.GAME_OVER);
});
