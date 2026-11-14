// Frontend: fetches one JSON document from /api/dashboard and renders it.
// All text goes in through textContent or text nodes, never innerHTML, because
// repository descriptions and bios are written by other people.

const $ = (sel, root = document) => root.querySelector(sel);
const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------- tiny DOM helpers ----------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs ?? {})) el.setAttribute(key, value);
  for (const kid of kids) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

const ICONS = {
  star: [['path', { d: 'M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1L3.2 9.6l6.1-.8L12 3.2z' }]],
  fork: [
    ['circle', { cx: 6, cy: 5, r: 2.2 }],
    ['circle', { cx: 18, cy: 5, r: 2.2 }],
    ['circle', { cx: 12, cy: 19, r: 2.2 }],
    ['path', { d: 'M6 7.2v1.3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7.2M12 11.5v5.3' }],
  ],
  pin: [['path', { d: 'M9 3.5h6l-.8 5.4 2.8 2.8v1.8H7v-1.8l2.8-2.8L9 3.5zM12 13.5v7' }]],
};

function icon(name) {
  const el = s('svg', { viewBox: '0 0 24 24', class: 'icon', 'aria-hidden': 'true', focusable: 'false' });
  for (const [tag, attrs] of ICONS[name]) el.append(s(tag, attrs));
  return el;
}

// ---------- formatting ----------

const nf = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const utcDate = (iso) => new Date(`${iso}T00:00:00Z`);
const longDate = (iso) =>
  utcDate(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const shortDate = (iso) => utcDate(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const plural = (n, one, many = `${one}s`) => `${nf.format(n)} ${n === 1 ? one : many}`;
const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function timeAgo(when) {
  const t = typeof when === 'number' ? when : Date.parse(when);
  const diff = Math.round((t - Date.now()) / 1000);
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  const units = [['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3600], ['minute', 60]];
  for (const [unit, secs] of units) if (abs >= secs) return rtf.format(Math.round(diff / secs), unit);
  return 'just now';
}

const initials = (name) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

// ---------- state ----------

const state = {
  data: null,
  settings: null,
  status: null,
  q: '',
  lang: '',
  sort: 'stars',
  showAll: false,
  view: 'grid',
  pinnedStreak: null,
  heat: null,
};

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    });
  } catch {
    const err = new Error('The dashboard server is not reachable. Check that it is still running.');
    err.status = 0;
    throw err;
  }
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) {
    const err = new Error(payload?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.rateLimited = !!payload?.rateLimited;
    err.resetAt = payload?.resetAt ?? null;
    throw err;
  }
  return payload;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 4000);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('theme', theme);
  } catch {
    /* storage blocked; the setting still lives in the database */
  }
}

// ---------- views ----------

function show(which) {
  $('#loading').hidden = which !== 'loading';
  $('#setup').hidden = which !== 'setup';
  $('#error').hidden = which !== 'error';
  $('#content').hidden = which !== 'content';
  if (which !== 'content') $('#banner').hidden = true;
}

function showError(err) {
  let title = "Couldn't load this dashboard";
  let body = err.message;
  if (err.status === 404) {
    title = 'That GitHub user was not found';
    body = 'Check the spelling of the username in Settings.';
  } else if (err.rateLimited) {
    title = 'GitHub rate limit reached';
    const reset = err.resetAt ? ` The limit resets at ${clock(err.resetAt)}.` : '';
    const advice = state.status?.hasToken || state.status?.provider === 'demo'
      ? ''
      : ' Add GITHUB_TOKEN to your .env file to raise the limit from 60 to 5,000 requests per hour.';
    body = `GitHub is limiting requests.${reset}${advice}`;
  }
  $('#error-title').textContent = title;
  $('#error-body').textContent = body;
  show('error');
}

function setBusy(busy) {
  const btn = $('#btn-refresh');
  btn.disabled = busy;
  btn.textContent = busy ? 'Refreshing…' : 'Refresh data';
  if (busy && !state.data) show('loading');
}

