/* Registro RV · MEDIVIAL — app de campo para retrorreflectividad de señalización vertical.
   Funciona sin conexión: todo se guarda en el celular (IndexedDB) y se envía al Google Sheets cuando hay señal. */
'use strict';

const APP_VERSION = '1.0.2';
const COLOR_NAMES = {
  blanco: 'Blanco', rojo: 'Rojo', amarillo: 'Amarillo', amarillo_verde_fl: 'Amarillo-verde fluorescente',
  azul: 'Azul', verde: 'Verde', cafe: 'Café'
};
const FAM_NAMES = { SR: 'Reglamentaria', SP: 'Preventiva', SI: 'Informativa', ST: 'Turística' };
const RESULT_LABEL = { ok: 'Cumple', bad: 'No cumple', nd: 'Sin referencia', inc: 'Incompleto' };

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const pad = (n, w = 3) => String(n).padStart(w, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`; };
const uid = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const fmt = (n, d = 1) => n == null || !isFinite(n) ? '—' : Number(n).toLocaleString('es-CO', { maximumFractionDigits: d });

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* almacenamiento lleno o bloqueado */ } }
};

/* ---------------- IndexedDB ---------------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open('registro-rv', 1);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains('registros')) db.createObjectStore('registros', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('fotos')) db.createObjectStore('fotos', { keyPath: 'id' });
      };
      rq.onsuccess = () => { this.db = rq.result; res(); };
      rq.onerror = () => rej(rq.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode); const s = t.objectStore(store);
      const rq = fn(s);
      t.oncomplete = () => res(rq && rq.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  put(store, obj) { return this.tx(store, 'readwrite', s => s.put(obj)); },
  get(store, key) { return this.tx(store, 'readonly', s => s.get(key)); },
  del(store, key) { return this.tx(store, 'readwrite', s => s.delete(key)); },
  all(store) { return this.tx(store, 'readonly', s => s.getAll()); }
};

/* ---------------- Estado ---------------- */
let CATALOG = [];
let CFG = null;
let SETTINGS = { apiUrl: '', token: '' };
let JORNADA = null;
let REGS = [];
const F = { senal: null, lecturas: {}, gps: null, fotoBlob: null, fotoUrl: null, fotoChanged: false, editingId: null, confirmKey: '' };
let gpsWatch = null;
let syncing = false;
let lastSyncError = '';
const expanded = new Set();

/* ---------------- Utilidades ---------------- */
function parseNum(v) {
  const s = String(v ?? '').trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return isFinite(n) && n >= 0 ? n : NaN;
}
let toastTimer;
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) { const b = document.createElement('button'); b.type = 'button'; b.textContent = action.label; b.onclick = () => { t.hidden = true; action.fn(); }; t.appendChild(b); }
  t.hidden = false; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 12000 : 3200);
}
function showError(el, msg, ok) { el.textContent = msg; el.classList.toggle('ok', !!ok); el.hidden = !msg; }

/* ---------------- Evaluación ---------------- */
function colorsFor(senal, spColor) {
  if (!senal) return [];
  if (senal.sel) return spColor ? [{ color: spColor, rol: 'Predominante' }] : [];
  const out = [{ color: senal.p, rol: 'Predominante' }];
  if (senal.q) out.push({ color: senal.q, rol: 'Secundario' });
  return out;
}
function evalColor(color, raw, lamina) {
  const vals = (raw || ['', '', '']).map(parseNum);
  const invalid = vals.some(v => Number.isNaN(v));
  const nums = vals.filter(v => typeof v === 'number' && !Number.isNaN(v));
  const complete = nums.length === 3 && !invalid;
  const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  const base = lamina && CFG.minimos[lamina] ? CFG.minimos[lamina][color] : undefined;
  const pctEval = Number(CFG.porcentaje_evaluacion) || 100;
  const minimo = base != null && base !== '' ? Number(base) * pctEval / 100 : null;
  const porcentaje = avg != null && base ? avg / Number(base) * 100 : null;
  let estado;
  if (!complete) estado = 'inc';
  else if (minimo == null) estado = 'nd';
  else estado = avg >= minimo ? 'ok' : 'bad';
  return { vals, invalid, complete, avg, base: base ?? null, minimo, porcentaje, estado };
}
function overall(states) {
  if (!states.length || states.includes('inc')) return 'inc';
  if (states.includes('bad')) return 'bad';
  if (states.includes('nd')) return 'nd';
  return 'ok';
}
const chip = st => `<span class="chip chip-${st === 'inc' ? 'nd' : st}">${RESULT_LABEL[st]}</span>`;

/* ---------------- Navegación ---------------- */
function show(name) {
  $$('.screen').forEach(s => { s.hidden = s.id !== 'scr-' + name; });
  $('#tabbar').hidden = !JORNADA || name === 'jornada' || name === 'ajustes';
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.go === name));
  if (name === 'registro') { renderJornadaBar(); if (!F.editingId && !F.gps) startGps(); }
  else stopGps();
  if (name === 'lista') renderLista();
  if (name === 'jornada') fillJornadaForm();
  if (name === 'ajustes') fillAjustes();
  window.scrollTo(0, 0);
}

/* ---------------- Jornada ---------------- */
function fillSelect(sel, items, value, placeholder) {
  sel.innerHTML = `<option value="">${esc(placeholder)}</option>` + items.map(v => `<option${v === value ? ' selected' : ''}>${esc(v)}</option>`).join('');
  if (value && !items.includes(value)) sel.insertAdjacentHTML('beforeend', `<option selected>${esc(value)}</option>`);
}
function fillJornadaForm() {
  const j = JORNADA || LS.get('rv.jornada.ultima', null) || {};
  $('#j-fecha').value = today();
  fillSelect($('#j-proyecto'), CFG.proyectos, j.proyecto, 'Selecciona el proyecto');
  fillSelect($('#j-tecnico'), CFG.tecnicos, j.tecnico, 'Selecciona el técnico');
  fillSelect($('#j-equipo'), CFG.equipos, j.equipo, 'Selecciona el serial');
  (j.division === 'UF' ? $('#j-div-uf') : $('#j-div-tramo')).checked = true;
  (j.sistema === 'PR' ? $('#j-sis-pr') : $('#j-sis-k')).checked = true;
  $('#j-tramo').value = j.tramo || '';
  refreshTramos();
  showError($('#j-error'), '');
}
function refreshTramos() {
  const mem = LS.get('rv.tramos', {});
  const proj = $('#j-proyecto').value;
  const div = $('input[name=j-division]:checked').value;
  const list = (mem[proj] || []).filter(t => t.d === div).map(t => t.v);
  $('#dl-tramos').innerHTML = list.map(v => `<option value="${esc(v)}">`).join('');
  $('#j-tramo').placeholder = div === 'UF' ? 'Número de UF (ej. 3)' : 'Nombre del tramo';
}
function submitJornada(e) {
  e.preventDefault();
  const j = {
    fecha: $('#j-fecha').value, proyecto: $('#j-proyecto').value,
    division: $('input[name=j-division]:checked').value, tramo: $('#j-tramo').value.trim(),
    tecnico: $('#j-tecnico').value, equipo: $('#j-equipo').value,
    sistema: $('input[name=j-sistema]:checked').value
  };
  const miss = [];
  if (!j.fecha) miss.push('fecha'); if (!j.proyecto) miss.push('proyecto');
  if (!j.tramo) miss.push(j.division === 'UF' ? 'UF' : 'tramo');
  if (!j.tecnico) miss.push('técnico'); if (!j.equipo) miss.push('serial del equipo');
  if (miss.length) { showError($('#j-error'), 'Falta: ' + miss.join(', ') + '.'); return; }
  j.id = (JORNADA && JORNADA.proyecto === j.proyecto && JORNADA.fecha === j.fecha) ? JORNADA.id : 'J' + Date.now().toString(36);
  JORNADA = j;
  LS.set('rv.jornada', j); LS.set('rv.jornada.ultima', j);
  const mem = LS.get('rv.tramos', {});
  const arr = mem[j.proyecto] || [];
  if (!arr.some(t => t.d === j.division && t.v === j.tramo)) arr.push({ d: j.division, v: j.tramo });
  mem[j.proyecto] = arr; LS.set('rv.tramos', mem);
  if (!F.editingId) resetRegistro(true);
  show('registro');
}
function renderJornadaBar() {
  if (!JORNADA) return;
  $('#jb-main').textContent = JORNADA.proyecto;
  const [y, m, d] = JORNADA.fecha.split('-');
  $('#jb-sub').textContent = `${d}/${m}/${y} · ${JORNADA.division} ${JORNADA.tramo} · ${JORNADA.tecnico} · 922 ${JORNADA.equipo}`;
  $('#abs-prefix').textContent = (F.editingId ? (REGS.find(r => r.id === F.editingId) || {}).sistema : null) || JORNADA.sistema;
  updateAbsPreview();
}

/* ---------------- Registro: señal ---------------- */
function familia() { const r = $('input[name=r-familia]:checked'); return r ? r.value : ''; }
function renderPicker() {
  const fam = familia();
  $('#picker').hidden = !fam || !!F.senal;
  if (!fam) return;
  const q = norm($('#r-buscar').value.trim());
  const list = CATALOG.filter(s => s.f === fam && (!q || norm(s.c).includes(q) || norm(s.n).includes(q) || s.c.split('-')[1].toLowerCase().startsWith(q)));
  $('#picker-list').innerHTML = list.length
    ? list.map(s => `<li><button type="button" data-code="${esc(s.c)}"><span class="pk-code">${esc(s.c)}</span><span class="pk-name">${esc(s.n)}</span></button></li>`).join('')
    : `<li class="pk-empty">Ninguna señal ${esc(FAM_NAMES[fam].toLowerCase())} coincide con “${esc($('#r-buscar').value)}”.</li>`;
}
function selectSenal(code) {
  const s = CATALOG.find(x => x.c === code);
  if (!s) return;
  F.senal = s;
  const radio = $('#fam-' + s.f); if (radio) radio.checked = true;
  $('#sign-code').textContent = s.c;
  $('#sign-name').textContent = s.n;
  const cols = s.sel ? '<span>Lámina amarilla o amarillo-verde fluorescente</span>'
    : colorsFor(s).map(c => `<span class="sw sw-${c.color}"></span><span>${COLOR_NAMES[c.color]}</span>`).join('');
  $('#sign-sub').innerHTML = `<span>${esc(s.s)} ·</span> ${cols}`;
  const thumb = $('#sign-thumb');
  thumb.innerHTML = `<span class="fam-${s.f.toLowerCase()} fam-shape-wrap"><span class="fam-shape"></span></span>`;
  if (s.img) {
    const img = new Image(); img.alt = ''; img.src = 'img/' + s.img;
    img.onload = () => { thumb.innerHTML = ''; thumb.appendChild(img); };
  }
  $('#sign-card').hidden = false;
  $('#picker').hidden = true;
  $('#sp-color-field').hidden = !s.sel;
  renderLecturas();
}
function clearSenal() {
  F.senal = null; $('#sign-card').hidden = true; $('#sp-color-field').hidden = true;
  $('#r-buscar').value = ''; renderPicker(); renderLecturas();
}

/* ---------------- Registro: lecturas ---------------- */
function lamina() { const r = $('input[name=r-lamina]:checked'); return r ? r.value : ''; }
function spColor() { const r = $('input[name=r-spcolor]:checked'); return r ? r.value : ''; }
function buildLaminaSeg() {
  const seg = $('#lamina-seg');
  const cur = lamina() || LS.get('rv.ultimaLamina', '');
  seg.innerHTML = CFG.tipos_lamina.map(t => {
    const id = 'lam-' + String(t).replace(/[^A-Za-z0-9]/g, '');
    return `<input type="radio" name="r-lamina" id="${id}" value="${esc(t)}"${t === cur ? ' checked' : ''}><label for="${id}">Tipo ${esc(t)}</label>`;
  }).join('');
}
function renderLecturas() {
  const cols = colorsFor(F.senal, spColor());
  const box = $('#lecturas');
  const needLam = F.senal && !lamina();
  $('#lecturas-empty').hidden = cols.length > 0 && !needLam;
  if (F.senal && F.senal.sel && !spColor()) $('#lecturas-empty').textContent = 'Indica el color de la lámina (paso 3) para habilitar las lecturas.';
  else if (needLam) $('#lecturas-empty').textContent = 'Indica el tipo de lámina (paso 3) para compararlo con el mínimo.';
  else $('#lecturas-empty').textContent = 'Elige la señal y el tipo de lámina para ver los colores a medir.';
  box.innerHTML = cols.map(c => {
    const v = F.lecturas[c.color] || ['', '', ''];
    return `<div class="lect" data-color="${c.color}">
      <div class="lect-head"><span class="sw sw-${c.color}"></span>${COLOR_NAMES[c.color]} <span class="lect-role">${c.rol}</span></div>
      <div class="lect-inputs">${[0, 1, 2].map(i => `<input type="text" inputmode="decimal" class="num-input" id="l-${c.color}-${i}" data-color="${c.color}" data-i="${i}" value="${esc(v[i])}" placeholder="L${i + 1}" aria-label="${COLOR_NAMES[c.color]} lectura ${i + 1}" autocomplete="off">`).join('')}</div>
      <div class="lect-foot"><div class="lect-stats" id="st-${c.color}"></div><span id="ch-${c.color}"></span></div>
    </div>`;
  }).join('');
  updateEval();
}
function updateEval() {
  const cols = colorsFor(F.senal, spColor());
  const lam = lamina();
  const states = [];
  cols.forEach(c => {
    const ev = evalColor(c.color, F.lecturas[c.color], lam);
    states.push(ev.estado);
    const st = $('#st-' + c.color), ch = $('#ch-' + c.color);
    if (!st) return;
    st.innerHTML = `<span>Prom. <b>${fmt(ev.avg)}</b></span><span>Mín. <b>${ev.minimo == null ? '—' : fmt(ev.minimo)}</b></span><span><b>${ev.porcentaje == null ? '—' : fmt(ev.porcentaje, 0) + ' %'}</b></span>`;
    ch.innerHTML = ev.invalid ? '<span class="chip chip-bad">Revisa el valor</span>' : chip(ev.estado);
  });
  const res = overall(states);
  $('#savebar-result').innerHTML = cols.length ? chip(res) : '<span class="chip chip-nd">Sin evaluar</span>';
}

/* ---------------- Registro: abscisa ---------------- */
function updateAbsPreview() {
  const km = $('#r-km').value, m = $('#r-m').value;
  const pre = $('#abs-prefix').textContent;
  $('#abs-preview').textContent = km !== '' ? `${pre} ${km}+${m === '' ? '___' : pad(m)}` : '';
}

/* ---------------- GPS ---------------- */
function startGps() {
  stopGps();
  const stEl = $('#gps-state');
  if (!('geolocation' in navigator)) { stEl.textContent = 'Este navegador no tiene GPS'; stEl.className = 'gps-state bad'; return; }
  stEl.textContent = 'Buscando GPS…'; stEl.className = 'gps-state';
  gpsWatch = navigator.geolocation.watchPosition(p => {
    const g = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, t: new Date(p.timestamp).toISOString() };
    if (!F.gps || g.acc <= F.gps.acc || (Date.now() - Date.parse(F.gps.t)) > 30000) F.gps = g;
    renderGps();
  }, err => {
    stEl.className = 'gps-state bad';
    stEl.textContent = err.code === 1 ? 'GPS sin permiso: actívalo para este sitio en el navegador' : 'No se pudo obtener la ubicación. Toca Actualizar.';
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}
function stopGps() { if (gpsWatch != null) { navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; } }
function renderGps() {
  const stEl = $('#gps-state'), co = $('#gps-coords');
  if (!F.gps) { co.textContent = '—'; return; }
  const a = Math.round(F.gps.acc);
  stEl.className = 'gps-state ' + (a <= 10 ? 'good' : a <= 30 ? 'fair' : 'bad');
  stEl.textContent = `Precisión ±${a} m` + (gpsWatch != null ? ' · afinando' : '');
  co.textContent = `${F.gps.lat.toFixed(6)}, ${F.gps.lon.toFixed(6)}`;
}

/* ---------------- Foto ---------------- */
async function compressImage(file) {
  const max = 1600;
  let src, w, h;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' }); w = src.width; h = src.height;
  } catch (e) {
    src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
    w = src.naturalWidth; h = src.naturalHeight;
  }
  const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.8));
}
function setFoto(blob) {
  if (F.fotoUrl) URL.revokeObjectURL(F.fotoUrl);
  F.fotoBlob = blob; F.fotoUrl = blob ? URL.createObjectURL(blob) : null;
  $('#photo-thumb').hidden = !blob;
  if (blob) $('#photo-img').src = F.fotoUrl;
  $('#foto-label').textContent = blob ? 'Repetir foto' : 'Tomar foto';
}

/* ---------------- Guardar ---------------- */
function nextConsecutivo(proyecto) {
  const nums = REGS.filter(r => r.proyecto === proyecto && !r.anulado).map(r => Number(r.consecutivo) || 0);
  const mem = LS.get('rv.consec', {});
  return Math.max(0, mem[proyecto] || 0, ...nums) + 1;
}
function nextGarmin() {
  const last = LS.get('rv.ultimaGarmin', '');
  if (!/^\d+$/.test(last)) return '';
  return String(Number(last) + 1).padStart(Math.max(4, last.length), '0');
}
function resetRegistro(keepFamily) {
  F.senal = null; F.lecturas = {}; F.editingId = null; F.confirmKey = ''; F.fotoChanged = false; setFoto(null);
  if (!keepFamily) $$('input[name=r-familia]').forEach(r => { r.checked = false; });
  $$('input[name=r-spcolor]').forEach(r => { r.checked = false; });
  $('#sign-card').hidden = true; $('#sp-color-field').hidden = true; $('#r-buscar').value = '';
  $('#r-m').value = ''; $('#r-obs').value = ''; $('#r-foto').value = '';
  if (JORNADA) $('#r-consecutivo').value = nextConsecutivo(JORNADA.proyecto);
  $('#r-garmin').value = nextGarmin();
  $('#edit-banner').hidden = true; $('#btn-guardar').textContent = 'Guardar señal';
  showError($('#r-error'), '');
  buildLaminaSeg(); renderPicker(); renderLecturas();
  F.gps = null; renderGps();
}
async function submitRegistro(e) {
  e.preventDefault();
  const err = $('#r-error');
  const editing = F.editingId ? REGS.find(r => r.id === F.editingId) : null;
  const base = editing || JORNADA;
  const s = F.senal, lam = lamina(), spc = spColor();
  const km = $('#r-km').value.trim(), m = $('#r-m').value.trim();
  const consec = $('#r-consecutivo').value.trim();
  const garmin = $('#r-garmin').value.trim();
  const errors = [];
  if (!s) errors.push('Elige la señal (paso 1).');
  if (!/^\d+$/.test(consec) || Number(consec) < 1) errors.push('Escribe el número de la señal.');
  if (!/^\d+$/.test(km)) errors.push('Escribe el kilómetro de la abscisa.');
  if (!/^\d{1,3}$/.test(m)) errors.push('Escribe los metros de la abscisa (0 a 999).');
  if (!lam) errors.push('Elige el tipo de lámina.');
  if (s && s.sel && !spc) errors.push('Indica si la lámina es amarilla o amarillo-verde fluorescente.');
  const cols = colorsFor(s, spc);
  const evals = cols.map(c => ({ ...c, ev: evalColor(c.color, F.lecturas[c.color], lam) }));
  evals.forEach(c => {
    if (c.ev.invalid) errors.push(`Hay un valor no numérico en ${COLOR_NAMES[c.color]}.`);
    else if (!c.ev.complete) errors.push(`Faltan lecturas de ${COLOR_NAMES[c.color]} (se necesitan 3).`);
  });
  if (garmin && !/^\d{4,}$/.test(garmin)) errors.push('El consecutivo de la foto Garmin debe tener al menos 4 dígitos.');
  if (errors.length) { showError(err, errors.join(' ')); err.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }

  const warns = [];
  if (!F.gps) warns.push('no hay ubicación GPS');
  if (!garmin) warns.push('falta el consecutivo de la foto Garmin');
  const dup = REGS.find(r => r.proyecto === base.proyecto && !r.anulado && String(r.consecutivo) === consec && r.id !== F.editingId);
  if (dup) warns.push(`el N.º ${consec} ya existe en este proyecto (${dup.codigo})`);
  const key = warns.join('|');
  if (warns.length && F.confirmKey !== key) {
    F.confirmKey = key;
    showError(err, 'Atención: ' + warns.join('; ') + '. Toca Guardar otra vez para guardar así.');
    err.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }

  const now = new Date().toISOString();
  const res = overall(evals.map(c => c.ev.estado));
  const rec = {
    id: editing ? editing.id : uid(),
    jornada_id: base.jornada_id || base.id,
    fecha: base.fecha, proyecto: base.proyecto, division: base.division, tramo: base.tramo,
    tecnico: base.tecnico, equipo: base.equipo, sistema: editing ? editing.sistema : JORNADA.sistema,
    consecutivo: Number(consec), familia: s.f, codigo: s.c, nombre: s.n, subfamilia: s.s,
    km: Number(km), m: Number(m),
    lamina: lam, color_lamina_sp: s.sel ? spc : '',
    colores: evals.map(c => ({
      color: c.color, rol: c.rol, lecturas: c.ev.vals, promedio: round(c.ev.avg, 2),
      minimo: c.ev.minimo == null ? null : round(c.ev.minimo, 2), porcentaje: c.ev.porcentaje == null ? null : round(c.ev.porcentaje, 1),
      cumple: c.ev.estado === 'ok' ? 'Sí' : c.ev.estado === 'bad' ? 'No' : 'Sin referencia'
    })),
    resultado: RESULT_LABEL[res], porcentaje_evaluacion: Number(CFG.porcentaje_evaluacion) || 100,
    lat: F.gps ? round(F.gps.lat, 7) : null, lon: F.gps ? round(F.gps.lon, 7) : null,
    precision_m: F.gps ? Math.round(F.gps.acc) : null, gps_hora: F.gps ? F.gps.t : null,
    foto_garmin: garmin, observaciones: $('#r-obs').value.trim(),
    tiene_foto: !!F.fotoBlob || (editing && !F.fotoChanged ? !!editing.tiene_foto : false),
    foto_url: editing && !F.fotoChanged ? (editing.foto_url || '') : '',
    foto_pendiente: F.fotoChanged ? !!F.fotoBlob : (editing ? !!editing.foto_pendiente : false),
    creado: editing ? editing.creado : now, modificado: now, app_version: APP_VERSION,
    estado_sync: 'pendiente', anulado: false, error: null,
    enviado_alguna_vez: editing ? !!editing.enviado_alguna_vez : false
  };
  rec.abscisa = `${rec.sistema} ${rec.km}+${pad(rec.m)}`;
  try {
    if (F.fotoChanged) {
      if (F.fotoBlob) await DB.put('fotos', { id: rec.id, blob: F.fotoBlob });
      else await DB.del('fotos', rec.id);
    }
    await DB.put('registros', rec);
  } catch (ex) {
    showError(err, 'No se pudo guardar en el celular: ' + (ex && ex.message || ex) + '. Revisa el espacio disponible.');
    return;
  }
  const i = REGS.findIndex(r => r.id === rec.id);
  if (i >= 0) REGS[i] = rec; else REGS.push(rec);
  if (!editing) {
    const mem = LS.get('rv.consec', {}); mem[rec.proyecto] = Math.max(mem[rec.proyecto] || 0, rec.consecutivo); LS.set('rv.consec', mem);
    if (garmin) LS.set('rv.ultimaGarmin', garmin);
  }
  LS.set('rv.ultimaLamina', lam);
  updatePending();
  const label = `N.º ${rec.consecutivo} · ${rec.codigo} · ${rec.abscisa}`;
  if (editing) {
    resetRegistro(false); toast(`Registro actualizado: ${label}`); show('lista');
  } else {
    resetRegistro(true); toast(`Señal guardada: ${label} · ${rec.resultado}`);
    startGps(); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  sync(false);
}
function round(n, d) { if (n == null || !isFinite(n)) return null; const f = 10 ** d; return Math.round(n * f) / f; }

/* ---------------- Editar ---------------- */
async function editRecord(id) {
  const r = REGS.find(x => x.id === id); if (!r) return;
  resetRegistro(false);
  F.editingId = id;
  stopGps();
  $('#fam-' + r.familia).checked = true;
  selectSenal(r.codigo);
  $('#r-consecutivo').value = r.consecutivo;
  $('#r-km').value = r.km; $('#r-m').value = pad(r.m);
  buildLaminaSeg();
  $$('input[name=r-lamina]').forEach(x => { x.checked = x.value === r.lamina; });
  if (r.color_lamina_sp) $$('input[name=r-spcolor]').forEach(x => { x.checked = x.value === r.color_lamina_sp; });
  F.lecturas = {};
  r.colores.forEach(c => { F.lecturas[c.color] = c.lecturas.map(v => v == null ? '' : String(v).replace('.', ',')); });
  renderLecturas();
  F.gps = r.lat != null ? { lat: r.lat, lon: r.lon, acc: r.precision_m || 0, t: r.gps_hora || r.creado } : null;
  renderGps();
  if (F.gps) { $('#gps-state').textContent = `Guardada · ±${r.precision_m} m`; }
  else { $('#gps-state').textContent = 'Sin ubicación guardada'; $('#gps-state').className = 'gps-state bad'; }
  $('#r-garmin').value = r.foto_garmin || ''; $('#r-obs').value = r.observaciones || '';
  const f = await DB.get('fotos', r.id).catch(() => null);
  if (f && f.blob) setFoto(f.blob);
  F.fotoChanged = false;
  $('#edit-banner-text').textContent = `Editando N.º ${r.consecutivo} · ${r.codigo} (${r.fecha})`;
  $('#edit-banner').hidden = false; $('#btn-guardar').textContent = 'Guardar cambios';
  show('registro');
}

/* ---------------- Lista ---------------- */
function scopeRecords() {
  if (!JORNADA) return [];
  const all = $('input[name=f-alcance]:checked').value === 'todo';
  return REGS.filter(r => !r.anulado && r.proyecto === JORNADA.proyecto && (all || r.fecha === JORNADA.fecha))
    .sort((a, b) => (b.creado || '').localeCompare(a.creado || ''));
}
async function renderLista() {
  const list = scopeRecords();
  const all = $('input[name=f-alcance]:checked').value === 'todo';
  $('#lista-lead').textContent = JORNADA ? `${JORNADA.proyecto} · ${all ? 'todas las jornadas guardadas en este celular' : 'jornada del ' + JORNADA.fecha.split('-').reverse().join('/')}` : '';
  const ok = list.filter(r => r.resultado === 'Cumple').length;
  const bad = list.filter(r => r.resultado === 'No cumple').length;
  const pend = list.filter(r => r.estado_sync !== 'enviado').length;
  $('#summary').innerHTML = `
    <div class="sum"><b>${list.length}</b><span>Señales</span></div>
    <div class="sum ok"><b>${ok}</b><span>Cumplen</span></div>
    <div class="sum bad"><b>${bad}</b><span>No cumplen</span></div>
    <div class="sum pend"><b>${pend}</b><span>Por enviar</span></div>`;
  if (!list.length) {
    $('#lista').innerHTML = `<div class="list-empty"><b>Aún no hay señales registradas${all ? ' en este proyecto' : ' en esta jornada'}.</b>Ve a Registrar, elige la familia y el código de la primera señal.</div>`;
    return;
  }
  $('#lista').innerHTML = list.map(r => {
    const st = r.resultado === 'Cumple' ? 'ok' : r.resultado === 'No cumple' ? 'bad' : 'nd';
    const syncTxt = r.estado_sync === 'enviado' ? 'Enviado' : r.error ? 'Error al enviar' : 'Por enviar';
    const syncCls = r.estado_sync === 'enviado' ? '' : r.error ? 'err' : 'pend';
    const open = expanded.has(r.id);
    return `<article class="rec" data-id="${r.id}">
      <button type="button" class="rec-head" aria-expanded="${open}">
        <span class="rec-n">${r.consecutivo}</span>
        <span class="rec-title"><span class="code">${esc(r.codigo)}</span><span class="abs">${esc(r.abscisa)}</span></span>
        <span class="rec-meta"><span>${esc(r.nombre)}</span><span>· Tipo ${esc(r.lamina)}</span>${r.foto_garmin ? `<span>· G${esc(r.foto_garmin)}</span>` : ''}</span>
        <span class="rec-side">${chip(st)}<span class="sync-tag ${syncCls}">${syncTxt}</span></span>
      </button>
      <div class="rec-body" ${open ? '' : 'hidden'}>${open ? recBody(r) : ''}</div>
    </article>`;
  }).join('');
  list.filter(r => expanded.has(r.id)).forEach(loadThumb);
}
function recBody(r) {
  const rows = r.colores.map(c => `<tr><td><span class="sw sw-${c.color}"></span> ${COLOR_NAMES[c.color]}</td>${c.lecturas.map(v => `<td>${fmt(v)}</td>`).join('')}<td><b>${fmt(c.promedio)}</b></td><td>${fmt(c.minimo)}</td><td>${c.porcentaje == null ? '—' : fmt(c.porcentaje, 0) + '%'}</td></tr>`).join('');
  const gps = r.lat != null ? `${r.lat.toFixed(6)}, ${r.lon.toFixed(6)} (±${r.precision_m} m)` : 'Sin GPS';
  return `<div style="overflow-x:auto"><table class="rec-table"><thead><tr><th>Color</th><th>L1</th><th>L2</th><th>L3</th><th>Prom.</th><th>Mín.</th><th>%</th></tr></thead><tbody>${rows}</tbody></table></div>
    <dl class="kv">
      <dt>${esc(r.division)}</dt><dd>${esc(r.tramo)}</dd>
      <dt>Técnico</dt><dd>${esc(r.tecnico)} · 922 ${esc(r.equipo)}</dd>
      <dt>GPS</dt><dd>${gps}</dd>
      <dt>Foto Garmin</dt><dd>${esc(r.foto_garmin || '—')}</dd>
      ${r.color_lamina_sp ? `<dt>Lámina</dt><dd>${COLOR_NAMES[r.color_lamina_sp]}</dd>` : ''}
      ${r.observaciones ? `<dt>Obs.</dt><dd>${esc(r.observaciones)}</dd>` : ''}
      ${r.error ? `<dt>Envío</dt><dd style="color:var(--bad)">${esc(r.error)}</dd>` : ''}
    </dl>
    <div class="rec-photo" id="ph-${r.id}"></div>
    <div class="row-btns" data-actions="${r.id}">
      <button type="button" class="btn btn-secondary btn-sm" data-edit="${r.id}">Editar</button>
      <button type="button" class="btn btn-ghost btn-sm" data-anular="${r.id}">Anular</button>
    </div>`;
}
async function loadThumb(r) {
  const box = document.getElementById('ph-' + r.id); if (!box) return;
  const f = await DB.get('fotos', r.id).catch(() => null);
  if (f && f.blob) {
    const u = URL.createObjectURL(f.blob);
    box.innerHTML = `<div class="photo-thumb"><img src="${u}" alt="Foto de ${esc(r.codigo)}"></div>`;
  } else if (r.foto_url) {
    box.innerHTML = `<a href="${esc(r.foto_url)}" target="_blank" rel="noopener">Ver foto en Drive</a>`;
  }
}
async function anular(id) {
  const r = REGS.find(x => x.id === id); if (!r) return;
  if (r.estado_sync !== 'enviado' && !r.enviado_alguna_vez) {
    await DB.del('registros', id); await DB.del('fotos', id).catch(() => {});
    REGS = REGS.filter(x => x.id !== id);
  } else {
    r.anulado = true; r.estado_sync = 'pendiente'; r.error = null; r.modificado = new Date().toISOString();
    await DB.put('registros', r);
  }
  expanded.delete(id);
  updatePending(); renderLista();
  toast(`N.º ${r.consecutivo} · ${r.codigo} anulado`);
  sync(false);
}

/* ---------------- Sincronización ---------------- */
function pendingList() { return REGS.filter(r => r.estado_sync !== 'enviado'); }
function updatePending() {
  const n = pendingList().length;
  const b = $('#badge-pend'); b.hidden = !n; b.textContent = n;
  const pill = $('#sync-pill');
  pill.classList.toggle('pending', n > 0);
  pill.classList.toggle('offline', !navigator.onLine || !SETTINGS.apiUrl);
  pill.classList.toggle('busy', syncing);
  let t;
  if (syncing) t = 'Enviando…';
  else if (!SETTINGS.apiUrl) t = n ? `${n} en el celular` : 'Sin conectar';
  else if (!navigator.onLine) t = n ? `${n} por enviar · sin señal` : 'Sin señal';
  else if (n && lastSyncError) t = `${n} por enviar · reintentar`;
  else t = n ? `${n} por enviar` : 'Todo enviado';
  $('#sync-text').textContent = t;
}
function blobToB64(blob) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(blob); });
}
function fotoNombre(r) {
  const safe = s => String(s).replace(/[^A-Za-z0-9+_-]/g, '');
  return `${pad(r.consecutivo)}_${safe(r.codigo)}_${safe(r.sistema)}${r.km}+${pad(r.m)}${r.foto_garmin ? '_G' + safe(r.foto_garmin) : ''}.jpg`;
}
function toSheet(r) {
  const c1 = r.colores[0] || {}, c2 = r.colores[1] || {};
  const col = (c, p) => ({
    [p + '_color']: c.color ? COLOR_NAMES[c.color] : '', [p + '_l1']: c.lecturas ? c.lecturas[0] : '', [p + '_l2']: c.lecturas ? c.lecturas[1] : '',
    [p + '_l3']: c.lecturas ? c.lecturas[2] : '', [p + '_promedio']: c.promedio ?? '', [p + '_minimo']: c.minimo ?? '',
    [p + '_porcentaje']: c.porcentaje ?? '', [p + '_cumple']: c.cumple || ''
  });
  return {
    id: r.id, estado: r.anulado ? 'ANULADO' : 'ACTIVO', fecha: r.fecha, proyecto: r.proyecto, division: r.division, tramo_uf: r.tramo,
    tecnico: r.tecnico, equipo_serial: r.equipo, consecutivo: r.consecutivo, familia: FAM_NAMES[r.familia], codigo: r.codigo, nombre: r.nombre,
    sistema_abscisa: r.sistema, km: r.km, m: r.m, abscisa: r.abscisa, tipo_lamina: r.lamina,
    color_lamina_sp: r.color_lamina_sp ? COLOR_NAMES[r.color_lamina_sp] : '',
    ...col(c1, 'c1'), ...col(c2, 'c2'),
    resultado: r.resultado, porcentaje_evaluacion: r.porcentaje_evaluacion,
    latitud: r.lat ?? '', longitud: r.lon ?? '', precision_m: r.precision_m ?? '', foto_garmin: r.foto_garmin || '',
    observaciones: r.observaciones || '', registrado: r.creado, modificado: r.modificado, app_version: r.app_version
  };
}
async function sync(manual) {
  if (syncing) return;
  if (!SETTINGS.apiUrl) { if (manual) toast('Falta conectar el Google Sheets: abre Ajustes (engranaje).'); updatePending(); return; }
  if (!navigator.onLine) { if (manual) toast('Sin señal. Los registros quedan guardados en el celular.'); updatePending(); return; }
  const pend = pendingList();
  if (!pend.length) { if (manual) toast('No hay registros por enviar.'); updatePending(); return; }
  syncing = true; updatePending();
  let sent = 0, failed = 0;
  for (const r of pend) {
    try {
      const payload = { token: SETTINGS.token, accion: r.anulado ? 'anular' : 'guardar', registro: toSheet(r) };
      if (!r.anulado && r.foto_pendiente) {
        const f = await DB.get('fotos', r.id);
        if (f && f.blob) payload.foto = { base64: await blobToB64(f.blob), mime: 'image/jpeg', nombre: fotoNombre(r) };
      }
      const resp = await fetch(SETTINGS.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow' });
      const j = await resp.json();
      if (!j.ok) throw new Error(j.error || 'El Sheets rechazó el registro');
      if (r.anulado) {
        await DB.del('registros', r.id); await DB.del('fotos', r.id).catch(() => {});
        REGS = REGS.filter(x => x.id !== r.id);
      } else {
        r.estado_sync = 'enviado'; r.enviado_alguna_vez = true; r.error = null;
        if (payload.foto) { r.foto_pendiente = false; if (j.foto_url) r.foto_url = j.foto_url; await DB.del('fotos', r.id).catch(() => {}); }
        await DB.put('registros', r);
      }
      sent++;
    } catch (ex) {
      failed++;
      const netErr = ex instanceof TypeError;
      lastSyncError = netErr ? 'Sin conexión con el Sheets' : String(ex.message || ex);
      if (!netErr) { r.error = lastSyncError; await DB.put('registros', r).catch(() => {}); }
      if (netErr) break;
    }
    updatePending();
  }
  if (!failed) lastSyncError = '';
  syncing = false; updatePending();
  if (!$('#scr-lista').hidden) renderLista();
  if (manual) {
    if (failed) toast(`Enviados ${sent}. No se pudo enviar ${failed}: ${lastSyncError}.`);
    else toast(`Enviados ${sent} registros al Sheets.`);
  }
}

/* ---------------- Configuración remota ---------------- */
async function refreshConfig(report) {
  if (!SETTINGS.apiUrl || !navigator.onLine) return false;
  try {
    const u = SETTINGS.apiUrl + (SETTINGS.apiUrl.includes('?') ? '&' : '?') + 'accion=config&token=' + encodeURIComponent(SETTINGS.token || '');
    const resp = await fetch(u, { redirect: 'follow' });
    const j = await resp.json();
    if (!j.ok) throw new Error(j.error || 'Respuesta inválida');
    const c = j.config;
    if (!Array.isArray(c.proyectos) || !Array.isArray(c.tecnicos) || !Array.isArray(c.equipos) || !c.minimos) throw new Error('La configuración del Sheets está incompleta');
    c.tipos_lamina = c.tipos_lamina && c.tipos_lamina.length ? c.tipos_lamina : Object.keys(c.minimos);
    c.origen = 'Google Sheets, actualizado ' + new Date().toLocaleString('es-CO');
    CFG = c; LS.set('rv.cfg', c);
    if (!$('#scr-registro').hidden && !F.editingId) { buildLaminaSeg(); updateEval(); }
    return true;
  } catch (ex) {
    if (report) throw ex;
    return false;
  }
}

/* ---------------- Ajustes ---------------- */
function fillAjustes() {
  $('#a-url').value = SETTINGS.apiUrl || ''; $('#a-token').value = SETTINGS.token || '';
  $('#cfg-origen').textContent = CFG.origen || 'valores incluidos en la app (aún sin conectar al Sheets)';
  $('#cat-count').textContent = CATALOG.length;
  $('#app-version').textContent = APP_VERSION;
  showError($('#a-msg'), '');
}
async function submitAjustes(e) {
  e.preventDefault();
  SETTINGS = { apiUrl: $('#a-url').value.trim(), token: $('#a-token').value.trim() };
  LS.set('rv.ajustes', SETTINGS);
  const msg = $('#a-msg');
  if (!SETTINGS.apiUrl) { showError(msg, 'Guardado sin URL: los registros quedan solo en el celular.', true); updatePending(); return; }
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(SETTINGS.apiUrl)) { showError(msg, 'La URL debe ser la de la aplicación web del script: termina en /exec.'); return; }
  showError(msg, 'Probando conexión…', true);
  try {
    await refreshConfig(true);
    showError(msg, `Conectado. Listas actualizadas: ${CFG.proyectos.length} proyectos, ${CFG.tecnicos.length} técnicos, ${CFG.equipos.length} equipos.`, true);
    $('#cfg-origen').textContent = CFG.origen;
    sync(false);
  } catch (ex) {
    showError(msg, 'No se pudo conectar: ' + (ex.message || ex) + '. Revisa la URL, la clave y que tengas señal.');
  }
  updatePending();
}

/* ---------------- Eventos ---------------- */
function bind() {
  $('#form-jornada').addEventListener('submit', submitJornada);
  $('#j-proyecto').addEventListener('change', refreshTramos);
  $$('input[name=j-division]').forEach(r => r.addEventListener('change', refreshTramos));
  $('#jornada-bar').addEventListener('click', () => show('jornada'));

  $$('input[name=r-familia]').forEach(r => r.addEventListener('change', () => {
    if (F.senal && F.senal.f !== familia()) { F.senal = null; $('#sign-card').hidden = true; $('#sp-color-field').hidden = true; renderLecturas(); }
    $('#r-buscar').value = ''; renderPicker();
    if (!F.senal) setTimeout(() => $('#r-buscar').focus({ preventScroll: true }), 50);
  }));
  $('#r-buscar').addEventListener('input', renderPicker);
  $('#picker-list').addEventListener('click', e => { const b = e.target.closest('button[data-code]'); if (b) selectSenal(b.dataset.code); });
  $('#btn-cambiar-senal').addEventListener('click', clearSenal);

  $('#lamina-seg').addEventListener('change', () => { F.confirmKey = ''; renderLecturas(); });
  $$('input[name=r-spcolor]').forEach(r => r.addEventListener('change', () => {
    const other = r.value === 'amarillo' ? 'amarillo_verde_fl' : 'amarillo';
    if (F.lecturas[other] && !F.lecturas[r.value]) { F.lecturas[r.value] = F.lecturas[other]; }
    delete F.lecturas[other];
    renderLecturas();
  }));
  $('#lecturas').addEventListener('input', e => {
    const t = e.target; if (!t.dataset.color) return;
    const arr = F.lecturas[t.dataset.color] || ['', '', ''];
    arr[Number(t.dataset.i)] = t.value; F.lecturas[t.dataset.color] = arr;
    updateEval();
  });
  $('#lecturas').addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !e.target.dataset.color) return;
    e.preventDefault();
    const inputs = $$('#lecturas input'); const i = inputs.indexOf(e.target);
    if (inputs[i + 1]) inputs[i + 1].focus(); else e.target.blur();
  });

  ['#r-km', '#r-m'].forEach(s => $(s).addEventListener('input', updateAbsPreview));
  $('#r-m').addEventListener('blur', () => { const v = $('#r-m').value; if (/^\d{1,3}$/.test(v)) $('#r-m').value = pad(v); updateAbsPreview(); });
  $('#btn-gps').addEventListener('click', () => { F.gps = null; renderGps(); startGps(); });

  $('#r-foto').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    $('#foto-label').textContent = 'Procesando…';
    try { setFoto(await compressImage(file)); F.fotoChanged = true; }
    catch (ex) { setFoto(F.fotoBlob); toast('No se pudo procesar la foto. Intenta de nuevo.'); }
    e.target.value = '';
  });
  $('#btn-quitar-foto').addEventListener('click', () => { setFoto(null); F.fotoChanged = true; });

  $('#form-registro').addEventListener('submit', submitRegistro);
  $('#btn-cancel-edit').addEventListener('click', () => { resetRegistro(false); show('lista'); });

  $$('input[name=f-alcance]').forEach(r => r.addEventListener('change', renderLista));
  $('#lista').addEventListener('click', e => {
    const ed = e.target.closest('[data-edit]'); if (ed) { editRecord(ed.dataset.edit); return; }
    const an = e.target.closest('[data-anular]');
    if (an) {
      const id = an.dataset.anular; const box = an.parentElement;
      box.innerHTML = `<span style="font-weight:700;align-self:center">¿Anular este registro?</span>
        <button type="button" class="btn btn-danger btn-sm" data-confirmar="${id}">Sí, anular</button>
        <button type="button" class="btn btn-ghost btn-sm" data-cancelar="${id}">No</button>`;
      return;
    }
    const cf = e.target.closest('[data-confirmar]'); if (cf) { anular(cf.dataset.confirmar); return; }
    const cc = e.target.closest('[data-cancelar]'); if (cc) { renderLista(); return; }
    const head = e.target.closest('.rec-head');
    if (head) {
      const id = head.closest('.rec').dataset.id;
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      renderLista();
    }
  });
  $('#btn-sync-now').addEventListener('click', () => sync(true));
  $('#sync-pill').addEventListener('click', () => sync(true));

  $('#tabbar').addEventListener('click', e => { const t = e.target.closest('[data-go]'); if (t) show(t.dataset.go); });
  $('#btn-ajustes').addEventListener('click', () => show('ajustes'));
  $('#btn-volver').addEventListener('click', () => show(JORNADA ? 'registro' : 'jornada'));
  $('#form-ajustes').addEventListener('submit', submitAjustes);

  window.addEventListener('online', () => { updatePending(); refreshConfig(); sync(false); });
  window.addEventListener('offline', updatePending);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopGps();
    else if (!$('#scr-registro').hidden && !F.editingId) startGps();
  });
  setInterval(() => { if (pendingList().length && navigator.onLine) sync(false); }, 90000);
}

/* ---------------- Service worker ---------------- */
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw && nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Hay una versión nueva de la app.', { label: 'Actualizar', fn: () => nw.postMessage('skipWaiting') });
        }
      });
    });
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
}

/* ---------------- Inicio ---------------- */
async function init() {
  bind();
  SETTINGS = LS.get('rv.ajustes', null) || { apiUrl: (window.RV_DEFAULTS || {}).apiUrl || '', token: (window.RV_DEFAULTS || {}).token || '' };
  const [cat, cfgBase] = await Promise.all([
    fetch('data/catalogo.json').then(r => r.json()),
    fetch('data/config.json').then(r => r.json())
  ]);
  CATALOG = cat;
  CFG = LS.get('rv.cfg', null) || cfgBase;
  try { await DB.open(); REGS = await DB.all('registros'); }
  catch (e) { toast('Este navegador no permite guardar datos. Usa Chrome o Safari sin modo incógnito.'); }
  const j = LS.get('rv.jornada', null);
  JORNADA = j && j.fecha === today() ? j : null;
  buildLaminaSeg();
  resetRegistro(false);
  updatePending();
  show(JORNADA ? 'registro' : 'jornada');
  registerSW();
  refreshConfig().then(ok => { if (ok && !$('#scr-jornada').hidden) fillJornadaForm(); });
  sync(false);
}
init();
