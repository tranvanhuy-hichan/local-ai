const $ = (s) => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

let state = { chats: [], currentId: null, model: 'qwen2.5:3b', system: '', temperature: 0.7, numCtx: 8192, lang: 'vi', theme: 'dark' };
let pending = [];   // attachments waiting to be sent
let editing = -1;   // index of the user message being edited
const capsCache = {};
let streaming = null; // { id, chatId }

const cur = () => state.chats.find((c) => c.id === state.currentId);
let saveTimer;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => api.save(state), 300); };

// ---------- markdown (small, safe renderer) ----------
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return s;
}
function md(src) {
  const out = [];
  const parts = src.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2) { // code block (possibly unterminated while streaming)
      const nl = part.indexOf('\n');
      const lang = nl >= 0 ? part.slice(0, nl).trim() : '';
      const code = nl >= 0 ? part.slice(nl + 1) : part;
      out.push(`<pre><div class="ph"><span>${esc(lang || 'code')}</span><button data-copy>Sao chép</button></div><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
      return;
    }
    let list = null, tbl = [];
    const flushTbl = () => {
      if (!tbl.length) return;
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      if (tbl.length > 1 && /^[\s|:-]+$/.test(tbl[1])) {
        out.push('<table><thead><tr>' + cells(tbl[0]).map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>' +
          tbl.slice(2).map((r) => '<tr>' + cells(r).map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      } else tbl.forEach((r) => out.push(`<p>${inline(r)}</p>`));
      tbl = [];
    };
    const close = () => { flushTbl(); if (list) { out.push(`</${list}>`); list = null; } };
    for (const line of part.split('\n')) {
      let m;
      if (/^\s*\|.*\|\s*$/.test(line)) { if (list) close(); tbl.push(line); }
      else if ((m = line.match(/^(#{1,3})\s+(.*)/))) { close(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
      else if ((m = line.match(/^\s*[-*]\s+(.*)/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
      else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
      else if ((m = line.match(/^>\s?(.*)/))) { close(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); }
      else if (line.trim()) { close(); out.push(`<p>${inline(line)}</p>`); }
      else close();
    }
    close();
  });
  return out.join('');
}

// ---------- rendering ----------
function renderHistory() {
  const q = $('#search').value.trim().toLowerCase();
  const chats = state.chats
    .filter((c) => !q || c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)))
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated - a.updated);
  const now = new Date(); const day = 864e5;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const label = (t) => t >= startToday ? 'Hôm nay' : t >= startToday - day ? 'Hôm qua' : t >= startToday - 7 * day ? '7 ngày trước' : 'Cũ hơn';
  const box = $('#history'); box.innerHTML = '';
  let last = '';
  for (const c of chats) {
    const g = c.pinned ? 'Đã ghim' : label(c.updated);
    if (g !== last) { box.insertAdjacentHTML('beforeend', `<div class="group">${g}</div>`); last = g; }
    const el = document.createElement('div');
    el.className = 'item' + (c.id === state.currentId ? ' active' : '');
    el.innerHTML = `<span class="t">${esc(c.title)}</span><span class="acts"><button data-a="pin" title="${c.pinned ? 'Bỏ ghim' : 'Ghim'}">${c.pinned ? '📍' : '📌'}</button><button data-a="ren" title="Đổi tên">✎</button><button data-a="del" title="Xoá">🗑</button></span>`;
    el.onclick = (e) => {
      const a = e.target.dataset.a;
      if (a === 'del') { if (confirm(`Xoá "${c.title}"?`)) deleteChat(c.id); }
      else if (a === 'pin') { c.pinned = !c.pinned; save(); renderHistory(); }
      else if (a === 'ren') rename(c, el);
      else if (!e.target.closest('input')) openChat(c.id);
    };
    box.append(el);
  }
}
function rename(c, el) {
  const t = el.querySelector('.t');
  t.innerHTML = `<input value="${esc(c.title)}">`;
  const inp = t.firstChild; inp.focus(); inp.select();
  const done = (ok) => { if (ok && inp.value.trim()) { c.title = inp.value.trim(); save(); } renderHistory(); };
  inp.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
  inp.onblur = () => done(true);
}

function msgHTML(m, i, last) {
  if (m.role === 'user') {
    if (editing === i) return `<div class="msg user"><div class="edit"><textarea id="editBox" rows="3">${esc(m.content)}</textarea><div class="row"><button data-editcancel>Huỷ</button><button class="primary" data-editsave="${i}">Gửi lại</button></div></div></div>`;
    const atts = (m.attachments || []).map((a) => a.kind === 'image'
      ? `<img src="data:image/jpeg;base64,${a.image}" alt="${esc(a.name)}">` : `<span class="file">📄 ${esc(a.name)}</span>`).join('');
    return `<div class="msg user">${atts ? `<div class="atts">${atts}</div>` : ''}<div class="body">${esc(m.content)}</div>${streaming ? '' : `<div class="tools"><button data-edit="${i}">Sửa</button><button data-copymsg="${i}">Sao chép</button></div>`}</div>`;
  }
  const cls = m.error ? 'msg assistant error' : 'msg assistant';
  const live = streaming && last;
  const tools = live ? '' : `<div class="tools"><button data-copymsg="${i}">Sao chép</button>${last ? '<button data-regen>Tạo lại</button>' : ''}</div>`;
  return `<div class="${cls}"><div class="body"><div class="${live ? 'cursor' : ''}">${m.error ? esc(m.content) : md(m.content)}</div>${tools}</div></div>`;
}
function renderMessages(stick = true) {
  const c = cur(); const sc = $('#messages');
  const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
  $('#msgInner').innerHTML = !c || !c.messages.length
    ? '<div class="empty"><img src="logo.svg" alt="" width="72" height="72"><div>Bạn muốn hỏi gì hôm nay?</div></div>'
    : c.messages.map((m, i) => msgHTML(m, i, i === c.messages.length - 1)).join('');
  if (stick && nearBottom) sc.scrollTop = sc.scrollHeight;
}
function renderAll() { renderHistory(); renderMessages(); updateSend(); }
function updateSend() {
  const b = $('#send');
  b.textContent = streaming ? '■' : '↑';
  b.disabled = !streaming && !$('#input').value.trim() && !pending.length;
}

// ---------- chat actions ----------
function newChat() {
  if (streaming) return;
  const existing = state.chats.find((c) => !c.messages.length);
  if (existing) { state.currentId = existing.id; }
  else {
    const c = { id: uid(), title: 'Đoạn chat mới', messages: [], created: Date.now(), updated: Date.now() };
    state.chats.push(c); state.currentId = c.id;
  }
  renderAll(); $('#input').focus(); save();
}
function openChat(id) { if (streaming) return; state.currentId = id; renderAll(); save(); }
function deleteChat(id) {
  if (streaming?.chatId === id) api.stop(streaming.id);
  state.chats = state.chats.filter((c) => c.id !== id);
  if (state.currentId === id) state.currentId = state.chats.sort((a, b) => b.updated - a.updated)[0]?.id ?? null;
  if (!state.currentId) return newChat();
  renderAll(); save();
}

const toApi = (m) => {
  let content = m.content; const images = [];
  for (const a of m.attachments || []) {
    if (a.kind === 'text') content += `\n\n[Tệp đính kèm: ${a.name}${a.truncated ? ' (đã cắt bớt vì quá dài)' : ''}]\n\`\`\`\n${a.text}\n\`\`\``;
    else images.push(a.image);
  }
  return images.length ? { role: m.role, content, images } : { role: m.role, content };
};
async function hasVision(model) {
  if (!(model in capsCache)) capsCache[model] = (await api.caps(model)).includes('vision');
  return capsCache[model];
}
async function updateBadge() {
  const b = $('#capBadge'), v = await hasVision(state.model);
  b.textContent = v ? '👁 Đọc được ảnh' : 'Chỉ văn bản';
  b.classList.toggle('vision', v);
}

