const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Chạy qua XWayland (ổn định); bộ gõ lấy từ GTK_IM_MODULE/XMODIFIERS của hệ thống.
app.commandLine.appendSwitch('ozone-platform', 'x11');

// NVIDIA + Wayland hay làm cửa sổ Electron trắng xoá; UI nhẹ nên tắt GPU cho giao diện
// (Ollama vẫn dùng GPU bình thường để chạy model).
app.disableHardwareAcceleration();

const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const dataFile = () => path.join(app.getPath('userData'), 'data.json');
const streams = new Map();

function createWindow() {
  const win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 700, minHeight: 500,
    title: 'Local AI Chat', icon: path.join(__dirname, 'build', 'icon.png'), autoHideMenuBar: true, backgroundColor: '#212121',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('data:load', () => {
  try { return JSON.parse(fs.readFileSync(dataFile(), 'utf8')); } catch { return null; }
});
ipcMain.handle('data:save', (_e, data) => {
  const tmp = dataFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, dataFile());
});

ipcMain.handle('models', async () => {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`);
    return { ok: true, models: (await r.json()).models.map((m) => m.name) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('model:caps', async (_e, model) => {
  try {
    const r = await fetch(`${OLLAMA}/api/show`, { method: 'POST', body: JSON.stringify({ model }) });
    return (await r.json()).capabilities || [];
  } catch { return []; }
});

ipcMain.handle('model:loaded', async () => {
  try {
    const r = await fetch(`${OLLAMA}/api/ps`);
    return (await r.json()).models.map((m) => m.name);
  } catch { return null; } // null = Ollama không chạy
});
// keep_alive 0 = giải phóng ngay; "30m" = nạp sẵn và giữ 30 phút.
ipcMain.handle('model:power', async (_e, { model, on }) => {
  try {
    const r = await fetch(`${OLLAMA}/api/generate`, {
      method: 'POST', body: JSON.stringify({ model, keep_alive: on ? '30m' : 0 }),
    });
    if (!r.ok) throw new Error(await r.text());
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

const MAX_TEXT = 300000;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|scss|js|mjs|ts|tsx|jsx|py|java|c|h|cpp|hpp|cs|go|rs|rb|php|sh|bash|sql|yml|yaml|toml|ini|cfg|conf|log|tex|swift|kt|lua|r|vue|svelte)$/i;

// Turn an attached file into either image data or plain text for the model.
ipcMain.handle('file:extract', async (_e, { name, type, buffer }) => {
  const buf = Buffer.from(buffer);
  try {
    let text;
    if (/\.pdf$/i.test(name) || type === 'application/pdf') {
      text = (await require('pdf-parse/lib/pdf-parse.js')(buf)).text;
    } else if (/\.docx$/i.test(name)) {
      text = (await require('mammoth').extractRawText({ buffer: buf })).value;
    } else if (TEXT_EXT.test(name) || type.startsWith('text/') || !buf.subarray(0, 4096).includes(0)) {
      text = buf.toString('utf8');
    } else {
      return { error: `Không hỗ trợ định dạng của "${name}"` };
    }
    text = text.replace(/\r\n/g, '\n').trim();
    if (!text) return { error: `Không trích được chữ từ "${name}" (có thể là PDF dạng ảnh scan)` };
    const truncated = text.length > MAX_TEXT;
    return { kind: 'text', name, text: text.slice(0, MAX_TEXT), truncated };
  } catch (err) {
    return { error: `Lỗi đọc "${name}": ${err.message}` };
  }
});

ipcMain.handle('export:save', async (e, { name, content }) => {
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
    defaultPath: name.replace(/[\\/:*?"<>|]/g, '_') + '.md',
  });
  if (r.canceled) return false;
  fs.writeFileSync(r.filePath, content);
  return true;
});

// Stream a chat completion; chunks are pushed back to the renderer.
ipcMain.on('chat:start', async (e, { id, model, messages, options }) => {
  const ctrl = new AbortController();
  streams.set(id, ctrl);
  const send = (msg) => { if (!e.sender.isDestroyed()) e.sender.send('chat:event', { id, ...msg }); };
  try {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, options }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const j = JSON.parse(line);
        if (j.error) throw new Error(j.error);
        if (j.message?.content) send({ type: 'token', text: j.message.content });
      }
    }
    send({ type: 'done' });
  } catch (err) {
    send(err.name === 'AbortError' ? { type: 'done', aborted: true }
      : { type: 'error', error: err.message.includes('fetch failed') ? 'Không kết nối được Ollama (http://127.0.0.1:11434). Hãy chạy "ollama serve".' : err.message });
  } finally {
    streams.delete(id);
  }
});
ipcMain.on('chat:stop', (_e, id) => streams.get(id)?.abort());

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
