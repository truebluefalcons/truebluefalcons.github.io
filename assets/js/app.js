(function () {
  'use strict';
  // Runs two pages: the public stats page (data-mode="public": leaderboards only) and the
  // admin page (data-mode="admin": quotas, opportunities and workload as well).
  const S = window.TBFStats;
  const MODE = document.body.dataset.mode === 'public' ? 'public' : 'admin';
  const ADMIN = MODE === 'admin';
  const BASE = document.body.dataset.base || '';
  const state = {
    tournament: 'all',
    calMonth: null, // 'YYYY-MM' shown in the match calendar
    showNone: false,
    workload: 'per',
    sort: ADMIN
      ? { batting: { key: 'balls', dir: -1 }, bowling: { key: 'balls', dir: -1 } }
      : { batting: { key: 'runs', dir: -1 }, bowling: { key: 'wkts', dir: -1 } },
  };
  let config, players, season, fixtures = [];

  // ---------------------------------------------------------------- helpers
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fullName = (p) => p.first + ' ' + p.last;
  const short = (p) => p.first.split(' ')[0] + ' ' + p.last;
  const fixed = (v, d) => (v == null || !isFinite(v) ? '–' : v.toFixed(d));
  const tierRank = (p) => (config.tiers[p.tier] ? config.tiers[p.tier].priority : 9);
  const badge = (p) => !ADMIN ? '' : '<span class="badge ' + p.tier + '">' + (p.tier === 'none' ? 'Per match' : p.tier) + '</span>';
  const tName = (id) => (config.tournaments.find((t) => t.id === id) || { short: id }).short;

  function store(k, v) { try { localStorage.setItem('tbf.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function recall(k, d) { try { const v = localStorage.getItem('tbf.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }

  async function load(path) {
    const r = await fetch(path, { cache: 'no-cache' });
    if (!r.ok) throw new Error(path + ': ' + r.status);
    return r.json();
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    try {
      [config, { players }, season] = await Promise.all([load(BASE + 'data/config.json'), load(BASE + 'data/players.json'), load(BASE + 'data/season.json')]);
      // Schedule is optional: a missing or broken data/fixtures.json just hides the upcoming games.
      fixtures = await load(BASE + 'data/fixtures.json').then((d) => d.fixtures || []).catch(() => []);
    } catch (e) {
      document.querySelector('main').innerHTML = '<div class="card empty"><strong>Could not load data</strong>' + esc(e.message) + '</div>';
      return;
    }
    if (config.logo) $('crest').src = BASE + config.logo;
    $('eyebrow').textContent = 'Season ' + config.season + ' · ' + config.tournaments.map((t) => t.name).join(' & ');
    if (ADMIN) {
      $('cap-full').textContent = config.tiers.full.cap;
      $('cap-half').textContent = config.tiers.half.cap;
      $('total-matches').textContent = config.totalMatches;
    }
    renderUpdated();

    state.showNone = recall('showNone', false);
    state.tournament = recall('tournament', 'all');
    if (state.tournament !== 'all' && !config.tournaments.some((t) => t.id === state.tournament)) state.tournament = 'all';
    if ($('show-none')) $('show-none').checked = state.showNone;

    const seg = $('tournament-filter');
    seg.innerHTML = [{ id: 'all', short: 'All' }].concat(config.tournaments).map((t) =>
      '<button type="button" data-t="' + esc(t.id) + '" title="' + esc(t.name || 'All tournaments') + '">' + esc(t.short) + '</button>').join('');
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      state.tournament = b.dataset.t;
      store('tournament', state.tournament);
      render();
    });
    if ($('show-none')) $('show-none').addEventListener('change', (e) => { state.showNone = e.target.checked; store('showNone', state.showNone); render(); });
    if ($('workload-mode')) $('workload-mode').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      state.workload = b.dataset.mode;
      [...$('workload-mode').children].forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      renderWorkload(S.aggregate(season, players, state.tournament));
    });
    spyOnSections();
    render();
  }

  function renderUpdated() {
    $('updated').textContent = season.generatedAt ? 'Updated ' + new Date(season.generatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'No matches yet';
  }

  // the admin page calls this after saving a match, so the new stats show at once
  window.TBFApp = {
    setData(next) {
      if (next.season) season = next.season;
      if (next.players) players = next.players;
      renderUpdated();
      render();
    },
    get data() { return { config, players, season }; },
  };

  function visible(L) {
    if (!ADMIN) return L.matches > 0;
    if (L.player.tier === 'none') return state.showNone && L.matches > 0;
    return true;
  }

  function render() {
    [...$('tournament-filter').children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.t === state.tournament)));
    const agg = S.aggregate(season, players, state.tournament);
    renderKpis(agg);
    if (ADMIN) {
      renderPlanner();
      renderQuota(agg);
    } else {
      renderLeaders(agg);
    }
    renderBatting(agg);
    renderBowling(agg);
    if (ADMIN) renderWorkload(agg);
    renderMatches(agg);
  }

  // ---------------------------------------------------------------- KPIs
  function renderKpis(agg) {
    const all = agg.allMatches.length;
    const per = config.tournaments.map((t) => ({ t, n: agg.allMatches.filter((m) => m.tournament === t.id).length }));
    let runs = 0, wkts = 0, balls = 0;
    agg.lines.forEach((L) => { runs += L.bat.runs; wkts += L.bowl.wickets; balls += L.bat.balls; });
    const wins = agg.matches.filter((m) => /won/i.test(m.result || '') && config.teamAliases.some((a) => (m.result || '').toLowerCase().includes(a.toLowerCase()))).length;
    const pct = Math.min(100, (all * 100) / config.totalMatches);
    const k = (v, l, extra) => '<div class="kpi"><div class="v num">' + v + '</div><div class="l">' + l + '</div>' + (extra || '') + '</div>';
    $('kpis').innerHTML =
      k(all + '<small> / ' + config.totalMatches + '</small>', 'Matches played', '<div class="meter"><i style="width:' + pct + '%"></i></div>') +
      per.map((x) => k(x.n, esc(x.t.name))).join('') +
      k(agg.matches.length ? wins + '<small> / ' + agg.matches.length + '</small>' : '–', 'Wins' + (state.tournament === 'all' ? '' : ' · ' + tName(state.tournament))) +
      k(runs, 'Runs off the bat') +
      k(wkts, 'Wickets');
  }

  // ---------------------------------------------------------------- leaders (public page)
  function renderLeaders(agg) {
    const L = [...agg.lines.values()].filter((x) => x.matches > 0);
    const top = (arr, f, tie) => arr.filter((x) => f(x) > 0).sort((a, b) => f(b) - f(a) || (tie ? tie(a, b) : 0)).slice(0, 3);
    const bowlKey = (x) => (x.bowl.best ? x.bowl.best.w * 1000 - x.bowl.best.r : 0);
    const boards = [
      { title: 'Most runs', icon: 'bat', rows: top(L, (x) => x.bat.runs, (a, b) => a.bat.balls - b.bat.balls), v: (x) => x.bat.runs, sub: (x) => x.bat.inns + ' inns · ' + x.bat.balls + ' balls · SR ' + fixed(x.bat.sr, 0) },
      { title: 'Most wickets', icon: 'ball', rows: top(L, (x) => x.bowl.wickets, (a, b) => (a.bowl.econ || 99) - (b.bowl.econ || 99)), v: (x) => x.bowl.wickets, sub: (x) => S.fmtOvers(x.bowl.balls, config.ballsPerOver) + ' ov · econ ' + fixed(x.bowl.econ, 2) },
      { title: 'Highest score', icon: 'star', rows: top(L, (x) => x.bat.hs + (x.bat.hsNotOut ? 0.5 : 0)), v: (x) => x.bat.hs + (x.bat.hsNotOut ? '*' : ''), sub: (x) => x.bat.fours + ' fours · ' + x.bat.sixes + ' sixes this season' },
      { title: 'Best bowling', icon: 'target', rows: top(L, bowlKey), v: (x) => x.bowl.best.w + '/' + x.bowl.best.r, sub: (x) => x.bowl.inns + ' matches bowled' },
    ];
    $('leaders').innerHTML = boards.map((b) => {
      if (!b.rows.length) return '<div class="card leader empty-leader"><h3>' + b.title + '</h3><p class="muted">No one yet</p></div>';
      const [first, ...rest] = b.rows;
      return '<div class="card leader"><h3>' + b.title + '</h3>' +
        '<div class="lead-top"><div><div class="lead-name">' + esc(fullName(first.player)) + '</div><div class="lead-sub">' + esc(b.sub(first)) + '</div></div>' +
        '<div class="lead-v num">' + b.v(first) + '</div></div>' +
        (rest.length ? '<ol class="lead-rest">' + rest.map((x) => '<li><span>' + esc(short(x.player)) + '</span><b class="num">' + b.v(x) + '</b></li>').join('') + '</ol>' : '') +
        '</div>';
    }).join('');
  }

  // ---------------------------------------------------------------- quota
  function renderPlanner() {
    const P = S.plan(season, players, config);
    const pc = (n) => ((n * 100) / P.totalSlots).toFixed(2) + '%';
    const free = Math.max(0, P.totalSlots - P.slotsUsed);
    let call;
    if (P.played === 0) {
      call = P.entitlement > P.totalSlots
        ? '<div class="callout warn"><strong>Over-subscribed by ' + (P.entitlement - P.totalSlots) + ' slots</strong>Member caps add up to ' + P.entitlement + ' places, but ' + P.total + ' matches × ' + P.per + ' players is only ' + P.totalSlots + '. Rotate early so nobody falls behind.</div>'
        : '<div class="callout ok"><strong>Room for everyone</strong>Member caps (' + P.entitlement + ') fit inside the ' + P.totalSlots + ' places available.</div>';
    } else if (P.squeeze > 0) {
      call = '<div class="callout warn"><strong>' + P.squeeze + ' places short</strong>Members still need ' + P.remainingEntitlement + ' games between them, but only ' + P.remainingSlots + ' places are left in the remaining ' + P.remainingMatches + ' matches. Pick from players marked “Due a game” first.</div>';
    } else {
      call = '<div class="callout ok"><strong>' + (-P.squeeze) + ' spare places</strong>Members need ' + P.remainingEntitlement + ' more games and there are ' + P.remainingSlots + ' places left, which leaves room for per-match players.</div>';
    }
    $('planner').innerHTML =
      '<div class="card planner"><div><h3>Season places · ' + P.totalSlots + '</h3>' +
      '<div class="stack" role="img" aria-label="' + P.slotsMembers + ' member places used, ' + P.slotsGuests + ' per-match places used, ' + free + ' places left">' +
      '<i style="width:' + pc(P.slotsMembers) + ';background:var(--blue-600)"></i><i style="width:' + pc(P.slotsGuests) + ';background:var(--blue-300)"></i></div>' +
      '<div class="legend"><span><i class="dot" style="background:var(--blue-600)"></i>Members <b>' + P.slotsMembers + '</b></span>' +
      '<span><i class="dot" style="background:var(--blue-300)"></i>Per match &amp; guests <b>' + P.slotsGuests + '</b></span>' +
      '<span><i class="dot" style="background:var(--surface-2);border:1px solid var(--border)"></i>Still to play <b>' + free + '</b></span>' +
      '<span>Member caps <b>' + P.entitlement + '</b></span></div></div><div>' + call + '</div></div>';
  }

  function renderQuota(agg) {
    const teamPlayed = agg.allMatches.length;
    const rows = [...agg.lines.values()]
      .filter((L) => L.player.tier !== 'none' || (state.showNone && L.matchesAll > 0))
      .map((L) => ({ L, cap: config.tiers[L.player.tier].cap, pace: S.pace(L.matchesAll, config.tiers[L.player.tier].cap, teamPlayed, config.totalMatches) }))
      .sort((a, b) => tierRank(a.L.player) - tierRank(b.L.player) ||
        (a.pace && b.pace ? (a.L.matchesAll - a.pace.expected) - (b.L.matchesAll - b.pace.expected) : 0) ||
        b.L.matchesAll - a.L.matchesAll || fullName(a.L.player).localeCompare(fullName(b.L.player)));
    $('quota').innerHTML = rows.map(({ L, cap, pace }) => {
      const p = L.player;
      const pct = cap ? Math.min(100, (L.matchesAll * 100) / cap) : 0;
      const tick = pace ? '<span class="pace" style="left:calc(' + Math.min(100, (pace.expected * 100) / cap) + '% - 1px)" title="Expected by now: ' + pace.expected.toFixed(1) + '"></span>' : '';
      return '<div class="card qcard">' +
        '<div class="top"><span class="name" title="' + esc(fullName(p)) + '">' + esc(fullName(p)) + '</span>' + badge(p) + '</div>' +
        '<div class="count"><span class="big num">' + L.matchesAll + '</span><span class="of">' + (cap ? 'of ' + cap + ' matches' : 'matches (no cap)') + '</span></div>' +
        (cap ? '<div class="qbar"><i style="width:' + pct + '%"></i>' + tick + '</div>' : '') +
        '<div class="foot">' + (pace ? '<span class="status ' + pace.status + '">' + pace.label + '</span><span>' + pace.remaining + ' left</span>' : '<span>Pays per match</span><span></span>') + '</div>' +
        '<div class="mini"><span>Faced <b>' + L.bat.balls + '</b></span><span>Bowled <b>' + L.bowl.balls + '</b></span><span>Batted <b>' + L.bat.inns + '×</b></span></div>' +
        '</div>';
    }).join('');
  }

  // ---------------------------------------------------------------- tables
  function table(kind, cols, rows) {
    const sort = state.sort[kind];
    const col = cols.find((c) => c.key === sort.key) || cols[0];
    rows.sort((a, b) => {
      const va = col.val(a), vb = col.val(b);
      if (typeof va === 'string') return sort.dir * va.localeCompare(vb);
      return sort.dir * ((va == null ? -Infinity : va) - (vb == null ? -Infinity : vb)) || tierRank(a.player) - tierRank(b.player);
    });
    if (!rows.length) return '<div class="empty"><strong>No players to show</strong>' + (ADMIN ? 'Turn on per-match players or add a match.' : 'Stats appear here once the first match is added.') + '</div>';
    const head = '<thead><tr>' + cols.map((c) =>
      '<th scope="col" data-key="' + c.key + '"' + (c.key === sort.key ? ' aria-sort="' + (sort.dir < 0 ? 'descending' : 'ascending') + '"' : '') + ' title="' + esc(c.title || c.label) + '">' + c.label + '</th>').join('') + '</tr></thead>';
    const body = '<tbody>' + rows.map((r) => '<tr>' + cols.map((c) => {
      const html = c.render ? c.render(r) : c.val(r);
      const isZero = html === 0 || html === '0' || html === '–';
      return c.key === 'name' ? '<td class="player">' + html + '</td>' : '<td class="num' + (c.key === sort.key ? ' hl' : '') + (isZero ? ' zero' : '') + '">' + html + '</td>';
    }).join('') + '</tr>').join('') + '</tbody>';
    return '<table class="stats">' + head + body + '</table>';
  }

  function bindSort(el, kind, rerender) {
    el.onclick = (e) => {
      const th = e.target.closest('th[data-key]');
      if (!th) return;
      const s = state.sort[kind];
      if (s.key === th.dataset.key) s.dir *= -1;
      else { s.key = th.dataset.key; s.dir = th.dataset.key === 'name' ? 1 : -1; }
      rerender();
    };
  }

  const nameCol = { key: 'name', label: 'Player', val: (L) => fullName(L.player), render: (L) => '<span class="pc">' + esc(short(L.player)) + ' ' + badge(L.player) + '</span>' };
  const mCol = { key: 'm', label: 'M', title: 'Matches played', val: (L) => L.matches };

  function renderBatting(agg) {
    const rows = [...agg.lines.values()].filter(visible);
    const maxBalls = Math.max(1, ...rows.map((L) => L.bat.balls));
    const maxRuns = Math.max(1, ...rows.map((L) => L.bat.runs));
    const cols = !ADMIN ? [
      nameCol, mCol,
      { key: 'inns', label: 'Inns', title: 'Innings batted', val: (L) => L.bat.inns },
      { key: 'runs', label: 'Runs', val: (L) => L.bat.runs, render: (L) => '<span class="cellbar"><i style="width:' + Math.round((L.bat.runs * 60) / maxRuns) + 'px"></i>' + L.bat.runs + '</span>' },
      { key: 'balls', label: 'Balls', title: 'Balls faced', val: (L) => L.bat.balls },
      { key: 'hs', label: 'HS', title: 'Highest score', val: (L) => L.bat.hs, render: (L) => (L.bat.inns ? L.bat.hs + (L.bat.hsNotOut ? '*' : '') : '–') },
      { key: 'avg', label: 'Avg', val: (L) => L.bat.avg, render: (L) => fixed(L.bat.avg, 1) },
      { key: 'sr', label: 'SR', title: 'Strike rate', val: (L) => L.bat.sr, render: (L) => fixed(L.bat.sr, 1) },
      { key: 'b4', label: '4s', val: (L) => L.bat.fours },
      { key: 'b6', label: '6s', val: (L) => L.bat.sixes },
      { key: 'f50', label: '50s', val: (L) => L.bat.fifties },
    ] : [
      nameCol, mCol,
      { key: 'inns', label: 'Opp', title: 'Batting opportunities (innings batted)', val: (L) => L.bat.inns },
      { key: 'opp', label: 'Opp %', title: 'Batted in this % of matches played', val: (L) => L.bat.oppPct, render: (L) => (L.bat.oppPct == null ? '–' : Math.round(L.bat.oppPct) + '%') },
      { key: 'runs', label: 'Runs', val: (L) => L.bat.runs },
      { key: 'balls', label: 'Balls', title: 'Balls faced', val: (L) => L.bat.balls, render: (L) => '<span class="cellbar"><i style="width:' + Math.round((L.bat.balls * 60) / maxBalls) + 'px"></i>' + L.bat.balls + '</span>' },
      { key: 'bpm', label: 'Balls/M', title: 'Balls faced per match played', val: (L) => L.bat.ballsPerMatch, render: (L) => fixed(L.bat.ballsPerMatch, 1) },
      { key: 'sr', label: 'SR', title: 'Strike rate', val: (L) => L.bat.sr, render: (L) => fixed(L.bat.sr, 1) },
      { key: 'avg', label: 'Avg', val: (L) => L.bat.avg, render: (L) => fixed(L.bat.avg, 1) },
      { key: 'hs', label: 'HS', title: 'Highest score', val: (L) => L.bat.hs, render: (L) => (L.bat.inns ? L.bat.hs + (L.bat.hsNotOut ? '*' : '') : '–') },
      { key: 'no', label: 'NO', title: 'Not outs', val: (L) => L.bat.notOuts },
      { key: 'b4', label: '4s', val: (L) => L.bat.fours },
      { key: 'b6', label: '6s', val: (L) => L.bat.sixes },
      { key: 'pos', label: 'Avg pos', title: 'Average batting position', val: (L) => L.bat.avgPos, render: (L) => fixed(L.bat.avgPos, 1) },
    ];
    const el = $('batting-table');
    el.innerHTML = table('batting', cols, rows);
    bindSort(el, 'batting', () => renderBatting(agg));
  }

  function renderBowling(agg) {
    const bpo = config.ballsPerOver;
    const rows = [...agg.lines.values()].filter(visible);
    const maxBalls = Math.max(1, ...rows.map((L) => L.bowl.balls));
    const maxWkts = Math.max(1, ...rows.map((L) => L.bowl.wickets));
    const cols = !ADMIN ? [
      nameCol, mCol,
      { key: 'overs', label: 'Overs', val: (L) => L.bowl.balls, render: (L) => (L.bowl.balls ? S.fmtOvers(L.bowl.balls, bpo) : '–') },
      { key: 'wkts', label: 'Wkts', val: (L) => L.bowl.wickets, render: (L) => '<span class="cellbar bowl"><i style="width:' + Math.round((L.bowl.wickets * 60) / maxWkts) + 'px"></i>' + L.bowl.wickets + '</span>' },
      { key: 'runs', label: 'Runs', title: 'Runs conceded', val: (L) => L.bowl.runs },
      { key: 'econ', label: 'Econ', val: (L) => (L.bowl.econ == null ? null : -L.bowl.econ), render: (L) => fixed(L.bowl.econ, 2), title: 'Economy (sorts best first)' },
      { key: 'avg', label: 'Avg', val: (L) => (L.bowl.avg == null ? null : -L.bowl.avg), render: (L) => fixed(L.bowl.avg, 1), title: 'Bowling average (sorts best first)' },
      { key: 'best', label: 'Best', val: (L) => (L.bowl.best ? L.bowl.best.w * 1000 - L.bowl.best.r : null), render: (L) => (L.bowl.best ? L.bowl.best.w + '/' + L.bowl.best.r : '–') },
      { key: 'mdn', label: 'Mdns', title: 'Maidens', val: (L) => L.bowl.maidens },
    ] : [
      nameCol, mCol,
      { key: 'inns', label: 'Opp', title: 'Bowling opportunities (matches bowled in)', val: (L) => L.bowl.inns },
      { key: 'opp', label: 'Opp %', title: 'Bowled in this % of matches played', val: (L) => L.bowl.oppPct, render: (L) => (L.bowl.oppPct == null ? '–' : Math.round(L.bowl.oppPct) + '%') },
      { key: 'overs', label: 'Overs', val: (L) => L.bowl.balls, render: (L) => (L.bowl.balls ? S.fmtOvers(L.bowl.balls, bpo) : '–') },
      { key: 'balls', label: 'Balls', title: 'Legal balls bowled', val: (L) => L.bowl.balls, render: (L) => '<span class="cellbar bowl"><i style="width:' + Math.round((L.bowl.balls * 60) / maxBalls) + 'px"></i>' + L.bowl.balls + '</span>' },
      { key: 'bpm', label: 'Balls/M', title: 'Balls bowled per match played', val: (L) => L.bowl.ballsPerMatch, render: (L) => fixed(L.bowl.ballsPerMatch, 1) },
      { key: 'wkts', label: 'Wkts', val: (L) => L.bowl.wickets },
      { key: 'runs', label: 'Runs', title: 'Runs conceded', val: (L) => L.bowl.runs },
      { key: 'econ', label: 'Econ', val: (L) => (L.bowl.econ == null ? null : -L.bowl.econ), render: (L) => fixed(L.bowl.econ, 2), title: 'Economy (sorts best first)' },
      { key: 'avg', label: 'Avg', val: (L) => (L.bowl.avg == null ? null : -L.bowl.avg), render: (L) => fixed(L.bowl.avg, 1), title: 'Bowling average (sorts best first)' },
      { key: 'best', label: 'Best', val: (L) => (L.bowl.best ? L.bowl.best.w * 1000 - L.bowl.best.r : null), render: (L) => (L.bowl.best ? L.bowl.best.w + '/' + L.bowl.best.r : '–') },
      { key: 'extras', label: 'Wd/Nb', title: 'Wides / no-balls', val: (L) => L.bowl.wides + L.bowl.noballs, render: (L) => L.bowl.wides + '/' + L.bowl.noballs },
    ];
    const el = $('bowling-table');
    el.innerHTML = table('bowling', cols, rows);
    bindSort(el, 'bowling', () => renderBowling(agg));
  }

  // ---------------------------------------------------------------- workload
  function renderWorkload(agg) {
    const per = state.workload === 'per';
    const rows = [...agg.lines.values()].filter((L) => visible(L) && L.matches > 0)
      .map((L) => ({ L, bat: per ? L.bat.ballsPerMatch : L.bat.balls, bowl: per ? L.bowl.ballsPerMatch : L.bowl.balls }))
      .sort((a, b) => (b.bat + b.bowl) - (a.bat + a.bowl));
    if (!rows.length) {
      $('workload-chart').innerHTML = '<div class="empty"><strong>No cricket yet</strong>Once a match is parsed you will see who is getting overs and who is getting time at the crease.</div>';
      return;
    }
    const max = Math.max(1, ...rows.map((r) => Math.max(r.bat, r.bowl)));
    const n = (v) => (per ? v.toFixed(1) : String(v));
    const avgBat = rows.reduce((s, r) => s + r.bat, 0) / rows.length;
    const avgBowl = rows.reduce((s, r) => s + r.bowl, 0) / rows.length;
    $('workload-chart').innerHTML =
      '<div class="wl-head"><span class="l">◂ Balls faced</span><span style="text-align:center">Player</span><span>Balls bowled ▸</span></div>' +
      rows.map((r) =>
        '<div class="wl-row">' +
        '<div class="wl-side l"><i style="width:' + (r.bat * 100) / max + '%"></i><span>' + n(r.bat) + '</span></div>' +
        '<div class="who">' + esc(short(r.L.player)) + '<small>' + r.L.matches + ' M · ' + (r.L.player.tier === 'none' ? 'per match' : r.L.player.tier) + '</small></div>' +
        '<div class="wl-side r"><i style="width:' + (r.bowl * 100) / max + '%"></i><span>' + n(r.bowl) + '</span></div>' +
        '</div>').join('') +
      '<p class="wl-note">Squad average: ' + n(per ? avgBat : Math.round(avgBat)) + ' balls faced and ' + n(per ? avgBowl : Math.round(avgBowl)) + ' balls bowled ' + (per ? 'per match' : 'per player') + '.</p>';
  }

  // ---------------------------------------------------------------- matches
  // Optional per-match recording ("video" in data/matches/<id>.json). Only https Twitch links are shown.
  function videoUrl(v) {
    try { const u = new URL(String(v || '')); return u.protocol === 'https:' && /(^|\.)twitch\.tv$/.test(u.hostname) ? u.href : null; }
    catch { return null; }
  }

  // One match boiled down for display, shared by the header strip and the match cards.
  function summarize(m) {
    const byId = new Map(players.map((p) => [p.id, p]));
    const who = (r) => { const p = byId.get(r.playerId); return esc(p ? short(p) : r.name); };
    const aliases = config.teamAliases.map((a) => a.toLowerCase());
    const ours = m.players.filter((r) => r.playerId || r.name);
    const topBat = ours.filter((r) => r.bat).sort((a, b) => b.bat.runs - a.bat.runs || a.bat.balls - b.bat.balls)[0];
    const topBowl = ours.filter((r) => r.bowl && r.bowl.balls).sort((a, b) => b.bowl.wickets - a.bowl.wickets || a.bowl.runs - b.bowl.runs)[0];
    const res = m.result || '';
    const won = /won|beat/i.test(res) && aliases.some((a) => res.toLowerCase().includes(a));
    const lost = /won|beat/i.test(res) && !won;
    const d = m.date ? new Date(m.date + 'T12:00:00') : null;
    return {
      res, won, lost,
      outcome: won ? 'W' : lost ? 'L' : res ? '–' : '?',
      cls: won ? 'win' : lost ? 'loss' : '',
      date: d ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : 'Date unknown',
      dateShort: d ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '?',
      bat: topBat ? who(topBat) + ' · <b class="num">' + topBat.bat.runs + (topBat.bat.notOut ? '*' : '') + '</b> (' + topBat.bat.balls + ')' : '–',
      bowl: topBowl ? who(topBowl) + ' · <b class="num">' + topBowl.bowl.wickets + '/' + topBowl.bowl.runs + '</b> (' + esc(topBowl.bowl.overs) + ')' : '–',
      count: new Set(ours.map((r) => r.playerId || r.name)).size,
      video: videoUrl(m.video),
    };
  }

  const matchAnchor = (m) => 'm-' + String(m.id).replace(/[^\w-]/g, '');
  const scorecardLink = (m) => '<a href="' + esc(m.scorecardUrl) + '" target="_blank" rel="noopener">Scorecard ↗</a>';
  const watchLink = (x, label) => x.video ? '<a class="video" href="' + esc(x.video) + '" target="_blank" rel="noopener">' + label + '</a>' : '';

  // Scheduled games that have not started yet (plus a 4 hour grace), soonest first, for the selected tournament.
  function upcoming() {
    const now = Date.now();
    const ours = (t) => config.teamAliases.some((a) => a.toLowerCase() === String(t || '').toLowerCase());
    return fixtures
      .filter((f) => f.date && (state.tournament === 'all' || f.tournament === state.tournament))
      .map((f) => ({ ...f, at: new Date(f.date + 'T' + (f.time || '12:00')), opponent: ours(f.teamOne) ? f.teamTwo : f.teamOne }))
      .filter((f) => !isNaN(f.at) && f.at.getTime() + 4 * 3600e3 > now)
      .sort((a, b) => a.at - b.at);
  }
  const fxDay = (f) => f.at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(f.at.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
  const fxTime = (f) => f.time ? (f.timeLabel ? f.timeLabel + ' ' : '') + f.at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';

  // Last five results, oldest to newest, and the current run of wins or losses.
  function formLine(list) {
    const res = list.map((m) => summarize(m)).filter((x) => x.won || x.lost);
    if (res.length < 2) return '';
    const five = res.slice(0, 5).reverse();
    let run = 0;
    while (run < res.length && res[run].won === res[0].won) run++;
    const word = res[0].won ? (run === 1 ? 'win' : 'wins') : (run === 1 ? 'loss' : 'losses');
    const streak = run === 1 ? (res[0].won ? 'Won the last game' : 'Lost the last game') : run + ' ' + word + ' in a row';
    return '<div class="fx-form"><small>Form</small><span class="fx-form-chips">' +
      five.map((x, i) => '<span class="fx-out xs ' + x.cls + (i === five.length - 1 ? ' last' : '') + '">' + x.outcome + '</span>').join('') +
      '</span><span class="fx-streak">' + esc(streak) + '</span></div>';
  }

  // Header: in time order, the last result (left) and the next game (right). Everything else is in the calendar.
  function renderStrip(agg) {
    const el = $('fixtures');
    if (!el) return;
    const list = agg.matches.slice().reverse();
    const coming = upcoming();
    const [next, after] = coming;
    if (!list.length && !next) { el.innerHTML = ''; el.hidden = true; return; }
    el.hidden = false;
    el.classList.toggle('solo', !list.length || !next);
    let html = '';
    if (list.length) {
      const latest = list[0];
      const x = summarize(latest);
      html +=
        '<article class="fx-latest">' +
          '<div class="fx-top"><span class="fx-kicker">Last result</span><span>' + esc(x.date) + '</span><span class="tbadge ' + esc(latest.tournament) + '">' + esc(tName(latest.tournament)) + '</span></div>' +
          '<div class="fx-vs"><span class="fx-out ' + x.cls + '">' + x.outcome + '</span><span><small>vs</small> ' + esc(latest.opponent || 'Opponent') + '</span></div>' +
          (x.res ? '<div class="fx-res ' + x.cls + '">' + esc(x.res) + '</div>' : '') +
          formLine(list) +
          '<div class="fx-perf"><div><small>Top bat</small>' + x.bat + '</div><div><small>Top bowl</small>' + x.bowl + '</div></div>' +
          '<div class="fx-links">' + watchLink(x, '▶ Watch on Twitch') + scorecardLink(latest) + '<a href="#matches">All matches ↓</a></div>' +
        '</article>';
    }
    if (next) {
      const dayNum = next.at.getDate();
      const mon = next.at.toLocaleDateString(undefined, { month: 'short' });
      const wk = next.at.toLocaleDateString(undefined, { weekday: 'long' });
      html +=
        '<article class="fx-upnext">' +
          '<div class="fx-top"><span class="fx-kicker">Next match</span><span class="tbadge ' + esc(next.tournament) + '">' + esc(tName(next.tournament)) + '</span></div>' +
          '<div class="fx-date"><span class="fx-day">' + dayNum + '</span><span class="fx-mon">' + esc(mon) + '<small>' + esc(wk) + '</small></span></div>' +
          '<div class="fx-vs sm"><span><small>vs</small> ' + esc(next.opponent || 'TBC') + '</span></div>' +
          '<div class="fx-when">' + esc([fxTime(next), next.ground].filter(Boolean).join(' · ')) + '</div>' +
          (after ? '<div class="fx-after">Then ' + esc(fxDay(after)) + ' vs ' + esc(after.opponent || 'TBC') + ' (' + esc(tName(after.tournament)) + ')</div>' : '') +
          '<div class="fx-links"><a href="#calendar">Full calendar ↓</a></div>' +
        '</article>';
    }
    el.innerHTML = html;
  }

  // ---------------------------------------------------------------- calendar
  // One month at a time: played games (W/L, linking to their card) and scheduled ones, with the
  // month's games listed under the grid so it still reads well on a phone.
  function calendarEvents(agg) {
    const played = agg.matches.map((m) => {
      const x = summarize(m);
      return { kind: 'played', date: m.date, tournament: m.tournament, opponent: m.opponent, x, anchor: '#' + matchAnchor(m), m };
    }).filter((e) => e.date);
    const seen = new Set(played.map((e) => e.date + '|' + e.tournament));
    const ours = (t) => config.teamAliases.some((a) => a.toLowerCase() === String(t || '').toLowerCase());
    const now = Date.now();
    const sched = fixtures
      .filter((f) => f.date && (state.tournament === 'all' || f.tournament === state.tournament) && !seen.has(f.date + '|' + f.tournament))
      .map((f) => {
        const at = new Date(f.date + 'T' + (f.time || '12:00'));
        return { ...f, at, kind: at.getTime() + 4 * 3600e3 > now ? 'upcoming' : 'pending', opponent: ours(f.teamOne) ? f.teamTwo : f.teamOne };
      });
    return played.concat(sched).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  }

  function renderCalendar(agg) {
    const el = $('calendar');
    if (!el) return;
    const events = calendarEvents(agg);
    if (!events.length) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    events.forEach((e, i) => { e.id = 'cal-' + e.date + '-' + i; });
    const months = [...new Set(events.map((e) => e.date.slice(0, 7)))].sort();
    const first = months[0], last = months[months.length - 1];
    if (!state.calMonth || state.calMonth < first || state.calMonth > last) {
      const next = events.find((e) => e.kind === 'upcoming');
      state.calMonth = (next || events[events.length - 1]).date.slice(0, 7);
    }
    const [y, mo] = state.calMonth.split('-').map(Number);
    const inMonth = events.filter((e) => e.date.slice(0, 7) === state.calMonth);
    const byDay = new Map();
    inMonth.forEach((e) => { const d = Number(e.date.slice(8, 10)); byDay.set(d, (byDay.get(d) || []).concat(e)); });
    const offset = new Date(y, mo - 1, 1).getDay();
    const days = new Date(y, mo, 0).getDate();
    const t = new Date();
    const todayKey = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
    const label = new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const dow = [...Array(7)].map((_, i) => new Date(2026, 10, 1 + i).toLocaleDateString(undefined, { weekday: 'short' }));

    const chip = (e) => {
      const cls = 'cal-chip t-' + esc(e.tournament) + ' ' + e.kind + (e.kind === 'played' ? ' ' + e.x.cls : '');
      const tag = e.kind === 'played' ? e.x.outcome : e.kind === 'pending' ? '?' : esc(tName(e.tournament));
      const href = e.kind === 'played' ? e.anchor : '#' + e.id;
      const title = (e.kind === 'played' ? e.x.res : (fxTime(e) ? fxTime(e) + ' · ' : '') + (e.ground || '')) ;
      return '<a class="' + cls + '" href="' + href + '" title="' + esc('vs ' + (e.opponent || 'TBC') + (title ? ' · ' + title : '')) + '"><b>' + tag + '</b><span>' + esc(e.opponent || 'TBC') + '</span></a>';
    };
    let cells = '';
    for (let i = 0; i < offset; i++) cells += '<div class="cal-day blank" aria-hidden="true"></div>';
    for (let d = 1; d <= days; d++) {
      const key = state.calMonth + '-' + String(d).padStart(2, '0');
      const evs = byDay.get(d) || [];
      cells += '<div class="cal-day' + (evs.length ? ' has' : '') + (key === todayKey ? ' today' : '') + (key < todayKey ? ' past' : '') + '">' +
        '<span class="cal-num">' + d + '</span>' + evs.map(chip).join('') + '</div>';
    }
    const tail = (7 - ((offset + days) % 7)) % 7;
    for (let i = 0; i < tail; i++) cells += '<div class="cal-day blank" aria-hidden="true"></div>';

    const row = (e) => {
      const day = new Date(e.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      return '<li class="card up-row cal-row ' + e.kind + '" id="' + e.id + '">' +
        '<span class="up-when"><b>' + esc(day) + '</b><small>' + (e.kind === 'pending' ? 'Result to come' : esc(fxTime(e))) + '</small></span>' +
        '<span class="up-vs"><small>vs</small> ' + esc(e.opponent || 'TBC') + '</span>' +
        '<span class="up-meta">' + esc([e.ground, e.division].filter(Boolean).join(' · ')) + '</span>' +
        '<span class="tbadge ' + esc(e.tournament) + '">' + esc(tName(e.tournament)) + '</span></li>';
    };
    const left = events.filter((e) => e.kind === 'upcoming').length;
    // Played games already have result cards below; the list only adds the games still to come.
    const toPlay = inMonth.filter((e) => e.kind !== 'played');

    el.innerHTML =
      '<div class="card cal-card">' +
        '<div class="cal-head">' +
          '<button type="button" class="cal-nav" data-step="-1" aria-label="Previous month"' + (state.calMonth <= first ? ' hidden' : '') + '>‹</button>' +
          '<h3 aria-live="polite">' + esc(label) + '</h3>' +
          '<button type="button" class="cal-nav" data-step="1" aria-label="Next month"' + (state.calMonth >= last ? ' hidden' : '') + '>›</button>' +
          '<span class="cal-sum">' + left + ' to play</span>' +
        '</div>' +
        '<div class="cal-grid" role="grid">' + dow.map((d) => '<div class="cal-dow">' + esc(d) + '</div>').join('') + cells + '</div>' +
        '<p class="cal-legend"><span class="cal-chip played win"><b>W</b></span> won <span class="cal-chip played loss"><b>L</b></span> lost <span class="cal-chip upcoming t-mcl"><b>MCL</b></span><span class="cal-chip upcoming t-lakeshore"><b>LCL</b></span> to play</p>' +
      '</div>' +
      (toPlay.length
        ? '<h4 class="cal-sub">Still to play in ' + esc(new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: 'long' })) + '</h4><ol class="up-list cal-list">' + toPlay.map(row).join('') + '</ol>'
        : !inMonth.length ? '<p class="muted cal-none">No games this month.</p>' : '') +
      '<h3 class="cal-results">Results</h3>';

    if (!el.dataset.wired) {
      el.dataset.wired = '1';
      el.addEventListener('click', (ev) => {
        const b = ev.target.closest('.cal-nav');
        if (!b) return;
        const [yy, mm] = state.calMonth.split('-').map(Number);
        const d = new Date(yy, mm - 1 + Number(b.dataset.step), 1);
        state.calMonth = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        renderCalendar(S.aggregate(season, players, state.tournament));
      });
    }
  }

  function renderMatches(agg) {
    renderStrip(agg);
    renderCalendar(agg);
    const list = agg.matches.slice().reverse();
    if (!list.length) {
      $('match-list').innerHTML = '<div class="card empty" style="grid-column:1/-1"><strong>No matches yet</strong>' + (ADMIN ? 'Add the first one with the form above.' : 'Matches appear here as they are added.') + '</div>';
      return;
    }
    $('match-list').innerHTML = list.map((m) => {
      const x = summarize(m);
      return '<article class="card mcard" id="' + matchAnchor(m) + '">' +
        '<div class="row1"><span>' + esc(x.date) + '</span><span class="tbadge ' + esc(m.tournament) + '">' + esc(tName(m.tournament)) + '</span></div>' +
        '<div class="vs"><span>vs</span> ' + esc(m.opponent || 'Opponent') + '</div>' +
        (x.res ? '<div class="res ' + x.cls + '">' + esc(x.res) + '</div>' : '') +
        '<div class="perf">' +
        '<div><small>Top bat</small>' + x.bat + '</div>' +
        '<div><small>Top bowl</small>' + x.bowl + '</div>' +
        '</div>' +
        '<div class="links"><span class="muted">' + x.count + ' players</span>' + scorecardLink(m) + watchLink(x, '▶ Watch on Twitch') + '</div>' +
        '</article>';
    }).join('');
  }

  // ---------------------------------------------------------------- nav highlight
  function spyOnSections() {
    const links = [...document.querySelectorAll('.sections a')];
    if (!links.length || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + en.target.id));
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    document.querySelectorAll('main section').forEach((s) => io.observe(s));
  }

  boot();
})();
