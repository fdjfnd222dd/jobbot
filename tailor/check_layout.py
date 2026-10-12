"""Usage: python check_layout.py resume.pdf [resume.json]
Prints page count, any 'lonely lines' (a wrapped line whose last line is <= 4 words), and,
when the JSON is given, entries where 3+ bullets in a row start with the same verb.
Checks every wrapped line: bullets, coursework/education lines, and skills rows.
the owner hates lonely lines. Fix every one (tighten wording) before delivering.
Copied from the claude.ai skill resume-tailor on 2026-10-07. Needs only pdfinfo/pdftotext
(poppler), no Python packages. Local change: exits 2 when the PDF is not exactly 1 page."""
import json, re, subprocess, sys

pdf = sys.argv[1]
data = json.load(open(sys.argv[2])) if len(sys.argv) > 2 else None
info = subprocess.run(['pdfinfo', pdf], capture_output=True, text=True).stdout
pages_line = next((l for l in info.splitlines() if l.startswith('Pages')), 'Pages: ?')
print(pages_line)
pages = pages_line.split(':', 1)[1].strip()

txt = [l.rstrip() for l in subprocess.run(['pdftotext', '-layout', pdf, '-'],
                                          capture_output=True, text=True).stdout.splitlines()]
maxw = max((len(l) for l in txt), default=0)
GAP = re.compile(r'\S {3,}\S')  # right-aligned location/date lines
headings = {'Education', 'Experience', 'Projects', 'Certifications and Awards',
            'Technical Skills', 'Leadership'}
standalone = set(headings)
if data:
    for p in data.get('projects', []):
        standalone.add(p['name'].strip())

bad = []
for i in range(1, len(txt)):
    l, prev = txt[i], txt[i - 1]
    s, ps = l.strip(), prev.strip()
    if not s or not ps or s in standalone or s.startswith('-') or GAP.search(s):
        continue
    if GAP.search(ps) or ps in standalone:
        continue
    # a continuation line: it follows a line that ran (nearly) to the right margin, or it is an
    # indented line under a bullet (pdftotext indents wrapped bullet/skills text; the widest lines
    # are the right-aligned date lines, so the margin test alone missed wrapped skills rows)
    wrapped = len(prev) >= 0.85 * maxw or (l[:1] == ' ' and (ps.startswith('-') or prev[:1] == ' '))
    if wrapped and len(s.split()) <= 4:
        bad.append(s)
print('LONELY LINES:\n' + '\n'.join('  -> ' + b for b in bad) if bad else 'No lonely lines.')

if data:
    warn = []
    groups = [(j['company'], j['bullets']) for j in data.get('experience', [])]
    groups += [(p['name'], p['bullets']) for p in data.get('projects', [])]
    for name, bullets in groups:
        verbs = [b.split()[0] for b in bullets if b.split()]
        for k in range(len(verbs) - 2):
            if verbs[k] == verbs[k + 1] == verbs[k + 2]:
                warn.append(f'{name}: 3+ bullets in a row start with "{verbs[k]}"')
                break
    if warn:
        print('REPEATED VERBS:\n' + '\n'.join('  -> ' + w for w in warn))

if pages != '1':
    print(f'NOT ONE PAGE ({pages}). Cut the weakest bullet for this posting; do not shrink font or margins.')
    sys.exit(2)
