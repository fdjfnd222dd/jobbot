#!/usr/bin/env bash
# cover.sh <letter.json> <outBase>
#   e.g. bash cover.sh ~/jobbot/data/resumes/ibm_cover.json ~/jobbot/data/resumes/PatExample_CoverLetter_IBM
# Builds <outBase>.docx -> <outBase>.pdf -> <outBase>_preview-1.jpg and checks it is one page.
# Uses the same LibreOffice lookup as render.sh (convert.sh).
# Exit codes: 0 ok, 1 build/convert failed, 2 not one page, 127 no LibreOffice.
set -eo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
[[ $# -eq 2 ]] || { echo "usage: bash cover.sh <letter.json> <outBase>" >&2; exit 1; }
JSON="$1"; OUT="$2"
[[ -f "$JSON" ]] || { echo "ERROR: no such file: $JSON" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"
OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
source "$DIR/convert.sh"

# Writing rule shared with the resume: no em dashes. Warn, don't block.
grep -q '—' "$JSON" && echo "WARNING: em dash found in $JSON (writing rule: no em dashes)" >&2

rm -f "$OUT"_preview*.jpg
node --no-warnings "$DIR/cover_letter.js" "$JSON" "$OUT.docx"
to_pdf "$OUT.docx" || exit $?
echo "wrote $OUT.pdf"
pdftoppm -jpeg -r 90 "$OUT.pdf" "${OUT}_preview"
ls "$OUT"_preview*
pages="$(pdfinfo "$OUT.pdf" | awk '/^Pages:/{print $2}')"
echo "Pages: $pages"
[[ "$pages" == 1 ]] || { echo "NOT ONE PAGE ($pages). Shorten a paragraph." >&2; exit 2; }
