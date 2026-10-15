# AbsTransfer — Obsidian notes: PC ⇄ phone over Wi-Fi

**English** | [Русский](README.ru.md)

Copies the notes from your Obsidian vault on a PC into a **separate, second vault** on your phone,
and sends everything you change on the phone back to the PC. No cloud, accounts or subscriptions:
the PC and the phone talk directly whenever they are on the same Wi-Fi network.

- Your existing vaults on the phone are not touched.
- Nothing is ever erased for good: deleted files go to the vault's `.trash` folder
  (on the PC — the `.trash` folder inside the vault, on the phone — Obsidian's trash).
- If the same note was edited on both the PC and the phone, both versions are kept:
  the phone's version appears next to it as `Note (с телефона 2026-10-15 19-30).md`.
- If the PC is off or you are away from home, the phone works as usual, and your changes
  are sent once the PC is reachable again.

> The app's interface (PC window, phone page, plugin settings) is in Russian.

## Requirements

- A Windows 10/11 PC with [Python 3.8+](https://www.python.org/downloads/)
  (tick "Add python.exe to PATH" during installation). No other libraries are needed.
- Obsidian on the phone (Android or iPhone).
- The PC and the phone on the same Wi-Fi network.

## What's inside

| File / folder | Purpose |
|---|---|
| `AbsTransfer.bat` | starts the PC app (window with settings) |
| `pc/abs_server.py` | the sync server for the PC (Python 3, standard library only) |
| `plugin/` | the Obsidian plugin for the phone (`main.js`, `manifest.json`) |
| `tests/` | end-to-end sync test (`node tests/sync_test.cjs`, requires Node.js 18+) |

## Setup (once)

### On the PC
1. [Download the project](https://github.com/araluga/AbsTransfer/archive/refs/heads/main.zip),
   unzip it and run `AbsTransfer.bat`.
2. The app finds the vaults Obsidian knows about and picks the one that is open right now.
   To use another one, choose it from the drop-down list or pick a folder with **Обзор…** (Browse).
   You need the folder with your notes (it contains a hidden `.obsidian` folder), not the folder
   where `Obsidian.exe` is installed.
3. If Windows asks about the firewall, allow access on **private networks**.
   Your home Wi-Fi must be marked as a **private** network
   (Settings → Network & Internet → Wi-Fi → your network → Network profile: Private).
   If it isn't, the app shows a red warning.
4. The window shows an address like `http://192.168.1.10:8765/?code=abc123`.

### On the phone
1. Connect to the same Wi-Fi network and open that address in the browser.
2. Tap **«Скачать заметки для телефона»** (Download notes for the phone). The archive contains all
   notes and attachments from the PC plus the pre-configured plugin. Unzip it:
   - Android — into the Documents folder;
   - iPhone — into Files → On My iPhone → Obsidian.
3. In Obsidian open the vault switcher → **Open folder as vault** → choose the `Notes-from-PC`
   folder (the name can be changed in the PC app). If unzipping produced a folder inside a folder,
   choose the inner one — the one that contains the notes.
4. When asked whether you trust the author, tap **Trust author and enable plugins**.
5. Done: the notes are already on the phone, and from now on changes sync by themselves.

## How syncing works

The plugin contacts the PC:
- when the vault is opened and when you return to the app;
- 15 seconds after your edits;
- every 5 minutes (configurable);
- manually — the ⟳ ribbon icon or the «Синхронизировать с ПК сейчас» (Sync with PC now) command.

For every file the plugin remembers its version at the last sync and compares it with the
current versions on the phone and on the PC. Only the PC changed — the file is downloaded;
only the phone changed — it is uploaded; both changed — both versions are kept.

The PC app has to be running for syncing to happen. To start it automatically, put a shortcut
to `AbsTransfer.bat` into the Startup folder (Win+R → `shell:startup`).

Plugin settings (Settings → AbsTransfer): PC address and access code, check interval, and two
deletion switches — for example, you can forbid deleting files on the phone even when they
were deleted on the PC.

All notes and attachments (images, PDFs, etc.) are synced. Settings, themes and plugins
(`.obsidian`) stay separate on each device and are not transferred.

## Security

- The server is reachable only on the local network and answers only requests that carry the
  access code. Generate a new code with the **Новый** (New) button in the PC app.
- Traffic is plain HTTP without encryption — use it only on a home network you trust.
- The server never serves files outside the selected vault and does not touch hidden folders.

## Troubleshooting

- **The page doesn't open on the phone (blank/black screen)** — the Wi-Fi network is marked as
  public in Windows, or the firewall blocks Python. If a VPN is running, make sure the window
  shows an address like `192.168.x.x` rather than the VPN address; the app logs the PC's other
  addresses too.
- **«Нет связи с ПК»** (no connection to PC) — check that the PC app is running and the phone is
  on the same Wi-Fi. Sometimes the router gives the PC a new IP address — then fix the address
  in the plugin settings.
- **«Неверный код доступа»** (wrong access code) — the code in the plugin must match the code in
  the PC app.
- Server log: `pc/abs_server.log` (shows whether the phone connected).
- Headless mode: `python pc/abs_server.py --nogui "D:\path\to\vault"`.

## License

[MIT](LICENSE)
