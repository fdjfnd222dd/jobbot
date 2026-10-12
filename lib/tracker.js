'use strict';
/**
 * The tracker row for a submitted run (`jobctl row <run>`), so /apply writes the same fields every time,
 * location included (owner, 2026-10-08). Pure: run + profile + today in, { docId, data } out.
 * Fields match the tracker page: company, role, location, reqId, applied, status, via, contact, notes,
 * followUp, updated. Location is "City, ST" / "Remote", several joined with " / " (lib/location.js).
 */
const path = require('node:path');
const { normLocation } = require('./location');

const VIA = { greenhouse: 'Greenhouse', ashby: 'Ashby', lever: 'Lever', workday: 'Workday', icims: 'iCIMS', oracle: 'Oracle', taleo: 'Taleo', smartrecruiters: 'SmartRecruiters', jobvite: 'Jobvite', workable: 'Workable', rippling: 'Rippling', bamboohr: 'BambooHR' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The ATS's own job id from the posting / apply URL, '' when it has none worth keeping (Ashby / Lever UUIDs). */
function reqIdOf(url) {
  const u = String(url || '');
  const m =
    u.match(/greenhouse\.io\/.*?(?:jobs\/|[?&]token=)(\d+)/i) ||
    u.match(/[?&]gh_jid=(\d+)/i) ||
    u.match(/icims\.com\/jobs\/(\d+)/i) ||
    u.match(/oraclecloud\.com\/.*\/job\/(\d+)/i) ||
    u.match(/myworkdayjobs\.com\/.*_((?:JR|R)?-?\d[\w-]*)(?:[/?#]|$)/i);
  return m ? m[1] : '';
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);

function trackerRow(run, profile, today, opts = {}) {
  const pr = (profile && profile.profile) || {};
  const grad = pr.gradYear ? `${MONTHS[Number(pr.gradMonth || 12) - 1] || 'Dec'} ${pr.gradYear}` : '';
  const reqId = opts.reqId != null ? String(opts.reqId) : run.reqId ? String(run.reqId) : reqIdOf(run.postingUrl) || reqIdOf(run.url);
  const company = run.company || '';
  const role = run.role || '';
  const location = opts.location ? normLocation(opts.location) : run.location || '';
  const resume = run.resume ? path.basename(run.resume) : '';
  return {
    docId: slug(`${company}-${reqId || role}`),
    data: {
      company,
      role,
      location,
      reqId,
      applied: today,
      status: 'applied',
      via: VIA[run.ats] || run.ats || '',
      contact: '',
      notes: `Applied with jobbot. Resume ${resume}${grad ? `, grad ${grad}` : ''}.`,
      followUp: '',
      updated: today,
    },
  };
}

module.exports = { trackerRow, reqIdOf };
