/**
 * ตรวจระยะจมเข็ม (Last 10 Blows) — หลายไซต์งาน
 * Google Sheets + Apps Script
 * สูตร Hiley:  Ru = e·W·H / (S + C/2) × (W + n²P)/(W + P),  Pa = Ru / FS
 *
 * ไฟล์ในโปรเจกต์ Apps Script
 *   - Code.gs     ← ไฟล์นี้
 *   - Index.html  ← กด + → HTML ตั้งชื่อ "Index"
 *
 * ติดตั้ง
 * 1) Google Sheets → ส่วนขยาย → Apps Script → วาง 2 ไฟล์ → บันทึก
 * 2) รีเฟรชชีต → เมนู "ตรวจเข็ม" → "ติดตั้ง / สร้างชีต"
 * 3) มือถือ: Deploy → การทำให้ใช้งานได้รายการใหม่ → เว็บแอป
 *    ดำเนินการในฐานะ: ฉัน · ผู้มีสิทธิ์เข้าถึง: เฉพาะตัวฉัน → เปิดลิงก์ /exec
 *    (ถ้าเคย Deploy แล้ว: จัดการการทำให้ใช้งานได้ → แก้ไข → เวอร์ชันใหม่)
 *
 * ชีตที่สร้าง
 *   ไซต์งาน     : 1 แถวต่อ 1 ไซต์ พร้อมค่าตั้ง (ตุ้ม ระยะยก Safe Load ฯลฯ) ของไซต์นั้น
 *   บันทึกเข็ม   : บันทึกรายต้นของทุกไซต์ (คอลัมน์ รหัสไซต์ แยกข้อมูล)
 *   สรุปไซต์งาน  : สรุปผลแยกตามไซต์ (สร้างใหม่อัตโนมัติทุกครั้งที่มีการบันทึก)
 */

const SH_SITES = 'ไซต์งาน';
const SH_LOG = 'บันทึกเข็ม';
const SH_SUM = 'สรุปไซต์งาน';

// ค่าตั้งของแต่ละไซต์: [key, ชื่อคอลัมน์, ค่าเริ่มต้น]
const SET_KEYS = [
  ['W', 'ตุ้ม (ตัน)', 4],
  ['H', 'ระยะยก (ซม.)', 50],
  ['SAFE', 'Safe Load (ตัน)', 25],
  ['FS', 'FS', 2.5],
  ['B', 'หน้าตัดเข็ม (ซม.)', 22],
  ['L', 'ยาวเข็ม (ม.)', 8],
  ['E', 'e', 0.75],
  ['N', 'n', 0.25],
  ['C', 'C (ซม.)', 1.5],
  ['FC', "fc' (ksc)", 350],
];
const SITE_META = ['รหัสไซต์', 'ชื่อไซต์งาน', 'รายละเอียด', 'ละติจูด', 'ลองจิจูด', 'สร้างเมื่อ'];
// ข้อมูลผู้เกี่ยวข้อง ใช้ในรายงาน PDF: [key, ชื่อคอลัมน์]
const SITE_EXTRA = [['owner', 'เจ้าของงาน'], ['contractor', 'ผู้รับเหมาตอกเข็ม'], ['engineer', 'วิศวกรผู้ออกแบบ'], ['supervisor', 'ผู้ควบคุมงาน']];
const SITE_COLS = SITE_META.length + SET_KEYS.length + 1 + SITE_EXTRA.length; // + ลิงก์แผนที่ + ผู้เกี่ยวข้อง
const X0 = SITE_META.length + SET_KEYS.length + 1; // index คอลัมน์แรกของ SITE_EXTRA
const LOG_HEAD = ['วันที่/เวลา', 'รหัสไซต์', 'ชื่อไซต์', 'เลขต้น', 'ตุ้ม (ตัน)', 'ระยะยก (ซม.)',
  'จม 10 ครั้ง (ซม.)', 'เกณฑ์ จมไม่เกิน (ซม.)', 'รับได้ (ตัน)', 'ผล', 'หมายเหตุ',
  'ความลึกปลายเข็ม (ม.)', 'เยื้องศูนย์ (ซม.)', 'uid'];
const SITE_HEAD = SITE_META.concat(SET_KEYS.map(k => k[1]), ['แผนที่'], SITE_EXTRA.map(x => x[1]));
const REPORT_FOLDER = 'รายงานตอกเสาเข็ม';

/* ================= เมนูและหน้า HTML ================= */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('ตรวจเข็ม')
    .addItem('เปิดแอปตรวจระยะจม', 'openSidebar')
    .addItem('ติดตั้ง / สร้างชีต', 'setupSheets')
    .addItem('คำนวณใหม่ทุกไซต์', 'recalcAll')
    .addSeparator()
    .addItem('แอปมือถือ (PWA): สร้างรหัส API', 'setupApiKey')
    .addItem('แอปมือถือ (PWA): ดูรหัส API', 'showApiKey')
    .addToUi();
}

