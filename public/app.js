// Alafia Clinic booking page. Plain JS, no build step. Talks to the API on the same origin.
(() => {
  'use strict';

  const KEY_STORAGE = 'alafia.apiKey';
  const $ = (id) => document.getElementById(id);

  const state = {
    slots: [],
    provider: 'All',
    selectedId: null,
    submitting: false,
    retryTimer: null,
  };

  // ---------- storage (never throws) ----------
  function readKey() {
    try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; }
  }
  function writeKey(value) {
    try {
      if (value) localStorage.setItem(KEY_STORAGE, value);
      else localStorage.removeItem(KEY_STORAGE);
    } catch { /* storage blocked; key lives only for this page load */ }
    memoryKey = value;
  }
  let memoryKey = readKey();

  // ---------- API ----------
  class ApiError extends Error {
    constructor(status, message, headers) {
      super(message);
      this.status = status;
      this.headers = headers;
    }
  }

  async function api(method, path, { body, headers = {} } = {}) {
    const res = await fetch(path, {
      method,
      headers: {
        'X-API-Key': memoryKey,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) {
      if (res.status === 401) {
        showKeyView("That key wasn't accepted. Check it and try again.");
      }
      throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`, res.headers);
    }
    return data;
  }

  // ---------- formatting ----------
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtDayKey = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const fmtFull = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  function isPast(slot) { return new Date(slot.start).getTime() <= Date.now(); }
  function slotRange(slot) { return `${fmtTime.format(new Date(slot.start))} – ${fmtTime.format(new Date(slot.end))}`; }

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  // ---------- views ----------
  const views = ['view-key', 'view-slots', 'view-confirm', 'view-lookup-error'];
  function show(id) {
    for (const v of views) $(v).hidden = v !== id;
    window.scrollTo(0, 0);
  }

  function updateKeyChip() {
    $('key-chip').hidden = !memoryKey;
    $('key-last4').textContent = memoryKey.slice(-4);
  }

  function showKeyView(message) {
    $('key-error').hidden = !message;
    $('key-error').textContent = message || '';
    $('key-error').className = 'alert alert-error';
    $('api-key').value = '';
    show('view-key');
    $('api-key').focus();
  }

  function showAlert(node, kind, text) {
    node.className = `alert alert-${kind}`;
    node.textContent = text;
    node.hidden = false;
  }
  function hideAlert(node) { node.hidden = true; node.textContent = ''; }

  // ---------- slots ----------
  async function loadSlots() {
    $('slots-loading').hidden = false;
    $('slots-empty').hidden = true;
    hideAlert($('page-alert'));
    try {
      const data = await api('GET', '/slots');
      state.slots = data.slots;
      if (state.selectedId && !state.slots.some((s) => s.id === state.selectedId)) clearSelection();
      renderFilters();
      renderSlots();
    } catch (err) {
      if (err.status !== 401) showAlert($('page-alert'), 'error', "We couldn't load the slots. Refresh the page to try again.");
    } finally {
      $('slots-loading').hidden = true;
    }
  }

  function providers() {
    return ['All', ...[...new Set(state.slots.map((s) => s.provider))].sort()];
  }

  function renderFilters() {
    const list = providers();
    if (!list.includes(state.provider)) state.provider = 'All';
    const tabs = $('provider-tabs');
    tabs.replaceChildren(...list.map((p) => el('button', {
      type: 'button',
      class: 'tab',
      role: 'tab',
      'aria-selected': String(p === state.provider),
      text: p,
      onclick: () => setProvider(p),
    })));
    const select = $('provider-select');
    select.replaceChildren(...list.map((p) => el('option', { value: p, text: p, selected: p === state.provider })));
  }

  function setProvider(p) {
    state.provider = p;
    renderFilters();
    renderSlots();
  }

  function slotCard(slot, { onPick, compact = false } = {}) {
    const past = isPast(slot);
    const booked = !slot.available;
    const selected = slot.id === state.selectedId;
    let badge = el('span', { class: 'badge badge-available', text: 'Available' });
    if (past) badge = el('span', { class: 'badge badge-past', text: 'Past' });
    else if (booked) badge = el('span', { class: 'badge badge-booked', text: 'Booked' });
    else if (selected) badge = el('span', { class: 'badge badge-selected', text: 'Selected' });

    const label = `${slot.provider}, ${fmtFull.format(new Date(slot.start))}${past ? ', past' : booked ? ', booked' : ''}`;
    return el('button', {
      type: 'button',
      class: 'slot',
      disabled: past || booked,
      'aria-pressed': compact ? null : String(selected),
      'aria-label': label,
      onclick: () => (onPick || selectSlot)(slot.id),
    },
    el('span', { class: 'slot-time', text: compact ? fmtFull.format(new Date(slot.start)) : fmtTime.format(new Date(slot.start)) }),
    compact ? null : el('span', { class: 'slot-range', text: slotRange(slot) }),
    el('span', { class: 'slot-provider', text: slot.provider }),
    badge);
  }

  function renderSlots() {
    const visible = state.slots.filter((s) => state.provider === 'All' || s.provider === state.provider);
    const groups = new Map();
    for (const slot of visible) {
      const key = fmtDayKey.format(new Date(slot.start));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(slot);
    }
    const nodes = [...groups.values()].map((slots) => el('section', { class: 'day' },
      el('h2', { class: 'day-title', text: fmtDay.format(new Date(slots[0].start)) }),
      el('div', { class: 'slot-grid' }, ...slots.map((s) => slotCard(s)))));
    $('slot-groups').replaceChildren(...nodes);
    $('slots-empty').hidden = visible.length > 0;
  }

  function selectSlot(id) {
    state.selectedId = id;
    const slot = state.slots.find((s) => s.id === id);
    $('form-placeholder').hidden = true;
    $('booking-form').hidden = false;
    $('selected-time').textContent = fmtFull.format(new Date(slot.start));
    $('selected-provider').textContent = `${slot.provider} · ${slotRange(slot)}`;
    hideAlert($('form-alert'));
    clearFieldErrors();
    renderSlots();
    if (window.matchMedia('(max-width: 860px)').matches) $('form-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('name').focus({ preventScroll: true });
  }

  function clearSelection() {
    state.selectedId = null;
    $('form-placeholder').hidden = false;
    $('booking-form').hidden = true;
    renderSlots();
  }

  // ---------- booking ----------
  function clearFieldErrors() {
    for (const f of ['name', 'email', 'slot_id']) {
      const err = $(`${f}-error`);
      err.hidden = true;
      err.textContent = '';
      const input = $(f);
      if (input) input.removeAttribute('aria-invalid');
    }
  }

  function showFieldError(message) {
    const field = ['slot_id', 'name', 'email'].find((f) => message.startsWith(f));
    if (!field) {
      showAlert($('form-alert'), 'error', message);
      return;
    }
    const err = $(`${field}-error`);
    err.textContent = message;
    err.hidden = false;
    const input = $(field);
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', `${field}-error`);
      input.focus();
    }
  }

  function setSubmitting(on, label) {
    state.submitting = on;
    const btn = $('book-btn');
    btn.disabled = on || state.retryTimer !== null;
    btn.textContent = label || (on ? 'Booking…' : 'Confirm booking');
  }

  // One Idempotency-Key per submit; an automatic retry after a network failure reuses it.
  async function postBooking(body) {
    const key = crypto.randomUUID();
    const headers = { 'Idempotency-Key': key };
    try {
      return await api('POST', '/bookings', { body, headers });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      await new Promise((r) => setTimeout(r, 800));
      return api('POST', '/bookings', { body, headers });
    }
  }

  async function submitBooking(event) {
    event.preventDefault();
    if (state.submitting || !state.selectedId) return;
    hideAlert($('form-alert'));
    clearFieldErrors();
    const body = { slot_id: state.selectedId, name: $('name').value, email: $('email').value };
    setSubmitting(true);
    try {
      const booking = await postBooking(body);
      const slot = state.slots.find((s) => s.id === booking.slot_id);
      $('booking-form').reset();
      state.selectedId = null;
      showConfirmation(booking, slot);
      history.pushState({}, '', `?booking=${encodeURIComponent(booking.id)}`);
    } catch (err) {
      handleBookingError(err);
    } finally {
      if (state.retryTimer === null) setSubmitting(false);
      else state.submitting = false; // the 429 countdown owns the button until it ends
    }
  }

  function handleBookingError(err) {
    if (!(err instanceof ApiError)) {
      showAlert($('form-alert'), 'error', "We couldn't reach the booking service. Check your connection and try again.");
      return;
    }
    switch (err.status) {
      case 400:
        showFieldError(err.message);
        break;
      case 401:
        break; // already sent to the key screen
      case 404:
        showAlert($('form-alert'), 'error', 'That slot no longer exists.');
        loadSlots();
        break;
      case 409:
        markTaken(state.selectedId);
        openTakenDialog(state.selectedId);
        break;
      case 429:
        startRetryCountdown(Number.parseInt(err.headers.get('Retry-After'), 10));
        break;
      default:
        showAlert($('form-alert'), 'error', 'Something went wrong on our side. Please try again in a moment.');
    }
  }

  function markTaken(id) {
    const slot = state.slots.find((s) => s.id === id);
    if (slot) slot.available = false;
    renderSlots();
  }

  function openTakenDialog(takenId) {
    const taken = state.slots.find((s) => s.id === takenId);
    const t = taken ? new Date(taken.start).getTime() : Date.now();
    const open = state.slots
      .filter((s) => s.available && !isPast(s) && s.id !== takenId)
      .sort((a, b) => Math.abs(new Date(a.start) - t) - Math.abs(new Date(b.start) - t))
      .slice(0, 2);
    $('taken-body').textContent = open.length
      ? 'Your name and email are still filled in. These times are close by:'
      : 'Your name and email are still filled in. There are no other open times right now.';
    $('nearby').replaceChildren(...open.map((s) => slotCard(s, {
      compact: true,
      onPick: (id) => { $('taken-dialog').close(); selectSlot(id); },
    })));
    $('taken-dialog').showModal();
    loadSlots();
  }

  function startRetryCountdown(seconds) {
    let left = Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
    clearInterval(state.retryTimer);
    const tick = () => {
      const mm = Math.floor(left / 60);
      const ss = String(left % 60).padStart(2, '0');
      showAlert($('form-alert'), 'warning', `Too many attempts. Try again in ${left} second${left === 1 ? '' : 's'}.`);
      $('book-btn').textContent = `Try again in ${mm}:${ss}`;
      $('book-btn').disabled = true;
      if (left <= 0) {
        clearInterval(state.retryTimer);
        state.retryTimer = null;
        hideAlert($('form-alert'));
        setSubmitting(false);
      }
      left -= 1;
    };
    state.retryTimer = setInterval(tick, 1000);
    tick();
  }

  // ---------- confirmation ----------
  function showConfirmation(booking, slot) {
    const status = booking.status;
    const badge = $('confirm-badge');
    badge.className = `badge badge-${status}`;
    badge.textContent = status === 'confirmed' ? 'Confirmed' : 'Cancelled';
    $('confirm-title').replaceChildren(
      status === 'confirmed' ? "You're " : 'This booking was ',
      el('em', { text: status === 'confirmed' ? 'booked' : 'cancelled' }),
    );
    const when = slot ? fmtFull.format(new Date(slot.start)) : '';
    $('confirm-when').textContent = slot ? `${when} with ${slot.provider}.` : '';
    $('confirm-when').hidden = !slot;
    $('c-id').textContent = booking.id;
    $('c-provider').textContent = slot ? slot.provider : '—';
    $('c-time').textContent = slot ? `${fmtDay.format(new Date(slot.start))}, ${slotRange(slot)}` : '—';
    $('c-name').textContent = booking.name;
    $('c-email').textContent = booking.email;
    $('c-status').textContent = status;
    const url = new URL(location.href);
    url.search = `?booking=${encodeURIComponent(booking.id)}`;
    url.hash = '';
    $('share-link').value = url.toString();
    $('copy-link').textContent = 'Copy';
    show('view-confirm');
  }

  async function openBookingFromUrl(id) {
    try {
      const [booking, slots] = await Promise.all([
        api('GET', `/bookings/${encodeURIComponent(id)}`),
        api('GET', '/slots').then((d) => d.slots).catch(() => []),
      ]);
      state.slots = slots;
      showConfirmation(booking, slots.find((s) => s.id === booking.slot_id));
    } catch (err) {
      if (err.status === 401) return;
      show('view-lookup-error');
    }
  }

  function goToSlots() {
    history.pushState({}, '', location.pathname);
    show('view-slots');
    loadSlots();
  }

  // ---------- routing ----------
  function route() {
    updateKeyChip();
    if (!memoryKey) {
      showKeyView('');
      return;
    }
    const id = new URLSearchParams(location.search).get('booking');
    if (id) {
      openBookingFromUrl(id);
    } else {
      show('view-slots');
      loadSlots();
    }
  }

  // ---------- wire up ----------
  $('tz').textContent = tz;

  $('key-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = $('api-key').value.trim();
    if (!value) {
      showAlert($('key-error'), 'error', 'Enter your API key.');
      return;
    }
    writeKey(value);
    route();
  });

  $('change-key').addEventListener('click', () => {
    writeKey('');
    updateKeyChip();
    showKeyView('');
  });

  $('provider-select').addEventListener('change', (e) => setProvider(e.target.value));
  $('booking-form').addEventListener('submit', submitBooking);
  $('clear-selection').addEventListener('click', clearSelection);
  for (const f of ['name', 'email']) {
    $(f).addEventListener('input', () => {
      $(f).removeAttribute('aria-invalid');
      $(`${f}-error`).hidden = true;
    });
  }
  $('taken-close').addEventListener('click', () => { $('taken-dialog').close(); clearSelection(); });
  $('book-another').addEventListener('click', goToSlots);
  $('lookup-back').addEventListener('click', goToSlots);
  $('copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('share-link').value);
      $('copy-link').textContent = 'Copied';
    } catch {
      $('share-link').select();
    }
  });
  window.addEventListener('popstate', route);

  route();
})();
