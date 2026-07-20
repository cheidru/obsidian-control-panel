'use strict';

const board = document.getElementById('board');
const emptyMsg = document.getElementById('empty');
const showArchived = document.getElementById('showArchived');
const newBtn = document.getElementById('newBtn');
const newDialog = document.getElementById('newDialog');
const newForm = document.getElementById('newForm');
const toastEl = document.getElementById('toast');

const themeBtn = document.getElementById('themeBtn');
const settingsBtn = document.getElementById('settingsBtn');
const settingsMenu = document.getElementById('settingsMenu');
const vaultPathItem = document.getElementById('vaultPathItem');
const vaultDialog = document.getElementById('vaultDialog');
const vaultForm = document.getElementById('vaultForm');
const projectsDirHint = document.getElementById('projectsDirHint');
const browseBtn = document.getElementById('browseBtn');

let state = { active: [], archived: [] };
const STATUSES = ['Planning', 'Active', 'On hold', 'Done'];

// --- theme -----------------------------------------------------------------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeBtn.textContent = theme === 'light' ? '🌙' : '☀️';
  themeBtn.title = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
}
applyTheme(localStorage.getItem('theme') || 'dark');
themeBtn.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  localStorage.setItem('theme', next);
  applyTheme(next);
});

// --- helpers ---------------------------------------------------------------
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer;
function toast(msg, isError) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', !!isError);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2600);
}

function badgeClass(status) {
  return (status || 'Active').replace(/\s+/g, '');
}

function fmtDate(d) {
  if (!d) return 'No start date';
  const date = new Date(d);
  if (isNaN(date)) return d;
  return 'Started ' + date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// debounce per-project saves
const saveTimers = {};
function debouncedSave(folder, archived, payload) {
  clearTimeout(saveTimers[folder]);
  saveTimers[folder] = setTimeout(async () => {
    try {
      await api('PUT', `/api/project/${encodeURIComponent(folder)}?archived=${archived ? 1 : 0}`, payload);
    } catch (e) {
      toast(e.message, true);
    }
  }, 350);
}

// --- rendering -------------------------------------------------------------
function card(p) {
  const el = document.createElement('article');
  el.className = 'card' + (p.archived ? ' archived' : '');

  const statusOptions = STATUSES.map(
    (s) => `<option ${s === p.status ? 'selected' : ''}>${s}</option>`
  ).join('');

  el.innerHTML = `
    <div class="card-head">
      <div>
        <h3 class="card-title"></h3>
        <div class="card-date"></div>
      </div>
      <select class="badge ${badgeClass(p.status)}" title="Change status">${statusOptions}</select>
    </div>
    <p class="desc"></p>
    <div class="progress-row">
      <div class="bar"><span style="width:${p.percent}%"></span></div>
      <span class="pct">${p.percent}%</span>
    </div>
    <input class="range" type="range" min="0" max="100" value="${p.percent}" ${p.archived ? 'disabled' : ''} />
    <div class="card-actions"></div>
  `;

  el.querySelector('.card-title').textContent = p.name;
  el.querySelector('.card-date').textContent = fmtDate(p.start_date);
  el.querySelector('.desc').textContent = p.description || '';

  // Clicking the card box (anywhere outside its interactive controls) opens the
  // project's main note "<folder>.md" in its default app.
  el.title = 'Open note';
  el.addEventListener('click', async (e) => {
    if (e.target.closest('button, select, input, textarea, .desc')) return;
    try {
      await api('POST', `/api/project/${encodeURIComponent(p.folder)}/note?archived=${p.archived ? 1 : 0}`);
      toast('Opening in Obsidian…');
    } catch (err) {
      toast(err.message, true);
    }
  });

  // status change
  const statusSel = el.querySelector('.badge');
  statusSel.addEventListener('change', () => {
    statusSel.className = 'badge ' + badgeClass(statusSel.value);
    p.status = statusSel.value;
    debouncedSave(p.folder, p.archived, { status: statusSel.value });
    toast('Status updated');
  });

  // percent slider
  const range = el.querySelector('.range');
  const fill = el.querySelector('.bar > span');
  const pctLabel = el.querySelector('.pct');
  range.addEventListener('input', () => {
    fill.style.width = range.value + '%';
    pctLabel.textContent = range.value + '%';
  });
  range.addEventListener('change', () => {
    p.percent = +range.value;
    debouncedSave(p.folder, p.archived, { percent: +range.value });
    toast('Progress saved');
  });

  // description: click to edit
  const desc = el.querySelector('.desc');
  if (!p.archived) {
    desc.title = 'Click to edit';
    desc.style.cursor = 'text';
    desc.addEventListener('click', () => editDescription(p, desc));
  }

  // actions
  const actions = el.querySelector('.card-actions');
  actions.appendChild(button('Open folder', 'btn small ghost', async () => {
    try { await api('POST', `/api/project/${encodeURIComponent(p.folder)}/open?archived=${p.archived ? 1 : 0}`); }
    catch (e) { toast(e.message, true); }
  }));

  if (p.archived) {
    actions.appendChild(button('Restore', 'btn small', async () => {
      try { await api('POST', `/api/project/${encodeURIComponent(p.folder)}/restore`); toast('Restored'); load(); }
      catch (e) { toast(e.message, true); }
    }));
  } else {
    actions.appendChild(button('Archive', 'btn small', async () => {
      try { await api('POST', `/api/project/${encodeURIComponent(p.folder)}/archive`); toast('Archived'); load(); }
      catch (e) { toast(e.message, true); }
    }));
  }

  return el;
}

function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function editDescription(p, descEl) {
  const ta = document.createElement('textarea');
  ta.value = p.description || '';
  ta.rows = 3;
  ta.maxLength = 500;
  ta.style.cssText = 'width:100%;font:inherit;background:var(--bg);color:var(--text);border:1px solid var(--accent);border-radius:8px;padding:8px;resize:vertical;';
  descEl.replaceWith(ta);
  ta.focus();
  const commit = () => {
    p.description = ta.value;
    const newDesc = document.createElement('p');
    newDesc.className = 'desc';
    newDesc.textContent = ta.value;
    newDesc.title = 'Click to edit';
    newDesc.style.cursor = 'text';
    newDesc.addEventListener('click', () => editDescription(p, newDesc));
    ta.replaceWith(newDesc);
    debouncedSave(p.folder, false, { description: ta.value });
    toast('Description saved');
  };
  ta.addEventListener('blur', commit);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ta.blur(); }
    if (e.key === 'Escape') { ta.value = p.description || ''; ta.blur(); }
  });
}

