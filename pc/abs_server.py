#!/usr/bin/env python3
"""AbsTransfer — сервер синхронизации заметок Obsidian между ПК и телефоном.

Запускается на ПК, раздаёт файлы хранилища по локальной сети (Wi-Fi).
На телефоне плагин AbsTransfer (папка plugin/) сам забирает изменения с ПК
и отправляет свои. Только стандартная библиотека Python 3.8+.

Запуск с окном:     python abs_server.py
Без окна (консоль): python abs_server.py --nogui
"""
import hashlib
import json
import os
import queue
import secrets
import shutil
import socket
import sys
import tempfile
import threading
import time
import urllib.parse
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(APP_DIR, "config.json")
PLUGIN_DIR = os.path.normpath(os.path.join(APP_DIR, "..", "plugin"))
PLUGIN_ID = "abs-transfer"
TRASH_DIR = ".trash"  # та же папка корзины, что использует сам Obsidian
BAD_CHARS = set('<>:"\\|?*') | {chr(i) for i in range(32)}
WIN_RESERVED = {"CON", "PRN", "AUX", "NUL"} | {"COM%d" % i for i in range(1, 10)} | {"LPT%d" % i for i in range(1, 10)}

DEFAULT_CONFIG = {
    "vault_path": "",
    "port": 8765,
    "token": "",
    "phone_vault_name": "Notes-from-PC",
}

_log_queue = queue.Queue()
WARNINGS = []  # предупреждения о настройке сети, показываются в окне красным


LOG_PATH = os.path.join(APP_DIR, "abs_server.log")
try:
    if os.path.getsize(LOG_PATH) > 1 << 20:
        os.replace(LOG_PATH, LOG_PATH + ".old")
except OSError:
    pass


def log(msg):
    line = time.strftime("%H:%M:%S ") + msg
    _log_queue.put(line)
    if "--nogui" in sys.argv:
        print(line, flush=True)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d ") + line + "\n")
    except OSError:
        pass


def new_token():
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    return "".join(secrets.choice(alphabet) for _ in range(6))


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg.update(json.load(f))
    except (OSError, ValueError):
        pass
    if not cfg["token"]:
        cfg["token"] = new_token()
        save_config(cfg)
    if not cfg["vault_path"] or not os.path.isdir(cfg["vault_path"]):
        found = find_vaults()
        cfg["vault_path"] = found[0] if found else ""
    return cfg


def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def find_vaults():
    """Хранилища, которые знает Obsidian на этом ПК: сначала открытое, потом недавние."""
    registry = os.path.join(os.environ.get("APPDATA", ""), "obsidian", "obsidian.json")
    try:
        with open(registry, encoding="utf-8") as f:
            vaults = json.load(f).get("vaults", {}).values()
    except (OSError, ValueError, AttributeError):
        return []
    vaults = [v for v in vaults if isinstance(v, dict) and os.path.isdir(v.get("path", ""))]
    vaults.sort(key=lambda v: (not v.get("open"), -v.get("ts", 0)))
    return [os.path.normpath(v["path"]) for v in vaults]


def check_vault(path):
    """Пустая строка — папка подходит, иначе текст проблемы."""
    if not path or not os.path.isdir(path):
        return "Папка не найдена: " + (path or "(не выбрана)")
    if os.path.isfile(os.path.join(path, "Obsidian.exe")):
        return "Это папка самой программы Obsidian, а не хранилища с заметками."
    if not os.path.isdir(os.path.join(path, ".obsidian")):
        return "В этой папке нет .obsidian — похоже, это не хранилище Obsidian."
    return ""


def lan_ips():
    """IPv4-адреса ПК, самые вероятные для домашнего Wi-Fi — первыми.

    VPN (Happ, Radmin и т.п.) часто забирают маршрут по умолчанию, поэтому
    «адрес выхода в интернет» для телефона не годится: берём адреса всех
    интерфейсов и ставим вперёд типичные домашние сети 192.168.x.x.
    """
    ips = set()
    try:
        ips |= {i[4][0] for i in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)}
    except OSError:
        pass
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # пакеты не отправляются, просто выбираем интерфейс
        ips.add(s.getsockname()[0])
    except OSError:
        pass
    finally:
        s.close()

    def rank(ip):
        a, b = (int(x) for x in ip.split(".")[:2])
        if a == 192 and b == 168:
            return 0
        if a == 172 and 16 <= b <= 31:
            return 1
        if a == 10:
            return 2
        return 3

    ips = [ip for ip in ips if not ip.startswith(("127.", "169.254.", "0."))]
    return sorted(ips, key=lambda ip: (rank(ip), ip)) or ["127.0.0.1"]


