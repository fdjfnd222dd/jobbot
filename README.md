# jobbot

A local, privacy-first driver that fills out job applications in Firefox from the command line, with a human approving every posting and handling anything it cannot answer truthfully.

## Architecture

```
jobctl (CLI)  ──unix socket──>  host/jobbot-host.js  ──native messaging──>  extension (jobbot-agent@local)
                                                                            └─ agent/page.js + Formhand core/adapters, in every frame
```

## Parts

| Path | What |
|---|---|
| `bin/jobctl` | The CLI (`jobctl help`). |
| `lib/apply.js` | The driver loop: landing, email gate / sign-in / create account, form steps, submit, confirmation. Stops with a JSON report when it needs a decision. Hands captchas and emailed security codes to the user. |
| `lib/urls.js` | ATS detection, tracking-link unwrapping (LinkedIn, Google, Outlook), direct form URLs (Lever, Ashby, Workable, Rippling, Jobvite, Taleo, Greenhouse). |
| `lib/discover.js`, `lib/find.js` | Find open postings from public ATS APIs and resolve a listing to its real application URL. |
| `extension/agent/` | MV2 extension: `background.js` (native port, tabs, injection), `page.js` (snapshot, fill, set, click, upload, sign-in). |
| `extension/core`, `extension/adapters` | The form engine, copied from Formhand (see below). Do not edit here. |
| `host/` | Native-messaging host. `jobctl install` registers it with Firefox. |
| `lib/secrets.js` | One generated password per site, stored in the system keyring via `secret-tool`. |
| `tailor/` | Resume and cover-letter DOCX/PDF pipeline, with a "never untrue" linter (see `tailor/README.md`). |
| `config/boards.json` | Public ATS board slugs that `jobctl discover` searches. Edit to taste. |
| `docs/ATS-FLOWS.md` | Per-ATS research notes (account needs, bot defences, success signals). |
| `tests/` | Driver unit tests and offline page tests on saved pages. |

## Install

Requirements: Linux, Firefox, Node.js 20+, `secret-tool` (libsecret) for the keyring, LibreOffice and poppler for `tailor/`.

```bash
git clone <this repo> ~/jobbot && cd ~/jobbot
(cd tailor && npm install)        # resume / cover letter rendering only
bash scripts/sync-formhand.sh     # copies core/, adapters/ and icons/ from a Formhand checkout (see below)
ln -s ~/jobbot/bin/jobctl ~/.local/bin/jobctl
jobctl install                    # register the native-messaging host
jobctl browser                    # start the dedicated job-hunt Firefox
jobctl doctor                     # check everything is wired up
```

Create your own `data/profile.json` (facts, standard answers, policy) and `data/resumes/master.json`; nothing personal ships with this repo. `tailor/references/facts.md` is an example of the facts bank the tailoring linter checks resumes against: replace it with your own confirmed facts.

## Usage

```bash
jobctl discover --brief            # open internships from config/boards.json
jobctl apply <url> --dry           # everything except the final Submit
jobctl status                      # what each run is waiting on
jobctl answer <ref> <value> --continue
jobctl test                        # fast tests; `jobctl test all` for everything
```

<details><summary><code>jobctl help</code></summary>

