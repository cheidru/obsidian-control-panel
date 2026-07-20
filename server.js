'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');

// --- Configuration ---------------------------------------------------------
const DEFAULT_VAULT_PATH = 'C:\\Users\\chei\\ObsidianVault';
const PROJECTS_DIRNAME = 'control panel';
const CONFIG_FILE = path.join(__dirname, 'config.json');
const ARCHIVE_DIRNAME = '_archive';
// Each project's metadata lives in "<folder>_info.md" inside its folder.
// Older projects used a fixed "project.md"; those are migrated on access.
const LEGACY_META_FILENAME = 'project.md';
const metaFilename = (folder) => `${folder}_info.md`;
const PORT = process.env.PORT || 4321;
const PUBLIC_DIR = path.join(__dirname, 'public');

// The projects folder lives inside the vault. CONTROL_PANEL_DIR, when set,
// overrides it wholesale and makes the vault path read-only in the UI.
const ROOT_OVERRIDE = process.env.CONTROL_PANEL_DIR || '';

function readConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg && typeof cfg === 'object') return cfg;
  } catch (e) {
    // missing or malformed config falls back to defaults
  }
  return {};
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

let vaultPath = readConfig().vaultPath || DEFAULT_VAULT_PATH;

// The projects root is re-derived whenever the vault path changes, so helpers
// read it through this getter rather than capturing it once.
function getRoot() {
  return ROOT_OVERRIDE || path.join(vaultPath, PROJECTS_DIRNAME);
}

// --- Native folder picker --------------------------------------------------
// The browser cannot reveal an absolute path, but the server runs on the same
// machine, so it opens the real Windows folder dialog on the user's desktop.
let pickerBusy = false;

// Title of the browser window hosting the panel, matched as a substring so it
// works across browsers ("Project Control Panel - Google Chrome", etc.).
const PANEL_WINDOW_TITLE = 'Project Control Panel';

function pickFolder(initialPath) {
  const start = String(initialPath || '').replace(/'/g, "''");
  const title = PANEL_WINDOW_TITLE.replace(/'/g, "''");

  // Owning the dialog to the panel's own window makes the shell centre it over
  // that window and keep it above it, instead of centring on the screen.
  const ownerType = `
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class PanelWindow : IWin32Window {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);

  IntPtr handle;
  public IntPtr Handle { get { return handle; } }

  public static IntPtr Find(string titlePart) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      if (sb.ToString().IndexOf(titlePart, StringComparison.OrdinalIgnoreCase) >= 0) {
        found = h;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public PanelWindow(string titlePart) {
    // Fall back to whatever window is in front: the user just clicked the
    // browse button there, so it is the panel window even if the tab title
    // is not reflected in the window caption.
    handle = Find(titlePart);
    if (handle == IntPtr.Zero) handle = GetForegroundWindow();
    if (handle != IntPtr.Zero) SetForegroundWindow(handle);
  }
}
`.trim();

  const script = [
    // Add-Type emits progress records to stderr as CLIXML; silence them.
    "$ProgressPreference = 'SilentlyContinue'",
    // Emit UTF-8 so non-ASCII paths (e.g. Cyrillic) survive the pipe to Node,
    // which decodes stdout as UTF-8. The console otherwise uses the OEM
    // codepage (CP866 on a Russian Windows), which would arrive as mojibake.
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    "Add-Type -ReferencedAssemblies 'System.Windows.Forms','System.Drawing' -TypeDefinition @'",
    ownerType,
    "'@",
    `$owner = New-Object PanelWindow('${title}')`,
    '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dlg.Description = 'Select your Obsidian vault folder'",
    '$dlg.ShowNewFolderButton = $true',
    `$dlg.SelectedPath = '${start}'`,
    'if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.SelectedPath) }',
  ].join('\n');

  // -EncodedCommand (UTF-16LE base64) sidesteps Windows command-line quoting,
  // which mangles a multi-line script passed via -Command.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-EncodedCommand', encoded],
      { timeout: 300000, encoding: 'utf8' },
      (err, stdout) => {
        // stderr is ignored on purpose: PowerShell routinely writes CLIXML
        // progress noise there even when the dialog succeeds.
        if (err) return reject(err);
        const picked = String(stdout).trim();
        resolve(picked || null); // null = user cancelled
      }
    );
  });
}