async function generate(chat) {
  let model = state.model;
  if (chat.messages.some((m) => m.attachments?.some((a) => a.kind === 'image')) && !(await hasVision(model))) {
    let alt = null;
    for (const o of $('#modelSel').options) if (await hasVision(o.value)) { alt = o.value; break; }
    if (!alt) {
      chat.messages.push({ role: 'assistant', error: true, content: `Model "${model}" không đọc được ảnh và máy chưa có model vision nào.\nCài một model vision, ví dụ:\n    ollama pull qwen2.5vl:3b\nrồi mở lại app và chọn model đó ở góc trên.` });
      save(); return renderAll();
    }
    model = alt;
  }
  const reply = { role: 'assistant', content: '' };
  chat.messages.push(reply);
  const id = uid();
  streaming = { id, chatId: chat.id };
  const history = chat.messages.slice(0, -1).filter((m) => !m.error).map(toApi);
  const LANG = {
    vi: 'Luôn trả lời bằng tiếng Việt có dấu đầy đủ, tự nhiên và chính xác, dù người dùng hỏi bằng ngôn ngữ nào. Không dùng tiếng Trung. Giữ nguyên code, tên riêng và thuật ngữ kỹ thuật cần thiết.',
    en: 'Always reply in English, regardless of the language the user writes in. Keep code and proper names unchanged.',
    auto: 'Reply in the same language as the user\'s latest message. If it is Vietnamese, use full Vietnamese diacritics. Never reply in Chinese unless asked.',
  };
  const sys = [LANG[state.lang], state.system.trim()].filter(Boolean).join('\n\n');
  history.unshift({ role: 'system', content: sys });
  renderAll();
  let raf = 0;
  api.chat({ id, model, messages: history, options: { temperature: state.temperature, num_ctx: state.numCtx } }, (ev) => {
    if (ev.type === 'token') {
      reply.content += ev.text;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (state.currentId === chat.id) renderMessages(); });
    } else {
      if (ev.type === 'error') { reply.content = ev.error; reply.error = true; }
      if (!reply.content && ev.type === 'done') chat.messages.pop();
      streaming = null; chat.updated = Date.now();
      save(); renderAll();
    }
  });
}

