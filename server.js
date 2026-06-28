'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// --- Configuration ---------------------------------------------------------
const ROOT = process.env.CONTROL_PANEL_DIR ||
  'C:\\Users\\chei\\ObsidianVault\\control panel';
const ARCHIVE_DIRNAME = '_archive';
const META_FILENAME = 'project.md';
const PORT = process.env.PORT || 4321;
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- Minimal YAML frontmatter parsing --------------------------------------
function parseFrontmatter(content) {
  const data = {};
  let body = content;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (match) {
    body = match[2];
    for (const rawLine of match[1].split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
      }
      data[key] = value;
    }
  }
  return { data, body };
}

function needsQuoting(value) {
  return /[:#\n"']/.test(value) || value.trim() !== value || value === '';
}

function stringifyFrontmatter(data, body) {
  let fm = '---\n';
  for (const [key, raw] of Object.entries(data)) {
    let value = raw == null ? '' : String(raw);
    if (needsQuoting(value)) {
      value = '"' + value.replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
    }
    fm += `${key}: ${value}\n`;
  }
  fm += '---\n';
  const trimmedBody = (body || '').replace(/^\s+/, '');
  return fm + (trimmedBody ? '\n' + trimmedBody : '\n');
}

// --- Project helpers -------------------------------------------------------
function ensureRoot() {
  fs.mkdirSync(ROOT, { recursive: true });
}

function sanitizeFolderName(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'Untitled Project';
}

function metaPath(folder, archived) {
  const base = archived ? path.join(ROOT, ARCHIVE_DIRNAME) : ROOT;
  return path.join(base, folder, META_FILENAME);
}

function readProject(folder, archived) {
  const file = metaPath(folder, archived);
  let data = {};
  let body = '';
  if (fs.existsSync(file)) {
    ({ data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8')));
  }
  return {
    folder,
    archived: !!archived,
    name: data.name || folder,
    start_date: data.start_date || '',
    percent: clampPercent(data.percent),
    status: data.status || 'Active',
    description: data.description || '',
    _body: body,
  };
}

function clampPercent(value) {
  let n = parseInt(value, 10);
  if (isNaN(n)) n = 0;
  return Math.max(0, Math.min(100, n));
}

function writeProject(proj, archived) {
  const dir = path.dirname(metaPath(proj.folder, archived));
  fs.mkdirSync(dir, { recursive: true });
  const data = {
    name: proj.name,
    start_date: proj.start_date,
    percent: proj.percent,
    status: proj.status,
    description: proj.description,
  };
  fs.writeFileSync(metaPath(proj.folder, archived), stringifyFrontmatter(data, proj._body));
}

function listProjects(archived) {
  const base = archived ? path.join(ROOT, ARCHIVE_DIRNAME) : ROOT;
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== ARCHIVE_DIRNAME && !e.name.startsWith('.'))
    .map((e) => readProject(e.name, archived))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// --- HTTP helpers ----------------------------------------------------------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

// --- API -------------------------------------------------------------------
async function handleApi(req, res, parts) {
  // parts: ['api', ...]
  const sub = parts[1];

  if (sub === 'projects' && req.method === 'GET') {
    return sendJSON(res, 200, {
      active: listProjects(false),
      archived: listProjects(true),
    });
  }

  if (sub === 'projects' && req.method === 'POST') {
    const body = await readBody(req);
    const name = (body.name || '').trim();
    if (!name) return sendJSON(res, 400, { error: 'Name is required' });
    const folder = sanitizeFolderName(name);
    const dir = path.join(ROOT, folder);
    if (fs.existsSync(dir)) return sendJSON(res, 409, { error: 'A project with that name already exists' });
    const proj = {
      folder,
      name,
      start_date: body.start_date || new Date().toISOString().slice(0, 10),
      percent: 0,
      status: body.status || 'Planning',
      description: body.description || '',
      _body: `# ${name}\n`,
    };
    writeProject(proj, false);
    return sendJSON(res, 201, readProject(folder, false));
  }

  if (sub === 'project') {
    const folder = decodeURIComponent(parts[2] || '');
    const action = parts[3];
    const archived = req.url.includes('archived=1') || false;

    if (req.method === 'PUT' && !action) {
      const existsActive = fs.existsSync(path.join(ROOT, folder));
      const isArchived = !existsActive && fs.existsSync(path.join(ROOT, ARCHIVE_DIRNAME, folder));
      if (!existsActive && !isArchived) return sendJSON(res, 404, { error: 'Project not found' });
      const proj = readProject(folder, isArchived);
      const body = await readBody(req);
      if (body.percent !== undefined) proj.percent = clampPercent(body.percent);
      if (body.status !== undefined) proj.status = String(body.status);
      if (body.description !== undefined) proj.description = String(body.description);
      if (body.start_date !== undefined) proj.start_date = String(body.start_date);
      writeProject(proj, isArchived);
      return sendJSON(res, 200, readProject(folder, isArchived));
    }

    if (req.method === 'POST' && action === 'archive') {
      const from = path.join(ROOT, folder);
      const to = path.join(ROOT, ARCHIVE_DIRNAME, folder);
      if (!fs.existsSync(from)) return sendJSON(res, 404, { error: 'Project not found' });
      fs.mkdirSync(path.join(ROOT, ARCHIVE_DIRNAME), { recursive: true });
      if (fs.existsSync(to)) return sendJSON(res, 409, { error: 'Already archived' });
      fs.renameSync(from, to);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && action === 'restore') {
      const from = path.join(ROOT, ARCHIVE_DIRNAME, folder);
      const to = path.join(ROOT, folder);
      if (!fs.existsSync(from)) return sendJSON(res, 404, { error: 'Archived project not found' });
      if (fs.existsSync(to)) return sendJSON(res, 409, { error: 'A live project with that name exists' });
      fs.renameSync(from, to);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && action === 'open') {
      const base = archived ? path.join(ROOT, ARCHIVE_DIRNAME) : ROOT;
      const dir = path.join(base, folder);
      if (!fs.existsSync(dir)) return sendJSON(res, 404, { error: 'Folder not found' });
      exec(`explorer "${dir}"`, () => {});
      return sendJSON(res, 200, { ok: true });
    }
  }

  return sendJSON(res, 404, { error: 'Unknown endpoint' });
}

// --- Server ----------------------------------------------------------------
ensureRoot();

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const parts = urlPath.split('/').filter(Boolean);
  if (parts[0] === 'api') {
    handleApi(req, res, parts).catch((err) => {
      console.error(err);
      sendJSON(res, 500, { error: String(err && err.message || err) });
    });
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n  Control Panel running at  http://localhost:${PORT}`);
  console.log(`  Projects folder:          ${ROOT}\n`);
});
