'use strict';
/**
 * iCIMS resume parsing scrambles the work history it copies into the profile form (2026-10-08, Driftmere and
 * Thorngate): Employer "SRE" / "ICS" / "Civic Org", a bullet as the Title, certifications as a fifth job, an
 * education row with "Masters" and "Did you graduate: Yes". Each run needed ~30 hand fixes.
 *
 * planHistory() reads the snapshot's Professional Experience / Education blocks and returns what to set so
 * they match the tailored resume JSON (the same facts the uploaded file holds), plus which extra blocks to
 * delete. Pure: snapshot fields + buttons + resume + profile in, a plan out. lib/apply.js applies it.
 */
const fs = require('node:fs');
const path = require('node:path');

const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

/** "Smithtown, NC" -> { city: 'Smithtown', state: 'North Carolina' } */
function place(location) {
  const [city, st] = String(location || '').split(',').map((s) => s.trim());
  return { city: city || '', state: STATES[(st || '').toUpperCase()] || st || '' };
}

/** "Jun 2026" -> { month: 'Jun', day: '1', year: '2026' }; "Present" / "" -> null */
function monthYear(s) {
  const m = String(s || '').match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/);
  return m ? { month: m[1][0].toUpperCase() + m[1].slice(1, 3).toLowerCase(), day: '1', year: m[2] } : null;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Jun 2026" -> { m: 6, mm: '06', name: 'June', abbr: 'Jun', year: '2026' }; anything else -> null */
function ym(s) {
  const d = monthYear(s);
  if (!d) return null;
  const m = MONTH_NAMES.findIndex((x) => x.slice(0, 3) === d.month) + 1;
  return m ? { m, mm: String(m).padStart(2, '0'), name: MONTH_NAMES[m - 1], abbr: d.month, year: d.year } : null;
}

/**
 * The employer as a form's Company box should read. The resume line "Gamma Project (Civic Lab, Civic Org)" names
 * the Civic Org as the program's customer, not the employer (the owner, 2026-10-09): the form gets "Gamma Project (Civic Lab)".
 */
function formEmployer(company) {
  return String(company || '').replace(/,\s*Civic Org\b/i, '').replace(/\s*\(\s*Civic Org\s*\)/i, '').replace(/\s+/g, ' ').trim();
}

/** The job title as a form's Title box should read: "(SRE)" is a resume abbreviation (SRE = Systems Reliability). */
function formTitle(title) {
  return String(title || '').replace(/\s*\((SRE)\)\s*$/i, '').trim();
}

/**
 * The owner's jobs for a work-history section, in resume order: the experience[] of the tailored resume JSON (the
 * facts in the uploaded file), cleaned for form boxes. A job whose end reads "Present" is current: no end date.
 */
function formJobs(resume) {
  return ((resume && resume.experience) || []).map((j) => {
    const [from, to] = String(j.dates || '').split(/\s+[-–—]\s+/);
    const where = place(j.location);
    const title = formTitle(j.title);
    return {
      company: formEmployer(j.company),
      title,
      short: title.split(',')[0].trim(), // "Research Assistant" for a box too short for the topic
      location: String(j.location || '').trim(),
      city: where.city,
      state: where.state,
      us: Object.values(STATES).includes(where.state),
      from: ym(from),
      to: /present|current/i.test(to || '') ? null : ym(to),
      current: /present|current/i.test(to || ''),
      description: (j.bullets || []).map((x) => '- ' + x).join('\n'),
    };
  });
}

/**
 * The one education entry: the profile's school / degree / major / GPA, the resume's school location, start from
 * profile extras.eduStart ("Aug 2023", the owner 2026-10-09), end = the expected graduation (gradMonth / gradYear).
 * Graduated only once that date has passed.
 */
function formEducation(resume, profile) {
  const pr = (profile && profile.profile) || {};
  const ex = (profile && profile.extras) || {};
  const row = Array.isArray(resume && resume.education) ? resume.education[0] : resume && resume.education;
  const school = pr.school || (row && row.school) || '';
  if (!school) return null;
  const at = place(row && row.location);
  const gm = Number(pr.gradMonth || 12);
  const end = pr.gradYear ? { m: gm, mm: String(gm).padStart(2, '0'), name: MONTH_NAMES[gm - 1], abbr: MONTH_NAMES[gm - 1].slice(0, 3), year: String(pr.gradYear) } : null;
  return {
    school,
    degree: pr.degree || '',
    bachelor: /bachelor/i.test(pr.degree || ''),
    major: pr.major || '',
    minor: pr.minor || '',
    gpa: String(ex.gpa || pr.gpa || ''),
    city: at.city,
    state: at.state,
    us: Object.values(STATES).includes(at.state),
    from: ym(ex.eduStart),
    to: end,
    graduated: !!pr.gradYear && new Date(Number(pr.gradYear), gm - 1, 28) <= new Date(),
  };
}

