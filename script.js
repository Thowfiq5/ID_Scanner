/* script.js — UI, OCR queue and Excel export.
   Field extraction logic lives in parser.js (EidParser). */

// One entry per column: key = parser field, label = table header, xl = Excel header
const FIELDS = [
  { key: 'idNumber',    label: 'ID number',     xl: 'ID Number',     wch: 22 },
  { key: 'cardNo',      label: 'Card number',   xl: 'Card Number',   wch: 14 },
  { key: 'name',        label: 'Name',          xl: 'Name',          wch: 28 },
  { key: 'dob',         label: 'Date of birth', xl: 'Date of Birth', wch: 14 },
  { key: 'sex',         label: 'Sex',           xl: 'Sex',           wch: 9  },
  { key: 'nationality', label: 'Nationality',   xl: 'Nationality',   wch: 16 },
  { key: 'issue',       label: 'Issue date',    xl: 'Issue Date',    wch: 13 },
  { key: 'expiry',      label: 'Expiry date',   xl: 'Expiry Date',   wch: 13 },
  { key: 'occupation',  label: 'Occupation',    xl: 'Occupation',    wch: 20 },
  { key: 'employer',    label: 'Employer',      xl: 'Employer',      wch: 48 },
  { key: 'place',       label: 'Issuing place', xl: 'Issuing Place', wch: 16 }
];

// OCR passes, tried in order until the page is read completely.
// Printed IDs sit on a busy security-pattern background; thresholding keeps
// only the dark printed text, which Tesseract reads far better.
const PASSES = [{ t: 90 }, { t: 120 }, { contrast: 1.4 }];

const stage = document.getElementById('stage');
const stageEmpty = document.getElementById('stageEmpty');
let fileInput = document.getElementById('fileInput');
const actionsEl = document.getElementById('actions');
const cancelBtn = document.getElementById('cancelBtn');
const logHead = document.getElementById('logHead');
const logBody = document.getElementById('logBody');
const rowCount = document.getElementById('rowCount');
const exportBtn = document.getElementById('exportBtn');
const exportHint = document.getElementById('exportHint');

const COLS = FIELDS.length + 3; // file + fields + status + remove

let records = [];
let recIdSeq = 0;
let processing = false;

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

logHead.innerHTML = '<tr><th>File</th>' + FIELDS.map(f => `<th>${f.label}</th>`).join('') + '<th>Status</th><th></th></tr>';

/* ---------- upload handling ---------- */
stage.addEventListener('click', () => { if (!processing) fileInput.click(); });
['dragover', 'dragenter'].forEach(evt => stage.addEventListener(evt, e => { e.preventDefault(); if (!processing) stage.classList.add('drag'); }));
['dragleave', 'drop'].forEach(evt => stage.addEventListener(evt, e => { e.preventDefault(); stage.classList.remove('drag'); }));
stage.addEventListener('drop', e => {
  if (processing) return;
  if (e.dataTransfer.files.length) handleIncoming(Array.from(e.dataTransfer.files));
});
fileInput.addEventListener('change', e => {
  if (e.target.files.length) handleIncoming(Array.from(e.target.files));
});

cancelBtn.addEventListener('click', () => {
  processing = false;
  resetStageToIdle();
});

const isPdf = f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
const isZip = f => f.type === 'application/zip' || f.name.toLowerCase().endsWith('.zip');

async function handleIncoming(files) {
  const items = [];
  for (const f of files) {
    if (isZip(f)) items.push(...await extractZip(f));
    else if (isPdf(f) || f.type.startsWith('image/')) items.push(f);
  }
  if (!items.length) return;
  processing = true;
  actionsEl.style.display = 'flex';
  await processQueue(items);
  processing = false;
  resetStageToIdle();
}