```
jobctl: job applications on autopilot (Firefox + Formhand engine)

Setup
  jobctl install                 register the native-messaging host with Firefox
  jobctl browser [stop]          start (or stop) the job-hunt Firefox with the extension
  jobctl doctor                  check everything is wired up
  jobctl reload                  restart the extension after editing extension/agent/

Finding
  jobctl discover [--role REGEX] [--city LIST] [--anywhere] [--all] [--max-age DAYS (default 7)]   open internships from config/boards.json (Greenhouse,
                                 Lever, Ashby, Workday, Oracle HCM, Phenom APIs), filtered to the owner's roles and cities,
                                 minus companies already applied to. Lists only; applies to nothing.
                                 --city "portland,austin,remote": only those places (metro names expand to suburbs:
                                 portland, austin, seattle, bay area, dc, nyc, richmond, chicago, raleigh/rtp, boston, remote; anything else is literal)
                                 Also reads the SimplifyJobs internship list (raw GitHub README, cached 1 h in
                                 data/simplify-cache.md); hits carry source:"simplify" and their Greenhouse / Ashby /
                                 Lever / Workday boards are added to config/boards.json. --no-simplify: boards only
                                 (a Simplify network failure only warns). 
                                 --new: only postings not seen before (saved to data/discover-latest.json);
                                 --notify: desktop notification (the daily timer uses --new --notify)
                                 --part-time: paid part-time work during the school year (remote by default, 30 days,
                                 Handshake Part-Time of any job type, $15/hr floor, spring terms allowed)
                                 --brief: one line per hit (JSON stays the default). Each run appends its funnel
                                 (hits, skips by reason, applyable) to data/discover-funnel.jsonl

  jobctl handshake [--query "Q1,Q2"] [--max-age N] [--city LIST] [--brief]   internships on Handshake (EXU's board) through
                                 the logged-in jobbot Firefox: searches the owner's roles (or --query), same filters / skips /
                                 output as discover (source:"handshake"; applyVia handshake = native apply on Handshake,
                                 external = the employer's ATS link in url). discover includes Handshake by default
                                 (--no-handshake: skip it). Logged out: exit 11, the owner logs in once in the jobbot window.
  jobctl find "<company>" "<title>" [--city X] [--json]   resolve a LinkedIn listing to its real ATS posting:
                                 config/boards.json, then slug guesses on Greenhouse / Ashby / Lever, then Workday
                                 tenants; fuzzy title match; prints the apply URL, the posting summary and runner-ups.
                                 Newly found boards are added to config/boards.json. --json: raw JSON only.

Replies (read-only; the /inbox skill drives these)
  jobctl inbox-query             print the Gmail search query (since data/inbox-state.json lastCheck, default 14 days back;
                                 ATS senders + keywords, minus promotions / job alerts / digests)
  jobctl inbox-plan <emails.json> <rows.json|rows-dir>   classify the emails, match them to tracker rows and print
                                 {updates, unmatched, counts, deadlines} as JSON. Writes nothing.
  jobctl inbox-done              record lastCheck=now in data/inbox-state.json

Applying
  jobctl posting <url> [--text]  read a posting via its ATS API (no tab): pay/hr, age, flags, gate
  jobctl tailor <url> [--build <slug> [--from <prior>] [--company C] [--text-file F] [--force] [--json]]
                                 rank facts.md alternates + skills for a posting; --build also writes a first-draft
                                 data/resumes/<slug>.json (best prior resume, skills reordered, grad date), renders
                                 it and lints it (exit 2 = lint failed, else render.sh's code). A second posting at
                                 a company gets its own name (PatExample_Resume_<Co>_<RoleTag>); a slug of
                                 another posting is never overwritten (<slug>-2). Prints bullets by id, posting
                                 keywords, the best alternates, todo, and the report block the tailor returns.
  jobctl tailor --finish <slug> [--edits <file|->] [--json]   apply bullet edits ([{"id":"e1.0","text":"..."},
                                 {"id":"p0.1","drop":true}, {"after":"e1.1","text":"..."}]), render, lint, report.
                                 Exit 0 = ready (return the report), 2 = todo lists what to fix.
  jobctl tailor --check <resume.json> [--company C]   never-untrue lint (DO NOT CLAIM, em dash, invented numbers,
                                 other company, a line moved to another job); lists each reworded bullet with what
                                 it added / dropped vs its closest source (lines already reviewed in another
                                 tailored resume are counted as carried). Exit 2 on errors.
  jobctl jd <url>                open a posting, print its text (for tailoring), close it
  jobctl apply <url> [--resume F] [--cover F] [--transcript F] [--company C] [--role R] [--location L] [--no-submit] [--dry]
                                 --dry: everything except the final Submit (fills, uploads, creates accounts;
                                 owner OK 2026-10-07) for testing
  jobctl batch <file|urls...> [--no-submit] [--full]   apply to many links in a row; stops on none, reports all
  jobctl continue [run] [--no-submit|--submit] [--full]
                                 apply / batch / continue / answer / answer-batch / code print text by default: run,
                                 status, exit meaning, company, role, message, ONE LINE PER NEED (ref, kind, * required,
                                 label, value, tried/error, options as a JSON array), last shot, and a submitted run's
                                 tracker row (row: {docId, data}). A finished run closes its queue item.
                                 --json: the same as compact JSON; --full: the whole report.
  jobctl row [run] [--location "City, ST"] [--req ID]   the tracker row for a submitted run ({docId, data}),
                                 location from the posting (--location when the ATS has no API)
  jobctl rows --unlogged         JSON [{run, docId, data}] for submitted runs whose tracker row is not written yet
                                 (the first call marks the runs submitted before it as written: baseline)
  jobctl rows --logged <run...|all>   mark runs as written to the tracker (data/logged.json)
  jobctl queue [--all]           postings to apply to next (data/queue.json, survives /clear); --all includes done
  jobctl queue add <url> [--company C] [--role R] [--resume F] [--note N]   dedupes by posting
  jobctl queue rm <url|n>        remove an item (n = its number in jobctl queue)
  jobctl queue next              the first pending item as JSON (exit 1 when none)
  jobctl test [fast|all|<file or name>...]   run the tests through the shared lock (scripts/test.sh)
  jobctl answer <ref> <value> [--run R] [--no-save] [--continue]   fill a field the run asked about (saved to the
                                 bank, the run's company as {company}; --no-save for posting-specific answers)
  jobctl answer-batch [file|-] [--run R] [--continue]   many answers at once from a file or stdin:
                                 JSON [{"ref":"0:12","value":"Yes","save":false}]
                                 --continue (answer, answer-batch, code): when every answer went in, resume the run
                                 in the same call (= jobctl continue; --no-submit/--submit pass through) and print
                                 {answered, run} with continue's exit code; any failed answer: {answered,
                                 continued:false, reason}, exit 1, run left alone
  jobctl remember "<question>" "<answer>" [--company C]   add to the Q&A bank without a page
                                 (with --company, that name becomes {company} in both)
  jobctl answers [search] [--all]   counts of the Q&A bank by topic; a search word lists the matches; --all lists all
  jobctl hiccup "<what>" [--kind K] [--topic T] [--fix "idea"]   log a hiccup by hand (hand fixes on a run are logged by
                                 themselves); --resolve <key> "<fix>" closes a cluster
  jobctl session start [--brief] | report [--days N] [--save] [--md]   start marks a session (SessionStart hook) and
                                 lists open hiccups (--brief: 12 lines max: queue, tracker, scorecard trend, top hiccups);
                                 report groups this session's hiccups + driver stops for the fix pass; --save also
                                 appends the session's scorecard line (data/sessions/scorecard.jsonl)
  jobctl friction [--days N]     what keeps slowing applications down (data/friction.jsonl): fix the top item
  jobctl review-answers [--json] audit the bank: answers naming a company, DO NOT CLAIM items, duplicates
  jobctl forget <id> [id...]     remove bank entries (ids from review-answers)
  jobctl status [run] [--dry]    dashboard: recent runs, what each one is waiting for (every need; --dry: test runs
                                 too). With a run id (or last): that run's message and needs, one line each, options.
  jobctl runs                    recent runs;  jobctl show [run]  one run in full
  jobctl log [--all|--json]      the last 10 applications submitted (--all / --json: every one, as JSON)

Low level (current run's tab unless --tab N / --run R)
  jobctl snap [--text] [--brief] fields, buttons, signals of the page (--brief: one line per field)
  jobctl code <code> [--continue]   type an emailed security code / PIN into its box(es) (split boxes: one char
                                 each); --continue resumes the run (--run R or last) once every box is filled
  jobctl press <css selector>     click an element the snapshot does not list (script links)
  jobctl deep [label-regex|index value]   list / type into fields inside shadow roots (web-component forms snap cannot see)
  jobctl set <ref> <value> | click <ref> | options <ref> [search text] | upload <ref|resume|cover> <file>
  jobctl goto <url> | text | shot [file] | tabs | open <url>
  jobctl drop <run> [reason]     give up on a stopped run (stale posting / skipped) and close its tab
  jobctl tabs-clean              close every tab no unfinished run is waiting on (8 GB RAM)
  jobctl lane <run|last> [owner|work|done]   tab-group lane by hand: red NEEDS YOU (the owner acts in the tab),
                                 green JOBBOT WORKING, grey DONE; apply / continue set lanes themselves
  jobctl lanes                   re-sort every waiting run's tab into its lane (after a restart or reload)
  jobctl handoffs [--watch]      runs the owner handed back by dragging a red tab into JOBBOT WORKING (or DONE); --watch
                                 polls every 3 s, one line per hand-back (run it in a Monitor during /apply)
  jobctl html <ref> [--up N]     markup around a field (debugging a live site)
  jobctl capture <file.html>     save the page's HTML (offline test fixture; data/ or tests/fixtures/)
  jobctl pw <site>               make sure a site has a keyring password (never printed;
                                 the owner reads it in KWallet Manager)
```