// Opens an obsidian:// URI and moves the Obsidian window over the panel window
// (same position and size), raised to the front. Fire-and-forget: repositioning
// polls for Obsidian's window for a few seconds, so we don't await it.
function openNoteInObsidian(uri, noteBase) {
  if (process.platform !== 'win32') {
    exec(`xdg-open "${uri}" || open "${uri}"`, () => {});
    return;
  }
  const u = String(uri).replace(/'/g, "''");
  const prefer = String(noteBase || '').replace(/'/g, "''");
  const title = PANEL_WINDOW_TITLE.replace(/'/g, "''");

  const winType = `
using System;
using System.Text;
using System.Runtime.InteropServices;

public class WinCtl {
  public struct RECT { public int Left, Top, Right, Bottom; }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

  static readonly IntPtr TOPMOST = new IntPtr(-1);
  static readonly IntPtr NOTOPMOST = new IntPtr(-2);
  const uint SWP_SHOW = 0x0040;
  const uint SWP_NOSIZE = 0x0001;

  public static IntPtr FindByTitle(string part) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      if (sb.ToString().IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // First visible window owned by one of the given PIDs (Obsidian is Electron,
  // so it spawns several processes); prefer one whose title names the note.
  public static IntPtr FindByPids(int[] pids, string prefer) {
    IntPtr best = IntPtr.Zero, pref = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      bool m = false; foreach (int p in pids) { if ((uint)p == pid) { m = true; break; } }
      if (!m) return true;
      StringBuilder sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      if (sb.Length == 0) return true;
      if (best == IntPtr.Zero) best = h;
      if (prefer.Length > 0 && sb.ToString().IndexOf(prefer, StringComparison.OrdinalIgnoreCase) >= 0) { pref = h; return false; }
      return true;
    }, IntPtr.Zero);
    return pref != IntPtr.Zero ? pref : best;
  }

  // Move Obsidian to the panel's top-left and raise it to the front, WITHOUT
  // resizing (SWP_NOSIZE) — forcing a size fights Obsidian's own layout on load.
  public static void Place(IntPtr h, int x, int y) {
    ShowWindow(h, 9); // SW_RESTORE (un-minimise)
    // Topmost toggle raises it above the panel without needing foreground rights.
    SetWindowPos(h, TOPMOST, x, y, 0, 0, SWP_SHOW | SWP_NOSIZE);
    SetWindowPos(h, NOTOPMOST, x, y, 0, 0, SWP_SHOW | SWP_NOSIZE);
    SetForegroundWindow(h);
  }
}
`.trim();

  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Add-Type -TypeDefinition @'",
    winType,
    "'@",
    // Capture the panel window's rectangle before launching Obsidian steals focus.
    `$panel = [WinCtl]::FindByTitle('${title}')`,
    'if ($panel -eq [IntPtr]::Zero) { $panel = [WinCtl]::GetForegroundWindow() }',
    '$r = New-Object WinCtl+RECT',
    '[void][WinCtl]::GetWindowRect($panel, [ref]$r)',
    '$x = $r.Left; $y = $r.Top',
    `Start-Process '${u}'`,
    // Wait for the Obsidian window (cold start can take a few seconds).
    '$obs = [IntPtr]::Zero',
    '$deadline = (Get-Date).AddSeconds(12)',
    'while ((Get-Date) -lt $deadline -and $obs -eq [IntPtr]::Zero) {',
    '  Start-Sleep -Milliseconds 300',
    '  $ids = @()',
    '  try { $ids = @(Get-Process -Name Obsidian -ErrorAction Stop | ForEach-Object { $_.Id }) } catch {}',
    `  if ($ids.Count -gt 0) { $obs = [WinCtl]::FindByPids($ids, '${prefer}') }`,
    '}',
    'if ($obs -ne [IntPtr]::Zero) { [WinCtl]::Place($obs, $x, $y) }',
  ].join('\n');

  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  execFile(
    'powershell.exe',
    ['-NoProfile', '-STA', '-EncodedCommand', encoded],
    { timeout: 30000 },
    (err) => { if (err) console.error('open note in Obsidian:', err.message); }
  );
}

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
  fs.mkdirSync(getRoot(), { recursive: true });
}

function sanitizeFolderName(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'Untitled Project';
}

function metaPath(folder, archived) {
  const base = archived ? path.join(getRoot(), ARCHIVE_DIRNAME) : getRoot();
  const dir = path.join(base, folder);
  const target = path.join(dir, metaFilename(folder));
  // Migrate a legacy project.md to the new per-project name on first access.
  if (!fs.existsSync(target)) {
    const legacy = path.join(dir, LEGACY_META_FILENAME);
    if (fs.existsSync(legacy)) {
      try {
        fs.renameSync(legacy, target);
      } catch (e) {
        return legacy; // rename failed: keep reading/writing the old file
      }
    }
  }
  return target;
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
  const base = archived ? path.join(getRoot(), ARCHIVE_DIRNAME) : getRoot();
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

  if (sub === 'settings' && req.method === 'GET') {
    return sendJSON(res, 200, {
      vaultPath,
      projectsDir: getRoot(),
      projectsDirname: PROJECTS_DIRNAME,
      locked: !!ROOT_OVERRIDE,
    });
  }

  if (sub === 'browse-folder' && req.method === 'POST') {
    if (process.platform !== 'win32') {
      return sendJSON(res, 501, { error: 'Folder picker is only available on Windows' });
    }
    if (ROOT_OVERRIDE) {
      return sendJSON(res, 409, {
        error: 'Vault path is fixed by the CONTROL_PANEL_DIR environment variable',
      });
    }
    if (pickerBusy) {
      return sendJSON(res, 409, { error: 'A folder picker is already open' });
    }
    const body = await readBody(req);
    pickerBusy = true;
    try {
      const picked = await pickFolder(body.initialPath || vaultPath);
      return sendJSON(res, 200, { path: picked, cancelled: picked === null });
    } catch (e) {
      return sendJSON(res, 500, { error: 'Could not open folder picker: ' + (e.message || e) });
    } finally {
      pickerBusy = false;
    }
  }

  if (sub === 'settings' && req.method === 'PUT') {
    if (ROOT_OVERRIDE) {
      return sendJSON(res, 409, {
        error: 'Vault path is fixed by the CONTROL_PANEL_DIR environment variable',
      });
    }
    const body = await readBody(req);
    const next = String(body.vaultPath || '').trim().replace(/[\\/]+$/, '');
    if (!next) return sendJSON(res, 400, { error: 'Vault path is required' });
    if (!path.isAbsolute(next)) return sendJSON(res, 400, { error: 'Vault path must be absolute' });
    let stat;
    try {
      stat = fs.statSync(next);
    } catch (e) {
      return sendJSON(res, 400, { error: 'Folder does not exist: ' + next });
    }
    if (!stat.isDirectory()) return sendJSON(res, 400, { error: 'Not a folder: ' + next });

    vaultPath = next;
    writeConfig({ ...readConfig(), vaultPath });
    ensureRoot();
    return sendJSON(res, 200, {
      vaultPath,
      projectsDir: getRoot(),
      projectsDirname: PROJECTS_DIRNAME,
      locked: false,
    });
  }

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
    const dir = path.join(getRoot(), folder);
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
      const existsActive = fs.existsSync(path.join(getRoot(), folder));
      const isArchived = !existsActive && fs.existsSync(path.join(getRoot(), ARCHIVE_DIRNAME, folder));
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
      const from = path.join(getRoot(), folder);
      const to = path.join(getRoot(), ARCHIVE_DIRNAME, folder);
      if (!fs.existsSync(from)) return sendJSON(res, 404, { error: 'Project not found' });
      fs.mkdirSync(path.join(getRoot(), ARCHIVE_DIRNAME), { recursive: true });
      if (fs.existsSync(to)) return sendJSON(res, 409, { error: 'Already archived' });
      fs.renameSync(from, to);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && action === 'restore') {
      const from = path.join(getRoot(), ARCHIVE_DIRNAME, folder);
      const to = path.join(getRoot(), folder);
      if (!fs.existsSync(from)) return sendJSON(res, 404, { error: 'Archived project not found' });
      if (fs.existsSync(to)) return sendJSON(res, 409, { error: 'A live project with that name exists' });
      fs.renameSync(from, to);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && action === 'open') {
      const base = archived ? path.join(getRoot(), ARCHIVE_DIRNAME) : getRoot();
      const dir = path.join(base, folder);
      if (!fs.existsSync(dir)) return sendJSON(res, 404, { error: 'Folder not found' });
      exec(`explorer "${dir}"`, () => {});
      return sendJSON(res, 200, { ok: true });
    }

    // Open the project's main note "<folder>.md" in Obsidian, raising Obsidian
    // over the panel window. The note is created with a heading if missing.
    if (req.method === 'POST' && action === 'note') {
      const base = archived ? path.join(getRoot(), ARCHIVE_DIRNAME) : getRoot();
      const dir = path.join(base, folder);
      if (!fs.existsSync(dir)) return sendJSON(res, 404, { error: 'Folder not found' });
      const file = path.join(dir, `${folder}.md`);
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, `# ${readProject(folder, archived).name}\n`);
      }
      // "path" targets the file by absolute path, so Obsidian opens it in
      // whichever registered vault contains it — no vault name needed.
      const uri = 'obsidian://open?path=' + encodeURIComponent(file);
      openNoteInObsidian(uri, folder);
      return sendJSON(res, 200, { ok: true, file, uri });
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
  console.log(`  Projects folder:          ${getRoot()}\n`);
});
