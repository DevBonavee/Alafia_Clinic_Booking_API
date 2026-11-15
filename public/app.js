// Alafia Clinic booking page. Plain JS, no build step. Talks to the API on the same origin.
// Screens follow HANDOFF.md and alafia-mockups.html (D1–D7 desktop, M1–M7 mobile).
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const KEY_STORAGE = 'alafia.apiKey';
  const EMAIL_STORAGE = 'alafia.email';
  const LAST_BOOKING_STORAGE = 'alafia.lastBooking';
  const mobileQuery = window.matchMedia('(max-width: 860px)');

  // ---------- icons (lucide paths, as in the mockups) ----------
  const ICONS = {
    check: '<path d="M20 6 9 17l-5-5"/>',
    arrow: '<path d="M5 12h14M12 5l7 7-7 7"/>',
    alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
    timer: '<path d="M10 2h4M12 14l3-3"/><circle cx="12" cy="14" r="8"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    chev: '<path d="m6 9 6 6 6-6"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  };
  const icon = (name, size = 16, stroke = 2, color = 'currentColor') =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  const MARK_PATHS = (plus, leaf) =>
    `<path d="M20 11v18M11 20h18" stroke="${plus}" stroke-width="4.5" stroke-linecap="round"/><path d="M23.5 16.5c0-4.4 2.9-7.3 7.5-7.5-.2 4.6-3.1 7.5-7.5 7.5z" fill="${leaf}"/>`;
  const mark = (size, dark) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="12" fill="${dark ? '#F6F3EC' : '#0F4C45'}"/>${MARK_PATHS(dark ? '#0F4C45' : '#F6F3EC', '#F2B35B')}</svg>`;
  const deco = `<svg viewBox="0 0 40 40" aria-hidden="true">${MARK_PATHS('#F6F3EC', '#F2B35B')}</svg>`;

  function hydrateIcons(root = document) {
    for (const n of root.querySelectorAll('[data-icon]')) n.innerHTML = icon(n.dataset.icon, Number(n.dataset.size) || 16);
    for (const n of root.querySelectorAll('[data-mark]')) n.innerHTML = mark(Number(n.dataset.size) || 32, n.dataset.mark === 'dark');
    for (const n of root.querySelectorAll('[data-deco]')) n.innerHTML = deco;
  }

  // ---------- small DOM helper ----------
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) node.append(c);
    return node;
  }
  const badge = (cls, text) => el('span', { class: `badge ${cls}`, text });

  // ---------- storage (never throws) ----------
  const store = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* blocked */ } },
  };
  let apiKey = store.get(KEY_STORAGE);

  // ---------- dates (en-GB style, local timezone, 24-hour) ----------
  const LOCALE = 'en-GB';
  const f = (opts) => new Intl.DateTimeFormat(LOCALE, opts);
  const fTime = f({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const fWd = f({ weekday: 'short' });
  const fWdLong = f({ weekday: 'long' });
  const fDay = f({ day: 'numeric' });
  const fMon = f({ month: 'short' });
  const fMonLong = f({ month: 'long' });
  const fYear = f({ year: 'numeric' });
  const fKey = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const D = (iso) => new Date(iso);
  const time = (iso) => fTime.format(D(iso));
  const dayKey = (iso) => fKey.format(D(iso));
  const minutes = (s) => Math.round((D(s.end) - D(s.start)) / 60000);
  const tzName = (() => {
    try {
      const part = new Intl.DateTimeFormat(LOCALE, { timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
      return part ? part.value : Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch { return 'local'; }
  })();
  const fmt = {
    summaryTitle: (iso) => `${fWd.format(D(iso))}, ${fDay.format(D(iso))} ${fMonLong.format(D(iso))}`, // Thu, 10 December
    long: (iso) => `${fWdLong.format(D(iso))} ${fDay.format(D(iso))} ${fMonLong.format(D(iso))}`, // Thursday 10 December
    short: (iso) => `${fWd.format(D(iso))} ${fDay.format(D(iso))} ${fMon.format(D(iso))}`, // Thu 10 Dec
    date: (iso) => `${fWd.format(D(iso))}, ${fDay.format(D(iso))} ${fMon.format(D(iso))} ${fYear.format(D(iso))}`, // Thu, 10 Dec 2026
    dateOnly: (iso) => `${fDay.format(D(iso))} ${fMon.format(D(iso))} ${fYear.format(D(iso))}`, // 15 Nov 2026
    range: (s) => `${time(s.start)} – ${time(s.end)}`,
  };
  const isPast = (s) => D(s.start).getTime() <= Date.now();
  const initial = (provider) => (provider.split(' ').slice(-1)[0] || provider)[0].toUpperCase();

  // ---------- API ----------
  class ApiError extends Error {
    constructor(status, message, headers) { super(message); this.status = status; this.headers = headers; }
  }

  async function api(method, path, { body, headers = {} } = {}) {
    const res = await fetch(path, {
      method,
      headers: { 'X-API-Key': apiKey, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      if (res.status === 401) {
        apiKey = '';
        store.set(KEY_STORAGE, '');
        showKeyView(true);
      }
      throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`, res.headers);
    }
    return data;
  }

  // ---------- state ----------
  const state = {
    slots: [],
    slotsById: new Map(),
    provider: 'All providers',
    day: null,
    selectedId: null,
    submitting: false,
    retryTimer: null,
  };

  function setSlots(list) {
    state.slots = list;
    state.slotsById = new Map(list.map((s) => [s.id, s]));
  }

  // ---------- views and navigation ----------
  const VIEWS = ['view-key', 'view-slots', 'view-confirm', 'view-mine', 'view-lookup-error'];
  function show(id) {
    for (const v of VIEWS) $(v).hidden = v !== id;
    const onKey = id === 'view-key';
    $('hdr').hidden = onKey;
    $('mtabs').hidden = onKey || id === 'view-confirm';
    document.body.classList.toggle('no-tabs', $('mtabs').hidden);
    document.body.classList.toggle('on-confirm', id === 'view-confirm');
    const current = id === 'view-mine' ? 'mine' : id === 'view-slots' || id === 'view-confirm' ? 'book' : null;
    for (const a of document.querySelectorAll('[data-nav]')) {
      if (a.closest('.logo')) continue;
      if (a.dataset.nav === current) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    closeSheet();
    window.scrollTo(0, 0);
  }

  function navigate(href) {
    history.pushState({}, '', href);
    route();
  }

  function updateKeyChip() {
    const tail = apiKey.slice(-4);
    $('key-mask').textContent = (mobileQuery.matches ? '••' : '••••') + tail;
  }

  // ---------- D1 / M1: key ----------
  function showKeyView(rejected) {
    $('key-error').hidden = !rejected;
    $('api-key-wrap').classList.toggle('err', !!rejected);
    $('api-key').value = '';
    show('view-key');
    $('api-key').focus();
  }

  // ---------- alerts and toasts ----------
  function alertBox(node, kind, title, desc, iconName) {
    node.className = `alert ${kind}`;
    node.replaceChildren(
      el('span', { html: icon(iconName || (kind === 'a-warn' ? 'timer' : kind === 'a-ok' ? 'check' : 'alert'), 20) }),
      el('div', {}, el('div', { class: 't', text: title }), desc ? el('div', { class: 'd', text: desc }) : null),
    );
    node.hidden = false;
  }
  const hide = (node) => { node.hidden = true; };

  function toast(title, desc) {
    const t = el('div', { class: 'alert a-ok toast', role: 'status' },
      el('span', { html: icon('check', 20) }),
      el('div', {}, el('div', { class: 't', text: title }), el('div', { class: 'd', text: desc })));
    $('toasts').append(t);
    setTimeout(() => t.remove(), 4500);
  }

  // ---------- D2 / M2: slots ----------
  async function loadSlots() {
    $('slots-loading').hidden = state.slots.length > 0;
    hide($('page-alert'));
    try {
      const data = await api('GET', '/slots');
      setSlots(data.slots);
      if (state.selectedId && !state.slotsById.get(state.selectedId)) clearSelection();
      renderSlotsView();
    } catch (err) {
      if (err.status !== 401) alertBox($('page-alert'), 'a-red', "We couldn't load the times", 'Refresh the page to try again.');
    } finally {
      $('slots-loading').hidden = true;
    }
  }

  const providers = () => ['All providers', ...[...new Set(state.slots.map((s) => s.provider))].sort()];
  const byProvider = (s) => state.provider === 'All providers' || s.provider === state.provider;
  const isOpen = (s) => s.available && !isPast(s);

  function renderSlotsView() {
    const list = providers();
    if (!list.includes(state.provider)) state.provider = 'All providers';

    // Provider tabs (desktop) and select (mobile).
    $('provider-tabs').replaceChildren(...list.map((p) => el('button', {
      type: 'button', class: 'tab', role: 'tab', 'aria-selected': String(p === state.provider),
      text: p === 'All providers' ? 'All' : p, onclick: () => { state.provider = p; renderSlotsView(); },
    })));
    $('provider-select').replaceChildren(...list.map((p) => el('option', { value: p, text: p, selected: p === state.provider })));

    // Day chips.
    const visible = state.slots.filter(byProvider);
    const days = new Map();
    for (const s of visible) {
      const k = dayKey(s.start);
      if (!days.has(k)) days.set(k, []);
      days.get(k).push(s);
    }
    const keys = [...days.keys()];
    if (!keys.includes(state.day)) {
      state.day = keys.find((k) => days.get(k).some(isOpen)) ?? keys[0] ?? null;
    }
    const today = dayKey(new Date().toISOString());
    $('day-chips').replaceChildren(...keys.map((k) => {
      const first = days.get(k)[0].start;
      const open = days.get(k).filter(isOpen).length;
      return el('button', {
        type: 'button', class: 'chip', role: 'tab', 'aria-selected': String(k === state.day),
        'aria-label': `${fmt.long(first)}, ${open} open`,
        onclick: () => { state.day = k; renderSlotsView(); },
      },
      el('span', { class: 'over', text: k === today ? 'Today' : fWd.format(D(first)) }),
      el('b', { text: fDay.format(D(first)) }),
      el('span', { class: 'small', text: `${open} open` }));
    }));
    const selChip = $('day-chips').querySelector('[aria-selected="true"]');
    if (selChip) selChip.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    // Slot cards for the chosen day.
    const daySlots = state.day ? days.get(state.day) || [] : [];
    $('slot-grid').replaceChildren(...daySlots.map((s) => slotCard(s, { onPick: selectSlot })));
    $('slots-empty').hidden = daySlots.length > 0 || state.slots.length === 0 && !$('slots-loading').hidden;
    if (state.slots.length === 0) $('slots-empty').textContent = 'No times have been published yet.';
    else $('slots-empty').textContent = 'No times on this day.';
  }

  function slotCard(s, { onPick, selected = s.id === state.selectedId } = {}) {
    const past = isPast(s);
    const booked = !s.available;
    const sel = selected && !past && !booked;
    const cls = ['slot', sel && 'sel', (past || booked) && 'off', past && 'past'].filter(Boolean).join(' ');
    let corner = null;
    let b = badge('b-ok', 'Available');
    if (sel) { corner = el('span', { class: 'corner ck', html: icon('check', 14, 3, '#3A2405') }); b = badge('b-acc', 'Selected'); }
    else if (past) b = badge('b-muted', 'Past');
    else if (booked) { corner = el('span', { class: 'corner muted', html: icon('lock') }); b = badge('b-muted', 'Booked'); }
    return el('button', {
      type: 'button', class: cls, disabled: past || booked, 'aria-pressed': String(sel),
      'aria-label': `${s.provider}, ${fmt.long(s.start)} at ${time(s.start)}${past ? ', past' : booked ? ', booked' : ''}`,
      onclick: () => onPick(s.id),
    },
    corner,
    el('div', {}, el('div', { class: 'tm', text: time(s.start) }), el('div', { class: 'rg', text: `to ${time(s.end)} · ${minutes(s)} min` })),
    el('div', { class: 'pv' }, el('span', { class: 'av', text: initial(s.provider) }), s.provider),
    el('div', {}, b));
  }

  // ---------- D3 / M3: booking panel or sheet ----------
  function summaryCard(s) {
    return [
      el('div', { class: 'date-tile' }, el('span', { class: 'over', text: fMon.format(D(s.start)) }), el('span', { class: 'serif', text: fDay.format(D(s.start)) })),
      el('div', { class: 'summary-text' },
        el('div', { class: 'summary-title', text: fmt.summaryTitle(s.start) }),
        el('div', { class: 'mono muted', style: 'font-size:12px', text: `${fmt.range(s)} · ${minutes(s)} min` }),
        el('div', { class: 'small', style: 'color:hsl(var(--secondary-foreground))', text: `with ${s.provider}` })),
      el('button', { type: 'button', class: 'summary-change', text: 'Change', onclick: clearSelection }),
    ];
  }

  function selectSlot(id) {
    state.selectedId = id;
    const s = state.slotsById.get(id);
    $('panel-empty').hidden = true;
    $('booking-form').hidden = false;
    $('summary').replaceChildren(...summaryCard(s));
    if (state.retryTimer === null) { hide($('form-alert')); setSubmitting(false); }
    clearFieldErrors();
    renderSlotsView();
    openSheet();
    if (!mobileQuery.matches) $('name').focus({ preventScroll: true });
  }

  function clearSelection() {
    state.selectedId = null;
    $('panel-empty').hidden = false;
    $('booking-form').hidden = true;
    closeSheet();
    renderSlotsView();
  }

  function openSheet() {
    if (!mobileQuery.matches) return;
    $('panel').classList.add('open');
    $('sheet-scrim').hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeSheet() {
    $('panel').classList.remove('open');
    $('sheet-scrim').hidden = true;
    document.body.style.overflow = '';
  }

  function clearFieldErrors() {
    for (const f of ['name', 'email', 'slot_id']) {
      const msg = $(`${f}-error`);
      msg.hidden = true;
      msg.textContent = '';
      const wrap = $(`${f}-wrap`);
      if (wrap) {
        wrap.classList.remove('err');
        $(f).removeAttribute('aria-invalid');
      }
    }
  }

  function showFieldError(message) {
    const field = ['slot_id', 'name', 'email'].find((f) => message.startsWith(f));
    if (!field) { alertBox($('form-alert'), 'a-red', 'Please check your details', message); return; }
    const msg = $(`${field}-error`);
    msg.textContent = message;
    msg.hidden = false;
    const wrap = $(`${field}-wrap`);
    if (wrap) {
      wrap.classList.add('err');
      $(field).setAttribute('aria-invalid', 'true');
      $(field).setAttribute('aria-describedby', `${field}-error`);
      $(field).focus();
    }
  }

  function setSubmitting(on) {
    state.submitting = on;
    const btn = $('book-btn');
    if (state.retryTimer !== null) return;
    btn.disabled = on;
    btn.innerHTML = on ? 'Booking…' : `Confirm booking ${icon('arrow')}`;
  }

  // One Idempotency-Key per submit; an automatic retry after a network failure reuses it.
  async function postBooking(body) {
    const headers = { 'Idempotency-Key': crypto.randomUUID() };
    try {
      return await api('POST', '/bookings', { body, headers });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      await new Promise((r) => setTimeout(r, 800));
      return api('POST', '/bookings', { body, headers });
    }
  }

  async function book(slotId) {
    if (state.submitting || state.retryTimer !== null) return;
    hide($('form-alert'));
    clearFieldErrors();
    const body = { slot_id: slotId, name: $('name').value, email: $('email').value };
    setSubmitting(true);
    try {
      const booking = await postBooking(body);
      store.set(EMAIL_STORAGE, booking.email);
      store.set(LAST_BOOKING_STORAGE, booking.id);
      $('booking-form').reset();
      state.selectedId = null;
      $('panel-empty').hidden = false;
      $('booking-form').hidden = true;
      history.pushState({}, '', `/?booking=${encodeURIComponent(booking.id)}`);
      showConfirmation(booking, state.slotsById.get(booking.slot_id));
    } catch (err) {
      handleBookingError(err, slotId);
    } finally {
      setSubmitting(false);
    }
  }

  function handleBookingError(err, slotId) {
    if (!(err instanceof ApiError)) {
      alertBox($('form-alert'), 'a-red', "We couldn't reach the clinic", 'Check your connection and try again.');
      return;
    }
    switch (err.status) {
      case 400: showFieldError(err.message); break;
      case 401: break; // already on the key screen
      case 404:
        alertBox($('form-alert'), 'a-red', 'That slot no longer exists.', 'Pick another time.');
        loadSlots();
        break;
      case 409: {
        const s = state.slotsById.get(slotId);
        if (s) s.available = false;
        renderSlotsView();
        openTakenDialog(slotId);
        break;
      }
      case 429: startRetryCountdown(Number.parseInt(err.headers.get('Retry-After'), 10)); break;
      default: alertBox($('form-alert'), 'a-red', 'Something went wrong on our side', 'Please try again in a moment.');
    }
  }

  // ---------- D4 / M6: slot taken ----------
  let nearbyPick = null;
  function openTakenDialog(takenId) {
    const taken = state.slotsById.get(takenId);
    const t = taken ? D(taken.start).getTime() : Date.now();
    const open = state.slots
      .filter((s) => isOpen(s) && s.id !== takenId)
      .sort((a, b) => Math.abs(D(a.start) - t) - Math.abs(D(b.start) - t))
      .slice(0, 2)
      .sort((a, b) => D(a.start) - D(b.start));
    nearbyPick = open.length ? open.reduce((best, s) => (Math.abs(D(s.start) - t) < Math.abs(D(best.start) - t) ? s : best)).id : null;
    $('taken-body').textContent = taken
      ? `${taken.provider} at ${time(taken.start)} was taken a moment before you. Your details are kept.`
      : 'That time was taken a moment before you. Your details are kept.';
    $('nearby-label').hidden = open.length === 0;
    $('taken-book').hidden = open.length === 0;
    const renderNearby = () => {
      $('nearby').replaceChildren(...open.map((s) => slotCard(s, {
        selected: s.id === nearbyPick,
        onPick: (id) => { nearbyPick = id; renderNearby(); },
      })));
      const pick = state.slotsById.get(nearbyPick);
      if (pick) $('taken-book').innerHTML = `Book ${time(pick.start)} instead ${icon('arrow')}`;
    };
    renderNearby();
    closeSheet();
    $('taken-dialog').showModal();
  }

  // ---------- D5 / M7: rate limited ----------
  function startRetryCountdown(seconds) {
    let left = Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
    clearInterval(state.retryTimer);
    const btn = $('book-btn');
    const tick = () => {
      if (left <= 0) { endCountdown(); return; }
      alertBox($('form-alert'), 'a-warn', 'Too many attempts', `We allow 5 tries a minute per email. Try again in ${left} second${left === 1 ? '' : 's'}.`);
      btn.disabled = true;
      btn.innerHTML = `${icon('timer')} Try again in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      left -= 1;
    };
    state.retryTimer = setInterval(tick, 1000);
    tick();
  }
  function endCountdown() {
    clearInterval(state.retryTimer);
    state.retryTimer = null;
    hide($('form-alert'));
    setSubmitting(false);
  }

  // ---------- D6 / M4: confirmation ----------
  let confirmed = null;
  function showConfirmation(booking, slot) {
    confirmed = booking;
    const ok = booking.status === 'confirmed';
    const first = booking.name.split(/\s+/)[0];
    $('confirm-icon').innerHTML = ok
      ? `<span class="ck">${icon('check', 24, 3, '#3A2405')}</span>`
      : `<span class="icobub">${icon('x', 22)}</span>`;
    $('confirm-over').textContent = ok ? 'Booking confirmed' : 'Booking cancelled';
    $('confirm-title').replaceChildren(ok ? 'You’re booked, ' : 'This booking is cancelled, ', el('em', { text: `${first}.` }));
    $('confirm-sub').innerHTML = '';
    if (slot) {
      $('confirm-sub').append(
        `${fmt.long(slot.start)} · ${fmt.range(slot)}`,
        mobileQuery.matches ? el('br') : ' ',
        `with ${slot.provider}`,
      );
    }
    $('c-id').textContent = booking.id;
    $('c-status').replaceChildren(ok ? badge('b-ok', 'Confirmed') : badge('b-red', 'Cancelled'));
    $('c-status-m').replaceChildren(ok ? badge('b-ok', 'Confirmed') : badge('b-red', 'Cancelled'));
    $('c-provider').textContent = slot ? slot.provider : '—';
    $('c-date').textContent = slot ? fmt.date(slot.start) : '—';
    $('c-time').textContent = slot ? `${fmt.range(slot)} (${tzName})` : '—';
    $('c-created').textContent = `${fmt.dateOnly(booking.created_at)}, ${time(booking.created_at)}`;
    $('c-name').textContent = booking.name;
    $('c-email').textContent = booking.email;
    $('c-email').title = booking.email;
    const url = new URL(location.href);
    url.search = `?booking=${encodeURIComponent(booking.id)}`;
    url.hash = '';
    $('share-link').value = url.toString();
    $('copy-link').textContent = 'Copy link';
    show('view-confirm');
  }

  async function openBookingFromUrl(id) {
    try {
      const [booking] = await Promise.all([
        api('GET', `/bookings/${encodeURIComponent(id)}`),
        api('GET', '/slots').then((d) => setSlots(d.slots)).catch(() => {}),
      ]);
      showConfirmation(booking, state.slotsById.get(booking.slot_id));
    } catch (err) {
      if (err.status === 401) return;
      show('view-lookup-error');
    }
  }

  async function copy(text, button, done) {
    try {
      await navigator.clipboard.writeText(text);
      if (button && done) { const old = button.innerHTML; button.textContent = done; setTimeout(() => { button.innerHTML = old; }, 1600); }
    } catch {
      $('share-link').select();
    }
  }

  // ---------- D7 / M5: my bookings ----------
  const mine = { email: '', cursor: null, items: [], pages: 0, asking: null, loading: false };

  function showMine(autoload = true) {
    show('view-mine');
    if (!$('mine-email').value) $('mine-email').value = store.get(EMAIL_STORAGE);
    if (autoload && $('mine-email').value) loadMine(true);
    else if (!$('mine-email').value) $('mine-email').focus();
  }

  async function loadMine(fresh) {
    if (mine.loading) return;
    hide($('mine-alert'));
    $('mine-error').hidden = true;
    $('mine-email-wrap').classList.remove('err');
    if (fresh) {
      const email = $('mine-email').value.trim();
      if (!email) {
        $('mine-error').textContent = 'email is required';
        $('mine-error').hidden = false;
        $('mine-email-wrap').classList.add('err');
        $('mine-email').focus();
        return;
      }
      Object.assign(mine, { email, cursor: null, items: [], pages: 0, asking: null });
    }
    mine.loading = true;
    for (const b of [$('mine-submit'), $('mine-more'), $('mine-more-m')]) b.disabled = true;
    try {
      const params = new URLSearchParams({ email: mine.email, limit: '10' });
      if (mine.cursor) params.set('cursor', mine.cursor);
      const [page] = await Promise.all([
        api('GET', `/bookings?${params}`),
        state.slots.length ? null : api('GET', '/slots').then((d) => setSlots(d.slots)).catch(() => {}),
      ]);
      mine.items.push(...page.bookings);
      mine.cursor = page.next_cursor;
      mine.pages += 1;
      if (fresh) store.set(EMAIL_STORAGE, mine.email);
      renderMine();
    } catch (err) {
      if (err.status === 401) return;
      if (err.status === 400) alertBox($('mine-alert'), 'a-red', 'Check the email', err.message);
      else alertBox($('mine-alert'), 'a-red', "We couldn't load your bookings", 'Please try again.');
    } finally {
      mine.loading = false;
      for (const b of [$('mine-submit'), $('mine-more'), $('mine-more-m')]) b.disabled = false;
    }
  }

  function whenText(b) {
    const s = state.slotsById.get(b.slot_id);
    return s ? `${fmt.short(s.start)} · ${time(s.start)}` : `Slot ${b.slot_id}`;
  }
  const providerText = (b) => (state.slotsById.get(b.slot_id) || {}).provider || '—';

  function renderMine() {
    const has = mine.items.length > 0;
    $('mine-table-card').hidden = !has;
    $('mine-empty').hidden = has || mine.pages === 0;
    $('mine-more').hidden = !mine.cursor;
    $('mine-more-m').hidden = !mine.cursor;
    $('mine-count').textContent = `Showing ${mine.items.length} · page ${mine.pages}`;
    const lastId = store.get(LAST_BOOKING_STORAGE);

    // Desktop table (D7).
    $('mine-rows').replaceChildren(...mine.items.map((b) => {
      const cancelled = b.status === 'cancelled';
      const asking = mine.asking === b.id;
      let actions;
      if (cancelled) actions = el('span', { class: 'muted', text: '—' });
      else if (asking) {
        actions = el('span', { class: 'ask-inline' },
          el('span', { class: 'small', text: 'Cancel this booking?' }),
          el('button', { type: 'button', class: 'btn ghost sm', text: 'Keep', onclick: () => { mine.asking = null; renderMine(); } }),
          el('button', { type: 'button', class: 'btn destructive sm', text: 'Yes, cancel', onclick: (e) => cancelBooking(b, e.currentTarget) }));
      } else {
        actions = el('button', { type: 'button', class: 'btn outline sm', text: 'Cancel', onclick: () => { mine.asking = b.id; renderMine(); } });
      }
      return el('tr', { class: [cancelled && 'cxl', asking && 'ask'].filter(Boolean).join(' ') },
        el('td', {},
          el('a', { class: 'mono', style: 'font-size:14px;text-decoration:none', href: `/?booking=${encodeURIComponent(b.id)}`, text: b.id, onclick: (e) => { e.preventDefault(); navigate(e.currentTarget.getAttribute('href')); } }),
          b.id === lastId && !cancelled ? badge('b-acc', 'New') : null),
        el('td', { text: whenText(b) }),
        el('td', { text: providerText(b) }),
        el('td', {}, cancelled ? badge('b-red', 'Cancelled') : badge('b-ok', 'Confirmed')),
        el('td', { class: 'mono small', text: fmt.dateOnly(b.created_at) }),
        el('td', { class: 'r' }, actions));
    }));
    for (const n of $('mine-rows').querySelectorAll('.badge.b-acc')) n.style.marginLeft = '6px';

    // Mobile cards (M5).
    $('mine-cards').replaceChildren(...mine.items.map((b) => {
      const cancelled = b.status === 'cancelled';
      const asking = mine.asking === b.id;
      return el('div', { class: `bk${cancelled ? ' cxl' : ''}` },
        el('div', { class: 'row-between', style: 'align-items:flex-start' },
          el('div', {},
            el('div', { class: 'bk-when', text: whenText(b) }),
            el('div', { class: 'small muted' }, `${providerText(b)} · `, el('span', { class: 'mono', text: b.id }))),
          cancelled ? badge('b-red', 'Cancelled') : badge('b-ok', 'Confirmed')),
        cancelled ? null : asking
          ? el('div', { class: 'bk-ask' },
            el('span', { class: 'small', text: 'Cancel this booking?' }),
            el('div', { class: 'row' },
              el('button', { type: 'button', class: 'btn outline sm', text: 'Keep', onclick: () => { mine.asking = null; renderMine(); } }),
              el('button', { type: 'button', class: 'btn destructive sm', text: 'Yes, cancel', onclick: (e) => cancelBooking(b, e.currentTarget) })))
          : el('button', { type: 'button', class: 'btn outline sm block', text: 'Cancel booking', onclick: () => { mine.asking = b.id; renderMine(); } }));
    }));
  }

  async function cancelBooking(b, button) {
    button.disabled = true;
    button.textContent = 'Cancelling…';
    try {
      const updated = await api('DELETE', `/bookings/${encodeURIComponent(b.id)}`);
      Object.assign(b, updated);
      const s = state.slotsById.get(b.slot_id);
      if (s) s.available = true;
      toast('Booking cancelled', s ? `${fmt.short(s.start)}, ${time(s.start)} with ${s.provider} is free again.` : 'The slot is free again.');
    } catch (err) {
      if (err.status === 401) return;
      if (err.status === 409) b.status = 'cancelled';
      else alertBox($('mine-alert'), 'a-red', "We couldn't cancel that booking", 'Please try again.');
    }
    mine.asking = null;
    renderMine();
  }

  // ---------- routing ----------
  function route() {
    updateKeyChip();
    if (!apiKey) { showKeyView(false); return; }
    const params = new URLSearchParams(location.search);
    if (params.get('view') === 'mine') { showMine(); return; }
    const id = params.get('booking');
    if (id) { openBookingFromUrl(id); return; }
    show('view-slots');
    renderSlotsView();
    loadSlots();
  }

  // ---------- wire up ----------
  hydrateIcons();
  $('tz').textContent = tzName;
  setSubmitting(false);

  $('key-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = $('api-key').value.trim();
    if (!value) {
      $('api-key-wrap').classList.add('err');
      $('api-key-msg').textContent = 'Paste your API key first.';
      $('api-key-msg').classList.add('err');
      return;
    }
    $('api-key-msg').textContent = 'Saved in this browser only.';
    $('api-key-msg').classList.remove('err');
    apiKey = value;
    store.set(KEY_STORAGE, value);
    route();
  });
  $('api-key').addEventListener('input', () => $('api-key-wrap').classList.remove('err'));

  const changeKey = () => { apiKey = ''; store.set(KEY_STORAGE, ''); showKeyView(false); };
  $('change-key').addEventListener('click', changeKey);
  $('tab-key').addEventListener('click', changeKey);

  for (const a of document.querySelectorAll('a[data-nav]')) {
    a.addEventListener('click', (e) => { e.preventDefault(); navigate(a.getAttribute('href')); });
  }
  window.addEventListener('popstate', route);

  $('provider-select').addEventListener('change', (e) => { state.provider = e.target.value; renderSlotsView(); });
  $('booking-form').addEventListener('submit', (e) => { e.preventDefault(); if (state.selectedId) book(state.selectedId); });
  $('sheet-scrim').addEventListener('click', clearSelection);
  for (const f of ['name', 'email']) {
    $(f).addEventListener('input', () => { $(`${f}-wrap`).classList.remove('err'); $(`${f}-error`).hidden = true; });
  }
  // The limit is per email, so a different email does not have to wait out the countdown.
  $('email').addEventListener('input', () => { if (state.retryTimer !== null) endCountdown(); });

  $('taken-book').addEventListener('click', () => {
    const id = nearbyPick;
    $('taken-dialog').close();
    if (!id) return;
    selectSlot(id);
    book(id);
  });
  $('taken-close').addEventListener('click', () => { $('taken-dialog').close(); clearSelection(); });
  $('taken-dialog').addEventListener('close', () => {
    const s = state.slotsById.get(state.selectedId);
    if (state.selectedId && (!s || !isOpen(s))) clearSelection();
  });
  $('taken-dialog').addEventListener('click', (e) => { if (e.target === $('taken-dialog')) $('taken-dialog').close(); });

  $('copy-id').addEventListener('click', () => copy(confirmed ? confirmed.id : '', null));
  $('copy-link').addEventListener('click', (e) => copy($('share-link').value, e.currentTarget, 'Copied'));
  $('copy-link-m').addEventListener('click', (e) => copy($('share-link').value, e.currentTarget, 'Copied'));
  $('book-another').addEventListener('click', () => navigate('/'));
  $('to-mine').addEventListener('click', () => {
    if (confirmed) $('mine-email').value = confirmed.email;
    navigate('/?view=mine');
  });
  $('lookup-back').addEventListener('click', () => navigate('/'));

  $('mine-form').addEventListener('submit', (e) => { e.preventDefault(); loadMine(true); });
  $('mine-more').addEventListener('click', () => loadMine(false));
  $('mine-more-m').addEventListener('click', () => loadMine(false));

  mobileQuery.addEventListener('change', () => {
    updateKeyChip();
    if (!mobileQuery.matches) closeSheet();
    else if (state.selectedId && !$('view-slots').hidden) openSheet();
  });

  route();
})();
