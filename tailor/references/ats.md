# ATS Notes: Which File to Upload and What Breaks

Researched Oct 2026. The real dividing line is a text-based PDF vs. an image PDF, not PDF vs. DOCX.
the owner's resumes are built in Word and exported by LibreOffice, so the PDF is always text-based.

## Spot the ATS from the apply URL first
Never guess the ATS from the company name. Find the real apply URL:
- LinkedIn "Apply" links are wrapped: `linkedin.com/safety/go/?url=<encoded>`. URL-decode the `url=` part.
- If the owner only pasted posting text with no link, say "if the apply link goes to X, use Y" instead of guessing.
- If you can search, a quick search for the company's careers portal settles it.

- myworkdayjobs.com / "Workday" -> Workday
- boards.greenhouse.io, job-boards.greenhouse.io, "Powered by Greenhouse" -> Greenhouse
- jobs.lever.co -> Lever
- jobs.ashbyhq.com -> Ashby
- icims.com -> iCIMS
- taleo.net -> Taleo
- oraclecloud.com/hcmUI/CandidateExperience -> Oracle HCM (Oracle Recruiting Cloud)
- Anything else (company career site, unknown) -> treat it as unknown

## Which file to upload
| ATS | Upload | Why |
|---|---|---|
| Greenhouse, Lever, Ashby | PDF | Modern parsers read text PDFs reliably; recruiters see the original file |
| Workday | PDF is fine; DOCX if the autofill keeps scrambling | Some older Workday tenants map DOCX fields better |
| iCIMS, Taleo, Oracle HCM | DOCX | Older parsers are less reliable on PDFs |
| Unknown | DOCX for portals, PDF for email | DOCX is the safer universal choice for portal uploads |
| Emailing a recruiter, referral | PDF | Layout stays exactly as built |
If the posting names a format, use that format, no matter what this table says.

## What the layout already handles (don't undo it)
- Single column, no tables, no text boxes, contact info in the page body (not the Word header)
- Standard headings: Education, Experience, Projects, Certifications and Awards, Technical Skills
- Each job in two lines: Company + location, then Title + dates. A shared "Title, Company" line is the
  #1 cause of parsers putting the company into the title field.
- "Bachelor of Science in ..." spelled out, because "B.S." often fails to map to the degree dropdown
- Dates as "Jun 2026": no periods, no seasons ("Summer 2026" broke Workday)
- Plain-text dash bullets, because Word list bullets become "1." in Workday

## Remind the owner after upload (one line, only when it applies)
- On Workday and iCIMS, check the autofilled Experience entries. The two EXU Research Assistant
  entries have cross-contaminated each other in Workday before.
- A Projects section sometimes gets swallowed into the last job's description. If so, fix it by hand.

## Portals already seen (verified from apply links or search)
| Company | Portal | Upload |
|---|---|---|
| Vertiv | Oracle HCM (egup.fa.us2.oraclecloud.com) | DOCX |
| Booz Allen Hamilton | careers.boozallen.com (unknown parser) | DOCX |
| Copperstone | careers.copperstone.com (unknown parser) | DOCX |
Add a row whenever a new company's portal is confirmed.
