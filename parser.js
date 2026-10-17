/* parser.js — turns raw OCR text of a UAE Emirates ID (front and/or back)
   into separate fields. Pure functions only, so it can be tested without a browser.

   Strategy: the 3 machine-readable lines (MRZ) on the back are read very
   reliably and carry check digits, so they are used to validate/override the
   label-based reading of the printed text. */
(function (root) {
  'use strict';

  const DATE_G = /(\d{1,2})\s?[\/\-.]\s?(\d{1,2})\s?[\/\-.]\s?(\d{4})/g;

  const NATIONALITY_CODES = {
    IND: 'India', PAK: 'Pakistan', BGD: 'Bangladesh', LKA: 'Sri Lanka', NPL: 'Nepal',
    PHL: 'Philippines', EGY: 'Egypt', JOR: 'Jordan', SYR: 'Syria', LBN: 'Lebanon',
    SDN: 'Sudan', YEM: 'Yemen', IRN: 'Iran', IRQ: 'Iraq', AFG: 'Afghanistan',
    KEN: 'Kenya', UGA: 'Uganda', ETH: 'Ethiopia', NGA: 'Nigeria', GHA: 'Ghana',
    GBR: 'United Kingdom', USA: 'United States', CAN: 'Canada', AUS: 'Australia',
    IDN: 'Indonesia', MYS: 'Malaysia', THA: 'Thailand', CHN: 'China', RUS: 'Russia',
    MAR: 'Morocco', TUN: 'Tunisia', DZA: 'Algeria', PSE: 'Palestine', SAU: 'Saudi Arabia',
    OMN: 'Oman', KWT: 'Kuwait', BHR: 'Bahrain', QAT: 'Qatar', ARE: 'United Arab Emirates'
  };

  const EMIRATES_RE = /\b(Abu\s*Dhabi|Dubai|Sharjah|Ajman|Umm\s*Al\s*Quwain|Ras\s*Al\s*Khaimah|Fujairah|Al\s*Ain)\b/i;

  // ---------- small helpers ----------
  function cleanOcrText(t) {
    // Arabic glyphs only add noise next to the English fields.
    return (t || '').replace(/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g, ' ');
  }
  const pad = n => String(n).padStart(2, '0');
  function validDate(d, m, y) {
    d = +d; m = +m; y = +y;
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
    const dt = new Date(y, m - 1, d);
    return dt.getMonth() === m - 1 ? dt : null;
  }
  const fmtDate = (d, m, y) => pad(d) + '/' + pad(m) + '/' + y;

  function allDates(text) {
    const out = [];
    for (const m of text.matchAll(DATE_G)) {
      const dt = validDate(m[1], m[2], m[3]);
      if (dt) out.push({ s: fmtDate(m[1], m[2], m[3]), dt });
    }
    return out;
  }

  // First date on the label's own line (after the label) or on the next line.
  function dateAfterLabel(lines, labelRe) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(labelRe);
      if (!m) continue;
      const win = lines[i].slice(m.index + m[0].length) + ' \n ' + (lines[i + 1] || '');
      const ds = allDates(win);
      if (ds.length) return ds[0].s;
    }
    return '';
  }

  function valueAfterLabel(lines, labelRe) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(labelRe);
      if (m) return lines[i].slice(m.index + m[0].length);
    }
    return null;
  }

  // Keep the leading UPPERCASE words (occupation / employer are printed in caps)
  function leadingUpper(v) {
    if (v == null) return '';
    const toks = v.replace(/[:;|_]/g, ' ').split(/\s+/).filter(Boolean);
    const keep = [];
    for (const t of toks) {
      if (/^[A-Z0-9&.,()\/'-]+$/.test(t)) keep.push(t); else break;
    }
    while (keep.length > 1 && keep[keep.length - 1].length === 1 && keep[keep.length - 1] !== '&') keep.pop();
    return keep.join(' ');
  }

  // Keep the leading Capitalised words (names)
  function leadingCapital(v) {
    if (v == null) return '';
    let s = v.replace(/[:;|_]/g, ' ').trim();
    if (s && !/\s/.test(s.split(/[^A-Za-z'.-]/)[0] || '')) {
      // no spaces in the first run -> OCR glued the words, split on camelCase
      s = s.replace(/([a-z])([A-Z])/g, '$1 $2');
    }
    const toks = s.split(/\s+/).filter(Boolean);
    const keep = [];
    for (const t of toks) {
      if (/^[A-Z][A-Za-z'.-]*$/.test(t)) keep.push(t); else break;
    }
    return keep.join(' ');
  }

  function titleCase(s) {
    return s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
  }

  // ---------- MRZ (machine readable zone on the back) ----------
  function mrzCheckDigit(str) {
    const w = [7, 3, 1];
    let sum = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      let v;
      if (c === '<') v = 0;
      else if (/\d/.test(c)) v = +c;
      else if (/[A-Z]/.test(c)) v = c.charCodeAt(0) - 55;
      else return -1;
      sum += v * w[i % 3];
    }
    return sum % 10;
  }
  const fixDigits = s => s.replace(/[OQD]/g, '0').replace(/[IL]/g, '1');

  function yyToYear(yy, isBirth) {
    yy = +yy;
    if (!isBirth) return 2000 + yy;
    const cur = new Date().getFullYear() % 100;
    return yy > cur ? 1900 + yy : 2000 + yy;
  }

  function parseMrz(text) {
    const lines = text.toUpperCase().split('\n').map(l => l.replace(/\s+/g, '')).filter(Boolean);
    const out = { found: false, trusted: false };

    // line 1:  I<country> + 9-digit card number + check digit + 15-digit ID number
    let l1 = null;
    for (const ln of lines) {
      const m = ln.match(/(\d{9})(\d)(784\d{12})/);
      if (m) { l1 = m; break; }
    }
    if (l1) {
      out.found = true;
      out.cardNo = l1[1];
      out.cardOk = mrzCheckDigit(l1[1]) === +l1[2];
      const d = l1[3];
      out.idNumber = d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7, 14) + '-' + d.slice(14);
    }

    // line 2:  DOB(6)+chk, sex, expiry(6)+chk, nationality(3), filler, composite chk
    let l2 = null;
    for (const ln of lines) {
      const m = ln.match(/([0-9OQDIL]{6})([0-9OQDIL])([MF])([0-9OQDIL]{6})([0-9OQDIL])([A-Z]{3})([A-Z0-9<]*)/);
      if (m) { l2 = m; break; }
    }
    if (l2) {
      out.found = true;
      const dob = fixDigits(l2[1]), dobChk = fixDigits(l2[2]);
      const exp = fixDigits(l2[4]), expChk = fixDigits(l2[5]);
      out.dobOk = mrzCheckDigit(dob) === +dobChk;
      out.expOk = mrzCheckDigit(exp) === +expChk;
      const dt = validDate(dob.slice(4, 6), dob.slice(2, 4), yyToYear(dob.slice(0, 2), true));
      if (dt) out.dob = fmtDate(dob.slice(4, 6), dob.slice(2, 4), yyToYear(dob.slice(0, 2), true));
      const dt2 = validDate(exp.slice(4, 6), exp.slice(2, 4), yyToYear(exp.slice(0, 2), false));
      if (dt2) out.expiry = fmtDate(exp.slice(4, 6), exp.slice(2, 4), yyToYear(exp.slice(0, 2), false));
      out.sex = l2[3] === 'M' ? 'Male' : 'Female';
      out.natCode = l2[6];

      // composite check digit over the whole upper+middle line
      if (l1) {
        const rest = l2[7] || '';
        if (rest.length >= 12) {
          const filler = rest.slice(0, 11), comp = rest[11];
          const composite = l1[1] + l1[2] + l1[3] + dob + dobChk + exp + expChk + filler;
          out.trusted = /\d/.test(comp) && mrzCheckDigit(composite) === +comp;
        }
      }
    }

    // line 3:  SURNAME<<GIVEN<NAMES<<<<
    for (const ln of lines) {
      if (/\d/.test(ln)) continue;
      const m = ln.match(/^([A-Z]+(?:<[A-Z]+)*)<<([A-Z<]+)$/);
      if (m) {
        let given = m[2];
        if (/K<+K<*$/.test(given)) given = given.replace(/K?(?:<+K)+<*$/, '');   // '<' misread as 'K'
        const sur = m[1].replace(/</g, ' ').trim();
        const giv = given.split('<').filter(Boolean).join(' ');
        out.name = titleCase((giv + ' ' + sur).trim());
        out.found = true;
        break;
      }
    }
    return out;
  }

  // ---------- main parser ----------
  function parseEid(raw) {
    const text = cleanOcrText(raw);
    const lines = text.split('\n');
    const mrz = parseMrz(text);
    const t = mrz.trusted;

    // ---- label-based reading of the printed text ----
    const L = {};
    const idm = text.match(/(?:784|[17]84|78[14])[\s-]*(\d{4})[\s-]*(\d{7})[\s-]*(\d)(?!\d)/);
    if (idm) L.idNumber = '784-' + idm[1] + '-' + idm[2] + '-' + idm[3];

    const cn = text.match(/Card\s*N\w{2,6}[^0-9]{0,40}(\d{9})(?!\d)/i) ||
               text.match(/Card\s*N\w{2,6}[\s\S]{0,60}?(\d{9})(?!\d)/i);
    if (cn) L.cardNo = cn[1];

    L.name = leadingCapital(valueAfterLabel(lines, /\bName\s*[:;]\s*/i));
    L.dob = dateAfterLabel(lines, /date\s*of\s*birth|birth\s*date/i);
    L.issue = dateAfterLabel(lines, /iss\w{2,5}\s+date|date\s*of\s*issue/i);
    L.expiry = dateAfterLabel(lines, /exp\w{2,6}\s+date|date\s*of\s*expiry/i);

    const sx = text.match(/\bSex\s*[:;\-]?\s*([MF])\b/);
    if (sx) L.sex = sx[1] === 'M' ? 'Male' : 'Female';
    else if (/\bFEMALE\b/i.test(text)) L.sex = 'Female';
    else if (/\bMALE\b/i.test(text)) L.sex = 'Male';

    const nat = valueAfterLabel(lines, /Nationality\s*[:;\-]?\s*/i);
    if (nat) {
      const toks = nat.trim().split(/\s+/);
      const keep = [];
      for (const tk of toks) { if (/^[A-Z][A-Za-z]{2,}$/.test(tk)) keep.push(tk); else break; }
      if (keep.length) L.nationality = /^[A-Z ]+$/.test(keep.join(' ')) ? titleCase(keep.join(' ')) : keep.join(' ');
    }

    L.occupation = leadingUpper(valueAfterLabel(lines, /Occ\w{3,8}\s*[:;]\s*/i));
    L.employer = leadingUpper(valueAfterLabel(lines, /E[mn]+p\w{2,6}r\s*[:;]\s*/i));

    const pl = valueAfterLabel(lines, /\bPlace\s*[:;]\s*/i);
    if (pl != null) {
      const em = pl.match(EMIRATES_RE);
      if (em) L.place = titleCase(em[1].replace(/\s+/g, ' '));
      else {
        const toks = pl.trim().split(/\s+/), keep = [];
        for (const tk of toks) { if (/^[A-Z][A-Za-z]{2,}$/.test(tk)) keep.push(tk); else break; }
        L.place = keep.join(' ');
      }
    }

    // ---- combine: trusted MRZ wins, otherwise printed text, MRZ as fallback ----
    const out = {};
    out.idNumber = (t && mrz.idNumber) || L.idNumber || mrz.idNumber || '';
    out.cardNo = ((t || mrz.cardOk) && mrz.cardNo) || L.cardNo || mrz.cardNo || '';
    out.dob = ((t || mrz.dobOk) && mrz.dob) || L.dob || mrz.dob || '';
    out.expiry = ((t || mrz.expOk) && mrz.expiry) || L.expiry || mrz.expiry || '';
    out.sex = (t && mrz.sex) || L.sex || mrz.sex || '';
    out.name = (L.name && /\s/.test(L.name) ? L.name : '') || mrz.name || L.name || '';
    out.nationality = L.nationality || (mrz.natCode ? (NATIONALITY_CODES[mrz.natCode] || mrz.natCode) : '');
    out.occupation = L.occupation || '';
    out.employer = L.employer || '';
    out.place = L.place || '';

    // issue date: labelled value, else the one date that is neither DOB nor expiry
    let issue = L.issue;
    if (issue && issue === out.expiry) issue = '';
    if (!issue) {
      const rest = allDates(text).filter(d => d.s !== out.dob && d.s !== out.expiry && d.dt <= new Date());
      const uniq = [...new Set(rest.map(d => d.s))];
      if (uniq.length === 1) issue = uniq[0];
    }
    out.issue = issue || '';
    if (out.issue && out.expiry) {
      const [a, b] = [out.issue, out.expiry].map(s => { const p = s.split('/'); return new Date(p[2], p[1] - 1, p[0]); });
      if (a >= b) out.issue = '';   // issue must come before expiry
    }

    out._front = /resident\s*identity|id\s*number|date\s*of\s*birth|nationality|issu\w*\s*date/i.test(text);
    out._back = mrz.found || /card\s*number|occupation|employer/i.test(text);
    out._mrzTrusted = t;
    return out;
  }

  const FIELD_KEYS = ['idNumber', 'cardNo', 'name', 'dob', 'sex', 'nationality', 'issue', 'expiry', 'occupation', 'employer', 'place'];

  // Fill blanks of `a` from `b` (never overwrite something already found)
  function mergeFields(a, b) {
    const out = Object.assign({}, a);
    for (const k of FIELD_KEYS) if (!out[k] && b[k]) out[k] = b[k];
    out._front = a._front || b._front;
    out._back = a._back || b._back;
    return out;
  }

  // Is this page's reading complete enough to stop trying other OCR passes?
  function pageComplete(f) {
    if (f._back && !f._front) return !!(f.cardNo && f.occupation && f.employer && f.place && f.idNumber);
    return !!(f.idNumber && f.name && f.dob && f.issue && f.expiry && f.nationality);
  }

  const api = { parseEid, parseMrz, mrzCheckDigit, mergeFields, pageComplete, FIELD_KEYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EidParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
