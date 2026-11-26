# Scribe — standalone installer

The PC program is a separate download; nobody needs any other app to run it.

- `Scribe.iss` — Inno Setup script for the one-file install (`Scribe-Setup-<version>-win-x64.exe`). It installs the program, asks the Scribe passphrase once on its own page (used inside the install and never stored), and sets the program to start at sign-in.
- `install-pair.mjs` — the hidden helper the installer runs after copying files: pairs the PC, pins the Scribe Guard public key, registers the sign-in task, starts the program, and writes the status file the installer's last page reads.

The release workflow (`.github/workflows/release.yml`) stages the spoke tree into `stage/` (bundled `node.exe` v24.22.1 LTS, `bin/`, `src/hands/`, `hands-mcp/src/shared/`, this folder's `install-pair.mjs`), compiles the installer, and publishes it as its own GitHub release.