def local_ip():
    return lan_ips()[0]


def public_networks(ip):
    """Сети с адресом ip, отмеченные в Windows как «Общедоступные» — в них брандмауэр режет телефон."""
    if os.name != "nt":
        return []
    import subprocess
    script = (
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-NetConnectionProfile | ForEach-Object { "
        "[pscustomobject]@{Name=$_.Name; Category=[int]$_.NetworkCategory; "
        "Ips=@(Get-NetIPAddress -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4 "
        "-ErrorAction SilentlyContinue | ForEach-Object IPAddress)} } | ConvertTo-Json"
    )
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command", script],
            capture_output=True, timeout=20, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout
        data = json.loads(out.decode("utf-8", "replace") or "[]")
    except (OSError, ValueError, subprocess.SubprocessError):
        return []
    if isinstance(data, dict):
        data = [data]
    # Category: 0 — общедоступная, 1 — частная, 2 — доменная
    return [p.get("Name") for p in data if p.get("Category") == 0 and ip in (p.get("Ips") or [])]


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class Conflict(Exception):
    def __init__(self, current):
        super().__init__("conflict")
        self.current = current


class Vault:
    """Хранилище на ПК. Скрытые файлы и папки (.obsidian, .trash, …) не синхронизируются."""

    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.lock = threading.Lock()
        self._cache = {}  # rel -> ((mtime_ns, size), hash)

    def abs_path(self, rel):
        rel = (rel or "").replace("\\", "/")
        parts = rel.split("/")
        if not rel or any(not p or p.startswith(".") or p.endswith((" ", ".")) or BAD_CHARS & set(p)
                          or p.split(".")[0].upper() in WIN_RESERVED for p in parts):
            raise ValueError("недопустимый путь: " + rel)
        full = os.path.abspath(os.path.join(self.root, *parts))
        if os.path.commonpath([full, self.root]) != self.root:
            raise ValueError("путь вне хранилища: " + rel)
        return full

    def _hash_cached(self, rel, full):
        try:
            st = os.stat(full)
        except FileNotFoundError:
            return None, None
        key = (st.st_mtime_ns, st.st_size)
        cached = self._cache.get(rel)
        if cached and cached[0] == key:
            return cached[1], st
        h = sha256_file(full)
        self._cache[rel] = (key, h)
        return h, st

    def manifest(self):
        files = {}
        with self.lock:
            for dirpath, dirnames, filenames in os.walk(self.root):
                dirnames[:] = [d for d in dirnames if not d.startswith(".")]
                for fn in filenames:
                    if fn.startswith("."):
                        continue
                    full = os.path.join(dirpath, fn)
                    rel = os.path.relpath(full, self.root).replace(os.sep, "/")
                    try:
                        h, st = self._hash_cached(rel, full)
                    except OSError:
                        continue
                    if h is not None:
                        files[rel] = {"hash": h, "size": st.st_size, "mtime": st.st_mtime_ns // 1_000_000}
            for rel in list(self._cache):
                if rel not in files:
                    del self._cache[rel]
        return files

    def read(self, rel):
        full = self.abs_path(rel)
        with open(full, "rb") as f:
            return f.read()

    def _current(self, rel, full):
        return self._hash_cached(rel, full)[0] if os.path.isfile(full) else None

    def write(self, rel, data, base):
        """Записать файл, только если на ПК он всё ещё в версии base (None — файла не было)."""
        full = self.abs_path(rel)
        with self.lock:
            current = self._current(rel, full)
            new_hash = sha256_bytes(data)
            if current != base and current != new_hash:
                raise Conflict(current)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            tmp = os.path.join(os.path.dirname(full), ".abs-%s.tmp" % secrets.token_hex(4))
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, full)
            self._cache.pop(rel, None)
            return new_hash

    def delete(self, rel, base):
        """Переместить файл в корзину хранилища (.trash), если он не менялся на ПК."""
        full = self.abs_path(rel)
        with self.lock:
            current = self._current(rel, full)
            if current is None:
                return
            if current != base:
                raise Conflict(current)
            target = os.path.join(self.root, TRASH_DIR, *rel.split("/"))
            stem, ext = os.path.splitext(target)
            n = 2
            while os.path.exists(target):
                target = "%s (%d)%s" % (stem, n, ext)
                n += 1
            os.makedirs(os.path.dirname(target), exist_ok=True)
            os.replace(full, target)
            self._cache.pop(rel, None)
            # убрать опустевшие папки, оставшиеся после удаления
            d = os.path.dirname(full)
            while d != self.root and os.path.isdir(d) and not os.listdir(d):
                os.rmdir(d)
                d = os.path.dirname(d)


STORED_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".pdf", ".zip", ".7z", ".rar",
              ".mp3", ".mp4", ".m4a", ".ogg", ".webm", ".mov", ".docx", ".xlsx", ".pptx"}