function doGet() {
  // การ Deploy สำหรับแอปมือถือตั้งเป็น "ทุกคน" จึงให้เปิดหน้า HTML ได้เฉพาะเจ้าของสคริปต์
  // คนอื่นเห็นแค่ข้อความว่า API พร้อมใช้งาน (การเขียนข้อมูลต้องมีรหัส API ผ่าน doPost)
  const me = Session.getEffectiveUser().getEmail();
  const who = Session.getActiveUser().getEmail();
  if (!who || who !== me) {
    return ContentService.createTextOutput('API ตรวจระยะจมเข็มพร้อมใช้งาน — เปิดแอปมือถือ (PWA) เพื่อใช้งาน');
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('ตรวจระยะจมเข็ม')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function openSidebar() {
  SpreadsheetApp.getUi().showSidebar(
    HtmlService.createHtmlOutputFromFile('Index').setTitle('ตรวจระยะจมเข็ม'));
}

function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheets_(ss);
  rebuildSummary_(ss);
  SpreadsheetApp.getUi().alert('ติดตั้งเสร็จแล้ว\nเปิดเมนู ตรวจเข็ม → เปิดแอปตรวจระยะจม เพื่อสร้างไซต์งานแรก');
}

function recalcAll() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheets_(ss);
  readSites_(ss).forEach(s => recalcSite_(ss, s));
  rebuildSummary_(ss);
}

/* ================= การคำนวณ ================= */
function hiley_(s, W, H, set10) {
  const P = Math.pow(s.B / 100, 2) * s.L * 2400;
  const Wkg = W * 1000;
  const eta = (Wkg + s.N * s.N * P) / (Wkg + P);
  const energy = s.E * Wkg * H * eta;
  const lim = (energy / (s.SAFE * s.FS * 1000) - s.C / 2) * 10;
  const cap = (set10 === '' || set10 === null || !isFinite(set10)) ? null
    : energy / (set10 / 10 + s.C / 2) / s.FS / 1000;
  return { lim: lim, cap: cap };
}
const r1_ = x => Math.round(x * 10) / 10;

/* ================= ชีต ================= */
function ensureSheets_(ss) {
  let sh = ss.getSheetByName(SH_SITES);
  if (!sh) {
    sh = ss.insertSheet(SH_SITES);
    sh.getRange(1, 1, 1, SITE_HEAD.length).setValues([SITE_HEAD])
      .setFontWeight('bold').setBackground('#1d2321').setFontColor('#ffffff').setWrap(true);
    sh.setFrozenRows(1);
    sh.getRange('F2:F').setNumberFormat('dd/mm/yyyy hh:mm');
    sh.setColumnWidth(1, 90); sh.setColumnWidth(2, 180); sh.setColumnWidth(3, 220);
    sh.getRange(2, SITE_META.length + 1, sh.getMaxRows() - 1, SET_KEYS.length).setBackground('#fff2c2');
  }
  let lg = ss.getSheetByName(SH_LOG);
  if (!lg) {
    lg = ss.insertSheet(SH_LOG);
    lg.getRange(1, 1, 1, LOG_HEAD.length).setValues([LOG_HEAD])
      .setFontWeight('bold').setBackground('#1d2321').setFontColor('#ffffff').setWrap(true);
    lg.setFrozenRows(1);
    lg.getRange('A2:A').setNumberFormat('dd/mm/yyyy hh:mm');
    lg.getRange('E2:I').setNumberFormat('0.0');
    const J = lg.getRange('J2:J');
    lg.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('ผ่าน')
        .setBackground('#dff1e6').setFontColor('#1d7a4a').setBold(true).setRanges([J]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('ไม่ผ่าน')
        .setBackground('#f8e1dd').setFontColor('#b4372a').setBold(true).setRanges([J]).build(),
    ]);
    [130, 80, 150, 80, 70, 80, 90, 110, 80, 70, 200, 100, 90].forEach((w, i) => lg.setColumnWidth(i + 1, w));
  }
  if (!ss.getSheetByName(SH_SUM)) ss.insertSheet(SH_SUM);
  // ซ่อมหัวตารางของชีตที่สร้างจากเวอร์ชันก่อน (คอลัมน์ใหม่ต่อท้าย)
  [[sh, SITE_HEAD], [lg, LOG_HEAD]].forEach(p => {
    const cur = p[0].getRange(1, 1, 1, p[1].length).getValues()[0];
    if (cur.join('|') !== p[1].join('|')) {
      p[0].getRange(1, 1, 1, p[1].length).setValues([p[1]])
        .setFontWeight('bold').setBackground('#1d2321').setFontColor('#ffffff').setWrap(true);
    }
  });
  migrateLegacy_(ss);
}

/** ย้ายข้อมูลจากเวอร์ชันเดิม (ชีต "บันทึกตอกเข็ม" + named range PC_*) เข้าเป็นไซต์ "ไซต์งานเดิม" ครั้งเดียว */
function migrateLegacy_(ss) {
  const props = PropertiesService.getDocumentProperties();
  if (props.getProperty('migrated_v2')) return;
  props.setProperty('migrated_v2', '1');
  const old = ss.getSheetByName('บันทึกตอกเข็ม');
  if (!old || !ss.getRangeByName('PC_W')) return;
  const set = {};
  SET_KEYS.forEach(k => {
    const nr = ss.getRangeByName('PC_' + k[0]);
    set[k[0]] = nr ? Number(nr.getValue()) || k[2] : k[2];
  });
  const site = createSiteRow_(ss, { title: 'ไซต์งานเดิม', desc: 'ย้ายมาจากเวอร์ชันก่อน', lat: '', lng: '', settings: set });
  const last = old.getLastRow();
  if (last < 2) return;
  const rows = old.getRange(2, 1, last - 1, 9).getValues()
    .filter(v => v[4] !== '' && v[4] !== null)
    .map(v => [v[0] || new Date(), site.id, site.title, v[1], v[2], v[3], v[4], '', '', '', v[8] || '', '', '', newUid_('P')]);
  if (rows.length) {
    const lg = ss.getSheetByName(SH_LOG);
    lg.getRange(lastRow_(lg, 2) + 1, 1, rows.length, LOG_HEAD.length).setValues(rows);
    recalcSite_(ss, site);
  }
}

