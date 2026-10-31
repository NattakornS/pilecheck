/* ตรวจระยะจมเข็ม — PWA
 * ข้อมูลเก็บในเครื่อง (localStorage) และส่งขึ้น Google Sheets ผ่าน Apps Script API
 * ทุกการแก้ไขเข้าคิว (outbox) ก่อน แล้วค่อยส่งเมื่อมีสัญญาณ จึงใช้ตอนออฟไลน์ได้
 * โหมดออฟไลน์ (cfg.mode === 'local'): ไม่ซิงก์เลย ข้อมูลอยู่ในเบราว์เซอร์เครื่องนี้เท่านั้น
 */
(function () {
  'use strict';

  var APP_VERSION = '1.1.0';
  var DEF = { W: 4, H: 50, SAFE: 25, FS: 2.5, B: 22, L: 8, E: 0.75, N: 0.25, C: 1.5, FC: 350 };
  var KEYS = Object.keys(DEF);
  var EXTRA = ['owner', 'contractor', 'engineer', 'supervisor'];
  var CENTER = [8.67, 99.93]; // ท่าศาลา นครศรีธรรมราช
  var LS = { cfg: 'pc-cfg', state: 'pc-state', theme: 'pc-theme', site: 'pc-site' };

  /* ---------- storage ---------- */
  function load(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v && typeof v === 'object' ? v : d; } catch (e) { return d; } }
  function put(k, v) { try { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); return true; } catch (e) { return false; } }
  function getStr(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }

  var cfg = load(LS.cfg, { url: '', key: '' });
  function isLocal() { return cfg.mode === 'local'; }
  function linked() { return !isLocal() && !!cfg.url && !!cfg.key; }
  var st = load(LS.state, null) || { sites: [], logs: [], outbox: [], errors: [], lastPull: 0, sheetUrl: '' };
  ['sites', 'logs', 'outbox', 'errors'].forEach(function (k) { if (!Array.isArray(st[k])) st[k] = []; });
  function save() { if (!put(LS.state, st)) toast('บันทึกข้อมูลในเครื่องไม่ได้ (พื้นที่เต็ม?)'); }

  /* ---------- small helpers ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var num = function (v) { var x = parseFloat(v); return isFinite(x) ? x : NaN; };
  var f1 = function (x) { return isFinite(x) ? (Math.round(x * 10) / 10).toLocaleString('th-TH', { maximumFractionDigits: 1 }) : '–'; };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  function genId(p) { return p + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtTime(d) { return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function hasLoc(s) { return s && s.lat !== '' && s.lat != null && s.lng !== '' && s.lng != null; }
  var toastTimer = null;
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3200); }

  /* ---------- calculation (Hiley) ---------- */
  function calc(s, W, H, set10) {
    var P = Math.pow(s.B / 100, 2) * s.L * 2400, Wkg = W * 1000;
    var eta = (Wkg + s.N * s.N * P) / (Wkg + P), energy = s.E * Wkg * H * eta;
    return {
      P: P,
      lim: (energy / (s.SAFE * s.FS * 1000) - s.C / 2) * 10,
      cap: isFinite(set10) ? energy / (set10 / 10 + s.C / 2) / s.FS / 1000 : NaN,
      struct: 0.25 * s.FC * s.B * s.B / 1000,
    };
  }

  /* ---------- theme ---------- */
  function effTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function paintTheme() {
    var d = effTheme() === 'dark';
    $('themeBtn').textContent = d ? '☀' : '☾';
    $('themeBtn').setAttribute('aria-label', d ? 'เปลี่ยนเป็นโหมดสว่าง' : 'เปลี่ยนเป็นโหมดมืด');
    var m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', d ? '#121615' : '#1d2321');
  }
  $('themeBtn').addEventListener('click', function () {
    var next = effTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next); put(LS.theme, next); paintTheme();
  });

  /* ---------- API ---------- */
  function NetErr(m) { this.message = m; } NetErr.prototype = Object.create(Error.prototype);
  function SrvErr(m) { this.message = m; } SrvErr.prototype = Object.create(Error.prototype);

  function api(action, args, overrideCfg) {
    var c = overrideCfg || cfg;
    if (!c.url || !c.key) return Promise.reject(new NetErr('ยังไม่ได้ตั้งค่าการเชื่อมต่อ'));
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, action === 'report' ? 60000 : 25000);
    return fetch(c.url, {
      method: 'POST', redirect: 'follow', signal: ctl ? ctl.signal : undefined,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key: c.key, action: action, args: args || [] }),
    }).then(function (r) {
      if (!r.ok) throw new NetErr('เซิร์ฟเวอร์ตอบ ' + r.status);
      return r.text();
    }).then(function (txt) {
      var j;
      try { j = JSON.parse(txt); } catch (e) {
        throw new SrvErr('ลิงก์ไม่ได้ตอบเป็น API — ตรวจว่า Deploy ตั้ง "ผู้มีสิทธิ์เข้าถึง: ทุกคน" และใช้ลิงก์ /exec');
      }
      if (!j.ok) throw new SrvErr(j.error || 'เกิดข้อผิดพลาด');
      return j.data;
    }, function (e) {
      if (e instanceof SrvErr || e instanceof NetErr) throw e;
      throw new NetErr(e && e.name === 'AbortError' ? 'หมดเวลารอสัญญาณ' : 'ไม่มีสัญญาณหรือเชื่อมต่อไม่ได้');
    }).finally(function () { clearTimeout(timer); });
  }

  /* ---------- sync ---------- */
  var flushing = false, netOk = navigator.onLine, lastErr = '', settingsDirty = false;

  function enqueue(op, args) {
    if (isLocal()) { save(); renderSync(); return; }
    st.outbox.push({ id: genId('Q'), op: op, args: args, t: Date.now() });
    save(); renderSync(); flush();
  }
  function opLabel(q) {
    var a = q.args || [];
    var site = function (id) { var s = siteById(id); return s ? s.title : 'ไซต์ที่ถูกลบ'; };
    switch (q.op) {
      case 'saveSite': return (a[0] && a[0].create ? 'สร้าง' : 'แก้ไข') + 'ไซต์ "' + (a[0] && a[0].title) + '"';
      case 'deleteSite': return 'ลบไซต์';
      case 'saveSettings': return 'ค่าตั้งของ ' + site(a[0]);
      case 'addPile': return 'บันทึกต้น ' + (a[1] && a[1].pile) + ' (' + site(a[0]) + ')';
      case 'deletePile': return 'ลบต้นเข็ม (' + site(a[0]) + ')';
      default: return q.op;
    }
  }

  function flush() {
    if (flushing || !linked()) { renderSync(); return Promise.resolve(); }
    flushing = true; renderSync();
    var step = function () {
      if (!st.outbox.length) return api('pull', []).then(function (d) {
        if (st.outbox.length || settingsDirty) return; // มีรายการใหม่ระหว่างดึง รอรอบหน้า
        st.sites = d.sites || []; st.logs = d.logs || []; st.sheetUrl = d.sheetUrl || ''; st.lastPull = Date.now();
        save(); netOk = true; lastErr = ''; refreshView();
      });
      var q = st.outbox[0];
      return api(q.op, q.args).then(function () {
        st.outbox.shift(); save(); netOk = true; renderSync(); return step();
      }, function (e) {
        if (e instanceof SrvErr) {
          // ปัญหาการตั้งค่า (รหัสผิด / Deploy ผิด): เก็บคิวไว้ หยุดส่ง ให้แก้การตั้งค่าก่อน
          if (/รหัส API|Deploy|ไม่ได้ตอบเป็น API/.test(e.message)) { lastErr = e.message; return; }
          // ข้อมูลรายการนี้ใช้ไม่ได้: บันทึกข้อผิดพลาด แล้วข้ามไปรายการถัดไป
          st.errors.unshift({ t: Date.now(), msg: opLabel(q) + ': ' + e.message });
          st.errors = st.errors.slice(0, 20);
          st.outbox.shift(); save(); renderSync(); refreshErrors();
          return step();
        }
        throw e;
      });
    };
    return step().catch(function (e) {
      netOk = false; lastErr = e.message;
    }).then(function () { flushing = false; renderSync(); });
  }

  function renderSync() {
    var chip = $('syncChip'), t = $('syncText'), n = st.outbox.length, cls = 'sync ';
    if (isLocal()) { cls += 'local'; t.textContent = 'โหมดออฟไลน์ · เก็บในเครื่องนี้เท่านั้น'; }
    else if (!cfg.url || !cfg.key) { cls += 'off'; t.textContent = 'ยังไม่ได้เชื่อมต่อ Google Sheets — แตะเพื่อตั้งค่า'; }
    else if (flushing) { cls += 'busy'; t.textContent = n ? 'กำลังส่ง ' + n + ' รายการ…' : 'กำลังซิงก์…'; }
    else if (!netOk || !navigator.onLine) { cls += n ? 'pending' : 'off'; t.textContent = 'ออฟไลน์' + (n ? ' · รอส่ง ' + n + ' รายการ' : '') + ' · แตะเพื่อลองใหม่'; }
    else if (lastErr) { cls += 'off'; t.textContent = lastErr; }
    else if (n) { cls += 'pending'; t.textContent = 'รอส่ง ' + n + ' รายการ'; }
    else { cls += 'ok'; t.textContent = st.lastPull ? 'ซิงก์แล้ว ' + fmtTime(new Date(st.lastPull)).slice(11) : 'เชื่อมต่อแล้ว'; }
    chip.className = cls;
  }
  $('syncChip').addEventListener('click', function () {
    if (!linked()) { openSetup(); return; }
    netOk = true; lastErr = ''; flush();
  });
  window.addEventListener('online', function () { netOk = true; flush(); });
  window.addEventListener('offline', function () { netOk = false; renderSync(); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') flush(); });
  setInterval(function () { if (st.outbox.length && navigator.onLine) flush(); }, 30000);

  /* ---------- data access + local mutations ---------- */
  function siteById(id) { for (var i = 0; i < st.sites.length; i++) if (st.sites[i].id === id) return st.sites[i]; return null; }
  function logsOf(id) { return st.logs.filter(function (l) { return l.siteId === id; }); }
  function settingsOf(s) { var o = {}; KEYS.forEach(function (k) { var v = s && s.settings ? num(s.settings[k]) : NaN; o[k] = v > 0 ? v : DEF[k]; }); return o; }
  function pendingUids() {
    var o = {}; st.outbox.forEach(function (q) { if (q.op === 'addPile' && q.args[1]) o[q.args[1].uid] = 1; }); return o;
  }
  function removeQueued(pred) {
    // ห้ามลบรายการแรกระหว่างกำลังส่ง (อาจส่งไปแล้ว)
    st.outbox = st.outbox.filter(function (q, i) { return (flushing && i === 0) || !pred(q); });
  }

  function createSite(data) {
    var id = genId('S');
    var site = { id: id, title: data.title, desc: data.desc, lat: data.lat, lng: data.lng, created: Date.now(), settings: Object.assign({}, DEF, data.settings || {}) };
    EXTRA.forEach(function (k) { site[k] = data[k] || ''; });
    st.sites.push(site);
    enqueue('saveSite', [Object.assign({}, data, { id: id, create: true })]);
    return id;
  }
  function editSite(id, data) {
    var s = siteById(id); if (!s) return;
    ['title', 'desc', 'lat', 'lng'].concat(EXTRA).forEach(function (k) { s[k] = data[k]; });
    enqueue('saveSite', [Object.assign({}, data, { id: id })]);
  }
  function deleteSite(id) {
    var createPending = st.outbox.some(function (q, i) { return q.op === 'saveSite' && q.args[0] && q.args[0].id === id && q.args[0].create && !(flushing && i === 0); });
    st.sites = st.sites.filter(function (s) { return s.id !== id; });
    st.logs = st.logs.filter(function (l) { return l.siteId !== id; });
    if (createPending) {
      removeQueued(function (q) { var a = q.args || []; return (a[0] && a[0].id === id) || a[0] === id; });
      save(); renderSync();
    } else enqueue('deleteSite', [id]);
  }
  function saveSettings(id, S) {
    var s = siteById(id); if (!s) return;
    s.settings = Object.assign({}, S);
    removeQueued(function (q) { return q.op === 'saveSettings' && q.args[0] === id; });
    enqueue('saveSettings', [id, Object.assign({}, S)]);
  }
  function addPile(id, p) {
    var now = new Date(), uid = genId('P');
    var row = { uid: uid, siteId: id, time: fmtTime(now), ts: now.toISOString(), pile: p.pile, W: p.W, H: p.H, set10: p.set10, note: p.note, depth: p.depth, offset: p.offset };
    st.logs.push(row);
    enqueue('addPile', [id, Object.assign({}, p, { uid: uid, time: now.toISOString() })]);
    return row;
  }
  function deletePile(id, uid) {
    st.logs = st.logs.filter(function (l) { return l.uid !== uid; });
    var had = st.outbox.some(function (q, i) { return q.op === 'addPile' && q.args[1] && q.args[1].uid === uid && !(flushing && i === 0); });
    if (had) { removeQueued(function (q) { return q.op === 'addPile' && q.args[1] && q.args[1].uid === uid; }); save(); renderSync(); }
    else enqueue('deletePile', [id, uid]);
  }

  /* ---------- views ---------- */
  var view = 'vList', cur = null, S = Object.assign({}, DEF), editing = null, pendingDel = null, saveTimer = null;

  function show(v) {
    view = v;
    ['vSetup', 'vList', 'vForm', 'vSite'].forEach(function (id) { $(id).hidden = id !== v; });
    $('backBtn').hidden = v === 'vList';
    $('setupBtn').hidden = v !== 'vList';
    $('bottomBar').hidden = v !== 'vSite';
    window.scrollTo(0, 0);
  }
  function refreshView() {
    renderSync();
    if (view === 'vList') renderSites();
    else if (view === 'vSite' && cur) {
      var s = siteById(cur.id);
      if (!s) { toast('ไซต์งานนี้ถูกลบจากชีตแล้ว'); gotoList(); return; }
      cur = s; S = settingsOf(s);
      KEYS.forEach(function (k) { if (document.activeElement !== $(k)) $(k).value = S[k]; });
      paintSiteHead(); render();
    }
  }
  $('backBtn').addEventListener('click', function () {
    if (view === 'vForm' && editing) { openSite(editing.id); return; }
    gotoList();
  });

  /* ----- setup ----- */
  function openSetup() {
    $('pageTitle').textContent = 'ตั้งค่า';
    $('cfgUrl').value = cfg.url || ''; $('cfgKey').value = cfg.key || '';
    $('cfgOut').hidden = true; $('localOut').hidden = true; $('resetConfirm').hidden = true; $('resetAsk').hidden = false;
    $('localInfo').textContent = 'ไซต์งาน ' + st.sites.length + ' ไซต์ · บันทึกเข็ม ' + st.logs.length + ' ต้น' + (isLocal() ? ' · โหมดออฟไลน์' : ' · รอส่ง ' + st.outbox.length + ' รายการ') + ' · แอปเวอร์ชัน ' + APP_VERSION;
    var hasData = st.sites.length > 0;
    $('cfgUpNote').hidden = !(isLocal() && hasData);
    $('localOn').hidden = !isLocal(); $('localOff').hidden = isLocal();
    paintInstall(); refreshErrors(); show('vSetup');
  }
  $('setupBtn').addEventListener('click', openSetup);
  function readCfgForm() { return { url: $('cfgUrl').value.trim(), key: $('cfgKey').value.trim() }; }
  function cfgNote(cls, html) { var o = $('cfgOut'); o.className = 'note ' + cls; o.innerHTML = html; o.hidden = false; }
  function validCfg(c) {
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(c.url)) { cfgNote('bad', 'ลิงก์ต้องขึ้นต้นด้วย https://script.google.com/macros/s/ และลงท้ายด้วย /exec'); return false; }
    if (!c.key) { cfgNote('bad', 'กรุณาใส่รหัส API'); return false; }
    return true;
  }
  $('cfgTest').addEventListener('click', function () {
    var c = readCfgForm(); if (!validCfg(c)) return;
    cfgNote('info', 'กำลังทดสอบ…');
    api('ping', [], c).then(function (d) { cfgNote('ok', 'เชื่อมต่อสำเร็จ: ' + esc(d.name)); },
      function (e) { cfgNote('bad', 'เชื่อมต่อไม่ได้: ' + esc(e.message)); });
  });
  $('cfgSave').addEventListener('click', function () {
    var c = readCfgForm(); if (!validCfg(c)) return;
    var fromLocal = isLocal(), changedSheet = !fromLocal && cfg.url && cfg.url !== c.url;
    if (changedSheet && st.outbox.length) { cfgNote('bad', 'ยังมี ' + st.outbox.length + ' รายการที่ยังไม่ได้ส่งขึ้นชีตเดิม ส่งให้หมดก่อนเปลี่ยนลิงก์'); return; }
    cfgNote('info', 'กำลังเชื่อมต่อ…');
    api('ping', [], c).then(function () {
      cfg = c; put(LS.cfg, cfg);
      if (fromLocal) queueLocalUpload();
      else if (changedSheet) { st.sites = []; st.logs = []; st.lastPull = 0; save(); }
      netOk = true; lastErr = ''; toast(fromLocal && st.outbox.length ? 'เชื่อมต่อแล้ว กำลังส่งข้อมูลในเครื่องขึ้นชีต' : 'เชื่อมต่อ Google Sheets แล้ว');
      flush(); gotoList();
    }, function (e) { cfgNote('bad', 'เชื่อมต่อไม่ได้: ' + esc(e.message)); });
  });
  // ย้ายจากโหมดออฟไลน์ไปชีต: ส่งทุกไซต์และทุกต้นขึ้นชีต (ชีตกันส่งซ้ำด้วยรหัสไซต์และ uid)
  function queueLocalUpload() {
    var t = Date.now();
    var q = function (op, args) { st.outbox.push({ id: genId('Q'), op: op, args: args, t: t }); };
    st.sites.forEach(function (s) {
      var d = { id: s.id, create: true, title: s.title, desc: s.desc || '', lat: s.lat, lng: s.lng, settings: Object.assign({}, s.settings) };
      EXTRA.forEach(function (k) { d[k] = s[k] || ''; });
      q('saveSite', [d]);
      q('saveSettings', [s.id, Object.assign({}, s.settings)]); // กรณีไซต์มีอยู่ในชีตแล้ว saveSite จะไม่แก้ค่าตั้ง
    });
    st.logs.forEach(function (r) {
      if (!siteById(r.siteId)) return;
      q('addPile', [r.siteId, { uid: r.uid, time: r.ts || parseTime(r.time), pile: r.pile, W: r.W, H: r.H, set10: r.set10, note: r.note, depth: r.depth, offset: r.offset }]);
    });
    save();
  }
  function parseTime(s) {
    var m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})/);
    return m ? new Date(+m[3], m[2] - 1, +m[1], +m[4], +m[5]).toISOString() : '';
  }
  $('localBtn').addEventListener('click', function () {
    if (st.outbox.length) {
      var o = $('localOut'); o.className = 'note bad'; o.hidden = false;
      o.textContent = 'ยังมี ' + st.outbox.length + ' รายการที่ยังไม่ได้ส่งขึ้นชีต ส่งให้หมดก่อนเปลี่ยนเป็นโหมดออฟไลน์';
      return;
    }
    cfg = Object.assign({}, cfg, { mode: 'local' }); put(LS.cfg, cfg);
    lastErr = ''; toast('ใช้โหมดออฟไลน์แล้ว ข้อมูลเก็บในเครื่องนี้เท่านั้น'); gotoList();
  });
  function refreshErrors() {
    var has = st.errors.length > 0;
    $('errPanel').hidden = !has;
    $('errList').innerHTML = st.errors.map(function (e) { return '<div class="note bad">' + esc(fmtTime(new Date(e.t))) + ' · ' + esc(e.msg) + '</div>'; }).join('');
    $('errHint').hidden = !has;
    if (has) $('errHint').innerHTML = 'มี ' + st.errors.length + ' รายการส่งขึ้นชีตไม่สำเร็จ <a href="#" id="errGo">ดูรายละเอียด</a>';
    var g = $('errGo'); if (g) g.onclick = function (ev) { ev.preventDefault(); openSetup(); };
  }
  $('errClear').addEventListener('click', function () { st.errors = []; save(); refreshErrors(); });
  $('resetAsk').addEventListener('click', function () {
    $('resetMsg').textContent = isLocal() ? 'โหมดออฟไลน์: ไซต์งานและบันทึกเข็มทั้งหมดจะหายถาวร เพราะไม่มีสำเนาในชีต' : st.outbox.length ? 'มี ' + st.outbox.length + ' รายการที่ยังไม่ได้ส่งขึ้นชีต จะหายไปถ้าล้าง ข้อมูลในชีตไม่ได้รับผลกระทบ' : 'ล้างข้อมูลในเครื่องแล้วดึงใหม่จากชีต ข้อมูลในชีตไม่ได้รับผลกระทบ';
    $('resetAsk').hidden = true; $('resetConfirm').hidden = false;
  });
  $('resetNo').addEventListener('click', function () { $('resetConfirm').hidden = true; $('resetAsk').hidden = false; });
  $('resetYes').addEventListener('click', function () {
    st = { sites: [], logs: [], outbox: [], errors: [], lastPull: 0, sheetUrl: '' }; save();
    toast('ล้างข้อมูลในเครื่องแล้ว'); flush(); gotoList();
  });

  /* ----- install ----- */
  var deferredPrompt = null;
  var isStandalone = function () { return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true; };
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredPrompt = e; paintInstall(); });
  window.addEventListener('appinstalled', function () { deferredPrompt = null; paintInstall(); toast('ติดตั้งแอปแล้ว'); });
  function paintInstall() {
    var sa = isStandalone();
    $('installBtn').hidden = sa || !deferredPrompt;
    $('iosTip').hidden = sa || !isIOS;
    $('installOther').hidden = sa || isIOS || !!deferredPrompt;
    $('installDone').hidden = !sa;
    $('installHint').hidden = sa || getStr('pc-hide-install') === '1';
  }
  $('installBtn').addEventListener('click', function () {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.finally(function () { deferredPrompt = null; paintInstall(); });
  });
  $('installHintGo').addEventListener('click', function (e) { e.preventDefault(); put('pc-hide-install', '1'); openSetup(); });

  /* ----- site list ----- */
  function gotoList() {
    cur = null; put(LS.site, ''); $('pageTitle').textContent = 'ไซต์งาน';
    show('vList'); renderSites(); refreshErrors(); paintInstall();
  }
  function renderSites() {
    var pend = pendingUids();
    if (st.sheetUrl) { $('sheetLink').href = st.sheetUrl; $('sheetLink').hidden = false; }
    $('siteEmpty').hidden = st.sites.length > 0;
    $('siteList').innerHTML = st.sites.slice().reverse().map(function (s) {
      var set = settingsOf(s), L = logsOf(s.id), pass = 0, wait = 0;
      L.forEach(function (r) { if (calc(set, r.W, r.H, r.set10).cap >= set.SAFE) pass++; if (pend[r.uid]) wait++; });
      var loc = hasLoc(s) ? '📍 ' + Number(s.lat).toFixed(4) + ', ' + Number(s.lng).toFixed(4) : 'ไม่ระบุตำแหน่ง';
      return '<button type="button" class="site" data-id="' + esc(s.id) + '">' +
        '<span class="t">' + esc(s.title) + '</span>' + (s.desc ? '<span class="d">' + esc(s.desc) + '</span>' : '') +
        '<span class="meta"><span class="pill">' + L.length + ' ต้น</span>' +
        (L.length ? '<span class="pill ok">ผ่าน ' + pass + '</span><span class="pill bad">ไม่ผ่าน ' + (L.length - pass) + '</span>' : '') +
        (wait ? '<span class="pill wait">รอส่ง ' + wait + '</span>' : '') +
        '<span>' + f1(set.SAFE) + ' ตัน · ' + loc + '</span></span></button>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('.site'), function (b) { b.addEventListener('click', function () { openSite(b.getAttribute('data-id')); }); });
  }
  $('newSiteBtn').addEventListener('click', function () { openForm(null); });

  /* ----- site form + map ----- */
  var map = null, marker = null;
  function openForm(site) {
    editing = site || null;
    $('pageTitle').textContent = site ? 'แก้ไขไซต์งาน' : 'สร้างไซต์งาน';
    $('fTitle').value = site ? site.title : ''; $('fDesc').value = site ? (site.desc || '') : '';
    $('fLat').value = hasLoc(site) ? site.lat : ''; $('fLng').value = hasLoc(site) ? site.lng : '';
    EXTRA.forEach(function (k) { $('f' + k).value = site ? (site[k] || '') : ''; });
    $('fSetWrap').hidden = !!site; $('formErr').hidden = true; $('geoMsg').textContent = '';
    show('vForm'); initMap();
    setTimeout(function () { if (map) { map.invalidateSize(); syncMarker(true); } }, 60);
  }
  function initMap() {
    if (typeof L === 'undefined') { $('mapNote').hidden = false; $('map').hidden = true; return; }
    $('mapNote').hidden = true; $('map').hidden = false;
    if (map) return;
    map = L.map('map').setView(CENTER, 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    map.on('click', function (e) { setLatLng(e.latlng.lat, e.latlng.lng, false); });
  }
  function setLatLng(lat, lng, pan) { $('fLat').value = lat.toFixed(6); $('fLng').value = lng.toFixed(6); syncMarker(pan); }
  function syncMarker(pan) {
    if (!map) return;
    var lat = num($('fLat').value), lng = num($('fLng').value);
    if (!isFinite(lat) || !isFinite(lng)) { if (marker) { map.removeLayer(marker); marker = null; } if (pan) map.setView(CENTER, 13); return; }
    if (!marker) {
      marker = L.marker([lat, lng], { draggable: true }).addTo(map);
      marker.on('dragend', function () { var p = marker.getLatLng(); setLatLng(p.lat, p.lng, false); });
    } else marker.setLatLng([lat, lng]);
    if (pan) map.setView([lat, lng], Math.max(map.getZoom(), 16));
  }
  $('fLat').addEventListener('change', function () { syncMarker(true); });
  $('fLng').addEventListener('change', function () { syncMarker(true); });
  $('clearLoc').addEventListener('click', function () { $('fLat').value = ''; $('fLng').value = ''; syncMarker(false); });
  $('geoBtn').addEventListener('click', function () {
    var m = $('geoMsg');
    if (!navigator.geolocation) { m.textContent = 'อุปกรณ์นี้ไม่รองรับการหาตำแหน่ง'; return; }
    m.textContent = 'กำลังหาตำแหน่ง…';
    navigator.geolocation.getCurrentPosition(function (p) {
      $('fLat').value = p.coords.latitude.toFixed(6); $('fLng').value = p.coords.longitude.toFixed(6);
      syncMarker(true); m.textContent = 'ได้ตำแหน่งแล้ว (คลาดเคลื่อน ±' + Math.round(p.coords.accuracy) + ' ม.)';
    }, function () { m.textContent = 'หาตำแหน่งไม่ได้ ตรวจว่าอนุญาตให้แอปใช้ตำแหน่ง หรือจิ้มบนแผนที่แทน'; },
    { enableHighAccuracy: true, timeout: 15000 });
  });
  $('cancelForm').addEventListener('click', function () { if (editing) openSite(editing.id); else gotoList(); });
  $('saveSiteBtn').addEventListener('click', function () {
    var err = $('formErr'), title = $('fTitle').value.trim();
    var fail = function (m) { err.textContent = m; err.hidden = false; };
    if (!title) { fail('กรุณาตั้งชื่อไซต์งาน'); $('fTitle').focus(); return; }
    var lat = $('fLat').value.trim(), lng = $('fLng').value.trim();
    if ((lat === '') !== (lng === '')) { fail('กรอกทั้งละติจูดและลองจิจูด หรือเว้นว่างทั้งคู่'); return; }
    if (lat !== '' && !(num(lat) >= -90 && num(lat) <= 90 && num(lng) >= -180 && num(lng) <= 180)) { fail('พิกัดไม่ถูกต้อง'); return; }
    var data = { title: title, desc: $('fDesc').value.trim(), lat: lat === '' ? '' : num(lat), lng: lng === '' ? '' : num(lng) };
    EXTRA.forEach(function (k) { data[k] = $('f' + k).value.trim(); });
    if (editing) { editSite(editing.id, data); openSite(editing.id); toast('บันทึกไซต์งานแล้ว'); }
    else {
      data.settings = {};
      ['W', 'H', 'SAFE', 'FS', 'B', 'L'].forEach(function (k) { var v = num($('f' + k).value); if (v > 0) data.settings[k] = v; });
      openSite(createSite(data)); toast('สร้างไซต์งานแล้ว');
    }
  });

  /* ----- site detail ----- */
  function openSite(id) {
    var s = siteById(id);
    if (!s) { gotoList(); return; }
    cur = s; S = settingsOf(s); put(LS.site, id); pendingDel = null;
    $('pageTitle').textContent = s.title;
    KEYS.forEach(function (k) { $(k).value = S[k]; });
    ['set10', 'note', 'depth', 'offset'].forEach(function (k) { $(k).value = ''; });
    var L = logsOf(id); $('pileId').value = L.length ? nextId(L[L.length - 1].pile) : '';
    $('reportOut').hidden = true; $('copyFallback').hidden = true; resetSiteDel();
    show('vSite'); paintSiteHead(); render();
  }
  function paintSiteHead() {
    $('pageTitle').textContent = cur.title;
    $('sDesc').textContent = cur.desc || 'ไม่มีรายละเอียด';
    if (hasLoc(cur)) {
      var q = cur.lat + ',' + cur.lng;
      $('sLoc').innerHTML = '<span class="coord">📍 ' + Number(cur.lat).toFixed(6) + ', ' + Number(cur.lng).toFixed(6) + '</span>' +
        '<a class="btn sm" href="https://www.google.com/maps?q=' + encodeURIComponent(q) + '" target="_blank" rel="noopener">Google Maps</a>';
    } else $('sLoc').innerHTML = '<span class="coord">ยังไม่ระบุตำแหน่ง</span>';
  }
  $('editSiteBtn').addEventListener('click', function () { openForm(cur); });

  function resetSiteDel() { $('sDelConfirm').hidden = true; $('sDelAsk').hidden = false; }
  $('sDelAsk').addEventListener('click', function () {
    $('sDelMsg').textContent = 'ลบ "' + cur.title + '" และบันทึกเข็มทั้งหมด ' + logsOf(cur.id).length + ' ต้น' +
      (isLocal() ? ' ย้อนกลับไม่ได้' : ' ทั้งในเครื่องและในชีต ย้อนกลับไม่ได้ (รายงาน PDF ที่ออกไปแล้วยังอยู่ใน Drive)');
    $('sDelAsk').hidden = true; $('sDelConfirm').hidden = false;
  });
  $('sDelNo').addEventListener('click', resetSiteDel);
  $('sDelYes').addEventListener('click', function () { var t = cur.title; deleteSite(cur.id); gotoList(); toast('ลบไซต์ "' + t + '" แล้ว'); });

  $('reportBtn').addEventListener('click', function () {
    var o = $('reportOut'), b = $('reportBtn');
    if (!linked()) { o.className = 'note bad'; o.textContent = (isLocal() ? 'โหมดออฟไลน์ออกรายงาน PDF ไม่ได้ ' : 'ยังไม่ได้เชื่อมต่อ Google Sheets ') + '— ใช้ "คัดลอกสรุปส่งไลน์" แทน หรือเชื่อมต่อ Google Sheets ในหน้าตั้งค่า'; o.hidden = false; return; }
    if (!navigator.onLine) { o.className = 'note warn'; o.textContent = 'ออกรายงานต้องมีสัญญาณ ข้อมูลที่บันทึกไว้จะอยู่ครบ ลองใหม่เมื่อมีเน็ต'; o.hidden = false; return; }
    b.disabled = true; o.className = 'note info'; o.textContent = 'กำลังส่งข้อมูลที่ค้าง แล้วสร้างรายงาน PDF… (10–30 วินาที)'; o.hidden = false;
    var id = cur.id;
    flush().then(function () {
      if (st.outbox.length) throw new NetErr('ยังส่งข้อมูลที่ค้างไม่หมด ลองใหม่เมื่อสัญญาณดีขึ้น');
      return api('report', [id]);
    }).then(function (r) {
      o.className = 'note ok';
      o.innerHTML = 'สร้างรายงานแล้ว (อยู่ในโฟลเดอร์ "รายงานตอกเสาเข็ม" ข้างไฟล์ชีต)<br><a href="' + esc(r.url) + '" target="_blank" rel="noopener">เปิด PDF</a> · <a href="' + esc(r.folderUrl) + '" target="_blank" rel="noopener">เปิดโฟลเดอร์</a>';
    }, function (e) { o.className = 'note bad'; o.textContent = 'สร้างรายงานไม่สำเร็จ: ' + e.message; })
      .finally(function () { b.disabled = false; });
  });

  function queueSettings() {
    clearTimeout(saveTimer); var id = cur.id, snap = Object.assign({}, S);
    var s = siteById(id); if (s) { s.settings = snap; save(); }
    settingsDirty = true;
    saveTimer = setTimeout(function () { settingsDirty = false; saveSettings(id, snap); }, 700);
  }
  KEYS.forEach(function (k) {
    $(k).addEventListener('input', function () { var v = num($(k).value); if (isFinite(v) && v > 0) { S[k] = v; render(); queueSettings(); } });
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-step]'), function (b) {
    b.addEventListener('click', function () {
      var k = b.getAttribute('data-step'), d = num(b.getAttribute('data-d')), min = k === 'W' ? 0.5 : 5;
      S[k] = Math.max(min, Math.round((S[k] + d) * 10) / 10); $(k).value = S[k]; render(); queueSettings();
    });
  });
  ['set10', 'offset'].forEach(function (k) { $(k).addEventListener('input', render); });

  function render() {
    if (!cur) return;
    var base = calc(S, S.W, S.H, NaN), lim = base.lim;
    $('critBig').innerHTML = lim <= 0 ? 'แรงไม่พอ' : f1(lim) + '<em>ซม.</em>';
    $('critSub').textContent = 'Safe Load ' + f1(S.SAFE) + ' ตัน · FS ' + f1(S.FS) + ' · เข็ม ' + f1(S.B) + '×' + f1(S.B) + ' ซม.';
    $('pileInfo').textContent = 'เข็มหนักประมาณ ' + Math.round(base.P).toLocaleString('th-TH') + ' กก. · กำลังตัวเข็มเองประมาณ ' + f1(base.struct) + ' ตัน';

    var set = num($('set10').value), v = $('verdict'), bb = $('bbStatus');
    if (isFinite(set) && set >= 0) {
      var cap = calc(S, S.W, S.H, set).cap, pass = cap >= S.SAFE, max = Math.max(S.SAFE * 1.6, cap * 1.05);
      v.hidden = false; v.className = 'verdict ' + (pass ? 'ok' : 'bad');
      $('vTag').textContent = pass ? 'ผ่านเกณฑ์' : 'ไม่ผ่านเกณฑ์';
      $('vCap').innerHTML = f1(cap) + ' <small>ตัน/ต้น</small>';
      $('mFill').style.width = Math.min(100, cap / max * 100) + '%';
      $('mMark').style.left = 'calc(' + (S.SAFE / max * 100) + '% - 1px)';
      $('mMid').textContent = 'เป้า ' + f1(S.SAFE) + ' ตัน'; $('mR').textContent = f1(max) + ' ตัน';
      bb.className = 'bb-status ' + (pass ? 'ok' : 'bad'); bb.innerHTML = '<b>' + f1(cap) + ' ตัน</b>' + (pass ? 'ผ่านเกณฑ์' : 'ไม่ผ่านเกณฑ์');
    } else { v.hidden = true; bb.className = 'bb-status'; bb.innerHTML = '<span class="hint">กรอกระยะจมเพื่อดูผล</span>'; }

    var w = [], off = num($('offset').value);
    if (S.W * 1000 < base.P) w.push('ตุ้มเบากว่าตัวเข็ม ควรใช้ตุ้มหนักอย่างน้อยเท่าน้ำหนักเข็ม');
    if (S.W >= 3 && S.H > 60) w.push('ตุ้มหนักแต่ยกสูงเกิน 60 ซม. หัวเข็มเสี่ยงแตก');
    if (S.SAFE > base.struct) w.push('Safe Load สูงกว่ากำลังของตัวเข็มเอง ต้องถามผู้ออกแบบ');
    if (lim > 0 && lim < 3) w.push('เกณฑ์ต่ำกว่า 3 ซม. ตอกเกือบปฏิเสธ หัวเข็มเสี่ยงแตก');
    if (isFinite(set) && set === 0) w.push('ระยะจม 0 ซม. ผิดปกติ ตรวจว่าวัดถูก หรือเข็มติดหินหรือหักใต้ดิน');
    if (isFinite(off) && off > 7.5) w.push('เข็มเยื้องศูนย์เกิน 7.5 ซม. ต้องแจ้งวิศวกร (ฐานเข็มเดี่ยวไวต่อการเยื้องมาก)');
    $('warns').innerHTML = w.map(function (t) { return '<div class="note warn">' + t + '</div>'; }).join('');

    var hs = [20, 30, 40, 50, 60, 70, 80]; if (hs.indexOf(S.H) < 0) hs.push(S.H); hs.sort(function (a, b) { return a - b; });
    $('critTbl').innerHTML = hs.map(function (h) {
      var l = calc(S, S.W, h, NaN).lim, note = '';
      if (l <= 0) note = 'แรงไม่พอ'; else if (l < 3) note = 'เกือบปฏิเสธ'; else if (S.W >= 3 && h > 60) note = 'เสี่ยงหัวเข็มแตก';
      return '<tr class="' + (h === S.H ? 'cur' : '') + '"><td>' + f1(h) + ' ซม.' + (h === S.H ? ' ◂' : '') + '</td><td class="n">' + (l > 0 ? f1(l) + ' ซม.' : '–') + '</td><td>' + note + '</td></tr>';
    }).join('');
    renderLog();
  }

  function renderLog() {
    var L = logsOf(cur.id), pend = pendingUids(), p = 0;
    $('emptyNote').hidden = L.length > 0;
    $('logBody').innerHTML = L.slice().reverse().map(function (r) {
      var cap = calc(S, r.W, r.H, r.set10).cap, ok = cap >= S.SAFE; if (ok) p++;
      var c = pendingDel === r.uid, extra = [];
      if (r.depth !== '' && r.depth != null && isFinite(r.depth)) extra.push('ลึก ' + f1(+r.depth) + ' ม.');
      if (r.offset !== '' && r.offset != null && isFinite(r.offset)) extra.push('เยื้อง ' + f1(+r.offset) + ' ซม.');
      return '<div class="logrow"><div><div class="p">' + esc(r.pile) + '</div>' +
        '<div class="m">จม ' + f1(r.set10) + ' ซม. · ตุ้ม ' + f1(r.W) + 't ยก ' + f1(r.H) + (extra.length ? ' · ' + extra.join(' · ') : '') + '</div>' +
        '<div class="m">' + esc(r.time) + (r.note ? ' · ' + esc(r.note) : '') + '</div></div>' +
        '<div class="r"><span class="pill ' + (ok ? 'ok' : 'bad') + '">' + (ok ? 'ผ่าน' : 'ไม่ผ่าน') + '</span>' +
        (pend[r.uid] ? '<span class="pill wait">รอส่ง</span>' : '') +
        '<span class="cap">' + f1(cap) + ' t</span>' +
        '<button class="del' + (c ? ' confirm' : '') + '" data-uid="' + esc(r.uid) + '">' + (c ? 'ยืนยันลบ' : 'ลบ') + '</button></div></div>';
    }).join('');
    $('sTotal').textContent = L.length; $('sPass').textContent = p; $('sFail').textContent = L.length - p;
    Array.prototype.forEach.call(document.querySelectorAll('.del'), function (b) {
      b.addEventListener('click', function () {
        var uid = b.getAttribute('data-uid');
        if (pendingDel !== uid) { pendingDel = uid; renderLog(); return; }
        pendingDel = null; deletePile(cur.id, uid); render(); toast('ลบแล้ว');
      });
    });
  }

  function nextId(id) { var m = String(id).match(/^(.*?)(\d+)$/); if (!m) return ''; var n = String(+m[2] + 1); while (n.length < m[2].length) n = '0' + n; return m[1] + n; }

  $('addRow').addEventListener('click', function () {
    if (!cur) return;
    var set = num($('set10').value);
    if (!isFinite(set) || set < 0) { toast('กรอกระยะจม 10 ครั้งก่อนบันทึก'); $('set10').focus(); return; }
    var L = logsOf(cur.id);
    var pile = $('pileId').value.trim() || (L.length ? nextId(L[L.length - 1].pile) : '') || ('ต้นที่ ' + (L.length + 1));
    var d = num($('depth').value), o = num($('offset').value);
    addPile(cur.id, { pile: pile, W: S.W, H: S.H, set10: set, note: $('note').value.trim(), depth: isFinite(d) ? d : '', offset: isFinite(o) ? o : '' });
    toast('บันทึก ' + pile + (isLocal() || navigator.onLine ? '' : ' ไว้ในเครื่อง (จะส่งเมื่อมีสัญญาณ)'));
    $('pileId').value = nextId(pile); ['set10', 'note', 'depth', 'offset'].forEach(function (k) { $(k).value = ''; });
    render();
  });

  function summaryText() {
    var L = logsOf(cur.id), lines = ['สรุปตรวจระยะจมเข็ม: ' + cur.title + ' (' + new Date().toLocaleDateString('th-TH') + ')'];
    if (hasLoc(cur)) lines.push('ตำแหน่ง: https://www.google.com/maps?q=' + cur.lat + ',' + cur.lng);
    lines.push('เข็ม ' + S.B + 'x' + S.B + ' ซม. ยาว ' + S.L + ' ม. · Safe Load ' + S.SAFE + ' ตัน · FS ' + S.FS,
      'เกณฑ์ที่ตุ้ม ' + S.W + ' ตัน ยก ' + S.H + ' ซม.: จม 10 ครั้งไม่เกิน ' + f1(calc(S, S.W, S.H, NaN).lim) + ' ซม.', '');
    if (!L.length) lines.push('(ยังไม่มีต้นที่บันทึก)');
    var p = 0;
    L.forEach(function (r) {
      var c = calc(S, r.W, r.H, r.set10).cap; if (c >= S.SAFE) p++;
      lines.push(r.pile + ': ตุ้ม ' + r.W + 't ยก ' + r.H + 'ซม. จม ' + r.set10 + 'ซม. → ' + f1(c) + ' ตัน ' + (c >= S.SAFE ? 'ผ่าน' : 'ไม่ผ่าน') + (r.note ? ' (' + r.note + ')' : ''));
    });
    if (L.length) lines.push('', 'รวม ' + L.length + ' ต้น · ผ่าน ' + p + ' · ไม่ผ่าน ' + (L.length - p));
    return lines.join('\n');
  }
  $('copyLog').addEventListener('click', function () {
    var t = summaryText(), fb = $('copyFallback');
    var fallback = function () { fb.hidden = false; fb.value = t; fb.focus(); fb.select(); toast('เลือกข้อความไว้แล้ว กดคัดลอกเองได้เลย'); };
    try { navigator.clipboard.writeText(t).then(function () { fb.hidden = true; toast('คัดลอกแล้ว วางในไลน์ได้เลย'); }, fallback); } catch (e) { fallback(); }
  });

  /* ---------- start ---------- */
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  paintTheme(); renderSync();
  if (!linked() && !isLocal()) { openSetup(); }
  else {
    var last = getStr(LS.site);
    if (last && siteById(last)) openSite(last); else gotoList();
    flush();
  }
})();
