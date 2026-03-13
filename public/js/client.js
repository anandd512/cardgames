'use strict';

const socket = io();

let myRoomId = null;
let mySeat = null;
let lastState = null;
let pendingBid = false;
let selectedGame = 'spades';
let selectedAvatar = 'ironman';

let audioCtx = null;
let masterGain = null;
let sfxGain = null;
let bgmGain = null;
let bgmTimer = null;
let bgmStep = 0;
let audioReady = false;
let roundModalTimer = null;
let bidFlashTimer = null;
let bidTrumpTimer = null;
let roundCountdownTicker = null;
let roundEndShownAt = null;
let uiTicker = null;
let musicMuted = false;
let musicVolumePct = 65;
let musicMode = 'calm';

const RULE_GUIDES = {
  spades: {
    title: 'Spades Rule Guide',
    items: [
      '<strong>1) Setup:</strong> 4 players in fixed teams: South + North vs West + East. Use one standard 52-card deck. First team to 500 wins.',
      '<strong>2) Deal:</strong> Dealer gives 13 cards to each player. Dealer rotates each round.',
      '<strong>3) Bidding:</strong> Starting left of dealer, each player bids how many tricks they expect. Bid <strong>0</strong> means Nil.',
      '<strong>4) Bid totals:</strong> Team target = both partner bids added (nil bids are evaluated separately).',
      '<strong>5) Lead rules:</strong> The player left of dealer leads first trick. You must follow suit if you can.',
      '<strong>6) Trump:</strong> Spades are always trump and beat other suits.',
      '<strong>7) Spades break:</strong> You cannot lead spades until someone plays a spade off-suit, unless your hand has only spades.',
      '<strong>8) Trick winner:</strong> Highest card of led suit wins unless one or more spades are played; then highest spade wins.',
      '<strong>9) Base scoring:</strong> If team makes bid: +10 per bid trick. Missing bid: negative 10 per bid trick.',
      '<strong>10) Bags:</strong> Extra tricks above team bid are bags (+1 each). Every 10 bags = -100 penalty.',
      '<strong>11) Nil scoring:</strong> Successful nil = +100 for that team. Failed nil = -100.',
      '<strong>12) Round flow:</strong> 13 tricks complete a round. Scoreboard updates, 5-second recap, next round auto starts.',
      '<strong>13) Match finish:</strong> First team to 500 (or higher score if both cross in same round) wins.',
    ],
  },
  judgement: {
    title: 'Judgement Rule Guide',
    items: [
      '<strong>1) Teams:</strong> South + North vs West + East with a 52-card deck.',
      '<strong>2) Match length:</strong> Host chooses 1 to 11 rounds. First team to more than half wins.',
      '<strong>3) Bidding:</strong> Every player bids from <strong>6</strong> to <strong>13</strong>. Timeout auto-bids 6.',
      '<strong>4) Bid winner team:</strong> Compare team sums (South+North vs West+East). Tie goes to Team 1.',
      '<strong>5) Trump chooser:</strong> Highest individual bidder inside winning team picks trump. Partner tie: later seat chooses.',
      '<strong>6) Trump:</strong> Clubs, Diamonds, Hearts, or Spades. Timeout defaults to Spades.',
      '<strong>7) First lead:</strong> Trump chooser leads trick one; then each trick winner leads next.',
      '<strong>8) Follow suit:</strong> Must follow lead suit when possible; otherwise any card is legal.',
      '<strong>9) Trick winner:</strong> Trump beats non-trump. Otherwise highest card in compared suit wins.',
      '<strong>10) Contract target:</strong> Winning team must reach max(partner bids), not bid sum.',
      '<strong>11) Defender target:</strong> Defenders must reach 14 - contract target.',
      '<strong>12) Early end:</strong> Round ends immediately when either side hits target, otherwise after 13 tricks.',
    ],
  },
  dehla: {
    title: 'Dehla Pakad Rule Guide',
    items: [
      '<strong>1) Setup:</strong> 4 players, fixed teams (South+North vs West+East), all 52 cards dealt (13 each). No bidding.',
      '<strong>2) Match format:</strong> Host selects total rounds; most round wins takes the match.',
      '<strong>3) Objective:</strong> Capture the four 10s (Dehlas). First team to capture 3 or more 10s wins the round.',
      '<strong>4) Lead:</strong> Player to dealer\'s right leads the first trick. Trick winner leads the next trick.',
      '<strong>5) Follow suit:</strong> You must play the led suit if you have it. If void, you may play any card.',
      '<strong>6) Dynamic trump:</strong> No trump at start. When a void player plays off-suit, that suit becomes the potential trump.',
      '<strong>7) Overrule:</strong> If another void player in the same trick plays a different off-suit card, their suit overrules.',
      '<strong>8) Trump fixed:</strong> At the end of that trick, the last void-cut suit becomes permanent trump for the round.',
      '<strong>9) Trick winner:</strong> Highest trump wins; if no trump played, highest card of the led suit wins.',
      '<strong>10) Round result:</strong> 3 or 4 tens captured wins the round; 2-2 is a draw (no winner scored).',
    ],
  },
};

const AVATAR_IMG = {
  ironman:       '/assets/avatars/Iron%20man.png',
  captain:       '/assets/avatars/Captain%20America.png',
  thor:          '/assets/avatars/Thor.png',
  hulk:          '/assets/avatars/Hulk.png',
  blackwidow:    '/assets/avatars/Black%20widow.png',
  hawkeye:       '/assets/avatars/Hawk%20eye.png',
  strange:       '/assets/avatars/Doctor%20strange.png',
  panther:       '/assets/avatars/Black%20panther.png',
  scarletwitch:  '/assets/avatars/Scarlet%20witch.png',
  thanos:        '/assets/avatars/Thanos.png',
  spiderman:     '/assets/avatars/Spiderman.png',
  captainmarvel: '/assets/avatars/Captain%20Marvel.png',
};

const SUIT_SYMBOLS = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };
const SEAT_LABELS = ['South', 'West', 'North', 'East'];

const REACTION_LABELS = {
  laugh: '😂',
  cry: '😢',
  well_played: '👏',
  angry: '😠',
  waiting: '⏳',
  fire: '🔥',
};

const $ = (id) => document.getElementById(id);
const screens = { lobby: $('lobby'), waitingRoom: $('waitingRoom'), gameTable: $('gameTable') };

function safeName(player, fallback) {
  if (!player || !player.name) return fallback;
  return String(player.name).trim() || fallback;
}