function lastRow_(sh, col) {
  const n = sh.getLastRow();
  if (n < 2) return 1;
  const v = sh.getRange(1, col, n, 1).getValues();
  for (let i = n - 1; i >= 1; i--) if (v[i][0] !== '' && v[i][0] !== null) return i + 1;
  return 1;
}

function readSites_(ss) {
  const sh = ss.getSheetByName(SH_SITES);
  const n = lastRow_(sh, 1);
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, SITE_COLS).getValues().map((v, i) => {
    if (!v[0]) return null;
    const settings = {};
    SET_KEYS.forEach((k, j) => {
      const x = Number(v[SITE_META.length + j]);
      settings[k[0]] = isFinite(x) && x > 0 ? x : k[2];
    });
    const site = {
      row: i + 2, id: String(v[0]), title: String(v[1]), desc: String(v[2]),
      lat: v[3] === '' ? '' : Number(v[3]), lng: v[4] === '' ? '' : Number(v[4]),
      created: v[5] instanceof Date ? v[5].getTime() : null, settings: settings,
    };
    SITE_EXTRA.forEach((x, j) => { site[x[0]] = String(v[X0 + j] || ''); });
    return site;
  }).filter(Boolean);
}

function findSite_(ss, id) {
  const s = readSites_(ss).filter(x => x.id === String(id))[0];
  if (!s) throw new Error('ไม่พบไซต์งานนี้ อาจถูกลบไปแล้ว');
  return s;
}

function siteRowValues_(s) {
  const lat = s.lat === '' || s.lat === null ? '' : Number(s.lat);
  const lng = s.lng === '' || s.lng === null ? '' : Number(s.lng);
  return [s.id, s.title, s.desc || '', lat, lng, s.created ? new Date(s.created) : new Date()]
    .concat(SET_KEYS.map(k => s.settings[k[0]]))
    .concat([lat !== '' && lng !== '' ? 'https://www.google.com/maps?q=' + lat + ',' + lng : ''])
    .concat(SITE_EXTRA.map(x => s[x[0]] || ''));
}

function createSiteRow_(ss, data) {
  const sh = ss.getSheetByName(SH_SITES);
  const settings = {};
  SET_KEYS.forEach(k => {
    const x = Number(data.settings && data.settings[k[0]]);
    settings[k[0]] = isFinite(x) && x > 0 ? x : k[2];
  });
  const site = {
    id: data.id ? String(data.id) : newUid_('S'),
    title: String(data.title || '').trim() || 'ไซต์งานใหม่',
    desc: String(data.desc || '').trim(), lat: data.lat, lng: data.lng,
    created: Date.now(), settings: settings,
  };
  SITE_EXTRA.forEach(x => { site[x[0]] = String(data[x[0]] || '').trim(); });
  sh.getRange(lastRow_(sh, 1) + 1, 1, 1, SITE_COLS).setValues([siteRowValues_(site)]);
  return site;
}