/**
 * Certifications for a Licenses / Certifications section: the resume's certification lines that name an issuer
 * ("CompTIA: Security+, Network+", "Quillstone: VCM-A, ..."), CompTIA first (Security+ and Network+ go on every
 * application, the owner 2026-10-09). Lines that are not certifications (Eagle Scout) are left out.
 */
/**
 * Cert names from one resume line. Commas inside parentheses do not split; a parenthesised exam code stays off the name
 * ("Security+ (SY0-701)" -> Security+), other parentheses hold the names ("Certified Professional (VCP-A, VCP-B)"
 * -> VCP-A, VCP-B). the owner's 2026-10-12 resume spells them both ways.
 */
function certNames(text) {
  const items = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(text || '')) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && !depth) {
      items.push(cur);
      cur = '';
    } else cur += ch;
  }
  items.push(cur);
  return items
    .map((x) => x.trim())
    .filter(Boolean)
    .flatMap((x) => {
      const m = x.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
      if (!m) return [x];
      if (/^[A-Z]{1,3}\d{0,2}-\d{3}[A-Z]?$/i.test(m[2].trim())) return [m[1].trim()];
      return m[2].split(/\s*,\s*/).filter(Boolean);
    });
}
const CERT_ISSUERS = /^(comptia|quillstone|cisco|aws|amazon|microsoft|google|isc2|\(isc\)2|ec-council|giac|red hat|vmware|linux foundation)$/i;
function formCerts(resume) {
  const out = [];
  for (const c of (resume && resume.certifications) || []) {
    const issuer = String(c.label || '').replace(/[:,]\s*$/, '').trim();
    if (!CERT_ISSUERS.test(issuer)) continue;
    for (const name of certNames(c.text)) out.push({ issuer, name: `${issuer} ${name}`, short: name });
  }
  return out.sort((a, b) => (/comptia/i.test(b.issuer) ? 1 : 0) - (/comptia/i.test(a.issuer) ? 1 : 0));
}

/** The tailored resume JSON next to the uploaded file (render.sh writes <OutBase>.json), else master.json. */
function resumeJsonFor(resumeFile, dir) {
  const read = (f) => {
    try {
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    } catch (e) {
      return null; // a half-written sidecar skips the fix, never crashes the run
    }
  };
  // master.json holds the same true jobs; a tailored file only reorders / rewords them.
  const side = resumeFile ? String(resumeFile).replace(/\.(pdf|docx)$/i, '.json') : null;
  return (side && side !== resumeFile && read(side)) || read(path.join(dir, 'master.json'));
}

// Label synonyms inside a work block: IRONFIELD's iCIMS form reads "Title*", "Employer name", ..., "Description of work"
// (2026-10-09: the block starts at Title, so the "starts at Employer" split saw no job and nothing was fixed).
const EXP_SYN = { 'employer name': 'employer', company: 'employer', 'company name': 'employer', 'job title': 'title', 'position title': 'title', 'description of work': 'description', 'job description': 'description' };
const EXP_START = new Set(['employer', 'title']);
const EXP_MAX = { employer: 1, title: 1, address: 1, city: 1, zip: 1, country: 1, state: 1, month: 2, day: 2, year: 2, description: 1 };
const EDU_MAX = { school: 1, 'school/institution': 1, 'other school': 1, degree: 1, major: 1, 'major/area of study': 1, gpa: 1, minor: 1, 'did you graduate?': 1, 'did you graduate': 1, country: 1, state: 1, city: 1, month: 2, day: 2, year: 2 };
/**
 * Split the form's fields into blocks. A Professional Experience block starts at "Employer" or "Title" (whichever the
 * form puts first) and an Education block at "School"; it ends at the next block start, a field outside its
 * vocabulary, or a label seen more often than a block holds (a "Date Available: Month / Day / Year" right after the
 * last job is not that job's dates). A work block without an Employer box is not a job (a "Title: Mr / Ms" box).
 */
function blocks(fields) {
  const out = [];
  let cur = null;
  for (const f of fields) {
    // "School (If not applicable, select Other)", "Other School (if not listed)" (Pinecrest, Ravenhaven): the note in
    // brackets is not part of the field's name.
    const label = String(f.label || '').replace(/[*✱:]+$/, '').trim().replace(/\s*\([^)]*\)$/, '').trim();
    const raw = label.toLowerCase();
    const expKey = EXP_SYN[raw] || raw;
    if (EXP_START.has(expKey) && (!cur || cur.kind !== 'exp' || (cur.seen[expKey] || 0) >= 1)) {
      cur = { kind: 'exp', fields: [], seen: {} };
      out.push(cur);
    } else if (raw === 'school' && f.kind === 'combobox') {
      cur = { kind: 'edu', fields: [], seen: {} };
      out.push(cur);
    } else if (cur) {
      const key = cur.kind === 'exp' ? expKey : raw;
      const max = (cur.kind === 'exp' ? EXP_MAX : EDU_MAX)[key];
      if (!max || (cur.seen[key] || 0) >= max) cur = null;
    }
    if (cur) {
      const key = cur.kind === 'exp' ? expKey : raw;
      cur.seen[key] = (cur.seen[key] || 0) + 1;
      cur.fields.push({ ...f, label, key });
    }
  }
  return out.filter((b) => b.kind !== 'exp' || b.seen.employer);
}