function getTeamDisplayNames(state) {
  const p = state.players || [];
  const team0 = `${safeName(p[0], 'South')} & ${safeName(p[2], 'North')}`;
  const team1 = `${safeName(p[1], 'West')} & ${safeName(p[3], 'East')}`;
  return [team0, team1];
}

function formatSuitIcon(suit) {
  return SUIT_SYMBOLS[suit] || '?';
}

const RED_SUITS = new Set(['hearts', 'diamonds']);
function formatSuitHTML(suit) {
  const sym = SUIT_SYMBOLS[suit] || '?';
  const cls = RED_SUITS.has(suit) ? 'suit-red' : 'suit-black';
  return `<span class="${cls}">${sym}</span>`;
}

function ensureAudio() {
  if (audioCtx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  audioCtx = new Ctx();

  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.34;
  masterGain.connect(audioCtx.destination);

  bgmGain = audioCtx.createGain();
  bgmGain.gain.value = 0.28;
  bgmGain.connect(masterGain);

  sfxGain = audioCtx.createGain();
  sfxGain.gain.value = 0.95;
  sfxGain.connect(masterGain);
}

async function unlockAudio() {
  ensureAudio();
  if (!audioCtx || audioReady) return;
  try {
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }
    audioReady = true;
    applyMusicSettings();
    playSfx('click');
    startBgm();
  } catch (_) {
    // Silent fail: browser may still block until another interaction.
  }
}

function tone({ freq, type = 'sine', duration = 0.12, vol = 0.2, when = 0, target = 'sfx' }) {
  if (!audioCtx || !audioReady) return;
  const t0 = audioCtx.currentTime + when;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);

  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

  osc.connect(gain);
  gain.connect(target === 'bgm' ? bgmGain : sfxGain);
  osc.start(t0);
  osc.stop(t0 + duration + 0.03);
}

function playSfx(name) {
  if (!audioReady) return;
  switch (name) {
    case 'click':
      tone({ freq: 680, type: 'triangle', duration: 0.05, vol: 0.08 });
      tone({ freq: 920, type: 'triangle', duration: 0.04, vol: 0.05, when: 0.03 });
      break;
    case 'cardSelf':
      tone({ freq: 410, type: 'square', duration: 0.08, vol: 0.13 });
      tone({ freq: 520, type: 'triangle', duration: 0.09, vol: 0.10, when: 0.05 });
      break;
    case 'cardOther':
      tone({ freq: 300, type: 'square', duration: 0.07, vol: 0.10 });
      break;
    case 'start':
      tone({ freq: 392, type: 'sawtooth', duration: 0.14, vol: 0.11 });
      tone({ freq: 523, type: 'sawtooth', duration: 0.16, vol: 0.10, when: 0.08 });
      tone({ freq: 659, type: 'sawtooth', duration: 0.18, vol: 0.09, when: 0.15 });
      break;
    case 'roundStart':
      tone({ freq: 330, type: 'triangle', duration: 0.10, vol: 0.10 });
      tone({ freq: 494, type: 'triangle', duration: 0.12, vol: 0.08, when: 0.07 });
      break;
    case 'roundOver':
      tone({ freq: 523, type: 'sine', duration: 0.12, vol: 0.12 });
      tone({ freq: 440, type: 'sine', duration: 0.16, vol: 0.10, when: 0.12 });
      break;
    case 'gameOver':
      tone({ freq: 392, type: 'sawtooth', duration: 0.18, vol: 0.12 });
      tone({ freq: 523, type: 'sawtooth', duration: 0.20, vol: 0.12, when: 0.12 });
      tone({ freq: 784, type: 'sawtooth', duration: 0.26, vol: 0.11, when: 0.23 });
      break;
    case 'bidWin':
      tone({ freq: 466, type: 'triangle', duration: 0.10, vol: 0.10 });
      tone({ freq: 698, type: 'triangle', duration: 0.14, vol: 0.10, when: 0.08 });
      break;
    case 'trickWin':
      tone({ freq: 350, type: 'triangle', duration: 0.09, vol: 0.11 });
      tone({ freq: 587, type: 'triangle', duration: 0.12, vol: 0.10, when: 0.07 });
      break;
    case 'reaction':
      tone({ freq: 760, type: 'sine', duration: 0.06, vol: 0.06 });
      break;
    default:
      break;
  }
}

function startBgm() {
  if (!audioReady) return;
  const audio = document.getElementById('bgmAudio');
  if (!audio) return;
  applyMusicSettings();
  audio.play().catch(() => {});
}

function restartBgm() {
  const audio = document.getElementById('bgmAudio');
  if (audio) {
    audio.currentTime = 0;
  }
  startBgm();
}

function applyMusicSettings() {
  const audio = document.getElementById('bgmAudio');
  if (audio) {
    audio.volume = musicMuted ? 0 : musicVolumePct / 100;
    audio.muted = musicMuted;
  }
  // SFX gain
  if (masterGain) {
    const base = musicMuted ? 0 : musicVolumePct / 100;
    masterGain.gain.value = 0.1 + base * 0.45;
  }
}

function handleStateSfx(prev, next) {
  if (!prev) return;

  if ((prev.phase === 'waiting' && next.phase === 'bidding') ||
      (prev.phase === 'waiting' && next.phase === 'playing')) {
    playSfx('start');
  }
  if (prev.roundNumber !== next.roundNumber) {
    playSfx('roundStart');
  }
  if (prev.phase !== 'round_end' && next.phase === 'round_end') {
    playSfx('roundOver');
  }
  if (prev.lastBidWinnerSeat !== next.lastBidWinnerSeat && next.lastBidWinnerSeat !== null && next.lastBidWinnerSeat !== undefined) {
    playSfx('bidWin');
  }
  if (prev.lastTrickWinner !== next.lastTrickWinner && next.lastTrickWinner !== null && next.lastTrickWinner !== undefined) {
    playSfx('trickWin');
  }

  const prevTrickCount = (prev.currentTrick || []).length;
  const nextTrickCount = (next.currentTrick || []).length;
  if (nextTrickCount > prevTrickCount) {
    const lastPlay = next.currentTrick[next.currentTrick.length - 1];
    const seat = lastPlay ? lastPlay.seat : null;
    const isSelfPlay = mySeat !== null && seat === mySeat;
    if (!isSelfPlay) playSfx('cardOther');
  }
}

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => el.classList.toggle('active', key === name));
  if (name === 'gameTable') {
    tryLockLandscape();
  }
}