function newUid_(prefix) {
  return prefix + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function readLogs_(ss, siteId) {
  const lg = ss.getSheetByName(SH_LOG);
  const n = lastRow_(lg, 2);
  if (n < 2) return [];
  const tz = ss.getSpreadsheetTimeZone();
  const vals = lg.getRange(2, 1, n - 1, LOG_HEAD.length).getValues();
  // แถวที่ยังไม่มี uid (กรอกในชีตเอง หรือเวอร์ชันเก่า) → สร้างให้
  let missing = false;
  vals.forEach(v => { if (v[1] !== '' && !v[13]) { v[13] = newUid_('P'); missing = true; } });
  if (missing) lg.getRange(2, 14, vals.length, 1).setValues(vals.map(v => [v[13]]));
  return vals.map((v, i) => ({
    row: i + 2, uid: String(v[13]), siteId: String(v[1]),
    time: v[0] instanceof Date ? Utilities.formatDate(v[0], tz, 'dd/MM/yyyy HH:mm') : String(v[0]),
    pile: String(v[3]), W: Number(v[4]), H: Number(v[5]), set10: v[6] === '' ? null : Number(v[6]),
    note: String(v[10] || ''),
    depth: v[11] === '' ? '' : Number(v[11]), offset: v[12] === '' ? '' : Number(v[12]),
  })).filter(r => r.set10 !== null && (siteId === undefined || r.siteId === String(siteId)));
}

/** เขียนเกณฑ์ / รับได้ / ผล ของทุกแถวในไซต์นี้ใหม่ */
function recalcSite_(ss, site) {
  const lg = ss.getSheetByName(SH_LOG);
  const n = lastRow_(lg, 2);
  if (n < 2) return;
  const rng = lg.getRange(2, 1, n - 1, LOG_HEAD.length);
  const vals = rng.getValues();
  const out = vals.map(v => {
    if (String(v[1]) !== site.id) return [v[2], v[7], v[8], v[9]];
    if (v[6] === '' || v[6] === null) return [site.title, '', '', ''];
    const W = Number(v[4]) || site.settings.W, H = Number(v[5]) || site.settings.H;
    const h = hiley_(site.settings, W, H, Number(v[6]));
    return [site.title, h.lim > 0 ? r1_(h.lim) : 'แรงไม่พอ', r1_(h.cap), h.cap >= site.settings.SAFE ? 'ผ่าน' : 'ไม่ผ่าน'];
  });
  lg.getRange(2, 3, n - 1, 1).setValues(out.map(o => [o[0]]));
  lg.getRange(2, 8, n - 1, 3).setValues(out.map(o => [o[1], o[2], o[3]]));
}

function rebuildSummary_(ss) {
  const sh = ss.getSheetByName(SH_SUM);
  sh.clear();
  const sites = readSites_(ss), logs = readLogs_(ss);
  sh.getRange('A1').setValue('สรุปผลการตอกเข็มแยกตามไซต์งาน').setFontSize(14).setFontWeight('bold');
  const head = ['ชื่อไซต์งาน', 'รายละเอียด', 'แผนที่', 'Safe Load (ตัน)', 'ตุ้ม/ระยะยก', 'เกณฑ์ จมไม่เกิน (ซม.)',
    'ต้นที่บันทึก', 'ผ่าน', 'ไม่ผ่าน', 'รับได้ต่ำสุด (ตัน)', 'บันทึกล่าสุด'];
  sh.getRange(3, 1, 1, head.length).setValues([head])
    .setFontWeight('bold').setBackground('#1d2321').setFontColor('#ffffff').setWrap(true);
  if (!sites.length) { sh.getRange('A4').setValue('ยังไม่มีไซต์งาน'); return; }
  const rows = sites.map(s => {
    const L = logs.filter(r => r.siteId === s.id);
    const caps = L.map(r => hiley_(s.settings, r.W, r.H, r.set10).cap);
    const pass = caps.filter(c => c >= s.settings.SAFE).length;
    const lim = hiley_(s.settings, s.settings.W, s.settings.H, null).lim;
    const map = s.lat !== '' && s.lng !== '' ? '=HYPERLINK("https://www.google.com/maps?q=' + s.lat + ',' + s.lng + '","เปิดแผนที่")' : '';
    return [s.title, s.desc, map, s.settings.SAFE, s.settings.W + ' ตัน / ' + s.settings.H + ' ซม.',
      lim > 0 ? r1_(lim) : 'แรงไม่พอ', L.length, pass, L.length - pass,
      caps.length ? r1_(Math.min.apply(null, caps)) : '', L.length ? L[L.length - 1].time : ''];
  });
  sh.getRange(4, 1, rows.length, head.length).setValues(rows);
  sh.getRange(4, 8, rows.length, 1).setFontColor('#1d7a4a').setFontWeight('bold');
  sh.getRange(4, 9, rows.length, 1).setFontColor('#b4372a').setFontWeight('bold');
  [180, 220, 90, 90, 120, 110, 80, 60, 60, 100, 120].forEach((w, i) => sh.setColumnWidth(i + 1, w));
}

/* ================= API ที่หน้า HTML เรียก ================= */
function withLock_(fn) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function listSites() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheets_(ss);
  const logs = readLogs_(ss);
  return {
    sheetUrl: ss.getUrl(),
    sites: readSites_(ss).map(s => {
      const L = logs.filter(r => r.siteId === s.id);
      const pass = L.filter(r => hiley_(s.settings, r.W, r.H, r.set10).cap >= s.settings.SAFE).length;
      return Object.assign(s, { total: L.length, pass: pass, fail: L.length - pass, last: L.length ? L[L.length - 1].time : '' });
    }),
  };
}

function getSite(id) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheets_(ss);
  return { site: findSite_(ss, id), log: readLogs_(ss, id), sheetUrl: ss.getUrl() };
}

/** สร้าง (ไม่มี id) หรือแก้ไขไซต์งาน */
function saveSite(data) {
  return withLock_(() => {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    ensureSheets_(ss);
    const lat = data.lat === '' || data.lat === null ? '' : Number(data.lat);
    const lng = data.lng === '' || data.lng === null ? '' : Number(data.lng);
    if (lat !== '' && !(lat >= -90 && lat <= 90)) throw new Error('ละติจูดต้องอยู่ระหว่าง -90 ถึง 90');
    if (lng !== '' && !(lng >= -180 && lng <= 180)) throw new Error('ลองจิจูดต้องอยู่ระหว่าง -180 ถึง 180');
    if (!String(data.title || '').trim()) throw new Error('กรุณาตั้งชื่อไซต์งาน');
    let site;
    const exists = data.id && readSites_(ss).some(x => x.id === String(data.id));
    if (!data.id || (data.create && !exists)) {
      // สร้างใหม่ (ใช้รหัสจากเครื่องถ้ามี เพื่อให้สร้างตอนออฟไลน์ได้)
      site = createSiteRow_(ss, Object.assign({}, data, { lat: lat, lng: lng }));
    } else {
      site = findSite_(ss, data.id);
      site.title = String(data.title).trim();
      site.desc = String(data.desc || '').trim();
      site.lat = lat; site.lng = lng;
      SITE_EXTRA.forEach(x => { site[x[0]] = String(data[x[0]] || '').trim(); });
      ss.getSheetByName(SH_SITES).getRange(site.row, 1, 1, SITE_COLS).setValues([siteRowValues_(site)]);
      recalcSite_(ss, site); // อัปเดตชื่อไซต์ในบันทึก
    }
    rebuildSummary_(ss);
    return site.id;
  });
}