async function load({ force = false, user } = {}) {
  setBusy(true);
  try {
    const qs = new URLSearchParams();
    if (user) qs.set('user', user);
    if (force) qs.set('refresh', '1');
    const data = await api(`/api/dashboard${qs.size ? `?${qs}` : ''}`);
    if (data.needsSetup) {
      state.data = null;
      show('setup');
      $('#setup-user').focus();
      return;
    }
    state.data = data;
    state.settings = data.settings;
    state.sort = data.settings.sort;
    state.pinnedStreak = null;
    show('content');
    render();
  } catch (err) {
    if (state.data) toast(err.message);
    else showError(err);
  } finally {
    setBusy(false);
  }
}

// ---------- rendering ----------

function render() {
  const d = state.data;
  renderBanner(d);
  renderMasthead(d);
  renderActivity(d);
  renderLanguages(d);
  renderRepoControls(d);
  renderRepos();
  renderFooter(d);
}

function renderBanner(d) {
  const lines = [];
  if (d.cache.provider === 'demo') {
    lines.push('You are looking at sample data. Run npm start to see your own GitHub activity.');
  } else if (d.contributions.approximate) {
    lines.push(
      `Showing public activity from the last ${d.contributions.trackedDays} days. Add a GITHUB_TOKEN to .env to load your full contribution calendar.`
    );
  }
  for (const e of d.cache.errors) {
    const reset = e.rateLimited && e.resetAt ? ` The limit resets at ${clock(e.resetAt)}.` : '';
    lines.push(`Could not refresh ${e.part}: ${e.message}.${reset} Showing saved data where it exists.`);
  }
  const banner = $('#banner');
  banner.replaceChildren(...lines.map((l) => h('p', null, l)));
  banner.hidden = lines.length === 0;
}

function safeUrl(raw) {
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

function renderMasthead(d) {
  const u = d.user;
  document.title = `${u.name}, developer dashboard`;
  $('#name').textContent = u.name;

  const avatar = $('#avatar');
  const fallback = () => avatar.replaceChildren(document.createTextNode(initials(u.name)));
  if (u.avatar) {
    const img = h('img', { src: `${u.avatar}${u.avatar.includes('?') ? '&' : '?'}s=160`, alt: '', width: 72, height: 72 });
    img.addEventListener('error', fallback);
    avatar.replaceChildren(img);
  } else {
    fallback();
  }

  const handle = $('#handle');
  handle.textContent = `@${u.login}`;
  handle.href = u.url;

  const bio = $('#bio');
  bio.textContent = u.bio ?? '';
  bio.hidden = !u.bio;

  const blog = u.blog ? safeUrl(u.blog) : null;
  const facts = [
    u.location && h('li', null, u.location),
    u.company && h('li', null, u.company),
    blog && h('li', null, h('a', { href: blog.href, target: '_blank', rel: 'noopener noreferrer' }, blog.host)),
    h('li', null, plural(u.followers, 'follower')),
    h('li', null, `On GitHub since ${new Date(u.createdAt).getUTCFullYear()}`),
  ];
  $('#facts').replaceChildren(...facts.filter(Boolean));
}

// ----- contribution heatmap -----

const CELL = 13;
const PITCH = 16;
const LEFT = 34;
const TOP = 22;

function buildHeatmap(days) {
  const offset = utcDate(days[0].date).getUTCDay(); // 0 is Sunday, which is the top row
  const cols = Math.ceil((offset + days.length) / 7);
  const width = LEFT + cols * PITCH - (PITCH - CELL) + 2;
  const height = TOP + 7 * PITCH - (PITCH - CELL) + 2;

  const svg = s('svg', {
    class: 'heat-svg',
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': `Contribution calendar for the past ${days.length} days. A monthly table is available with the view switch above.`,
  });

  for (const [label, row] of [['Mon', 1], ['Wed', 3], ['Fri', 5]]) {
    svg.append(s('text', { class: 'axis', x: LEFT - 8, y: TOP + row * PITCH + 10.5, 'text-anchor': 'end' }, label));
  }

  // A month label sits above the column that contains the 1st of that month.
  const labelled = new Set();
  const addMonth = (col, iso) => {
    if (labelled.has(col)) return;
    labelled.add(col);
    const name = utcDate(iso).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });
    svg.append(s('text', { class: 'axis', x: LEFT + col * PITCH, y: 12 }, name));
  };
  if (Number(days[0].date.slice(8)) <= 10) addMonth(0, days[0].date);

  const cells = days.map((day, i) => {
    const idx = offset + i;
    const col = Math.floor(idx / 7);
    const row = idx % 7;
    if (day.date.endsWith('-01')) addMonth(col, day.date);
    const rect = s('rect', {
      class: day.count === null ? 'cell nodata' : `cell l${day.level}`,
      x: LEFT + col * PITCH,
      y: TOP + row * PITCH,
      width: CELL,
      height: CELL,
      rx: 3,
      'data-i': i,
    });
    rect.style.setProperty('--c', col);
    svg.append(rect);
    return rect;
  });

  return { svg, cells, days };
}