let landscapeToastShown = false;
function tryLockLandscape() {
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);
  if (!isMobile) return;

  if (screen.orientation && screen.orientation.lock) {
    screen.orientation.lock('landscape').catch(() => {});
  }

  if (!landscapeToastShown) {
    landscapeToastShown = true;
    const isPortrait = window.innerHeight > window.innerWidth;
    if (isPortrait) {
      showToast('📱 Rotate to landscape for the best experience', 5000);
    }
  }
}

// Game selection
for (const tile of document.querySelectorAll('.game-tile')) {
  tile.addEventListener('click', () => {
    selectedGame = tile.dataset.game;
    document.querySelectorAll('.game-tile').forEach(t => t.classList.remove('selected'));
    tile.classList.add('selected');
    renderRuleGuide(selectedGame);
    updateLobbyForGameType();
  });
}

for (const avatarBtn of document.querySelectorAll('.avatar-btn')) {
  avatarBtn.addEventListener('click', () => {
    selectedAvatar = avatarBtn.dataset.avatar;
    document.querySelectorAll('.avatar-btn').forEach(btn => btn.classList.remove('selected'));
    avatarBtn.classList.add('selected');
  });
}

$('btnRulesToggle').addEventListener('click', () => {
  const panel = $('rulesPanel');
  const willShow = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !willShow);
  $('btnRulesToggle').textContent = willShow ? 'Hide Rules' : 'Show Rules';
});

function renderRuleGuide(gameType) {
  const cfg = RULE_GUIDES[gameType] || RULE_GUIDES.spades;
  $('rulesTitle').textContent = cfg.title;
  const list = $('rulesContent');
  list.innerHTML = '';
  for (const item of cfg.items) {
    const li = document.createElement('li');
    li.innerHTML = item;
    list.appendChild(li);
  }
}

renderRuleGuide(selectedGame);

function parseTotalRounds() {
  const raw = $('totalRounds').value.trim();
  const n = Number(raw);
  if (!Number.isFinite(n)) return 7;
  return Math.max(1, Math.min(11, Math.floor(n)));
}

function updateLobbyForGameType() {
  const needsRounds = selectedGame === 'judgement' || selectedGame === 'dehla';
  $('totalRounds').disabled = !needsRounds;
  $('totalRounds').style.opacity = needsRounds ? '1' : '0.65';
}

updateLobbyForGameType();

$('btnCreate').addEventListener('click', () => {
  unlockAudio();
  const playerName = $('playerName').value.trim();
  if (!playerName) return showError('lobbyError', 'Please enter your name.');

  socket.emit('createRoom', { playerName, gameType: selectedGame, totalRounds: parseTotalRounds(), avatar: selectedAvatar }, (res) => {
    if (res.error) return showError('lobbyError', res.error);
    myRoomId = res.roomId;
    mySeat = res.seat;
    $('displayRoomCode').textContent = res.roomId;
    hideError('lobbyError');
    showScreen('waitingRoom');
  });
});

$('btnJoin').addEventListener('click', () => {
  unlockAudio();
  const playerName = $('playerName').value.trim();
  const roomId = $('joinCode').value.trim().toUpperCase();
  if (!playerName) return showError('lobbyError', 'Please enter your name.');
  if (!roomId || roomId.length < 4) return showError('lobbyError', 'Enter a valid room code.');

  socket.emit('joinRoom', { roomId, playerName, avatar: selectedAvatar }, (res) => {
    if (res.error) return showError('lobbyError', res.error);
    myRoomId = res.roomId;
    mySeat = res.seat;
    $('displayRoomCode').textContent = res.roomId;
    hideError('lobbyError');
    showScreen('waitingRoom');
  });
});

$('btnSimulate').addEventListener('click', () => {
  unlockAudio();
  mySeat = null;
  socket.emit('startSimulation', { gameType: selectedGame, totalRounds: parseTotalRounds() }, (res) => {
    if (res.error) return showError('lobbyError', res.error);
    myRoomId = res.roomId;
    hideError('lobbyError');
    showScreen('gameTable');
  });
});

$('btnCopyCode').addEventListener('click', () => {
  const code = $('displayRoomCode').textContent;
  navigator.clipboard.writeText(code).then(() => showToast(`Copied room code: ${code}`));
});

$('btnFillBots').addEventListener('click', () => {
  unlockAudio();
  socket.emit('fillBots', { roomId: myRoomId }, (res) => {
    if (res && res.error) showError('waitingError', res.error);
  });
});

$('btnStartGame').addEventListener('click', () => {
  unlockAudio();
  socket.emit('startGame', { roomId: myRoomId }, (res) => {
    if (res && res.error) showError('waitingError', res.error);
  });
});

$('btnPlayAgain').addEventListener('click', () => location.reload());
$('logToggle') && $('logToggle').addEventListener('click', () => $('logPanel').classList.toggle('open'));

for (const button of document.querySelectorAll('.reaction-btn')) {
  button.addEventListener('click', () => {
    const reaction = button.dataset.reaction;
    socket.emit('sendReaction', { reaction }, (res) => {
      if (res && res.error) showToast(res.error);
    });
  });
}

$('btnMusicMute') && $('btnMusicMute').addEventListener('click', () => {
  unlockAudio();
  musicMuted = !musicMuted;
  applyMusicSettings();
  localStorage.setItem('cg_music_muted', musicMuted ? '1' : '0');
});

$('musicVolume') && $('musicVolume').addEventListener('input', (e) => {
  unlockAudio();
  musicVolumePct = Number(e.target.value || 65);
  applyMusicSettings();
  localStorage.setItem('cg_music_volume', String(musicVolumePct));
});

$('musicMode') && $('musicMode').addEventListener('change', (e) => {
  unlockAudio();
  musicMode = e.target.value;
  localStorage.setItem('cg_music_mode', musicMode);
});

function loadMusicPrefs() {
  const m = localStorage.getItem('cg_music_muted');
  const v = Number(localStorage.getItem('cg_music_volume') || 65);
  const mode = localStorage.getItem('cg_music_mode') || 'calm';
  musicMuted = m === '1';
  musicVolumePct = Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 65;
  musicMode = ['calm', 'lounge', 'cinematic'].includes(mode) ? mode : 'calm';
}

loadMusicPrefs();