function deleteSite(id) {
  return withLock_(() => {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const site = findSite_(ss, id);
    const lg = ss.getSheetByName(SH_LOG);
    const n = lastRow_(lg, 2);
    if (n >= 2) {
      const ids = lg.getRange(2, 2, n - 1, 1).getValues();
      for (let i = ids.length - 1; i >= 0; i--) if (String(ids[i][0]) === site.id) lg.deleteRow(i + 2);
    }
    ss.getSheetByName(SH_SITES).deleteRow(site.row);
    rebuildSummary_(ss);
    return true;
  });
}

function saveSettings(id, settings) {
  return withLock_(() => {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const site = findSite_(ss, id);
    SET_KEYS.forEach(k => {
      const x = Number(settings[k[0]]);
      if (isFinite(x) && x > 0) site.settings[k[0]] = x;
    });
    ss.getSheetByName(SH_SITES).getRange(site.row, 1, 1, SITE_COLS).setValues([siteRowValues_(site)]);
    recalcSite_(ss, site);
    rebuildSummary_(ss);
    return true;
  });
}

function addPile(id, p) {
  const set10 = Number(p.set10), W = Number(p.W), H = Number(p.H);
  if (!isFinite(set10) || set10 < 0) throw new Error('ระยะจมไม่ถูกต้อง');
  if (!(W > 0) || !(H > 0)) throw new Error('น้ำหนักตุ้มหรือระยะยกไม่ถูกต้อง');
  return withLock_(() => {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const site = findSite_(ss, id);
    const lg = ss.getSheetByName(SH_LOG);
    const prev = readLogs_(ss, id);
    if (p.uid && prev.some(r => r.uid === String(p.uid))) return getSite(id); // ส่งซ้ำ ไม่บันทึกซ้ำ
    const time = p.time ? new Date(p.time) : new Date();
    const pile = String(p.pile || '').trim() ||
      nextPileId_(prev.length ? prev[prev.length - 1].pile : '', prev.length + 1);
    const h = hiley_(site.settings, W, H, set10);
    lg.getRange(lastRow_(lg, 2) + 1, 1, 1, LOG_HEAD.length).setValues([[
      isNaN(time.getTime()) ? new Date() : time, site.id, site.title, pile, W, H, set10,
      h.lim > 0 ? r1_(h.lim) : 'แรงไม่พอ', r1_(h.cap), h.cap >= site.settings.SAFE ? 'ผ่าน' : 'ไม่ผ่าน', String(p.note || ''),
      isFinite(parseFloat(p.depth)) ? Number(p.depth) : '', isFinite(parseFloat(p.offset)) ? Number(p.offset) : '',
      p.uid ? String(p.uid) : newUid_('P'),
    ]]);
    rebuildSummary_(ss);
    return getSite(id);
  });
}

function deletePile(id, row, pile) {
  return withLock_(() => {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const lg = ss.getSheetByName(SH_LOG);
    row = Number(row);
    if (row >= 2 && String(lg.getRange(row, 2).getValue()) === String(id) &&
        String(lg.getRange(row, 4).getValue()) === String(pile)) lg.deleteRow(row);
    rebuildSummary_(ss);
    return getSite(id);
  });
}

function nextPileId_(prev, n) {
  const m = String(prev).match(/^(.*?)(\d+)$/);
  if (!m) return 'ต้นที่ ' + n;
  return m[1] + String(Number(m[2]) + 1).padStart(m[2].length, '0');
}

/* ================= JSON API สำหรับแอปมือถือ (PWA) ================= */
/**
 * แอป PWA ส่ง POST (Content-Type: text/plain) มาที่ลิงก์ /exec
 * body = {"key":"รหัส API","action":"pull","args":[...]}
 * ตอบกลับ {"ok":true,"data":...} หรือ {"ok":false,"error":"..."}
 */
