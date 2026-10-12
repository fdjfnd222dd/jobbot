'use strict';
/**
 * `--continue` on `jobctl answer`, `answer-batch` and `code`: enter the answers, then resume the run in the
 * same process. Every stop used to cost two Claude turns (answer, then `jobctl continue`); now it costs one
 * (Fable audit, 2026-10-08). Pure decisions only, so they test without a browser; bin/jobctl does the I/O.
 */

/**
 * Flags that never take a value: `answer-batch --continue answers.json` must keep the file as an argument.
 * (`--full`, `--brief`, `--save`, `--logged`, `--unlogged` too: `jobctl apply --full <url>` must keep the URL.)
 */
const BOOL = ['no-submit', 'submit', 'no-save', 'text', 'json', 'force', 'dry', 'anywhere', 'all', 'new', 'notify', 'simplify', 'no-simplify', 'no-detail', 'continue', 'full', 'brief', 'save', 'md', 'logged', 'unlogged', 'watch', 'owner'];

/** jobctl's argv parser: `--k v` sets flags.k = v, a BOOL flag or one followed by another `--` flag is true. */
function parse(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v != null && !v.startsWith('--') && !BOOL.includes(k)) {
        flags[k] = v;
        i++;
      } else flags[k] = true;
    } else args.push(a);
  }
  return { args, flags };
}

/** Exit code per run status (shared by apply / continue / --continue). Unknown statuses exit 1. */
const EXIT = { submitted: 0, already_applied: 0, closed: 0, needs_input: 10, needs_review: 10, blocked: 11, ready_to_submit: 12 };

function exitCode(status) {
  return EXIT[status] == null ? 1 : EXIT[status];
}

/**
 * Did the answers / code go in? answer-batch output has `failed` (array); answer and code output have `ok`.
 * Returns { ok, reason } so a refusal can say why the run was left alone.
 */
function answered(output) {
  if (!output) return { ok: false, reason: 'no answer output' };
  if (Array.isArray(output.failed)) {
    if (output.failed.length) return { ok: false, reason: `${output.failed.length} answer(s) failed: ${output.failed.map((f) => f.ref).filter(Boolean).join(', ') || '?'}` };
    return { ok: true };
  }
  if (output.ok) return { ok: true };
  const why = output.error || output.message || (output.boxes != null ? `filled ${output.filled || 0} of ${output.boxes} code boxes` : null);
  return { ok: false, reason: 'answer failed' + (why ? ': ' + why : '') };
}

/**
 * The one JSON object (and exit code) a `--continue` command prints.
 * report: the `continue` report (lib/apply resume()), or null when the answers failed and the run was not resumed.
 */
function combine(output, report) {
  const a = answered(output);
  if (!a.ok || !report) return { json: { answered: output, continued: false, reason: a.reason || 'not resumed' }, code: 1 };
  return { json: { answered: output, run: report }, code: exitCode(report.status) };
}

module.exports = { EXIT, exitCode, answered, combine, parse };
