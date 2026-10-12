/*
 * core/storage.js
 *
 * Everything lives in browser.storage.local (never sync, never network).
 *
 * Layout (one key per top-level section):
 *   schemaVersion    number   bump + add a step to MIGRATIONS when the shape changes
 *   profiles         array    [{ id, name, data }]   data: see EMPTY_PROFILE
 *   activeProfileId  string   which profile fills pages (popup picker)
 *   qaBank           object   { entries: [QAEntry] }  shared by every profile
 *   settings         object   { learnMode: boolean, companies: [string] }
 *                             companies: hiring companies seen by fill passes (newest
 *                             first, at most MAX_COMPANIES); the options page offers to
 *                             turn Q&A entries naming one into the {company} form.
 *   standardAnswers  object   { [questionId]: answerId }  shared by every profile;
 *                             questions are defined in core/standard.js. '' = leave blank.
 *
 * QAEntry:
 *   { id, question, aliases: [], answer, sensitive, createdAt, updatedAt }
 *   `question` and `aliases` are stored already normalized (core/matcher.js
 *   normalize()). `sensitive` is a category or '' (see core/qa.js).
 *
 * Several writers exist at once (options page, popup, learn mode inside a
 * page). Every write here re-reads the stored value immediately before it
 * changes it, so a stale copy held by one writer never wipes another's work.
 * Pages that display data listen to browser.storage.onChanged and reload.
 */
