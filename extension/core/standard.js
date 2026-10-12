/*
 * core/standard.js
 *
 * "Standard answers": a fixed set of compliance / EEO questions that repeat on
 * every application with different wording. The owner answers each one once
 * in the options page (storage.standardAnswers = { questionId: answerId }).
 *
 * QUESTIONS is the shared definition (the options page builds its form from it).
 *
 * detect(desc)          which standard question a field asks, from robust
 *                       patterns over its label (and, for choice fields with
 *                       a generic label like "Please check one of the boxes
 *                       below", its section heading). A confident detection
 *                       counts as the "exact match" the sensitive rules need.
 * classify(qid, text)   which answer an OPTION's text means: every answer has
 *                       a recognizer, and an option counts only when exactly
 *                       one answer recognizes it ("No, I am not a protected
 *                       veteran" -> not; "Two or More Races (Not Hispanic or
 *                       Latino)" -> two).
 * matchOption(options, qid, answerId)
 *                       the single option that means the stored answer, or
 *                       null (two candidates or none: never guess, the field
 *                       is outlined yellow).
 * A question the owner left blank in the options page is never filled.
 */
(function (root) {
  'use strict';

  const AF = (root.AF = root.AF || {});

  const DECLINE = { id: 'decline', text: 'I do not wish to answer' };

  /**
   * { id, label, answers: [{ id, text }], alwaysReview?, eeo? }
   *   alwaysReview  fill, but outline orange so the owner glances at it
   *   eeo           EEO / self-identification answer
   */
  const QUESTIONS = [
    {
      id: 'workAuth',
      label: 'Authorized to work in the United States?',
      // citizen / visa: like Yes, but also pick between "Yes, as a US citizen or
      // permanent resident" and "Yes, via a visa" when a list splits them
      // (Greenhouse). A plain Yes stays ambiguous on such a list (yellow).
      answers: [
        { id: 'yes', text: 'Yes' },
        { id: 'citizen', text: 'Yes: U.S. citizen or permanent resident' },
        { id: 'visa', text: 'Yes: on a visa / work permit' },
        { id: 'no', text: 'No' },
      ],
    },
    {
      id: 'sponsorship',
      label: 'Require visa sponsorship now or in the future?',
      answers: [{ id: 'yes', text: 'Yes' }, { id: 'no', text: 'No' }],
    },
    {
      // One stored STATUS answers every wording: "Are you a U.S. citizen?" (only a
      // citizen says Yes), "U.S. citizen or permanent resident?", "U.S. citizen,
      // lawful permanent resident, refugee, or asylee?" / ITAR-EAR "U.S. person"
      // (all three say Yes), and status lists ("U.S. Citizen", "Permanent
      // Resident", "Neither"). See citizenshipScope / matchCitizenship.
      id: 'citizenship',
      label: 'U.S. citizenship / "U.S. person" status (export control, ITAR / EAR)',
      alwaysReview: true,
      answers: [
        { id: 'citizen', text: 'U.S. citizen (or U.S. national)' },
        { id: 'lpr', text: 'U.S. lawful permanent resident (green card)' },
        { id: 'asylee', text: 'Refugee or asylee in the U.S.' },
        { id: 'none', text: 'None of these' },
      ],
    },
    {
      id: 'gender',
      label: 'Gender',
      eeo: true,
      answers: [{ id: 'male', text: 'Male' }, { id: 'female', text: 'Female' }, { id: 'nonbinary', text: 'Non-binary' }, DECLINE],
    },
    {
      id: 'hispanic',
      label: 'Hispanic or Latino?',
      eeo: true,
      answers: [{ id: 'yes', text: 'Yes' }, { id: 'no', text: 'No' }, DECLINE],
    },
    {
      id: 'race',
      label: 'Race / ethnicity',
      eeo: true,
      answers: [
        { id: 'white', text: 'White' },
        { id: 'black', text: 'Black or African American' },
        { id: 'asian', text: 'Asian' },
        { id: 'hispanic', text: 'Hispanic or Latino' },
        { id: 'native', text: 'American Indian or Alaska Native' },
        { id: 'pacific', text: 'Native Hawaiian or Other Pacific Islander' },
        { id: 'two', text: 'Two or More Races' },
        DECLINE,
      ],
    },
    {
      id: 'veteran',
      label: 'Veteran status',
      eeo: true,
      answers: [
        { id: 'not', text: 'I am not a protected veteran' },
        { id: 'protected', text: 'I identify as one or more of the classifications of protected veteran' },
        DECLINE,
      ],
    },
    {
      id: 'disability',
      label: 'Disability status (form CC-305)',
      eeo: true,
      answers: [
        { id: 'yes', text: 'Yes, I have a disability (or previously had a disability)' },
        { id: 'no', text: 'No, I do not have a disability and have not had one in the past' },
        DECLINE,
      ],
    },
    {
      id: 'privacyAck',
      label: 'Privacy / data transfer acknowledgment',
      alwaysReview: true,
      answers: [{ id: 'acknowledge', text: 'Acknowledge / Confirm' }],
    },
    {
      id: 'otherPositions',
      label: 'May we consider you for other positions?',
      answers: [{ id: 'yes', text: 'Yes' }, { id: 'no', text: 'No' }],
    },
    {
      id: 'previouslyEmployed',
      label: 'Previously worked at this company?',
      alwaysReview: true,
      answers: [{ id: 'yes', text: 'Yes' }, { id: 'no', text: 'No' }],
    },
    {
      id: 'clientEmployed',
      label: 'Currently employed by a client of this company?',
      alwaysReview: true,
      answers: [{ id: 'yes', text: 'Yes' }, { id: 'no', text: 'No' }],
    },
    {
      id: 'relatives',
      label: 'Relatives, family or a close personal relationship with an employee or applicant?',
      alwaysReview: true,
      answers: [{ id: 'yes', text: 'Yes' }, { id: 'no', text: 'No' }],
    },
    {
      id: 'referred',
      label: 'Referred by a current employee?',
      alwaysReview: true,
      answers: [{ id: 'yes', text: 'Yes' }, { id: 'no', text: 'No' }],
    },
  ];

  const matcher = AF.matcher || (typeof require === 'function' ? require('./matcher.js') : null);

  /* ------------------------------------------------------------------ */
  /* Which question is this?                                              */
  /* ------------------------------------------------------------------ */

  // [id, patterns (any), exclude (none)] on the normalized label. Order matters:
  // the first question whose patterns hit and excludes miss wins.
  //
  // Labels arrive here twice when the hiring company is known: as written, and
  // with the company replaced by {company} (core/company.js). The {company}
  // patterns only ever match the second form.
  // "Have you ever been employed by the U.S. Government / a competitor / a staffing
  // agency?" names another employer: not "previously worked HERE". Only right after
  // by / for / at / with / of: a Workday tenant's "worked for or with {company} ... through a
  // Staffing Agency" lists ways of having worked HERE.
  const NOT_THIS_EMPLOYER = /\b(by|for|at|with|of) (a |an |the |any )?(u s |us |federal |state |local )?(government\w*|federal|competitors?|staffing|military|armed forces|public sector|municipal\w*)\b/;

  const DETECT = [
    // Relatives / family / a close personal relationship with an employee or
    // another applicant. Before everything else: "relatives employed by a
    // client" or "family member who previously worked here" is THIS question.
    // Not: the follow-up "name / relationship of the relative" (text fields),
    // government-official questions, emergency contacts (vetoed by section).
    ['relatives', [
      /\b(relatives?|family members?|members? of your (immediate )?(family|household)|immediate family|related to|household members?|spouse|domestic partner|close (personal )?relationship|personal relationship|romantic relationship)\b.*(\b(employ\w*|work\w*|staff|applicants?|candidates?|personnel)\b|\{company\})/,
      /(\b(employ\w*|staff|applicants?|candidates?)\b|\{company\}).*\b(relatives?|related to you|family members?|immediate family|spouse|domestic partner|close (personal )?relationship|personal relationship)\b/,
    ], [/\b(names?|list|describe|explain|provide|identify|who|whom|which|what is|relationship to (you|them|the)|official|government|politically|public office)\b/, /\bemergency\b/, /\bhow did you\b/]],
    // Referred by a current employee (yes/no). Not "Referral source", "Name of
    // the employee who referred you", "How did you hear about us".
    ['referred', [
      /\b(referr\w*|refer)\b.*\b(employees?|staff|associates?|team members?|colleagues?|someone (at|who works))\b|\b(referr\w*|refer)\b.*\{company\} (employee|staff|associate)/,
      /\b(employee|staff|associate) referral\b/,
      // A Workday tenant: "did either of the following refer or recommend you for this or any other position"
      /\b(refer|referred|recommend\w*)\b (or (refer|referred|recommend\w*) )?(you|me)\b/,
    ], [/\b(names?|email|e mail|who referred|referr(er|ing) (name|employee)|employee (id|number)|ids?|list|provide|identify|enter|how did you|source|hear about)\b/]],
    ['sponsorship', [/\bsponsor\w*\b/, /\bvisa (status|support|sponsorship)\b/, /\bh ?1 ?b\b/, /\bimmigration (support|sponsorship|petition|case)\b/],
      // "authorized to work WITHOUT sponsorship" mixes two answers: leave it.
      [/\bwithout\b.*\bsponsor/, /\b(relatives?|family)\b/]],
    ['workAuth', [/\b(legally )?(authori[sz]ed|eligible|permitted|entitled)\b.*\bwork\b/, /\bwork authori[sz]ation\b/, /\bright to work\b/, /\bwork permit\b/],
      [/\bsponsor/, /\bvisa\b/]],
    // U.S. citizenship / export-control "U.S. person" status. After workAuth and
    // sponsorship ("U.S. citizen or otherwise authorized to work" is a work
    // authorization question). Not: country / dual citizenship, nationality,
    // embargoed countries, proof / documents, relatives' citizenship, "non-U.S.
    // person" / foreign-national wordings, or citizenship mixed with holding a
    // clearance (two answers in one).
    ['citizenship', [
      /\b(u s|us|united states|american) (citizen\w*|national|person)s?\b/,
      /\bcitizen\w* of the (u s|us|united states)\b/,
      /\bcitizenship status\b/,
      /\b(itar|ear|export control\w*|export administration|22 cfr|15 cfr)\b.*\b(person|citizen\w*|resident|status)\b/,
      // A bare export-control notice as a dropdown's label (a Greenhouse board): answered
      // only from a list of statuses (scope 'status' below), never a Yes/No.
      /\bexport control(s|led)?\b/,
      /\b(citizen\w*|national) (or )?(an? )?(lawful |legal )?permanent resident\b.*\b(refugee|asylee|asylum)\b/,
    ], [
      /\b(other than|dual|second|multiple|countr(y|ies)|nationalit\w*|embargo\w*|sanction\w*|cuba|iran|north korea|syria|crimea|list|explain|describe|provide|proof|document\w*|evidence|passport|born|birth|parents?|spouse|family|relatives?)\b/,
      /\bnon ?(u s|us|united states) (citizen|person|national)s?\b|\bforeign (national|person|citizen)s?\b/,
      /\b(hold|possess|have|active|current|obtain|maintain|eligib\w*|granted|interim)\b[^?]{0,40}\bclearance\b/,
    ]],
    ['race', [/\brace\b/, /\bracial\b/, /\bethnicit\w*\b/, /\bethnic (background|origin|group)\b/],
      [/\bhispanic\b.*\?$/]],
    ['hispanic', [/\bhispanic\b/, /\blatin[oax]\b/], []],
    ['gender', [/^(gender|sex)\b/, /\b(your|of) (gender|sex)\b/, /\bgender( identity)?\b/],
      [/\btransgender\b/, /\bpronouns?\b/, /\bsexual orientation\b/, /\bpreferred\b/]],
    ['veteran', [/\bveteran\b/, /\bmilitary (status|service)\b/, /\bprotected veteran\b/], []],
    ['disability', [/\bdisabilit\w*\b/, /\bdisabled\b/, /\bcc ?305\b/], [/\bveteran\b/, /\baccommodat\w*\b/]],
    // Needs BOTH a privacy/data noun and an acknowledgment verb (fourth entry),
    // and never a marketing / alerts / talent-community opt-in.
    ['privacyAck', [/\b(privacy|personal (data|information)|data (transfer|processing|protection|privacy)|gdpr|transfer\w* (of )?(my |your )?(personal )?(data|information))\b/],
      // Never a bundled agreement: terms, background checks, attestations of truth,
      // authorizations ride along with "privacy" in one box, and those are the owner's.
      [/\bemail\b/, /\bphone\b/, /\bsignature\b/,
        /\b(terms|conditions|background|certif\w*|authori[sz]\w*|true|truthful|accurate|correct|complete|verif\w*|drug|credit|references?|criminal|e ?sign\w*)\b/],
      [/\b(acknowledg\w*|consent\w*|confirm\w*|agree\w*|accept\w*|i have read|i understand|understood)\b/]],
    // Not when the consideration is done by AI / machine learning tools
    // (a Workday tenant): that is a consent question, the owner answers it.
    ['otherPositions', [/\bconsider\w* (you |me )?for (other|additional|future|similar|alternative|another)\b/, /\b(other|additional|future|similar|alternative) (positions?|roles?|opportunit\w*|openings?|jobs?|requisitions?)\b/],
      [/\bhow did you\b/, /\b(refer|referred|referral|recommend\w*)\b/, /\b(machine learning|artificial intelligence|ai|automated)\b/,
        // Not the owner's other applications / offers / interviews ("Have you applied for
        // other positions with us?", "Are you interviewing for other roles?").
        /\b(applied|apply\w*|interview\w*|offers?|pending)\b/]],
    // Employment questions need "employed by" / "work(ed) for|at": "worked WITH
    // customers" or "worked with Python" is not this question.
    ['clientEmployed', [/\b(employed by|employee of|work(ing)? for|worked for|contract(ing|or)? for) (a |an |one of )?(our |its |the |any )?(clients?|customers?)\b/],
      [/\b(relatives?|family)\b/, /\b(describe|list|explain|how)\b/]],
    ['previouslyEmployed', [
      /\b(previously|formerly|ever|past|prior|before)\b.*\b(worked|been employed|employed|interned) (for|at|by)\b/,
      /\b(worked|been employed|employed|interned) (for|at|by)\b.*\b(before|previously|in the past)\b/,
      /\b(former|previous|past|prior) (employee|intern|contractor)\b/,
      // "Have you ever worked with {company} as a full-time / part-time employee, intern, vendor...?"
      /\b(ever|previously|before)\b.*\bworked with\b.*\b(employee|intern|vendor|contractor)\b/,
    ], [/\b(relatives?|family|spouse|friends?|know anyone|referr\w*)\b/, /\b(client|customer)\b/, /\bwhere\b/, NOT_THIS_EMPLOYER,
      /\b(describe|list|explain|how)\b/, /\bworked (with|in|on|as)\b(?!.*\b(employee|intern|vendor|contractor)\b)/,
      /\bworked with (a |an |any |our |their )?\w* ?employees?\b/]],
    // The same question with the company named (core/company.js put {company}
    // in): "Have you worked for {company}?", "Are you a current or former
    // {company} employee?", "Have you been employed by {company} or its subsidiaries?"
    ['previouslyEmployed', [
      /\b(worked|been employed|employed|interned|been an? (employee|intern|contractor)) (for|at|by|with) \{company\}/,
      /\b(current|former|previous|past|prior|ex) (or (former|previous|past|current) )?\{company\} (employee|intern|contractor|worker)s?\b/,
      /\{company\} (employee|intern|contractor)s? (now|currently|previously|before|in the past)\b/,
      // "Have you, or do you currently work for, or with {company}?", "Have you ever
      // performed temporary work for {company} or any of its subsidiaries?"
      /\b(have you|ever|previously|currently|do you)\b.*\b(work|worked|working|employed)( (for|at|by|with))+( or (for|at|by|with))* \{company\}/,
    ], [/\b(relatives?|family|spouse|friends?|know anyone|referr\w*)\b/, /\b(client|customer)\b/, /\bwhere\b/, NOT_THIS_EMPLOYER,
      /\b(describe|list|explain|how|why|what)\b/]],
  ];

  /* ------------------------------------------------------------------ */
  /* U.S. citizenship / "U.S. person"                                     */
  /* ------------------------------------------------------------------ */

  // Which statuses a citizenship question asks about. A "Yes" is right only
  // when the owner's stored status is among them: a permanent resident is a
  // U.S. person (ITAR 22 CFR 120.62) but not a U.S. citizen.
  const CIT_ALL = ['citizen', 'lpr', 'asylee'];
  const CIT_PERSON = /\b(u s|us|united states) persons?\b/;
  const CIT_EXPORT = /\b(itar|ear|export control\w*|export administration|22 cfr|15 cfr)\b/;
  const CIT_CITIZEN = /\bcitizen(s|ship)?\b|\b(u s|us|united states) nationals?\b/;
  const CIT_LPR = /\b(lawful |legal )?permanent residen\w*|\bgreen card\b/;
  const CIT_ASYLEE = /\b(refugee|asylee|asylum|protected individual)s?\b/;

  /** ['citizen', 'lpr', ...] the label asks about, or 'status' (a list of statuses to pick from). */
  function citizenshipScope(label) {
    if (CIT_PERSON.test(label)) return CIT_ALL.slice();
    // An export-control notice that asks nothing itself: pick a named status or nothing.
    if (CIT_EXPORT.test(label) && !/\b(citizen\w*|resident|nationals?|refugee|asylee|persons?)\b/.test(label)) return 'status';
    if (CIT_EXPORT.test(label)) return CIT_ALL.slice();
    if (/\bcitizenship status\b/.test(label)) return 'status';
    const set = [];
    if (CIT_CITIZEN.test(label)) set.push('citizen');
    if (CIT_LPR.test(label)) set.push('lpr');
    if (CIT_ASYLEE.test(label)) set.push('asylee');
    return set.length ? set : 'status';
  }

  // Statuses an OPTION claims, minus the ones it negates ("No, I am not a U.S.
  // citizen, but I am a permanent resident" -> lpr).
  function statusesIn(t) {
    const out = [];
    const neg = (re) => new RegExp('\\bnot (a |an )?(u s |us |united states )?(' + re + ')').test(t);
    if (/\bcitizen\w*\b|\b(u s|us|united states) nationals?\b/.test(t) && !neg('citizen|national') && !/\bnon ?(u s |us )?citizen/.test(t)) out.push('citizen');
    if (CIT_LPR.test(t) && !neg('(lawful |legal )?permanent resident|green card')) out.push('lpr');
    if (CIT_ASYLEE.test(t) && !neg('refugee|asylee|protected')) out.push('asylee');
    return out;
  }
  const CIT_NONE = /^(no|none|neither|not applicable|n a|other)\b|\bnone of (these|the above)\b|\b(foreign national|non ?(u s |us )?(citizen|person|resident))\b/;

  /**
   * The option for a stored status, as { index, confidence } or null.
   * 1. an option that names the stored status (or, for 'none', a none-type
   *    option naming no status): exactly one;
   * 2. a yes/no list, when the label's scope is known: Yes when the status is
   *    in scope, else No. A Yes that names statuses must name ours ("Yes, I am
   *    a U.S. citizen" is not a permanent resident's Yes).
   */
  function matchCitizenship(options, status, scope) {
    const rows = [];
    options.forEach((opt, index) => {
      const raw = opt.text || opt.value;
      if (opt.disabled || !raw || matcher.isPlaceholderText(raw)) return;
      const t = optionText(raw, 'citizenship');
      rows.push({ index, t, named: statusesIn(t) });
    });
    const named = status === 'none'
      ? rows.filter((r) => !r.named.length && CIT_NONE.test(r.t))
      : rows.filter((r) => r.named.includes(status));
    if (named.length === 1) return { index: named[0].index, confidence: 1 };
    if (named.length > 1) {
      const only = named.filter((r) => r.named.length === 1);
      return only.length === 1 ? { index: only[0].index, confidence: 1 } : null;
    }
    if (!Array.isArray(scope)) return null;
    const want = scope.includes(status) ? 'yes' : 'no';
    const hits = rows.filter((r) => {
      const id = classify('citizenship', r.t);
      if (id !== want) return false;
      return want === 'no' || !r.named.length || r.named.includes(status);
    });
    return hits.length === 1 ? { index: hits[0].index, confidence: 1 } : null;
  }

  // Another country named, the U.S. not: "authorized to work in Canada" is not our answer.
  const FOREIGN = /\b(canada|canadian|mexico|uk|united kingdom|great britain|britain|england|scotland|ireland|eu|eea|european union|europe|germany|france|spain|italy|netherlands|belgium|switzerland|sweden|norway|denmark|finland|poland|portugal|austria|czech\w*|israel|india|china|japan|korea|singapore|hong kong|taiwan|philippines|vietnam|indonesia|malaysia|thailand|australia|new zealand|brazil|argentina|chile|colombia|uae|united arab emirates|saudi arabia|south africa|nigeria|kenya|egypt|turkey)\b/;
  const US = /\b(u s a?|usa|united states|america|american)\b|(?<!\b(tell|let|join|with|contact|for|to|give|send|show|help|inform) )\bus\b/;

  // Marketing / alerts / talent-community opt-ins are never a standard question
  // (they often mention the privacy policy or "future opportunities").
  const OPT_IN = /\b(marketing|newsletters?|alerts?|text messages?|sms|talent (community|network|pool)|promotion\w*|subscribe|updates about|future communications?|receive (emails?|messages|communications))\b/;

  // Section headings that put a generic label ("Please check one of the boxes")
  // into one EEO question. Used for choice fields only.
  const CONTEXT_DETECT = [
    ['disability', /\bdisabilit\w*\b/],
    ['veteran', /\bveteran\b/],
    ['race', /\b(race|racial|ethnicity)\b/],
    ['gender', /^gender\b/],
  ];

  const CHOICE_TYPES = new Set(['select', 'radio', 'checkbox', 'checkboxes']);

  // A bare notice title as the label of a dropdown or radio group ("Point of
  // Data Transfer" on Greenhouse, with the GDPR text below it): the privacy
  // acknowledgment, but only on a select / radio group, where the
  // acknowledgment verb then has to come from the option text (classify).
  // Never a checkbox: a box labelled with just the title would be ticked.
  const NOTICE_TITLE = /^(point of )?(personal )?data (transfer|privacy|processing|protection)( notice| acknowledge?ment| policy| statement)?$/;

  function byId(id) {
    return QUESTIONS.find((q) => q.id === id) || null;
  }

  /**
   * { id, confidence, source } or null.
   * desc as built by the adapters (label, context, inputType).
   */
  function detect(desc) {
    // Emergency contact / references sections: none of these are about the owner.
    if (matcher.isVetoed(desc, 'context')) return null;
    const label = matcher.normalize(desc.label);
    if (OPT_IN.test(label)) return null;
    if (label) {
      const foreign = FOREIGN.test(label) && !US.test(label);
      for (const [id, pats, excl, all] of DETECT) {
        if (all && !all.every((re) => re.test(label))) continue;
        if (pats.some((re) => re.test(label)) && !excl.some((re) => re.test(label))) {
          // The stored work authorization / sponsorship answers are about the U.S.
          if (foreign && (id === 'workAuth' || id === 'sponsorship')) return null;
          if (id === 'citizenship') return { id, confidence: 1, source: 'label', scope: citizenshipScope(label) };
          return { id, confidence: 1, source: 'label' };
        }
      }
    }
    if ((desc.inputType === 'select' || desc.inputType === 'radio') && NOTICE_TITLE.test(label)) {
      return { id: 'privacyAck', confidence: 1, source: 'notice title' };
    }
    if (!CHOICE_TYPES.has(desc.inputType)) return null;
    // A generic label ("Please check one of the boxes below") gets its meaning
    // from the section. A specific label that matched nothing above does not.
    if (label && !/\b(check|select|choose|one|below|following|boxes?|options?|status|answer)\b/.test(label)) return null;
    const ctx = matcher.normalize(desc.context);
    for (const [id, re] of CONTEXT_DETECT) if (re.test(ctx)) return { id, confidence: 0.95, source: 'context' };
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Which answer does an option mean?                                    */
  /* ------------------------------------------------------------------ */

  const NEG = /\b(not|no|don ?t|do not|won ?t|will not|never|neither|none)\b/;
  const DECLINE_RE = /\b(decline\w*|don ?t wish|do not wish|not wish|prefer not|choose not|chose not|rather not|not to (answer|disclose|self identify|identify|say|provide|respond)|wish not|not disclose|not declaring|not specified|undisclosed|i don ?t want to answer|do not want to answer|opt ?out)\b/;

  const yes = (t) => /^(yes|y|true)\b/.test(t) || (/^i (am|do|will|have|would|require|need|consent|agree|acknowledge|confirm)\b/.test(t) && !NEG.test(t));
  const no = (t) => /^(no|n|false)\b/.test(t) || (NEG.test(t) && !/^yes\b/.test(t));
  const YES_NO = { yes, no };

  // qid -> { answerId: (normalizedOptionText) -> bool }. 'decline' is shared.
  const RECOGNIZE = {
    workAuth: YES_NO,
    sponsorship: YES_NO,
    citizenship: YES_NO, // plus statuses, see matchCitizenship
    otherPositions: YES_NO,
    previouslyEmployed: YES_NO,
    clientEmployed: YES_NO,
    relatives: YES_NO,
    referred: YES_NO,
    hispanic: {
      yes: (t) => yes(t) || (/^(hispanic|latin[oax])\b/.test(t) && !NEG.test(t)),
      no: (t) => no(t) || /^non ?(hispanic|latin[oax])\b/.test(t),
    },
    gender: {
      male: (t) => /^(male|man|cis ?(gender )?(male|man))$/.test(t) || /^(male|man) /.test(t) && !/\b(trans|non)\b/.test(t),
      female: (t) => /^(female|woman|cis ?(gender )?(female|woman))$/.test(t) || /^(female|woman) /.test(t) && !/\b(trans|non)\b/.test(t),
      nonbinary: (t) => /\b(non ?binary|nonbinary|genderqueer|gender non ?conforming|gender fluid)\b/.test(t),
    },
    race: {
      white: (t) => /^white\b/.test(t),
      black: (t) => /^(black|african american)\b/.test(t),
      asian: (t) => /^asian\b/.test(t),
      hispanic: (t) => /^(hispanic|latin[oax])\b/.test(t),
      native: (t) => /\bamerican indian\b|\balaska(n)? native\b|^indigenous\b/.test(t),
      pacific: (t) => /\bhawaiian\b|\bpacific islander\b/.test(t),
      two: (t) => /\b(two or more|multi ?racial|multiple races|mixed race)\b/.test(t),
    },
    veteran: {
      not: (t) => /^non ?veteran\b/.test(t) || /\bnot a (protected )?veteran\b|\bnot a protected\b|\bam not (a )?(protected )?veteran\b/.test(t) || (/^no\b/.test(t) && !/\bveteran\b.*\bbut\b/.test(t)),
      protected: (t) => !NEG.test(t) && (/\bidentify as (one or more|a protected)\b|\bi am a (protected )?veteran\b|\bprotected veteran\b/.test(t) || /^yes\b/.test(t)),
    },
    disability: {
      yes: (t) => !NEG.test(t.replace(/\bor previously had\b.*/, '')) && (/^yes\b/.test(t) || /\bi have (a )?disabilit/.test(t)),
      no: (t) => /^no\b/.test(t) || /\b(do not|don ?t) have (a )?disabilit/.test(t),
    },
    privacyAck: {
      acknowledge: (t) => !NEG.test(t) && /\b(acknowledg\w*|confirm\w*|agree\w*|accept\w*|consent\w*|yes|i have read|i understand|understood|ok)\b/.test(t),
    },
  };

  // Race lists: "White (Not Hispanic or Latino) (United States of America)" is
  // White. Drop the Hispanic qualifier and the country tag before reading.
  function optionText(text, qid) {
    let t = matcher.normalize(text).replace(/\b(united states of america|usa)\b/g, ' ');
    if (qid === 'race') t = t.replace(/\bnot (of )?hispanic or latin[oax]\b/g, ' ').replace(/\bnon hispanic\b/g, ' ');
    return t.replace(/\s+/g, ' ').trim();
  }

  /** Answer id an option text means for question qid, or null. */
  function classify(qid, text) {
    const t = optionText(text, qid);
    if (!t || matcher.isPlaceholderText(text)) return null;
    // "I am a protected veteran but I choose not to self-identify..." is not a decline.
    if (DECLINE_RE.test(t) && !/\bi am a protected veteran\b/.test(t)) return 'decline';
    // "Not sure" / "Unsure" / "Maybe" is no answer at all: it must not count as a
    // second "No" (which made a real "No" ambiguous and the field yellow).
    if (/^(not sure|unsure|maybe|undecided|i don ?t know|don ?t know|do not know|i do not know|n a|not applicable)\b/.test(t)) return null;
    const rec = RECOGNIZE[qid] || {};
    const hits = Object.keys(rec).filter((id) => rec[id](t));
    return hits.length === 1 ? hits[0] : null;
  }

  // workAuth "citizen" / "visa" are both a Yes; these tell the two Yes options apart.
  const CITIZEN_RE = /\b(citizen\w*|permanent resident|green card|lawful permanent)\b/;
  const VISA_RE = /\b(visas?|h ?1 ?b|opt|cpt|ead|work permit|non ?immigrant|f ?1|tn|sponsor\w*)\b/;
  const YES_KINDS = {
    citizen: (t) => CITIZEN_RE.test(t) && !VISA_RE.test(t),
    visa: (t) => VISA_RE.test(t) && !CITIZEN_RE.test(t),
  };

  /** The yes/no answer an answer id stands for (workAuth citizen/visa -> yes). */
  function baseAnswer(qid, answerId) {
    return qid === 'workAuth' && YES_KINDS[answerId] ? 'yes' : answerId;
  }

  /**
   * The one option meaning answerId, as { index, confidence } or null.
   * options = [{ text, value, disabled }]. The VALUE is ignored unless the
   * text is empty: option values are often codes ("1", "Y") that mean nothing.
   */
  function matchOption(options, qid, answerId) {
    if (!answerId) return null;
    if (qid === 'citizenship') {
      // fillValue hands "<status>@<scope>" ("lpr@citizen,lpr,asylee", "none@status").
      const [status, scope] = String(answerId).split('@');
      return matchCitizenship(options, status, !scope || scope === 'status' ? 'status' : scope.split(','));
    }
    if (qid === 'workAuth' && YES_KINDS[answerId]) {
      // Exactly one Yes: that is it. Several: the one that names this kind.
      const yesIdx = [];
      options.forEach((opt, index) => {
        if (!opt.disabled && classify(qid, opt.text || opt.value) === 'yes') yesIdx.push(index);
      });
      if (yesIdx.length === 1) return { index: yesIdx[0], confidence: 1 };
      const kind = yesIdx.filter((i) => YES_KINDS[answerId](optionText(options[i].text || options[i].value, qid)));
      return kind.length === 1 ? { index: kind[0], confidence: 1 } : null;
    }
    const hits = [];
    options.forEach((opt, index) => {
      if (opt.disabled) return;
      const id = classify(qid, opt.text || opt.value);
      if (id === answerId) hits.push(index);
    });
    // Same meaning offered twice (two "No" variants): we cannot tell which.
    if (hits.length === 1) return { index: hits[0], confidence: 1 };
    // "Ethnicity" sometimes means Hispanic / Non-Hispanic only (Avature):
    // when every option reads as a Hispanic yes/no, answer with that question.
    if (qid === 'race' && !hits.length && answers.hispanic) {
      const real = options.filter((o) => !o.disabled && !matcher.isPlaceholderText(o.text || o.value));
      if (real.length >= 2 && real.every((o) => classify('hispanic', o.text || o.value))) {
        return matchOption(options, 'hispanic', answers.hispanic);
      }
    }
    return null;
  }

  // The stored answers of the current pass (core/autofill.js sets them), for
  // the race -> Hispanic fallback above.
  let answers = {};
  function setAnswers(a) {
    answers = { ...(a || {}) };
  }

  /**
   * Value to hand the filler for a standard question, by control type.
   *   select / radio / checkbox list /  the answer id (matched via classify)
   *   custom dropdown
   *   single checkbox                   'Yes' when its own label means the answer
   *                                     ("I acknowledge...", "I have a disability")
   *   text input                        'Yes'/'No', only for yes/no questions whose
   *                                     label reads as one ("Are you...?")
   *   textarea, anything else           never
   * '' means: do not fill.
   */
  function fillValue(qid, answerId, desc, checkboxLabel, detected) {
    if (!answerId) return '';
    if (qid === 'citizenship') return citizenshipValue(answerId, desc, detected);
    const base = baseAnswer(qid, answerId);
    if (desc.inputType === 'checkbox') {
      const text = checkboxLabel || desc.label;
      const means = classify(qid, text);
      if (means) return means === base ? 'Yes' : '';
      // The question itself is the box ("I acknowledge the privacy notice").
      return qid === 'privacyAck' && answerId === 'acknowledge' ? 'Yes' : '';
    }
    if (desc.inputType === 'select' || desc.inputType === 'radio' || desc.inputType === 'checkboxes') return answerId;
    const textLike = ['text', 'search', ''].includes(desc.inputType || '');
    if (textLike && RECOGNIZE[qid] === YES_NO && (base === 'yes' || base === 'no') && matcher.isYesNoQuestion(desc.label)) {
      return base === 'yes' ? 'Yes' : 'No';
    }
    return '';
  }

  // Citizenship: a status list or yes/no list gets "<status>@<scope>" for
  // matchOption; a yes/no text box gets Yes / No when the scope is known; a
  // checkbox is never ticked (an attestation of status is the owner's to make).
  function citizenshipValue(status, desc, detected) {
    const scope = (detected && detected.scope) || citizenshipScope(matcher.normalize(desc.label));
    if (['select', 'radio', 'checkboxes'].includes(desc.inputType)) return `${status}@${Array.isArray(scope) ? scope.join(',') : 'status'}`;
    const textLike = ['text', 'search', ''].includes(desc.inputType || '');
    if (textLike && Array.isArray(scope) && matcher.isYesNoQuestion(desc.label)) return scope.includes(status) ? 'Yes' : 'No';
    return '';
  }

  AF.standard = { QUESTIONS, byId, detect, classify, matchOption, fillValue, setAnswers, citizenshipScope };

  if (typeof module === 'object' && module.exports) module.exports = AF.standard;
})(typeof globalThis !== 'undefined' ? globalThis : this);