socket.on('gameState', (state) => {
  selectedGame = state.gameType || selectedGame;
  handleStateSfx(lastState, state);
  handleBidFlash(lastState, state);
  handleBidTrumpAnnouncement(lastState, state);
  lastState = state;
  updateWaitingRoomTheme(state);
  if (screens.waitingRoom.classList.contains('active')) {
    renderWaitingRoom(state);
    if (state.phase !== 'waiting') showScreen('gameTable');
  }
  if (screens.gameTable.classList.contains('active')) {
    renderTable(state);
  }
});

socket.on('gameOver', ({ winningTeam, scores }) => renderGameOver(winningTeam, scores));

socket.on('reactionEvent', (payload) => {
  playSfx('reaction');
  renderReaction(payload);
});

function renderWaitingRoom(state) {
  const ready = state.players.every(p => p !== null);
  const isAutoStart = state.gameType === 'judgement' || state.gameType === 'dehla';
  $('btnStartGame').disabled = isAutoStart ? true : (!ready || mySeat !== 0);
  $('btnStartGame').textContent = isAutoStart ? 'Auto Starts at 4 Players' : 'Start Game';
  const [team0Name, team1Name] = getTeamDisplayNames(state);
  $('seatTeam0').textContent = team0Name;
  $('seatTeam2').textContent = team0Name;
  $('seatTeam1').textContent = team1Name;
  $('seatTeam3').textContent = team1Name;

  for (let seat = 0; seat < 4; seat++) {
    const p = state.players[seat];
    const el = $(`seat${seat}`);
    el.className = 'seat-avatar';
    if (!p) {
      el.textContent = '?';
      continue;
    }
    el.classList.add('filled');
    if (p.isBot) el.classList.add('bot');
    if (seat === mySeat) el.classList.add('you');
    el.textContent = p.isBot ? `AI ${p.name}` : p.name.slice(0, 8);
  }
}

function renderTable(state) {
  renderScoreHUD(state);
  renderScorecard(state);
  renderJudgementGuide(state);
  renderPlayerInfos(state);
  renderOpponentHands(state);
  renderTrickArea(state);
  renderMyHand(state);
  renderLog(state);
  renderTurnIndicator(state);
  renderTurnClocks(state);
  applyTrickFlyAnimation(state);

  if (state.phase === 'bidding' && mySeat !== null && state.currentSeat === mySeat && !pendingBid) {
    showBidModal();
  }

  if (state.phase === 'trump_selection' && mySeat !== null && state.currentSeat === mySeat) {
    showTrumpModal(state);
  } else {
    hideModal('trumpModal');
  }

  if (state.phase === 'round_end') {
    if (!$('roundEndModal').classList.contains('shown')) {
      $('roundEndModal').classList.add('shown');
      roundEndShownAt = Date.now();
      renderRoundEnd(state);
      showRoundWinnerBanner(state);
      if (roundModalTimer) clearTimeout(roundModalTimer);
      roundModalTimer = setTimeout(() => {
        hideModal('roundEndModal');
      }, 5000);
      if (roundCountdownTicker) clearInterval(roundCountdownTicker);
      roundCountdownTicker = setInterval(() => {
        updateRoundEndCountdown(state);
      }, 250);
    }
    updateRoundEndCountdown(state);
  } else {
    if (roundCountdownTicker) {
      clearInterval(roundCountdownTicker);
      roundCountdownTicker = null;
    }
    hideModal('roundEndModal');
    $('roundEndModal').classList.remove('shown');
    roundEndShownAt = null;
  }
}

function updateRoundEndCountdown(state) {
  if (!$('roundEndModal').classList.contains('shown')) return;
  const startedAt = roundEndShownAt || Date.now();
  const elapsed = Date.now() - startedAt;
  const remain = Math.max(0, 5000 - elapsed);
  const seconds = Math.max(0, Math.ceil(remain / 1000));
  const node = $('roundNextCountdown');
  if (node) node.textContent = `${seconds}s`;
}

function renderJudgementGuide(state) {
  const panel = $('judgementGuide');
  if (!panel) return;
  const isJudgement = state.gameType === 'judgement';
  const isDehla = state.gameType === 'dehla';
  if (!isJudgement && !isDehla) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');

  if (isDehla) {
    $('liveGuideTitle').textContent = 'Dehla Live Rule';
    const [team0Name, team1Name] = getTeamDisplayNames(state);
    const t0 = state.teamTensCaptured ? state.teamTensCaptured[0] : 0;
    const t1 = state.teamTensCaptured ? state.teamTensCaptured[1] : 0;
    const trump = state.trumpSuit ? formatSuitHTML(state.trumpSuit) : 'Not yet revealed';
    const suitName = state.trumpSuit
      ? (state.trumpSuit.charAt(0).toUpperCase() + state.trumpSuit.slice(1))
      : null;
    const potential = (!state.trumpSuit && state.potentialTrumpSuit)
      ? formatSuitHTML(state.potentialTrumpSuit)
      : null;

    $('jgContract').textContent = `${team0Name}: ${t0} ten(s)`;
    $('jgDefender').textContent = `${team1Name}: ${t1} ten(s)`;
    if (state.trumpSuit) {
      $('jgProgress').innerHTML = `Trump: ${trump} ${suitName} (✓ fixed)`;
    } else if (potential) {
      $('jgProgress').innerHTML = `Potential trump: ${potential} (not yet fixed)`;
    } else {
      $('jgProgress').textContent = 'Trump: not revealed yet';
    }
    $('jgNote').textContent = 'Capture 3+ tens to win the round. 2-2 is a draw.';
    return;
  }

  $('liveGuideTitle').textContent = 'Judgement Live Rule';

  const contractTeam = state.contractTeam;
  const defenderTeam = state.defenderTeam;
  const [team0Name, team1Name] = getTeamDisplayNames(state);
  const cTarget = state.contractTarget;
  const dTarget = state.defenderTarget;

  const teamTricks = [
    (state.tricks[0] || 0) + (state.tricks[2] || 0),
    (state.tricks[1] || 0) + (state.tricks[3] || 0),
  ];

  const contractName = contractTeam === 0 ? team0Name : team1Name;
  const defenderName = defenderTeam === 0 ? team0Name : team1Name;
  const contractProgress = contractTeam === null || contractTeam === undefined ? '--' : teamTricks[contractTeam];
  const defenderProgress = defenderTeam === null || defenderTeam === undefined ? '--' : teamTricks[defenderTeam];

  $('jgContract').textContent = cTarget ? `${contractName} needs ${cTarget}` : 'Waiting for trump';
  $('jgDefender').textContent = dTarget ? `${defenderName} needs ${dTarget}` : 'Waiting for trump';

  if (!cTarget || !dTarget) {
    $('jgProgress').textContent = state.phase === 'trump_selection' ? 'Trump chooser deciding' : 'Awaiting targets';
    $('jgNote').textContent = 'Round target locks after trump selection.';
    return;
  }

  $('jgProgress').textContent = `${contractProgress}/${cTarget} vs ${defenderProgress}/${dTarget}`;

  if (state.phase === 'trump_selection') {
    $('jgNote').textContent = 'Trump timeout picks Spades automatically.';
  } else if (state.phase === 'bidding') {
    $('jgNote').textContent = 'Bid timeout places the minimum bid of 6.';
  } else {
    $('jgNote').textContent = 'Round ends as soon as one side hits target.';
  }
}