function doPost(e) {
  let res;
  try {
    const req = JSON.parse(e && e.postData ? e.postData.contents : '{}');
    const key = PropertiesService.getScriptProperties().getProperty('API_KEY');
    if (!key) throw new Error('ยังไม่ได้สร้างรหัส API (เมนู ตรวจเข็ม → แอปมือถือ: สร้างรหัส API)');
    if (String(req.key || '') !== key) throw new Error('รหัส API ไม่ถูกต้อง');
    const a = Array.isArray(req.args) ? req.args : [];
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    ensureSheets_(ss);
    switch (req.action) {
      case 'ping': res = { name: ss.getName(), time: Date.now() }; break;
      case 'pull': res = pull_(ss); break;
      case 'saveSite': res = saveSite(a[0]); break;
      case 'deleteSite':
        // ลบซ้ำ (ส่งซ้ำตอนเน็ตหลุด) ไม่ถือว่าผิด
        res = readSites_(ss).some(s => s.id === String(a[0])) ? deleteSite(a[0]) : true; break;
      case 'saveSettings': res = saveSettings(a[0], a[1] || {}); break;
      case 'addPile': addPile(a[0], a[1] || {}); res = true; break;
      case 'deletePile': res = deletePileByUid_(a[0], a[1]); break;
      case 'report': res = generateReport(a[0]); break;
      default: throw new Error('ไม่รู้จักคำสั่ง: ' + req.action);
    }
    res = { ok: true, data: res };
  } catch (err) {
    res = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

function pull_(ss) {
  const sites = readSites_(ss).map(s => { const o = Object.assign({}, s); delete o.row; return o; });
  const logs = readLogs_(ss).map(r => ({
    uid: r.uid, siteId: r.siteId, time: r.time, pile: r.pile, W: r.W, H: r.H,
    set10: r.set10, note: r.note, depth: r.depth, offset: r.offset,
  }));
  return { sites: sites, logs: logs, sheetUrl: ss.getUrl(), time: Date.now() };
}

function deletePileByUid_(siteId, uid) {
  return withLock_(() => {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const r = readLogs_(ss, siteId).filter(x => x.uid === String(uid))[0];
    if (r) ss.getSheetByName(SH_LOG).deleteRow(r.row);
    rebuildSummary_(ss);
    return true;
  });
}

function setupApiKey() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('API_KEY')) {
    const a = ui.alert('มีรหัส API อยู่แล้ว', 'สร้างรหัสใหม่หรือไม่? มือถือทุกเครื่องที่ใช้รหัสเดิมจะต้องใส่รหัสใหม่', ui.ButtonSet.YES_NO);
    if (a !== ui.Button.YES) return;
  }
  const key = Utilities.getUuid().replace(/-/g, '').slice(0, 24);
  props.setProperty('API_KEY', key);
  showApiKey();
}

function showApiKey() {
  const key = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!key) { SpreadsheetApp.getUi().alert('ยังไม่มีรหัส API กรุณาเลือก "สร้างรหัส API" ก่อน'); return; }
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;font-size:14px;line-height:1.5">' +
    '<p>ใส่ค่านี้ในหน้า <b>ตั้งค่าการเชื่อมต่อ</b> ของแอปมือถือ</p>' +
    '<p><b>รหัส API</b></p><input style="width:100%;font-size:18px;font-family:monospace;padding:6px" readonly value="' + key + '" onclick="this.select()">' +
    '<p style="margin-top:14px"><b>ลิงก์เว็บแอป</b>: คัดลอกจาก Apps Script → Deploy → จัดการการทำให้ใช้งานได้ (ลิงก์ที่ลงท้ายด้วย /exec)</p>' +
    '<p style="color:#a15c00">เก็บรหัสนี้เป็นความลับ ใครมีทั้งลิงก์และรหัสจะเขียนข้อมูลลงชีตนี้ได้</p></div>'
  ).setWidth(460).setHeight(300);
  SpreadsheetApp.getUi().showModalDialog(html, 'รหัส API สำหรับแอปมือถือ');
}

/* ================= รายงาน PDF ================= */
/**
 * สร้างรายงานบันทึกการตอกเสาเข็ม (Pile Driving Record) เป็น PDF
 * เก็บในโฟลเดอร์ "รายงานตอกเสาเข็ม" ใน Google Drive แล้วคืนลิงก์
 */