// iCIMS buttons that add / delete a work block: "Add Professional Experience", "Add Work Experience",
// "Delete Professional Experience (5)", "Delete Work Experience (2)".
const ADD_JOB = /^(\+\s*)?add (another |new |an? )?(professional |work )?(experience|employment|job)\b/i;
const delJob = (n) => new RegExp(`^delete (professional |work )?(experience|employment) \\(${n}\\)$`, 'i');

/**
 * The plan: { sets: [{ ref, value }], clears, deletes: [button text], adds, addButton, note }. Only for forms whose
 * blocks look parsed (iCIMS profile pages), or that offer an "Add ... Experience" button for jobs the form lacks.
 */
function planHistory(fields, buttons, resume, profile) {
  const bs = blocks(fields || []);
  // iCIMS numbers its rows over every block, so a block without a Title still counts for "(n)".
  const exp = bs.filter((b) => b.kind === 'exp');
  const edu = bs.filter((b) => b.kind === 'edu');
  const plan = { sets: [], clears: [], deletes: [], adds: 0, addButton: null, note: [] };
  const addBtn = (buttons || []).find((x) => ADD_JOB.test(String(x.text || '').trim()));
  const hasTitle = (b) => b.fields.some((f) => f.key === 'title');
  if (!exp.some(hasTitle) && !edu.length && !addBtn) return plan;
  const allJobs = formJobs(resume);
  const jobs = allJobs.slice(0, exp.length);
  if (allJobs.length > exp.length) {
    // Every application lists all the jobs (the owner, 2026-10-09): the driver presses Add for each missing one.
    if (addBtn) {
      plan.adds = allJobs.length - exp.length;
      plan.addButton = addBtn.text;
    } else plan.note.push(`${allJobs.length - exp.length} resume job(s) have no block on the form`);
  }
  const set = (f, value) => {
    if (f && value != null && value !== '' && String(f.value || '') !== String(value)) plan.sets.push({ ref: f.ref, value: String(value), label: f.label });
  };
  // Dates: Month / Day / Year boxes in order (start, then end); a box labelled "Start ..." / "End ..." says which.
  const datesOf = (b) => {
    const parts = { month: b.fields.filter((f) => f.key === 'month'), day: b.fields.filter((f) => f.key === 'day'), year: b.fields.filter((f) => f.key === 'year') };
    return parts;
  };
  const putDate = (parts, k, d, keepDay) => {
    set(parts.month[k], d.abbr);
    // The resume has no day; the form wants one. Keep what is there, else the 1st.
    if (parts.day[k] && !(keepDay && parts.day[k].value)) set(parts.day[k], '1');
    set(parts.year[k], d.year);
  };
  exp.forEach((b, i) => {
    const job = jobs[i];
    if (!job || !hasTitle(b)) return;
    const one = (k) => b.fields.find((f) => f.key === k);
    set(one('employer'), job.company);
    set(one('title'), job.title);
    set(one('city'), job.city);
    // Country only when the resume's location is a U.S. state.
    if (job.us) set(one('country'), 'United States');
    set(one('state'), job.state);
    const parts = datesOf(b);
    if (job.from) putDate(parts, 0, job.from, true);
    if (job.to) putDate(parts, 1, job.to, true);
    // "Present": a parsed end date on a current job is untrue; clear it.
    else if (job.current) for (const f of [parts.month[1], parts.day[1], parts.year[1]]) if (f && f.value) plan.clears.push({ ref: f.ref, label: f.label });
    const desc = one('description');
    if (desc && job.description) set(desc, job.description);
  });
  // Blocks past the resume's jobs are parser junk (certifications, a bullet): delete from the last one down.
  for (let n = exp.length; n > jobs.length; n--) {
    const btn = (buttons || []).find((x) => delJob(n).test(String(x.text || '').trim()));
    if (btn) plan.deletes.push(btn.text);
    else plan.note.push(`experience block ${n} is extra and has no delete button`);
  }
  // Education: the row naming the owner's school; other rows for the same school are parser duplicates.
  const ed = formEducation(resume, profile);
  const school = String((ed && ed.school) || '').toLowerCase();
  // A school missing from the picklist is "Other" plus the name typed into "Other School" (Pinecrest has no EXU).
  const schoolOf = (b) => {
    const pick = String((b.fields.find((f) => /^school$/i.test(f.label)) || {}).value || '').toLowerCase();
    const typed = String((b.fields.find((f) => /^other school$/i.test(f.label)) || {}).value || '').toLowerCase();
    return pick === 'other' && typed ? typed : pick;
  };
  const mine = school ? edu.filter((b) => schoolOf(b) === school) : [];
  if (mine.length) {
    const b = mine[0];
    const one = (re) => b.fields.find((f) => re.test(f.label));
    const degree = one(/^degree$/i);
    if (degree && ed.bachelor && !/bachelor/i.test(degree.value || '')) set(degree, 'Bachelors');
    set(one(/^major\b/i), ed.major); // "Major" or "Major/Area of Study" (Ravenhaven)
    set(one(/^gpa$/i), ed.gpa);
    set(one(/^minor$/i), ed.minor);
    // The school's own address (Country / State / City are required on iCIMS education rows; Driftmere, Thorngate
    // and Ravenhaven stopped on them): the resume's education location, e.g. "Springfield, VA". Never the home address.
    if (ed.city) {
      set(one(/^city$/i), ed.city);
      if (ed.us) set(one(/^country$/i), 'United States');
      set(one(/^state$/i), ed.state);
    }
    // Dates: two sets are start + expected graduation (IRONFIELD asked both, 2026-10-09: start was typed by hand);
    // one set is the graduation date (Ravenhaven).
    const parts = datesOf(b);
    const sets = Math.max(parts.month.length, parts.year.length);
    if (sets >= 2 && ed.from) putDate(parts, 0, ed.from, true);
    if (ed.to && sets >= 1) putDate(parts, sets >= 2 ? 1 : 0, ed.to, true);
    // Not graduated while the grad date is in the future (profile gradMonth / gradYear).
    if (ed.to && !ed.graduated) set(one(/^did you graduate\??$/i), 'No');
    for (let n = edu.length; n >= 1; n--) {
      if (edu[n - 1] === b || schoolOf(edu[n - 1]) !== school) continue;
      const text = `Delete Education (${n})`;
      if ((buttons || []).some((x) => x.text.toLowerCase() === text.toLowerCase())) plan.deletes.push(text);
    }
  }
  return plan;
}