function updateWaitingRoomTheme(state) {
  const gameType = (state && state.gameType) || selectedGame;
  const icon = gameType === 'judgement' ? '⚖' : (gameType === 'dehla' ? '10' : '♠');
  const waitingIcon = $('waitingCenterIcon');
  if (waitingIcon) waitingIcon.textContent = icon;
  const centerSuit = document.querySelector('.center-suit');
  if (centerSuit) centerSuit.textContent = icon;
}

function renderScoreHUD(state) {
  const isJudgement = state.gameType === 'judgement';
  const isDehla = state.gameType === 'dehla';
  const isRoundBased = isJudgement || isDehla;
  const [team0Name, team1Name] = getTeamDisplayNames(state);
  $('scoreNS').textContent = state.teamScore[0];
  $('scoreEW').textContent = state.teamScore[1];
  $('bagsNS').textContent = isJudgement
    ? `round wins: ${state.roundWins ? state.roundWins[0] : state.teamScore[0]}`
    : (isDehla
      ? `tens: ${state.teamTensCaptured ? state.teamTensCaptured[0] : 0}`
      : `bags: ${state.teamBags[0]}`);
  $('bagsEW').textContent = isJudgement
    ? `round wins: ${state.roundWins ? state.roundWins[1] : state.teamScore[1]}`
    : (isDehla
      ? `tens: ${state.teamTensCaptured ? state.teamTensCaptured[1] : 0}`
      : `bags: ${state.teamBags[1]}`);

  $('teamLabelNS').textContent = team0Name;
  $('teamLabelEW').textContent = team1Name;
  $('roundBadge').textContent = `#${state.roundNumber}`;

  $('specialRuleLabel').textContent = isJudgement ? 'Mode' : (isDehla ? 'Trump' : 'Spades');
  const spadesBadge = $('spadesBrokenBadge');
  if (isJudgement) {
    const rounds = state.totalRounds || '--';
    const need = state.maxRoundWinsToClinch || '--';
    spadesBadge.textContent = `${rounds}r / ${need} to win`;
    spadesBadge.classList.remove('hidden');
  } else if (isDehla) {
    if (state.trumpSuit) {
      spadesBadge.innerHTML = `${formatSuitHTML(state.trumpSuit)} set`;
    } else {
      spadesBadge.textContent = 'Hidden';
    }
    spadesBadge.classList.remove('hidden');
  } else {
    spadesBadge.textContent = state.spadesBroken ? 'Broken' : 'Unbroken';
    spadesBadge.classList.remove('hidden');
  }

  const trumpBadge = $('trumpSuitBadge');
  if ((isJudgement || isDehla) && state.trumpSuit) {
    trumpBadge.innerHTML = formatSuitHTML(state.trumpSuit);
    trumpBadge.classList.remove('hidden');
  } else {
    trumpBadge.classList.add('hidden');
  }

  const contractBadge = $('contractBadge');
  if (isJudgement && state.contractTarget) {
    const ct = state.contractTeam === 0 ? team0Name : team1Name;
    const dt = state.defenderTeam === 0 ? team0Name : team1Name;
    contractBadge.textContent = `${ct} ${state.contractTarget} / ${dt} ${state.defenderTarget}`;
    contractBadge.classList.remove('hidden');
  } else if (isDehla) {
    const t0 = state.teamTensCaptured ? state.teamTensCaptured[0] : 0;
    const t1 = state.teamTensCaptured ? state.teamTensCaptured[1] : 0;
    contractBadge.textContent = `${team0Name} ${t0} / ${team1Name} ${t1}`;
    contractBadge.classList.remove('hidden');
  } else {
    contractBadge.classList.add('hidden');
  }
}

function renderScorecard(state) {
  const comp = state.competition || {};
  const isJudgement = state.gameType === 'judgement';
  const isDehla = state.gameType === 'dehla';
  const isRoundBased = isJudgement || isDehla;
  const [team0Name, team1Name] = getTeamDisplayNames(state);
  const leaderTeam = comp.leaderTeam;
  const teamLabel = leaderTeam === null ? 'Tie game' : (leaderTeam === 0 ? team0Name : team1Name);

  $('leaderLine').textContent = teamLabel;
  $('leadLine').textContent = isRoundBased ? `${comp.leadBy ?? 0} rounds` : `${comp.leadBy ?? 0} pts`;
  if (isJudgement && Array.isArray(comp.roundsToClinch)) {
    $('toWinLabel').textContent = `Rounds to Clinch (${team0Name} / ${team1Name})`;
    $('toWinLine').textContent = `${comp.roundsToClinch[0]} / ${comp.roundsToClinch[1]}`;
  } else if (isDehla && typeof state.totalRounds === 'number') {
    $('toWinLabel').textContent = 'Rounds Left';
    $('toWinLine').textContent = String(Math.max(0, state.totalRounds - state.roundNumber));
  } else if (!isJudgement && Array.isArray(comp.pointsToWin)) {
    $('toWinLabel').textContent = `To Win (${team0Name} / ${team1Name})`;
    $('toWinLine').textContent = `${comp.pointsToWin[0]} / ${comp.pointsToWin[1]}`;
  } else {
    $('toWinLabel').textContent = isRoundBased
      ? `Rounds to Clinch (${team0Name} / ${team1Name})`
      : `To Win (${team0Name} / ${team1Name})`;
    $('toWinLine').textContent = '--';
  }

  if (state.lastRoundSummary) {
    const winner = state.lastRoundSummary.roundWinnerTeam;
    let resultText;
    if (isJudgement) {
      const rw = state.lastRoundSummary.roundWins || state.roundWins || [0, 0];
      resultText = winner === null
        ? `Draw (${rw[0]} / ${rw[1]})`
        : `${winner === 0 ? team0Name : team1Name} won (${rw[0]} / ${rw[1]})`;
    } else if (isDehla) {
      const tens = state.lastRoundSummary.teamTensCaptured || state.teamTensCaptured || [0, 0];
      resultText = winner === null
        ? `Draw (${tens[0]} ten / ${tens[1]} ten)`
        : `${winner === 0 ? team0Name : team1Name} won (${tens[0]} / ${tens[1]} ten)`;
    } else {
      const points = state.lastRoundSummary.teamRoundPoints;
      resultText = winner === null
        ? `Draw (${points[0]} / ${points[1]})`
        : `${winner === 0 ? team0Name : team1Name} won (+${Math.max(points[0], points[1])})`;
    }
    $('roundResultLine').textContent = resultText;
  }
}

