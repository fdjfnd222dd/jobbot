#!/usr/bin/env bash
# convert.sh — DOCX -> PDF with LibreOffice. Sourced by render.sh and cover.sh; not run directly.
#
# WHY a helper: this laptop has no system LibreOffice. The converter is found in this order:
#   1. $SOFFICE                         (override, e.g. SOFFICE=/path/to/soffice)
#   2. soffice / libreoffice on PATH    (present after ~/maintenance/install-libreoffice-20261007.sh)
#   3. ~/.local/opt/libreoffice/*.AppImage   (the no-sudo route, installed 2026-10-07)
#   4. the Flathub app org.libreoffice.LibreOffice, if someone installed it
# If none exists we stop with a message saying how to get one. No silent fallback,
# because a resume PDF that does not match the DOCX would be worse than no PDF.
#
# A private LibreOffice profile (~/.cache/jobbot-soffice) is used so a LibreOffice window
# the owner has open never blocks a headless conversion (the shared profile is locked
# while a window is open, and then the conversion silently does nothing).

JOBBOT_SOFFICE_PROFILE="file://${HOME}/.cache/jobbot-soffice"

find_soffice() {
  local a
  if [[ -n "${SOFFICE:-}" ]]; then echo "$SOFFICE"; return 0; fi
  for a in soffice libreoffice; do
    command -v "$a" >/dev/null 2>&1 && { command -v "$a"; return 0; }
  done
  for a in "$HOME"/.local/opt/libreoffice/*.AppImage; do
    [[ -x "$a" ]] && { echo "$a"; return 0; }
  done
  if command -v flatpak >/dev/null 2>&1 && flatpak info org.libreoffice.LibreOffice >/dev/null 2>&1; then
    echo "flatpak run --command=soffice org.libreoffice.LibreOffice"; return 0
  fi
  return 1
}

# to_pdf <file.docx>  -> writes <file.pdf> next to it, or returns non-zero with a reason.
to_pdf() {
  local docx="$1" outdir pdf so rc try
  outdir="$(dirname "$docx")"
  pdf="${docx%.docx}.pdf"
  if ! so="$(find_soffice)"; then
    cat >&2 <<EOF
ERROR: no LibreOffice found, so the PDF cannot be made (the DOCX was written: $docx).
Fix (pick one):
  - no sudo:  mkdir -p ~/.local/opt/libreoffice && curl -L -o ~/.local/opt/libreoffice/LibreOffice-still.basic-x86_64.AppImage \\
                https://appimages.libreitalia.org/LibreOffice-still.basic-x86_64.AppImage && chmod +x ~/.local/opt/libreoffice/*.AppImage
  - system:   sudo bash ~/maintenance/install-libreoffice-20261007.sh
EOF
    return 127
  fi
  rm -f "$pdf"   # never leave an old PDF around that looks like a fresh one
  for try in 1 2; do
    # $so is unquoted on purpose: the flatpak form is several words.
    # flock: two conversions sharing one profile at the same time would clash (resume + cover
    # rendered in parallel by the bot), so they queue up here instead. Waits up to 2 minutes.
    mkdir -p "$HOME/.cache"
    flock -w 120 "$HOME/.cache/jobbot-soffice.lock" \
      $so -env:UserInstallation="$JOBBOT_SOFFICE_PROFILE" --headless --convert-to pdf \
        --outdir "$outdir" "$docx" >/dev/null 2>&1
    rc=$?
    [[ -s "$pdf" ]] && return 0
    # 81 = LibreOffice built a fresh profile on first launch and wants a restart. Retry once.
    [[ $rc -eq 81 ]] || break
  done
  echo "ERROR: LibreOffice ($so) exited $rc and wrote no PDF for $docx" >&2
  return 1
}
