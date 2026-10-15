// Сквозной тест: настоящий сервер pc/abs_server.py + плагин plugin/main.js
// с имитацией API Obsidian поверх папки на диске. Запуск: node tests/sync_test.cjs
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { spawn, spawnSync } = require("child_process");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const PORT = 18765;
const TOKEN = "test42";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abs-test-"));
const PC = path.join(tmp, "pc");
let PHONE = path.join(tmp, "phone");
fs.mkdirSync(PC);
fs.mkdirSync(PHONE);

// ---------- имитация модуля obsidian ----------
const notices = [];
class TFile {
  constructor(p) {
    this.path = p;
    const st = fs.statSync(path.join(PHONE, p));
    this.stat = { mtime: Math.floor(st.mtimeMs), size: st.size };
  }
}
class TFolder {
  constructor(p) {
    this.path = p;
  }
}
const toAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const full = (p) => path.join(PHONE, ...p.split("/"));
const vault = {
  getFiles() {
    const out = [];
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        const r = rel ? rel + "/" + e.name : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else out.push(new TFile(r));
      }
    };
    walk(PHONE, "");
    return out;
  },
  getAbstractFileByPath(p) {
    if (!fs.existsSync(full(p))) return null;
    return fs.statSync(full(p)).isDirectory() ? new TFolder(p) : new TFile(p);
  },
  async readBinary(f) {
    return toAB(fs.readFileSync(full(f.path)));
  },
  async modifyBinary(f, data) {
    fs.writeFileSync(full(f.path), Buffer.from(data));
  },
  async createBinary(p, data) {
    if (fs.existsSync(full(p))) throw new Error("File already exists.");
    fs.writeFileSync(full(p), Buffer.from(data));
  },
  async createFolder(p) {
    if (fs.existsSync(full(p))) throw new Error("Folder already exists.");
    fs.mkdirSync(full(p));
  },
  async trash(f) {
    const dest = path.join(PHONE, ".trash", path.basename(f.path));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(full(f.path), dest);
  },
  on() {},
  adapter: {
    async stat(p) {
      const st = fs.statSync(full(p));
      return { mtime: Math.floor(st.mtimeMs), size: st.size };
    },
  },
};
let stored = { settings: { serverUrl: `http://127.0.0.1:${PORT}`, token: TOKEN, intervalMin: 0 } };
const obsidian = {
  TFile,
  Notice: class {
    constructor(m) {
      notices.push(m);
    }
  },
  Plugin: class {
    constructor() {
      this.app = { vault, workspace: { onLayoutReady() {} } };
    }
    async loadData() {
      return JSON.parse(JSON.stringify(stored));
    }
    async saveData(d) {
      stored = JSON.parse(JSON.stringify(d));
    }
    addStatusBarItem() {
      return { setText() {} };
    }
    addRibbonIcon() {}
    addCommand() {}
    addSettingTab() {}
    registerEvent() {}
    registerDomEvent() {}
    registerInterval(id) {
      return id;
    }
  },
  PluginSettingTab: class {},
  Setting: class {},
  async requestUrl({ url, method, body, headers }) {
    const res = await fetch(url, { method, body: body ? Buffer.from(body) : undefined, headers });
    const buf = await res.arrayBuffer();
    return {
      status: res.status,
      arrayBuffer: buf,
      get json() {
        return JSON.parse(Buffer.from(buf).toString("utf8"));
      },
    };
  },
};
global.window = globalThis;
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  return req === "obsidian" ? obsidian : origLoad.call(this, req, ...rest);
};
const PluginClass = require(path.join(ROOT, "plugin", "main.js"));

// ---------- помощники ----------
const w = (dir, p, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
  fs.writeFileSync(path.join(dir, p), text);
};
const r = (dir, p) => fs.readFileSync(path.join(dir, p), "utf8");
const ex = (dir, p) => fs.existsSync(path.join(dir, p));
const list = (dir) => fs.readdirSync(dir, { recursive: true }).map((x) => x.replace(/\\/g, "/")).sort();
let plugin;
async function sync() {
  notices.length = 0;
  await plugin.sync(true);
  return notices.join(" | ");
}
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