function renderPlayerInfos(state) {
  const dirs = ['South', 'West', 'North', 'East'];
  const avatarIds = ['avatarSouth', 'avatarWest', 'avatarNorth', 'avatarEast'];
  for (let s = 0; s < 4; s++) {
    const dir = dirs[s];
    const p = state.players[s];
    $(`name${dir}`).textContent = p ? p.name : '-';
    const avatarEl = $(avatarIds[s]);
    if (avatarEl) {
      const avatarKey = p && p.avatar ? p.avatar : 'ironman';
      const imgSrc = AVATAR_IMG[avatarKey];
      if (imgSrc) {
        avatarEl.innerHTML = `<img src="${imgSrc}" alt="${avatarKey}" draggable="false">`;
      } else {
        avatarEl.textContent = '🦾';
      }
    }

    const bid = state.bids ? state.bids[s] : undefined;
    $(`bid${dir}`).textContent = (state.gameType === 'dehla' || bid === null || bid === undefined) ? '' : `Bid: ${bid === 0 ? 'NIL' : bid}`;
    $(`tricks${dir}`).textContent = `${state.tricks[s] ?? 0} tricks`;

    const zone = $(`zone${dir}`);
    zone.classList.toggle('active-seat', state.currentSeat === s && (state.phase === 'playing' || state.phase === 'bidding' || state.phase === 'trump_selection'));
  }

  $('yourTurnBadge').classList.toggle('hidden', !(state.currentSeat === mySeat && state.phase === 'playing'));
}

function renderTurnClocks(state) {
  const ids = ['South', 'West', 'North', 'East'];
  const limitMs = state.turnDurationMs || 15000;
  const deadline = state.turnDeadlineTs || (Date.now() + limitMs);
  const remainMs = Math.max(0, deadline - Date.now());
  const progress = Math.max(0, Math.min(1, remainMs / limitMs));
  const angle = (1 - progress) * 360;

  for (let i = 0; i < ids.length; i++) {
    const el = $(`clock${ids[i]}`);
    if (!el) continue;
    if (state.phase === 'bidding' || state.phase === 'playing' || state.phase === 'trump_selection') {
      if (state.currentSeat === i) {
        el.style.setProperty('--progress', String(progress));
        el.style.setProperty('--hand-angle', `${angle}deg`);
      } else {
        el.style.setProperty('--progress', '1');
        el.style.setProperty('--hand-angle', '0deg');
      }
      el.classList.toggle('active', state.currentSeat === i);
    } else {
      el.style.setProperty('--progress', '1');
      el.style.setProperty('--hand-angle', '0deg');
      el.classList.remove('active');
    }
  }
}

function renderOpponentHands(state) {
  const seats = [
    { seat: 2, el: $('handNorth') },
    { seat: 1, el: $('handWest') },
    { seat: 3, el: $('handEast') },
  ];
  for (const { seat, el } of seats) {
    el.innerHTML = '';
    const visibleCards = state.hands[seat] || [];
    const hasFaceCards = visibleCards.some(c => !c.hidden);

    if (hasFaceCards) {
      for (const card of visibleCards) {
        if (card.hidden) continue;
        const c = buildCardElement(card, false, true);
        c.classList.add('trick-card');
        el.appendChild(c);
      }
      continue;
    }

    const count = state.handCounts[seat] || 0;
    for (let i = 0; i < count; i++) {
      const back = document.createElement('div');
      back.className = 'card-back';
      el.appendChild(back);
    }
  }
}

function renderTrickArea(state) {
  const slots = {
    0: $('trickSouth'),
    1: $('trickWest'),
    2: $('trickNorth'),
    3: $('trickEast'),
  };
  Object.values(slots).forEach(el => el.innerHTML = '');

  for (const item of state.currentTrick) {
    if (!item || !item.card || item.card.hidden) continue;
    const c = buildCardElement(item.card, false, true);
    c.classList.add('trick-card');
    slots[item.seat].appendChild(c);
  }
}

function applyTrickFlyAnimation(state) {
  const trickArea = $('trickArea');
  trickArea.classList.remove('fly-south', 'fly-west', 'fly-north', 'fly-east');
  if (state.phase !== 'trick_pause' || state.lastTrickWinner === null || state.lastTrickWinner === undefined) return;
  if (state.lastTrickWinner === 0) trickArea.classList.add('fly-south');
  if (state.lastTrickWinner === 1) trickArea.classList.add('fly-west');
  if (state.lastTrickWinner === 2) trickArea.classList.add('fly-north');
  if (state.lastTrickWinner === 3) trickArea.classList.add('fly-east');
}

function renderMyHand(state) {
  const handEl = $('handSouth');
  handEl.innerHTML = '';

  const seatToShow = mySeat === null ? 0 : mySeat;
  const hand = state.hands[seatToShow] || [];
  const legal = new Set(state.legalCards || []);
  const isMyTurn = state.currentSeat === mySeat && state.phase === 'playing';

  for (const card of hand) {
    if (card.hidden) continue;
    const id = `${card.rank}_${card.suit}`;
    const isLegal = isMyTurn && legal.has(id);
    const disabled = mySeat === null || !isMyTurn;
    const c = buildCardElement(card, isLegal, disabled);
    c.dataset.id = id;
    if (isLegal) c.addEventListener('click', () => onCardClick(card));
    handEl.appendChild(c);
  }
}

function renderLog(state) {
  const logBody = $('logBody');
  if (!logBody) return;
  logBody.innerHTML = '';
  const entries = (state.log || []).slice().reverse();
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'log-entry';
    row.textContent = e.msg;
    logBody.appendChild(row);
  }
}