async function extractZip(zipFile) {
  const out = [];
  try {
    const zip = await JSZip.loadAsync(zipFile);
    const entries = Object.values(zip.files).filter(e => !e.dir && /\.(jpe?g|png|bmp|webp|gif|tiff?|pdf)$/i.test(e.name) && !e.name.startsWith('__MACOSX'));
    for (const entry of entries) {
      const blob = await entry.async('blob');
      const name = entry.name.split('/').pop();
      const type = /\.pdf$/i.test(name) ? 'application/pdf' : (blob.type || 'image/jpeg');
      out.push(new File([blob], name, { type }));
    }
  } catch (err) {
    console.error('ZIP read failed', err);
  }
  return out;
}

/* ---------- file -> page images ---------- */
function fileToDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.readAsDataURL(file);
  });
}

async function pdfToPages(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let p = 1; p <= Math.min(pdf.numPages, 4); p++) {   // EID = front + back
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 3 });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width; canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    pages.push(canvas.toDataURL('image/png'));
  }
  return pages;
}

async function fileToPages(file) {
  return isPdf(file) ? pdfToPages(file) : [await fileToDataUrl(file)];
}

function preprocess(dataUrl, pass) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(2200 / Math.max(img.width, img.height), 2.5);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = imageData.data;
      for (let i = 0; i < d.length; i += 4) {
        const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        let v;
        if (pass.t) v = gray > pass.t ? 255 : 0;
        else v = Math.max(0, Math.min(255, (gray - 128) * (pass.contrast || 1.4) + 128));
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/* ---------- OCR queue ---------- */
async function processQueue(files) {
  let worker = null;
  try {
    worker = await Tesseract.createWorker('eng', 1, { logger: updateScanStatus });
    await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
  } catch (err) {
    console.error('OCR engine failed to start', err);
  }

  for (let i = 0; i < files.length; i++) {
    if (!processing) break;
    const file = files[i];
    const recId = 'r' + (recIdSeq++);
    addPendingRow(recId, file.name);

    if (!worker) { failRecord(recId); continue; }
    try {
      const pages = await fileToPages(file);
      renderQueuePreview(pages[0], file.name, i + 1, files.length);

      let acc = {};
      for (const page of pages) {
        let pageFields = {};
        for (const pass of PASSES) {
          const img = await preprocess(page, pass);
          const { data } = await worker.recognize(img);
          pageFields = EidParser.mergeFields(pageFields, EidParser.parseEid(data.text || ''));
          if (EidParser.pageComplete(pageFields)) break;
        }
        acc = EidParser.mergeFields(acc, pageFields);
      }
      finalizeRecord(recId, acc);
    } catch (err) {
      console.error('Scan failed', err);
      failRecord(recId);
    }
  }
  if (worker) { try { await worker.terminate(); } catch (e) {} }
}

function renderQueuePreview(dataUrl, name, idx, total) {
  stage.innerHTML = `
    <div class="queue-view">
      <div class="queue-preview scanning" id="qPreview">
        <img src="${dataUrl}">
        <div class="scanline"></div>
      </div>
      <div class="status-bar">
        <div class="status-row"><span>Scanning ${idx} of ${total} — ${escapeHtml(name)}</span><span class="val" id="statusPct">0%</span></div>
        <div class="progress-track"><div class="progress-fill" id="progressFill"></div></div>
      </div>
    </div>`;
}

function updateScanStatus(m) {
  const pct = document.getElementById('statusPct');
  const fill = document.getElementById('progressFill');
  if (typeof m.progress === 'number') {
    const p = Math.round(m.progress * 100);
    if (pct) pct.textContent = p + '%';
    if (fill) fill.style.width = p + '%';
  }
}

function resetStageToIdle() {
  stage.innerHTML = '';
  stage.appendChild(stageEmpty);
  const newInput = document.createElement('input');
  newInput.type = 'file'; newInput.id = 'fileInput'; newInput.accept = 'image/*,.pdf,.zip'; newInput.multiple = true; newInput.style.display = 'none';
  newInput.addEventListener('change', e => { if (e.target.files.length) handleIncoming(Array.from(e.target.files)); });
  stage.appendChild(newInput);
  fileInput = newInput;
  actionsEl.style.display = 'none';
}

/* ---------- records ---------- */
function blankRecord(recId, fileName) {
  const r = { id: recId, file: fileName, status: 'pending' };
  FIELDS.forEach(f => r[f.key] = '');
  return r;
}

function addPendingRow(recId, fileName) {
  records.push(blankRecord(recId, fileName));
  renderLog();
}

const coreComplete = r => !!(r.idNumber && r.name && r.dob && r.issue && r.expiry);
const idKey = r => (r.idNumber || '').replace(/\D/g, '');

function failRecord(recId) {
  const rec = records.find(r => r.id === recId);
  if (rec) { rec.status = 'failed'; renderLog(); }
}

function finalizeRecord(recId, fields) {
  const rec = records.find(r => r.id === recId);
  if (!rec) return;
  FIELDS.forEach(f => { rec[f.key] = fields[f.key] || ''; });
  const any = FIELDS.some(f => rec[f.key]);
  rec.status = coreComplete(rec) ? 'ok' : (any ? 'partial' : 'failed');

  // Front and back scanned as separate files? Merge them into one row by ID number.
  const key = idKey(rec);
  if (key) {
    const other = records.find(r => r !== rec && r.status !== 'pending' && idKey(r) === key);
    if (other) {
      FIELDS.forEach(f => { if (!other[f.key] && rec[f.key]) other[f.key] = rec[f.key]; });
      other.file += ', ' + rec.file;
      other.status = coreComplete(other) ? 'ok' : 'partial';
      records = records.filter(r => r !== rec);
    }
  }
  renderLog();
}

function renderLog() {
  if (!records.length) {
    logBody.innerHTML = `<tr class="empty-row"><td colspan="${COLS}">No records yet — upload ID images or PDFs above to begin.</td></tr>`;
    exportBtn.disabled = true;
    exportHint.textContent = 'Add at least one record to export.';
  } else {
    logBody.innerHTML = records.map((r) => {
      const statusLabel = r.status === 'pending' ? 'Scanning…' : r.status === 'ok' ? 'Complete' : r.status === 'partial' ? 'Check fields' : 'Failed';
      const statusClass = r.status === 'ok' ? 'ok' : 'pending';
      const cells = FIELDS.map(f =>
        `<td><input type="text" class="${r[f.key] ? '' : 'not-found'}" value="${escapeHtml(r[f.key])}" placeholder="Not detected" data-id="${r.id}" data-field="${f.key}" style="min-width:${Math.max(90, f.wch * 8)}px"></td>`
      ).join('');
      return `
      <tr>
        <td class="file" title="${escapeHtml(r.file)}">${escapeHtml(r.file)}</td>
        ${cells}
        <td class="status-cell ${statusClass}">${statusLabel}</td>
        <td class="rm" data-rm="${r.id}">Remove</td>
      </tr>`;
    }).join('');
    exportBtn.disabled = false;
    exportHint.textContent = 'Ready to export.';
  }
  rowCount.textContent = records.length + (records.length === 1 ? ' record' : ' records');

  logBody.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', () => {
      const rec = records.find(r => r.id === inp.dataset.id);
      if (rec) {
        rec[inp.dataset.field] = inp.value;
        inp.classList.toggle('not-found', !inp.value);
      }
    });
  });
  logBody.querySelectorAll('[data-rm]').forEach(el => {
    el.addEventListener('click', () => {
      records = records.filter(r => r.id !== el.dataset.rm);
      renderLog();
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Excel export ---------- */
exportBtn.addEventListener('click', () => {
  const data = records.map(r => {
    const row = { 'File Name': r.file };
    FIELDS.forEach(f => { row[f.xl] = r[f.key] || 'NOT FOUND'; });
    return row;
  });
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [{ wch: 28 }].concat(FIELDS.map(f => ({ wch: f.wch })));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'ID Extraction Results');
  XLSX.writeFile(wb, 'id_extraction_results.xlsx');
});

renderLog();
