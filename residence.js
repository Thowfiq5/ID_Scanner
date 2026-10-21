/* residence.js — UI, OCR queue and Excel export for the Residence (visa) card scanner.
   Field extraction lives in residence-parser.js (ResidenceParser).
   Re-uses helpers from script.js: extractZip, fileToPages, preprocess, escapeHtml, isPdf, isZip. */
(function () {
  'use strict';

  const RFIELDS = [
    { key: 'idNumber',   label: 'ID number',      xl: 'ID Number',      wch: 14 },
    { key: 'fileNo',     label: 'File',           xl: 'File',           wch: 20 },
    { key: 'passport',   label: 'Passport no.',   xl: 'Passport No',    wch: 14 },
    { key: 'name',       label: 'Name',           xl: 'Name',           wch: 52 },
    { key: 'profession', label: 'Profession',     xl: 'Profession',     wch: 24 },
    { key: 'employer',   label: 'Employer',       xl: 'Employer',       wch: 70 },
    { key: 'issue',      label: 'Issue date',     xl: 'Issue Date',     wch: 13 },
    { key: 'expiry',     label: 'Expiry date',    xl: 'Expiry Date',    wch: 13 },
    { key: 'place',      label: 'Place of issue', xl: 'Place of Issue', wch: 15 }
  ];
  const TEXT_COLS = [1, 2, 3, 7, 8];     // Excel columns kept as text: ID, File, Passport, dates (col 0 = File Name)

  // The residence card has a pink security background: thresholding destroys it, so
  // plain contrast boosts come first and a threshold pass is only a last resort.
  const RPASSES = [{ contrast: 1.4 }, { contrast: 1.0 }, { contrast: 1.8 }, { t: 120 }];
  const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  const $ = id => document.getElementById(id);
  const stage = $('rsStage'), stageEmpty = $('rsStageEmpty');
  const actionsEl = $('rsActions'), cancelBtn = $('rsCancelBtn');
  const logHead = $('rsLogHead'), logBody = $('rsLogBody');
  const rowCount = $('rsRowCount'), exportBtn = $('rsExportBtn'), exportHint = $('rsExportHint');
  const queueView = $('rsQueue'), qImg = $('rsQImg'), qText = $('rsQText'), qPct = $('rsQPct'), qFill = $('rsQFill');
  const fileInput = $('rsFileInput');

  const COLS = RFIELDS.length + 3;
  let records = [];
  let seq = 0;
  let processing = false;
  let cancelled = false;

  logHead.innerHTML = '<tr><th>File</th>' + RFIELDS.map(f => `<th>${f.label}</th>`).join('') + '<th>Status</th><th></th></tr>';

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

  /* ---------- OCR ---------- */
  function progress(m) {
    if (typeof m.progress === 'number') {
      const p = Math.round(m.progress * 100);
      qPct.textContent = p + '%';
      qFill.style.width = p + '%';
    }
  }

  const loadImg = src => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });

  // The passport's leading letter ("T6830773") is often read as a digit. Re-read just that
  // token from a cropped, enlarged copy with a letters+digits whitelist.
  async function rereadPassport(worker, hit) {
    try {
      const w = (hit.words || []).find(x => x.text && x.text.includes(hit.guess));
      const img = await loadImg(hit.img);
      if (!w || !img) return '';
      const padX = 14, padY = 8, k = 3;
      const x0 = Math.max(0, w.bbox.x0 - padX), y0 = Math.max(0, w.bbox.y0 - padY);
      const x1 = Math.min(img.width, w.bbox.x1 + padX), y1 = Math.min(img.height, w.bbox.y1 + padY);
      const c = document.createElement('canvas');
      c.width = (x1 - x0) * k; c.height = (y1 - y0) * k;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
      await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: ALNUM });
      const { data } = await worker.recognize(c.toDataURL('image/png'));
      const t = (data.text || '').replace(/[^A-Z0-9]/g, '');
      return /^[A-Z]\d{7}$/.test(t) ? t : '';
    } catch (err) {
      console.error('Passport re-read failed', err);
      return '';
    } finally {
      try { await worker.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' }); } catch (e) {}
    }
  }

  // Unsure words at the start of a line are almost always fragments of the neighbouring Arabic
  // text ("AT", "AN", "P" …). Rebuild the text without them, keeping a marker for emptied lines
  // so the Name / Profession / Employer blocks stay separated.
  function confidentText(data) {
    if (!data.lines || !data.lines.length) return '';
    return data.lines.map(l => {
      const words = l.words || [];
      if (!words.length) return '';
      // trim unsure words from the START of the line only. Trailing junk is handled by the parser,
      // and trimming the end by confidence would also cut real words ("L L C - DUBAI").
      let a = 0;
      while (a < words.length && words[a].confidence < 45) a++;
      return a < words.length ? words.slice(a).map(w => w.text).join(' ') : '·';
    }).join('\n');
  }

  async function processQueue(files) {
    let worker = null;
    try {
      worker = await Tesseract.createWorker('eng', 1, { logger: progress });
      await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    } catch (err) { console.error('OCR engine failed to start', err); }

    for (let i = 0; i < files.length; i++) {
      if (cancelled) break;
      const file = files[i];
      const rec = blankRecord('s' + (seq++), file.name);
      records.push(rec); renderLog();
      if (!worker) { rec.status = 'failed'; renderLog(); continue; }

      try {
        const pages = await fileToPages(file);
        qImg.src = pages[0];
        qText.textContent = `Scanning ${i + 1} of ${files.length} — ${file.name}`;
        qPct.textContent = '0%'; qFill.style.width = '0%';

        let acc = {}, hit = null;
        for (const page of pages) {
          for (const pass of RPASSES) {
            if (cancelled) break;
            const img = await preprocess(page, pass);
            const { data } = await worker.recognize(img);
            const f = ResidenceParser.parseResidence(data.text || '');
            if (f.passportGuess && !hit) hit = { img, words: data.words, guess: f.passportGuess };
            const ct = confidentText(data);
            if (ct) acc = ResidenceParser.mergeFields(acc, ResidenceParser.parseResidence(ct));   // cleaner reading first
            acc = ResidenceParser.mergeFields(acc, f);
            if (ResidenceParser.pageComplete(acc)) break;
          }
          if (acc.idNumber || acc.fileNo) break;      // one card per file; ignore the blank back page
        }

        if (!/^[A-Z]\d{7}$/.test(acc.passport || '') && hit && !cancelled) {
          const fixed = await rereadPassport(worker, hit);
          if (fixed) acc.passport = fixed;
        }

        const out = ResidenceParser.finalize(acc);
        RFIELDS.forEach(f => { rec[f.key] = out[f.key] || ''; });
        const any = RFIELDS.some(f => rec[f.key]);
        rec.status = coreOk(rec) ? 'ok' : (any ? 'partial' : 'failed');
      } catch (err) {
        console.error('Scan failed', err);
        rec.status = 'failed';
      }
      renderLog();
    }
    if (worker) { try { await worker.terminate(); } catch (e) {} }
  }

  const coreOk = r => !!(r.idNumber && r.fileNo && /^[A-Z]\d{7}$/.test(r.passport) && r.name && r.profession && r.employer && r.issue && r.expiry);

  /* ---------- records / table ---------- */
  function blankRecord(id, file) {
    const r = { id, file, status: 'pending' };
    RFIELDS.forEach(f => r[f.key] = '');
    return r;
  }

  function renderLog() {
    if (!records.length) {
      logBody.innerHTML = `<tr class="empty-row"><td colspan="${COLS}">No records yet — upload residence card images or PDFs above to begin.</td></tr>`;
      exportBtn.disabled = true;
      exportHint.textContent = 'Add at least one record to export.';
    } else {
      logBody.innerHTML = records.map(r => {
        const label = r.status === 'pending' ? 'Scanning…' : r.status === 'ok' ? 'Complete' : r.status === 'partial' ? 'Check fields' : 'Failed';
        const cells = RFIELDS.map(f =>
          `<td><input type="text" class="${r[f.key] ? '' : 'not-found'}" value="${escapeHtml(r[f.key])}" placeholder="Not detected" data-id="${r.id}" data-field="${f.key}" style="min-width:${Math.max(90, f.wch * 8)}px"></td>`
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
      RFIELDS.forEach(f => { row[f.xl] = r[f.key] || ''; });
      return row;
    });
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = [{ wch: 28 }].concat(RFIELDS.map(f => ({ wch: f.wch })));
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let R = 1; R <= range.e.r; R++) {
      TEXT_COLS.forEach(C => {                  // keep numbers / dates exactly as printed on the card
        const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
        if (cell) { cell.t = 's'; cell.v = String(cell.v); }
      });
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Residence Results');
    XLSX.writeFile(wb, 'residence_card_results.xlsx');
  });

  renderLog();
})();