function setHighlight(range) {
  const heat = state.heat;
  if (!heat) return;
  heat.svg.classList.toggle('dim', !!range);
  heat.days.forEach((day, i) => {
    heat.cells[i].classList.toggle('hl', !!range && day.date >= range.start && day.date <= range.end);
  });
}

const pinnedRange = () => (state.pinnedStreak ? state.data.streaks[state.pinnedStreak] : null);

function renderActivity(d) {
  const { days, trackedDays, total } = d.contributions;

  $('#activity-title').textContent = trackedDays
    ? `${nf.format(total)} contributions in the past ${trackedDays >= 360 ? 'year' : `${trackedDays} days`}`
    : 'Contribution data is not available right now';

  const heat = $('#heat');
  const scroller = $('#heat-scroll');
  if (!days.length) {
    state.heat = null;
    heat.replaceChildren(h('p', { class: 'hint' }, 'GitHub did not return any contribution data. Try Refresh data in a few minutes.'));
    $('#legend').hidden = true;
  } else {
    $('#legend').hidden = false;
    state.heat = buildHeatmap(days);
    heat.replaceChildren(state.heat.svg);
    scroller.scrollLeft = scroller.scrollWidth; // newest weeks first on small screens
  }

  renderMonthTable(days);
  renderStreaks(d);
  setView(state.view);
}

function setView(view) {
  state.view = view;
  const hasDays = !!state.heat;
  $('#heat-scroll').hidden = view !== 'grid';
  $('#legend').hidden = view !== 'grid' || !hasDays;
  $('#heat-table').hidden = view !== 'table';
  for (const btn of document.querySelectorAll('.seg button')) btn.setAttribute('aria-pressed', String(btn.dataset.view === view));
}

function renderMonthTable(days) {
  const months = new Map();
  for (const day of days) {
    if (day.count === null) continue;
    const key = day.date.slice(0, 7);
    const m = months.get(key) ?? { total: 0, active: 0, best: null };
    m.total += day.count;
    if (day.count > 0) m.active += 1;
    if (day.count > 0 && (!m.best || day.count >= m.best.count)) m.best = day;
    months.set(key, m);
  }
  const rows = [...months].reverse().map(([key, m]) =>
    h('tr', null,
      h('th', { scope: 'row' }, utcDate(`${key}-01`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })),
      h('td', { class: 'num' }, nf.format(m.total)),
      h('td', { class: 'num' }, nf.format(m.active)),
      h('td', null, m.best ? `${shortDate(m.best.date)} (${nf.format(m.best.count)})` : 'None'))
  );
  $('#heat-table').replaceChildren(
    h('div', { class: 'table-wrap' },
      h('table', { class: 'month-table' },
        h('caption', null, 'Contributions by month, newest first'),
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, 'Month'),
          h('th', { scope: 'col', class: 'num' }, 'Contributions'),
          h('th', { scope: 'col', class: 'num' }, 'Active days'),
          h('th', { scope: 'col' }, 'Busiest day'))),
        h('tbody', null, rows)))
  );
}

