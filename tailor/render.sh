#!/usr/bin/env bash
# render.sh <resume.json> <outBase>
#   e.g. bash render.sh ~/jobbot/data/resumes/ibm.json ~/jobbot/data/resumes/PatExample_Resume_IBM
# Builds <outBase>.docx -> <outBase>.pdf -> <outBase>_preview-1.jpg (+ <outBase>.json, the source facts),
# then runs the layout check.
#
# Local version of the claude.ai skill's scripts/render.sh (resume-tailor). Changes:
#   - PDF conversion goes through convert.sh (finds the AppImage / system LibreOffice, uses a
#     private profile, fails loudly instead of silently when no converter exists)
#   - exits non-zero when the result is not exactly one page, so the bot can refuse to upload it
# Exit codes: 0 ok (read the LONELY LINES / REPEATED VERBS output anyway), 1 build/convert failed,
#             2 not one page, 127 no LibreOffice.
set -eo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
[[ $# -eq 2 ]] || { echo "usage: bash render.sh <resume.json> <outBase>" >&2; exit 1; }
JSON="$1"; OUT="$2"
[[ -f "$JSON" ]] || { echo "ERROR: no such file: $JSON" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"
OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"   # absolute: LibreOffice needs a real outdir
source "$DIR/convert.sh"

rm -f "$OUT"_preview*.jpg   # stale page-2 previews from an earlier overflow are misleading
node --no-warnings "$DIR/build_resume.js" "$JSON" "$OUT.docx"
# The facts behind this file, next to it: jobbot rewrites what iCIMS's resume parser scrambles from it.
[[ "$(cd "$(dirname "$JSON")" && pwd)/$(basename "$JSON")" == "$OUT.json" ]] || cp "$JSON" "$OUT.json"
to_pdf "$OUT.docx" || exit $?
echo "wrote $OUT.pdf"
pdftoppm -jpeg -r 90 "$OUT.pdf" "${OUT}_preview"
ls "$OUT"_preview*
python3 "$DIR/check_layout.py" "$OUT.pdf" "$JSON"   # exits 2 when not exactly one page
