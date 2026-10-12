'use strict';
/**
 * Last look at the voluntary self-identification answers before a page is sent (owner rule: nothing untrue).
 *
 * 2026-10-09: Fernhaven's Oracle application went out with race "Asian" ticked although the owner's stored answer is
 * decline (data/profile.json standardAnswers); nobody could say afterwards which click ticked it. Whatever the cause,
 * a race / Hispanic / gender / veteran / disability answer on the page that means something other than the owner's
 * answer must stop the run before Next / Submit, not be found in an audit later.
 *
 * conflicts() is pure: form fields (label, value, kind, section, ref) + standardAnswers in, conflicts out.
 */
const D = require('./data');

const EEO = ['race', 'hispanic', 'gender', 'veteran', 'disability'];
// 2026-10-10 (Kestrelvale): "authorized to work in the United States?" went to "No" on a misclick. Work authorization and
// sponsorship are checked the same way: an answer that means the opposite of the owner's stops the run.
const LEGAL = ['workAuth', 'sponsorship'];
// Cedarhall 2026-10-09: "No" picked "Yes – North Korea". A sanctioned / foreign-government country in any picked answer stops it.
const COUNTRY_RISK = /\b(north korea|dprk|iran|syria|cuba|crimea|russia|belarus|venezuela|sudan|myanmar|donetsk|luhansk)\b/i;
// The owner's stored workAuth is a status ("citizen"): any authorized status means "yes".
const yesNo = (id, v) => (id === 'workAuth' && v && v !== 'no' ? 'yes' : v);

function kindOf(f) {
  const k = f.kind || '';
  return k === 'combobox' ? 'select' : k === 'buttons' ? 'radio' : /^checkboxes?$/.test(k) ? 'checkbox' : k;
}

/** The page's EEO answers that say something else than the owner's. */
function conflicts(fields, standardAnswers) {
  const ST = D.AF.standard;
  const sa = standardAnswers || {};
  const out = [];
  for (const f of fields || []) {
    if (!f || !f.value || /^(text|textarea|email|tel|url|number|date|file|password)$/.test(f.kind || '')) continue;
    const label = String(f.label || '');
    if (COUNTRY_RISK.test(String(f.value)) && !COUNTRY_RISK.test(label)) {
      out.push({ ref: f.ref, label: label.slice(0, 120), value: String(f.value), question: 'country', owner: 'none' });
      continue;
    }
    let hit = ST.detect({ label, context: f.section || '', inputType: kindOf(f) });
    // Oracle: "Select the races you identify with." (plural: the race patterns want "race") and a lone
    // "I am Hispanic or Latino." box.
    if (!hit && /\brac(e|es|ial)\b|\bethnicit/i.test(label)) hit = { id: 'race' };
    if (!hit && /^i am (hispanic|latin[oax])\b/i.test(label.trim())) hit = { id: 'hispanic' };
    if (hit && LEGAL.includes(hit.id) && sa[hit.id]) {
      const means = yesNo(hit.id, ST.classify(hit.id, String(f.value)));
      const owner = yesNo(hit.id, sa[hit.id]);
      if (means && means !== owner) out.push({ ref: f.ref, label: label.slice(0, 120), value: String(f.value), question: hit.id, owner });
      continue;
    }
    if (!hit || !EEO.includes(hit.id) || !sa[hit.id]) continue;
    const owner = sa[hit.id];
    const single = (f.kind || '') === 'checkbox';
    // A checkbox group reads "White, Asian"; a single ticked box means what its own label says.
    const parts = single ? [label] : /^checkboxes$/.test(f.kind || '') ? String(f.value).split(/\s*[,;]\s*/) : [String(f.value)];
    for (const part of parts) {
      if (single && !/^(yes|checked|true|on)$/i.test(String(f.value).trim())) continue;
      const means = single && hit.id === 'hispanic' ? (/^i am (hispanic|latin)/i.test(part.trim()) ? 'yes' : ST.classify(hit.id, part)) : ST.classify(hit.id, part);
      if (means && means !== owner) out.push({ ref: f.ref, label: String(f.label || '').slice(0, 120), value: part, question: hit.id, owner });
    }
  }
  return out;
}

module.exports = { conflicts, EEO, LEGAL };
