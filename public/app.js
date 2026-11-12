/* IPL TRUMP 2026 – browser client.
 * Renders ONLY from the per-player server view. No game rules are enforced here;
 * the buttons merely send intents, and the server accepts or rejects them.
 */
(() => {
  'use strict';

  const SESSION_KEY = 'ipltrump.session';
  const LABELS = {
    matches: 'Matches', runs: 'Runs', battingAverage: 'Batting Avg', strikeRate: 'Strike Rate',
    highestScore: 'Highest Score', centuries: 'Centuries', halfCenturies: 'Half Centuries',
    wickets: 'Wickets', bowlingAverage: 'Bowling Avg', economyRate: 'Economy', catches: 'Catches',
  };
  const DECIMAL_KEYS = new Set(['battingAverage', 'strikeRate', 'bowlingAverage', 'economyRate']);
  const STAT_ORDER = Object.keys(LABELS);

  const $ = (sel) => document.querySelector(sel);
  const app = $('#app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtLakh = (lakh) => `₹${(lakh / 100).toFixed(2)} Cr`;
  const fmtStat = (k, v) => (v === null || v === undefined ? '—' : DECIMAL_KEYS.has(k) ? Number(v).toFixed(2) : String(v));
  const initials = (name) => name.split(' ').map((w) => w[0]).join('').slice(0, 3).toUpperCase();
  const bidStep = (current) => (current < 100 ? 5 : current < 500 ? 10 : 25);

  let session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  let view = null;
  let es = null;
  let offset = 0;             // serverNow − Date.now(), for countdown accuracy
  let busy = false;
  let pick = null;            // { key, category } – local, not yet locked
  let lastOverlaySeq = null;  // auction SOLD/UNSOLD overlay tracking
  let lastWinnerKey = null;   // round reveal overlay tracking

  // ───────────────────────────────────────────────────────── plumbing
  function toast(msg, bad = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast${bad ? ' bad' : ''}`;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), 3200);
  }

  function setConn(ok, label) {
    const c = $('#conn');
    c.className = `conn${ok ? ' ok' : ''}`;
    c.querySelector('span').textContent = label || (ok ? 'Live' : 'Reconnecting…');
  }

  function saveSession(s) {
    session = s;
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  }

  function clearSession() {
    session = null;
    view = null;
    localStorage.removeItem(SESSION_KEY);
    if (es) { es.close(); es = null; }
    $('#room-chip').classList.add('hidden');
    render();
  }

  function connect() {
    if (es) es.close();
    view = null;
    render();
    const url = `/api/rooms/${encodeURIComponent(session.code)}/stream?token=${encodeURIComponent(session.token)}`;
    es = new EventSource(url);
    es.addEventListener('state', (e) => {
      view = JSON.parse(e.data);
      offset = view.serverNow - Date.now();
      setConn(true);
      render();
    });
    es.onopen = () => setConn(true);
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        toast('This room is no longer available for your session.', true);
        clearSession();
      } else {
        setConn(false);
      }
    };
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || 'Request failed');
    return data;
  }

  async function act(type, extra = {}) {
    if (!session || busy) return;
    busy = true;
    try {
      await api(`/api/rooms/${session.code}/action`, {
        ...extra, type, token: session.token, actionId: crypto.randomUUID(),
      });
    } catch (err) {
      toast(err.message, true);
    } finally {
      busy = false;
    }
  }

  // ───────────────────────────────────────────────────────── components
  function crest(team, cls = '') {
    const size = team.abbr.length > 3 ? 12 : 16;
    return `<svg class="crest ${cls}" viewBox="0 0 64 64" aria-hidden="true">
      <defs><linearGradient id="g-${team.id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${team.primary}"/><stop offset="1" stop-color="${team.secondary}"/></linearGradient></defs>
      <path d="M32 3 L58 14 V34 C58 48 46 57 32 61 C18 57 6 48 6 34 V14 Z" fill="url(#g-${team.id})" stroke="#fff" stroke-width="2"/>
      <text x="32" y="37" text-anchor="middle" font-size="${size}" font-weight="900" fill="#fff" font-family="Trebuchet MS, sans-serif">${esc(team.abbr)}</text>
    </svg>`;
  }

  const teamOf = (teamId) => (view ? view.teams.find((t) => t.id === teamId) : null);

  function statTable(p, highlightKey = null) {
    const rows = STAT_ORDER.map((k) => {
      const v = p.stats[k];
      const cls = [v === null || v === undefined ? 'unavail' : '', k === highlightKey ? 'hl' : ''].join(' ');
      return `<tr class="${cls}"><td>${LABELS[k]}</td><td>${fmtStat(k, v)}</td></tr>`;
    }).join('');
    return `<table class="stat-table">${rows}</table>`;
  }

  function testBadge(p) {
    return p.dataSource === 'SYNTHETIC_TEST' ? '<span class="tag test">TEST DATA</span>' : '<span class="tag">Verified</span>';
  }

  function playerCard(p, { winner = false, extra = '', showStats = true, highlightKey = null, cls = '' } = {}) {
    return `<div class="card ${cls} ${winner ? 'winner' : ''}">
      <div class="head"><span>IPL Trump Card</span>${testBadge(p)}</div>
      <div class="photo" role="img" aria-label="${esc(p.name)} photo placeholder">${esc(initials(p.name))}</div>
      <p class="cname">${esc(p.name)}</p>
      <div class="role">${esc(p.role)}</div>
      <div class="meta">${esc(p.nationality)} · Base ${fmtLakh(p.basePrice)}</div>
      ${showStats ? statTable(p, highlightKey) : ''}
      ${extra}
    </div>`;
  }

  function overlayStamp(html, ms = 2600) {
    const o = $('#overlay');
    o.innerHTML = html;
    o.classList.remove('hidden');
    clearTimeout(overlayStamp._t);
    overlayStamp._t = setTimeout(() => o.classList.add('hidden'), ms);
  }

  function confetti() {
    const colors = ['#f5c542', '#1e9bff', '#ff7a1a', '#35d28a', '#ffffff'];
    let html = '<div class="confetti">';
    for (let i = 0; i < 90; i++) {
      html += `<i style="--x:${Math.random() * 100}%;--c:${colors[i % colors.length]};--d:${3 + Math.random() * 4}s;animation-delay:${-Math.random() * 6}s"></i>`;
    }
    return `${html}</div>`;
  }

  // ───────────────────────────────────────────────────────── screens
  function renderLanding() {
    app.innerHTML = `
      <section class="hero">
        <h1>Build the squad. Win the Trump battle.</h1>
        <div class="stripe"></div>
        <p>A two-player IPL auction and 14-match tournament. Bid from a ₹120 Cr purse, then duel your opponent with cricket cards, where the best-scoring statistic takes the round.</p>
      </section>
      <div class="grid g-2 landing-grid">
        <div class="panel stack">
          <h2>Create a room</h2>
          <p class="muted small">You become the host. Share the room code with your opponent.</p>
          <label for="create-name">Your name</label>
          <input id="create-name" maxlength="20" placeholder="e.g. Dhoni Fan" autocomplete="nickname" />
          <button class="btn big" id="create-btn">Create private room</button>
        </div>
        <div class="panel stack">
          <h2>Join a room</h2>
          <p class="muted small">Enter the six-character code shared by the host.</p>
          <label for="join-code">Room code</label>
          <input id="join-code" maxlength="6" placeholder="ABC123" style="text-transform:uppercase;letter-spacing:.3em" />
          <label for="join-name">Your name</label>
          <input id="join-name" maxlength="20" placeholder="e.g. Kohli Fan" autocomplete="nickname" />
          <button class="btn orange big" id="join-btn">Join room</button>
        </div>
      </div>`;
    $('#create-btn').onclick = async () => {
      try {
        const r = await api('/api/rooms', { name: $('#create-name').value });
        saveSession({ code: r.code, token: r.token, seat: r.seat });
        connect();
      } catch (e) { toast(e.message, true); }
    };
    $('#join-btn').onclick = async () => {
      try {
        const r = await api('/api/rooms/join', { code: $('#join-code').value, name: $('#join-name').value });
        saveSession({ code: r.code, token: r.token, seat: r.seat });
        connect();
      } catch (e) { toast(e.message, true); }
    };
  }

  function seatList() {
    const list = [null, null];
    list[view.you.seat] = { ...view.you, mine: true };
    if (view.opponent) list[view.opponent.seat] = { ...view.opponent, mine: false };
    return list;
  }

  function renderLobby() {
    const seats = seatList();
    const rows = seats.map((s, i) => s
      ? `<div class="seat">
           <span class="dot ${s.connected ? 'on' : ''}"></span>
           <div style="flex:1"><div class="name">${esc(s.name)} ${s.mine ? '<span class="tag">You</span>' : ''}</div>
           <div class="muted small">${i === 0 ? 'Host' : 'Player 2'} · ${s.connected ? 'Connected' : 'Disconnected'}</div></div>
         </div>`
      : `<div class="seat" style="opacity:.6"><span class="dot"></span>
           <div><div class="name">Waiting for player…</div><div class="muted small">Share the code above</div></div></div>`).join('');
    const l = view.lobby;
    let hint = '';
    if (l.waiting) hint = 'Waiting for your opponent to join with the room code.';
    else if (!l.bothConnected) hint = 'Both players must be connected before the game can start.';
    app.innerHTML = `
      <div class="grid g-2">
        <div class="panel center stack">
          <h3>Private room code</h3>
          <div class="code">${esc(view.code)}</div>
          <p class="muted small">Your opponent enters this code on the landing page.</p>
        </div>
        <div class="panel stack">
          <h2>Lobby</h2>
          ${rows}
          ${l.canStart
            ? '<button class="btn orange big" data-act="start">Start game</button>'
            : `<p class="muted center">${esc(hint || (view.you.seat === 0 ? 'Ready when both players are connected.' : 'Waiting for the host to start the game.'))}</p>`}
        </div>
      </div>`;
  }

  function renderTeams() {
    const mine = view.you.teamId;
    const opp = view.opponent;
    const cards = view.teams.map((t) => {
      const takenByOpp = t.takenBySeat !== null && t.takenBySeat !== view.you.seat;
      const isMine = mine === t.id;
      return `<button class="team-card ${isMine ? 'mine' : ''} ${takenByOpp ? 'taken' : ''}" data-act="pickTeam" data-team="${t.id}" ${takenByOpp ? 'disabled' : ''}>
        ${crest(t, 'lg')}
        <div><div class="tname">${esc(t.name)}</div><div class="abbr">${esc(t.abbr)}</div></div>
        ${isMine ? '<span class="tag" style="color:var(--gold)">Your franchise</span>' : ''}
        ${takenByOpp ? `<span class="tag">Taken by ${esc(opp ? opp.name : 'opponent')}</span>` : ''}
      </button>`;
    }).join('');
    const status = !mine ? 'Pick your franchise. Both players must choose different teams.'
      : (opp && opp.teamId) ? 'Both teams locked in. The auction is starting…'
      : 'Waiting for your opponent to pick a team.';
    app.innerHTML = `
      <div class="panel stack">
        <h2>Team selection</h2>
        <p class="muted">${esc(status)}</p>
        <div class="team-grid">${cards}</div>
      </div>`;
  }

  function squadSummary(sq) {
    const count = (role) => sq.players.filter((p) => p.role === role).length;
    return { total: sq.players.length, batters: count('Batter'), bowlers: count('Bowler'),
      allrounders: count('All-rounder'), keepers: count('Wicketkeeper') };
  }

  function squadPanel(sq, label) {
    const team = teamOf(sq.teamId);
    const s = squadSummary(sq);
    const pct = Math.min(100, (sq.purse / 12000) * 100);
    const problems = sq.validation.valid
      ? '<span class="tag" style="color:var(--green)">Squad valid</span>'
      : sq.validation.problems.map((p) => `<div class="small" style="color:#ffb3bb">• ${esc(p)}</div>`).join('');
    const rows = sq.players.map((p) => `
      <li>
        <span>${esc(p.name)} <span class="muted small">${esc(p.role)}</span></span>
        <span class="price">${fmtLakh(p.price)}</span>
      </li>`).join('') || '<li class="muted">No players yet</li>';
    return `
      <div class="panel stack">
        <div class="row" style="justify-content:space-between">
          <div class="row">${team ? crest(team, 'sm') : ''}<div><div class="name" style="font-weight:800">${esc(sq.name)}</div>
          <div class="muted small">${team ? esc(team.name) : ''} ${label}</div></div></div>
          ${sq.ready ? '<span class="tag" style="color:var(--green)">Ready</span>' : ''}
        </div>
        <div class="grid g-2 small">
          <div>Players <b>${s.total}</b></div><div>Spent <b>${fmtLakh(sq.spent)}</b></div>
          <div>Batters <b>${s.batters}</b></div><div>Bowlers <b>${s.bowlers}</b></div>
          <div>All-rounders <b>${s.allrounders}</b></div><div>Wicketkeepers <b>${s.keepers}</b></div>
          <div>Remaining <b>${fmtLakh(sq.purse)}</b></div>
        </div>
        <div class="purse-bar"><div style="width:${pct}%"></div></div>
        <div>${problems}</div>
        <ul class="squad-list">${rows}</ul>
      </div>`;
  }

  function renderAuction() {
    const a = view.auction;
    const lot = a.lot;
    const seq = a.lastResult ? a.lastResult.seq : null;
    if (seq !== null && seq !== lastOverlaySeq) {
      lastOverlaySeq = seq;
      const r = a.lastResult;
      const html = r.type === 'SOLD'
        ? `<div class="stamp sold">SOLD<small>${esc(r.player.name)} → ${esc(r.winnerName)} · ${fmtLakh(r.price)}</small></div>`
        : `<div class="stamp unsold">UNSOLD<small>${esc(r.player.name)}</small></div>`;
      overlayStamp(html, 2400);
    }

    const profile = lot
      ? playerCard(lot.player, { cls: 'auction-card' })
      : `<div class="empty">${a.finished ? 'Auction complete.' : 'Next player loading…'}</div>`;

    let bidPanel;
    if (lot) {
      const step = bidStep(lot.highBid);
      const min = lot.minNext;
      const leader = lot.highSeat === null
        ? `<div class="muted">No bids yet · base ${fmtLakh(lot.player.basePrice)}</div>`
        : `<div>Highest bidder: <b>${esc(lot.highName)}</b>${lot.highSeat === view.you.seat ? ' <span class="tag">You</span>' : ''}</div>`;
      const quick = [0, 1, 2].map((i) => min + i * step);
      const bidBtns = a.myPurse <= 0 || !lot.youCanBid ? '' : quick.map((amt) =>
        `<button class="btn" data-act="bid" data-amount="${amt}" ${amt > a.myPurse ? 'disabled' : ''}>Bid ${fmtLakh(amt)}</button>`).join('');
      const passBtn = lot.youCanPass ? '<button class="btn ghost" data-act="pass">Pass</button>' : '';
      const passedInfo = lot.passed.map((p, i) => (p ? `<span class="passed-flag">${esc(view.you.seat === i ? 'You' : view.opponent.name)} passed</span>` : '')).join(' ');
      bidPanel = `
        <div class="muted small">CURRENT BID</div>
        <div class="bigbid">${lot.highBid ? fmtLakh(lot.highBid) : '—'}</div>
        ${leader}
        <div class="muted small" style="margin-top:14px">BIDDING CLOSES IN</div>
        <div class="timer" data-deadline="${lot.deadline}">--</div>
        ${passedInfo ? `<div style="margin-top:6px">${passedInfo}</div>` : ''}
        <div class="bid-buttons" style="margin-top:16px">${bidBtns}${passBtn}</div>
        ${lot.youCanBid ? '' : `<p class="muted small" style="margin-top:10px">${lot.highSeat === view.you.seat ? 'You lead this lot.' : 'You cannot bid on this lot.'}</p>`}`;
    } else {
      bidPanel = `<div class="empty">${a.finished ? 'Auction complete. Review your squads.' : 'Next lot starting…'}</div>`;
    }

    const myPct = Math.max(0, Math.min(100, (a.myPurse / a.startingPurse) * 100));
    const squads = view.squads.map((sq) => `
      <div class="panel stack" style="padding:16px">
        <div class="row" style="justify-content:space-between">
          <div class="row">${teamOf(sq.teamId) ? crest(teamOf(sq.teamId), 'sm') : ''}<b>${esc(sq.name)}</b>${sq.seat === view.you.seat ? '<span class="tag">You</span>' : ''}</div>
          <span class="small muted">${sq.players.length} players</span>
        </div>
        <div class="small">Remaining purse <b style="color:var(--gold)">${fmtLakh(sq.purse)}</b> of ${fmtLakh(a.startingPurse)}</div>
        <div class="purse-bar"><div style="width:${(sq.purse / a.startingPurse) * 100}%"></div></div>
        <ul class="squad-list">${sq.players.map((p) => `<li><span>${esc(p.name)} <span class="muted small">${esc(p.role)}</span></span><span class="price">${fmtLakh(p.price)}</span></li>`).join('') || '<li class="muted">No purchases yet</li>'}</ul>
      </div>`).join('');

    app.innerHTML = `
      <div class="row" style="justify-content:space-between;margin-bottom:14px">
        <div class="row"><span class="tag">Starting purse ${fmtLakh(a.startingPurse)}</span>
          <span class="tag">Sold ${a.soldCount}</span><span class="tag">Remaining players ${a.remainingPlayers}</span></div>
        <div class="row small">Your purse: <b style="color:var(--gold)">${fmtLakh(a.myPurse)}</b>
          <span class="muted">(${myPct.toFixed(0)}%)</span></div>
      </div>
      <div class="auction-grid">
        <div class="stack">
          <h3>Current player</h3>
          ${profile}
        </div>
        <div class="panel stack">
          <h3>Live bidding</h3>
          ${bidPanel}
        </div>
        <div class="stack">
          <h3>Squads</h3>
          ${squads}
        </div>
      </div>`;
    startCountdowns();
  }

  function renderSquad() {
    const sp = view.squadPhase;
    const mine = view.squads[view.you.seat];
    const theirs = view.squads[view.opponent ? view.opponent.seat : 1 - view.you.seat];
    app.innerHTML = `
      <div class="panel stack" style="margin-bottom:18px">
        <h2>Squad review</h2>
        <p class="muted small">Rules: ${sp.rules.min}–${sp.rules.max} players · at least ${sp.rules.minBatters} batters, ${sp.rules.minBowlers} bowlers, ${sp.rules.minWicketkeepers} wicketkeeper. Both squads are public.</p>
        <div class="row">
          <button class="btn big" style="width:auto" data-act="readySquad" ${mine.validation.valid && !sp.youReady ? '' : 'disabled'}>
            ${sp.youReady ? 'Waiting for opponent…' : 'Confirm squad & enter tournament'}</button>
          ${sp.canRestart ? '<button class="btn ghost" data-act="restartAuction">Restart auction (squad invalid)</button>' : ''}
          <span class="small muted">Opponent: ${sp.opponentReady ? 'Ready' : 'Reviewing'}</span>
        </div>
      </div>
      <div class="grid g-2">${squadPanel(mine, '(You)')}${squadPanel(theirs, '(Opponent)')}</div>`;
  }

  function renderScoreboard() {
    const m = view.match;
    const names = m.names;
    const progress = Array.from({ length: m.totalRounds }, (_, i) => {
      const cls = i < m.roundsPlayed ? 'done' : (i === m.roundsPlayed ? 'cur' : '');
      return `<span class="${cls}"></span>`;
    }).join('');
    return `
      <div class="panel">
        <div class="row" style="justify-content:space-between;margin-bottom:6px">
          <span class="tag">MATCH ${m.n} / ${view.tournament.totalMatches}</span>
          <span class="small muted">Round ${Math.min(m.roundsPlayed + (view.round.stage === 'revealed' ? 0 : 1), m.totalRounds)} of ${m.totalRounds} · ${m.roundsRemaining} remaining</span>
        </div>
        <div class="scoreboard">
          <div class="side"><div class="nm">${esc(names[0])}</div>${view.you.seat === 0 ? '<span class="tag">You</span>' : (view.opponent && view.opponent.seat === 0 ? '<span class="tag">Opponent</span>' : '')}</div>
          <div><div class="score">${m.scores[0]} – ${m.scores[1]}</div><div class="mid">ROUNDS WON</div></div>
          <div class="side"><div class="nm">${esc(names[1])}</div>${view.you.seat === 1 ? '<span class="tag">You</span>' : (view.opponent && view.opponent.seat === 1 ? '<span class="tag">Opponent</span>' : '')}</div>
        </div>
        <div class="progress">${progress}</div>
      </div>`;
  }

  function renderRound() {
    const r = view.round;
    const youSeat = view.you.seat;
    const oppStatusCls = r.opponentStatus === 'revealed' ? 'revealed' : (r.opponentStatus === 'locked' ? 'locked' : 'selecting');
    const oppStatusText = { selecting: 'Selecting', locked: 'Locked in', revealed: 'Revealed' }[r.opponentStatus];

    if (r.stage === 'selecting') {
      const card = r.myCard;
      const k = `${view.match.n}-${view.match.roundNo}`;
      if (!pick || pick.key !== k) pick = { key: k, category: null };
      const chosen = r.youLocked ? r.youChoice : pick.category;
      const options = card.options.map((o) => `
        <button class="opt ${chosen === o.key ? 'sel' : ''}" data-act="choose" data-cat="${o.key}" ${r.youLocked ? 'disabled' : ''}>
          <div class="l">${esc(o.group)}</div><div>${esc(o.label)}</div><div class="v">${fmtStat(o.key, o.value)}</div>
        </button>`).join('');
      const lockBtn = r.youLocked
        ? `<span class="status-pill locked">Locked: ${esc(LABELS[chosen])}</span>`
        : `<button class="btn orange" data-act="lock" ${chosen ? '' : 'disabled'}>Lock ${chosen ? esc(LABELS[chosen]) : 'selection'}</button>`;
      return `
        ${renderScoreboard()}
        <div class="grid g-2" style="margin-top:18px;align-items:start">
          <div class="stack">
            <h3>Your card</h3>
            ${playerCard(card, { cls: 'reveal-card' })}
          </div>
          <div class="panel stack">
            <h3>Choose one statistic</h3>
            <p class="muted small">Compared against your opponent's choice after both lock. Opponent's card and pick stay hidden until then.</p>
            <div class="opts" style="margin-top:0">${options}</div>
            <div class="row" style="margin-top:14px;justify-content:space-between">
              ${lockBtn}
              <span class="small muted">Auto-pick in <span data-deadline="${r.deadline}">--</span></span>
            </div>
            <div class="seat" style="margin-top:14px">
              <span class="status-pill ${oppStatusCls}">${oppStatusText}</span>
              <div><div class="name">${esc(view.opponent ? view.opponent.name : 'Opponent')}</div>
              <div class="muted small">${r.opponentStatus === 'selecting' ? 'Still choosing a statistic…' : 'Waiting for reveal…'}</div></div>
            </div>
          </div>
        </div>`;
    }

    // revealed
    const rev = r.reveal;
    const [a, b] = rev.entries;
    const side = (e) => `
      <div>
        <div class="muted small" style="text-align:center;margin-bottom:6px">${esc(e.name)} ${e.seat === youSeat ? '(You)' : ''}</div>
        ${playerCard(e.player, { winner: rev.winnerSeat === e.seat, highlightKey: e.category, showStats: true,
          extra: `<div class="row" style="justify-content:space-between;margin-top:10px">
                    <span class="tag" style="color:var(--gold)">${esc(e.label)}</span>
                    <b style="font-size:20px">${fmtStat(e.category, e.value)}</b></div>
                  <div class="small muted">Normalised score <b style="color:var(--text)">${e.score.toFixed(2)}</b>${e.auto ? ' · auto-picked' : ''}</div>`,
          cls: 'reveal-card' })}
      </div>`;
    const why = rev.winnerSeat === null
      ? `Equal normalised scores (${a.score.toFixed(2)} vs ${b.score.toFixed(2)}). No point awarded.`
      : `${esc(rev.winnerName)} wins the round: ${Math.max(a.score, b.score).toFixed(2)} beats ${Math.min(a.score, b.score).toFixed(2)} on normalised score.`;
    return `
      ${renderScoreboard()}
      <div class="panel" style="margin-top:18px">
        <h2 class="center">Round ${view.match.roundNo} reveal</h2>
        <div class="reveal-grid">${side(a)}<div class="vs">VS</div>${side(b)}</div>
        <p class="explain">${why}</p>
        <p class="center small muted">Next round in <span data-deadline="${r.revealAt}">--</span></p>
      </div>`;
  }

  function matchChip(m, idx) {
    const live = m.status === 'live' ? 'live' : '';
    const t = m.status === 'done'
      ? (m.winnerSeat === null ? 'Draw' : (m.winnerSeat === view.you.seat ? 'You won' : 'Opponent won'))
      : m.status === 'live' ? 'In progress' : 'Upcoming';
    return `<div class="mchip ${m.status} ${live}">
      <div class="t">MATCH ${m.n}</div>
      <div class="muted small">${m.status === 'done' ? `${m.scores[0]}–${m.scores[1]}` : `${m.roundsPlayed}/11 rounds`}</div>
      <div class="small">${t}</div></div>`;
  }

  function standingsTable() {
    const s = view.tournament.standings;
    const rows = s.ranking.map((seat, i) => {
      const r = s.rows[seat];
      const team = view.teams.find((t) => t.id === (seat === view.you.seat ? view.you.teamId : view.opponent && view.opponent.teamId));
      return `<tr>
        <td>${i + 1}. ${esc(r.name)} ${seat === view.you.seat ? '<span class="tag">You</span>' : ''} ${team ? `<span class="muted small">${esc(team.abbr)}</span>` : ''}</td>
        <td>${r.played}</td><td>${r.wins}</td><td>${r.draws}</td><td>${r.losses}</td><td>${r.roundWins}</td>
        <td class="pts">${r.points}</td></tr>`;
    }).join('');
    return `<table class="std">
      <thead><tr><th>Player</th><th>P</th><th>W</th><th>D</th><th>L</th><th>Rounds</th><th>Pts</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <p class="small muted" style="margin-top:8px">Win = 2 pts · Draw = 1 pt · Loss = 0. Tie-break: ${esc(s.tieBreakRule)}.</p>`;
  }

  function lastCompletedMatch() {
    const done = view.tournament.history.filter((m) => m.status === 'done');
    return done.length ? done[done.length - 1] : null;
  }

  function renderTournament() {
    const t = view.tournament;
    let main;
    if (view.round) {
      main = renderRound();
    } else {
      const last = lastCompletedMatch();
      const summary = last
        ? `<div class="panel center"><h2>Match ${last.n} result</h2>
            <div class="stamp draw" style="font-size:40px;animation:none">${last.winnerSeat === null ? 'DRAWN' : (last.winnerSeat === view.you.seat ? 'YOU WON' : 'OPPONENT WON')}</div>
            <p class="muted">Final rounds: ${last.scores[0]} – ${last.scores[1]}</p></div>`
        : '<div class="empty">Tournament starting…</div>';
      main = summary;
    }
    // Round history of the most recent match, for transparency.
    const hist = view.tournament.history.filter((m) => m.rounds.length).slice(-1)[0];
    const histHtml = hist ? hist.rounds.map((rd) => {
      const [a, b] = rd.entries;
      const w = rd.winnerSeat === null ? 'Draw' : (rd.winnerSeat === view.you.seat ? 'You' : 'Opponent');
      return `<div class="history-round"><span>R${rd.roundNo} · ${esc(a.label)} ${a.score.toFixed(0)} vs ${esc(b.label)} ${b.score.toFixed(0)}</span><b>${w}</b></div>`;
    }).join('') : '<div class="muted small">No rounds played yet.</div>';

    app.innerHTML = `
      ${main}
      <div class="grid g-2" style="margin-top:18px;align-items:start">
        <div class="panel">
          <h2>Standings</h2>
          ${standingsTable()}
        </div>
        <div class="panel">
          <h2>Schedule</h2>
          <div class="match-list">${t.matches.map((m, i) => matchChip(m, i)).join('')}</div>
          <h3 style="margin-top:18px">Latest match rounds</h3>
          ${histHtml}
        </div>
      </div>`;
    startCountdowns();
    maybeWinnerOverlay();
  }

  function maybeWinnerOverlay() {
    if (!view.round || view.round.stage !== 'revealed') return;
    const k = `${view.match.n}-${view.match.roundNo}`;
    if (k === lastWinnerKey) return;
    lastWinnerKey = k;
    const rev = view.round.reveal;
    const html = rev.winnerSeat === null
      ? '<div class="stamp draw">DRAW<small>No point this round</small></div>'
      : `<div class="stamp winner">${rev.winnerSeat === view.you.seat ? 'WINNER' : 'ROUND LOST'}<small>${esc(rev.winnerName)} +1 point</small></div>`;
    overlayStamp(html, 2200);
  }

  function renderChampion() {
    const c = view.champion;
    const youWon = c.seat === view.you.seat;
    const title = c.joint ? 'Joint champions!' : (youWon ? 'You are the champion!' : `${esc(c.name)} wins the tournament`);
    app.innerHTML = `
      ${confetti()}
      <section class="champ">
        <div class="crown">🏆</div>
        <div class="name">${c.joint ? 'SHARED TITLE' : esc(c.name || 'Draw')}</div>
        <p class="muted">${title}</p>
      </section>
      <div class="grid g-2" style="align-items:start">
        <div class="panel"><h2>Final standings</h2>${standingsTable()}</div>
        <div class="panel"><h2>Schedule</h2><div class="match-list">${view.tournament.matches.map(matchChip).join('')}</div></div>
      </div>`;
  }

  function startCountdowns() {
    tickCountdowns();
  }

  function tickCountdowns() {
    const now = Date.now() + offset;
    document.querySelectorAll('[data-deadline]').forEach((el) => {
      const left = Math.max(0, Math.ceil((Number(el.dataset.deadline) - now) / 1000));
      el.textContent = `${left}s`;
      el.classList.toggle('urgent', left <= 3);
    });
  }

  function render() {
    if (!session) {
      $('#room-chip').classList.add('hidden');
      return renderLanding();
    }
    const chip = $('#room-chip');
    chip.textContent = `ROOM ${session.code} · LEAVE`;
    chip.classList.remove('hidden');
    chip.onclick = () => {
      if (confirm('Leave this room? You can rejoin only with your original browser session.')) clearSession();
    };
    if (!view) {
      app.innerHTML = '<div class="skeleton"></div><p class="muted center" style="margin-top:14px">Connecting to room…</p>';
      return;
    }
    switch (view.phase) {
      case 'lobby': return renderLobby();
      case 'teams': return renderTeams();
      case 'auction': return renderAuction();
      case 'squad': return renderSquad();
      case 'tournament': return renderTournament();
      case 'champion': return renderChampion();
      default: app.innerHTML = '<p class="muted center">Unknown game phase.</p>';
    }
  }

  // ───────────────────────────────────────────────────────── events
  app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const kind = el.dataset.act;
    if (kind === 'start') act('start');
    else if (kind === 'pickTeam') act('pickTeam', { teamId: el.dataset.team });
    else if (kind === 'bid') act('bid', { amount: Number(el.dataset.amount) });
    else if (kind === 'pass') act('pass');
    else if (kind === 'readySquad') act('readySquad');
    else if (kind === 'restartAuction') act('restartAuction');
    else if (kind === 'choose') {
      pick = { key: `${view.match.n}-${view.match.roundNo}`, category: el.dataset.cat };
      render();
    } else if (kind === 'lock') {
      const chosen = pick && pick.category;
      if (chosen) act('lock', { category: chosen });
    }
  });

  setInterval(tickCountdowns, 200);

  // Boot: resume an existing session if one is stored (reconnection support).
  if (session) connect();
  else render();
})();