function send(text) {
  let c = cur(); if (!c) { newChat(); c = cur(); }
  const attachments = pending; pending = []; renderChips();
  if (!text) text = 'Hãy xem và tóm tắt nội dung đính kèm.';
  c.messages.push({ role: 'user', content: text, ...(attachments.length && { attachments }) });
  if (c.messages.length === 1) c.title = (text.startsWith('Hãy xem và') ? attachments[0].name : text).replace(/\s+/g, ' ').slice(0, 40);
  c.updated = Date.now();
  generate(c);
}

// ---------- events ----------
const input = $('#input');
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; updateSend(); });
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); } });
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (streaming) return api.stop(streaming.id);
  const t = input.value.trim(); if (!t && !pending.length) return;
  input.value = ''; input.style.height = 'auto';
  send(t);
});
$('#newChat').onclick = newChat;
$('#search').oninput = renderHistory;
$('#toggleSide').onclick = () => $('#sidebar').classList.toggle('hidden');
$('#modelSel').onchange = (e) => { state.model = e.target.value; save(); updateBadge(); };

$('#messages').addEventListener('click', (e) => {
  const t = e.target;
  if (t.dataset.copy !== undefined) {
    navigator.clipboard.writeText(t.closest('pre').querySelector('code').textContent);
    t.textContent = 'Đã chép!'; setTimeout(() => (t.textContent = 'Sao chép'), 1500);
  } else if (t.dataset.copymsg) {
    navigator.clipboard.writeText(cur().messages[+t.dataset.copymsg].content);
    t.textContent = 'Đã chép!'; setTimeout(() => (t.textContent = 'Sao chép'), 1500);
  } else if (t.dataset.edit && !streaming) {
    editing = +t.dataset.edit; renderMessages(false); $('#editBox').focus();
  } else if (t.dataset.editcancel !== undefined) {
    editing = -1; renderMessages(false);
  } else if (t.dataset.editsave && !streaming) {
    const c = cur(), i = +t.dataset.editsave, txt = $('#editBox').value.trim();
    editing = -1; if (!txt) return renderMessages(false);
    c.messages.length = i + 1; c.messages[i].content = txt; c.updated = Date.now(); generate(c);
  } else if (t.dataset.regen !== undefined && !streaming) {
    const c = cur(); c.messages.pop(); generate(c);
  }
});

// settings
const dlg = $('#settings');
$('#settingsBtn').onclick = () => {
  $('#sysPrompt').value = state.system; $('#temp').value = state.temperature;
  $('#tempVal').textContent = state.temperature; $('#theme').value = state.theme; $('#ctx').value = state.numCtx; $('#lang').value = state.lang; dlg.showModal();
};
$('#temp').oninput = (e) => ($('#tempVal').textContent = e.target.value);
dlg.addEventListener('close', () => {
  state.system = $('#sysPrompt').value; state.temperature = +$('#temp').value; state.theme = $('#theme').value; state.numCtx = +$('#ctx').value; state.lang = $('#lang').value;
  document.documentElement.dataset.theme = state.theme; save();
});
$('#clearAll').onclick = () => {
  if (!confirm('Xoá toàn bộ lịch sử chat?')) return;
  if (streaming) api.stop(streaming.id);
  state.chats = []; state.currentId = null; dlg.close(); newChat();
};

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); newChat(); }
});

