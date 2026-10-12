# ATS candidate application flows (driver reference)

Researched 2026-10-07 for the jobbot Firefox-extension driver. Read-only research: live public
job pages and the ATS's own public JS bundles and JSON endpoints were fetched. Nothing was submitted,
and no accounts were created.

**Evidence tags**
- **[V]**: verified in fetched HTML, JS bundle or JSON (source URL given).
- **[R]**: reported in docs, guides or search results (source given). Not seen in markup.
- **[?]**: unknown or unconfirmed. Inspect at runtime.

Selectors drift. Prefer, in this order: `data-automation-id` / `data-qa` / `data-testid` / stable `id`,
then visible button text, then class names. Always re-check against the live DOM.

---

## Summary table

| ATS | JD → form | Account? | Captcha / bot defence | Resume parse autofill | Success signal |
|---|---|---|---|---|---|
| Greenhouse | same page (`#application-form`); embed `…/embed/job_app?for=X&token=ID` | No | invisible reCAPTCHA **Enterprise**; fallback 8-char **email security code** | No native parse (MyGreenhouse "Autofill" needs login) | URL → `/jobs/ID/confirmation`, "Thank you for applying!" [V] |
| Lever | `{job}` → `{job}/apply` | No | **hCaptcha** (invisible, runs on submit) | Yes (name/email/phone) [R] | URL → `{job}/thanks`, "Application submitted!" [V] |
| Ashby | `{job}` → `{job}/application` | No | reCAPTCHA (v3/Enterprise score) | Yes, "Autofill from resume" box | `.ashby-application-form-success-container`, "Your application was successfully submitted…" [V] |
| Workday | `{job}` → `{job}/apply/applyManually` (or `/autofillWithResume`, `/useMyLastApplication`) | **Yes** (per tenant) | Custom "NoCaptcha": click-filter overlay, honeypot, 500 ms timer | Yes (`autofillWithResume`) | "Congratulations!" / "Your application has successfully been submitted." [V] |
| iCIMS | `…/job` → `…/job?mode=apply&apply=yes` → `…/login` | Yes (email first) | **invisible hCaptcha** on the email step | Yes ("may populate") [R] | Confirmation page [R] |
| SmartRecruiters | `jobs.smartrecruiters.com/Co/ID` → `/oneclick-ui/company/Co/publication/UUID` | No | **DataDome** in front of oneclick-ui (curl got 403) | Yes [R] | [?] |
| Oracle ORC | `…/job/{id}` → `…/job/{id}/apply/email` → `/apply/section/{n}` | Email + **one-time PIN** | optional hCaptcha + honeypot | Yes (profile import) [R] | thank-you route [V route] |
| Taleo (Enterprise) | `jobdetail.ftl?job=N` → `jobapply.ftl?job=N` → `iam/accessmanagement/login.jsf` | Yes (username + password), sometimes "Apply as Guest" | none seen | Yes ("upload resume to fill out") [R] | "Thank you" page [R] |
| Jobvite | `/co/job/ID` → `/co/job/ID/apply` | No | invisible reCAPTCHA on final submit | [?] | navigates to server `pageUri` [V] |
| BambooHR | `co.bamboohr.com/careers/ID` (form opens in SPA) | No | [?] | [?] | "Submit Application" then a confirmation [R] |
| Workable | `apply.workable.com/co/j/SC/` → `/apply` | No | **Embervale Turnstile** | Yes, "Autofill application" | "Thank you!" / "Your application has been submitted successfully." [V] |
| Rippling | `ats.rippling.com/{board}/jobs/{uuid}` → `/apply` | No | **Embervale Turnstile** | Yes ("résumé will be parsed") | "You have successfully applied to {job}" [V] |
| Eightfold (PCSX) | `/careers/job/{pid}` → `/careers/apply?pid={pid}` | Optional | reCAPTCHA v3 (`recaptchaEnabled`) | Yes [R] | [?] |
| Phenom | `/{cc}/{lang}/job/{jobId}/{slug}` → hosted apply or redirect to backing ATS | Depends on backing ATS | depends | depends | depends |
| Handshake (native) | `exu.joinhandshake.com/jobs/{id}` → Apply → modal on the same page | Yes (EXU SSO + Duo, the owner's session in the jobbot Firefox) | none seen | No (picks a stored document) | `currentUser.applications` lists the job (GraphQL); toast "Application submitted!" [V up to Submit] |

Cross-cutting rules for the driver:
1. Never fill honeypots. Known ones are Workday `[data-automation-id="beecatcher"]` (`name="website"`) and the
   Oracle `honeyPotForm`. A safe default is to skip any input that is visually hidden or labelled "for robots".
2. Captchas here are mostly invisible and score-based. A real, logged-in Firefox profile with human-paced
   input passes far more often than synthetic events. When a visible challenge or an email code appears,
   **pause and hand control to the owner**. Do not try to solve it.
3. Use trusted-looking interaction. Workday's click filter only marks you human when its overlay div gets
   the click, so dispatch clicks on the topmost element at the button's centre, not on the inner `<button>`.

---

## 1. Greenhouse

**URLs**
- New board: `https://job-boards.greenhouse.io/{board}/jobs/{id}`. Legacy `https://boards.greenhouse.io/{board}/jobs/{id}`
  served the same new page (it fetched as 200 on the job-boards host) [V].
- The form is on the **same page** as the description: `form#application-form.application--form` [V]
  (https://job-boards.greenhouse.io/glenstone/jobs/4461450008).
- Embed iframe: the company page loads `boards.greenhouse.io/embed/job_board/js?for={board}`, which creates
  `iframe#grnhse_iframe`. The job is passed in the host page's query string `?gh_jid={id}` (`gh_src` is the
  source token). The iframe src is `https://job-boards.greenhouse.io/embed/job_app?for={board}&token={id}` [V].
  **Driver tip:** navigate straight to the embed URL, or better to `job-boards.greenhouse.io/{board}/jobs/{id}`,
  so you never fight the cross-origin iframe.
- Public job list API: `https://boards-api.greenhouse.io/v1/boards/{board}/jobs` (gives `absolute_url`) [V].

**Apply button / selectors** [V]
- Top "Apply" is `button.btn.btn--rounded[aria-label="Apply"]`. It only scrolls to the form.
- Standard fields: `#first_name`, `#last_name`, `#email`, `#phone` (plus `.phone-input__country`), `#country`
  (react-select), and location "Location (City)" with a "Locate me" button.
- Custom questions use `#question_{id}`. Selects are react-select comboboxes
  (`#react-select-question_{id}-placeholder`). Type the text, then pick the option.
- Resume: hidden `input#resume[type=file]` (accept `.pdf,.doc,.docx,.txt,.rtf`). Buttons "Attach",
  "Dropbox" (`[data-testid=resume-dropbox]`), "Google Drive", and "Enter manually" (`[data-testid=resume-text]`).
  Set the file on `#resume` directly. A cover letter, if present, follows the same pattern (`#cover_letter`) [R].
- Submit: `.application--submit button[type=submit]`, text "Submit application".

**Account:** none. "Autofill my application" via MyGreenhouse (`my.greenhouse.io`) needs a login and is optional [V locale].

**Captcha** [V]
- Invisible reCAPTCHA **Enterprise** (`recaptcha.net/recaptcha/enterprise.js`, `GOOGLE_RECAPTCHA_INVISIBLE_KEY`).
  The token is sent as `g-recaptcha-enterprise-token` on submit.
- If the score is low, the server answers `captcha-failed` with `security_code_recipient`. The UI then shows
  `fieldset#email-verification` with **8 one-character inputs `#security-input-0` … `#security-input-7`**:
  "A verification code was sent to {email}. To submit your application, enter the 8-character code to confirm
  you're a human." The error codes are `invalid-security-code`, `expired-security-code` and `security-code-error`.
  Source: entry.client bundle and `job-boards.cdn.greenhouse.io/locales/en/job_post.*.json`.
- **Driver:** detect `#security-input-0`, pause, and let the owner type the emailed code. (An extension could
  read the code from the owner's mail, but keep a human in the loop.)

**Confirmation** [V]
- `confirmationPath` is `/{board}/jobs/{id}/confirmation`. The page reads "Thank you for applying! Your application
  has been received…" (the text is configurable per company: `confirmation_message`).
- Inside the embed, the iframe posts `"greenhouse.confirmation"` to the parent.

**Blockers:** custom required questions (react-select), EEOC section (`.eeoc__question__wrapper`), education
and employment blocks, location autocomplete. The location service can fail: "You can submit your application
without a location."

**Driver recipe**
1. Normalise the URL. If a host page has `gh_jid`, open `job-boards.greenhouse.io/embed/job_app?for={board}&token={gh_jid}`.
2. Wait for `#application-form`.
3. Set the file on `#resume`. Fill `#first_name`, `#last_name`, `#email` and `#phone`, then `#country` and location.
4. Fill each `#question_*`, including react-selects and the EEOC selects. Answer "decline" options where allowed.
5. Click "Submit application". Wait for the URL to end in `/confirmation` OR for `#security-input-0` to appear (then pause for the human).

## 2. Lever

**URLs** [V] (https://jobs.lever.co/spotify/2193db3f-77c5-43b8-b030-8f92c9882bf1)
- JD: `https://jobs.lever.co/{co}/{uuid}`. Form: append **`/apply`**. After success: **`/apply` → `/thanks`**
  (`https://jobs.lever.co/{co}/{uuid}/thanks`).
- EU host: `jobs.eu.lever.co` [R]. API: `https://api.lever.co/v0/postings/{co}?mode=json` (`hostedUrl`, `applyUrl`) [V].

**Selectors** [V]
- Apply link: `a.postings-btn[data-qa="show-page-apply"]` and `[data-qa="btn-apply-bottom"]`. Text "Apply for this job".
- Form: `form#application-form` (multipart POST).
- Resume: `input#resume-upload-input[data-qa="input-resume"][name="resume"]`. Parse status classes are
  `.resume-upload-working`, `.resume-upload-success` and `.resume-upload-failure`.
- `input[name=name][data-qa=name-input]` (one full-name field), `[name=email][data-qa=email-input]`,
  `[name=phone][data-qa=phone-input]`, `#location-input[data-qa=location-input]` (autocomplete; the hidden
  `#selected-location` must get filled), `[name=org][data-qa=org-input]` (current company),
  `urls[LinkedIn]`, `urls[GitHub]`, `urls[Portfolio]`, `urls[Other]`.
- Pronoun checkboxes are `name=pronouns`. Custom cards are `cards[{uuid}][field{n}]`. Also `consent[marketing]`, and an EEO block.
- Submit: `button#btn-submit[data-qa="btn-submit"]`, text "Submit application" (type=button). A hidden
  `#hcaptchaSubmitBtn` does the real submit.

**Captcha** [V]: hCaptcha (`hcaptcha.com/1/secure-api.js`, `div#h-captcha`). Clicking `#btn-submit` runs
`hcaptcha.execute()`. If the score is fine, no challenge appears and the form posts. Otherwise a visual hCaptcha
appears, so pause for the human. Pressing Enter in a field is also intercepted.

**Account:** none. **Resume parse** fills name/email/phone after upload [R: widely reported; status classes V].

**Confirmation** [V]: `/thanks` page with the text "Application submitted!" and "Return to the main page".

**Driver recipe**
1. If the URL has no `/apply`, append `/apply`.
2. Upload to `#resume-upload-input`. Wait for `.resume-upload-success`, or 10 s.
3. Overwrite or fill name, email, phone, org and urls. Type the location, then choose a suggestion, and make sure `#selected-location` is non-empty.
4. Fill the cards (radios/checkboxes/text) and EEO.
5. Click `#btn-submit`. Success means the URL ends with `/thanks`. If an hCaptcha iframe becomes visible, hand off.

## 3. Ashby

**URLs** [V] (https://jobs.ashbyhq.com/openai/8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3)
- JD: `https://jobs.ashbyhq.com/{org}/{jobId}`. Form: append **`/application`** (routes `/:org/:jobId/application`;
  the right pane has "Overview" / "Application" tabs, `.ashby-job-posting-right-pane-application-tab`).
  Button "Apply for this Job".
- Embedded boards: company page with `?ashby_jid={jobId}` [R]. Navigate to the jobs.ashbyhq.com URL instead.
- API: `https://api.ashbyhq.com/posting-api/job-board/{org}` gives `jobUrl` and `applyUrl` [V]. Form schema:
  `POST https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting` → `applicationForm.sections[].fieldEntries[].field.path` [V].

**Selectors** [V] (from bundle `cdn.ashbyprd.com/frontend_non_user/.../index-*.js`)
- Field input `id` = the field **path**. System fields are `_systemfield_name`, `_systemfield_email` and
  `_systemfield_resume` (file). `_systemfield_location` is a location autocomplete. Custom questions use a UUID path.
  The wrapper is `.ashby-application-form-field-entry`.
- Stable classes: `.ashby-application-form-container`, `…-input-text`, `…-input-textarea`, `…-input-dropdown`,
  `…-input-radio-group-option`, `…-input-checkbox-group-option`, `…-input-yesno-option`, `…-input-date`,
  `…-input-file` (button "Upload File"), and `…-input-autocomplete-popup-result`.
- Resume autofill pane: `.ashby-application-form-autofill-pane` with the heading "Autofill from resume", the text
  "Upload your resume here to autofill key application fields." and the button "Upload file".
- Submit: `.ashby-application-form-submit-button`, text "Submit Application".

**Captcha** [V]: reCAPTCHA (site keys in `window.__appData`, an Enterprise path exists). The server error is
`RECAPTCHA_SCORE_BELOW_THRESHOLD`, which surfaces in `.ashby-application-form-failure-container`. There is no visible challenge, so a failure means a human retry.

**Confirmation** [V]: `.ashby-application-form-success-container` with "Success" and either the org-specific
`applicationSubmittedSuccessMessage` or the default "Your application was successfully submitted. We'll contact
you if there are next steps." The URL does not change [R].

**Driver recipe**
1. Open `{jobUrl}/application` and wait for `.ashby-application-form-container`.
2. Optionally upload the resume into the autofill pane first, wait, then review the fields.
3. Set the file on the `_systemfield_resume` input. Fill `#_systemfield_name`, `#_systemfield_email`, phone, and location (type, then click the popup result).
4. Answer custom questions by label. Yes/no questions are buttons, not radios.
5. Click `.ashby-application-form-submit-button`. Wait for the success or failure container.

## 4. Workday (`*.myworkdayjobs.com`, also `*.myworkdaysite.com`)

All of the selectors below are **[V]** from the live bundles `wd5.myworkdaycdn.com/wday/asset/candidate-experience-jobs/cx-jobs.min.js`
and `…/candidate-experience-apply-flow/candidate-experience-apply-flow.min.js` (2026 build), loaded by
https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite.

**URLs** [V]
- JD: `https://{tenant}.wd{N}.myworkdayjobs.com[/{locale}]/{siteId}/job/{location}/{jobPostingId}`.
  Example: `…/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-Software-Engineer--VLSI-AI-Agent_JR2012538`.
- Apply URL builder (from the bundle): `${uriBase}/job/${location}/${jobPostingId}/apply${method ? "/"+method : ""}`,
  where `method` ∈ `applyManually | autofillWithResume | useMyLastApplication` (also `applyWithSeek`, `LinkedIn`).
  So **JD URL + `/apply/applyManually`** skips the modal.
- JSON: `GET https://{host}/wday/cxs/{tenant}/{siteId}/job/{location}/{jobPostingId}` returns `canApply`,
  `includeResumeParsing`, `questionnaireId` and `externalUrl`. Listing: `POST …/wday/cxs/{tenant}/{siteId}/jobs`.

**Apply button and modal** [V]
- JD button: `[data-automation-id="adventureButton"]`, text "Apply". The modal is titled "Start Your Application".
- Modal options (anchors): `[data-automation-id="autofillWithResume"]` "Autofill with Resume" (only if
  `includeResumeParsing`), `[data-automation-id="applyManually"]` "Apply Manually", and
  `[data-automation-id="useMyLastApplication"]` "Use My Last Application". The last one requires sign-in: "To use your
  last application, you must sign in." Apply with LinkedIn/SEEK may also appear.
- If you already applied: `[data-automation-id="alreadyAppliedPage"]` "You've already applied for this job." The JD shows
  "You applied for this job on {date}".

**Sign in / create account** [V]
- Header sign-in: `utilityButtonSignIn`. Inside the flow: `signInLink` / `createAccountLink` switch forms.
  Also `forgotPasswordLink`, `SignInWithEmailButton`, `GoogleSignInButton`, `AppleSignInButton`,
  `LinkedInSignInButton`, `OktaSignInButton`, `USAJobsSignInButton`, and `sendLinkButton`.
- Fields: `[data-automation-id="email"]`, `[data-automation-id="password"]`, `[data-automation-id="verifyPassword"]`
  (create only), `[data-automation-id="createAccountCheckbox"]` (terms consent, if the tenant configured one).
- Buttons: `[data-automation-id="createAccountSubmitButton"]` "Create Account" and `[data-automation-id="signInSubmitButton"]` "Sign In".
- Password rules are tenant-configured and rendered in `[data-automation-id="passwordRulesList"]` ("Password
  Requirements:" plus a list). Typical: ≥8 characters (often 10), upper, lower, digit and special [R: Workday docs/guides].
- Email verification: strings "Resend Account Verification", "An email has been sent to you." and "Still can't sign in?
  Be sure to check your spam folder, your account may need verification" [V]. This is a **verification link** by email
  (tenant option). Some tenants allow applying without verifying first [R: doc.workday.com].
- Accounts are **per tenant**, so each company needs its own account.
- **NoCaptcha anti-bot (important)** [V]: on the sign-in, create-account and forgot-password forms, Workday wraps the submit
  button in `[data-automation-id="noCaptchaWrapper"]` and lays a transparent absolutely-positioned
  `div[data-automation-id="click_filter"][role=button]` over it. Only a click (or Enter/Space) **on the click_filter**
  sets the "human" flag, and that handler then dispatches a click to the real button. Two more tests must pass: a honeypot
  `input[data-automation-id="beecatcher"][name="website"]` must stay **empty**, and a timer test (500 ms) must have
  elapsed. **Driver:** wait ≥1 s after the form renders, then click `[data-automation-id="click_filter"]`, not
  `createAccountSubmitButton`/`signInSubmitButton`.

**Steps** (page containers carry these automation ids) [V]
`applyFlowAutoFillPage` (resume upload, `resumeUpload`) → `applyFlowMyInfoPage` → `applyFlowMyExpPage` →
(application questions, generic `applyFlowPage`) → `applyFlowVoluntaryDisclosuresPage` → `applyFlowSelfIdentifyPage` →
(`applyFlowMyAvailabilityPage`, `takeAssessmentPage` if configured) → `applyFlowReviewPage`.
Visible step titles (from the server, tenant-specific): "My Information", "My Experience", "Application Questions",
"Voluntary Disclosures", "Self Identify", "Review" [R]. The progress bar is `[data-automation-id="progressBar"]`.

**Form widgets** [V]
- Field wrappers: `[data-automation-id="formField-{fieldName}"]`. Field ids are path-based joined with `--`
  (the bundle flattens `legalName` etc. with `--`). Reported examples: `name--legalName--firstName`,
  `name--legalName--lastName`, `address--addressLine1`, `phoneNumber--phoneNumber`, `source--source` [R/?: verify live].
- Dropdown/prompt widgets: `searchBox`, `promptOption`, `multiselectInputContainer`, `selectedItemList`.
  Dates: `dateSectionMonth`, `dateSectionDay`, `dateSectionYear`. Repeating sections (work, education): `add-button`.
- File upload: `[data-automation-id="file-upload-input-ref"]` (`input[type=file]`), the visible button `select-files`,
  `file-upload-drop-zone`, and status `file-upload-successful` / `file-upload-failed`.
- "How Did You Hear About Us?" (source) is a required multiselect prompt on most tenants [R]. "Previous worker" is a yes/no radio [V key `candidateIsPreviousWorker`].
- Errors: `errorHeading`, `errorMessage`, `inputAlert`.

**Navigation / submit** [V]
- `[data-automation-id="pageFooterNextButton"]`. Its text is "Save and Continue", "Next" or **"Submit"** (it becomes
  "Submit" on the final review page). Back is `pageFooterBackButton`.
- There is no separate final-submit id: **the final submit is `pageFooterNextButton` with text "Submit".**
- Legal notice modals: `legalNoticeAcceptButton` / `legalNoticeDeclineButton`.

**Confirmation** [V]: "Congratulations!" plus "Your application has successfully been submitted." (or the tenant's
`applyConfirmationMessage`). The user home (`/userHome`, "View My Applications") then lists it. The document title also changes to "Congratulations".

**Blockers:** per-tenant account plus email verification; NoCaptcha click filter; react prompts that need typing
and Enter; multi-page validation (errors only after Next); session timeouts; resume parsing creating duplicate
work/education entries that must be deleted; required "How did you hear"; voluntary self-ID pages; tenants
behind Akamai/Embervale challenges [R].

**My Experience (history)** [V: Vanguard capture in ~/autofill/fixtures/workday, UMBERMOOR / Elmbrook 2026-10-09]: group
`[role=group][aria-labelledby=Work-Experience-section]` (h4 "Work Experience") > panels `[role=group]` labelled by an h5
"Work Experience <n>" with a plain `Delete` button; fields `formField-jobTitle`, `companyName`, `location`,
`currentlyWorkHere` (checkbox, same `name` in every panel), `startDate` / `endDate` (Month / Year spinbuttons in a
`dateInputWrapper`), `roleDescription`. Education panels: `school` (prompt), `degree`, `fieldOfStudy`, `gradeAverage`,
`firstYearAttended` / `lastYearAttended` (year only). "Add" / "Add Another" = `data-automation-id="add-button"`. The
engine skips repeaters on purpose; the driver fills them (`fillRepeaters`, lib/history.js `nextRepeaterAction`): every
job from the resume JSON, missing ones added, parsed junk rewritten or deleted, one education entry. Certifications are
left alone (the picker lists issuing bodies only, DRIFTRIDGE).

**Driver recipe**
1. From the JD URL, go to `JD + "/apply/autofillWithResume"` (if `includeResumeParsing`) or `"/apply/applyManually"`.
2. If the sign-in/create form shows: switch with `createAccountLink` if needed; fill `email`, `password` and
   `verifyPassword`; tick `createAccountCheckbox` if present; leave `beecatcher` empty; wait 1 s; click `click_filter`.
   If verification is needed, pause for the owner to click the email link, then sign in the same way (`signInSubmitButton` via `click_filter`).
3. On the autofill page, set the file on `file-upload-input-ref` and wait for `file-upload-successful`.
4. Loop: detect the current page id (`applyFlow*Page`), fill it, click `pageFooterNextButton`, wait for the page
   id to change or for `errorMessage` (then fix and retry).
5. On `applyFlowReviewPage`, confirm the button text is "Submit", click it, and wait for the "Congratulations" / "successfully been submitted" text.

## 5. iCIMS (`*.icims.com`)

**URLs** [V] (https://careers-emcorgroup.icims.com/jobs/53019/journeyman-electrician/job?in_iframe=1)
- JD: `https://{portal}.icims.com/jobs/{id}/{slug}/job`. Company career sites usually wrap it in an iframe
  `#icims_content_iframe`. The page then auto-redirects the top window when `in_iframe=1` is present.
  **Driver:** open the icims.com URL top-level, with `?in_iframe=1` stripped or kept as-is.
- Apply link: `a.iCIMS_ApplyOnlineButton.iCIMS_PrimaryButton[title="Apply"]` → `…/job?mode=apply&apply=yes&in_iframe=1&hashed=…`
  → redirects to `…/jobs/{id}/{slug}/login`. Text "Apply" (older portals: "Apply for this job online").
- Login (email step) [V]: `form#enterEmailForm` → `input#email[name=css_loginName]`, GDPR checkbox
  `#accept_gdpr` (when shown), and submit `input#enterEmailSubmitButton[value="Next"]`.

**Account** [R: iCIMS Candidate Guide, https://community.icims.com/articles/HowTo/Candidate-Guide-to-the-iCIMS-Talent-Platform]:
the email decides new vs returning. A new user creates a profile with name, email, login and password, or uses a
social login. A returning user signs in with a password (some portals send an email link or code [?]). The steps that
follow are Candidate Profile ("Update Profile"), job questions, EEO, then submit. "Finish Later" exists.

**Resume:** upload sources "My Computer", Google Drive, Dropbox, OneDrive. Parsing "may populate some profile
fields". Upload before the other fields [R].

**Captcha** [V]: **invisible hCaptcha** on `enterEmailForm` (sitekey in the page, `size: 'invisible'`). Form submit is
intercepted and `hcaptcha.execute()` runs, then `h-captcha-response` is appended. A visible challenge is possible.

**Confirmation** [R]: "a new page with a confirmation message … indicating that the application was submitted
successfully". The exact text is tenant-configurable [?]. Success/error banners use `.iCIMS_SuccessMessage` / `.iCIMS_ErrorMessage` [V classes].

**Blockers:** iframe wrapping, hCaptcha, per-portal profiles, long multi-page forms with classic `<select>`s,
the cookie requirement ("Please Enable Cookies to Continue"), and frequent "hashed" tokens. Do not construct URLs; follow the links.

**Profile history** [V: Driftmere, Thorngate, Ravenhaven, Pinecrest, IRONFIELD 2026-10-08/09]: "Professional Experience (n)" /
"Work Experience (n)" blocks of Employer, Title, address, Month / Day / Year start and end, Description; the order varies
(IRONFIELD: Title*, Employer name, City, Country, State, dates, Description of work). Education rows: School (ajax
dropdown), Degree, Major, GPA, Did You Graduate, one date set (graduation, Ravenhaven) or two (start + graduation, IRONFIELD).
Delete buttons are icon links `Delete Professional Experience (5)`. The resume parse scrambles them; `planHistory`
rewrites every block from the resume JSON, deletes extras and presses "Add ... Experience" for missing jobs (the add
button's exact text is UNVERIFIED live).

**Driver recipe**
1. Resolve the iCIMS job URL (from the iframe src if needed). Open it top-level and click `.iCIMS_ApplyOnlineButton`.
2. On `#enterEmailForm`, fill `#email`, tick `#accept_gdpr` if present, and click `#enterEmailSubmitButton`. If an hCaptcha appears, hand off.
3. Branch: a password page (returning) or a profile-creation page (new). Fill or pause.
4. Upload the resume first, then step through the pages (Next/Submit). Watch for `.iCIMS_ErrorMessage`.
5. Treat a page with `.iCIMS_SuccessMessage` or text matching /submitted|thank you/i as success.

## 6. SmartRecruiters

**URLs** [V] (https://jobs.smartrecruiters.com/Equinox/744000154122188)
- JD: `https://jobs.smartrecruiters.com/{CompanyId}/{postingId}[-slug]`.
- Apply: `https://jobs.smartrecruiters.com/oneclick-ui/company/{CompanyId}/publication/{postingUuid}?dcr_ci={CompanyId}`.
  The template is in `window.ONECLICKDATA.url`, and `puuid` is the publication UUID (also `uuid` in
  `api.smartrecruiters.com/v1/companies/{Co}/postings`).
- Apply button: `a#st-apply.js-oneclick` (also header/bottom copies), text **"I'm interested"**. A SmartR variant is `.js-smartr-oneclick`.

**Bot defence** [V]: oneclick-ui is behind **DataDome** (`ct.captcha-delivery.com/i.js`). A plain fetch got HTTP 403
with a DataDome challenge. In the owner's real browser this is usually silent. If a DataDome slider appears, hand off.

**Form** [R: SAP/SmartRecruiters learning, https://learning.sap.com/courses/smartrecruiters-for-sap-successfactors-academy/exploring-the-candidate-experience]:
single page with "Easy Apply" resume upload that triggers **resume parsing**, personal info (first/last name, email,
confirm email, phone, location), experience/education, screening questions, then **privacy consent**. A confirmation
message and email follow. No account. Selectors: [?]. The UI is built from web components (shadow DOM likely) [?], so the
driver may need to pierce shadow roots.

**Driver recipe**
1. From the JD, read `window.ONECLICKDATA` (or click `#st-apply`).
2. On oneclick-ui, upload the resume first, wait for the parse, then fill or correct the fields (check for shadow DOM).
3. Tick the consent, then submit. Detect success by text /thank you|application (was )?(sent|submitted)/i [?].

## 7. Oracle Recruiting Cloud (Candidate Experience)

**URLs** [V] (https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch; routes from
`static.oracle.com/cdn/fa/oj-hcm-ce/…/js/main-minimal.js`)
- Site: `https://{pod}.fa.{dc}.oraclecloud.com/hcmUI/CandidateExperience/{lang}/sites/{siteKey}` (siteNumber like `CX_45001`).
- JD: `…/sites/{siteKey}/job/{jobId}`. Apply flow: **`…/job/{jobId}/apply/email`** (email or phone entry) →
  `/apply/pin` (PIN/OTP) → **`/job/{jobId}/apply/section/{n}`** (multi-page) → confirm/thank-you routes
  (`/apply/confirm`, `/apply/{token}/thank-you-assessment`, `/apply/submission-exists`). There is also an "easy apply"
  variant `/job/{jobId}/easy-apply` with `/easy-apply/section/{n}/block/{m}`.
- REST: `/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber=…` [V].
- Posting text, no tab [V 2026-10-09, Fernhaven 300404]: `recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id="<id>",siteNumber=<CX_n>`
  (`ExternalDescriptionStr` / `ExternalResponsibilitiesStr` / `ExternalQualificationsStr`, `PrimaryLocation`,
  `ExternalPostedStartDate`). A link can name the site ("sites/careers"); the job page's HTML holds the number in its
  favicon links (`siteNumber=CX_1001`). `jobctl posting` does both (lib/posting.js oraclePosting).

**Identity** [V code / R docs]
- Email field: `input#primary-email` (label "Email Address"). It can switch to SMS/WhatsApp
  (`#applyFlowVerifyEmail` toggles the method). Legal disclaimer / terms checkbox before continuing (`legal-disclaimer` component).
- Then a **6-digit one-time code** (`.input-row--pin-code`, segmented). Depending on config it is sent at the start
  or **at the end** of the apply flow. Wrong code 5× means a 30-minute lockout. Returning candidates may be asked to
  confirm last name or date of birth ("Authenticate Your Identity") before the code
  (https://docs.oracle.com/en/cloud/saas/readiness/hcm/24b/recr-24b/24B-recruiting-wn-f32343.htm). Tenants with
  "Candidate Autoconfirmation" skip it (https://docs.oracle.com/en/cloud/saas/talent-management/faimh/enable-candidate-autoconfirmation.html).
- No password account.

**Captcha** [V]: optional bot protection `isBotsProtectionEnabled` with provider **hCaptcha** plus a honeypot form
(`honeyPot` → REST field `control`). Rate-limit errors: `ORA_IRC_TOO_MANY_REQUESTS`, `ORA_TOO_MANY_SIGNIN`.

**Sections:** blocks such as personal info, experience, education, attachments (resume), questions, disability/EEO,
agreements, and **e-signature** (`ORA_ESIGNATURE`, full-name field) on the last page [V block codes]. English button
labels such as "Apply Now", "Next" and "Submit" are [R]; the strings live in a separate i18n bundle that was not fetched.

**Profile items** [V: TI capture tests/fixtures/oracle-form-2.html; Fernhaven 2026-10-09]: Experience / Education / Licenses
and Certificates are `.apply-flow-block--tile-profile-items` blocks: saved entries are `article.apply-flow-profile-item-tile`
(`--invalid` + "Fields to fix: n" when incomplete; `__summary-title` = job title / major / license, `__summary-subtitle`
= employer / school), with icon buttons `__edit-item-icon` (aria-label "Edit") and `__delete-icon` ("Delete"); the block's
`profile-item-tile__new-tile` button reads "Add Experience" / "Add Education" / "Add License". Add / Edit open an inline
form (Degree pills, Major / School comboboxes, Month / Year comboboxes, Graduated checkbox, SAVE / CANCEL; its markup is
UNVERIFIED: no capture of it open). The resume import makes "Unnamed Major" / "Unnamed License" tiles with made-up
dates. `fillRepeaters` deletes tiles that name no fact, edits invalid / wrong ones, adds each missing job, SAVEs every
form and CANCELs one that will not take a value (a certificate missing from the tenant's catalogue).

**Driver recipe**
1. JD URL + `/apply/email`. Fill `#primary-email`, accept the terms, click Next.
2. If the PIN UI appears, pause for the owner (or read the 6-digit code from mail with approval).
3. For each `/apply/section/{n}`: fill the blocks, upload the resume in attachments, click Next.
4. Last page: agreements plus e-signature full name, then Submit. Watch for the PIN prompt *after* submit.
5. Success means a thank-you/confirm route or text /thank you|submitted/i.

## 8. Taleo (Oracle Taleo Enterprise; `*.taleo.net/careersection/…`)

**URLs** [V] (https://hdr.taleo.net/careersection/ex/jobdetail.ftl?job=196837&lang=en) and
[R] (https://docs.oracle.com/en/cloud/saas/taleo-enterprise/21b/otrdc/deep-linking-configuration.html)
- JD: `https://{co}.taleo.net/careersection/{cs}/jobdetail.ftl?job={contestNo|reqId}&lang=en`.
- Apply: **replace `jobdetail.ftl` with `jobapply.ftl`** (same query). When signed out this redirects to
  `/careersection/iam/accessmanagement/login.jsf?lang=en&redirectionURI=…jobapply.ftl…`.
- Job search JSON: `POST /careersection/rest/jobboard/searchjobs?lang=en&portal={portalId}` (`contestNo` = the `job=` value) [V].

**Selectors** [V]
- JD apply: `input#requisitionDescriptionInterface.UP_APPLY_ON_REQ` / `…BOTTOM_APPLY_ON_REQ`, value "Apply Online".
  The id has a dot, so use `[id="requisitionDescriptionInterface.UP_APPLY_ON_REQ"]`.
- Login (`login.jsf`, title "Candidate Account Login"): `#dialogTemplate-dialogForm-login-name1` (User Name),
  `#dialogTemplate-dialogForm-login-password`, and button `#dialogTemplate-dialogForm-login-defaultCmd` ("Login").
  Also `#…-login-register` ("New User"), `#…-login-guestapply` ("Apply as Guest", only if enabled), and the forgot-username/password links.
- Register (`register.jsf`, "New User Registration"): `#dialogTemplate-dialogForm-userName`, `-password`,
  `-passwordConfirm`, `-email`, `-emailConfirm`, and `#dialogTemplate-dialogForm-defaultCmd` ("Register").
  The password policy is tenant-configured and shown on error [?].

**Flow** [R: Taleo candidate guides]: "Privacy Agreement" ("I Accept") → resume upload with an optional
"upload resume to fill out the application" parse → Personal Information → Education/Experience → Questionnaires →
Attachments → **eSignature** (type your full name) → "Review and Submit" → **Submit**. Each page uses "Save and
Continue". Accounts are per company. A session-timeout dialog appears (`topNavInterface.answerConfirmBeaconReset` "OK"
resets the timer) [V].

**Confirmation:** a thank-you page ("Thank you for applying"/"Your submission was completed") [?: tenant text].

**Blockers:** JSF postbacks (no stable URLs per step), `cmdSubmit` JS buttons, session timeouts, dotted ids, and
mandatory privacy/eSignature steps.

**Driver recipe**
1. Swap `jobdetail.ftl` for `jobapply.ftl`. On `login.jsf`, sign in or click "New User" and register (pause if
   the owner has no account), or use "Apply as Guest" if it is offered.
2. Accept the privacy agreement. Upload the resume (choose the parse option if offered).
3. Loop: fill the page, click "Save and Continue", and check for an error banner. Click the OK on the timeout dialog when it shows.
4. eSignature: type the full name exactly as entered. On "Review and Submit", click Submit and wait for the thank-you text.

## 9. Jobvite

**URLs** [V] (https://jobs.jobvite.com/egnyte/job/o0LMAfwR)
- JD: `https://jobs.jobvite.com/{co}/job/{jobId}`. Apply: **append `/apply`**. The apply page may first show a
  **Data Consent** screen (location/language picker, then "Accept"/"Decline" `button.jv-button-primary`).
  An unknown company slug redirects to jobvite.com support.
- JD apply link: `a.jv-button.jv-button-primary.jv-button-apply[href$="/apply"]`, text "Apply". (Also "Apply Later", which is mailto.)

**Form** [V]: AngularJS (`ng-app="jv.careersite.desktop.app"`, controller `JVApply`). Steps are main → EEO →
OFCCP → prescreen (each optional, based on job config). The final button calls `submitApplication()`, which runs
**`grecaptcha.execute()` (invisible reCAPTCHA)** and then posts. On success the app navigates to the server-returned
`pageUri` (the thanks page) [V]. The resume is required (`validateResume`). There are options to attach a cover letter and portfolio.

**Account:** none [V: no login in flow]. **Confirmation text:** [?] (server page).

**Driver recipe**
1. JD + `/apply`. If the consent screen shows, select the country/language and click Accept.
2. Upload the resume, fill `ng-model` inputs (dispatch `input`/`change` events so Angular sees them), and fill the required custom fields.
3. Click Next through the EEO/prescreen steps, then Submit. Success means the URL changes away from `/apply` and the page has /thank/i.

## 10. BambooHR

**URLs** [V] (https://instructure.bamboohr.com/careers/15)
- Board: `https://{co}.bamboohr.com/careers`. JD: `/careers/{id}`. JSON: `GET /careers/list` and
  `GET /careers/{id}/detail` → `formFields` [V]. Example form fields: firstName, lastName, email, phone,
  resumeFileId, streetAddress, city, state, zip, country, desiredPay, plus custom questions with `isRequired`.
- The page is a client-rendered SPA (`#poRoot`). The form appears on clicking "Apply for This Job" [R].

**Flow** [R: BambooHR help, https://bamboohr.screenstepslive.com/m/53914/l/587666-how-does-a-candidate-apply-for-a-job-opening]:
fill in the information, then "Submit Application", and the candidate receives a confirmation email. No account.
Captcha: [?]. Resume parse: [?].

**Driver recipe**
1. Fetch `/careers/{id}/detail` to learn the required fields.
2. Open `/careers/{id}` and click "Apply for This Job". Fill by label and upload the resume.
3. Click "Submit Application". Detect the confirmation text [?] (/thank|submitted|received/i).

## 11. Workable

**URLs** [V] (https://apply.workable.com/blueground/j/186545F8C1/)
- JD: `https://apply.workable.com/{co}/j/{shortcode}/`. Form: **append `apply/`**. The short form
  `apply.workable.com/j/{shortcode}/apply` redirects to it. Old `{co}.workable.com/jobs/{id}` redirects [R].
- APIs: `GET https://apply.workable.com/api/v1/widget/accounts/{co}` (jobs with `application_url`) and
  `GET https://apply.workable.com/api/v1/jobs/{shortcode}/form` (sections and fields) [V].
- Field ids from the form API: `firstname`, `lastname`, `email`, `headline`, `phone`, `address` (pre-filled from geo-IP!),
  `education` / `experience` groups, `summary`, `resume` (file), `cover_letter`, and `QA_{n}` custom questions [V].
  Assume DOM `name`/`id` match these ids [R/?: verify].

**UI strings** [V] (bundle `dcvxs6ggqztsa.cloudfront.net/candidate/releases/careers.*.js`): the JD button is "Apply for
this job" (tabs "Overview"/"Application"). The autofill box "Autofill application" shows "Autofill completed! Please review the
information we have filled in below." on success. Submit is **"Submit application"**. Success title **"Thank you!"** with
"Your application has been submitted successfully." EEO form pieces: `[data-ui="eeoc-form"]`,
`[data-ui="submit-eeoc"]`, `[data-ui="skip-eeoc"]`. Cookie banner: `[data-ui="cookie-consent-accept"]`.

**Captcha** [V]: **Embervale Turnstile**. On failure: "We couldn't process your request. Please access the application from a
different browser and try again."

**Driver recipe**
1. Normalise to `…/j/{sc}/apply/`. Accept or dismiss the cookie banner.
2. Optionally upload the resume to "Autofill application" and wait for "Autofill completed!".
3. Fill the fields from the form API (correct `address`). Upload `resume`. Answer `QA_*`.
4. Click "Submit application". If Turnstile shows an interactive widget, hand off. Then wait for "Thank you!".
5. If an EEO form follows, use `submit-eeoc` or `skip-eeoc`.

## 12. Rippling

**URLs** [V] (https://ats.rippling.com/dunder-mifflin…/jobs/a51b3d6b-47d5-46c5-b764-941d2d526a1a, a Rippling demo board)
- JD: `https://ats.rippling.com/{jobBoardSlug}/jobs/{jobId}`. Form: **append `/apply`** (Next.js route
  `/[jobBoardSlug]/jobs/[jobId]/apply`, title "Apply - {job}"). Some companies use a custom domain or an embed [R].
- Apply button: `button[data-testid="Apply now"]`.
- Basic questions in `__NEXT_DATA__` (`apiData`): `oid` = `first_name`, `last_name`, email, phone, resume, LinkedIn, etc.,
  plus custom question groups [V].

**Strings** [V]: "The résumé will be parsed to fill in the application details", "Parsing the résumé. This might take
a few seconds.", "Résumé parsing was successful." Terms line: 'By clicking "Apply" you agree to Rippling's Terms of
Service…', so the final button text is "Apply" [V inferred]. An AI-analysis opt-out checkbox and SMS opt-in Yes/No appear.
Success is **"You have successfully applied to {jobPostName}"**. Failure is "Unable to apply for {job}…".

**Captcha** [V]: **Embervale Turnstile** (`turnstileContainer`: "There was an error while verifying you are a human.").

**Driver recipe**
1. JD + `/apply`. Upload the resume, wait for "parsing was successful", then correct the fields.
2. Answer the custom groups and SMS opt-in, and decide the AI-opt-out per the owner's policy.
3. Click "Apply". Wait for "You have successfully applied". If Turnstile blocks, hand off.

## 13. Eightfold (Talent Intelligence career site "PCSX")

**URLs** [V] (https://apply.careers.microsoft.com/careers; bundle `/gen/js/pcsxPwa.*.js`)
- Hosts: `{co}.eightfold.ai/careers` or a custom domain (e.g. `apply.careers.microsoft.com`).
- Routes: JD `/careers/job/{pid}` (legacy `/careers?pid={pid}` [R]). **Apply: `/careers/apply?pid={pid}`**
  (private: `/careers/apply/private?pid=`). Login: `/careers/login`. Dashboard: `/careers/dashboard`.
- The old public API `/api/apply/v2/jobs` now returns "Not authorized for PCSX" [V].

**Captcha** [V]: reCAPTCHA **v3** (`recaptcha/api.js?render={sitekey}`, `"recaptchaEnabled": true` in the site config).
**Account:** optional; there are candidate login and dashboard pages [V routes]. **Steps:** a stepper with
`[data-test-id="step-{n}"]` [V]. Containers: `.apply-form-container`, `.apply-page` [V]. Button and label text come from the gettext i18n
catalogue, so they are not in the bundle [?]. Resume upload with parsing [R]. Confirmation text: [?].

**Driver recipe**
1. Extract `pid`. Open `/careers/apply?pid={pid}`.
2. Upload the resume and wait for the prefill. For each `step-{n}`, fill and continue.
3. Submit, then detect /thank|submitted|applied/i [?].

## 14. Phenom (career-site layer, often in front of another ATS)

**URLs** [V] (https://careers.phenom.com/us/en/job/P-104440/x)
- JD: `https://{careers-domain}/{country}/{lang}/job/{jobId}/{slug}` (the slug is ignored). Search JSON is embedded with
  `jobSeqNo` (e.g. `PHENA0059P104440EXTERNALENUS`) and `externalApply`.
- Apply: either **Phenom Hosted Apply** (`/{cc}/{lang}/apply?jobSeqNo={jobSeqNo}` [R]; config `workflowApplyBundleUrl`,
  `oneTimeLoginLink: true` [V]) or a redirect to the backing ATS (Workday, SuccessFactors, Taleo…) when the job has `externalApply` or the ATS is hosted [R: phenom.com blog].
- Apply button: commonly `a[data-ph-at-id="apply-link"]`, text "Apply Now" [?: not seen in SSR HTML].

**Driver recipe:** click Apply and follow it. If the URL lands on a known ATS host, switch to that recipe. Otherwise
treat it as a generic multi-step form (label-driven fill, then Next/Submit, then a success-text check). Hosted apply may email a
one-time login link (`oneTimeLoginLink`), so pause for the owner.

---

## 15. Handshake (EXU's student board: a source, and a portal for native applies)

**Data** [V 2026-10-09] (no public API: everything runs as the logged-in page, `JB.fetchJson` in the jobbot Firefox; lib/handshake.js)
- Search: `GET /stu/postings?query=Q&job.job_types[]=3&sort_column=created_at&sort_direction=desc&page=N&per_page=50` with
  `Accept: application/json` (without it the server redirects to the `/job-search` HTML). `results[].job`: `employer_name`,
  `title`, `location_names`, `salary_min_raw` / `salary_max_raw` **in cents** with `pay_schedule.name` (Hourly Wage /
  Annual Salary / Monthly Stipend; employers mislabel it: Pinecrest "Annual Salary" 3277 = $32.77/hr), `created_at`.
  Facets in `filter_views` (`job.job_types`: 3 Internship, 9 Job, 4 Co-op).
- Job detail: `POST /hs/graphql {query}` (plain queries work; no persisted-query hash needed; introspection is off). Fields
  that exist: `job(id) { title description remote locations { name city stateAbbreviation } employer { name }
  jobApplySetting { applyType externalApplyType externalUrl alternativeExternalUrl additionalInstructions }
  requiredDocumentTypes { behaviorIdentifier name } screeningQuestions { id question } }`. Batch with aliases (15 per call).
- Applied?: `currentUser { applications(input: { filter: { applicableId: "<jobId>", applicableType: JOB } }) { nodes { id createdAt status } } }`.
- The app's own GraphQL client keeps a fetch reference from boot: hooking `window.fetch` later sees none of its calls
  (Resource Timing still lists `/hs/graphql`); the queries were read from the public JS bundles instead.

**Apply routing** (`jobApplySetting.applyType`): `EXTERNAL` + `externalApplyType: URL` → the employer's ATS (`externalUrl`,
tracking params and Workday `/apply` stripped; ~80% of security/IT/SWE internships). Some `externalUrl`s are a careers
home page (NYSTRS `…/NYSTRS_Careers`, NC Auditor): `jobctl find` the posting. Short links (`smrtr.io` = SmartRecruiters) are
followed in Node; `click.appcast.io` answers a bot check (403) and is left for the browser to follow. `HANDSHAKE` and
`HANDSHAKE_AND_EXTERNAL` → native apply on Handshake.

**Native apply** [V up to Submit, Driftmere SWE intern, --dry]: job page "Apply" → `role=dialog` "Apply to {employer}"
(`[data-hook=apply-modal-content]`). One `fieldset[aria-labelledby^=apply-modal-document-heading]` per required document
("Attach your resume" / transcript / cover letter). Handshake pre-picks the last-used document (green chip `<h5>name</h5>` +
Close button). Close it → a "Search your resumes" combobox + **"Upload new"** `input[type=file]` (max **1 MB**). Uploading
saves the file to the owner's Handshake documents ("Document saved" toast) and shows it as the chip, plus an unticked "Set as
default resume" box (leave it). Notes such as "Your school year does not match what is requested" do not block Submit.
Employer questions (atsDetail / screeningQuestions) sit in the same modal. Then **"Submit Application"**.
Driver: lib/handshake-apply.js (`kind()` before drive's switch: `hs_modal`, `hs_login`, `already` / `done` from
GraphQL; `stepModal()`: documents, then the generic stepForm for questions and Submit with the usual gates).
External applies on Handshake ask "Did you apply?" afterwards; jobbot never confirms those (the ATS run is the record).

---

## Generic fallbacks for the driver

- History repeaters on any other form (an "Employment" / "Work Experience" / "Education" / "Certifications" heading with
  fields and an "+ Add another"): `JB.repeaters()` takes the fields from the heading to the next heading of its level,
  splits entries where the first label comes round again, and `fillRepeaters` fills / adds them like Workday's.
  Greenhouse's optional Employment section has this shape on some boards (UNVERIFIED: no capture yet).

- **ATS detection by host:** `greenhouse.io` | `lever.co` | `ashbyhq.com` | `myworkdayjobs.com` / `myworkdaysite.com` |
  `icims.com` | `smartrecruiters.com` | `oraclecloud.com/hcmUI/CandidateExperience` | `taleo.net` | `jobvite.com` |
  `bamboohr.com/careers` | `apply.workable.com` | `ats.rippling.com` | `eightfold.ai` or `/careers/apply?pid=` |
  Phenom (`phenompeople` assets, `jobSeqNo`).
  For company domains, sniff iframes (`#grnhse_iframe`, `#icims_content_iframe`) and the query (`gh_jid`, `ashby_jid`, `lever-`).
- **Success detection:** URL change (Greenhouse `/confirmation`, Lever `/thanks`) OR text match
  /thank you|successfully (been )?submitted|application (was )?(sent|received|submitted)|you have successfully applied|congratulations/i.
  Store a screenshot or the HTML as proof.
- **Human hand-off triggers:** a visible captcha iframe (hCaptcha, reCAPTCHA, Turnstile, DataDome); Greenhouse `#security-input-0`;
  Oracle PIN; Workday "account may need verification"; any "verify your email" text.
- **Rate limits:** space applications by minutes, not seconds. Workday, Oracle (`ORA_IRC_TOO_MANY_REQUESTS`) and
  DataDome/Turnstile all score velocity. Reuse one real browser profile and avoid parallel tabs on the same ATS.
- **Commonly required fields:** "How did you hear about us?", work authorization / sponsorship, location, salary expectation,
  EEO/veteran/disability (choose "decline to self-identify" when the owner wants that), privacy consent, e-signature.
