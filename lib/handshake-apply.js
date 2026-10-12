'use strict';
/*
 * Native Handshake applications (jobs whose jobApplySetting.applyType is HANDSHAKE): the driver half.
 * lib/apply.js drive() asks `kind()` what a Handshake page is before its own switch, and runs `stepModal()` for
 * the Apply modal. Everything else (the job page's Apply button, the questions, Submit with its --dry / --no-submit
 * / policy gates) is the generic driver's.
 *
 * The modal (2026-10-09, Driftmere SWE intern): "Apply to <employer>", one fieldset per required document. Handshake
 * pre-picks the document used last ("NB_Resume_26.pdf", a green chip with a Close button); jobbot removes it and
 * uploads this run's resume (the tailored one) through the slot's "Upload new" file input (max 1 MB). A transcript
 * slot gets profile.documents.transcript; a cover-letter slot gets --cover; neither on hand -> needs_input. Then
 * employer questions (answer bank / needs) and "Submit Application".
 * Whether the application went in is read from Handshake itself (GraphQL currentUser.applications for the job),
 * not only from the "Application submitted!" toast, which fades.
 */
const fs = require('node:fs');
const path = require('node:path');
const H = require('./handshake');
const D = require('./data');
const { ROOT } = require('./paths');

const MAX_BYTES = 1024 * 1024; // Handshake: "Max file size: 1 MB"

/** resume / transcript / cover from a document slot's heading ("Attach your resume"). */
function slotKind(heading) {
  const t = String(heading || '').toLowerCase();
  if (/transcript/.test(t)) return 'transcript';
  if (/cover/.test(t)) return 'cover';
  if (/resume|résumé|\bcv\b/.test(t)) return 'resume';
  return 'other';
}

/** The file this run should attach for a slot kind, or null. */
function fileFor(which, run, p) {
  if (which === 'resume') return run.resume || p.documents.resume || null;
  if (which === 'transcript') return run.transcript || (p.documents && p.documents.transcript) || null;
  if (which === 'cover') return run.cover || null;
  return null;
}

const abs = (f) => (path.isAbsolute(f) ? f : path.join(ROOT, f));

/**
 * What to do with each document slot, pure (tests): [{slot, which, action: keep|remove|upload|need|too_big, file}].
 * A slot holding the file this run uploaded is kept; any other document (Handshake's pre-pick) is removed first.
 */
function planDocs(docs, run, p, sizeOf) {
  const size = sizeOf || ((f) => fs.statSync(abs(f)).size);
  return (docs || []).map((slot) => {
    const which = slotKind(slot.heading);
    const file = fileFor(which, run, p);
    if (!file) return { slot, which, action: 'need' };
    // Kept only when this run uploaded it: a pre-picked document with the same file name can be an older version
    // (Handshake keeps every upload; a re-upload of a name shows as "name (1)").
    if (slot.attached && (run.hsUploaded || {})[which]) return { slot, which, action: 'keep', file };
    if (slot.attached && slot.removeRef) return { slot, which, action: 'remove', file };
    let bytes = 0;
    try {
      bytes = size(file);
    } catch (e) {
      return { slot, which, action: 'missing', file };
    }
    if (bytes > MAX_BYTES) return { slot, which, action: 'too_big', file, bytes };
    if (slot.uploadRef) return { slot, which, action: 'upload', file };
    return { slot, which, action: 'need', file };
  });
}

/** Is this run's application in on Handshake? (GraphQL from the run's own tab.) null when it cannot tell. */
async function appliedOnHandshake(run, url) {
  const id = H.jobIdOf(url || run.url);
  if (!id) return null;
  try {
    return await H.applicationFor(H.tabFetcher(run.tabId, new URL(url || run.url).hostname), id);
  } catch (e) {
    return null;
  }
}

/**
 * The kind of a Handshake page, refining classify(): hs_login (logged out), done (submitted: toast or Handshake
 * lists the application), already (applied before this run), hs_modal (the Apply modal is open). Other pages and
 * other sites keep `kind`.
 */