function renderTurnIndicator(state) {
  const el = $('turnIndicator');
  if (state.phase === 'bidding' || state.phase === 'playing' || state.phase === 'trump_selection') {
    const player = state.players[state.currentSeat];
    const name = player ? player.name : SEAT_LABELS[state.currentSeat];
    const actionText = state.phase === 'bidding'
      ? 'bidding'
      : (state.phase === 'trump_selection' ? 'choosing trump' : 'playing');
    el.textContent = state.currentSeat === mySeat
      ? (state.phase === 'bidding' ? 'Your bid' : (state.phase === 'trump_selection' ? 'Choose trump' : 'Your turn'))
      : `${name} is ${actionText}...`;
    el.classList.add('visible');
  } else {
    el.classList.remove('visible');
  }
}

function buildCardElement(card, isLegal, disabled) {
  const el = document.createElement('div');
  el.className = `card ${card.suit}`;
  if (!isLegal) el.classList.add('illegal');
  if (!disabled && isLegal) el.classList.remove('illegal');

  const sym = SUIT_SYMBOLS[card.suit];
  el.innerHTML = `
    <div class="rank"><span>${card.rank}</span><span class="suit-mini">${sym}</span></div>
    <div class="pip-center">${sym}</div>
    <div class="rank rank-bottom"><span>${card.rank}</span><span class="suit-mini">${sym}</span></div>
  `;
  return el;
}

function onCardClick(card) {
  if (!lastState || mySeat === null) return;
  if (lastState.phase !== 'playing' || lastState.currentSeat !== mySeat) return;
  playSfx('cardSelf');
  const cardId = `${card.rank}_${card.suit}`;
  socket.emit('playCard', { cardId }, (res) => {
    if (res && res.error) showToast(res.error);
  });
}

function showBidModal() {
  pendingBid = true;
  const opts = $('bidOptions');
  opts.innerHTML = '';

  const isJudgement = lastState && lastState.gameType === 'judgement';
  const minBid = isJudgement ? 6 : 1;

  if (!isJudgement) {
    const nil = document.createElement('button');
    nil.className = 'bid-btn nil';
    nil.textContent = 'NIL';
    nil.addEventListener('click', () => submitBid(0));
    opts.appendChild(nil);
  }

  for (let bid = minBid; bid <= 13; bid++) {
    const btn = document.createElement('button');
    btn.className = 'bid-btn';
    btn.textContent = String(bid);
    btn.addEventListener('click', () => submitBid(bid));
    opts.appendChild(btn);
  }

  $('bidTip').textContent = isJudgement
    ? 'Choose your bid between 6 and 13.'
    : 'How many tricks will you take?';
  $('bidNote').innerHTML = isJudgement
    ? 'If timer expires, the game auto-places <strong>6</strong>.'
    : 'Bid <strong>0</strong> for <em>Nil</em>.';

  showModal('bidModal');
}

function showTrumpModal(state) {
  if (state.gameType !== 'judgement') return;
  const opts = $('trumpOptions');
  if (opts.dataset.ready === '1') {
    showModal('trumpModal');
    return;
  }

  opts.innerHTML = '';
  const suits = ['clubs', 'diamonds', 'hearts', 'spades'];
  for (const suit of suits) {
    const btn = document.createElement('button');
    btn.className = 'bid-btn';
    btn.innerHTML = `${suit[0].toUpperCase() + suit.slice(1)} ${SUIT_SYMBOLS[suit]}`;
    btn.addEventListener('click', () => submitTrump(suit));
    opts.appendChild(btn);
  }
  opts.dataset.ready = '1';
  showModal('trumpModal');
}

function submitTrump(suit) {
  hideModal('trumpModal');
  socket.emit('chooseTrump', { suit }, (res) => {
    if (res && res.error) showToast(res.error);
  });
}

function submitBid(bid) {
  pendingBid = false;
  hideModal('bidModal');
  socket.emit('placeBid', { bid }, (res) => {
    if (res && res.error) showToast(res.error);
  });
}

function renderRoundEnd(state) {
  const summary = state.lastRoundSummary;
  const comp = state.competition || {};
  const isJudgement = state.gameType === 'judgement';
  const isDehla = state.gameType === 'dehla';
  const isRoundBased = isJudgement || isDehla;
  const [team0Name, team1Name] = getTeamDisplayNames(state);
  $('roundEndTitle').textContent = `Round ${state.roundNumber} Complete`;

  const roundText = summary
    ? `${summary.roundWinnerTeam === null ? 'Round tied' : (summary.roundWinnerTeam === 0 ? `${team0Name} won the round` : `${team1Name} won the round`)}`
    : 'Round complete';

  const scoreUnit = isRoundBased ? 'rounds' : 'pts';
  const leadUnit = isRoundBased ? 'rounds' : 'pts';
  const tensLine = isDehla
    ? `<div class="round-score-row"><span>Tens Captured</span><span>${team0Name}: ${state.teamTensCaptured ? state.teamTensCaptured[0] : 0} • ${team1Name}: ${state.teamTensCaptured ? state.teamTensCaptured[1] : 0}</span></div>`
    : '';

  $('roundScores').innerHTML = `
    <div class="round-score-row"><span>${team0Name}</span><span>${state.teamScore[0]} ${scoreUnit}</span></div>
    <div class="round-score-row"><span>${team1Name}</span><span>${state.teamScore[1]} ${scoreUnit}</span></div>
    <div class="round-score-row"><span>Round Story</span><span>${roundText}</span></div>
    ${tensLine}
    <div class="round-score-row"><span>Leader Margin</span><span>${comp.leadBy ?? 0} ${leadUnit}</span></div>
    <div class="round-score-row"><span>Next round starts in</span><span id="roundNextCountdown">5s</span></div>
  `;

  showModal('roundEndModal');
}