async function main() {
  // ПК-хранилище с заметками
  w(PC, "Входящие.md", "# Привет с ПК");
  w(PC, "Проекты/План.md", "1. Первый пункт");
  w(PC, ".obsidian/app.json", "{}"); // не должно уехать на телефон
  fs.mkdirSync(path.join(PC, "img"));
  fs.writeFileSync(path.join(PC, "img/pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]));
  w(PHONE, ".obsidian/plugins/abs-transfer/data.json", "{}");

  const py = spawn(
    "python",
    [
      "-c",
      `import sys,time; sys.path.insert(0, r"${path.join(ROOT, "pc")}"); import abs_server as a
s=a.SyncServer(); s.start({"vault_path": r"${PC}", "port": ${PORT}, "token": "${TOKEN}", "phone_vault_name": "Notes-from-PC"})
time.sleep(3600)`,
    ],
    { stdio: "inherit" }
  );
  try {
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`http://127.0.0.1:${PORT}/api/ping`);
        break;
      } catch {
        await wait(100);
      }
    }
    plugin = new PluginClass();
    await plugin.onload();

    console.log("1. первая синхронизация:", await sync());
    assert.equal(r(PHONE, "Входящие.md"), "# Привет с ПК");
    assert.equal(r(PHONE, "Проекты/План.md"), "1. Первый пункт");
    assert.deepEqual([...fs.readFileSync(path.join(PHONE, "img/pic.png"))], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    assert.ok(!ex(PHONE, ".obsidian/app.json"), ".obsidian ПК не должен попадать на телефон");

    console.log("2. повтор без изменений:", await sync());
    assert.match(notices[0], /без изменений/);

    w(PHONE, "Проекты/План.md", "1. Первый пункт\n2. Добавлено на телефоне");
    w(PHONE, "Телефон/Идея.md", "новая папка и заметка с телефона");
    console.log("3. правки на телефоне:", await sync());
    assert.equal(r(PC, "Проекты/План.md"), "1. Первый пункт\n2. Добавлено на телефоне");
    assert.equal(r(PC, "Телефон/Идея.md"), "новая папка и заметка с телефона");

    w(PC, "Входящие.md", "# Привет с ПК, отредактировано");
    w(PC, "Новая с ПК.md", "свежая");
    console.log("4. правки на ПК:", await sync());
    assert.equal(r(PHONE, "Входящие.md"), "# Привет с ПК, отредактировано");
    assert.equal(r(PHONE, "Новая с ПК.md"), "свежая");

    w(PC, "Входящие.md", "версия ПК");
    w(PHONE, "Входящие.md", "версия телефона, длиннее");
    console.log("5. конфликт:", await sync());
    assert.equal(r(PHONE, "Входящие.md"), "версия ПК");
    assert.equal(r(PC, "Входящие.md"), "версия ПК");
    const copyPhone = list(PHONE).find((f) => f.startsWith("Входящие (с телефона"));
    const copyPc = list(PC).find((f) => f.startsWith("Входящие (с телефона"));
    assert.ok(copyPhone && copyPc, "копия конфликта должна быть на обеих сторонах");
    assert.equal(r(PHONE, copyPhone), "версия телефона, длиннее");
    assert.equal(r(PC, copyPc), "версия телефона, длиннее");

    fs.unlinkSync(path.join(PC, "Новая с ПК.md"));
    console.log("6. удаление на ПК:", await sync());
    assert.ok(!ex(PHONE, "Новая с ПК.md"));
    assert.ok(ex(PHONE, ".trash/Новая с ПК.md"), "на телефоне файл должен лежать в корзине");

    fs.unlinkSync(path.join(PHONE, "Телефон/Идея.md"));
    console.log("7. удаление на телефоне:", await sync());
    assert.ok(!ex(PC, "Телефон/Идея.md"));
    assert.equal(r(PC, ".trash/Телефон/Идея.md"), "новая папка и заметка с телефона");

    plugin.settings.deleteOnPhone = false;
    fs.unlinkSync(path.join(PC, "Проекты/План.md"));
    console.log("8. удаление на ПК при запрете удалять на телефоне:", await sync());
    assert.ok(ex(PHONE, "Проекты/План.md"), "файл должен остаться на телефоне");
    console.log("   повтор:", await sync());
    assert.ok(!ex(PC, "Проекты/План.md"), "файл не должен снова уехать на ПК");
    assert.match(notices[0], /без изменений/);

    plugin.base = {};
    w(PC, "Входящие.md", "после сброса отличается");
    console.log("9. сброс истории:", await sync());
    assert.equal(r(PC, "Входящие.md"), "после сброса отличается");
    assert.ok(list(PHONE).filter((f) => f.startsWith("Входящие (с телефона")).length >= 1);

    // безопасность сервера
    const bad = await fetch(`http://127.0.0.1:${PORT}/api/file?path=..%2Fevil.md&base=`, {
      method: "PUT",
      body: "x",
      headers: { "X-Token": TOKEN },
    });
    assert.equal(bad.status, 400, "выход за пределы хранилища должен отклоняться");
    assert.ok(!fs.existsSync(path.join(tmp, "evil.md")));
    const hidden = await fetch(`http://127.0.0.1:${PORT}/api/file?path=.obsidian%2Fapp.json`, {
      headers: { "X-Token": TOKEN },
    });
    assert.equal(hidden.status, 400, "скрытые папки недоступны");
    const noToken = await fetch(`http://127.0.0.1:${PORT}/api/manifest`);
    assert.equal(noToken.status, 401);
    const page = await fetch(`http://127.0.0.1:${PORT}/?code=${TOKEN}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /файлов/);

    // архив для телефона: заметки + настроенный плагин; после распаковки синхронизация ничего не качает
    const zip = await fetch(`http://127.0.0.1:${PORT}/starter.zip?code=${TOKEN}`);
    assert.equal(zip.status, 200);
    const zipPath = path.join(tmp, "starter.zip");
    fs.writeFileSync(zipPath, Buffer.from(await zip.arrayBuffer()));
    const unpacked = path.join(tmp, "unpacked");
    const ex2 = spawnSync("python", ["-c", "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", zipPath, unpacked]);
    assert.equal(ex2.status, 0, String(ex2.stderr));
    PHONE = path.join(unpacked, "Notes-from-PC");
    for (const f of ["Входящие.md", "img/pic.png", copyPc, ".obsidian/community-plugins.json",
                     ".obsidian/plugins/abs-transfer/main.js", ".obsidian/plugins/abs-transfer/manifest.json"]) {
      assert.ok(ex(PHONE, f), "в архиве нет " + f);
    }
    assert.equal(r(PHONE, "Входящие.md"), r(PC, "Входящие.md"));
    assert.ok(!ex(PHONE, ".trash"), "корзина ПК не должна попадать в архив");
    stored = JSON.parse(r(PHONE, ".obsidian/plugins/abs-transfer/data.json"));
    stored.settings.intervalMin = 0;
    assert.equal(stored.settings.serverUrl, `http://127.0.0.1:${PORT}`);
    plugin = new PluginClass();
    await plugin.onload();
    console.log("10. первая синхронизация распакованного архива:", await sync());
    assert.match(notices[0], /без изменений/);
    w(PC, "Входящие.md", "правка на ПК после скачивания архива");
    console.log("    правка на ПК после архива:", await sync());
    assert.equal(r(PHONE, "Входящие.md"), "правка на ПК после скачивания архива");

    console.log("\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ");
  } finally {
    py.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("ТЕСТ НЕ ПРОЙДЕН:", e);
  process.exitCode = 1;
});