def phone_vault_name(cfg):
    name = "".join(c for c in cfg["phone_vault_name"] if c not in BAD_CHARS and c != "/").strip(" .")
    return name or "Notes-from-PC"


def make_starter_zip(cfg, vault, server_url, out):
    """Хранилище для телефона: все заметки с ПК + уже настроенный плагин синхронизации.

    В настройки плагина сразу записываются хеши файлов из архива, поэтому первая
    синхронизация ничего не перекачивает, а лишь подхватывает правки, сделанные после.
    """
    name = phone_vault_name(cfg)
    plugin_root = "%s/.obsidian/plugins/%s/" % (name, PLUGIN_ID)
    base = {}
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for rel in sorted(vault.manifest()):
            try:
                data = vault.read(rel)
            except (OSError, ValueError):
                continue
            base[rel] = sha256_bytes(data)
            stored = os.path.splitext(rel)[1].lower() in STORED_EXT
            z.writestr("%s/%s" % (name, rel), data, zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED)
        z.writestr(name + "/.obsidian/community-plugins.json", json.dumps([PLUGIN_ID]))
        for fn in ("main.js", "manifest.json"):
            z.write(os.path.join(PLUGIN_DIR, fn), plugin_root + fn)
        data = {"settings": {"serverUrl": server_url, "token": cfg["token"]}, "base": base}
        z.writestr(plugin_root + "data.json", json.dumps(data, ensure_ascii=False))
    return name, len(base)


def human_size(n):
    for unit in ("Б", "КБ", "МБ"):
        if n < 1024:
            return "%.0f %s" % (n, unit)
        n /= 1024
    return "%.1f ГБ" % n


