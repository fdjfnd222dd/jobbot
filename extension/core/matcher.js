/*
 * core/matcher.js
 *
 * Turns a field's label text into a profile key ("firstName", "email", ...)
 * with a confidence score between 0 and 1.
 *
 * Order of checks (see SPEC.md "Architecture"):
 *   1. Veto: anything that smells like someone else's data (emergency contact,
 *      references, employer, ...) matches NOTHING. This runs first and wins.
 *   2. Exact normalized phrase match.
 *   3. Weighted keyword rules.
 *   (Fuzzy matching belongs to the Q&A bank and arrives in Phase 3.)
 *
 * Loaded two ways: as a content script (attaches to globalThis.AF) and as a
 * CommonJS module in Node tests.
 */
(function (root) {
  'use strict';

  const AF = (root.AF = root.AF || {});

  // At or above this the field is outlined green; below it, orange.
  const HIGH_CONFIDENCE = 0.75;
  // Below this we do not fill at all.
  const MIN_CONFIDENCE = 0.5;

  /* ------------------------------------------------------------------ */
  /* Normalization                                                        */
  /* ------------------------------------------------------------------ */

  // Split camelCase and letter/digit boundaries: "addressLine1" -> "address Line 1".
  function splitCamel(text) {
    return String(text || '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([a-zA-Z])(\d)/g, '$1 $2')
      .replace(/(\d)([a-zA-Z])/g, '$1 $2');
  }

  // The {company} placeholder (core/company.js) survives normalization, so a
  // stored "worked at {company} before" stays itself when normalized again.
  const COMPANY_TOKEN = /\{\s*company\s*\}/gi;
  const COMPANY_MARK = 'zqcompanyqz';

  function normalize(text) {
    return splitCamel(String(text || '').replace(COMPANY_TOKEN, ` ${COMPANY_MARK} `))
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[’']/g, '')
      .replace(/\bplease (select|choose|enter)( one)?\b/g, ' ')
      .replace(/\bselect one\b/g, ' ')
      .replace(/\((required|optional)\)/g, ' ')
      .replace(/\b(required|optional)\s*$/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\bzqcompanyqz\b/g, '{company}');
  }

  /* ------------------------------------------------------------------ */
  /* Vetoes: never fill these with the user's own data                    */
  /* ------------------------------------------------------------------ */

  // Checked against the label and the attribute hints.
  const LABEL_VETO = [
    /\bemergency\b/,
    /\bnext of kin\b/,
    /\bkin\b/,
    /\breferences?\b(?! (id|number|no|code)\b)/,
    /\breferr(als?|ers?|ed|ing)\b/,
    /\breferee\b/,
    /\bguardian\b/,
    /\bparents?\b/,
    /\bspouses?\b/,
    /\brelatives?\b/,
    /\brelationship\b/,
    /\bsupervisors?\b/,
    /\bmanagers?\b/,
    /\brecruiters?\b/,
    /\bemployers?\b/,
    /\bcompan(y|ys|ies)\b/,
    /\bbeneficiary\b/,
    /\bcontact person\b/,
    // A typed signature is not a name field, even when it says "Name".
    /\bsignature\b/,
    /\bsign (here|below)\b/,
    /\be ?sign\w*\b/,
    /\binitials\b/,
  ];

  // Checked against the section heading / fieldset legend. Narrower than
  // LABEL_VETO because a heading covers many fields.
  const CONTEXT_VETO = [
    /\bemergency\b/,
    /\bnext of kin\b/,
    /\breferences?\b(?! (id|number|no|code)\b)/,
    /\bguardian\b/,
    /\bspouses?\b/,
    /\bbeneficiary\b/,
  ];

  function isVetoed(texts, vetoes) {
    return texts.some((t) => t && vetoes.some((re) => re.test(t)));
  }

  // Fields the owner never wants touched OR outlined (2026-10-02): salary /
  // pay expectations, and anything about an emergency contact / next of kin
  // (by label or by section). They are skipped silently, even when required.
  // References (2026-10-02, Phase 4): "Reference 1 name", "Professional references"
  // too, by label as well as by section. Not "reference number/ID/code".
  // Also "Expected CTC", "Rate of pay desired", "How much do you expect to be paid?",
  // "Desired annual earnings", "Starting pay", "Expected stipend" (reviewed 2026-10-03).
  const IGNORED_LABEL = /\b(salary|salaries|compensation|remuneration|wages?|pay (rate|range|expectations?|requirements?|expected|desired)|(desired|expected|target|hourly|current|starting|minimum|base) (pay|rate|earnings|income|wages?|ctc|stipend)|ctc|stipend|annual (income|earnings)|rate of pay|expect\w* to (be paid|earn)|emergency|next of kin|referees?|references?(?! (id|number|no|code)\b))\b/;

  function isIgnored(desc) {
    const texts = [normalize(desc.label), ...(desc.hints || []).map(normalize)];
    return texts.some((t) => t && IGNORED_LABEL.test(t)) || isVetoed([normalize(desc.context)], CONTEXT_VETO);
  }

  /** Does the label/hints ('label') or the section ('context') veto this field? */
  function fieldVetoed(desc, which) {
    if (which === 'context') return isVetoed([normalize(desc.context)], CONTEXT_VETO);
    return isVetoed([normalize(desc.label), ...(desc.hints || []).map(normalize)], LABEL_VETO);
  }

  /* ------------------------------------------------------------------ */
  /* Rules                                                                */
  /* ------------------------------------------------------------------ */

  // Exact normalized label -> key. Confidence 1.0.
  const EXACT = {
    'first name': 'firstName',
    'legal first name': 'firstName',
    'given name': 'firstName',
    'preferred name': 'preferredName',
    'preferred first name': 'preferredName',
    'nickname': 'preferredName',
    'middle name': 'middleName',
    'middle initial': 'middleInitial',
    'last name': 'lastName',
    'legal last name': 'lastName',
    'family name': 'lastName',
    'surname': 'lastName',
    'name': 'fullName',
    'full name': 'fullName',
    'legal name': 'fullName',
    'full legal name': 'fullName',
    'your name': 'fullName',
    'email': 'email',
    'email address': 'email',
    'e mail': 'email',
    'phone': 'phone',
    'phone number': 'phone',
    'mobile phone': 'phone',
    'mobile number': 'phone',
    'phone device type': 'phoneType',
    'phone type': 'phoneType',
    'device type': 'phoneType',
    'country phone code': 'phoneCountryCode',
    'phone country code': 'phoneCountryCode',
    'country code': 'phoneCountryCode',
    'do you have a preferred name': 'hasPreferredName',
    'i have a preferred name': 'hasPreferredName',
    'state of residence': 'state',
    'current state of residence': 'state',
    'state of current residence': 'state',
    'address': 'addressLine1',
    'street address': 'addressLine1',
    'address line 1': 'addressLine1',
    'address line 2': 'addressLine2',
    'city': 'city',
    'state': 'state',
    'state province': 'state',
    'zip': 'postalCode',
    'zip code': 'postalCode',
    'postal code': 'postalCode',
    'country': 'country',
    'linkedin': 'linkedin',
    'linkedin profile': 'linkedin',
    'linkedin url': 'linkedin',
    'github': 'github',
    'github url': 'github',
    'portfolio': 'portfolio',
    'website': 'portfolio',
    'school': 'school',
    'university': 'school',
    'degree': 'degree',
    'major': 'major',
    'field of study': 'major',
    'minor': 'minor',
    'gpa': 'gpa',
    'graduation date': 'gradDate',
    'graduation month': 'gradMonth',
    'graduation year': 'gradYear',
    'todays date': 'todayDate',
    'today s date': 'todayDate',
    'current date': 'todayDate',
    'date of today': 'todayDate',
  };

  // Words that put address/contact rules into someone else's context
  // (school address, work phone) — the rule declines rather than guessing.
  const NOT_HOME = '\\b(school|university|college|work|office|business|billing|birth)\\b';
  // The profile holds the college / university degree: a high-school question is not it.
  const HIGH_SCHOOL = '\\b(high school|secondary school|secondary education|ged|hs diploma)\\b';
  const GRAD = '(graduat\\w*|grad|completion|degree (conferred|completed|date|awarded))';
  const MONTH_YEAR = '\\b(month (and |or |\\/ ?)?year|mm ?(\\/ ?)?yyyy)\\b';

  // A label opening like this is a yes/no question, not a profile value.
  const QUESTION_START = /^(are|am|do|does|did|have|has|had|will|would|can|could|is|was|were|should|attended|if)\b/;

  // key -> { patterns: [[regexSource, weight]], exclude: [regexSource], penalty: [[regexSource, minus]],
  //          question: true if the key answers a yes/no question }
  const RULES = {
    preferredName: {
      patterns: [
        ['\\bpreferred (first )?name\\b', 0.98],
        ['\\bnick ?name\\b', 0.95],
        ['\\bgoes by\\b', 0.85],
        ['\\bwhat (do|should) we call you\\b', 0.9],
        ['\\bfirst name preferred\\b', 0.95],
        ['\\bpreferred\\b.*\\bname\\b', 0.8],
      ],
      exclude: ['\\b(last|family|sur)\\s?name\\b', '\\bpronoun', '\\bhave\\b'],
    },
    // "Is your legal name the same as your preferred name?" (Eightfold)
    legalNameSame: {
      question: true,
      patterns: [
        ['\\blegal name\\b.*\\bsame\\b.*\\bpreferred name\\b', 0.95],
        ['\\bpreferred name\\b.*\\bsame\\b.*\\blegal name\\b', 0.95],
      ],
    },
    hasPreferredName: {
      question: true,
      patterns: [
        ['\\b(do you|i) have a preferred (first )?name\\b', 0.95],
        ['\\bpreferred name\\b.*\\bdifferent\\b', 0.8],
      ],
    },
    firstName: {
      patterns: [
        ['\\bfirst name\\b', 0.95],
        ['\\bgiven name\\b', 0.95],
        ['\\bforename\\b', 0.9],
        ['\\bf ?name\\b', 0.8],
      ],
      exclude: ['\\bpreferred\\b', '\\bnick', '\\bfirst (and|last) (last )?name\\b', '\\bfirst last\\b'],
    },
    middleName: {
      patterns: [['\\bmiddle name\\b', 0.95]],
      exclude: ['\\binitial\\b'],
    },
    middleInitial: {
      patterns: [['\\bmiddle initial\\b', 0.95], ['\\bmi\\b', 0.6]],
    },
    lastName: {
      patterns: [
        ['\\blast name\\b', 0.95],
        ['\\bfamily name\\b', 0.95],
        ['\\bsurname\\b', 0.95],
        ['\\bl ?name\\b', 0.8],
      ],
      exclude: ['\\bfirst\\b'],
      // "Preferred last name" is usually the same as legal, but flag it.
      penalty: [['\\bpreferred\\b', 0.35]],
    },
    fullName: {
      patterns: [
        ['\\bfull (legal )?name\\b', 0.95],
        ['\\bfirst (and )?last name\\b', 0.95],
        ['\\blegal name\\b', 0.85],
        ['^(your )?name$', 0.85],
        ['\\b(applicant|candidate)( s)? (full )?name\\b', 0.85],
      ],
      exclude: ['\\b(middle|preferred|nick|user|school|university|file)\\b'],
    },
    email: {
      patterns: [['\\be ?mail\\b', 0.95]],
      exclude: ['\\b(school|work|university)\\b'],
    },
    phone: {
      patterns: [
        ['\\b(tele)?phone\\b', 0.9],
        ['\\bmobile\\b', 0.85],
        ['\\bcell\\b', 0.85],
        ['\\bcontact number\\b', 0.8],
      ],
      // An "Alternate / secondary phone" would only repeat the main one.
      exclude: ['\\b(ext|extension|type|device|country|code|alt|alternate|alternative|secondary|additional|other)\\b', NOT_HOME],
    },
    phoneType: {
      patterns: [
        ['\\b(phone )?device type\\b', 0.95],
        ['\\bphone (number )?type\\b', 0.95],
        ['\\btype of (phone|number)\\b', 0.9],
      ],
      exclude: [NOT_HOME],
    },
    phoneCountryCode: {
      patterns: [
        ['\\bcountry (phone |dialing |calling )?code\\b', 0.95],
        ['\\b(phone|dialing|calling) (country )?code\\b', 0.9],
      ],
      exclude: ['\\b(zip|postal|area)\\b', NOT_HOME],
    },
    addressLine1: {
      patterns: [
        ['\\baddress line 1\\b', 0.97],
        ['\\baddress 1\\b', 0.95],
        ['\\bstreet address\\b', 0.95],
        ['\\bstreet\\b', 0.85],
        ['\\b(home|mailing|current|residential|permanent) address\\b', 0.85],
        ['^address$', 0.8],
      ],
      exclude: ['\\b(line 2|address 2|e ?mail|web|url|ip)\\b', NOT_HOME],
    },
    addressLine2: {
      patterns: [
        ['\\baddress line 2\\b', 0.97],
        ['\\baddress 2\\b', 0.95],
        ['\\b(apt|apartment|suite)\\b', 0.85],
        ['\\bunit\\b', 0.6],
      ],
      exclude: [NOT_HOME],
    },
    city: {
      patterns: [['\\bcity\\b', 0.95], ['\\btown\\b', 0.8], ['\\bmunicipality\\b', 0.8]],
      exclude: [NOT_HOME],
    },
    state: {
      patterns: [['\\bstate\\b', 0.9], ['\\bprovince\\b', 0.9], ['\\bregion\\b', 0.65]],
      // Workday "County" (address--regionSubdivision1) is not the state.
      exclude: ['\\bunited states\\b', '\\bstate of\\b', '\\b(authori[sz]ed|sponsor\\w*)\\b', '\\b(county|subdivision)\\b', NOT_HOME],
    },
    postalCode: {
      patterns: [['\\bzip\\b', 0.95], ['\\bpostal\\b', 0.95], ['\\bpost ?code\\b', 0.95]],
      exclude: [NOT_HOME],
    },
    country: {
      patterns: [['\\bcountry\\b', 0.9]],
      exclude: [
        '\\b(code|citizenship|nationality|authori[sz]ed|phone|dialing)\\b',
        NOT_HOME,
      ],
    },
    linkedin: {
      patterns: [['\\blinked ?in\\b', 0.97]],
    },
    github: {
      patterns: [['\\bgit ?hub\\b', 0.97]],
    },
    portfolio: {
      patterns: [
        ['\\bportfolio\\b', 0.95],
        ['\\bpersonal (web ?)?site\\b', 0.95],
        ['\\bweb ?site\\b', 0.85],
        ['\\b(personal )?url\\b', 0.55],
      ],
      exclude: ['\\b(linked ?in|git ?hub|twitter|facebook|instagram)\\b'],
    },
    school: {
      patterns: [
        ['\\bschool( name)?\\b', 0.9],
        ['\\buniversity\\b', 0.9],
        ['\\bcollege\\b', 0.85],
        ['\\binstitution\\b', 0.85],
      ],
      // "Please select the university ... where you completed your highest degree"
      // mentions a degree but asks for the school.
      exclude: [
        '\\bhigh school\\b',
        '\\b(city|state|country|address|email|phone|gpa|major|year|date|month)\\b',
        // Mentions a degree, unless phrased "institution where/which you ... degree".
        '^(?!.*\\b(institution|university|college|school)\\b.*\\b(where|which)\\b).*\\bdegree\\b',
        GRAD,
      ],
    },
    degree: {
      patterns: [
        ['\\bdegree\\b', 0.9],
        ['\\b(level of education|education level)\\b', 0.8],
      ],
      exclude: [
        '\\b(major|field|discipline|date|year|month|gpa|study|speciali[sz]ation)\\b',
        '\\b(institution|university|college|school)\\b.*\\b(where|which)\\b',
        // "Highest level of education COMPLETED": a student's answer is not the degree in progress.
        '\\b(highest|level)\\b.*\\bcompleted\\b',
        GRAD,
      ],
    },
    major: {
      patterns: [
        ['\\bmajor\\b', 0.9],
        ['\\b(field|area) of study\\b', 0.95],
        ['\\bdiscipline\\b', 0.75],
        ['\\bconcentration\\b', 0.65],
        ['\\bspeciali[sz]ation\\b', 0.85],
      ],
      exclude: ['\\bminor\\b'],
    },
    minor: {
      patterns: [['\\bminor\\b', 0.85]],
      exclude: ['\\b(are|is) you\\b', '\\bunder\\b', '\\bage\\b', '\\b18\\b'],
    },
    gradMonth: {
      patterns: [[GRAD + '.*\\bmonth\\b', 0.95], ['\\bmonth\\b.*' + GRAD, 0.95]],
      exclude: [MONTH_YEAR, HIGH_SCHOOL],
    },
    gradYear: {
      patterns: [
        [GRAD + '.*\\byear\\b', 0.95],
        ['\\byear\\b.*' + GRAD, 0.95],
        ['\\bclass of\\b', 0.8],
      ],
      exclude: [MONTH_YEAR, HIGH_SCHOOL],
    },
    gradDate: {
      patterns: [
        ['\\b' + GRAD + ' date\\b', 0.95],
        ['\\bexpected ' + GRAD + '\\b', 0.85],
        ['\\b' + GRAD + '\\b', 0.7],
      ],
      // A lone month or year field is gradMonth/gradYear; "(month and year)" is this.
      exclude: ['^(?!.*' + MONTH_YEAR + ').*\\b(month|year)\\b', HIGH_SCHOOL],
    },
    gpa: {
      patterns: [['\\bgpa\\b', 0.97], ['\\bgrade point average\\b', 0.97]],
      exclude: ['\\b(scale|out of|maximum|max)\\b', HIGH_SCHOOL],
    },
  };

  // Compile once.
  const COMPILED = Object.entries(RULES).map(([key, r]) => ({
    key,
    question: !!r.question,
    patterns: r.patterns.map(([src, w]) => [new RegExp(src), w]),
    exclude: (r.exclude || []).map((src) => new RegExp(src)),
    penalty: (r.penalty || []).map(([src, w]) => [new RegExp(src), w]),
  }));

  // HTML autocomplete tokens are strong, standardized hints.
  const AUTOCOMPLETE = {
    'given-name': 'firstName',
    'additional-name': 'middleName',
    'family-name': 'lastName',
    'name': 'fullName',
    'nickname': 'preferredName',
    'email': 'email',
    'tel': 'phone',
    'tel-national': 'phone',
    'address-line1': 'addressLine1',
    'street-address': 'addressLine1',
    'address-line2': 'addressLine2',
    'address-level2': 'city',
    'address-level1': 'state',
    'postal-code': 'postalCode',
    'country': 'country',
    'country-name': 'country',
  };

  const INSTRUCTION = /\b(otherwise )?(please )?(select|answer|choose|check|tick|mark|click|indicate) (yes|no|one|y|n)\b( (below|above|here|if applicable|or no|otherwise))*/g;

  const ANSWER_TAIL = /( (yes|no|y|n)( (below|above|here))?)+( (otherwise|else)( (yes|no|y|n)( (below|above|here))?)*)?$/;

  // Free-text prompts that merely mention a profile word ("Email marketing
  // experience", "City planning experience", "Major projects you have led",
  // "Please state your reasons for applying", "Describe a time ... at school"):
  // never a profile field by keyword (an EXACT label still counts).
  const FREE_TEXT = /\b(experience|projects?|skills?|reasons?|describe|explain|elaborate|tell us|share|why|motivat\w*|accomplishments?|achievements?|interests?|example|summary|cover letter)\b/;

  function scoreText(norm) {
    if (FREE_TEXT.test(norm)) return null;
    const candidates = [];
    const isQuestion = QUESTION_START.test(norm);
    for (const rule of COMPILED) {
      if (isQuestion && !rule.question) continue;
      if (rule.exclude.some((re) => re.test(norm))) continue;
      let best = 0;
      for (const [re, w] of rule.patterns) if (w > best && re.test(norm)) best = w;
      if (!best) continue;
      for (const [re, minus] of rule.penalty) if (re.test(norm)) best -= minus;
      candidates.push({ key: rule.key, confidence: best });
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
    if (!candidates.length) return null;

    const top = { ...candidates[0] };
    // Answering instructions are not part of the question ("..., please select yes
    // below; otherwise, please select no"): they only make a label look long.
    // normalize() already dropped "please select", leaving "... yes below otherwise no".
    const words = norm.replace(INSTRUCTION, ' ').replace(ANSWER_TAIL, '').trim().split(/\s+/).length;
    // Long labels are usually questions, not profile fields.
    if (words > 16) return null;
    if (words > 8) top.confidence *= 0.75;
    // Two rules nearly tied: fill, but ask for review.
    if (candidates[1] && top.confidence - candidates[1].confidence < 0.1) {
      top.confidence = Math.min(top.confidence, 0.6);
    }
    return top;
  }

  /**
   * Match a field descriptor (built by an adapter) to a profile key.
   *
   * desc = {
   *   label:        visible question text (best guess, raw)
   *   hints:        [raw strings]  name/id/data-automation-id/placeholder
   *   context:      raw section heading or fieldset legend, if any
   *   autocomplete: the element's autocomplete attribute
   *   inputType:    'text' | 'email' | 'tel' | 'select' | ...
   *   keyHint:      optional key an adapter already knows (vetoes still apply)
   * }
   * Returns { key, confidence, source } or null.
   */
  function matchField(desc) {
    const label = normalize(desc.label);
    const hints = (desc.hints || []).map(normalize).filter(Boolean);
    const context = normalize(desc.context);

    if (isVetoed([label, ...hints], LABEL_VETO)) return null;
    if (isVetoed([context], CONTEXT_VETO)) return null;

    // An adapter that knows a field from a stable id (Greenhouse "end-month--0")
    // can name the key outright.
    if (desc.keyHint) {
      return { key: desc.keyHint, confidence: desc.keyHintConfidence || 0.95, source: 'adapter' };
    }

    if (label && EXACT[label]) return { key: EXACT[label], confidence: 1, source: 'exact' };
    // A bare "Date" (EEO / self-identification blocks) is today's date: review it.
    if (label === 'date') return { key: 'todayDate', confidence: 0.7, source: 'exact' };

    if (label) {
      const hit = scoreText(label);
      // A textarea is a free-text answer: a keyword match there is always reviewed.
      if (hit && desc.inputType === 'textarea') hit.confidence = Math.min(hit.confidence, 0.7);
      if (hit && hit.confidence >= MIN_CONFIDENCE) return { ...hit, source: 'label' };
      // A real label that matched nothing: do not let attribute noise override it.
      if (label.split(' ').length > 3) return null;
    }

    const ac = String(desc.autocomplete || '').toLowerCase().split(/\s+/).pop();
    if (AUTOCOMPLETE[ac]) return { key: AUTOCOMPLETE[ac], confidence: 0.9, source: 'autocomplete' };

    for (const h of hints) {
      if (EXACT[h]) return { key: EXACT[h], confidence: 0.85, source: 'hint' };
      const hit = scoreText(h);
      if (hit && hit.confidence * 0.85 >= MIN_CONFIDENCE) {
        return { key: hit.key, confidence: hit.confidence * 0.85, source: 'hint' };
      }
    }

    if (!label) {
      if (desc.inputType === 'email') return { key: 'email', confidence: 0.7, source: 'type' };
      if (desc.inputType === 'tel') return { key: 'phone', confidence: 0.7, source: 'type' };
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Values                                                               */
  /* ------------------------------------------------------------------ */

  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  const US_STATES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
    CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
    FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
    IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
    ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
    MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
    NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
    NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
    PA: 'Pennsylvania', PR: 'Puerto Rico', RI: 'Rhode Island', SC: 'South Carolina',
    SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
    VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  };

  // Each group lists spellings that mean the same thing. Option matching only
  // ever accepts a spelling from the same group: no prefix/substring guesses.
  const COUNTRY_ALIASES = [
    ['United States', 'United States of America', 'USA', 'US', 'U.S.', 'U.S.A.', 'America'],
    ['United Kingdom', 'UK', 'Great Britain', 'England'],
    ['Canada', 'CA'],
  ];

  const PHONE_TYPE_ALIASES = [
    ['Mobile', 'Cell', 'Cell Phone', 'Cellular', 'Mobile Phone', 'Mobile/Cell', 'Cell/Mobile', 'Personal Mobile'],
    ['Home', 'Home Phone', 'Landline', 'Residence'],
    ['Work', 'Work Phone', 'Office', 'Business'],
  ];

  const YES_NO_ALIASES = [['Yes', 'Y'], ['No', 'N']];

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  /**
   * The string to type for `key`, given the profile and the target input type.
   * Returns '' when the profile has nothing for it.
   */
  function valueFor(key, profile, inputType) {
    const p = profile || {};
    const month = parseInt(p.gradMonth, 10);
    const year = String(p.gradYear || '').trim();
    switch (key) {
      case 'fullName':
        return [p.firstName, p.lastName].filter(Boolean).join(' ');
      case 'preferredName':
        return p.preferredName || p.firstName || '';
      case 'middleInitial':
        return p.middleName ? p.middleName.trim().charAt(0).toUpperCase() : '';
      case 'phoneCountryCode':
        // Dial-code pickers list countries ("United States of America (+1)").
        return p.country == null ? '' : String(p.country).trim();
      case 'hasPreferredName': {
        if (!p.firstName) return '';
        const pref = normalize(p.preferredName);
        return pref && pref !== normalize(p.firstName) ? 'Yes' : 'No';
      }
      case 'legalNameSame': {
        // Same = no preferred name, or one equal to the legal first name.
        if (!p.firstName) return '';
        const pref = normalize(p.preferredName);
        return !pref || pref === normalize(p.firstName) ? 'Yes' : 'No';
      }
      case 'gradMonth':
        if (!month) return '';
        return inputType === 'select' ? String(month) : MONTHS[month - 1];
      case 'todayDate': {
        const d = new Date();
        if (inputType === 'date') return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
        return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`;
      }
      case 'gradDate':
        if (!month || !year) return '';
        if (inputType === 'month') return `${year}-${pad2(month)}`;
        if (inputType === 'date') return `${year}-${pad2(month)}-01`;
        return `${pad2(month)}/${year}`;
      default:
        return p[key] == null ? '' : String(p[key]).trim();
    }
  }

  function aliasGroup(groups, v) {
    return groups.find((g) => g.some((a) => normalize(a) === normalize(v))) || [];
  }

  /** Equivalent spellings used when picking a <select> option. */
  function valueVariants(key, value) {
    const v = String(value || '').trim();
    if (!v) return [];
    const out = [v];
    if (key === 'state') {
      const up = v.toUpperCase();
      if (US_STATES[up]) out.push(US_STATES[up]);
      for (const [abbr, name] of Object.entries(US_STATES)) {
        if (name.toLowerCase() === v.toLowerCase()) out.push(abbr);
      }
    } else if (key === 'country' || key === 'phoneCountryCode') {
      out.push(...aliasGroup(COUNTRY_ALIASES, v));
    } else if (key === 'phoneType') {
      out.push(...aliasGroup(PHONE_TYPE_ALIASES, v));
    } else if (key === 'hasPreferredName' || key === 'legalNameSame' || key === 'qa') {
      out.push(...aliasGroup(YES_NO_ALIASES, v));
    } else if (key === 'gradMonth') {
      const m = parseInt(v, 10);
      if (m >= 1 && m <= 12) out.push(pad2(m), MONTHS[m - 1], MONTHS[m - 1].slice(0, 3));
    }
    return [...new Set(out)];
  }

  // Broad families so "Bachelor of Science" can pick an option like "Bachelor's Degree".
  const DEGREE_FAMILIES = [
    /\b(bachelor|bachelors|bs|ba|bsc|bse|undergraduate)\b/,
    /\b(master|masters|ms|ma|msc|mba|meng)\b/,
    /\b(doctor|doctorate|phd|doctoral)\b/,
    /\b(associate|associates|aa|as)\b/,
    /\b(high school|ged|diploma)\b/,
  ];

  function degreeFamily(text) {
    const n = normalize(text);
    return DEGREE_FAMILIES.findIndex((re) => re.test(n));
  }

  // Placeholder-looking option text: "Select...", "-- Choose --", "Please select", "----".
  // "Choose not to Disclose" (Phenom gender) is a real answer, not a placeholder.
  const PLACEHOLDER_OPTION = /^(|-+|(select|choose)(?!.*\bnot\b).*|please select.*|none selected|--.*--)$/;

  function isPlaceholderText(text) {
    return PLACEHOLDER_OPTION.test(normalize(text)) || /^[-\s]*$/.test(String(text || ''));
  }

  // "United States of America (+1)" -> "United States of America"
  // "United States+1" / "+1 United States" (dial-code pickers) -> "United States"
  // "B.S. - Bachelor of Science" (Workday degree list) -> "Bachelor of Science"
  function stripDecoration(text) {
    return String(text || '')
      .replace(/^\s*[A-Za-z][A-Za-z.]{0,7}\s+-\s+(?=\S)/, '')
      .replace(/\s*\([^)]*\)\s*$/, '')
      .replace(/\s*\+\d[\d\s-]*$/, '')
      .replace(/^\s*\+\d+\s+/, '');
  }

  /**
   * Choose the option for `value` among `options` = [{ text, value, disabled }].
   * Accepts, in order:
   *   1.0   normalized option text or value equals the profile value
   *   0.95  equals one of its known aliases (state abbreviation, "USA", "Cell")
   *   0.9   same, once a trailing "(...)" is stripped from the option text
   *   0.65  degree only: the single option in the same degree family (review)
   * Two different options tying at the top means we cannot tell: no pick.
   * Returns { index, confidence } or null.
   */
  function matchOption(options, key, value) {
    // Standard answers ("std:<questionId>") have their own variant-aware matcher.
    if (/^std:/.test(String(key || ''))) {
      const standard = AF.standard || (typeof require === 'function' ? require('./standard.js') : null);
      return standard.matchOption(options, key.slice(4), value);
    }
    const variants = valueVariants(key, value);
    const wants = (variants.length ? variants : [String(value || '')]).map(normalize).filter(Boolean);
    if (!wants.length) return null;
    const first = wants[0];
    let best = null;
    let tie = false;
    options.forEach((opt, index) => {
      if (opt.disabled || isPlaceholderText(opt.text) && !opt.value) return;
      const text = normalize(opt.text);
      const val = normalize(opt.value);
      const bare = normalize(stripDecoration(opt.text));
      let c = 0;
      if (text === first || val === first) c = 1;
      else if (wants.includes(text) || (val && wants.includes(val))) c = 0.95;
      else if (bare !== text && wants.includes(bare)) c = 0.9;
      if (!c) return;
      if (!best || c > best.confidence) {
        best = { index, confidence: c, text };
        tie = false;
      } else if (c === best.confidence && text !== best.text) {
        tie = true;
      }
    });
    if (best && !tie) return { index: best.index, confidence: best.confidence };
    if (best && tie) return null;

    if (key === 'degree') {
      // Same degree family and only one such option: fill, ask for review.
      const fam = degreeFamily(value);
      if (fam >= 0) {
        const hits = options
          .map((o, i) => [o, i])
          .filter(([o]) => !o.disabled && !isPlaceholderText(o.text) && degreeFamily(o.text) === fam);
        if (hits.length === 1) return { index: hits[0][1], confidence: 0.65 };
      }
    }
    return null;
  }

  AF.matcher = {
    HIGH_CONFIDENCE,
    MIN_CONFIDENCE,
    normalize,
    splitCamel,
    matchField,
    isVetoed: fieldVetoed,
    isIgnored,
    isYesNoQuestion: (label) => QUESTION_START.test(normalize(label)),
    valueFor,
    valueVariants,
    degreeFamily,
    matchOption,
    isPlaceholderText,
    PROFILE_KEYS: Object.keys(RULES).concat('todayDate'),
  };

  if (typeof module === 'object' && module.exports) module.exports = AF.matcher;
})(typeof globalThis !== 'undefined' ? globalThis : this);