/**
 * Workday "Autofill with Resume" turns a resume project into a work block ("Threat Intelligence Pipeline",
 * no Job Title: Coppermoor / Elmbrook 2026-10-09). Returns the refs of the block-level "Delete" buttons to press,
 * last first. Work blocks come first on My Experience, so the i-th Company field owns the i-th plain "Delete".
 */
function workdayJunkBlocks(fields, buttons, resume) {
  const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const projects = new Set(((resume && resume.projects) || []).map((x) => norm(String(x.name || '').split(',')[0])));
  const employers = new Set(((resume && resume.experience) || []).map((x) => norm(x.company)));
  const companies = fields.filter((f) => /^company\b/i.test(f.label || ''));
  const titles = fields.filter((f) => /^job title\b/i.test(f.label || ''));
  const deletes = buttons.filter((b) => /^delete$/i.test(String(b.text || '').trim()));
  const out = [];
  companies.forEach((c, i) => {
    const name = norm(c.value);
    const title = titles[i] ? String(titles[i].value || '').trim() : 'x';
    const employer = [...employers].some((e) => e && (name === e || e.startsWith(name + ' ') || name.startsWith(e + ' ')));
    if (name && (projects.has(name) || (!title && !employer)) && deletes[i]) out.push(deletes[i].ref);
  });
  return out.reverse();
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Repeating sections (Workday My Experience, Oracle profile tiles, an "Employment" repeater on any other form)    */
/* ------------------------------------------------------------------------------------------------------------ */
/*
 * Every application lists the owner's real jobs, education and certifications, even when the section is optional and
 * empty (the owner, 2026-10-09: applications are much weaker without them). extension/agent/page.js JB.repeaters() reads
 * the sections as { kind: 'work' | 'edu' | 'cert', ats, add, entries: [{ title, subtitle, invalid, del, edit, fields }],
 * open: { fields, save, cancel } }; nextRepeaterAction() returns the one next step (delete an extra entry, fill an
 * entry, open a tile, press Add, Save, Cancel) or null when every section matches the facts. The driver does the step,
 * reads the sections again and asks again; `memo` (owned by the driver) keeps it from repeating a step that did not take.
 */

/** The facts every history section is filled from: { work: [job], edu: [school], cert: [cert] }. */
function formFacts(resume, profile) {
  const ed = formEducation(resume, profile);
  return { work: formJobs(resume), edu: ed ? [ed] : [], cert: formCerts(resume) };
}

// Workday formField-<name> ids (seen on the Vanguard capture in ~/autofill/fixtures/workday) -> keys.
const WD_KEYS = { jobTitle: 'title', companyName: 'company', location: 'location', currentlyWorkHere: 'current', roleDescription: 'description', school: 'school', degree: 'degree', fieldOfStudy: 'major', gradeAverage: 'gpa', firstYearAttended: 'startYear', lastYearAttended: 'endYear' };

const lc = (t) => String(t || '').toLowerCase().replace(/[*✱:]/g, ' ').replace(/\brequired\b/g, ' ').replace(/\s+/g, ' ').trim();
const nm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim();

/** What a field of a `kind` entry holds: a key ('title', 'company', ...) or { date, when, part } for a date box; null = not ours. */
function repKey(f, kind) {
  if (f.key === 'startDate' || f.key === 'endDate') return { date: true, when: f.key === 'startDate' ? 'start' : 'end', part: 'full' };
  if (f.key && WD_KEYS[f.key]) return WD_KEYS[f.key];
  const l = lc(f.label);
  if (f.kind === 'checkbox' && /\bcurrent|\bpresent\b|still (work|employ)|i work here/.test(l)) return 'current';
  if (/graduat/.test(l) && !/\b(date|month|year)\b/.test(l)) return 'graduated';
  if (f.kind === 'date' || /\b(month|year|day|date)\b/.test(l)) {
    // A degree's "Date Acquired" is its (expected) graduation; a certificate's is when it was earned.
    const when = kind === 'edu' && /\b(acquired|awarded|conferred|obtained|received)\b/.test(l) ? 'end'
      : /\b(start|from|begin|began|enrol\w*)\b/.test(l) ? 'start'
      : /\b(end|to|until|finish\w*|graduat\w*|complet\w*|expected|leav\w*)\b/.test(l) ? 'end'
      : /\b(acquired|issued?|obtained|earned|received)\b/.test(l) ? 'start' : /expir/.test(l) ? 'expires' : '';
    const part = f.kind === 'date' ? 'full' : /\bmonth\b/.test(l) ? 'month' : /\byear\b/.test(l) ? 'year' : /\bday\b/.test(l) ? 'day' : /\bdate\b/.test(l) ? 'full' : '';
    return part ? { date: true, when, part } : null;
  }
  if (kind === 'work') {
    if (/^(employer|company|organi[sz]ation|business)\b/.test(l)) return 'company';
    if (/^((job|position|role) )?title\b|^position\b|^role\b/.test(l)) return 'title';
    if (/^(work |job )?location\b/.test(l)) return 'location';
    if (/descri|responsib|duties|summary|accomplish/.test(l)) return 'description';
  }
  if (kind === 'edu') {
    if (/^(name of )?(other )?(school|university|college|institution)/.test(l)) return 'school';
    if (/degree|level of education|education level/.test(l)) return 'degree';
    if (/major|field of study|discipline|area of study|concentration|program of study/.test(l)) return 'major';
    if (/\bgpa\b|grade (point )?average|^grade\b/.test(l)) return 'gpa';
    if (/^minor\b/.test(l)) return 'minor';
  }
  if (kind === 'cert') {
    if (/number|\bid\b|\bno\b|url|link/.test(l)) return null;
    if (/issu|organi[sz]ation|authority|vendor|provider|body/.test(l)) return 'issuer';
    if (/^(licen[cs]e|certifi\w*|title|name|credential)\b/.test(l)) return 'name';
  }
  if (/^city\b/.test(l)) return 'city';
  if (/^(state|province)\b/.test(l)) return 'state';
  if (/^country\b/.test(l)) return 'country';
  return null;
}

const ORDER = ['company', 'title', 'school', 'degree', 'major', 'name', 'issuer', 'location', 'city', 'country', 'state', 'current', 'graduated', 'start', 'startYear', 'end', 'endYear', 'gpa', 'minor', 'description'];
const IDENTITY = new Set(['company', 'title', 'school', 'name']);
const CHOICE = /^(select|combobox|buttons|radio|checkboxes)$/;

/** Does the field already say what we want? Choice boxes match on any accepted wording ("Bachelor's Degree"). */
function same(f, want) {
  const v = String(f.value || '');
  if (f.kind === 'checkbox') return (v === 'checked') === /^(yes|true|checked)$/i.test(want.value);
  if (want.date) {
    const got = v.split(/\D+/).filter(Boolean).map(Number);
    return want.date.every((x, i) => got[i] === x);
  }
  const all = [want.value, ...(want.alts || [])].map(nm).filter(Boolean);
  const n = nm(v);
  if (!n) return false;
  if (all.includes(n)) return true;
  // The snapshot cuts long values at 300 characters with "…" (a Workday Role Description, DUNVALE 2026-10-09: rewritten on
  // every pass because the cut text never equalled the bullets).
  if (/…$/.test(v)) {
    const pre = nm(v.slice(0, -1));
    if (pre.length >= 40 && all.some((a) => a.startsWith(pre))) return true;
  }
  return CHOICE.test(f.kind || '') && all.some((a) => n.includes(a) || a.includes(n));
}

/** What one entry's fields should hold for `item`: [{ ref, value, alts, key, label }], in the order to set them. */
function entrySets(fields, item, kind, ats) {
  const out = [];
  const seenDate = {};
  for (const f of fields || []) {
    const k = repKey(f, kind);
    if (!k) continue;
    let key = k;
    let want = null;
    if (typeof k === 'object') {
      // An unlabelled Month / Year pair is start then end, in page order.
      const n = (seenDate[k.part] = (seenDate[k.part] || 0) + 1);
      const when = k.when || (n === 1 ? 'start' : n === 2 ? 'end' : '');
      if (when !== 'start' && when !== 'end') continue;
      key = when;
      const d = when === 'start' ? item.from : item.to;
      if (!d) {
        // A current job has no end date: a parsed one is untrue; clear a text box that holds one.
        if (when === 'end' && item.current && f.value && /^(text|date)$/.test(f.kind || '')) out.push({ ref: f.ref, value: '', key, label: f.label, clear: true });
        continue;
      }
      if (k.part === 'month') want = { value: d.name, alts: [d.abbr, d.mm, String(d.m)] };
      else if (k.part === 'year') want = { value: d.year };
      else if (k.part === 'day') {
        if (!f.value) out.push({ ref: f.ref, value: '1', key: when + 'Day', label: f.label });
        continue;
      } else if (f.kind === 'date' || ats === 'workday') want = { value: `${d.mm}/${d.year}`, date: [d.m, Number(d.year)] };
      else want = { value: `${d.mm}/${d.year}`, alts: [`${d.name} ${d.year}`] };
    } else if (key === 'startYear' || key === 'endYear') {
      const d = key === 'startYear' ? item.from : item.to;
      if (!d) continue;
      want = { value: d.year };
    } else {
      want = valueFor(key, item, kind, f);
      if (!want) continue;
    }
    if (!same(f, want)) out.push({ ref: f.ref, key, label: f.label, value: want.value, ...(want.alts ? { alts: want.alts } : {}) });
  }
  return out.sort((a, b) => ORDER.indexOf(a.key.replace(/Day$/, '')) - ORDER.indexOf(b.key.replace(/Day$/, '')));
}

function valueFor(key, item, kind, f) {
  const yesNo = (yes) => (f.kind === 'checkbox' ? { value: yes ? 'yes' : 'no' } : { value: yes ? 'Yes' : 'No' });
  if (kind === 'work') {
    switch (key) {
      case 'company': return { value: item.company };
      case 'title': return { value: item.title, alts: [item.short] };
      case 'location': return item.location ? { value: item.location } : null;
      case 'city': return item.city ? { value: item.city } : null;
      case 'state': return item.state ? { value: item.state } : null;
      case 'country': return item.us ? { value: 'United States', alts: ['United States of America', 'USA', 'US'] } : null;
      case 'current': return yesNo(item.current);
      case 'description': return item.description ? { value: item.description } : null;
      default: return null;
    }
  }
  if (kind === 'edu') {
    switch (key) {
      case 'school': return { value: item.school };
      // Pills read "Bachelors" (Oracle); dropdowns "Bachelor's Degree" / "Bachelor of Science (BS)" (Workday, iCIMS).
      case 'degree': return item.bachelor ? (f.kind === 'buttons' ? { value: 'Bachelors', alts: ["Bachelor's Degree", "Bachelor's", 'Bachelor', item.degree] } : { value: item.degree, alts: ['Bachelors', "Bachelor's Degree", "Bachelor's", 'Bachelor', 'BS'] }) : item.degree ? { value: item.degree } : null;
      case 'major': return item.major ? { value: item.major } : null;
      case 'gpa': return item.gpa ? { value: item.gpa } : null;
      case 'minor': return item.minor ? { value: item.minor } : null;
      case 'graduated': return yesNo(item.graduated);
      case 'city': return item.city ? { value: item.city } : null;
      case 'state': return item.state ? { value: item.state } : null;
      case 'country': return item.us ? { value: 'United States', alts: ['United States of America', 'USA', 'US'] } : null;
      default: return null;
    }
  }
  if (kind === 'cert') {
    if (key === 'name') return { value: item.name, alts: [item.short] };
    if (key === 'issuer') return { value: item.issuer };
  }
  return null;
}

/** How well an entry's visible text (tile title / subtitle, its identity boxes) names `item`: 0 = not at all. */
function score(text, item, kind) {
  const t = ' ' + nm(text) + ' ';
  const has = (w) => t.includes(' ' + w + ' ');
  if (kind === 'cert') return t.replace(/\s/g, '').includes(nm(item.short).replace(/\s/g, '')) ? 2 : 0;
  const org = nm(kind === 'edu' ? item.school : item.company).split(' ');
  // "EXU" for Example State University; the first word otherwise ("quillstone", "gamma").
  const orgHit = has(org[0]) || (org.length > 2 && has(org.map((w) => w[0]).join(''))) ? 1 : 0;
  const words = nm(kind === 'edu' ? item.major : item.title).split(' ').filter((w) => w.length > 2 && !/^(and|the|for|intern)$/.test(w));
  const hit = words.length ? words.filter(has).length / words.length : 0;
  return orgHit + hit;
}

/** An entry's start as { m, year } from its date boxes (one MM/YYYY box, or Month + Year boxes), else null. */
function entryStart(e, kind) {
  let m = null;
  let y = null;
  for (const f of e.fields || []) {
    const k = repKey(f, kind);
    if (!k || typeof k !== 'object' || (k.when && k.when !== 'start') || !f.value) continue;
    const v = String(f.value);
    if (k.part === 'full') {
      const hit = v.match(/(\d{1,2})\s*\/\s*(?:\d{1,2}\s*\/\s*)?(\d{4})/) || v.match(/^(\d{4})-(\d{2})/);
      if (hit) return hit[1].length === 4 ? { m: Number(hit[2]), year: hit[1] } : { m: Number(hit[1]), year: hit[2] };
    } else if (k.part === 'month' && m == null) {
      const n = Number(v) || MONTH_NAMES.findIndex((x) => x.slice(0, 3).toLowerCase() === v.slice(0, 3).toLowerCase()) + 1;
      if (n) m = n;
    } else if (k.part === 'year' && y == null && /^\d{4}$/.test(v.trim())) y = v.trim();
    if (m != null && y != null) return { m, year: y };
  }
  if (!e.fields && e.subtitle) {
    const hit = String(e.subtitle).match(/(\d{1,2})\/(\d{4})/);
    if (hit) return { m: Number(hit[1]), year: hit[2] };
  }
  return null;
}

/** entry index -> item index (-1: names no item). Best pairs first, so two EXU jobs each find their own entry. */
function assign(entries, items, kind) {
  const text = (e) => [e.title, e.subtitle, ...(e.fields || []).filter((f) => IDENTITY.has(repKey(f, kind))).map((f) => f.value)].join(' ');
  const pairs = [];
  entries.forEach((e, i) => items.forEach((it, j) => {
    let s = score(text(e), it, kind);
    // Two jobs at one employer with the same short title (EXU "Research Assistant" x2, DUNVALE 2026-10-09: their
    // descriptions went to each other's entry): the entry's start date tells them apart.
    const st = kind === 'work' && s >= 0.5 && it.from ? entryStart(e, kind) : null;
    if (st) s += st.m === it.from.m && String(st.year) === String(it.from.year) ? 1 : -0.25;
    if (s >= 0.5) pairs.push([s, i, j]);
  }));
  pairs.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]);
  const out = entries.map(() => -1);
  const used = new Set();
  for (const [, i, j] of pairs) if (out[i] < 0 && !used.has(j)) {
    out[i] = j;
    used.add(j);
  }
  return out;
}

