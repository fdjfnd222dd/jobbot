# tailor: resume + cover letter rendering

Local resume + cover letter renderer. It turns JSON into a DOCX, then a PDF,
then a JPEG preview, then runs a layout check. Nothing here talks to the network.

## Use

```bash
cd ~/jobbot/tailor

# Resume: copy the master, edit the copy, render it
cp ../data/resumes/master.json ../data/resumes/ibm.json
bash render.sh ../data/resumes/ibm.json ../data/resumes/PatExample_Resume_IBM
#  -> PatExample_Resume_IBM.docx / .pdf / _preview-1.jpg, plus page count,
#     LONELY LINES and REPEATED VERBS. Look at the preview before you send it.

# Cover letter: see examples/cover_example.json for the fields
bash cover.sh my_letter.json ../data/resumes/PatExample_CoverLetter_IBM
```

### Fast path: `jobctl tailor` (first draft + never-untrue lint)

```bash
# Deterministic first draft: picks the best prior resume (or master), puts the skills the posting names first,
# applies the grad-date rule, writes data/resumes/<slug>.json, renders it and lints it. Prints a JSON summary.
jobctl tailor "<posting url>" --build acme [--from <prior-slug>] [--company "Acme"] [--force]
jobctl tailor --text-file posting.txt --company "Acme" --build acme   # portals with no ATS API (text from `jobctl jd`)

# The lint, on its own (also runs at the end of --build). Exit 2 = an error, 0 = ok (warnings are listed).
jobctl tailor --check ../data/resumes/acme.json --company Acme
```

`--build` never rewrites bullets: that stays a judgment call (the agent `.claude/agents/resume-tailor.md` does it).
It refuses to overwrite `<slug>.json` or `PatExample_Resume_<Company>.*` without `--force`. Its exit code is 2 when
the lint fails, else render.sh's (0 ok, 2 not one page, 1 failed, 127 no LibreOffice).

`--check` fails (exit 2) on: a DO NOT CLAIM / never-confirmed item from `facts.md` anywhere (also `Go` outside the skills
rows), an em dash, "Site Reliability", another company's name (from the file names in `data/resumes`), a file name that
names a different company than the target, a number found in neither `master.json` nor `facts.md`, a changed name /
contact / school / job title / dates / location, or a grad date other than the two `facts.md` allows. It only warns (and
lists, least similar first, each with its closest source line and a 0 to 1 score) for every bullet that is not verbatim
in `master.json` or a `facts.md` alternate, skills found in neither, and `May 2028`. Tests: `tests/tailor.test.js`.

Exit codes from both scripts: `0` ok, `1` build or convert failed, `2` not exactly one page,
`127` no LibreOffice. The bot should refuse to upload anything that does not exit 0.

## Files

| File | What |
|---|---|
| `build_resume.js` | JSON to DOCX. Copied from the skill; layout is unchanged. |
| `cover_letter.js` | Letter JSON to DOCX. Same header (name and contact) as the resume. `name`/`contact` default to `data/resumes/master.json`. |
| `common.js` | Shared font, page size and header. |
| `convert.sh` | Finds LibreOffice and converts DOCX to PDF. Sourced by both scripts. |
| `render.sh`, `cover.sh` | The full pipelines. |
| `lint.js` | The never-untrue lint behind `jobctl tailor --check` (pure functions; `lib/tailor.js` loads facts, master and the prior resumes). |
| `check_layout.py` | Page count, lonely lines and repeated verbs. Uses only poppler (`pdfinfo`, `pdftotext`), so no venv is needed. |
| `references/facts.md`, `ats.md` | Copies of the skill's references. Read `facts.md` before tailoring. |
| `../data/resumes/master.json` | The master resume, which is the source of truth. |

## PDF converter

`convert.sh` looks for LibreOffice in this order: `$SOFFICE`, `soffice` on PATH,
`~/.local/opt/libreoffice/*.AppImage`, and finally the Flathub app.

- **In use now:** the LibreOffice 25.8 "still" AppImage at `~/.local/opt/libreoffice/`
  (291 MB). It was installed without sudo on 2026-10-07. To remove it, delete the folder.
- **Optional system package:** `sudo bash ~/maintenance/install-libreoffice-20261007.sh`
  installs `libreoffice-fresh` with pacman, which updates during normal upgrades. Once it is
  installed, `soffice` on PATH takes priority and the AppImage can be deleted.
- **Not used:** Flatpak. Flathub is only set up system-wide, and the app alone is 804 MB
  installed, plus the freedesktop 25.08 runtime.

Each conversion takes about 3 seconds (measured 2026-10-09: DOCX build 0.14 s, LibreOffice 2.34 s, preview JPG 0.03 s,
layout check 0.06 s). LibreOffice's cold start is nearly all of it: two DOCX files in one `soffice` call took 2.41 s,
so batching saves a full start per extra file, while flags such as `--norestore --nologo` and skipping the preview
change nothing measurable. A resident LibreOffice would be faster but costs RAM, which this laptop does not have.
It uses a private profile in `~/.cache/jobbot-soffice`, so an open LibreOffice window can't block it.
A lock queues parallel runs.

## Fonts

Times New Roman isn't installed. LibreOffice substitutes Liberation Serif, which has the same
metrics, so line breaks and page fit don't change. The claude.ai PDF on the Desktop was made the
same way. Its text matches a local render of `master.json` exactly.

## Rules (from the skill)

- One page, with no lonely lines.
- To fix overflow, edit the wording. Never shrink the font or margins.
- Don't invent metrics. Check claims against `references/facts.md`.
- No em dashes. `cover.sh` warns if it finds one.
