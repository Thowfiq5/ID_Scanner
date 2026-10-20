/* labour.js — UI, OCR queue and Excel export for the Labour Card scanner.
   Field extraction lives in labour-parser.js (LabourParser).
   Re-uses helpers from script.js: extractZip, fileToPages, preprocess, escapeHtml, isPdf, isZip. */
(function () {
  'use strict';

  const LFIELDS = [
    { key: 'name',          label: 'Name',            xl: 'Name',            wch: 36 },
    { key: 'expiry',        label: 'Expiry date',     xl: 'Expiry Date',     wch: 14 },
    { key: 'workPermit',    label: 'Work permit no.', xl: 'Work Permit No',  wch: 16 },
    { key: 'personalNo',    label: 'Personal no.',    xl: 'Personal No',     wch: 18 },
    { key: 'profession',    label: 'Profession',      xl: 'Profession',      wch: 26 },
    { key: 'nationality',   label: 'Nationality',     xl: 'Nationality',     wch: 16 },
    { key: 'establishment', label: 'Establishment',   xl: 'Establishment',   wch: 54 }
  ];

  // Labour cards are printed on a gold background: try thresholds, then plain contrast.
  const LPASSES = [{ t: 90 }, { t: 120 }, { t: 105 }, { contrast: 1.4 }];

  const $ = id => document.getElementById(id);
  const stage = $('lbStage'), stageEmpty = $('lbStageEmpty');
  const actionsEl = $('lbActions'), cancelBtn = $('lbCancelBtn');
  const logHead = $('lbLogHead'), logBody = $('lbLogBody');
  const rowCount = $('lbRowCount'), exportBtn = $('lbExportBtn'), exportHint = $('lbExportHint');
  const queueView = $('lbQueue'), qImg = $('lbQImg'), qText = $('lbQText'), qPct = $('lbQPct'), qFill = $('lbQFill');
  let fileInput = $('lbFileInput');

  const COLS = LFIELDS.length + 3;
  let records = [];
  let seq = 0;
  let processing = false;
  let cancelled = false;

  logHead.innerHTML = '<tr><th>File</th>' + LFIELDS.map(f => `<th>${f.label}</th>`).join('') + '<th>Status</th><th></th></tr>';

  /* ---------- upload handling ---------- */
  stage.addEventListener('click', e => { if (!processing && e.target !== fileInput) fileInput.click(); });
  ['dragover', 'dragenter'].forEach(evt => stage.addEventListener(evt, e => { e.preventDefault(); if (!processing) stage.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(evt => stage.addEventListener(evt, e => { e.preventDefault(); stage.classList.remove('drag'); }));
  stage.addEventListener('drop', e => {
    if (!processing && e.dataTransfer.files.length) handleIncoming(Array.from(e.dataTransfer.files));
  });
  fileInput.addEventListener('change', e => {
    if (e.target.files.length) handleIncoming(Array.from(e.target.files));
    e.target.value = '';
  });
  cancelBtn.addEventListener('click', () => { cancelled = true; cancelBtn.textContent = 'Stopping…'; });

  async function handleIncoming(files) {
    const items = [];
    for (const f of files) {
      if (isZip(f)) items.push(...await extractZip(f));
      else if (isPdf(f) || f.type.startsWith('image/')) items.push(f);
    }
    if (!items.length) return;
    processing = true; cancelled = false;
    cancelBtn.textContent = 'Stop scanning';
    actionsEl.style.display = 'flex';
    stageEmpty.style.display = 'none';
    queueView.style.display = 'block';
    try { await processQueue(items); } finally {
      processing = false;
      queueView.style.display = 'none';
      stageEmpty.style.display = '';
      actionsEl.style.display = 'none';
    }
  }

  const withTimeout = (promise, ms, msg) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });

  // Tesseract reports a failed language download through errorHandler (and otherwise never settles),
  // so a missing/blocked Arabic model must not be allowed to hang the scan.
  function createArabicWorker() {
    let failed;
    const bad = new Promise((_, rej) => { failed = rej; });
    const make = Tesseract.createWorker('ara', 1, { logger: progress, errorHandler: e => failed(e instanceof Error ? e : new Error(String(e))) })
      .then(async w => { await w.setParameters({ tessedit_pageseg_mode: '6' }); return w; });
    return withTimeout(Promise.race([make, bad]), 60000, 'Arabic model download timed out');
  }

  /* ---------- OCR ---------- */
  function progress(m) {
    if (typeof m.progress === 'number') {
      const p = Math.round(m.progress * 100);
      qPct.textContent = p + '%';
      qFill.style.width = p + '%';
    }
  }

  async function processQueue(files) {
    let eng = null, ara = null, arabicFailed = false;
    try {
      eng = await Tesseract.createWorker('eng', 1, { logger: progress });
      await eng.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    } catch (err) { console.error('OCR engine failed to start', err); }

    for (let i = 0; i < files.length; i++) {
      if (cancelled) break;
      const file = files[i];
      const rec = blankRecord('l' + (seq++), file.name);
      records.push(rec); renderLog();
      if (!eng) { rec.status = 'failed'; renderLog(); continue; }

      try {
        const pages = await fileToPages(file);
        qImg.src = pages[0];
        qText.textContent = `Scanning ${i + 1} of ${files.length} — ${file.name}`;
        qPct.textContent = '0%'; qFill.style.width = '0%';

        let acc = {}, bestImg = null;
        for (const page of pages) {
          for (const pass of LPASSES) {
            const img = await preprocess(page, pass);
            const { data } = await eng.recognize(img);
            acc = LabourParser.mergeFields(acc, LabourParser.parseLabour(data.text || ''));
            bestImg = img;
            if (LabourParser.coreComplete(acc)) break;
          }
          if (LabourParser.coreComplete(acc)) break;     // one card per file
        }

        // Profession / Nationality are normally Arabic-only on this card -> Arabic pass.
        if ((!acc.profession || !acc.nationality) && bestImg && !cancelled && !arabicFailed) {
          try {
            if (!ara) {
              qText.textContent = `Reading Arabic text — ${file.name}`;
              ara = await createArabicWorker();
            }
            const { data } = await withTimeout(ara.recognize(bestImg), 90000, 'Arabic OCR timed out');
            const arf = LabourParser.parseArabicLines(data.text || '');
            if (!acc.profession && arf.profession) acc.profession = arf.profession;
            if (!acc.nationality && arf.nationality) acc.nationality = LabourParser.nationalityToEnglish(arf.nationality);
          } catch (err) {
            console.error('Arabic OCR unavailable — keeping English results', err);
            arabicFailed = true; ara = null;
          }
        }

        LFIELDS.forEach(f => { rec[f.key] = acc[f.key] || ''; });
        const any = LFIELDS.some(f => rec[f.key]);
        rec.status = coreOk(rec) ? 'ok' : (any ? 'partial' : 'failed');
      } catch (err) {
        console.error('Scan failed', err);
        rec.status = 'failed';
      }
      renderLog();
    }
    for (const w of [eng, ara]) if (w) { try { await w.terminate(); } catch (e) {} }
  }

  const coreOk = r => !!(r.name && r.expiry && r.workPermit && r.personalNo && r.establishment);

  /* ---------- records / table ---------- */
  function blankRecord(id, file) {
    const r = { id, file, status: 'pending' };
    LFIELDS.forEach(f => r[f.key] = '');
    return r;
  }

  function renderLog() {
    if (!records.length) {
      logBody.innerHTML = `<tr class="empty-row"><td colspan="${COLS}">No records yet — upload labour card images or PDFs above to begin.</td></tr>`;
      exportBtn.disabled = true;
      exportHint.textContent = 'Add at least one record to export.';
    } else {
      logBody.innerHTML = records.map(r => {
        const label = r.status === 'pending' ? 'Scanning…' : r.status === 'ok' ? 'Complete' : r.status === 'partial' ? 'Check fields' : 'Failed';
        const cells = LFIELDS.map(f =>
          `<td><input type="text" dir="auto" class="${r[f.key] ? '' : 'not-found'}" value="${escapeHtml(r[f.key])}" placeholder="Not detected" data-id="${r.id}" data-field="${f.key}" style="min-width:${Math.max(90, f.wch * 8)}px"></td>`
        ).join('');
        return `<tr>
          <td class="file" title="${escapeHtml(r.file)}">${escapeHtml(r.file)}</td>
          ${cells}
          <td class="status-cell ${r.status === 'ok' ? 'ok' : 'pending'}">${label}</td>
          <td class="rm" data-rm="${r.id}">Remove</td>
        </tr>`;
      }).join('');
      exportBtn.disabled = false;
      exportHint.textContent = 'Ready to export.';
    }
    rowCount.textContent = records.length + (records.length === 1 ? ' record' : ' records');

    logBody.querySelectorAll('input').forEach(inp => inp.addEventListener('input', () => {
      const rec = records.find(r => r.id === inp.dataset.id);
      if (rec) { rec[inp.dataset.field] = inp.value; inp.classList.toggle('not-found', !inp.value); }
    }));
    logBody.querySelectorAll('[data-rm]').forEach(el => el.addEventListener('click', () => {
      records = records.filter(r => r.id !== el.dataset.rm);
      renderLog();
    }));
  }

  /* ---------- Excel export ---------- */
  exportBtn.addEventListener('click', () => {
    const data = records.map(r => {
      const row = { 'File Name': r.file };
      LFIELDS.forEach(f => { row[f.xl] = r[f.key] || ''; });
      return row;
    });
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = [{ wch: 28 }].concat(LFIELDS.map(f => ({ wch: f.wch })));
    // keep long numbers as text so Excel does not turn them into 1.00E+13
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let R = 1; R <= range.e.r; R++) {
      [3, 4].forEach(C => {                      // Work Permit No, Personal No columns
        const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
        if (cell) { cell.t = 's'; cell.v = String(cell.v); }
      });
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Labour Card Results');
    XLSX.writeFile(wb, 'labour_card_results.xlsx');
  });

  renderLog();
})();