function renderStreaks(d) {
  const { current, longest, activeDays, trackedDays, busiest, perActiveDay } = d.streaks;

  const range = (r) => (r.start === r.end ? shortDate(r.start) : `${shortDate(r.start)} to ${shortDate(r.end)}`);
  const days = (n) => h('span', { class: 'u' }, n === 1 ? 'day' : 'days');

  const streakButton = (key, label, streak, emptyText) => {
    const inner = [
      h('span', { class: 'k' }, label),
      h('span', { class: 'v' }, nf.format(streak.length), days(streak.length)),
      h('span', { class: 's' }, streak.length ? range(streak) : emptyText),
    ];
    if (!streak.length) return h('div', { class: 'streak' }, ...inner);
    const btn = h('button', { type: 'button', class: 'streak', 'aria-pressed': 'false', 'data-key': key }, ...inner);
    btn.addEventListener('pointerenter', () => setHighlight(streak));
    btn.addEventListener('focus', () => setHighlight(streak));
    btn.addEventListener('pointerleave', () => setHighlight(pinnedRange()));
    btn.addEventListener('blur', () => setHighlight(pinnedRange()));
    btn.addEventListener('click', () => {
      state.pinnedStreak = state.pinnedStreak === key ? null : key;
      for (const b of document.querySelectorAll('button.streak')) b.setAttribute('aria-pressed', String(b.dataset.key === state.pinnedStreak));
      setHighlight(pinnedRange());
    });
    return btn;
  };

  const items = [
    streakButton('current', 'Current streak', { ...current }, 'Contribute today to start one'),
    streakButton('longest', 'Longest streak', longest, 'No streak yet'),
    h('div', { class: 'streak' },
      h('span', { class: 'k' }, 'Active days'),
      h('span', { class: 'v' }, nf.format(activeDays)),
      h('span', { class: 's' }, trackedDays ? `of ${nf.format(trackedDays)} days, ${perActiveDay} a day when active` : '')),
    h('div', { class: 'streak' },
      h('span', { class: 'k' }, 'Busiest day'),
      h('span', { class: 'v' }, busiest ? nf.format(busiest.count) : '0'),
      h('span', { class: 's' }, busiest ? longDate(busiest.date) : 'No activity yet')),
  ];
  $('#streaks').replaceChildren(...items);
}

// heatmap tooltip (event delegation keeps this to a handful of listeners)
function wireHeatmap() {
  const tip = $('#tip');
  const heat = $('#heat');

  const hide = () => { tip.hidden = true; };
  const showFor = (rect) => {
    const day = state.heat?.days[Number(rect.dataset.i)];
    if (!day) return;
    const headline = day.count === null ? 'No data' : day.count === 0 ? 'No contributions' : plural(day.count, 'contribution');
    tip.replaceChildren(h('strong', null, headline), h('span', null, longDate(day.date)));
    tip.hidden = false;
    const r = rect.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2), window.innerWidth - tip.offsetWidth - 8);
    let top = r.top - tip.offsetHeight - 8;
    if (top < 8) top = r.bottom + 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  heat.addEventListener('pointerover', (e) => {
    const rect = e.target.closest?.('.cell');
    if (rect) showFor(rect);
    else hide();
  });
  heat.addEventListener('pointerdown', (e) => {
    const rect = e.target.closest?.('.cell');
    if (rect) showFor(rect);
  });
  heat.addEventListener('pointerleave', hide);
  $('#heat-scroll').addEventListener('scroll', hide, { passive: true });
  document.addEventListener('pointerdown', (e) => { if (!heat.contains(e.target)) hide(); });
}

// ----- languages -----