</details>

## Safety and policy

- Never untrue: answers come only from your `data/profile.json`, `data/answers.json` and your facts bank. A factual question with no source stops the run and goes to you.
- Captchas and "verify you are human" puzzles are handed to you (run status `blocked`), never solved or worked around. Honeypot fields are never filled.
- Marketing, job-alert and "consider me for other roles" opt-ins are never ticked.
- `policy.autoSubmit` and `policy.autoConsent` in `data/profile.json` are set by you only.
- Passwords are generated per site and kept in the system keyring; they are never written to files or logs.
- Duplicate postings are refused unless `--force`.
- Respect each site's terms and any "no AI-written text" rule a posting states.

## Privacy

All data stays on your machine in `data/` (profile, answers, resumes, run logs, screenshots, the job-hunt Firefox profile, the applied tracker). `data/` and the usual personal file types (resumes, screenshots, profiles, secrets) are gitignored. jobbot makes no network calls of its own except to the public ATS endpoints and job pages you point it at.

## Built on Formhand

`extension/core/` and `extension/adapters/` are copies of the form-matching engine from [Formhand](https://github.com/fdjfnd222dd/formhand) (MIT). `scripts/sync-formhand.sh` re-copies them from a local Formhand checkout (`$FORMHAND_SRC`, default `~/autofill`); fix form-matching bugs upstream, then re-sync. The page tests in `tests/page.test.js` use Formhand's saved page fixtures and Playwright from that checkout, and are skipped when it is absent. Tests that need your own `data/profile.json` are skipped too.

## License

MIT, see `LICENSE`.
