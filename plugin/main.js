/*
 * AbsTransfer — двусторонняя синхронизация хранилища Obsidian с ПК по Wi-Fi.
 *
 * Работает в паре с pc/abs_server.py. Для каждого файла плагин помнит хеш на момент
 * последней синхронизации (base) и сравнивает его с текущими версиями на телефоне (L)
 * и на ПК (R):
 *   изменился только ПК       → скачать с ПК
 *   изменился только телефон  → отправить на ПК
 *   изменились оба            → ничего не теряется: версия телефона сохраняется рядом
 *                               как «… (с телефона ДАТА)», основной файл берётся с ПК
 * Удаления не стирают файлы, а переносят их в корзину (.trash) хранилища.
 */
const { Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl } = require("obsidian");

const DEFAULT_SETTINGS = {
  serverUrl: "",
  token: "",
  intervalMin: 5,
  syncOnStart: true,
  syncOnChange: true,
  deleteOnPhone: true,
  deleteOnPc: true,
};
const KEEP = "KEEP"; // файл удалён на ПК, но по настройке оставлен только на телефоне
const CHANGE_DELAY_MS = 15000;
const PING_TIMEOUT_MS = 6000;

async function sha256(buf) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("ПК не отвечает")), ms)),
  ]);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

module.exports = class AbsTransferPlugin extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
    this.base = data.base || {}; // путь → хеш на момент последней синхронизации
    this.cache = data.cache || {}; // путь → {m: mtime, s: size, h: hash}, чтобы не перечитывать файлы
    this.lastResult = data.lastResult || "ещё не было";
    this.syncing = false;
    this.lastAttempt = 0;
    this.changeTimer = null;

    this.statusEl = this.addStatusBarItem();
    this.addRibbonIcon("refresh-cw", "Синхронизировать с ПК", () => this.sync(true));
    this.addCommand({ id: "sync-now", name: "Синхронизировать с ПК сейчас", callback: () => this.sync(true) });
    this.addSettingTab(new AbsTransferSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      const onChange = () => this.scheduleSync();
      this.registerEvent(this.app.vault.on("modify", onChange));
      this.registerEvent(this.app.vault.on("create", onChange));
      this.registerEvent(this.app.vault.on("delete", onChange));
      this.registerEvent(this.app.vault.on("rename", onChange));
      // телефон разблокировали / вернулись в приложение — заодно проверить ПК
      this.registerDomEvent(document, "visibilitychange", () => {
        if (!document.hidden && Date.now() - this.lastAttempt > 30000) this.sync(false);
      });
      if (this.settings.syncOnStart) setTimeout(() => this.sync(false), 2000);
    });
    this.restartInterval();
  }

  onunload() {
    clearTimeout(this.changeTimer);
  }

  restartInterval() {
    if (this.intervalId) window.clearInterval(this.intervalId);
    this.intervalId = null;
    const min = Number(this.settings.intervalMin);
    if (min > 0) this.intervalId = this.registerInterval(window.setInterval(() => this.sync(false), min * 60000));
  }

  scheduleSync() {
    if (!this.settings.syncOnChange || this.syncing) return;
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.sync(false), CHANGE_DELAY_MS);
  }

  async persist() {
    await this.saveData({ settings: this.settings, base: this.base, cache: this.cache, lastResult: this.lastResult });
  }

  setStatus(text) {
    this.statusEl.setText(text);
  }

  // ---------- сеть ----------

  async api(method, path, body) {
    const url = this.settings.serverUrl.trim().replace(/\/+$/, "") + path;
    const headers = { "X-Token": this.settings.token.trim() };
    let res;
    if (!this.useFetch) {
      try {
        res = await requestUrl({
          url,
          method,
          body,
          contentType: body ? "application/octet-stream" : undefined,
          headers,
          throw: false,
        });
      } catch (e) {
        // на некоторых телефонах системный http-клиент не пускает на http:// — пробуем через fetch
        try {
          res = await this.fetchRequest(url, method, body, headers);
          this.useFetch = true;
        } catch (e2) {
          throw new Error(e.message + " / " + e2.message);
        }
      }
    } else {
      res = await this.fetchRequest(url, method, body, headers);
    }
    if (res.status === 401) throw new Error("неверный код доступа");
    return res;
  }

  async fetchRequest(url, method, body, headers) {
    const r = await fetch(url, { method, body, headers });
    const buf = await r.arrayBuffer();
    return {
      status: r.status,
      arrayBuffer: buf,
      get json() {
        return JSON.parse(new TextDecoder().decode(buf));
      },
    };
  }

  fileUrl(p, base) {
    let q = "/api/file?path=" + encodeURIComponent(p);
    if (base !== undefined) q += "&base=" + (base || "");
    return q;
  }

  // ---------- синхронизация ----------

  async sync(manual) {
    if (this.syncing) {
      if (manual) new Notice("Синхронизация уже идёт…");
      return;
    }
    if (!this.settings.serverUrl || !this.settings.token) {
      if (manual) new Notice("AbsTransfer: укажите адрес ПК и код доступа в настройках плагина");
      return;
    }
    this.syncing = true;
    this.lastAttempt = Date.now();
    clearTimeout(this.changeTimer);
    this.setStatus("⟳ ПК…");
    const st = { down: 0, up: 0, trashedHere: 0, trashedPc: 0, conflicts: [], errors: [] };
    try {
      const ping = await withTimeout(this.api("GET", "/api/ping"), PING_TIMEOUT_MS);
      if (ping.status !== 200) throw new Error("ответ ПК: " + ping.status);
      const manifest = await this.api("GET", "/api/manifest");
      if (manifest.status !== 200) throw new Error("ответ ПК: " + manifest.status);
      const remote = manifest.json.files;
      const local = await this.localManifest();

      const paths = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(this.base)]);
      let done = 0;
      for (const p of paths) {
        try {
          await this.syncPath(p, local[p] || null, remote[p] ? remote[p].hash : null, this.base[p] || null, st);
        } catch (e) {
          console.error("AbsTransfer:", p, e);
          st.errors.push(p + ": " + e.message);
        }
        if (++done % 25 === 0) await this.persist(); // на случай, если приложение закроют посреди
      }

      const time = new Date().toLocaleString();
      const parts = [];
      if (st.down) parts.push("↓ " + st.down);
      if (st.up) parts.push("↑ " + st.up);
      if (st.trashedHere) parts.push("в корзину здесь: " + st.trashedHere);
      if (st.trashedPc) parts.push("в корзину на ПК: " + st.trashedPc);
      if (st.conflicts.length) parts.push("конфликтов: " + st.conflicts.length);
      if (st.errors.length) parts.push("ошибок: " + st.errors.length);
      const summary = parts.length ? parts.join(", ") : "без изменений";
      this.lastResult = time + " — " + summary;
      this.setStatus("ПК ✓ " + new Date().toLocaleTimeString().slice(0, 5));
      if (manual || parts.length) new Notice("ПК ⇄ телефон: " + summary);
      if (st.conflicts.length) {
        new Notice(
          "Заметки изменены и на ПК, и на телефоне. Версия телефона сохранена рядом с пометкой «с телефона»:\n" +
            st.conflicts.join("\n"),
          15000
        );
      }
      if (st.errors.length) new Notice("AbsTransfer, ошибки:\n" + st.errors.slice(0, 5).join("\n"), 15000);
    } catch (e) {
      this.setStatus("ПК недоступен");
      this.lastResult = new Date().toLocaleString() + " — нет связи с ПК (" + e.message + ")";
      if (manual) new Notice("Нет связи с ПК: " + e.message + "\nПК включён, сервер запущен, телефон в той же Wi-Fi?");
    } finally {
      await this.persist();
      this.syncing = false;
    }
  }

  async localManifest() {
    const out = {};
    for (const f of this.app.vault.getFiles()) {
      const c = this.cache[f.path];
      if (c && c.m === f.stat.mtime && c.s === f.stat.size) {
        out[f.path] = c.h;
      } else {
        const h = await sha256(await this.app.vault.readBinary(f));
        this.cache[f.path] = { m: f.stat.mtime, s: f.stat.size, h };
        out[f.path] = h;
      }
    }
    for (const p of Object.keys(this.cache)) if (!(p in out)) delete this.cache[p];
    return out;
  }

  async syncPath(p, L, R, B, st) {
    if (B === KEEP) {
      if (R === null) {
        if (L === null) delete this.base[p];
        return; // файл живёт только на телефоне
      }
      B = null; // на ПК снова появился файл с таким именем — сравниваем заново
    }
    if (L === R) {
      if (L === null) delete this.base[p];
      else this.base[p] = L;
      return;
    }
    if (L === B) {
      // изменился только ПК
      if (R !== null) return this.download(p, st);
      if (this.settings.deleteOnPhone) return this.trashLocal(p, st);
      this.base[p] = KEEP;
      return;
    }
    if (R === B) {
      // изменился только телефон
      if (L !== null) return this.upload(p, R, st);
      if (this.settings.deleteOnPc) return this.trashRemote(p, R, st);
      return this.download(p, st); // удалять на ПК запрещено — вернуть файл
    }
    // изменились обе стороны
    if (L === null) return this.download(p, st); // удалён здесь, но изменён на ПК — правка важнее
    if (R === null) return this.upload(p, null, st); // удалён на ПК, но изменён здесь
    return this.resolveConflict(p, R, st);
  }

  async download(p, st) {
    const res = await this.api("GET", this.fileUrl(p));
    if (res.status !== 200) throw new Error("не удалось скачать (" + res.status + ")");
    const data = res.arrayBuffer;
    await this.writeLocal(p, data);
    this.base[p] = await sha256(data);
    st.down++;
  }

  async upload(p, remoteHash, st) {
    const file = this.app.vault.getAbstractFileByPath(p);
    if (!(file instanceof TFile)) return;
    const data = await this.app.vault.readBinary(file);
    const res = await this.api("PUT", this.fileUrl(p, remoteHash), data);
    if (res.status === 409) return; // файл только что изменили на ПК — разберёмся в следующий раз
    if (res.status !== 200) throw new Error((res.json && res.json.error) || "ошибка " + res.status);
    this.base[p] = res.json.hash;
    st.up++;
  }

  async trashLocal(p, st) {
    const file = this.app.vault.getAbstractFileByPath(p);
    if (file) await this.app.vault.trash(file, false); // в папку .trash этого хранилища
    delete this.base[p];
    delete this.cache[p];
    st.trashedHere++;
  }

  async trashRemote(p, remoteHash, st) {
    const res = await this.api("DELETE", this.fileUrl(p, remoteHash));
    if (res.status === 409) return;
    if (res.status !== 200) throw new Error((res.json && res.json.error) || "ошибка " + res.status);
    delete this.base[p];
    st.trashedPc++;
  }

  async resolveConflict(p, R, st) {
    const file = this.app.vault.getAbstractFileByPath(p);
    const mine = await this.app.vault.readBinary(file);
    const copyPath = this.conflictPath(p);
    await this.app.vault.createBinary(copyPath, mine);
    const res = await this.api("PUT", this.fileUrl(copyPath, null), mine);
    if (res.status === 200) {
      this.base[copyPath] = res.json.hash;
      st.up++;
    }
    await this.download(p, st);
    st.conflicts.push(p);
  }

  conflictPath(p) {
    const slash = p.lastIndexOf("/");
    const dir = p.slice(0, slash + 1);
    const name = p.slice(slash + 1);
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    const d = new Date();
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
    let candidate = `${dir}${stem} (с телефона ${stamp})${ext}`;
    for (let n = 2; this.app.vault.getAbstractFileByPath(candidate); n++) {
      candidate = `${dir}${stem} (с телефона ${stamp} ${n})${ext}`;
    }
    return candidate;
  }

  async writeLocal(p, data) {
    const vault = this.app.vault;
    const existing = vault.getAbstractFileByPath(p);
    if (existing instanceof TFile) {
      await vault.modifyBinary(existing, data);
    } else {
      const slash = p.lastIndexOf("/");
      if (slash > 0) await this.ensureFolder(p.slice(0, slash));
      await vault.createBinary(p, data);
    }
    const stat = await vault.adapter.stat(p);
    if (stat) this.cache[p] = { m: stat.mtime, s: stat.size, h: await sha256(data) };
  }

  async ensureFolder(dir) {
    let path = "";
    for (const part of dir.split("/")) {
      path = path ? path + "/" + part : part;
      if (!this.app.vault.getAbstractFileByPath(path)) {
        try {
          await this.app.vault.createFolder(path);
        } catch (e) {
          if (!/exist/i.test(e.message)) throw e;
        }
      }
    }
  }
};

class AbsTransferSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const plugin = this.plugin;
    const s = plugin.settings;
    const save = async () => {
      await plugin.persist();
    };
    containerEl.empty();
    containerEl.createEl("h2", { text: "AbsTransfer — синхронизация с ПК" });
    containerEl.createEl("p", { text: "Последняя синхронизация: " + plugin.lastResult });

    new Setting(containerEl)
      .setName("Адрес ПК")
      .setDesc("Показан в окне AbsTransfer на компьютере, например http://192.168.1.10:8765")
      .addText((t) =>
        t.setPlaceholder("http://192.168.1.10:8765").setValue(s.serverUrl).onChange(async (v) => {
          s.serverUrl = v.trim();
          await save();
        })
      );
    new Setting(containerEl)
      .setName("Код доступа")
      .setDesc("Тот же код, что в окне AbsTransfer на ПК")
      .addText((t) =>
        t.setValue(s.token).onChange(async (v) => {
          s.token = v.trim();
          await save();
        })
      );
    new Setting(containerEl)
      .setName("Проверять ПК каждые (минут)")
      .setDesc("0 — только вручную и после правок")
      .addText((t) =>
        t.setValue(String(s.intervalMin)).onChange(async (v) => {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0) return;
          s.intervalMin = n;
          plugin.restartInterval();
          await save();
        })
      );
    new Setting(containerEl)
      .setName("Синхронизировать при открытии")
      .addToggle((t) =>
        t.setValue(s.syncOnStart).onChange(async (v) => {
          s.syncOnStart = v;
          await save();
        })
      );
    new Setting(containerEl)
      .setName("Отправлять правки автоматически")
      .setDesc("Через 15 секунд после последнего изменения")
      .addToggle((t) =>
        t.setValue(s.syncOnChange).onChange(async (v) => {
          s.syncOnChange = v;
          await save();
        })
      );
    new Setting(containerEl)
      .setName("Удалено на ПК → убрать и здесь")
      .setDesc("Файл переносится в корзину этого хранилища (.trash). Выключите, чтобы на телефоне ничего не удалялось.")
      .addToggle((t) =>
        t.setValue(s.deleteOnPhone).onChange(async (v) => {
          s.deleteOnPhone = v;
          await save();
        })
      );
    new Setting(containerEl)
      .setName("Удалено здесь → убрать и на ПК")
      .setDesc("Файл переносится в корзину хранилища на ПК (.trash). Если выключить, удалённое здесь вернётся с ПК.")
      .addToggle((t) =>
        t.setValue(s.deleteOnPc).onChange(async (v) => {
          s.deleteOnPc = v;
          await save();
        })
      );
    new Setting(containerEl)
      .setName("Проверить связь и синхронизировать")
      .addButton((b) =>
        b
          .setButtonText("Синхронизировать сейчас")
          .setCta()
          .onClick(async () => {
            await plugin.sync(true);
            this.display();
          })
      );
    new Setting(containerEl)
      .setName("Начать сравнение заново")
      .setDesc(
        "Забыть историю синхронизаций. Одинаковые файлы не тронутся, недостающие докачаются, " +
          "а различающиеся сохранятся в обоих вариантах. Нужно, если подключаете другое хранилище ПК."
      )
      .addButton((b) =>
        b.setButtonText("Сбросить").onClick(async () => {
          plugin.base = {};
          await save();
          new Notice("История синхронизаций сброшена");
        })
      );
  }
}
