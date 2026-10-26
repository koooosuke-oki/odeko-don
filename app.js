// つたえてドン！ ゲーム本体
(() => {
  const $ = (id) => document.getElementById(id);
  // index.html で付けた ?v=… を、あとから読み込むファイルにも付ける
  const VERSION = new URL(document.currentScript.src).search;

  const state = {
    category: null,
    words: [],      // シャッフル済みのお題
    index: 0,
    results: [],    // { word, ok }
    timeLeft: 60,
    endAt: 0,
    timerId: null,
    playing: false,
    locked: false,  // 正解/パス直後の演出中
    tiltEnabled: true,
    neutral: false, // おでこに当てた（まっすぐの）状態か
    hasSensor: false,
    wakeLock: null,
    adult: false,   // 大人モード中か
    secret: false,  // ダンサーモード中か
    secretCategories: [],
  };

  // ---------- 画面切り替え ----------
  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
    updateOrientationHint();
  }

  function isPortrait() {
    return window.innerHeight > window.innerWidth;
  }

  // 準備・プレイ中に縦向きなら「横向きにしてね」を出す
  function updateOrientationHint() {
    const inGame = $('ready').classList.contains('active') || $('play').classList.contains('active');
    document.body.classList.toggle('need-landscape', inGame && isPortrait());
  }
  window.addEventListener('resize', () => {
    updateOrientationHint();
    if ($('ready').classList.contains('active')) maybeStartCountdown();
  });

  // ---------- ホーム ----------
  function renderCategories() {
    const list = $('category-list');
    list.innerHTML = '';
    let categories = window.CATEGORIES;
    if (state.adult) categories = withAllCategory(window.ADULT_CATEGORIES);
    if (state.secret) categories = withAllCategory(state.secretCategories);
    for (const cat of categories) {
      const btn = document.createElement('button');
      btn.className = 'category-card';
      btn.innerHTML = `<span class="emoji">${cat.emoji}</span>
        <span class="name">${cat.name}</span>
        <span class="count">${cat.words.length}問</span>`;
      btn.addEventListener('click', () => selectCategory(cat));
      list.appendChild(btn);
    }
  }

  // テーマが2つ以上あるときは、先頭に全テーマのお題をまとめた「ぜんぶ」を足す
  function withAllCategory(categories) {
    if (categories.length < 2) return categories;
    const all = {
      name: 'ぜんぶ',
      emoji: '🌟',
      words: [...new Set(categories.flatMap((c) => c.words))],
    };
    return [all, ...categories];
  }

  async function selectCategory(cat) {
    state.category = cat;
    state.tiltEnabled = $('tilt-toggle').checked;
    state.timeLeft = Number($('time-select').value);
    unlockAudio();
    if (state.tiltEnabled) await requestMotionPermission();
    requestWakeLock();
    goReady();
  }

  // iOS はユーザー操作の中で許可を求める必要がある
  async function requestMotionPermission() {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      try {
        const res = await DOE.requestPermission();
        if (res !== 'granted') {
          state.tiltEnabled = false;
          alert('傾き操作が許可されなかったので、ボタン操作で遊びます。');
        }
      } catch (e) {
        state.tiltEnabled = false;
      }
    }
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !state.wakeLock) {
        state.wakeLock = await navigator.wakeLock.request('screen');
        state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
      }
    } catch (e) { /* 対応していなければ何もしない */ }
  }

  function releaseWakeLock() {
    if (state.wakeLock) state.wakeLock.release();
    state.wakeLock = null;
  }

  // ---------- 準備 ----------
  let countdownTimer = null;

  function goReady() {
    $('ready-category').textContent = `${state.category.emoji} ${state.category.name}`;
    $('countdown').textContent = '';
    state.neutral = false;
    show('ready');
    maybeStartCountdown();
  }

  // 横向き、かつ（センサーがあれば）おでこに当てた状態になったらカウントダウン開始
  function maybeStartCountdown() {
    if (countdownTimer || !$('ready').classList.contains('active')) return;
    if (isPortrait()) {
      $('ready-message').textContent = '横向きにしてね';
      return;
    }
    if (state.tiltEnabled && state.hasSensor && !state.neutral) {
      $('ready-message').textContent = 'おでこに当ててね';
      return;
    }
    $('ready-message').textContent = 'はじまるよ！';
    let n = 3;
    $('countdown').textContent = n;
    sfx.countdown();
    countdownTimer = setInterval(() => {
      n -= 1;
      if (n > 0) {
        $('countdown').textContent = n;
        sfx.countdown();
      } else {
        stopCountdown();
        startGame();
      }
    }, 1000);
  }

  function stopCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  $('ready-cancel').addEventListener('click', () => {
    stopCountdown();
    releaseWakeLock();
    show('home');
  });

  // ---------- プレイ ----------
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function startGame() {
    state.words = shuffle(state.category.words);
    state.index = 0;
    state.results = [];
    state.playing = true;
    state.locked = false;
    state.endAt = Date.now() + state.timeLeft * 1000;
    $('play').classList.toggle('tilt-mode', state.tiltEnabled);
    $('score').textContent = '0';
    showWord();
    show('play');
    sfx.start();
    tick();
    state.timerId = setInterval(tick, 200);
  }

  function showWord() {
    // お題を使い切ったら混ぜ直す
    if (state.index >= state.words.length) {
      state.words = shuffle(state.category.words);
      state.index = 0;
    }
    $('word').textContent = state.words[state.index];
  }

  function tick() {
    const left = Math.max(0, Math.ceil((state.endAt - Date.now()) / 1000));
    const timer = $('timer');
    if (timer.textContent !== String(left) && left <= 5 && left > 0) sfx.hurry();
    timer.textContent = left;
    timer.classList.toggle('hurry', left <= 10);
    if (left <= 0) endGame();
  }

  function answer(ok) {
    if (!state.playing || state.locked) return;
    state.locked = true;
    state.results.push({ word: state.words[state.index], ok });
    $('score').textContent = state.results.filter((r) => r.ok).length;

    const flash = $('flash');
    flash.textContent = ok ? '正解！' : 'パス';
    flash.className = `flash show ${ok ? 'correct' : 'pass'}`;
    if (ok) sfx.correct();
    else sfx.pass();
    if (navigator.vibrate) navigator.vibrate(ok ? 80 : [40, 60, 40]);

    setTimeout(() => {
      flash.className = 'flash';
      if (!state.playing) return;
      state.index += 1;
      showWord();
      state.locked = false;
    }, 700);
  }

  $('correct-btn').addEventListener('click', () => answer(true));
  $('pass-btn').addEventListener('click', () => answer(false));

  // パソコンで試すとき用：→ / Enter で正解、← / Space でパス
  document.addEventListener('keydown', (e) => {
    if (!$('play').classList.contains('active')) return;
    if (e.key === 'ArrowRight' || e.key === 'Enter') answer(true);
    if (e.key === 'ArrowLeft' || e.key === ' ') answer(false);
  });

  function endGame() {
    if (!state.playing) return;
    state.playing = false;
    clearInterval(state.timerId);
    // 最後に表示していたお題（未回答）はパス扱いで結果に入れる
    if (!state.locked) state.results.push({ word: state.words[state.index], ok: false });
    sfx.end();
    if (navigator.vibrate) navigator.vibrate(300);
    setTimeout(showResult, 700);
  }

  // ---------- 傾き検出 ----------
  // 横向きでおでこに当てると、画面が垂直になり |gamma| ≒ 90。
  // 傾けると |gamma| が 0 に近づき、
  //   画面が下向き（うなずく）→ |beta| が 180 付近 → 正解
  //   画面が上向き（のけぞる）→ |beta| が 0 付近   → パス
  const TILT_TRIGGER = 40;  // |gamma| がこれより小さくなったら傾けたと判定
  const TILT_NEUTRAL = 65;  // |gamma| がこれより大きければ、まっすぐに戻ったと判定

  window.addEventListener('deviceorientation', (e) => {
    if (e.beta == null || e.gamma == null) return;
    state.hasSensor = true;
    const g = Math.abs(e.gamma);

    if (g > TILT_NEUTRAL) {
      if (!state.neutral) {
        state.neutral = true;
        if ($('ready').classList.contains('active')) maybeStartCountdown();
      }
      return;
    }
    if (g < TILT_TRIGGER && state.neutral) {
      state.neutral = false;
      if (state.tiltEnabled && state.playing && !state.locked && !isPortrait()) {
        answer(Math.abs(e.beta) > 90);
      }
    }
  });

  // ---------- 結果 ----------
  function showResult() {
    releaseWakeLock();
    const correct = state.results.filter((r) => r.ok).length;
    $('result-score').textContent = correct;
    const list = $('result-list');
    list.innerHTML = '';
    for (const r of state.results) {
      const li = document.createElement('li');
      li.className = r.ok ? 'ok' : 'ng';
      li.textContent = r.word;
      list.appendChild(li);
    }
    show('result');
  }

  $('again-btn').addEventListener('click', () => {
    state.timeLeft = Number($('time-select').value);
    unlockAudio();
    requestWakeLock();
    goReady();
  });
  $('home-btn').addEventListener('click', () => show('home'));

  // ---------- ダンサーモード（パスワード付き） ----------
  // お題はパスワードで暗号化して dancer.enc.json に入れてある。
  // 正しいパスワードでしか中身を取り出せないので、公開ファイルを見られても名前はわからない。
  // 作り直すときは tools/encrypt-words.py を使う。
  const SECRET_KEY = 'tsutaete-secret-words';

  // 全角・半角の違いや前後の空白は気にしない
  function normalizePassword(text) {
    return text.normalize('NFKC').trim();
  }

  function fromBase64(b64) {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  }

  // 正しいパスワードならカテゴリの配列を返す。違えば例外になる
  async function decryptWords(password) {
    const res = await fetch('dancer.enc.json' + VERSION);
    if (!res.ok) throw new Error('network');
    const enc = await res.json();
    const baseKey = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(normalizePassword(password)), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: fromBase64(enc.salt), iterations: enc.iterations, hash: 'SHA-256' },
      baseKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(enc.iv) }, key, fromBase64(enc.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  function enterSecretMode(categories) {
    state.secretCategories = categories;
    state.secret = true;
    document.body.classList.add('secret');
    renderCategories();
    show('home');
    window.scrollTo(0, 0);
  }

  function exitSecretMode() {
    state.secret = false;
    document.body.classList.remove('secret');
    renderCategories();
  }

  // 一度入れたら、タブを閉じるまではパスワードを聞き直さない
  function savedSecretWords() {
    try { return JSON.parse(sessionStorage.getItem(SECRET_KEY)); } catch (e) { return null; }
  }

  $('secret-btn').addEventListener('click', () => {
    const saved = savedSecretWords();
    if (saved) {
      enterSecretMode(saved);
      return;
    }
    $('password-input').value = '';
    $('password-error').textContent = '';
    show('password-gate');
    $('password-input').focus();
  });

  $('password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('password-input');
    if (!input.value.trim()) {
      $('password-error').textContent = 'パスワードを入力してください';
      return;
    }
    try {
      const categories = await decryptWords(input.value);
      try { sessionStorage.setItem(SECRET_KEY, JSON.stringify(categories)); } catch (err) { /* 覚えられなくても続行 */ }
      input.blur();
      enterSecretMode(categories);
    } catch (err) {
      $('password-error').textContent = err.message === 'network'
        ? '読み込めませんでした。通信状態を確認してください'
        : 'パスワードがちがいます';
      input.select();
    }
  });
  $('password-cancel').addEventListener('click', () => show('home'));
  $('secret-exit').addEventListener('click', exitSecretMode);

  // ---------- 大人モード・年齢確認 ----------
  // 年齢確認は、ブラウザを開いている間（タブを閉じるまで）だけ覚えておく
  const AGE_KEY = 'odeko-age-confirmed';

  function isAgeConfirmed() {
    try { return sessionStorage.getItem(AGE_KEY) === 'yes'; } catch (e) { return false; }
  }

  // 大人向けのお題は、年齢確認のあとで初めて読み込む
  function loadAdultWords() {
    if (window.ADULT_CATEGORIES) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'words-adult.js' + VERSION;
      script.onload = resolve;
      script.onerror = reject;
      document.body.appendChild(script);
    });
  }

  async function enterAdultMode() {
    try {
      await loadAdultWords();
    } catch (e) {
      alert('お題を読み込めませんでした。通信状態を確認してください。');
      show('home');
      return;
    }
    state.adult = true;
    document.body.classList.add('adult');
    renderCategories();
    show('home');
    window.scrollTo(0, 0);
  }

  function exitAdultMode() {
    state.adult = false;
    document.body.classList.remove('adult');
    renderCategories();
  }

  $('adult-btn').addEventListener('click', () => {
    if (isAgeConfirmed()) enterAdultMode();
    else show('age-gate');
  });
  $('age-yes').addEventListener('click', () => {
    try { sessionStorage.setItem(AGE_KEY, 'yes'); } catch (e) { /* 覚えられなくても続行 */ }
    enterAdultMode();
  });
  $('age-no').addEventListener('click', () => show('home'));
  $('adult-exit').addEventListener('click', exitAdultMode);

  // ---------- 効果音 ----------
  // 音声ファイルは使わず、その場で音を合成して鳴らす
  let audioCtx = null;
  function unlockAudio() {
    try {
      // iPhone のマナーモード中でも鳴るようにする（iOS 17 以降）
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
      if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      // iPhone は止まると 'suspended' だけでなく 'interrupted' にもなるので、動いていなければ再開する
      if (audioCtx.state !== 'running') audioCtx.resume();
      // 無音を一瞬鳴らして、iPhone で音の再生を確実に有効にする
      const buffer = audioCtx.createBuffer(1, 1, 22050);
      const src = audioCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(audioCtx.destination);
      src.start(0);
    } catch (e) { audioCtx = null; }
  }

  // どの画面でも、タップされたら音を使える状態に戻しておく
  document.addEventListener('touchend', unlockAudio, { passive: true });
  document.addEventListener('click', unlockAudio);

  // 1音を鳴らす。delay 秒後に、type の波形で freq Hz を duration 秒
  function tone(freq, duration, { type = 'sine', volume = 0.3, delay = 0 } = {}) {
    if (!audioCtx || !$('sound-toggle').checked) return;
    if (audioCtx.state !== 'running') audioCtx.resume();
    const t = audioCtx.currentTime + delay;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  const sfx = {
    countdown: () => tone(660, 0.12, { type: 'triangle', volume: 0.4 }),
    start: () => tone(1320, 0.35, { type: 'triangle', volume: 0.45 }),
    hurry: () => tone(880, 0.07, { type: 'square', volume: 0.12 }),
    // ピンポーン！（明るい2音のチャイム）
    correct: () => {
      tone(1319, 0.25, { type: 'triangle', volume: 0.5 });
      tone(1047, 0.5, { type: 'triangle', volume: 0.5, delay: 0.15 });
      tone(2093, 0.3, { type: 'sine', volume: 0.12, delay: 0.15 });
    },
    // ブッブー（低いブザー2回）
    pass: () => {
      tone(150, 0.18, { type: 'sawtooth', volume: 0.3 });
      tone(150, 0.3, { type: 'sawtooth', volume: 0.3, delay: 0.22 });
    },
    // 終了の笛（長めのブザー）
    end: () => {
      tone(523, 0.15, { type: 'square', volume: 0.2 });
      tone(392, 0.15, { type: 'square', volume: 0.2, delay: 0.16 });
      tone(262, 0.6, { type: 'square', volume: 0.2, delay: 0.32 });
    },
  };

  $('sound-toggle').addEventListener('change', (e) => {
    unlockAudio();
    if (e.target.checked) sfx.correct();
  });

  // 画面に戻ってきたら画面スリープ防止をかけ直す
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (state.playing || $('ready').classList.contains('active'))) {
      requestWakeLock();
    }
  });

  renderCategories();
})();
