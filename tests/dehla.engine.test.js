'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const dehla = require('../server/dehla');
const { GAME_PHASES } = dehla;

function card(rank, suit, value) {
  return { rank, suit, value };
}

function playOneTrick(game, idsInSeatOrder) {
  for (const id of idsInSeatOrder) {
    const seat = game.currentSeat;
    const result = dehla.playCard(game, seat, id);
    assert.ok(!result.error, result.error || 'Expected valid card play');
  }
  const after = dehla.advanceAfterTrickPause(game);
  assert.ok(!after.error, after.error || 'Expected trick pause advance to succeed');
  return after;
}

test('Dehla: last void-cut suit in trick becomes permanent trump', () => {
  const game = dehla.createGame('DH001', { totalRounds: 5 });
  game.phase = GAME_PHASES.PLAYING;
  game.currentSeat = 0;

  // Seat 0 leads spades; seat 1 void plays hearts; seat 2 void plays diamonds (overrules).
  game.hands = [
    [card('9', 'spades', 9)],
    [card('K', 'hearts', 13)],
    [card('2', 'diamonds', 2)],
    [card('A', 'spades', 14)],
  ];

  playOneTrick(game, ['9_spades', 'K_hearts', '2_diamonds', 'A_spades']);
  assert.equal(game.lastTrickWinner, 2);
  assert.equal(game.trumpSuit, 'diamonds');
});

test('Dehla: trick winner captures all tens in that trick for team', () => {
  const game = dehla.createGame('DH002', { totalRounds: 5 });
  game.phase = GAME_PHASES.PLAYING;
  game.currentSeat = 0;
  game.trumpSuit = 'hearts';

  game.hands = [
    [card('10', 'clubs', 10)],
    [card('A', 'hearts', 14)],
    [card('10', 'spades', 10)],
    [card('10', 'diamonds', 10)],
  ];

  playOneTrick(game, ['10_clubs', 'A_hearts', '10_spades', '10_diamonds']);

  // Seat 1 (team 1) won with trump and should capture 3 tens.
  assert.deepEqual(game.teamTensCaptured, [0, 3]);
});

test('Dehla: round with 2-2 tens is draw and final match winner can be tie', () => {
  const game = dehla.createGame('DH003', { totalRounds: 1 });
  game.roundNumber = 1;
  game.phase = GAME_PHASES.TRICK_PAUSE;
  game.teamTensCaptured = [2, 2];
  game.roundWins = [0, 0];
  game.lastTrickWinner = 0;
  game.hands = [[], [], [], []];

  const result = dehla.advanceAfterTrickPause(game);

  assert.equal(result.roundEnd, true);
  assert.equal(result.gameOver, true);
  assert.equal(result.winningTeam, null);
  assert.deepEqual(result.scores, [0, 0]);
  assert.equal(game.roundDraws, 1);
});