async function kind(run, snap, k) {
  if (!H.isHandshake(snap.url)) return k;
  let p;
  try {
    p = new URL(snap.url).pathname;
  } catch (e) {
    return k;
  }
  if (/^\/(login|access|sign_in|sessions)\b/.test(p)) return 'hs_login';
  if (k === 'done' || k === 'captcha') return k;
  if (run.submitPressedAt && (await appliedOnHandshake(run, snap.url))) return 'done';
  const A = require('./apply');
  const st = await A.call(run.tabId, 0, 'handshakeState', {}).catch(() => null);
  if (st && st.modal) return 'hs_modal';
  if (!run.submitPressedAt && !run.hsAppliedChecked) {
    run.hsAppliedChecked = true;
    const app = await appliedOnHandshake(run, snap.url);
    if (app) {
      run.hsApplication = app;
      return 'already';
    }
  }
  return k;
}

/** One pass over the Apply modal: documents first, then the generic form step (questions, Submit). */
async function stepModal(run, snap) {
  const A = require('./apply');
  const p = D.profile();
  const st = await A.call(run.tabId, 0, 'handshakeState', {});
  if (!st || !st.modal) return null; // closed meanwhile: look again
  if (st.notes && st.notes.length && !run.hsNotes) {
    run.hsNotes = st.notes;
    A.log(run, 'handshake', `modal note: ${st.notes.join(' | ')}`);
  }
  run.hsDocTries = run.hsDocTries || {};
  const needs = [];
  for (const d of planDocs(st.docs, run, p)) {
    const key = `${d.which}:${d.action}`;
    if (d.action === 'keep') {
      run.uploads[`${A.uploadPage(snap.url)}#${d.which}`] = path.basename(d.file); // the generic step must not re-upload
      continue;
    }
    if ((run.hsDocTries[key] = (run.hsDocTries[key] || 0) + 1) > 3) {
      return A.stop(run, 'needs_input', `Handshake ${d.which} slot did not take the file after 3 tries: attach ${d.file ? path.basename(d.file) : 'it'} in the window, then \`jobctl continue\``, snap, [{ type: 'file', label: d.slot.heading, for: d.which, kind: 'file', required: true }]);
    }
    if (d.action === 'remove') {
      A.log(run, 'handshake', `remove pre-picked ${d.which} "${d.slot.attached}" (attaching ${path.basename(d.file)})`);
      await A.click(run, `0:${d.slot.removeRef}`, { tab: false });
      await A.settle(run.tabId, { quiet: 500, max: 4000 });
      return null;
    }
    if (d.action === 'upload') {
      const res = await A.upload(run, 0, d.which === 'other' ? 'resume' : d.which, d.file, d.slot.uploadRef).catch((e) => ({ ok: false, error: e.message }));
      A.log(run, 'upload', `${d.which} -> Handshake "${d.slot.heading}" ${res && res.ok ? 'ok' : 'FAILED ' + ((res && res.error) || '')}`);
      if (res && res.ok) {
        run.uploads[`${A.uploadPage(snap.url)}#${d.which}`] = path.basename(d.file);
        run.hsUploaded = { ...(run.hsUploaded || {}), [d.which]: path.basename(d.file) };
      }
      await A.settle(run.tabId, { quiet: 1000, max: 8000 });
      return null;
    }
    if (d.action === 'too_big') {
      needs.push({ type: 'file', label: `${d.slot.heading}: ${path.basename(d.file)} is ${Math.round(d.bytes / 1024)} KB, Handshake takes 1 MB at most`, for: d.which, kind: 'file', required: true });
      continue;
    }
    needs.push({ type: d.which === 'transcript' ? 'transcript' : d.which === 'cover' ? 'cover_letter' : 'file', label: d.slot.heading, for: d.which, kind: 'file', required: true, ...(d.action === 'missing' ? { note: `file not found: ${d.file}` } : {}) });
  }
  if (needs.length) return A.stop(run, 'needs_input', `Handshake wants ${needs.map((n) => n.for).join(' + ')}: give the file (--transcript / --cover, or profile.documents), then \`jobctl continue\``, snap, needs);
  // Questions and Submit: the generic form step. Its findNav takes the LAST button matching SUBMIT, and the modal
  // sits at the end of the page, so "Submit Application" wins over the job page's own "Apply" behind it.
  return A.stepForm(run, snap);
}

module.exports = { slotKind, fileFor, planDocs, kind, stepModal, appliedOnHandshake, MAX_BYTES };