// ---------- init ----------
(async () => {
  const saved = await api.load();
  if (saved) state = { ...state, ...saved };
  document.documentElement.dataset.theme = state.theme;

  const r = await api.models();
  const sel = $('#modelSel');
  if (r.ok && r.models.length) {
    sel.innerHTML = r.models.map((m) => `<option>${esc(m)}</option>`).join('');
    if (!r.models.includes(state.model)) state.model = r.models.find((m) => m.startsWith('qwen2.5:3b')) || r.models[0];
    sel.value = state.model;
  } else {
    sel.innerHTML = `<option>${esc(state.model)}</option>`;
  }
  if (!state.chats.length || !cur()) { state.currentId = state.chats[0]?.id ?? null; }
  if (!state.currentId) newChat(); else renderAll();
  updateBadge();
  if (!r.ok) {
    cur().messages.push({ role: 'assistant', content: 'Không kết nối được Ollama. Hãy chạy "ollama serve" rồi mở lại app.', error: true });
    renderMessages();
  }
})();

// ---------- attachments ----------
function renderChips() {
  $('#chips').innerHTML = pending.map((a, i) => `<div class="chip">${a.kind === 'image' ? `<img src="data:image/jpeg;base64,${a.image}">` : '📄'}<span>${esc(a.name)}</span><button data-rm="${i}" type="button">✕</button></div>`).join('');
  updateSend();
}
$('#chips').onclick = (e) => { if (e.target.dataset.rm) { pending.splice(+e.target.dataset.rm, 1); renderChips(); } };

// Downscale photos so base64 stays small and the vision model runs faster.
async function prepImage(f) {
  const bmp = await createImageBitmap(f);
  const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
  return { kind: 'image', name: f.name || 'image', image: cv.toDataURL('image/jpeg', 0.85).split(',')[1] };
}
async function addFiles(files) {
  for (const f of files) {
    try {
      const a = f.type.startsWith('image/') ? await prepImage(f)
        : await api.extract({ name: f.name, type: f.type, buffer: await f.arrayBuffer() });
      if (a.error) alert(a.error); else pending.push(a);
    } catch (err) { alert(`Không đọc được "${f.name}": ${err.message}`); }
  }
  renderChips();
}
$('#attach').onclick = () => $('#file').click();
$('#file').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
input.addEventListener('paste', (e) => { if (e.clipboardData.files.length) { e.preventDefault(); addFiles([...e.clipboardData.files]); } });
let dragN = 0;
addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragN++; document.body.classList.add('drag'); } });
addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; document.body.classList.remove('drag'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); dragN = 0; document.body.classList.remove('drag'); addFiles([...e.dataTransfer.files]); });

// ---------- export ----------
$('#exportBtn').onclick = () => {
  const c = cur(); if (!c?.messages.length) return;
  const body = c.messages.map((m) => `## ${m.role === 'user' ? 'Bạn' : 'AI'}\n\n${(m.attachments || []).map((a) => `*[đính kèm: ${a.name}]*\n\n`).join('')}${m.content}`).join('\n\n');
  api.exportChat({ name: c.title, content: `# ${c.title}\n\n${body}\n` });
};

// ---------- bật / tắt model ----------
let modelBusy = false;
async function refreshPower() {
  const b = $('#powerBtn'), list = await api.loaded();
  if (modelBusy) return;
  if (list === null) { b.textContent = '⏻ Ollama tắt'; b.classList.remove('on'); return; }
  const on = list.includes(state.model);
  b.textContent = on ? '⏻ Model: Bật' : '⏻ Model: Tắt';
  b.classList.toggle('on', on);
}
$('#powerBtn').onclick = async () => {
  if (modelBusy) return;
  if (streaming) return alert('Đang trả lời, hãy dừng trước khi tắt model.');
  const list = await api.loaded();
  if (list === null) return alert('Không kết nối được Ollama. Hãy chạy "ollama serve".');
  const on = !list.includes(state.model);
  modelBusy = true;
  const b = $('#powerBtn'); b.classList.add('busy'); b.textContent = on ? '⏻ Đang nạp model...' : '⏻ Đang tắt...';
  const r = await api.power({ model: state.model, on });
  modelBusy = false; b.classList.remove('busy');
  if (!r.ok) alert('Lỗi: ' + r.error);
  refreshPower();
};
$('#modelSel').addEventListener('change', refreshPower);
setInterval(refreshPower, 5000);
refreshPower();
