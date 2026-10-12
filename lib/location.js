'use strict';
/**
 * One shape for every posting location in the tracker (owner, 2026-10-08: "add location of the application
 * to the artifact, bake it into the system"). The tracker page splits a row's location on " / " for its
 * location filter, so each place is "City, ST" (or "Remote"), several joined with " / ".
 *
 * ATSs write places a dozen ways: "San Francisco, California, United States", "USA - Everett, WA",
 * "IL - Chicago", "US-WA-Seattle", "Remote (US)", "US Remote", "NYC". Pure: raw string in, normalized out.
 */
const { STATES } = require('./history');

const ABBR = Object.fromEntries(Object.entries(STATES).map(([ab, name]) => [name.toLowerCase(), ab]));
const METRO = { nyc: 'New York, NY', 'new york city': 'New York, NY', 'new york': 'New York, NY', sf: 'San Francisco, CA', 'bay area': 'San Francisco Bay Area, CA', dc: 'Washington, DC', 'washington dc': 'Washington, DC' };
// Bare city names ATSs use without a state (Greenhouse "Chicago", Ashby "New York").
const CITY = { chicago: 'IL', seattle: 'WA', austin: 'TX', boston: 'MA', denver: 'CO', atlanta: 'GA', portland: 'OR', richmond: 'VA', 'san francisco': 'CA', 'new york': 'NY', 'los angeles': 'CA', 'san jose': 'CA', 'washington': 'DC', 'arlington': 'VA', 'reston': 'VA', 'mclean': 'VA', 'palo alto': 'CA', 'mountain view': 'CA', 'sunnyvale': 'CA', 'santa clara': 'CA', 'emeryville': 'CA', 'bellevue': 'WA', 'redmond': 'WA', 'dallas': 'TX', 'houston': 'TX', 'miami': 'FL', 'philadelphia': 'PA', 'pittsburgh': 'PA', 'durham': 'NC', 'raleigh': 'NC', 'charlotte': 'NC' };
const COUNTRY = /^(united states( of america)?|usa|us|u\.s\.a?\.?)$/i;

/** "California" / "CA" -> "CA"; anything else -> null */
function stateAbbr(s) {
  const t = String(s || '').trim();
  if (/^[A-Z]{2}$/.test(t) && STATES[t]) return t;
  return ABBR[t.toLowerCase()] || null;
}

/** One place -> "City, ST", "Remote", or the cleaned text when it can't be read. */
function onePlace(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (/\bremote\b/i.test(t)) return 'Remote';
  t = t.replace(/\(.*?\)/g, '').replace(/,?\s+(united states( of america)?|usa|us)$/i, '').trim();
  t = t.replace(/\s+(office|hq|headquarters)$/i, '').trim(); // Ashby "San Francisco Office" (Embercrest 2026-10-09)
  // "Chicago IL USA" (Crowe) -> after the country is cut: "Chicago IL"
  const bare = t.match(/^([A-Za-z .'-]+?)\s+([A-Z]{2})$/);
  if (bare && STATES[bare[2]]) return `${bare[1]}, ${bare[2]}`;
  const metro = METRO[t.toLowerCase()] || METRO[t.toLowerCase().replace(/\s*-.*$/, '')];
  if (metro) return metro;
  // "US-WA-Seattle" (iCIMS)
  let m = t.match(/^US-([A-Z]{2})-(.+)$/i);
  if (m && STATES[m[1].toUpperCase()]) return `${m[2].trim()}, ${m[1].toUpperCase()}`;
  // "IL - Chicago", "USA - Everett, WA", "Washington - Seattle Campus"
  m = t.match(/^([A-Za-z .]+?)\s+-\s+(.+)$/);
  if (m) {
    if (COUNTRY.test(m[1].trim())) return onePlace(m[2]);
    const st = stateAbbr(m[1]);
    if (st) return `${m[2].replace(/\s+campus$/i, '').trim()}, ${st}`;
  }
  // "San Francisco, California, United States" / "Austin, TX" / "Reston, VA, US"
  const parts = t.split(',').map((s) => s.trim()).filter((s) => s && !COUNTRY.test(s));
  // The state can sit after a street ("4555 Great America Pkwy, Santa Clara, CA, 95054"): the city is the part before it.
  for (let i = 1; i < parts.length; i++) {
    const st = stateAbbr(parts[i]);
    if (st) return `${parts[i - 1]}, ${st}`;
  }
  if (parts.length === 1 && CITY[parts[0].toLowerCase()]) return `${parts[0]}, ${CITY[parts[0].toLowerCase()]}`;
  return parts.join(', ') || t;
}

/** Many places (";" / " | " / " / " / " and N more") -> "City, ST / City, ST", at most `max`, then "+N more". */
function normLocation(raw, max = 4) {
  const pieces = String(raw || '')
    .split(/\s*(?:;|\||\s\/\s|\band\b(?= \d+ more))\s*/i)
    .map(onePlace)
    .filter((p) => p && !/^\d+ more$/i.test(p));
  const uniq = [...new Set(pieces)];
  if (uniq.length <= max) return uniq.join(' / ');
  return `${uniq.slice(0, max).join(' / ')} / +${uniq.length - max} more`;
}

module.exports = { normLocation, onePlace, stateAbbr };