function renderLanguages(d) {
  const section = $('#languages');
  if (!d.languages.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const main = d.languages.filter((l) => l.slot > 0);
  const rest = d.languages.filter((l) => l.slot === 0);
  const segments = main.map((l) => ({ ...l }));
  if (rest.length) {
    segments.push({
      name: 'Other',
      count: rest.reduce((n, l) => n + l.count, 0),
      percent: Math.round(rest.reduce((n, l) => n + l.percent, 0) * 10) / 10,
      slot: 0,
      other: true,
    });
  }
  const total = segments.reduce((n, l) => n + l.count, 0);

  const toggle = (seg) => {
    if (seg.other) return;
    state.lang = state.lang === seg.name ? '' : seg.name;
    state.showAll = false;
    $('#lang').value = state.lang;
    syncLanguageButtons();
    renderRepos();
  };

  const label = (seg) => `${seg.name}, ${plural(seg.count, 'repository', 'repositories')}, ${seg.percent}%`;
  const bar = h('div', { class: 'langbar' },
    segments.map((seg) =>
      h('button', {
        type: 'button',
        class: `lang-${seg.slot}`,
        style: null,
        'aria-label': label(seg),
        'aria-pressed': 'false',
        'data-lang': seg.other ? '' : seg.name,
        title: label(seg),
        onclick: () => toggle(seg),
        disabled: seg.other ? true : null,
      })
    )
  );
  segments.forEach((seg, i) => { bar.children[i].style.flexGrow = String(seg.count); bar.children[i].style.flexBasis = '0'; });

  const list = h('div', { class: 'langlist' },
    segments.map((seg) =>
      h('button', {
        type: 'button',
        class: `lang-${seg.slot}`,
        'aria-pressed': 'false',
        'data-lang': seg.other ? '' : seg.name,
        onclick: () => toggle(seg),
        disabled: seg.other ? true : null,
      }, h('span', { class: 'dot' }), seg.name, h('span', { class: 'pct' }, `${seg.percent}%`))
    )
  );

  section.replaceChildren(
    h('h2', { id: 'languages-title' }, `Languages across ${plural(total, 'repository', 'repositories')}`),
    bar,
    list
  );
  syncLanguageButtons();
}

function syncLanguageButtons() {
  for (const b of document.querySelectorAll('#languages button[data-lang]')) {
    b.setAttribute('aria-pressed', String(!!state.lang && b.dataset.lang === state.lang));
  }
}

// ----- repositories -----

const SORTERS = {
  stars: (a, b) => b.stars - a.stars || a.name.localeCompare(b.name),
  forks: (a, b) => b.forks - a.forks || a.name.localeCompare(b.name),
  updated: (a, b) => Date.parse(b.pushedAt || 0) - Date.parse(a.pushedAt || 0),
  name: (a, b) => a.name.localeCompare(b.name),
};

function renderRepoControls(d) {
  const select = $('#lang');
  const names = d.languages.map((l) => l.name);
  if (state.lang && !names.includes(state.lang)) state.lang = '';
  select.replaceChildren(
    h('option', { value: '' }, 'All languages'),
    names.map((n) => h('option', { value: n }, n))
  );
  select.value = state.lang;
  $('#sort').value = state.sort;
}

function visibleRepos() {
  const q = state.q.trim().toLowerCase();
  return state.data.repos
    .filter((r) => !state.lang || r.language === state.lang)
    .filter((r) => !q || r.name.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || SORTERS[state.sort](a, b));
}

function stat(name, value, label) {
  return h('span', { class: 'stat', title: `${nf.format(value)} ${label}` },
    icon(name), h('span', null, compact.format(value)), h('span', { class: 'sr' }, ` ${label}`));
}

function repoCard(r, feature) {
  return h('article', { class: feature ? 'repo feature' : 'repo' },
    h('div', { class: 'repo-top' },
      h('h3', null, h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.name)),
      h('button', {
        type: 'button',
        class: 'pin',
        'aria-pressed': String(r.pinned),
        'aria-label': `${r.pinned ? 'Unpin' : 'Pin'} ${r.name}`,
        title: r.pinned ? 'Unpin' : 'Pin to the top',
        onclick: () => togglePin(r.name),
      }, icon('pin'))),
    h('p', { class: 'desc' }, r.description || 'No description yet.'),
    h('div', { class: 'repo-meta' },
      r.language && h('span', { class: `lang-tag lang-${r.langSlot}` }, h('span', { class: 'dot' }), r.language),
      stat('star', r.stars, 'stars'),
      stat('fork', r.forks, 'forks'),
      r.archived && h('span', { class: 'badge' }, 'Archived'),
      r.isFork && h('span', { class: 'badge' }, 'Fork'),
      r.pushedAt && h('span', { class: 'updated' }, `Pushed ${timeAgo(r.pushedAt)}`))
  );
}