function generateReport(id) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const site = findSite_(ss, id);
  const logs = readLogs_(ss, id);
  const s = site.settings, tz = ss.getSpreadsheetTimeZone();
  const now = new Date();
  const e = x => String(x === null || x === undefined ? '' : x)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const f = (x, d) => (x === '' || x === null || !isFinite(x)) ? '–' : Number(x).toFixed(d === undefined ? 1 : d);
  const P = Math.pow(s.B / 100, 2) * s.L * 2400;
  const crit = hiley_(s, s.W, s.H, null).lim;
  const structCap = 0.25 * s.FC * s.B * s.B / 1000;

  let pass = 0, minCap = Infinity, maxSet = 0;
  const rows = logs.map((r, i) => {
    const h = hiley_(s, r.W, r.H, r.set10);
    const ok = h.cap >= s.SAFE; if (ok) pass++;
    minCap = Math.min(minCap, h.cap); maxSet = Math.max(maxSet, r.set10);
    return '<tr' + (ok ? '' : ' class="fail"') + '>' +
      '<td class="c">' + (i + 1) + '</td><td>' + e(r.pile) + '</td><td>' + e(r.time) + '</td>' +
      '<td class="n">' + f(r.W) + '</td><td class="n">' + f(r.H, 0) + '</td>' +
      '<td class="n">' + f(r.depth, 2) + '</td><td class="n">' + f(r.offset) + '</td>' +
      '<td class="n b">' + f(r.set10) + '</td><td class="n">' + (h.lim > 0 ? f(h.lim) : '–') + '</td>' +
      '<td class="n b">' + f(h.cap) + '</td><td class="c b">' + (ok ? 'ผ่าน' : 'ไม่ผ่าน') + '</td>' +
      '<td>' + e(r.note) + '</td></tr>';
  }).join('');
  const fail = logs.length - pass;
  const loc = site.lat !== '' && site.lng !== '' ? f(site.lat, 6) + ', ' + f(site.lng, 6) : 'ไม่ระบุ';
  const offsetOver = logs.filter(r => r.offset !== '' && r.offset > 7.5).length;

  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    '@page{size:A4;margin:14mm 12mm}' +
    'body{font-family:"Sarabun","Tahoma","Leelawadee UI",sans-serif;font-size:10pt;color:#111;line-height:1.35}' +
    'h1{font-size:15pt;margin:0 0 2px}h2{font-size:11pt;margin:14px 0 6px;border-bottom:1.5px solid #111;padding-bottom:2px}' +
    '.sub{color:#444;font-size:9pt;margin:0 0 10px}' +
    'table{border-collapse:collapse;width:100%}' +
    '.info td{padding:3px 6px;border:1px solid #999;vertical-align:top}.info td.k{background:#eee;width:22%;font-weight:bold}' +
    '.log th,.log td{border:1px solid #777;padding:3px 4px;font-size:8.5pt}' +
    '.log th{background:#e6e6e6;font-weight:bold;text-align:center}' +
    '.n{text-align:right}.c{text-align:center}.b{font-weight:bold}tr.fail td{background:#fde4e0}' +
    '.sum td{border:1px solid #999;padding:4px 6px;text-align:center}.sum .v{font-size:14pt;font-weight:bold}' +
    '.note{font-size:8.5pt;color:#333}.sign{width:100%;margin-top:28px}.sign td{width:33%;text-align:center;padding-top:34px;font-size:9.5pt}' +
    '.verdict{padding:6px 10px;border:2px solid ' + (fail ? '#b4372a' : '#1d7a4a') + ';font-weight:bold;margin-top:8px}' +
    '</style></head><body>' +
    '<h1>บันทึกการตอกเสาเข็ม (Pile Driving Record)</h1>' +
    '<p class="sub">ออกรายงานเมื่อ ' + Utilities.formatDate(now, tz, 'dd/MM/yyyy HH:mm') + ' · รหัสไซต์ ' + e(site.id) + '</p>' +

    '<h2>1. ข้อมูลโครงการ</h2><table class="info">' +
    '<tr><td class="k">ชื่อโครงการ / ไซต์งาน</td><td colspan="3">' + e(site.title) + '</td></tr>' +
    '<tr><td class="k">รายละเอียด</td><td colspan="3">' + e(site.desc || '–') + '</td></tr>' +
    '<tr><td class="k">พิกัดที่ตั้ง</td><td colspan="3">' + e(loc) + '</td></tr>' +
    '<tr><td class="k">เจ้าของงาน</td><td>' + e(site.owner || '–') + '</td><td class="k">ผู้รับเหมาตอกเข็ม</td><td>' + e(site.contractor || '–') + '</td></tr>' +
    '<tr><td class="k">วิศวกรผู้ออกแบบ</td><td>' + e(site.engineer || '–') + '</td><td class="k">ผู้ควบคุมงาน</td><td>' + e(site.supervisor || '–') + '</td></tr>' +
    '</table>' +

    '<h2>2. ข้อกำหนดเสาเข็มและเครื่องตอก</h2><table class="info">' +
    '<tr><td class="k">ขนาดเสาเข็ม</td><td>สี่เหลี่ยม ' + f(s.B, 0) + '×' + f(s.B, 0) + ' ซม. ยาว ' + f(s.L) + ' ม.</td>' +
    '<td class="k">น้ำหนักเสาเข็ม (P)</td><td>' + Math.round(P) + ' กก.</td></tr>' +
    '<tr><td class="k">กำลังคอนกรีตเสาเข็ม fc\'</td><td>' + f(s.FC, 0) + ' ksc</td>' +
    '<td class="k">กำลังโครงสร้างเสาเข็ม (0.25 fc\' A)</td><td>' + f(structCap) + ' ตัน</td></tr>' +
    '<tr><td class="k">Safe Load ตามแบบ</td><td>' + f(s.SAFE) + ' ตัน/ต้น</td>' +
    '<td class="k">Factor of Safety</td><td>' + f(s.FS) + ' (Ru ที่ต้องการ ' + f(s.SAFE * s.FS) + ' ตัน)</td></tr>' +
    '<tr><td class="k">น้ำหนักตุ้ม (W)</td><td>' + f(s.W) + ' ตัน (Drop Hammer)</td>' +
    '<td class="k">ระยะยกตุ้ม (H)</td><td>' + f(s.H, 0) + ' ซม.</td></tr>' +
    '<tr><td class="k">สมมติฐาน</td><td colspan="3">e = ' + s.E + ', n = ' + s.N + ', C = ' + s.C + ' ซม.</td></tr>' +
    '<tr><td class="k">เกณฑ์ยอมรับ</td><td colspan="3"><b>ระยะจม 10 ครั้งสุดท้าย ไม่เกิน ' + (crit > 0 ? f(crit) + ' ซม.' : '– (แรงตอกไม่พอ)') +
    '</b> ที่ W = ' + f(s.W) + ' ตัน, H = ' + f(s.H, 0) + ' ซม.</td></tr></table>' +

    '<h2>3. สรุปผล</h2><table class="sum"><tr>' +
    '<td>จำนวนต้นที่ตอก<div class="v">' + logs.length + '</div></td>' +
    '<td>ผ่านเกณฑ์<div class="v" style="color:#1d7a4a">' + pass + '</div></td>' +
    '<td>ไม่ผ่านเกณฑ์<div class="v" style="color:#b4372a">' + fail + '</div></td>' +
    '<td>กำลังต่ำสุด<div class="v">' + (logs.length ? f(minCap) : '–') + '</div>ตัน</td>' +
    '<td>ระยะจมสูงสุด<div class="v">' + (logs.length ? f(maxSet) : '–') + '</div>ซม./10 ครั้ง</td></tr></table>' +
    '<div class="verdict">' + (!logs.length ? 'ยังไม่มีข้อมูลการตอก' : fail ?
      'มีเสาเข็ม ' + fail + ' ต้นไม่ผ่านเกณฑ์ ขอให้วิศวกรผู้ออกแบบพิจารณา (เช่น ตอกซ้ำทดสอบหลังทิ้งไว้ หรือเพิ่มเสาเข็ม)' :
      'เสาเข็มทุกต้นผ่านเกณฑ์ระยะจม 10 ครั้งสุดท้าย') +
    (offsetOver ? ' · มี ' + offsetOver + ' ต้นเยื้องศูนย์เกิน 7.5 ซม.' : '') + '</div>' +

    '<h2>4. บันทึกการตอกรายต้น</h2><table class="log"><thead><tr>' +
    '<th>ลำดับ</th><th>เลขต้น</th><th>วันที่/เวลา</th><th>ตุ้ม<br>(ตัน)</th><th>ยก<br>(ซม.)</th>' +
    '<th>ลึกปลาย<br>(ม.)</th><th>เยื้อง<br>(ซม.)</th><th>จม 10 ครั้ง<br>(ซม.)</th><th>เกณฑ์<br>(ซม.)</th>' +
    '<th>รับได้<br>(ตัน)</th><th>ผล</th><th>หมายเหตุ</th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="12" class="c">ยังไม่มีข้อมูล</td></tr>') + '</tbody></table>' +

    '<h2>5. วิธีคำนวณ</h2><p class="note">กำลังรับน้ำหนักจากการตอก คำนวณด้วยสูตร Hiley: ' +
    'Ru = e·W·H / (S + C/2) × (W + n²P) / (W + P) และ Safe Load = Ru / FS ' +
    'โดย S = ระยะจม 10 ครั้งสุดท้าย ÷ 10 (ซม./ครั้ง) · ค่าที่ได้เป็นการตรวจสอบเบื้องต้นจากข้อมูลการตอก ' +
    'การยอมรับเสาเข็มให้เป็นไปตามดุลยพินิจและการรับรองของวิศวกรผู้ออกแบบ · ' +
    'แนะนำให้ทดสอบ Seismic Test (Pile Integrity Test) หลังตัดหัวเข็ม</p>' +

    '<table class="sign"><tr>' +
    '<td>ลงชื่อ ..................................................<br>(' + e(site.contractor || '..................................') + ')<br>ผู้รับเหมาตอกเข็ม</td>' +
    '<td>ลงชื่อ ..................................................<br>(' + e(site.supervisor || '..................................') + ')<br>ผู้ควบคุมงาน</td>' +
    '<td>ลงชื่อ ..................................................<br>(' + e(site.engineer || '..................................') + ')<br>วิศวกรผู้ออกแบบ / ผู้ตรวจสอบ</td>' +
    '</tr></table></body></html>';

  const name = 'บันทึกการตอกเสาเข็ม_' + site.title.replace(/[\\/:*?"<>|]/g, '_') + '_' +
    Utilities.formatDate(now, tz, 'yyyyMMdd_HHmm') + '.pdf';
  const pdf = Utilities.newBlob(html, 'text/html', 'report.html').getAs('application/pdf').setName(name);
  const folder = reportFolder_(ss);
  const file = folder.createFile(pdf);
  return { url: file.getUrl(), name: name, folderUrl: folder.getUrl() };
}

/** โฟลเดอร์ "รายงานตอกเสาเข็ม" ภายในโฟลเดอร์เดียวกับไฟล์ Google Sheets นี้ (สร้างให้ถ้ายังไม่มี) */
function reportFolder_(ss) {
  const parents = DriveApp.getFileById(ss.getId()).getParents();
  const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const it = parent.getFoldersByName(REPORT_FOLDER);
  return it.hasNext() ? it.next() : parent.createFolder(REPORT_FOLDER);
}

/* ================= แก้ไขในชีตโดยตรง ================= */
function onEdit(e) {
  if (!e || !e.range) return;
  const sh = e.range.getSheet(), name = sh.getName(), ss = sh.getParent();
  if (e.range.getRow() < 2) return;
  try {
    if (name === SH_SITES) {
      const ids = sh.getRange(e.range.getRow(), 1, e.range.getNumRows(), 1).getValues().map(v => String(v[0]));
      readSites_(ss).filter(s => ids.indexOf(s.id) >= 0).forEach(s => {
        sh.getRange(s.row, 1, 1, SITE_COLS).setValues([siteRowValues_(s)]);
        recalcSite_(ss, s);
      });
      rebuildSummary_(ss);
    } else if (name === SH_LOG && e.range.getColumn() <= 7 && e.range.getLastColumn() >= 2) {
      const ids = sh.getRange(e.range.getRow(), 2, e.range.getNumRows(), 1).getValues().map(v => String(v[0]));
      readSites_(ss).filter(s => ids.indexOf(s.id) >= 0).forEach(s => recalcSite_(ss, s));
      rebuildSummary_(ss);
    }
  } catch (err) { /* ไม่ขัดจังหวะการแก้ไขในชีต */ }
}
