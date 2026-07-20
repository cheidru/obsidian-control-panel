# [Obsidian Control Panel](https://cheidru.github.io/obsidian-control-panel/)
A small local web interface to track projects stored as subfolders in your
Obsidian vault. Each project shows its name, start date, percent complete,
status, and a short description.

## Run

```
npm start
```

(or `node server.js`)

Then open http://localhost:4321 in your browser.

No dependencies to install — it uses only Node's built-in modules.

## How it works

- Projects live in `C:\Users\chei\ObsidianVault\control panel` (one folder per project).
- Each project's data is stored in `project.md` inside its folder, as YAML
  frontmatter — fully readable and editable from Obsidian:

  ```
  ---
  name: My Project
  start_date: 2026-06-29
  percent: 40
  status: Active
  description: Some notes
  ---

  # My Project
  ```

- **Archiving** moves a project folder into a `_archive` subfolder. Restoring
  moves it back. Toggle "Show archived" to see archived projects.
- The progress slider, status badge, and description save automatically.
- "Open folder" opens the project folder in Windows Explorer.

## Configuration

Override defaults with environment variables:

- `CONTROL_PANEL_DIR` — path to the projects folder.
- `PORT` — server port (default `4321`).
