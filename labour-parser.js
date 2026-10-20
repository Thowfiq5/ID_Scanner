/* labour-parser.js — turns raw OCR text of a UAE Ministry of Human Resources
   (MOHRE) Work Permit / Labour Card into separate fields.
   Pure functions only, so it can be tested in Node without a browser.

   Card layout (English label on the left, Arabic label on the right):
     Name, Expiry Date, Work Permit NO, Personal NO,
     Profession, Nationality, Establishment.
   Profession and Nationality are often printed in Arabic only, so a second,
   Arabic OCR pass (parseArabicLines) is used for those two fields. */
(function (root) {
  'use strict';

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Arabic country names (normalised, see arNorm) -> English
  const AR_COUNTRIES = {
    'الهند': 'India', 'باكستان': 'Pakistan', 'بنغلاديش': 'Bangladesh', 'سريلانكا': 'Sri Lanka',
    'نيبال': 'Nepal', 'الفلبين': 'Philippines', 'مصر': 'Egypt', 'الاردن': 'Jordan', 'سوريا': 'Syria',
    'لبنان': 'Lebanon', 'السودان': 'Sudan', 'اليمن': 'Yemen', 'ايران': 'Iran', 'العراق': 'Iraq',
    'افغانستان': 'Afghanistan', 'كينيا': 'Kenya', 'اوغندا': 'Uganda', 'اثيوبيا': 'Ethiopia',
    'نيجيريا': 'Nigeria', 'غانا': 'Ghana', 'اندونيسيا': 'Indonesia', 'ماليزيا': 'Malaysia',
    'تايلاند': 'Thailand', 'الصين': 'China', 'روسيا': 'Russia', 'المغرب': 'Morocco', 'تونس': 'Tunisia',
    'الجزائر': 'Algeria', 'فلسطين': 'Palestine', 'السعوديه': 'Saudi Arabia', 'عمان': 'Oman',
    'الكويت': 'Kuwait', 'البحرين': 'Bahrain', 'قطر': 'Qatar', 'الامارات': 'United Arab Emirates',
    'تركيا': 'Turkey', 'بريطانيا': 'United Kingdom', 'امريكا': 'United States', 'ميانمار': 'Myanmar',
    'اوزبكستان': 'Uzbekistan', 'ليبيا': 'Libya', 'الصومال': 'Somalia', 'تنزانيا': 'Tanzania'
  };

  // Arabic month-free helpers ------------------------------------------------
  function arNorm(s) {
    return (s || '')
      .replace(/[ً-ٰٟ]/g, '')        // diacritics / tatweel marks
      .replace(/ـ/g, '')
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/ى/g, 'ي')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const AR_RE = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g;
  const hasArabic = s => /[؀-ۿ]/.test(s || '');
  const stripArabic = t => (t || '').replace(AR_RE, ' ');

  function titleCase(s) {
    return s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
  }

  // ---------- date: 23/Sep/2028 (also tolerates 23/09/2028) ----------
  function monthFrom(tok) {
    if (/^\d{1,2}$/.test(tok)) { const n = +tok; return n >= 1 && n <= 12 ? MONTHS[n - 1] : null; }
    const t = tok.slice(0, 3).toLowerCase();
    for (const m of MONTHS) if (m.toLowerCase() === t) return m;
    // one-letter OCR slip, e.g. "Sap", "0ct", "Dac"
    for (const m of MONTHS) {
      let diff = 0;
      for (let i = 0; i < 3; i++) if (m[i].toLowerCase() !== t[i]) diff++;
      if (diff <= 1 && /^[A-Za-z0]{3}/.test(tok)) return m;
    }
    return null;
  }

  function findDate(text) {
    const re = /(\d{1,2})\s?[\/\-.]\s?([A-Za-z0]{3,9}|\d{1,2})\s?[\/\-.]\s?(\d{4})/g;
    let m;
    while ((m = re.exec(text))) {
      const mon = monthFrom(m[2]);
      const d = +m[1], y = +m[3];
      if (mon && d >= 1 && d <= 31 && y >= 2000 && y <= 2100) return String(d).padStart(2, '0') + '/' + mon + '/' + y;
    }
    return '';
  }

  // ---------- label helpers ----------
  // Text after the label on its own line; `next` also returns the following line.
  function afterLabel(lines, labelRe) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(labelRe);
      if (m) return { same: lines[i].slice(m.index + m[0].length), next: lines[i + 1] || '', prev: lines[i - 1] || '' };
    }
    return null;
  }

  // Leading UPPER-CASE words (name / establishment are printed in capitals)
  function leadingUpper(v, allowShort) {
    if (v == null) return '';
    const toks = v.replace(/[:;|_]/g, ' ').split(/\s+/).filter(Boolean);
    const keep = [];
    for (const t of toks) {
      if (/^[A-Z0-9&.,()\/'-]+$/.test(t)) keep.push(t); else break;
    }
    // drop trailing single-letter OCR junk (but keep real initials when allowShort)
    while (!allowShort && keep.length > 1 && keep[keep.length - 1].length === 1 && keep[keep.length - 1] !== '&') keep.pop();
    return keep.join(' ');
  }

  function leadingCapital(v) {
    if (v == null) return '';
    const toks = v.replace(/[:;|_]/g, ' ').split(/\s+/).filter(Boolean);
    const keep = [];
    for (const t of toks) {
      if (/^[A-Z][A-Za-z'.-]+$/.test(t)) keep.push(t); else break;
    }
    return keep.join(' ');
  }

  function digitsOnly(s) { return s.replace(/\D/g, ''); }

  // Digit run of the wanted length range after a label (same line first, then the next/previous one)
  function numberAfter(lines, labelRe, minLen, maxLen) {
    const hit = afterLabel(lines, labelRe);
    if (!hit) return '';
    for (const part of [hit.same, hit.prev, hit.next]) {
      // collapse single spaces inside a number, keep wider gaps as separators
      const cand = part.replace(/(\d) (?=\d)/g, '$1');
      for (const m of cand.matchAll(/\d+/g)) {
        if (m[0].length >= minLen && m[0].length <= maxLen) return m[0];
      }
    }
    return '';
  }

  // ---------- main (English OCR) ----------
  function parseLabour(raw) {
    const text = (raw || '').replace(AR_RE, ' ');
    const lines = text.split('\n');
    const out = {};

    const nm = afterLabel(lines, /\bName\s*[:;]\s*/);
    out.name = nm ? leadingUpper(nm.same, true) : '';

    const exp = afterLabel(lines, /Expiry\s*Date|Exp\w{2,5}\s*Date/i);
    out.expiry = findDate((exp ? exp.same + ' \n ' + exp.next : '')) || findDate(text);

    out.workPermit = numberAfter(lines, /Work\s*Permit\s*N\w*\s*[:;]?/i, 7, 10);
    out.personalNo = numberAfter(lines, /Personal\s*N\w*\s*[:;]?/i, 12, 15);

    const pr = afterLabel(lines, /Profession\s*[:;]?/i);
    out.profession = pr ? leadingCapital(pr.same) : '';

    const nt = afterLabel(lines, /Nationality\s*[:;]?/i);
    out.nationality = nt ? leadingCapital(nt.same) : '';

    const es = afterLabel(lines, /Establishment\s*[:;]\s*/i);
    out.establishment = es ? leadingUpper(es.same) : '';

    return out;
  }

  // ---------- Arabic OCR pass: profession + nationality ----------
  function arabicValue(line, labelRe) {
    let v = line.replace(labelRe, ' ');
    v = v.replace(/[A-Za-z0-9:;|_.,\-\/\\()«»"'“”]/g, ' ');
    v = v.replace(/\s+/g, ' ').trim();
    return v;
  }

  function parseArabicLines(raw) {
    const out = {};
    const lines = (raw || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (!hasArabic(ln)) continue;
      const n = arNorm(ln);
      if (!out.profession && /المهن[هة]/.test(n)) {
        const v = arabicValue(ln, /المهن[هة]|المهنة/g);
        if (v) out.profession = v;
      }
      if (!out.nationality && /الجنسي[هة]/.test(n)) {
        const v = arabicValue(ln, /الجنسي[هة]|الجنسية/g);
        if (v) out.nationality = v;
      }
    }
    return out;
  }

  // Arabic nationality -> English name (falls back to the Arabic text)
  function nationalityToEnglish(ar) {
    if (!ar) return '';
    const n = arNorm(ar);
    if (AR_COUNTRIES[n]) return AR_COUNTRIES[n];
    for (const k of Object.keys(AR_COUNTRIES)) if (n.includes(k)) return AR_COUNTRIES[k];
    return ar;
  }

  // ---------- merging / completeness ----------
  const FIELD_KEYS = ['name', 'expiry', 'workPermit', 'personalNo', 'profession', 'nationality', 'establishment'];

  // Fill blanks of a from b. Personal NO: prefer the full 14-digit reading (OCR sometimes drops the leading "1").
  function mergeFields(a, b) {
    const out = Object.assign({}, a);
    for (const k of FIELD_KEYS) if (!out[k] && b[k]) out[k] = b[k];
    if (b.personalNo && out.personalNo !== b.personalNo) {
      const better = x => x && x.length === 14;
      if (!better(out.personalNo) && better(b.personalNo)) out.personalNo = b.personalNo;
    }
    return out;
  }

  // Enough to stop trying more English OCR passes
  function coreComplete(f) {
    return !!(f.name && f.expiry && f.workPermit && f.personalNo && f.personalNo.length === 14 && f.establishment);
  }

  const api = { parseLabour, parseArabicLines, nationalityToEnglish, mergeFields, coreComplete, FIELD_KEYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LabourParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