(function (root) {
  'use strict';

  const AF = (root.AF = root.AF || {});

  const SCHEMA_VERSION = 3;

  const EMPTY_PROFILE = Object.freeze({
    firstName: '',
    middleName: '',
    lastName: '',
    preferredName: '',
    email: '',
    phone: '',
    phoneType: '', // "Mobile" | "Home" | "Work": Workday/Phenom "Phone Device Type"
    addressLine1: '',
    addressLine2: '',
    city: '',
    state: '',
    postalCode: '',
    country: '',
    linkedin: '',
    github: '',
    portfolio: '',
    school: '',
    degree: '',
    major: '',
    minor: '',
    gradMonth: '', // "1".."12"
    gradYear: '',
    gpa: '',
  });

  const DEFAULT_PROFILE_ID = 'default';

  const DEFAULTS = {
    schemaVersion: SCHEMA_VERSION,
    profiles: [{ id: DEFAULT_PROFILE_ID, name: 'Default', data: { ...EMPTY_PROFILE } }],
    activeProfileId: DEFAULT_PROFILE_ID,
    qaBank: { entries: [] },
    settings: { learnMode: false, companies: [] },
    // Defaults for "have you worked here / for a client", "relatives employed
    // here" and "referred by an employee";
    // the user can blank them. Everything else starts blank (never filled).
    standardAnswers: { previouslyEmployed: 'no', clientEmployed: 'no', relatives: 'no', referred: 'no' },
  };

  // MIGRATIONS[n] upgrades data from version n to n+1. Keep old steps forever.
  const MIGRATIONS = {
    // v2 (Phase 2): profile.phoneType. Left empty: the user picks it.
    1(data) {
      if (data.profile && data.profile.phoneType == null) data.profile = { ...data.profile, phoneType: '' };
    },
    // v3 (Phase 3): one `profile` -> `profiles` list + `activeProfileId`.
    2(data) {
      if (!Array.isArray(data.profiles)) {
        data.profiles = [{ id: DEFAULT_PROFILE_ID, name: 'Default', data: { ...(data.profile || {}) } }];
        data.activeProfileId = DEFAULT_PROFILE_ID;
      }
      delete data.profile;
      data.removeKeys = ['profile'];
    },
  };

  function migrate(data) {
    const out = { ...data };
    let v = out.schemaVersion || 0;
    if (v === 0) v = out.profile ? 1 : SCHEMA_VERSION; // a pre-versioning profile is v1
    while (v < SCHEMA_VERSION) {
      MIGRATIONS[v](out);
      v++;
    }
    out.schemaVersion = SCHEMA_VERSION;
    return out;
  }

  function api() {
    return root.browser && root.browser.storage && root.browser.storage.local;
  }

  function cleanProfile(profile) {
    const clean = {};
    for (const k of Object.keys(EMPTY_PROFILE)) clean[k] = String((profile && profile[k]) || '').trim();
    return clean;
  }

  function newId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /** Raw stored data, migrated (and the migration written back once). */
  async function read() {
    const raw = await api().get([...Object.keys(DEFAULTS), 'profile']);
    const data = migrate(raw);
    if (raw.schemaVersion !== SCHEMA_VERSION && Object.keys(raw).length) {
      const removeKeys = data.removeKeys || [];
      delete data.removeKeys;
      await api().set({
        schemaVersion: SCHEMA_VERSION,
        profiles: data.profiles,
        activeProfileId: data.activeProfileId,
      });
      if (removeKeys.length && api().remove) await api().remove(removeKeys);
    }
    delete data.removeKeys;
    const profiles = (Array.isArray(data.profiles) && data.profiles.length ? data.profiles : DEFAULTS.profiles).map(
      (p) => ({ id: p.id, name: p.name || 'Profile', data: { ...EMPTY_PROFILE, ...(p.data || {}) } })
    );
    const active = profiles.find((p) => p.id === data.activeProfileId) || profiles[0];
    return {
      schemaVersion: SCHEMA_VERSION,
      profiles,
      activeProfileId: active.id,
      qaBank: { entries: [], ...(data.qaBank || {}) },
      settings: { ...DEFAULTS.settings, ...(data.settings || {}) },
      standardAnswers: { ...DEFAULTS.standardAnswers, ...(data.standardAnswers || {}) },
    };
  }

  /**
   * Everything a fill pass or a UI needs. `profile` is the ACTIVE profile's
   * data, `profileName` its name.
   */
  async function load() {
    const d = await read();
    const active = d.profiles.find((p) => p.id === d.activeProfileId);
    return { ...d, profile: active.data, profileName: active.name };
  }

  /** Save the data of one profile (default: the active one). */
  async function saveProfile(profile, id) {
    const d = await read();
    const target = id || d.activeProfileId;
    const clean = cleanProfile(profile);
    const profiles = d.profiles.map((p) => (p.id === target ? { ...p, data: clean } : p));
    await api().set({ schemaVersion: SCHEMA_VERSION, profiles });
    return clean;
  }

  /** Add a profile (copying `fromId`'s data if given). Resolves the new profile. */
  async function addProfile(name, fromId) {
    const d = await read();
    const src = fromId && d.profiles.find((p) => p.id === fromId);
    const p = { id: newId('p'), name: String(name || 'Profile').trim() || 'Profile', data: cleanProfile(src ? src.data : {}) };
    await api().set({ schemaVersion: SCHEMA_VERSION, profiles: d.profiles.concat(p) });
    return p;
  }

  async function renameProfile(id, name) {
    const d = await read();
    const profiles = d.profiles.map((p) => (p.id === id ? { ...p, name: String(name || '').trim() || p.name } : p));
    await api().set({ schemaVersion: SCHEMA_VERSION, profiles });
  }

  /** Delete a profile. The last one cannot be deleted. */
  async function deleteProfile(id) {
    const d = await read();
    if (d.profiles.length <= 1) throw new Error('Cannot delete the only profile');
    const profiles = d.profiles.filter((p) => p.id !== id);
    const activeProfileId = d.activeProfileId === id ? profiles[0].id : d.activeProfileId;
    await api().set({ schemaVersion: SCHEMA_VERSION, profiles, activeProfileId });
  }

  async function setActiveProfile(id) {
    const d = await read();
    if (!d.profiles.some((p) => p.id === id)) throw new Error('No such profile: ' + id);
    await api().set({ schemaVersion: SCHEMA_VERSION, activeProfileId: id });
  }

  async function saveSettings(patch) {
    const d = await read();
    const settings = { ...d.settings, ...(patch || {}) };
    await api().set({ settings });
    return settings;
  }

  const MAX_COMPANIES = 50;

  /** Note a hiring company a pass saw (no write when it is already the newest one). */
  async function rememberCompany(name) {
    const n = String(name || '').trim();
    if (!n) return null;
    const d = await read();
    const list = Array.isArray(d.settings.companies) ? d.settings.companies : [];
    if (list[0] === n) return list;
    const companies = [n].concat(list.filter((c) => c.toLowerCase() !== n.toLowerCase())).slice(0, MAX_COMPANIES);
    await api().set({ settings: { ...d.settings, companies } });
    return companies;
  }

  /** Merge { questionId: answerId } into the standard answers ('' blanks one). */
  async function saveStandardAnswers(patch) {
    const d = await read();
    const standardAnswers = { ...d.standardAnswers };
    for (const [k, v] of Object.entries(patch || {})) standardAnswers[k] = String(v == null ? '' : v);
    await api().set({ standardAnswers });
    return standardAnswers;
  }

  /**
   * Change the Q&A bank with fresh data: fn(entries) -> new entries.
   * Read-modify-write in one go so a stale copy never overwrites newer entries.
   */
  async function updateQA(fn) {
    const d = await read();
    const entries = fn(d.qaBank.entries.slice()) || [];
    await api().set({ qaBank: { ...d.qaBank, entries } });
    return entries;
  }

  /** Export everything except schema bookkeeping, as a plain object. */
  async function exportAll() {
    const d = await read();
    return {
      format: 'job-autofill-export',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      profiles: d.profiles,
      activeProfileId: d.activeProfileId,
      qaBank: d.qaBank,
      standardAnswers: d.standardAnswers,
      settings: d.settings,
    };
  }

  /**
   * Merge an export (or a seed file of the same shape) into storage.
   * Profiles: same name replaces that profile's data, new names are added.
   * Q&A: same normalized question replaces the answer (aliases are merged),
   * new questions are added. Standard answers present in the file replace
   * the stored ones. Nothing already stored is deleted.
   * Resolves { profilesAdded, profilesUpdated, qaAdded, qaUpdated }.
   */
  async function importAll(obj, normalize) {
    if (!obj || typeof obj !== 'object') throw new Error('Not an export file');
    const norm = normalize || ((s) => String(s || '').trim().toLowerCase());
    const d = await read();
    const report = { profilesAdded: 0, profilesUpdated: 0, qaAdded: 0, qaUpdated: 0 };

    const profiles = d.profiles.slice();
    for (const p of obj.profiles || []) {
      if (!p || !p.name) continue;
      const i = profiles.findIndex((q) => q.name === p.name);
      if (i >= 0) {
        profiles[i] = { ...profiles[i], data: cleanProfile(p.data) };
        report.profilesUpdated++;
      } else {
        profiles.push({ id: newId('p'), name: String(p.name), data: cleanProfile(p.data) });
        report.profilesAdded++;
      }
    }
    // A fresh install has one empty "Default": drop it once real profiles arrive.
    const blank = (p) => Object.values(p.data).every((v) => !v);
    const kept = profiles.filter((p) => !(p.id === DEFAULT_PROFILE_ID && blank(p) && profiles.length > 1));

    const now = Date.now();
    const entries = d.qaBank.entries.slice();
    for (const e of (obj.qaBank && obj.qaBank.entries) || []) {
      if (!e || !e.question || e.answer == null) continue;
      const question = norm(e.question);
      const aliases = (e.aliases || []).map(norm).filter(Boolean);
      const i = entries.findIndex((x) => x.question === question);
      if (i >= 0) {
        const merged = [...new Set([...(entries[i].aliases || []), ...aliases])];
        entries[i] = { ...entries[i], answer: String(e.answer), aliases: merged, sensitive: e.sensitive || entries[i].sensitive || '', updatedAt: now };
        report.qaUpdated++;
      } else {
        entries.push({
          id: e.id || newId('qa'), question, aliases, answer: String(e.answer),
          sensitive: e.sensitive || '', createdAt: e.createdAt || now, updatedAt: now,
        });
        report.qaAdded++;
      }
    }
    const activeProfileId = kept.some((p) => p.id === d.activeProfileId) ? d.activeProfileId : kept[0].id;
    const standardAnswers = { ...d.standardAnswers };
    for (const [k, v] of Object.entries(obj.standardAnswers || {})) standardAnswers[k] = String(v == null ? '' : v);
    await api().set({
      schemaVersion: SCHEMA_VERSION, profiles: kept, activeProfileId, qaBank: { ...d.qaBank, entries }, standardAnswers,
    });
    return report;
  }

  /**
   * Delete everything this extension stored (profiles, standard answers, the
   * Q&A bank, settings, schema bookkeeping). The next load() returns DEFAULTS,
   * as after a fresh install. Files exported earlier are not touched.
   */
  async function clearAll() {
    const store = api();
    if (store.clear) return store.clear();
    const all = await store.get(null);
    return store.remove(Object.keys(all || {}));
  }

  AF.storage = {
    SCHEMA_VERSION,
    EMPTY_PROFILE,
    DEFAULTS,
    migrate,
    load,
    saveProfile,
    addProfile,
    renameProfile,
    deleteProfile,
    setActiveProfile,
    saveSettings,
    rememberCompany,
    saveStandardAnswers,
    updateQA,
    exportAll,
    importAll,
    clearAll,
    newId,
  };

  if (typeof module === 'object' && module.exports) module.exports = AF.storage;
})(typeof globalThis !== 'undefined' ? globalThis : this);