function renderRepos() {
  if (!state.data) return;
  const all = visibleRepos();
  const limit = state.settings.maxRepos;
  const shown = state.showAll ? all : all.slice(0, limit);
  const grid = $('#repo-grid');

  if (!state.data.repos.length) {
    grid.replaceChildren(h('div', { class: 'empty' }, h('p', null, 'No public repositories to show yet.')));
  } else if (!all.length) {
    grid.replaceChildren(
      h('div', { class: 'empty' },
        h('p', null, 'No repositories match this search.'),
        h('button', { type: 'button', class: 'btn', onclick: clearFilters }, 'Clear search and filters'))
    );
  } else {
    grid.replaceChildren(...shown.map((r, i) => repoCard(r, i === 0 && shown.length >= 3)));
  }

  const more = $('#more');
  more.hidden = all.length <= limit;
  more.textContent = state.showAll ? 'Show fewer' : `Show all ${nf.format(all.length)} repositories`;
  $('#repos-count').textContent = all.length
    ? `Showing ${nf.format(shown.length)} of ${plural(all.length, 'repository', 'repositories')}`
    : '';
}

function clearFilters() {
  state.q = '';
  state.lang = '';
  $('#q').value = '';
  $('#lang').value = '';
  syncLanguageButtons();
  renderRepos();
}

async function togglePin(name) {
  const current = new Set(state.settings.pinned);
  const wasPinned = current.has(name);
  if (wasPinned) current.delete(name);
  else current.add(name);
  const pinned = [...current];
  try {
    state.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ pinned }) });
    for (const r of state.data.repos) r.pinned = current.has(r.name);
    renderRepos();
  } catch (err) {
    toast(err.message.startsWith('Invalid value for pinned') ? 'You can pin up to 12 repositories.' : err.message);
  }
}

// ----- footer -----

function cacheText(entry) {
  switch (entry.status) {
    case 'hit': return `Saved copy from ${timeAgo(entry.fetchedAt)}`;
    case 'revalidated': return `Checked ${timeAgo(entry.fetchedAt)}, nothing changed`;
    case 'fetched': return `Fetched ${timeAgo(entry.fetchedAt)}`;
    case 'stale': return `Saved copy from ${timeAgo(entry.fetchedAt)}, GitHub could not be reached`;
    default: return 'Not available';
  }
}

function renderFooter(d) {
  const { cache, contributions } = d;
  const source =
    cache.provider === 'demo' ? 'Sample data generated on this computer'
    : contributions.source === 'graphql' ? 'Contribution calendar from the GitHub GraphQL API'
    : 'Contributions estimated from public events';
  const rate = cache.rate
    ? `${nf.format(cache.rate.remaining)} of ${nf.format(cache.rate.limit)} requests left, resets at ${clock(cache.rate.reset * 1000)}`
    : 'No GitHub request made yet';

  const row = (term, text) => [h('dt', null, term), h('dd', null, text)];
  $('#foot').replaceChildren(
    h('dl', null, ...row('Profile', cacheText(cache.profile)), ...row('Repositories', cacheText(cache.repos))),
    h('dl', null, ...row('Contributions', cacheText(cache.contributions)), ...row('Data source', source)),
    h('dl', null, ...row('GitHub API quota', rate))
  );
}