/** Does a saved Oracle tile already read right? Title / subtitle name the item; no "Fields to fix". */
function tileRight(e, item, kind) {
  if (e.invalid || /^unnamed\b/i.test(e.title || '')) return false;
  const t = ' ' + nm(`${e.title} ${e.subtitle}`) + ' ';
  const need = kind === 'work' ? [item.company.split(/[\s(]/)[0], item.short] : kind === 'edu' ? [item.school, item.major] : [item.short];
  return need.filter(Boolean).every((w) => t.includes(' ' + nm(w) + ' '));
}

function nextRepeaterAction(sections, facts, memo) {
  for (const k of ['fills', 'saves', 'edits', 'adds', 'failed', 'pending', 'deletes']) memo[k] = memo[k] || {};
  for (const sec of sections || []) {
    const kind = sec.kind;
    const items = (facts && facts[kind]) || [];
    if (!items.length) continue;
    // Workday's certification picker lists issuing bodies, not certificates (DRIFTRIDGE 2026-10-09): left to the owner.
    if (sec.ats === 'workday' && kind === 'cert') continue;
    const at = (i) => `${kind}:${i}`;
    const what = (i) => (kind === 'work' ? `${items[i].title} @ ${items[i].company}` : kind === 'edu' ? items[i].school : items[i].name);

    // Oracle: the open inline form (one at a time) is finished first: fill, Save; Cancel when it will not take.
    // No form open: the item an earlier Add / Edit was for is done (a form that opens later is matched by its values).
    if (!(sec.open && sec.open.fields && sec.open.fields.length)) memo.pending[kind] = null;
    else {
      let i = memo.pending[kind];
      if (i == null) {
        const a = assign([{ title: '', subtitle: '', fields: sec.open.fields }], items, kind)[0];
        i = a >= 0 ? a : null;
      }
      if (i == null) {
        if (sec.open.cancel && !memo.failed[`${kind}:open`]) {
          memo.failed[`${kind}:open`] = 1;
          return { do: 'click', ref: sec.open.cancel, why: 'cancel', kind, note: 'an open form that is none of the facts' };
        }
        continue;
      }
      const sets = entrySets(sec.open.fields, items[i], kind, sec.ats);
      const fills = memo.fills[at(i)] || 0;
      // A name the form will not take (a certificate missing from its catalogue) after one try: give this item up.
      const stuck = fills >= 1 && sets.some((x) => IDENTITY.has(x.key));
      if (!stuck && sets.length && fills < 2) {
        memo.fills[at(i)] = fills + 1;
        return { do: 'fill', sets, why: 'fill', kind, item: i, note: what(i) };
      }
      const saves = memo.saves[at(i)] || 0;
      if (!stuck && sec.open.save && saves < 2) {
        memo.saves[at(i)] = saves + 1;
        return { do: 'click', ref: sec.open.save, why: 'save', kind, item: i, note: what(i) };
      }
      memo.failed[at(i)] = 1;
      memo.pending[kind] = null;
      if (sec.open.cancel) return { do: 'click', ref: sec.open.cancel, why: 'cancel', kind, item: i, note: `${what(i)}: the form would not take it` };
      continue;
    }

    const entries = sec.entries || [];
    const map = assign(entries, items, kind);
    const used = new Set(map.filter((j) => j >= 0));
    const missing = items.map((_, j) => j).filter((j) => !used.has(j) && !memo.failed[at(j)]);
    // Entries that name no fact: Workday / generic boxes are rewritten for a missing item (cheaper than delete + add);
    // Oracle tiles ("Unnamed License" with made-up dates) are deleted and added fresh.
    const reuse = sec.ats !== 'oracle';
    const extra = [];
    entries.forEach((e, i) => {
      if (map[i] >= 0) return;
      if (reuse && missing.length && e.fields && e.fields.length) map[i] = missing.shift();
      else extra.push(i);
    });
    // 1. Extra entries go, last first (indexes stay valid for the ones before).
    for (const i of extra.reverse()) {
      const e = entries[i];
      const key = `${kind}:del:${e.del}`;
      if (e.del && !memo.deletes[key]) {
        memo.deletes[key] = 1;
        return { do: 'click', ref: e.del, why: 'delete', kind, note: [e.title, e.subtitle].filter(Boolean).join(' / ') || 'empty entry' };
      }
    }
    // 2. Entries that name an item get its facts.
    for (let i = 0; i < entries.length; i++) {
      const j = map[i];
      if (j < 0) continue;
      const e = entries[i];
      if (e.fields && e.fields.length) {
        const sets = entrySets(e.fields, items[j], kind, sec.ats);
        if (sets.length && (memo.fills[at(j)] || 0) < 2) {
          memo.fills[at(j)] = (memo.fills[at(j)] || 0) + 1;
          return { do: 'fill', sets, why: 'fill', kind, item: j, note: what(j) };
        }
      } else if (e.edit && !tileRight(e, items[j], kind) && !memo.edits[at(j)]) {
        memo.edits[at(j)] = 1;
        memo.pending[kind] = j;
        return { do: 'click', ref: e.edit, why: 'edit', kind, item: j, note: `${what(j)} (tile read "${[e.title, e.subtitle].filter(Boolean).join(' / ')}")` };
      }
    }
    // 3. Items no entry holds: Add (Workday adds an empty block; Oracle opens the inline form for it).
    if (missing.length && sec.add && (memo.adds[kind] || 0) < items.length + 2) {
      memo.adds[kind] = (memo.adds[kind] || 0) + 1;
      memo.pending[kind] = missing[0];
      return { do: 'click', ref: sec.add, why: 'add', kind, item: missing[0], note: what(missing[0]) };
    }
  }
  return null;
}

module.exports = { planHistory, blocks, place, monthYear, ym, resumeJsonFor, workdayJunkBlocks, formJobs, formEducation, formCerts, formEmployer, formTitle, formFacts, repKey, entrySets, assign, tileRight, nextRepeaterAction, STATES };
