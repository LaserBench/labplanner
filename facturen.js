/* Labplanner: facturatie, omzetoverzicht en PDF-export.
   Alleen zichtbaar voor info@nmept.com (en in de database afgeschermd met RLS). */
(function(){
'use strict';
const A = window.LabApp;
if (!A) return;
const {F, esc, toast} = A;

/* ---------- vaste gegevens ---------- */
const COMPANY = {name:'NME Precision Technologies', address:'Stampstraat 26a', postcode:'6369bd', city:'Simpelveld', kvk:'91262917',
  tel:'+31 (0) 6 132 76115', email:'info@nmept.com', web:'https://www.nmept.com', iban:'NL91 RABO 0367 9725 73', bic:'RABONL2U'};
const PAY_DAYS = 30;
// Opdrachten die vóór dit moment al klaar waren, zijn nog met de hand gefactureerd.
const BILLING_START = '2026-10-27T11:00:00.000Z';
const BILLABLE = new Set(['base','imm','steg','tryin','lepel']);
const PER_PATIENT = new Set(['base','imm','steg']);      // direct een eigen factuur
const VAT_OPTS = [['vrijgesteld','Vrijgesteld'],['21','21%'],['9','9%'],['0','0%']];
const STEG_CODES = {2:'P000013', 3:'P000014', 4:'P000015', 5:'P00021', 6:'P00022'};

// Zonder online database (alleen bij testen) komen producten en klanten uit testdata.json (staat niet op GitHub)
const SEED = {products:[], customers:[], counters:[], invoices:[], payment_overviews:[]};
let seedTried = false;
async function loadTestdata(){
  if (seedTried) return; seedTried = true;
  try { const r = await fetch('testdata.json', {cache:'no-store'}); if (r.ok) Object.assign(SEED, await r.json()); } catch (e){}
}

/* ---------- hulpjes ---------- */
const pad = (n, l = 2) => String(n).padStart(l, '0');
const round2 = n => Math.round((+n || 0) * 100) / 100;
const eur = n => '€ ' + (+n || 0).toLocaleString('nl-NL', {minimumFractionDigits:2, maximumFractionDigits:2});
const eur0 = n => '€ ' + Math.round(+n || 0).toLocaleString('nl-NL');
const dmy = s => { if (!s) return ''; const [y,m,d] = s.split('-'); return `${d}/${m}/${y}`; };
const dmyDash = s => dmy(s).replace(/\//g, '-');
const today = () => A.todayStr();
const weekKey = s => A.ymd(A.mondayOf(A.parseYmd(s)));
function download(blob, name){
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ---------- data: Supabase of (bij testen) deze browser ---------- */
const Db = {
  get online(){ return !!A.Sync.client; },
  key: t => 'labplanner.db.' + t,
  async all(table){
    if (this.online){ const {data, error} = await A.Sync.client.from(table).select('*'); if (error) throw error; return data; }
    return A.readLS(this.key(table)) || A.clone(SEED[table] || []);
  },
  async upsert(table, rows, k = 'id'){
    rows = [].concat(rows);
    if (this.online){ const {error} = await A.Sync.client.from(table).upsert(rows); if (error) throw error; return; }
    const all = await this.all(table);
    for (const r of rows){ const i = all.findIndex(x => x[k] === r[k]); if (i < 0) all.push(r); else all[i] = r; }
    A.writeLS(this.key(table), all);
  },
  async remove(table, ids, k = 'id'){
    if (!ids.length) return;
    if (this.online){ const {error} = await A.Sync.client.from(table).delete().in(k, ids); if (error) throw error; return; }
    A.writeLS(this.key(table), (await this.all(table)).filter(x => !ids.includes(x[k])));
  },
  async next(key, year){
    if (this.online){ const {data, error} = await A.Sync.client.rpc('next_counter', {p_key:key, p_year:year}); if (error) throw error; return data; }
    const all = await this.all('counters'); let r = all.find(x => x.key === key && x.year === year);
    if (!r){ r = {key, year, value:0}; all.push(r); }
    r.value++; A.writeLS(this.key('counters'), all); return r.value;
  }
};

const S = {loaded:false, loading:null, products:[], customers:[], invoices:[], overviews:[], cust:null, tab:'overzicht', sel:null, open:{}, incomplete:[]};
async function load(force){
  if (S.loading) return S.loading;
  if (S.loaded && !force) return;
  S.loading = (async () => {
    try {
      if (!Db.online) await loadTestdata();
      const [p, c, i, o] = await Promise.all([Db.all('products'), Db.all('customers'), Db.all('invoices'), Db.all('payment_overviews')]);
      S.products = p.sort((a,b) => (a.sort || 0) - (b.sort || 0));
      S.customers = c.sort((a,b) => (b.planner ? 1 : 0) - (a.planner ? 1 : 0) || a.company.localeCompare(b.company));
      S.invoices = i; S.overviews = o;
      if (!S.cust || !S.customers.some(x => x.id === S.cust)) S.cust = (S.customers.find(x => x.planner) || S.customers[0] || {}).id;
      S.loaded = true;
    } catch (e){ toast('Facturatie laden mislukt: ' + (e.message || e)); }
    finally { S.loading = null; }
  })();
  return S.loading;
}
const cust = id => S.customers.find(c => c.id === id) || {};
const prod = code => S.products.find(p => p.code === code) || SEED.products.find(p => p.code === code);

/* ---------- factuurregels uit een opdracht ---------- */
function lineFrom(code, ctx){
  const p = prod(code); if (!p) return null;
  const info = [`Uw referentie: ${ctx.nr || ''}`, `Patiënt: ${ctx.name || ''}`];
  if (p.lot_label) info.push(`${p.lot_label}: ${ctx.lot || ''}`);
  if (p.ce) info.push('CE 1639');
  if (p.stl) info.push('STL- file aangeleverd');
  return {id:A.uid(), code, desc:p.name, qty:1, price:+p.price, vat:p.vat || 'vrijgesteld', info, taskId:ctx.taskId || null, sort:''};
}
function linesForTask(t){
  const L = [], lots = t.lots || {}, pts = A.ptList(t), pt = pts[0] || {nr:'', name:''}, ar = t.arches || {};
  const c = {nr:pt.nr, name:pt.name, taskId:t.id};
  if (t.type === 'base'){
    for (const a of ['boven','onder']){ const x = ar[a]; if (!x) continue;
      const code = x.steg ? (a === 'boven' ? 'P00010' : 'P00020') : x.partial ? (a === 'boven' ? 'P00007' : 'P00008') : (a === 'boven' ? 'P00001' : 'P00002');
      L.push(lineFrom(code, {...c, lot:lots.pmma})); }
  }
  if (t.type === 'imm'){
    const tk = 'tand:' + A.shadeKey(t);
    for (const a of ['boven','onder']){ const x = ar[a]; if (!x) continue;
      L.push(lineFrom(x.partial ? (a === 'boven' ? 'P00009' : 'P000010') : (a === 'boven' ? 'P00003' : 'P00004'), {...c, lot:lots.pmma}));
      L.push(lineFrom(x.partial ? (a === 'boven' ? 'P00011' : 'P000012') : (a === 'boven' ? 'P00005' : 'P00006'), {...c, lot:lots[tk]})); }
  }
  if (t.type === 'steg'){ const code = STEG_CODES[(t.steg || {}).implants]; if (code) L.push(lineFrom(code, {...c, lot:lots.titanium})); }
  if (t.type === 'tryin' || t.type === 'lepel'){
    for (const p of pts) for (const a of ['boven','onder']) if (p[a]){
      const code = t.type === 'tryin' ? (a === 'boven' ? 'P00016' : 'P00017') : (a === 'boven' ? 'P00018' : 'P00019');
      L.push(lineFrom(code, {nr:p.nr, name:p.name, lot:lots.tryin, taskId:t.id}));
    }
  }
  const base = t.completedAt || t.updatedAt || '';
  return L.filter(Boolean).map((l,i) => (l.sort = `${base}|${pad(i,3)}`, l));
}
const taskValue = t => linesForTask(t).reduce((s,l) => s + l.qty * l.price, 0);

function totals(inv){
  let excl = 0; const vat = {};
  for (const l of inv.lines || []){
    const a = round2((+l.qty || 0) * (+l.price || 0)); excl += a;
    if (l.vat && l.vat !== 'vrijgesteld' && +l.vat > 0) vat[l.vat] = (vat[l.vat] || 0) + a * (+l.vat) / 100;
  }
  excl = round2(excl);
  const vatTotal = round2(Object.values(vat).reduce((s,v) => s + v, 0));
  return {excl, vat, vatTotal, incl:round2(excl + vatTotal)};
}
const lineIncl = l => { const a = round2((+l.qty || 0) * (+l.price || 0)); return l.vat && l.vat !== 'vrijgesteld' ? round2(a * (1 + (+l.vat) / 100)) : a; };
const kindLabel = k => ({patient:'Per patiënt', tryin:'Pasprotheses (verzamel)', lepel:'Afdruklepels (verzamel)', los:'Losse factuur'})[k] || k;
const invPatients = inv => [...new Set((inv.lines || []).map(l => { const n = (l.info || []).find(s => s.startsWith('Patiënt:')); return n ? n.slice(8).trim() : ''; }).filter(Boolean))];

async function saveInv(inv){
  inv.total = totals(inv).incl; inv.updated_at = A.nowIso();
  const row = {id:inv.id, customer_id:inv.customer_id, status:inv.status, kind:inv.kind, open_key:inv.open_key || null, number:inv.number || null,
    invoice_date:inv.invoice_date || null, due_date:inv.due_date || null, payment_ref:inv.payment_ref || null, lines:inv.lines, total:inv.total,
    created_at:inv.created_at || A.nowIso(), updated_at:inv.updated_at, accepted_at:inv.accepted_at || null, sent_at:inv.sent_at || null};
  await Db.upsert('invoices', row);
}
function linkTask(taskId, invId, what){
  const t = A.Store.get(taskId); if (!t || t.invoiceId === invId) return;
  const c = A.clone(t); c.invoiceId = invId; A.commit(c, what);
}

/* ---------- concepten automatisch opbouwen uit afgeronde opdrachten ---------- */
let syncing = false, syncTimer = null;
function scheduleSync(){ clearTimeout(syncTimer); syncTimer = setTimeout(syncConcepts, 400); }
async function syncConcepts(){
  if (!A.isAdmin() || syncing) return;
  await load(); if (!S.loaded) return;
  const pc = S.customers.find(c => c.planner); if (!pc) return;
  syncing = true;
  try {
    const changed = new Map(), unlink = [];
    // Opdracht weer open gezet of verwijderd: regels uit het concept halen
    for (const inv of S.invoices.filter(i => i.status === 'concept')){
      const keep = inv.lines.filter(l => { if (!l.taskId) return true; const t = A.Store.get(l.taskId); const ok = t && !t.deleted && t.status === 'done'; if (!ok && t) unlink.push(t.id); return ok; });
      if (keep.length !== inv.lines.length){ inv.lines = keep; changed.set(inv.id, inv); }
    }
    for (const id of new Set(unlink)) linkTask(id, null, 'Van conceptfactuur gehaald');
    // Nieuw afgerond: op een concept zetten
    S.incomplete = [];
    const done = A.Store.live().filter(t => BILLABLE.has(t.type) && !t.example && t.status === 'done' && !t.invoiceId && (t.completedAt || '') >= BILLING_START);
    for (const t of done){
      const lines = linesForTask(t);
      if (!lines.length){ S.incomplete.push(t); continue; }
      let inv;
      if (PER_PATIENT.has(t.type)){
        inv = S.invoices.find(i => i.id === 'T-' + t.id);
        if (!inv){ inv = {id:'T-' + t.id, customer_id:pc.id, status:'concept', kind:'patient', lines, created_at:A.nowIso()}; S.invoices.push(inv); }
      } else {
        const key = `${pc.id}:${t.type}`;
        inv = S.invoices.find(i => i.open_key === key && i.status === 'concept');
        if (!inv){ inv = {id:A.uid(), customer_id:pc.id, status:'concept', kind:t.type, open_key:key, lines:[], created_at:A.nowIso()}; S.invoices.push(inv); }
        inv.lines = inv.lines.filter(l => l.taskId !== t.id).concat(lines).sort((a,b) => (a.sort || '').localeCompare(b.sort || ''));
      }
      changed.set(inv.id, inv);
      linkTask(t.id, inv.id, 'Op conceptfactuur gezet');
    }
    for (const inv of changed.values()){
      if (!inv.lines.length){ await Db.remove('invoices', [inv.id]); S.invoices = S.invoices.filter(i => i !== inv); if (S.sel === inv.id) S.sel = null; }
      else await saveInv(inv);
    }
    if (changed.size || S.incomplete.length) draw();
  } catch (e){ toast('Concepten bijwerken mislukt: ' + (e.message || e)); }
  finally { syncing = false; }
}

/* ---------- acties ---------- */
async function acceptInv(inv){
  if (!inv.lines.length){ toast('Deze factuur heeft geen regels.'); return; }
  const miss = inv.lines.filter(l => (l.info || []).some(s => /^lot ?nummer[^:]*:\s*$/i.test(s)));
  if (miss.length){ toast(`Vul eerst het lotnummer in bij: ${miss.map(l => l.desc).slice(0,2).join(', ')}${miss.length > 2 ? '…' : ''}`); return; }
  const d = new Date(), y = d.getFullYear();
  try {
    const seq = await Db.next('invoice', y);
    inv.number = `${y}${pad(d.getMonth() + 1)}${pad(seq, 4)}`;
    inv.invoice_date = A.ymd(d); inv.due_date = A.ymd(A.addDays(d, PAY_DAYS));
    inv.status = 'geaccepteerd'; inv.open_key = null; inv.accepted_at = A.nowIso();
    await saveInv(inv);
    toast(`Factuur ${inv.number} geaccepteerd`);
    S.sel = null; draw();
  } catch (e){ toast('Accepteren mislukt: ' + (e.message || e)); }
}
async function rebuildInv(inv){
  const ids = [...new Set(inv.lines.map(l => l.taskId).filter(Boolean))];
  const fresh = ids.flatMap(id => { const t = A.Store.get(id); return t ? linesForTask(t) : []; });
  inv.lines = inv.lines.filter(l => !l.taskId).concat(fresh).sort((a,b) => (a.sort || '').localeCompare(b.sort || ''));
  await saveInv(inv); draw(); toast('Regels opnieuw opgebouwd uit de opdrachten');
}
let dropArmed = 0;
async function dropInv(inv, btn){
  if (Date.now() > dropArmed){ dropArmed = Date.now() + 4000; btn.textContent = 'Nogmaals klikken om te bevestigen'; btn.classList.add('armed'); setTimeout(() => { btn.textContent = 'Niet factureren'; btn.classList.remove('armed'); }, 4000); return; }
  for (const id of new Set(inv.lines.map(l => l.taskId).filter(Boolean))) linkTask(id, 'none', 'Gemarkeerd als niet factureren');
  await Db.remove('invoices', [inv.id]);
  S.invoices = S.invoices.filter(i => i !== inv); S.sel = null; draw(); toast('Concept verwijderd; de opdrachten worden niet gefactureerd');
}
async function newManual(){
  const c = cust(S.cust);
  const inv = {id:A.uid(), customer_id:c.id, status:'concept', kind:'los', lines:[], created_at:A.nowIso()};
  S.invoices.push(inv); await saveInv(inv);
  S.tab = 'concept'; S.sel = inv.id; draw();
}
function addLine(inv, code){
  const c = cust(inv.customer_id);
  let l;
  if (code === '__vrij'){ l = {id:A.uid(), code:'', desc:'', qty:1, price:0, vat:c.default_vat || 'vrijgesteld', info:[], taskId:null}; }
  else {
    const p = prod(code); if (!p) return;
    const lot = p.lot_material && p.lot_material !== 'tand' ? A.Lots.current(p.lot_material) : '';
    l = lineFrom(code, {nr:'', name:'', lot});
    if (c.default_vat && c.default_vat !== 'vrijgesteld' && (p.vat || 'vrijgesteld') === 'vrijgesteld') l.vat = c.default_vat;
  }
  l.sort = 'z' + Date.now();
  inv.lines.push(l);
}

async function exportOverview(){
  const c = cust(S.cust);
  const list = S.invoices.filter(i => i.customer_id === c.id && i.status === 'geaccepteerd').sort((a,b) => a.number.localeCompare(b.number));
  if (!list.length){ toast('Er zijn geen geaccepteerde facturen om te exporteren.'); return; }
  const btn = F('bExport'); btn.disabled = true; btn.textContent = 'Bezig met PDF’s…';
  try {
    const y = new Date().getFullYear();
    const ref = `${y}${pad(await Db.next('payref', y))}`;
    const dates = list.map(i => i.invoice_date).sort();
    const ov = {ref, customer_id:c.id, created_at:A.nowIso(), period_from:dates[0], period_to:dates[dates.length - 1], total:round2(list.reduce((s,i) => s + totals(i).incl, 0)), invoice_numbers:list.map(i => i.number)};
    const zipBlob = await buildZip(ov, list, c);
    for (const inv of list){ inv.status = 'verstuurd'; inv.payment_ref = ref; inv.sent_at = A.nowIso(); await saveInv(inv); }
    await Db.upsert('payment_overviews', ov, 'ref'); S.overviews.push(ov);
    download(zipBlob, folderName(ov, c) + '.zip');
    toast(`Betaaloverzicht ${ref} met ${list.length} facturen geëxporteerd`);
    S.tab = 'verstuurd'; S.open[ref] = true; draw();
  } catch (e){ toast('Exporteren mislukt: ' + (e.message || e)); }
  finally { btn.disabled = false; draw(); }
}
const folderName = (ov, c) => `${ov.ref} - ${dmyDash(A.ymd(new Date(ov.created_at)))} ${c.short_name || c.company}`;
async function buildZip(ov, list, c){
  const zip = new JSZip(), dir = zip.folder(folderName(ov, c));
  for (const inv of list) dir.file(`${inv.number}.pdf`, (await Pdf.invoice(inv, c)).output('arraybuffer'));
  dir.file(`Betaaloverzicht ${c.short_name || c.company} ${ov.ref}.pdf`, (await Pdf.overview(ov, list, c)).output('arraybuffer'));
  return zip.generateAsync({type:'blob'});
}
async function exportSingle(inv){
  const c = cust(inv.customer_id);
  try {
    const doc = await Pdf.invoice(inv, c);
    inv.status = 'verstuurd'; inv.payment_ref = null; inv.sent_at = A.nowIso(); await saveInv(inv);
    download(doc.output('blob'), `${inv.number}.pdf`);
    toast(`Factuur ${inv.number} los geëxporteerd`); S.sel = null; draw();
  } catch (e){ toast('Exporteren mislukt: ' + (e.message || e)); }
}
async function viewPdf(title, docPromise, fileName){
  try {
    const doc = await docPromise, blob = doc.output('blob'), url = URL.createObjectURL(blob);
    F('pdfTitle').textContent = title;
    F('pdfFrame').src = url; F('pdfOpen').href = url;
    F('pdfDl').onclick = () => download(blob, fileName);
    F('pdfDlg').showModal();
  } catch (e){ toast('PDF maken mislukt: ' + (e.message || e)); }
}

/* ---------- PDF (zelfde opmaak als de huidige facturen) ---------- */
const Pdf = {
  res:null,
  async init(){
    if (this.res) return this.res;
    const b64 = async url => { const buf = await (await fetch(url)).arrayBuffer(); let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
    const res = {fonts:null, logo:null};
    try { res.fonts = {r:await b64('assets/fonts/Kanit-Regular.ttf'), m:await b64('assets/fonts/Kanit-Medium.ttf'), b:await b64('assets/fonts/Kanit-SemiBold.ttf')}; } catch (e){ res.fonts = null; }
    try { res.logo = await cropLogo('assets/logo.png'); } catch (e){ res.logo = null; }
    return this.res = res;
  },
  doc(res){
    const {jsPDF} = window.jspdf, d = new jsPDF({unit:'mm', format:'a4', compress:true});
    if (res.fonts){
      d.addFileToVFS('Kanit-Regular.ttf', res.fonts.r); d.addFont('Kanit-Regular.ttf', 'Kanit', 'normal');
      d.addFileToVFS('Kanit-Medium.ttf', res.fonts.m); d.addFont('Kanit-Medium.ttf', 'Kanit', 'medium');
      d.addFileToVFS('Kanit-SemiBold.ttf', res.fonts.b); d.addFont('Kanit-SemiBold.ttf', 'Kanit', 'bold');
      d.F = (st, size) => { d.setFont('Kanit', st === 'b' ? 'bold' : st === 'm' ? 'medium' : 'normal'); d.setFontSize(size); };
    } else d.F = (st, size) => { d.setFont('helvetica', st === 'b' ? 'bold' : 'normal'); d.setFontSize(size); };
    d.setTextColor(17, 17, 17); d.setDrawColor(17, 17, 17);
    return d;
  },
  async invoice(inv, c){
    const res = await this.init(), d = this.doc(res);
    const L = 16, R = 194, CX = 153, BOTTOM = 270, t = totals(inv);
    if (res.logo) d.addImage(res.logo.data, 'JPEG', L, 12, 30, 30 * res.logo.h / res.logo.w);
    d.F('b', 12.5); d.text(`Factuur: ${inv.number || 'CONCEPT'}`, R, 22, {align:'right'});
    // klant
    let y = 64;
    d.F('b', 12.5); d.text(c.company || '', L, y); y += 6.4;
    d.F('r', 12);
    for (const s of [c.contact, c.address, [c.postcode, c.city].filter(Boolean).join(' '), c.country].filter(Boolean)){ d.text(s, L, y); y += 6.4; }
    // afzender
    let ry = 61;
    d.F('b', 8.5); d.text(COMPANY.name, R, ry, {align:'right'}); ry += 4.2;
    d.F('r', 8.5);
    for (const s of [COMPANY.address, `${COMPANY.postcode} ${COMPANY.city}`]){ d.text(s, R, ry, {align:'right'}); ry += 4.2; }
    ry += 2.6;
    for (const s of [`KVK-nummer: ${COMPANY.kvk}`, `Tel.: ${COMPANY.tel}`, `E-mail: ${COMPANY.email}`, `Website: ${COMPANY.web}`, `IBAN: ${COMPANY.iban}`, `BIC: ${COMPANY.bic}`]){ d.text(s, R, ry, {align:'right'}); ry += 4.2; }
    // datums
    y = 107; d.F('r', 8.5);
    for (const s of [`Factuurdatum: ${dmy(inv.invoice_date) || '—'}`, `Vervaldatum: ${dmy(inv.due_date) || '—'}`, `Klantnummer: ${c.id}`]){ d.text(s, L, y); y += 4.2; }
    const head = yy => {
      d.F('r', 8.5);
      d.text('Aantal', L, yy); d.text('Beschrijving', L + 13, yy);
      d.text('Bedrag', CX, yy, {align:'right'}); d.text('Bedrag', R, yy, {align:'right'});
      d.text('excl. btw', CX, yy + 4.6, {align:'right'}); d.text('incl. btw', R, yy + 4.6, {align:'right'});
      d.setLineWidth(0.35); d.line(L, yy + 6.6, R, yy + 6.6);
      return yy + 13;
    };
    y = head(132);
    for (const l of inv.lines){
      const desc = d.splitTextToSize(l.desc || '', CX - L - 13 - 22);
      const h = desc.length * 5.4 + 5.6 + (l.info || []).length * 4.6 + 5;
      if (y + h > BOTTOM){ d.addPage(); y = head(22); }
      d.F('r', 11);
      d.text(String(l.qty), L, y);
      d.text(desc, L + 13, y);
      d.text(eur((+l.qty || 0) * (+l.price || 0)), CX, y, {align:'right'});
      d.text(eur(lineIncl(l)), R, y, {align:'right'});
      let yy = y + desc.length * 5.4;
      d.text(`Stuksprijs: ${eur(l.price)}`, L + 13, yy);
      d.F('r', 8); d.text(l.vat && l.vat !== 'vrijgesteld' ? `${l.vat}% btw` : 'Btw vrijgesteld', R, y + 5.4, {align:'right'});
      yy += 4.8; d.F('r', 8.5);
      for (const s of l.info || []){ d.text(s, L + 13, yy); yy += 4.6; }
      y = yy + 4.4;
    }
    const vatLines = Object.entries(t.vat);
    if (y + 20 + vatLines.length * 7 > BOTTOM){ d.addPage(); y = head(22); }
    d.setLineWidth(0.35); d.line(L, y - 2, R, y - 2);
    y += 5; d.F('r', 11);
    d.text('Totaalbedrag excl. btw', CX, y, {align:'right'}); d.text(eur(t.excl), R, y, {align:'right'});
    for (const [rate, v] of vatLines){ y += 7; d.text(`Btw ${rate}%`, CX, y, {align:'right'}); d.text(eur(v), R, y, {align:'right'}); }
    y += 4.5; d.line(L, y, R, y); y += 7;
    d.F('b', 11); d.text('Totaalbedrag incl. btw', CX, y, {align:'right'}); d.text(eur(t.incl), R, y, {align:'right'});
    // betaaltekst
    const pay1 = `Gelieve dit bedrag van ${eur(t.incl)} over te maken voor: ${dmy(inv.due_date) || '—'} op rekeningnummer:`;
    const pay2 = `${COMPANY.iban} t.n.v. ${COMPANY.name} o.v.v. "Factuur ${inv.number || 'CONCEPT'}".`;
    let py = 248;
    if (y > 232){ d.addPage(); py = 72; }
    d.F('r', 10.5); d.text(pay1, 105, py, {align:'center'}); d.text(pay2, 105, py + 6.2, {align:'center'});
    this.pageNumbers(d);
    return d;
  },
  async overview(ov, list, c){
    const res = await this.init(), d = this.doc(res);
    const L = 14, R = 196, BOTTOM = 270, name = c.short_name || c.company;
    const period = `${dmy(ov.period_from).slice(0,5)} tm ${dmy(ov.period_to).slice(0,5)} ${(ov.period_to || '').slice(0,4)}`;
    if (res.logo){ const w = 26; d.addImage(res.logo.data, 'JPEG', R - w, 22, w, w * res.logo.h / res.logo.w); }
    d.F('b', 10); d.text(`Betaaloverzicht ${name} ${period}`, L, 36);
    d.F('r', 10); d.text(`Betalingsreferentie: ${ov.ref}`, 108, 36);
    const cols = {klant:L, datum:L + 27, nr:L + 50, oms:L + 74, excl:157, btw:174, incl:R};
    const head = yy => {
      d.F('m', 8);
      d.text('Klant', cols.klant, yy); d.text('Factuurdatum', cols.datum, yy); d.text('Factuurnummer', cols.nr, yy); d.text('Omschrijving', cols.oms, yy);
      d.text('Excl. btw', cols.excl, yy, {align:'right'}); d.text('Btw', cols.btw, yy, {align:'right'}); d.text('Incl. btw', cols.incl, yy, {align:'right'});
      d.setLineWidth(0.3); d.line(L, yy + 2, R, yy + 2);
      return yy + 7.5;
    };
    let y = head(58);
    for (const inv of list){
      if (y > BOTTOM - 25){ d.addPage(); y = head(24); }
      const t = totals(inv);
      let oms = inv.lines.map(l => l.desc).join(', ');
      d.F('r', 7.6);
      while (oms.length > 3 && d.getTextWidth(oms) > cols.excl - 16 - cols.oms) oms = oms.slice(0, -2);
      if (oms !== inv.lines.map(l => l.desc).join(', ')) oms = oms.replace(/[ ,]+$/, '') + '…';
      d.text(name, cols.klant, y); d.text(dmy(inv.invoice_date), cols.datum, y); d.text(inv.number, cols.nr, y); d.text(oms, cols.oms, y);
      d.text(eur(t.excl), cols.excl, y, {align:'right'}); d.text(t.vatTotal ? eur(t.vatTotal) : 'vrijgesteld', cols.btw, y, {align:'right'});
      d.F('m', 7.6); d.text(eur(t.incl), cols.incl, y, {align:'right'});
      y += 5;
    }
    const ex = round2(list.reduce((s,i) => s + totals(i).excl, 0)), inc = round2(list.reduce((s,i) => s + totals(i).incl, 0)), vt = round2(inc - ex);
    y = Math.max(y + 18, 150); if (y > BOTTOM - 20){ d.addPage(); y = 40; }
    d.setLineWidth(0.3); d.line(L, y, R, y); y += 7;
    d.F('r', 9); d.text('Totaalbedrag excl. btw', 150, y, {align:'right'}); d.text(eur(ex), R, y, {align:'right'});
    if (vt){ y += 6; d.text('Btw', 150, y, {align:'right'}); d.text(eur(vt), R, y, {align:'right'}); }
    y += 4; d.line(L, y, R, y); y += 7;
    d.F('b', 9.5); d.text('Totaalbedrag incl. btw', 150, y, {align:'right'}); d.text(eur(inc), R, y, {align:'right'});
    y += 12; d.F('r', 8.5);
    d.text(`Graag het totaalbedrag van ${eur(inc)} in één betaling overmaken op ${COMPANY.iban} t.n.v. ${COMPANY.name} o.v.v. "${ov.ref}".`, L, y);
    this.pageNumbers(d);
    return d;
  },
  pageNumbers(d){
    const n = d.getNumberOfPages();
    for (let i = 1; i <= n; i++){ d.setPage(i); d.F('r', 7.5); d.text(`Pagina ${i} / ${n}`, 105, 288, {align:'center'}); }
  }
};
async function cropLogo(url){
  const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = url; });
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const {data, width, height} = g.getImageData(0, 0, c.width, c.height);
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2){
    const i = (y * width + x) * 4;
    if (data[i+3] > 20 && (data[i] < 235 || data[i+1] < 235 || data[i+2] < 235)){ if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 <= x0) return {data:c.toDataURL('image/png'), w:width, h:height};
  // bijsnijden en verkleinen (scherp genoeg voor print, klein bestand)
  const w = x1 - x0 + 4, h = y1 - y0 + 4, k = Math.min(1, 600 / w), ow = Math.round(w * k), oh = Math.round(h * k);
  const o = document.createElement('canvas'); o.width = ow; o.height = oh;
  const og = o.getContext('2d'); og.fillStyle = '#fff'; og.fillRect(0, 0, ow, oh); og.drawImage(c, x0 - 2, y0 - 2, w, h, 0, 0, ow, oh);
  return {data:o.toDataURL('image/jpeg', 0.92), w:ow, h:oh};
}

/* ---------- omzet: verwacht, verdiend, records ---------- */
function revenue(){
  const now = new Date(), thisWeek = A.ymd(A.mondayOf(now)), weeks = {}, days = {}, products = {};
  const add = (k, field, v) => { weeks[k] = weeks[k] || {earned:0, expected:0, n:0}; weeks[k][field] += v; };
  const year = String(now.getFullYear());
  let yearEarned = 0, monthEarned = 0, yearTasks = 0;
  for (const t of A.Store.live()){
    if (!BILLABLE.has(t.type) || t.example) continue;
    const lines = linesForTask(t); if (!lines.length) continue;
    const v = lines.reduce((s,l) => s + l.qty * l.price, 0);
    if (t.status === 'done' && t.completedAt){
      const day = A.ymd(new Date(t.completedAt)), wk = weekKey(day);
      add(wk, 'earned', v); weeks[wk].n++;
      days[day] = (days[day] || 0) + v;
      if (day.startsWith(year)){ yearEarned += v; yearTasks++; for (const l of lines) products[l.desc] = (products[l.desc] || 0) + l.qty; }
      if (day.slice(0,7) === A.ymd(now).slice(0,7)) monthEarned += v;
    } else if (t.status !== 'done' && t.dueDate){
      let wk = weekKey(t.dueDate); if (wk < thisWeek) wk = thisWeek;   // te laat: telt mee in deze week
      add(wk, 'expected', v);
    }
  }
  // Losse facturen voor andere klanten tellen mee op hun factuurdatum
  for (const inv of S.invoices){
    if (inv.kind !== 'los' || inv.status === 'concept' || !inv.invoice_date) continue;
    const v = totals(inv).excl, wk = weekKey(inv.invoice_date);
    add(wk, 'earned', v); days[inv.invoice_date] = (days[inv.invoice_date] || 0) + v;
    if (inv.invoice_date.startsWith(year)) yearEarned += v;
    if (inv.invoice_date.slice(0,7) === A.ymd(now).slice(0,7)) monthEarned += v;
  }
  const bestDay = Object.entries(days).sort((a,b) => b[1] - a[1])[0];
  const pastWeeks = Object.entries(weeks).filter(([k]) => k <= thisWeek);
  const bestWeek = pastWeeks.slice().sort((a,b) => (b[1].earned) - (a[1].earned))[0];
  const last8 = [...Array(8)].map((_,i) => A.ymd(A.addDays(A.parseYmd(thisWeek), -7 * (i + 1)))).map(k => (weeks[k] || {}).earned || 0).filter(v => v > 0);
  const dowTotals = [0,0,0,0,0,0,0], dowCount = [0,0,0,0,0,0,0];
  for (const [d, v] of Object.entries(days)){ const i = A.dowIdx(A.parseYmd(d)); dowTotals[i] += v; dowCount[i]++; }
  const bestDow = dowTotals.map((v,i) => [i, dowCount[i] ? v / dowCount[i] : 0]).sort((a,b) => b[1] - a[1])[0];
  const topProduct = Object.entries(products).sort((a,b) => b[1] - a[1])[0];
  return {thisWeek, weeks, bestDay, bestWeek, avg: last8.length ? last8.reduce((s,v) => s + v, 0) / last8.length : 0, yearEarned, monthEarned, yearTasks, bestDow, topProduct};
}
function overviewHtml(){
  const r = revenue(), w = r.weeks[r.thisWeek] || {earned:0, expected:0, n:0};
  const nextWk = A.ymd(A.addDays(A.parseYmd(r.thisWeek), 7)), nw = r.weeks[nextWk] || {earned:0, expected:0};
  const totalWeek = w.earned + w.expected, pct = totalWeek ? Math.round(w.earned / totalWeek * 100) : 0;
  const bestW = r.bestWeek ? r.bestWeek[1].earned : 0;
  // grafiek: 12 weken terug + volgende week
  const keys = [...Array(13)].map((_,i) => A.ymd(A.addDays(A.parseYmd(r.thisWeek), 7 * (i - 11))));
  const vals = keys.map(k => r.weeks[k] || {earned:0, expected:0});
  const max = Math.max(1, ...vals.map(v => v.earned + v.expected));
  const nice = (() => { const raw = max / 4, p = Math.pow(10, Math.floor(Math.log10(raw))); const m = [1,2,2.5,5,10].find(x => x * p >= raw) * p; return m; })();
  const top = nice * 4, W = 960, H = 230, padL = 50, padB = 26, bw = (W - padL - 10) / keys.length;
  const yOf = v => H - padB - (v / top) * (H - padB - 10);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="rev-chart" role="img" aria-label="Omzet per week">`;
  for (let i = 0; i <= 4; i++){ const v = nice * i, yy = yOf(v); svg += `<line x1="${padL}" x2="${W - 6}" y1="${yy}" y2="${yy}" class="g"/><text x="${padL - 6}" y="${yy + 3.5}" text-anchor="end" class="ax">${v ? eur0(v) : '€ 0'}</text>`; }
  keys.forEach((k, i) => {
    const v = vals[i], x = padL + i * bw + bw * 0.18, bwi = bw * 0.64;
    const ye = yOf(v.earned), yx = yOf(v.earned + v.expected), cur = k === r.thisWeek;
    if (v.expected) svg += `<rect x="${x}" y="${yx}" width="${bwi}" height="${ye - yx}" rx="3" class="exp"><title>Verwacht: ${eur(v.expected)}</title></rect>`;
    if (v.earned) svg += `<rect x="${x}" y="${ye}" width="${bwi}" height="${H - padB - ye}" rx="3" class="earn${cur ? ' cur' : ''}"><title>Verdiend: ${eur(v.earned)}</title></rect>`;
    svg += `<text x="${x + bwi / 2}" y="${H - 8}" text-anchor="middle" class="ax${cur ? ' curl' : ''}">wk ${A.isoWeek(A.parseYmd(k))}</text>`;
  });
  svg += '</svg>';
  const toBest = bestW && totalWeek < bestW ? `Nog ${eur0(bestW - totalWeek)} tot je beste week ooit.` : bestW && w.earned > bestW - 0.01 && w.earned > 0 ? 'Dit is nu al je beste week ooit!' : '';
  const DOWL = ['maandag','dinsdag','woensdag','donderdag','vrijdag','zaterdag','zondag'];
  return `<div class="rev">
    <div class="rev-hero">
      <div class="rev-main"><span class="rev-lbl">Verwachte omzet week ${A.isoWeek(A.parseYmd(r.thisWeek))}</span><b class="rev-big">${eur(totalWeek)}</b>
        <div class="rev-bar"><i style="width:${pct}%"></i></div>
        <span class="rev-sub"><b>${eur(w.earned)}</b> verdiend · <b>${eur(w.expected)}</b> nog af te ronden${toBest ? ` · ${toBest}` : ''}</span></div>
      <div class="rev-kpis">
        <div><span>Volgende week gepland</span><b>${eur(nw.expected)}</b></div>
        <div><span>Deze maand</span><b>${eur(r.monthEarned)}</b></div>
        <div><span>Dit jaar</span><b>${eur(r.yearEarned)}</b></div>
        <div><span>Gemiddeld per week</span><b>${eur(r.avg)}</b><small>laatste 8 weken</small></div>
      </div>
    </div>
    <div class="rev-card"><div class="rev-ch"><h3>Omzet per week</h3><span class="lg"><i class="earn"></i>Verdiend <i class="exp"></i>Verwacht</span></div>${svg}
      <p class="hint">Verwacht = opdrachten die nog niet klaar zijn, op de week van hun einddatum. Blijft een opdracht openstaan, dan schuift hij mee naar de huidige week. Verdiend = op de dag dat de opdracht op Klaar ging.</p></div>
    <div class="rev-records">
      <div class="rec"><span>Beste dag ooit</span><b>${r.bestDay ? eur(r.bestDay[1]) : '—'}</b><small>${r.bestDay ? A.fmtDay(r.bestDay[0]) + ' ' + r.bestDay[0].slice(0,4) : 'nog geen data'}</small></div>
      <div class="rec"><span>Beste week ooit</span><b>${r.bestWeek ? eur(r.bestWeek[1].earned) : '—'}</b><small>${r.bestWeek ? `week ${A.isoWeek(A.parseYmd(r.bestWeek[0]))} · ${r.bestWeek[0].slice(0,4)}` : 'nog geen data'}</small></div>
      <div class="rec"><span>Sterkste weekdag</span><b>${r.bestDow && r.bestDow[1] ? DOWL[r.bestDow[0]] : '—'}</b><small>${r.bestDow && r.bestDow[1] ? 'gemiddeld ' + eur0(r.bestDow[1]) + ' per dag' : ''}</small></div>
      <div class="rec"><span>Topproduct dit jaar</span><b>${r.topProduct ? r.topProduct[1] + '×' : '—'}</b><small>${r.topProduct ? esc(r.topProduct[0]) : ''}</small></div>
      <div class="rec"><span>Afgeronde opdrachten</span><b>${r.yearTasks}</b><small>dit jaar</small></div>
    </div>
  </div>`;
}

/* ---------- scherm ---------- */
const view = F('billingView');
function counts(){
  const mine = S.invoices.filter(i => i.customer_id === S.cust);
  return {concept:mine.filter(i => i.status === 'concept').length, acc:mine.filter(i => i.status === 'geaccepteerd').length};
}
function invCard(inv){
  const t = totals(inv), pts = invPatients(inv), miss = inv.lines.some(l => (l.info || []).some(s => /^lot ?nummer[^:]*:\s*$/i.test(s)));
  return `<button type="button" class="ic${S.sel === inv.id ? ' sel' : ''}" data-inv="${esc(inv.id)}">
    <span class="ic-top"><b>${inv.number ? esc(inv.number) : 'Concept'}</b><span class="ic-kind">${kindLabel(inv.kind)}</span></span>
    <span class="ic-pt">${pts.length ? esc(pts.slice(0,4).join(', ')) + (pts.length > 4 ? ` +${pts.length - 4}` : '') : esc((inv.lines[0] || {}).desc || 'Nog geen regels')}</span>
    <span class="ic-bot"><span>${inv.lines.length} ${inv.lines.length === 1 ? 'regel' : 'regels'}${inv.invoice_date ? ' · ' + dmy(inv.invoice_date) : ''}</span>${miss ? '<span class="ic-warn">lotnummer ontbreekt</span>' : ''}<b>${eur(t.incl)}</b></span>
  </button>`;
}
function editorHtml(inv){
  const c = cust(inv.customer_id), t = totals(inv), ro = inv.status === 'verstuurd';
  const prodOpts = `<option value="">+ Regel toevoegen…</option>` + S.products.filter(p => p.active !== false).map(p => `<option value="${esc(p.code)}">${esc(p.name)} · ${eur(p.price)}</option>`).join('') + '<option value="__vrij">Vrije regel (eigen omschrijving en prijs)</option>';
  return `<div class="ie">
    <div class="ie-head">
      <div><h3>${inv.number ? 'Factuur ' + esc(inv.number) : 'Conceptfactuur'}</h3><span class="hint">${esc(c.company || '')} · ${kindLabel(inv.kind)}${inv.invoice_date ? ' · ' + dmy(inv.invoice_date) + ', vervalt ' + dmy(inv.due_date) : ''}</span></div>
      <button type="button" class="btn ghost sm" data-act="pdf">Voorbeeld PDF</button>
    </div>
    ${inv.kind === 'tryin' || inv.kind === 'lepel' ? `<p class="ie-note">Elke afgeronde ${inv.kind === 'tryin' ? 'pasprothese' : 'afdruklepel'} komt automatisch op deze verzamelfactuur, tot je hem accepteert. Daarna begint een nieuwe.</p>` : ''}
    <div class="ie-lines">${inv.lines.map((l,i) => `<div class="il" data-li="${i}">
        <div class="il-row">
          <input type="number" class="il-qty" data-f="qty" value="${esc(l.qty)}" min="0" step="1" aria-label="Aantal"${ro ? ' disabled' : ''}>
          <input type="text" class="il-desc" data-f="desc" value="${esc(l.desc)}" aria-label="Omschrijving"${ro ? ' disabled' : ''}>
          <span class="il-eur">€<input type="number" class="il-price" data-f="price" value="${esc(l.price)}" step="0.01" aria-label="Stuksprijs"${ro ? ' disabled' : ''}></span>
          <select data-f="vat" aria-label="Btw"${ro ? ' disabled' : ''}>${VAT_OPTS.map(([v,lab]) => `<option value="${v}"${String(l.vat || 'vrijgesteld') === v ? ' selected' : ''}>${lab}</option>`).join('')}</select>
          <b class="il-sum">${eur(lineIncl(l))}</b>
          ${ro ? '' : `<button type="button" class="il-rm" data-act="rmline" aria-label="Regel verwijderen" title="Regel verwijderen">×</button>`}
        </div>
        <textarea data-f="info" rows="${Math.max(2, (l.info || []).length)}" aria-label="Extra regels onder deze omschrijving"${ro ? ' disabled' : ''}>${esc((l.info || []).join('\n'))}</textarea>
      </div>`).join('') || '<p class="hint">Nog geen regels. Voeg hieronder een product toe.</p>'}</div>
    ${ro ? '' : `<select class="ie-add" data-act="addline" aria-label="Regel toevoegen">${prodOpts}</select>`}
    <div class="ie-tot"><span>Totaal excl. btw <b>${eur(t.excl)}</b></span>${t.vatTotal ? `<span>Btw <b>${eur(t.vatTotal)}</b></span>` : ''}<span class="big">Totaal <b>${eur(t.incl)}</b></span></div>
    <div class="ie-foot">
      ${inv.status === 'concept' ? `${inv.lines.some(l => l.taskId) ? '<button type="button" class="btn ghost sm" data-act="rebuild" title="Neemt wijzigingen in de opdrachten over">Opnieuw opbouwen</button>' : ''}
        <button type="button" class="btn danger-ghost sm" data-act="drop">Niet factureren</button><span class="spacer"></span>
        <button type="button" class="btn primary" data-act="accept">Accepteren</button>` : ''}
      ${inv.status === 'geaccepteerd' ? `<span class="hint">Komt mee in het volgende betaaloverzicht.</span><span class="spacer"></span><button type="button" class="btn ghost sm" data-act="single">Los exporteren (zonder betaaloverzicht)</button>` : ''}
    </div>
  </div>`;
}
function sentHtml(){
  const mine = S.invoices.filter(i => i.customer_id === S.cust && i.status === 'verstuurd');
  const ovs = S.overviews.filter(o => o.customer_id === S.cust).sort((a,b) => b.ref.localeCompare(a.ref));
  const c = cust(S.cust);
  const folder = (key, title, sub, invs, ov) => `<div class="fold${S.open[key] ? ' open' : ''}">
    <button type="button" class="fold-h" data-fold="${esc(key)}"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" style="fill:var(--accent-soft);stroke:var(--accent);stroke-width:1.5"/></svg>
      <span class="fold-t"><b>${esc(title)}</b><small>${esc(sub)}</small></span><b class="fold-sum">${eur(invs.reduce((s,i) => s + totals(i).incl, 0))}</b></button>
    ${S.open[key] ? `<div class="fold-b">
      ${ov ? `<div class="fold-acts"><button type="button" class="btn ghost sm" data-ov="${esc(ov.ref)}">Betaaloverzicht openen</button><button type="button" class="btn ghost sm" data-zip="${esc(ov.ref)}">Map opnieuw downloaden (ZIP)</button></div>` : ''}
      ${invs.sort((a,b) => (a.number || '').localeCompare(b.number || '')).map(i => `<div class="fr"><b class="mono">${esc(i.number)}</b><span>${dmy(i.invoice_date)}</span><span class="fr-d">${esc(invPatients(i).join(', ') || i.lines.map(l => l.desc).join(', '))}</span><b>${eur(totals(i).incl)}</b><button type="button" class="btn ghost sm" data-openinv="${esc(i.id)}">Openen</button></div>`).join('')}
    </div>` : ''}
  </div>`;
  let h = ovs.map(o => folder(o.ref, `${o.ref} · ${dmyDash(A.ymd(new Date(o.created_at)))} · ${c.short_name || c.company}`, `${o.invoice_numbers.length} facturen · ${dmy(o.period_from)} t/m ${dmy(o.period_to)}`, mine.filter(i => i.payment_ref === o.ref), o)).join('');
  const loose = mine.filter(i => !i.payment_ref);
  if (loose.length) h += folder('__los', 'Los verstuurd', `${loose.length} facturen zonder betaaloverzicht`, loose, null);
  return h || '<p class="hint bill-empty">Nog niets verstuurd voor deze klant.</p>';
}
function draw(){
  if (view.hidden || !S.loaded) return;
  const n = counts(), c = cust(S.cust);
  const active = document.activeElement && view.contains(document.activeElement) && document.activeElement.matches('input, textarea, select') ? document.activeElement : null;
  if (active && active.closest('.ie')) { drawTotalsOnly(); return; }   // niet herschrijven tijdens typen
  let body = '';
  if (S.tab === 'overzicht') body = overviewHtml();
  else if (S.tab === 'verstuurd') body = `<div class="folds">${sentHtml()}</div>`;
  else {
    const st = S.tab === 'concept' ? 'concept' : 'geaccepteerd';
    const list = S.invoices.filter(i => i.customer_id === S.cust && i.status === st).sort((a,b) => (a.number || a.created_at || '').localeCompare(b.number || b.created_at || ''));
    if (S.sel && !list.some(i => i.id === S.sel)) S.sel = null;
    if (!S.sel && list.length && innerWidth > 900) S.sel = list[0].id;
    const sel = list.find(i => i.id === S.sel);
    const inc = st === 'concept' && c.planner && S.incomplete.length ? `<div class="bill-warn"><b>${S.incomplete.length} afgeronde ${S.incomplete.length === 1 ? 'opdracht mist' : 'opdrachten missen'} gegevens</b> (bijv. boven/onder of aantal implantaten) en ${S.incomplete.length === 1 ? 'staat' : 'staan'} daarom nog niet op een factuur. ${S.incomplete.slice(0,4).map(t => `<button type="button" class="linkbtn" data-task="${esc(t.id)}">${esc(A.typeLabel(t))} ${esc(t.patientNr || '')}</button>`).join(' ')}</div>` : '';
    body = `${inc}<div class="bill-split${sel ? ' has-sel' : ''}"><div class="ic-list">${list.map(invCard).join('') || `<p class="hint bill-empty">${st === 'concept' ? (c.planner ? 'Geen concepten. Zodra je een opdracht op Klaar zet, staat de factuur hier klaar.' : 'Geen concepten. Maak er een met "+ Nieuwe factuur".') : 'Geen geaccepteerde facturen die nog verstuurd moeten worden.'}</p>`}</div>
      <div class="ie-wrap">${sel ? `<button type="button" class="btn ghost sm ie-back" data-act="back">← Terug naar de lijst</button>${editorHtml(sel)}` : '<p class="hint bill-empty">Kies een factuur.</p>'}</div></div>`;
  }
  view.innerHTML = `<div class="bill">
    <div class="bill-top">
      <label class="bill-cust"><span class="mini">Klant</span><select id="bCust">${S.customers.map(x => `<option value="${esc(x.id)}"${x.id === S.cust ? ' selected' : ''}>${esc(x.short_name || x.company)} (${esc(x.id)})</option>`).join('')}</select></label>
      <div class="seg" id="bTabs" role="tablist">
        ${[['overzicht','Omzet'],['concept',`Concept${n.concept ? ` <i class="cnt">${n.concept}</i>` : ''}`],['geaccepteerd',`Geaccepteerd${n.acc ? ` <i class="cnt">${n.acc}</i>` : ''}`],['verstuurd','Verstuurd']].map(([k,l]) => `<button type="button" data-tab="${k}" aria-pressed="${S.tab === k}">${l}</button>`).join('')}
      </div>
      <span class="spacer"></span>
      <button type="button" class="btn ghost" id="bNew">+ Nieuwe factuur</button>
      <button type="button" class="btn primary" id="bExport"${n.acc ? '' : ' disabled'}>Exporteer betaaloverzicht${n.acc ? ` (${n.acc})` : ''}</button>
    </div>
    <div class="bill-body">${body}</div>
  </div>`;
}
function drawTotalsOnly(){
  const inv = S.invoices.find(i => i.id === S.sel); if (!inv) return;
  const t = totals(inv), tot = view.querySelector('.ie-tot');
  if (tot) tot.innerHTML = `<span>Totaal excl. btw <b>${eur(t.excl)}</b></span>${t.vatTotal ? `<span>Btw <b>${eur(t.vatTotal)}</b></span>` : ''}<span class="big">Totaal <b>${eur(t.incl)}</b></span>`;
  view.querySelectorAll('.il').forEach(el => { const l = inv.lines[+el.dataset.li]; if (l) el.querySelector('.il-sum').textContent = eur(lineIncl(l)); });
  const card = view.querySelector(`.ic[data-inv="${CSS.escape(inv.id)}"] .ic-bot b`); if (card) card.textContent = eur(t.incl);
}

let saveTimer = null;
view.addEventListener('input', e => {
  const el = e.target, li = el.closest('.il'); if (!li) return;
  const inv = S.invoices.find(i => i.id === S.sel); if (!inv) return;
  const l = inv.lines[+li.dataset.li], f = el.dataset.f; if (!l || !f) return;
  if (f === 'qty') l.qty = +el.value || 0;
  else if (f === 'price') l.price = round2(el.value);
  else if (f === 'info') l.info = el.value.split('\n').map(s => s.replace(/\s+$/, '')).filter((s,i,a) => s || i < a.length - 1);
  else l[f] = el.value;
  drawTotalsOnly();
  clearTimeout(saveTimer); saveTimer = setTimeout(() => saveInv(inv).catch(err => toast('Opslaan mislukt: ' + err.message)), 600);
});
view.addEventListener('change', async e => {
  if (e.target.id === 'bCust'){ S.cust = e.target.value; S.sel = null; draw(); return; }
  const inv = S.invoices.find(i => i.id === S.sel);
  if (e.target.matches('[data-act="addline"]') && inv && e.target.value){ addLine(inv, e.target.value); await saveInv(inv); e.target.blur(); draw(); return; }
  if (e.target.matches('select[data-f="vat"]') && inv){ e.target.blur(); await saveInv(inv); draw(); }
});
view.addEventListener('click', async e => {
  const tab = e.target.closest('[data-tab]'); if (tab){ S.tab = tab.dataset.tab; S.sel = null; draw(); return; }
  if (e.target.closest('#bNew')){ newManual(); return; }
  if (e.target.closest('#bExport')){ exportOverview(); return; }
  const card = e.target.closest('[data-inv]'); if (card){ S.sel = card.dataset.inv; draw(); return; }
  const task = e.target.closest('[data-task]'); if (task){ A.showView('planner'); A.openEditor(task.dataset.task); return; }
  const fold = e.target.closest('[data-fold]'); if (fold){ S.open[fold.dataset.fold] = !S.open[fold.dataset.fold]; draw(); return; }
  const oi = e.target.closest('[data-openinv]'); if (oi){ const inv = S.invoices.find(i => i.id === oi.dataset.openinv); if (inv) viewPdf(`Factuur ${inv.number}`, Pdf.invoice(inv, cust(inv.customer_id)), `${inv.number}.pdf`); return; }
  const ovb = e.target.closest('[data-ov]'), zb = e.target.closest('[data-zip]');
  if (ovb || zb){
    const ov = S.overviews.find(o => o.ref === (ovb || zb).dataset[ovb ? 'ov' : 'zip']); if (!ov) return;
    const c = cust(ov.customer_id), list = S.invoices.filter(i => i.payment_ref === ov.ref).sort((a,b) => a.number.localeCompare(b.number));
    if (ovb) viewPdf(`Betaaloverzicht ${ov.ref}`, Pdf.overview(ov, list, c), `Betaaloverzicht ${c.short_name || c.company} ${ov.ref}.pdf`);
    else download(await buildZip(ov, list, c), folderName(ov, c) + '.zip');
    return;
  }
  const act = e.target.closest('[data-act]'); if (!act) return;
  const inv = S.invoices.find(i => i.id === S.sel);
  const a = act.dataset.act;
  if (a === 'back'){ S.sel = null; draw(); return; }
  if (!inv) return;
  if (a === 'pdf') viewPdf(inv.number ? `Factuur ${inv.number}` : 'Conceptfactuur', Pdf.invoice(inv, cust(inv.customer_id)), `${inv.number || 'concept'}.pdf`);
  if (a === 'accept') acceptInv(inv);
  if (a === 'single') exportSingle(inv);
  if (a === 'rebuild') rebuildInv(inv);
  if (a === 'drop') dropInv(inv, act);
  if (a === 'rmline'){ const li = +act.closest('.il').dataset.li; inv.lines.splice(li, 1); await saveInv(inv); draw(); }
});

// PDF-viewer
document.body.insertAdjacentHTML('beforeend', `<dialog id="pdfDlg" class="wide" aria-labelledby="pdfTitle">
  <div class="dlg-head"><h2 id="pdfTitle">PDF</h2><a class="btn ghost sm" id="pdfOpen" target="_blank" rel="noopener">Openen in nieuw tabblad</a><button type="button" class="btn primary sm" id="pdfDl">Downloaden</button>
  <button type="button" class="icon-btn bare" data-close aria-label="Sluiten"><svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3l10 10M13 3 3 13"/></svg></button></div>
  <iframe id="pdfFrame" title="PDF-voorbeeld" class="pdf-frame"></iframe></dialog>`);
F('pdfDlg').addEventListener('click', e => { if (e.target === F('pdfDlg') || e.target.closest('[data-close]')) F('pdfDlg').close(); });

/* ---------- aansluiten op de planner ---------- */
window.addEventListener('lab:view', async e => {
  if (e.detail !== 'billing') return;
  view.innerHTML = '<p class="hint bill-empty">Facturatie laden…</p>';
  await load(true); await syncConcepts(); draw();
});
window.addEventListener('lab:render', () => { if (A.isAdmin()) scheduleSync(); if (!view.hidden && S.tab === 'overzicht') draw(); });
window.addEventListener('lab:ready', () => { if (A.isAdmin()){ S.loaded = false; scheduleSync(); } });
if (A.isAdmin() && !A.ONLINE.url) scheduleSync();
window.Billing = {S, linesForTask, totals, Pdf, syncConcepts, revenue};
})();