// ---------- settings dialog ----------

function openSettings() {
  const form = $('#settings-form');
  const st = state.settings;
  if (!st) return;
  form.username.value = st.username;
  form.theme.value = st.theme;
  form.maxRepos.value = st.maxRepos;
  form.hideForks.checked = st.hideForks;
  form.hideArchived.checked = st.hideArchived;
  form.ttlProfileMin.value = st.ttlProfileMin;
  form.ttlReposMin.value = st.ttlReposMin;
  form.ttlContribMin.value = st.ttlContribMin;

  const status = state.status;
  $('#settings-source').textContent = !status ? ''
    : status.provider === 'demo' ? 'Demo mode: no requests are sent to GitHub.'
    : status.hasToken ? 'A GitHub token was found on the server, so the full contribution calendar is loaded. The token is never sent to the browser.'
    : 'No GitHub token found, so contributions come from your last 90 days of public events. Set GITHUB_TOKEN in .env to load the full year.';
  $('#settings-dialog').showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  const f = $('#settings-form');
  const patch = {
    username: f.username.value.trim(),
    theme: f.theme.value,
    maxRepos: Number(f.maxRepos.value),
    hideForks: f.hideForks.checked,
    hideArchived: f.hideArchived.checked,
    ttlProfileMin: Number(f.ttlProfileMin.value),
    ttlReposMin: Number(f.ttlReposMin.value),
    ttlContribMin: Number(f.ttlContribMin.value),
  };
  try {
    state.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
  } catch (err) {
    toast(err.message);
    return;
  }
  applyTheme(state.settings.theme);
  $('#settings-dialog').close();
  state.showAll = false;
  await load();
}

// ---------- start ----------

function wire() {
  $('#btn-refresh').addEventListener('click', () => load({ force: true }));
  $('#btn-settings').addEventListener('click', openSettings);
  $('#error-retry').addEventListener('click', () => load({ force: true }));
  $('#error-settings').addEventListener('click', openSettings);
  $('#settings-cancel').addEventListener('click', () => $('#settings-dialog').close());
  $('#settings-form').addEventListener('submit', saveSettings);

  $('#clear-cache').addEventListener('click', async () => {
    if (!window.confirm('Delete all cached GitHub data? Your settings are kept and the data is fetched again.')) return;
    try {
      await api('/api/cache/clear', { method: 'POST' });
      $('#settings-dialog').close();
      toast('Cached data cleared.');
      await load();
    } catch (err) {
      toast(err.message);
    }
  });

  $('#setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#setup-user').value.trim();
    try {
      state.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ username }) });
    } catch {
      toast('Enter a valid GitHub username: letters, numbers and single hyphens.');
      return;
    }
    await load();
  });

  for (const btn of document.querySelectorAll('.seg button')) btn.addEventListener('click', () => setView(btn.dataset.view));

  $('#q').addEventListener('input', (e) => { state.q = e.target.value; state.showAll = false; renderRepos(); });
  $('#lang').addEventListener('change', (e) => { state.lang = e.target.value; state.showAll = false; syncLanguageButtons(); renderRepos(); });
  $('#sort').addEventListener('change', async (e) => {
    state.sort = e.target.value;
    renderRepos();
    try {
      state.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ sort: state.sort }) });
    } catch (err) {
      toast(err.message);
    }
  });
  $('#more').addEventListener('click', () => { state.showAll = !state.showAll; renderRepos(); });

  wireHeatmap();
}

async function init() {
  wire();
  try {
    state.settings = await api('/api/settings');
    applyTheme(state.settings.theme);
    state.status = await api('/api/status').catch(() => null);
  } catch (err) {
    showError(err);
    return;
  }
  await load();
}

init();
