/* residence-parser.js — turns raw OCR text of a UAE Residence (visa) card into fields.
   Pure functions only, so it can be tested in Node without a browser.

   On this card the English labels are printed *under* their values and are often
   lost in OCR, so fields are found by their shape (9-digit ID, 3/4/7 file number,
   passport number, yyyy/mm/dd dates) and by order: after the passport number come
   three blocks of capital letters — Name, Profession, Employer — each separated
   by an Arabic line. */
(function (root) {
  'use strict';

  const AR_RE = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g;
  const LABELS = /\b(?:ID\s*Number|Passport\s*No|Place\s*of\s*Issue|Expiry\s*Date|Issue\s*Date|Name|Profession|Employer|File|Sign)\b\.?/g;   // Title-case only: values are UPPER-case
  const PLACE_RE = /\b(Abu\s?Dhabi|Dubai|Sharjah|Ajman|Umm\s?Al\s?Quwain|Ras\s?Al\s?Khaimah|Fujairah|Dub[a-z]{1,2})\b/;
  const CAP_TOKEN = /^-?[A-Z][A-Z.'&\-\/()]*$|^[&-]$/;

  const pad = n => String(n).padStart(2, '0');

  function validDate(y, m, d) {
    y = +y; m = +m; d = +d;
    if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, m - 1, d);
    return dt.getMonth() === m - 1 ? dt : null;
  }

  function allDates(text) {
    const out = [];
    for (const m of text.matchAll(/(20\d{2})\s?[\/:\-.\s]\s?(\d{2})\s?[\/:\-.\s]\s?(\d{2})(?!\d)/g)) {
      const dt = validDate(m[1], m[2], m[3]);
      if (dt) out.push({ s: m[1] + '/' + pad(m[2]) + '/' + pad(m[3]), dt, line: text.slice(0, m.index).split('\n').length - 1 });
    }
    return out;
  }

  // Longest run of consecutive CAPITAL-LETTER tokens in a line (junk like "ater", "Nake yes" breaks a run)
  function bestCapRun(line) {
    const toks = line.replace(/[;:|*+_{}\[\]<>~"]+/g, ' ').split(/\s+/).filter(Boolean);
    let best = '', bestLetters = 0, cur = [];
    const letterCount = t => t.replace(/[^A-Z]/g, '').length;
    const flush = () => {
      // trailing 1–2 letter noise ("AT", "AN") from neighbouring Arabic text; keep real endings like "L L C" / "CO"
      while (cur.length > 1 && letterCount(cur[cur.length - 1]) <= 2 &&
             !/^(CO|LC|LLC|FZE|FZC|&)$/.test(cur[cur.length - 1]) && !/^LL?$/.test(cur[cur.length - 2]) && cur[cur.length - 1] !== '-') cur.pop();
      if (cur.length) {
        const letters = cur.join('').replace(/[^A-Z]/g, '').length;
        const longest = Math.max(...cur.map(t => t.replace(/[^A-Z]/g, '').length));
        if (letters > bestLetters && longest >= 3 && letters >= 4) { best = cur.join(' '); bestLetters = letters; }
      }
      cur = [];
    };
    for (const t of toks) { if (CAP_TOKEN.test(t)) cur.push(t); else flush(); }
    flush();
    return best.replace(/(^|\s)-(?=[A-Z])/g, '$1- ').replace(/\s+/g, ' ').trim();
  }

  function parseResidence(raw) {
    const text = (raw || '').replace(AR_RE, ' ');
    const lines = text.split('\n');
    const out = {};

    // ---- numbers (shape based) ----
    let anchor = -1;
    const mark = i => { if (i > anchor) anchor = i; };

    for (let i = 0; i < lines.length; i++) {
      const f = lines[i].match(/(?<!\d)(\d{3})\s?[\/:;|]\s?(\d{4})\s?[\/:;|]\s?(\d{6,8})(?!\d)/);
      if (f && !out.fileNo) { out.fileNo = f[1] + '/' + f[2] + '/' + f[3]; mark(i); }
      const p = lines[i].match(/\b([A-Z]\d{7})\b/);
      if (p && !out.passport) { out.passport = p[1]; mark(i); }
      const n = lines[i].match(/(?<![\d\/:])(\d{9})(?![\d\/:])/);
      if (n && !out.idNumber) { out.idNumber = n[1]; mark(i); }
    }
    if (!out.passport) {          // OCR often turns the leading letter into a digit/other glyph: keep the 8-char token as a hint
      for (let i = 0; i < lines.length; i++) {
        const p = lines[i].match(/(?<![\w\/])([A-Z0-9]\d{7})(?![\w\/])/);
        if (p && p[1] !== (out.idNumber || '')) { out.passportGuess = p[1]; mark(i); break; }
      }
    }

    // ---- dates: earlier = issue, later = expiry ----
    const ds = allDates(text);
    const uniq = [];
    for (const d of ds) if (!uniq.some(u => u.s === d.s)) uniq.push(d);
    uniq.sort((a, b) => a.dt - b.dt);
    if (uniq.length >= 2) { out.issue = uniq[0].s; out.expiry = uniq[uniq.length - 1].s; }
    else if (uniq.length === 1) { if (uniq[0].dt >= new Date()) out.expiry = uniq[0].s; else out.issue = uniq[0].s; }

    // ---- place of issue ----
    const pm = text.match(PLACE_RE);
    if (pm) out.place = /^Dub/.test(pm[1]) ? 'Dubai' : pm[1].replace(/\s+/g, ' ');

    // ---- Name / Profession / Employer: capital-letter blocks after the anchor ----
    const firstDateLine = ds.length ? Math.min(...ds.map(d => d.line)) : lines.length;
    const end = firstDateLine > anchor ? firstDateLine : lines.length;
    const groups = [];
    let open = false;
    for (let i = anchor + 1; i < end; i++) {
      const ln = lines[i].replace(LABELS, ' ');
      if (/UNITED\s+ARAB|RESIDENCE/.test(ln)) { open = false; continue; }
      const run = bestCapRun(ln);
      if (run) {
        if (open) groups[groups.length - 1].push(run); else groups.push([run]);
        open = true;
      } else if (ln.trim()) open = false;     // an Arabic/garbage line separates blocks
    }
    out._groups = groups.length;
    // a lone leading letter ("P MECHANIC ASSISTANT") is noise from the Arabic line next to it
    const dropLead = v => v.replace(/^[A-Z]\s+(?=[A-Z]{2})/, '');
    if (groups.length >= 3) {
      out.name = groups[0].join(' ');
      out.profession = dropLead(groups[1].join(' '));
      out.employer = dropLead(groups.slice(2).map(g => g.join(' ')).join(' '));
    } else if (groups.length === 2) {
      out.name = groups[0].join(' ');
      out.employer = dropLead(groups[1].join(' '));          // profession block was merged/lost
    } else if (groups.length === 1) {
      out.name = groups[0].join(' ');
    }
    return out;
  }

  const FIELD_KEYS = ['idNumber', 'fileNo', 'passport', 'name', 'profession', 'employer', 'issue', 'expiry', 'place'];
  const PASSPORT_OK = /^[A-Z]\d{7}$/;

  // Fill blanks of a from b; a clean 3-block reading wins for the text blocks; a well-formed passport wins.
  function mergeFields(a, b) {
    const out = Object.assign({}, a);
    for (const k of FIELD_KEYS) if (!out[k] && b[k]) out[k] = b[k];
    if (b._groups >= 3 && !(a._groups >= 3)) {
      ['name', 'profession', 'employer'].forEach(k => { if (b[k]) out[k] = b[k]; });
    }
    out._groups = Math.max(a._groups || 0, b._groups || 0);
    if (!PASSPORT_OK.test(out.passport || '') && PASSPORT_OK.test(b.passport || '')) out.passport = b.passport;
    if (!out.passport && (a.passportGuess || b.passportGuess)) out.passportGuess = a.passportGuess || b.passportGuess;
    return out;
  }

  // Enough to stop trying further OCR passes
  function pageComplete(f) {
    return !!(f.idNumber && f.fileNo && PASSPORT_OK.test(f.passport || '') && f._groups >= 3 &&
              f.name && f.profession && f.employer && f.issue && f.expiry && f.place);
  }

  // Use the guessed passport only when no well-formed one was found
  function finalize(f) {
    const o = Object.assign({}, f);
    if (!o.passport && o.passportGuess) o.passport = o.passportGuess;
    delete o.passportGuess; delete o._groups;
    return o;
  }

  const api = { parseResidence, mergeFields, pageComplete, finalize, FIELD_KEYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ResidenceParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