SETUP_PAGE = """<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AbsTransfer</title>
<style>
body{{font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:16px;line-height:1.5;
background:#1e1e1e;color:#ddd}}
a.btn{{display:block;text-align:center;padding:14px;margin:16px 0;border-radius:10px;background:#7c5cff;
color:#fff;text-decoration:none;font-weight:600}}
code{{background:#333;padding:2px 6px;border-radius:4px;word-break:break-all}}
li{{margin-bottom:8px}}
</style></head><body>
<h2>AbsTransfer: заметки с ПК на телефон</h2>
<p>Хранилище на ПК: <b>{vault}</b></p>
<a class="btn" href="/starter.zip?code={token}">Скачать заметки для телефона<br>
<small>{count} файлов, около {size} — .zip</small></a>
<p>Архив собирается несколько секунд — подождите, пока начнётся загрузка.</p>
<ol>
<li>Распакуйте архив. Получится папка <b>{name}</b> с вашими заметками.<br>
Android — в «Документы» (Documents). iPhone — в «Файлы → На iPhone → Obsidian».</li>
<li>В Obsidian: <b>Открыть папку как хранилище</b> → выберите папку <b>{name}</b>
(ту, где лежат заметки; если при распаковке получилась папка в папке — внутреннюю).
Ваши текущие хранилища на телефоне не затрагиваются — это отдельное, второе хранилище.</li>
<li>Obsidian спросит, доверяете ли вы автору — нажмите <b>«Доверять и включить плагины»</b>.</li>
<li>Дальше правки синхронизируются сами. Вручную — значок ⟳ на боковой панели.</li>
</ol>
<p>Если настраиваете вручную, в настройках плагина укажите:<br>
адрес ПК <code>{url}</code><br>код доступа <code>{token}</code></p>
</body></html>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "AbsTransfer/1.0"
    vault = None  # Vault
    cfg = None

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        # разрешаем запросы из самого Obsidian (запасной путь через fetch в плагине)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers", "X-Hash")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "X-Token, Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # --- ответы ---
    def _send(self, code, body=b"", ctype="application/json; charset=utf-8", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _parse(self):
        u = urllib.parse.urlsplit(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query, keep_blank_values=True).items()}
        return u.path, q

    def _authorized(self, q):
        given = self.headers.get("X-Token") or q.get("code") or ""
        return secrets.compare_digest(given.encode(), self.cfg["token"].encode())

    def _dispatch(self):
        path, q = self._parse()
        ip = self.client_address[0]
        if ip not in self.seen_ips:
            self.seen_ips.add(ip)
            log("Подключение: %s" % ip)
        if not self._authorized(q):
            log("Отказ %s: неверный код доступа" % ip)
            if path == "/":
                return self._send(401, "Нужен код доступа: откройте адрес из окна AbsTransfer на ПК.",
                                  "text/plain; charset=utf-8")
            return self._send(401, {"error": "Неверный код доступа"})
        try:
            route = (self.command, path)
            host = self.headers.get("Host") or "%s:%s" % (local_ip(), self.cfg["port"])
            if route == ("GET", "/"):
                files = self.vault.manifest()
                page = SETUP_PAGE.format(vault=os.path.basename(self.vault.root), name=phone_vault_name(self.cfg),
                                         count=len(files), size=human_size(sum(f["size"] for f in files.values())),
                                         token=self.cfg["token"], url="http://" + host)
                return self._send(200, page, "text/html; charset=utf-8")
            if route == ("GET", "/starter.zip"):
                log("Собираю архив с заметками для %s…" % ip)
                with tempfile.TemporaryFile() as tmp:
                    name, count = make_starter_zip(self.cfg, self.vault, "http://" + host, tmp)
                    length = tmp.seek(0, os.SEEK_END)
                    tmp.seek(0)
                    ascii_name = name if name.isascii() else "Notes-from-PC"
                    self.send_response(200)
                    self.send_header("Content-Type", "application/zip")
                    self.send_header("Content-Length", str(length))
                    self.send_header("Content-Disposition", "attachment; filename=\"%s.zip\"; filename*=UTF-8''%s"
                                     % (ascii_name, urllib.parse.quote(name + ".zip")))
                    self.end_headers()
                    shutil.copyfileobj(tmp, self.wfile, 1 << 20)
                log("Отправлен архив: %d файлов, %s" % (count, human_size(length)))
                return
            if route == ("GET", "/api/ping"):
                return self._send(200, {"ok": True, "vault": os.path.basename(self.vault.root)})
            if route == ("GET", "/api/manifest"):
                return self._send(200, {"files": self.vault.manifest()})
            if path == "/api/file":
                rel = q.get("path", "")
                base = q.get("base") or None
                if self.command == "GET":
                    data = self.vault.read(rel)
                    return self._send(200, data, "application/octet-stream", {"X-Hash": sha256_bytes(data)})
                if self.command == "PUT":
                    length = int(self.headers.get("Content-Length") or 0)
                    data = self.rfile.read(length)
                    h = self.vault.write(rel, data, base)
                    log("← с телефона: " + rel)
                    return self._send(200, {"hash": h})
                if self.command == "DELETE":
                    self.vault.delete(rel, base)
                    log("✕ удалено с телефона (в корзину .trash): " + rel)
                    return self._send(200, {"ok": True})
            return self._send(404, {"error": "not found"})
        except Conflict as c:
            return self._send(409, {"error": "Файл изменился на ПК", "current": c.current})
        except ValueError as e:
            return self._send(400, {"error": str(e)})
        except FileNotFoundError:
            return self._send(404, {"error": "Файл не найден"})
        except ConnectionError:
            log("Телефон оборвал соединение (%s)" % ip)
        except Exception as e:  # noqa: BLE001 — сервер не должен падать из-за одного запроса
            log("Ошибка: %r" % e)
            return self._send(500, {"error": str(e)})

    do_GET = do_PUT = do_DELETE = do_HEAD = _dispatch


class SyncServer:
    def __init__(self):
        self.httpd = None
        self.thread = None

    @property
    def running(self):
        return self.httpd is not None

    def start(self, cfg):
        if not cfg["vault_path"] or not os.path.isdir(cfg["vault_path"]):
            raise ValueError("Выберите существующую папку хранилища Obsidian")
        handler = type("BoundHandler", (Handler,),
                       {"vault": Vault(cfg["vault_path"]), "cfg": dict(cfg), "seen_ips": set()})
        self.httpd = ThreadingHTTPServer(("0.0.0.0", int(cfg["port"])), handler)
        self.httpd.daemon_threads = True
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        log("Сервер запущен. Хранилище: " + cfg["vault_path"])
        log("На телефоне откройте: " + phone_url(cfg))
        threading.Thread(target=self._diagnose, args=(cfg,), daemon=True).start()

    @staticmethod
    def _diagnose(cfg):
        others = lan_ips()[1:]
        if others:
            log("Если телефон не открывает адрес, попробуйте: " +
                ", ".join("http://%s:%s/?code=%s" % (ip, cfg["port"], cfg["token"]) for ip in others))
        nets = public_networks(local_ip())
        del WARNINGS[:]
        if nets:
            msg = ("Сеть «%s» отмечена в Windows как общедоступная — брандмауэр не пустит телефон. "
                   "Сделайте её частной: Параметры → Сеть и Интернет → Wi-Fi → «%s» → "
                   "Профиль сети: Частные." % (nets[0], nets[0]))
            WARNINGS.append(msg)
            log("⚠ " + msg)

    def stop(self):
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
            self.httpd = None
            log("Сервер остановлен")


def phone_url(cfg):
    return "http://%s:%s/?code=%s" % (local_ip(), cfg["port"], cfg["token"])


def run_console(cfg):
    if len(sys.argv) > 2 and not sys.argv[-1].startswith("--"):
        cfg["vault_path"] = sys.argv[-1]
    save_config(cfg)
    srv = SyncServer()
    srv.start(cfg)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        srv.stop()


def run_gui(cfg):
    import tkinter as tk
    from tkinter import filedialog, messagebox, scrolledtext, ttk

    srv = SyncServer()
    root = tk.Tk()
    root.title("AbsTransfer — Obsidian ПК ⇄ телефон")
    root.minsize(560, 460)
    frm = ttk.Frame(root, padding=12)
    frm.pack(fill="both", expand=True)
    frm.columnconfigure(1, weight=1)

    vault_var = tk.StringVar(value=cfg["vault_path"])
    port_var = tk.StringVar(value=str(cfg["port"]))
    token_var = tk.StringVar(value=cfg["token"])
    name_var = tk.StringVar(value=cfg["phone_vault_name"])
    url_var = tk.StringVar(value="")

    def row(r, label, var, button=None):
        ttk.Label(frm, text=label).grid(row=r, column=0, sticky="w", pady=3)
        e = ttk.Entry(frm, textvariable=var)
        e.grid(row=r, column=1, sticky="ew", pady=3, padx=6)
        if button:
            ttk.Button(frm, text=button[0], command=button[1]).grid(row=r, column=2, sticky="ew")
        return e

    def browse():
        d = filedialog.askdirectory(title="Папка хранилища Obsidian на ПК", initialdir=vault_var.get() or None)
        if d:
            vault_var.set(os.path.normpath(d))

    ttk.Label(frm, text="Хранилище на ПК:").grid(row=0, column=0, sticky="w", pady=3)
    vault_box = ttk.Combobox(frm, textvariable=vault_var, values=find_vaults())
    vault_box.grid(row=0, column=1, sticky="ew", pady=3, padx=6)
    vault_box.bind("<Button-1>", lambda e: vault_box.config(values=find_vaults()))
    ttk.Button(frm, text="Обзор…", command=browse).grid(row=0, column=2, sticky="ew")
    found = find_vaults()
    ttk.Label(frm, foreground="gray",
              text=("Найдено хранилищ Obsidian: %d — выберите в списке или укажите другую папку." % len(found))
              if found else "Хранилища Obsidian не найдены автоматически — укажите папку через «Обзор…».",
              ).grid(row=1, column=1, columnspan=2, sticky="w", padx=6)
    row(2, "Порт:", port_var)
    row(3, "Код доступа:", token_var, ("Новый", lambda: token_var.set(new_token())))
    row(4, "Имя на телефоне:", name_var)

    toggle_btn = ttk.Button(frm)
    toggle_btn.grid(row=5, column=0, columnspan=3, sticky="ew", pady=(10, 6))

    ttk.Label(frm, text="Откройте на телефоне (тот же Wi-Fi):").grid(row=6, column=0, columnspan=3, sticky="w")
    url_entry = ttk.Entry(frm, textvariable=url_var, state="readonly", font=("Segoe UI", 11, "bold"))
    url_entry.grid(row=7, column=0, columnspan=2, sticky="ew", pady=3)

    def copy_url():
        root.clipboard_clear()
        root.clipboard_append(url_var.get())

    ttk.Button(frm, text="Копировать", command=copy_url).grid(row=7, column=2, sticky="ew")

    logbox = scrolledtext.ScrolledText(frm, height=12, state="disabled", font=("Consolas", 9))
    warn_var = tk.StringVar(value="")
    warn_label = tk.Label(frm, textvariable=warn_var, fg="#c00000", justify="left", anchor="w", wraplength=520)
    warn_label.grid(row=8, column=0, columnspan=3, sticky="ew", pady=(6, 0))
    warn_label.bind("<Configure>", lambda e: warn_label.config(wraplength=max(200, e.width - 10)))

    logbox.grid(row=9, column=0, columnspan=3, sticky="nsew", pady=(8, 0))
    frm.rowconfigure(9, weight=1)

    def refresh_button():
        toggle_btn.config(text="Остановить сервер" if srv.running else "Запустить сервер")
        url_var.set(phone_url(cfg) if srv.running else "(сервер не запущен)")

    def toggle():
        if srv.running:
            srv.stop()
        else:
            path = os.path.normpath(vault_var.get().strip().strip('"')) if vault_var.get().strip() else ""
            problem = check_vault(path)
            if problem and (not os.path.isdir(path) or os.path.isfile(os.path.join(path, "Obsidian.exe"))):
                messagebox.showerror("AbsTransfer", problem + "\n\nВыберите папку с заметками.")
                return
            if problem and not messagebox.askyesno("AbsTransfer", problem + "\n\nВсё равно использовать эту папку?"):
                return
            vault_var.set(path)
            try:
                cfg.update(vault_path=path, port=int(port_var.get()),
                           token=token_var.get().strip() or new_token(), phone_vault_name=name_var.get().strip())
                token_var.set(cfg["token"])
                save_config(cfg)
                srv.start(cfg)
            except (ValueError, OSError) as e:
                messagebox.showerror("AbsTransfer", str(e))
        refresh_button()

    toggle_btn.config(command=toggle)

    def on_vault_selected(_event):
        if srv.running and os.path.normpath(vault_var.get()) != os.path.normpath(cfg["vault_path"]):
            srv.stop()
            toggle()  # перезапуск с новым хранилищем

    vault_box.bind("<<ComboboxSelected>>", on_vault_selected)

    def pump_log():
        try:
            while True:
                line = _log_queue.get_nowait()
                logbox.config(state="normal")
                logbox.insert("end", line + "\n")
                logbox.see("end")
                logbox.config(state="disabled")
        except queue.Empty:
            pass
        warn_var.set("\n".join("⚠ " + w for w in dict.fromkeys(WARNINGS)))
        root.after(300, pump_log)

    def on_close():
        srv.stop()
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)
    if cfg["vault_path"] and os.path.isdir(cfg["vault_path"]):
        try:
            # запоминаем найденное хранилище, чтобы оно не сменилось, когда в Obsidian откроют другое
            save_config(cfg)
            srv.start(cfg)
        except OSError as e:
            log("Не удалось запустить сервер: %s" % e)
    else:
        log("Выберите папку хранилища Obsidian и нажмите «Запустить сервер».")
    refresh_button()
    pump_log()
    root.mainloop()


if __name__ == "__main__":
    config = load_config()
    if "--nogui" in sys.argv:
        run_console(config)
    else:
        run_gui(config)