function render() {
  board.innerHTML = '';
  const active = state.active;
  const archived = showArchived.checked ? state.archived : [];

  if (active.length === 0 && archived.length === 0) {
    emptyMsg.hidden = false;
    return;
  }
  emptyMsg.hidden = true;

  active.forEach((p) => board.appendChild(card(p)));

  if (archived.length) {
    const label = document.createElement('div');
    label.className = 'section-label';
    label.textContent = 'Archived';
    board.appendChild(label);
    archived.forEach((p) => board.appendChild(card(p)));
  }
}

async function load() {
  try {
    state = await api('GET', '/api/projects');
    render();
  } catch (e) {
    toast(e.message, true);
  }
}

// --- settings menu ---------------------------------------------------------
let settings = { vaultPath: '', projectsDir: '', projectsDirname: '', locked: false };

function openMenu(open) {
  settingsMenu.hidden = !open;
  settingsBtn.setAttribute('aria-expanded', String(open));
}

settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  openMenu(settingsMenu.hidden);
});

document.addEventListener('click', (e) => {
  if (!settingsMenu.hidden && !settingsMenu.contains(e.target)) openMenu(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsMenu.hidden) openMenu(false);
});

function updateProjectsHint(vault) {
  const base = (vault || '').trim().replace(/[\\/]+$/, '');
  const sep = base.includes('/') && !base.includes('\\') ? '/' : '\\';
  projectsDirHint.textContent = base
    ? base + sep + settings.projectsDirname
    : settings.projectsDir;
}

vaultPathItem.addEventListener('click', async () => {
  openMenu(false);
  try {
    settings = await api('GET', '/api/settings');
  } catch (e) {
    return toast(e.message, true);
  }
  const input = vaultForm.querySelector('[name=vaultPath]');
  input.value = settings.vaultPath;
  input.disabled = settings.locked;
  browseBtn.disabled = settings.locked;
  document.getElementById('vaultSaveBtn').disabled = settings.locked;
  updateProjectsHint(settings.vaultPath);
  vaultDialog.showModal();
  input.focus();
  input.select();
});

vaultForm.querySelector('[name=vaultPath]').addEventListener('input', (e) => {
  updateProjectsHint(e.target.value);
});

// Opens the native Windows folder dialog on the machine running the server.
browseBtn.addEventListener('click', async () => {
  const input = vaultForm.querySelector('[name=vaultPath]');
  browseBtn.disabled = true;
  try {
    const res = await api('POST', '/api/browse-folder', { initialPath: input.value });
    if (res.cancelled) return;
    input.value = res.path;
    updateProjectsHint(res.path);
  } catch (e) {
    toast(e.message, true);
  } finally {
    browseBtn.disabled = false;
    input.focus();
  }
});

vaultForm.addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const next = new FormData(vaultForm).get('vaultPath');
  try {
    settings = await api('PUT', '/api/settings', { vaultPath: next });
    vaultDialog.close();
    toast('Vault path saved');
    load();
  } catch (err) {
    toast(err.message, true);
  }
});

// --- events ----------------------------------------------------------------
newBtn.addEventListener('click', () => {
  newForm.reset();
  newForm.querySelector('[name=start_date]').value = new Date().toISOString().slice(0, 10);
  newDialog.showModal();
});

newForm.addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const fd = new FormData(newForm);
  const payload = {
    name: fd.get('name'),
    start_date: fd.get('start_date'),
    status: fd.get('status'),
    description: fd.get('description'),
  };
  try {
    await api('POST', '/api/projects', payload);
    newDialog.close();
    toast('Project created');
    load();
  } catch (err) {
    toast(err.message, true);
  }
});

showArchived.addEventListener('change', render);

load();