function showRoundWinnerBanner(state) {
  const el = $('roundWinnerBanner');
  const summary = state.lastRoundSummary;
  if (!summary) return;
  const [team0Name, team1Name] = getTeamDisplayNames(state);
  const winner = summary.roundWinnerTeam;
  const text = winner === null
    ? `Round ${state.roundNumber} Drawn`
    : `Round ${state.roundNumber}: ${winner === 0 ? team0Name : team1Name} Won`;
  if (Array.isArray(summary.teamRoundPoints)) {
    el.textContent = `${text} • ${summary.teamRoundPoints[0]} / ${summary.teamRoundPoints[1]}`;
  } else if (Array.isArray(summary.teamTensCaptured)) {
    el.textContent = `${text} • ${summary.teamTensCaptured[0]} ten / ${summary.teamTensCaptured[1]} ten`;
  } else if (Array.isArray(summary.roundWins)) {
    el.textContent = `${text} • ${summary.roundWins[0]} / ${summary.roundWins[1]}`;
  } else {
    el.textContent = text;
  }
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4600);
}

function handleBidTrumpAnnouncement(prev, next) {
  if (!prev) return;

  if (next.gameType === 'judgement') {
    const movedIntoPlay = prev.phase === 'trump_selection' && next.phase === 'playing';
    if (!movedIntoPlay) return;
    const winnerSeat = next.lastBidWinnerSeat;
    const winnerName = winnerSeat !== null && winnerSeat !== undefined
      ? safeName(next.players[winnerSeat], SEAT_LABELS[winnerSeat])
      : 'Unknown';
    const trumpIcon = formatSuitHTML(next.trumpSuit);
    showBidTrumpBannerHTML(`${winnerName} won bid • Trump ${trumpIcon}`);
    return;
  }

  if (next.gameType === 'dehla') {
    if (prev.trumpSuit === null && next.trumpSuit !== null) {
      const icon = formatSuitHTML(next.trumpSuit);
      const suitName = next.trumpSuit.charAt(0).toUpperCase() + next.trumpSuit.slice(1);
      showBidTrumpBannerHTML(`Trump established: ${icon} ${suitName}`);
    }
  }
}

function showBidTrumpBanner(text) {
  showBidTrumpBannerHTML(text);
}

function showBidTrumpBannerHTML(html) {
  const el = $('bidTrumpBanner');
  if (!el) return;
  if (bidTrumpTimer) clearTimeout(bidTrumpTimer);
  el.innerHTML = html;
  el.classList.remove('hidden');
  void el.offsetWidth;
  el.style.animation = 'none';
  requestAnimationFrame(() => {
    el.style.animation = '';
  });
  bidTrumpTimer = setTimeout(() => {
    el.classList.add('hidden');
  }, 2600);
}

function handleBidFlash(prev, next) {
  if (!prev) return;
  for (let seat = 0; seat < 4; seat++) {
    const before = prev.bids ? prev.bids[seat] : null;
    const after = next.bids ? next.bids[seat] : null;
    if ((before === null || before === undefined) && (after !== null && after !== undefined)) {
      const player = next.players[seat];
      const name = player ? player.name : SEAT_LABELS[seat];
      const text = `${name} bid ${after === 0 ? 'NIL' : after}`;
      flashBid(text);
      break;
    }
  }
}

function flashBid(text) {
  const el = $('bidFlash');
  if (bidFlashTimer) clearTimeout(bidFlashTimer);
  el.textContent = text;
  el.classList.remove('hidden');
  void el.offsetWidth;
  el.style.animation = 'none';
  requestAnimationFrame(() => {
    el.style.animation = '';
  });
  bidFlashTimer = setTimeout(() => el.classList.add('hidden'), 1600);
}

function renderGameOver(winningTeam, scores) {
  playSfx('gameOver');
  const isJudgement = lastState && lastState.gameType === 'judgement';
  const isDehla = lastState && lastState.gameType === 'dehla';
  const isRoundBased = isJudgement || isDehla;
  const [team0Name, team1Name] = getTeamDisplayNames(lastState || { players: [] });
  let title = 'Match Tied';
  if (winningTeam === 0) title = `${team0Name} Wins!`;
  if (winningTeam === 1) title = `${team1Name} Wins!`;
  $('gameOverTitle').textContent = title;

  const unit = isRoundBased ? 'rounds' : 'pts';
  $('finalScores').innerHTML = `
    <div class="round-score-row"><span>${team0Name}</span><span>${scores[0]} ${unit}</span></div>
    <div class="round-score-row"><span>${team1Name}</span><span>${scores[1]} ${unit}</span></div>
  `;
  showModal('gameOverModal');
}

function renderReaction({ reaction, seat, name }) {
  const layer = $('reactionsLayer');
  const bubble = document.createElement('div');
  bubble.className = 'reaction-float';
  bubble.textContent = `${REACTION_LABELS[reaction] || '✨'}`;

  const coords = getSeatReactionPosition(seat);
  bubble.style.left = `${coords.x}px`;
  bubble.style.top = `${coords.y}px`;

  layer.appendChild(bubble);
  setTimeout(() => bubble.remove(), 2800);
}

function getSeatReactionPosition(seat) {
  const map = {
    0: $('zoneSouth'),
    1: $('zoneWest'),
    2: $('zoneNorth'),
    3: $('zoneEast'),
  };
  const target = seat === null || seat === undefined ? $('feltTable') : map[seat];
  const rect = target.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function showModal(id) { $(id).classList.remove('hidden'); }
function hideModal(id) { $(id).classList.add('hidden'); }

function showError(id, msg) {
  const el = $(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError(id) {
  $(id).classList.add('hidden');
}

let toastTimer = null;
function showToast(msg, duration = 2400) {
  const toast = $('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

document.addEventListener('keydown', (e) => {
  if (!$('bidModal').classList.contains('hidden') && pendingBid) {
    const isJudgement = lastState && lastState.gameType === 'judgement';
    if (!isJudgement && (e.key === 'n' || e.key === 'N')) return submitBid(0);
    const val = parseInt(e.key, 10);
    const minBid = isJudgement ? 6 : 1;
    if (!Number.isNaN(val) && val >= minBid && val <= 9) submitBid(val);
  }
});

$('playerName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btnCreate').click();
});
$('joinCode').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btnJoin').click();
});

// Unlock audio after user gesture and apply click SFX across controls.
document.addEventListener('pointerdown', () => {
  unlockAudio();
}, { once: true });

document.addEventListener('keydown', () => {
  unlockAudio();
}, { once: true });

document.addEventListener('click', (e) => {
  const hit = e.target.closest('.btn, .reaction-btn, .bid-btn, .btn-copy, .game-tile, .card');
  if (!hit) return;
  playSfx('click');
});

if (!uiTicker) {
  uiTicker = setInterval(() => {
    if (!lastState) return;
    if (!screens.gameTable.classList.contains('active')) return;
    renderTurnClocks(lastState);
  }, 250);
}
