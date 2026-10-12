/*
 * core/embed.js
 *
 * Application forms inside cross-origin iframes (a company careers page that
 * wraps a Greenhouse board in iframe#grnhse_iframe: CareerPuck, many company sites).
 * Runs in the top frame on Alt+Z only, and looks only at the <iframe>
 * elements themselves (we cannot see inside a cross-origin frame).
 *
 * Each visible frame is classified:
 *   'fill'  its host is one of FILL_HOSTS, the only hosts the extension has
 *           host permissions for: background.js injects the normal scripts
 *           into that frame and it is filled like a page of its own;
 *   'open'  another cross-origin frame with positive evidence of an
 *           application form (a known ATS host, or apply / job / career words
 *           in its URL, id, name or title): background.js opens its URL in a
 *           new tab next to this one (no extra permission needed);
 *   null    everything else: ads, analytics, video, maps, chat widgets,
 *           captchas, social embeds, tiny or hidden frames, same-origin
 *           frames, non-http(s) URLs. Never opened, never touched.
 *
 * survey(doc) -> [{ url, host, kind, frameId }]
 *   frameId comes from browser.runtime.getFrameId(iframe) (content scripts,
 *   Firefox 96+); null when that API is missing (tests, a plain page).
 *
 * Pure apart from survey(); Node tests require() it directly.
 */
(function (root) {
  'use strict';

  const AF = (root.AF = root.AF || {});

  // Exactly the manifest's host_permissions. Keep the two in sync.
  const FILL_HOSTS = ['job-boards.greenhouse.io', 'boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com'];

  // ATS hosts: a frame from one of these is an application (or a job board).
  const ATS_HOST = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|myworkday\.com|myworkdaysite\.com|icims\.com|smartrecruiters\.com|eightfold\.ai|avature\.net|jobvite\.com|taleo\.net|successfactors\.(com|eu)|workable\.com|bamboohr\.com|breezy\.hr|recruitee\.com|applytojob\.com|jazzhr\.com|ultipro\.com|ukg\.net|paylocity\.com|paycomonline\.net|oraclecloud\.com|teamtailor\.com|pinpointhq\.com|rippling\.com|ats\.rippling\.com|dover\.com|gem\.com|comeet\.(com|co)|personio\.(de|com)|jobs\.personio\.de|freshteam\.com|zohorecruit\.com|recruiterbox\.com|hire\.withgoogle\.com|phenompeople\.com)$/;

  // Never an application form, whatever the URL says.
  const DENY_HOST = /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|googletagmanager\.com|google-analytics\.com|adservice\.google\.com|amazon-adsystem\.com|adnxs\.com|criteo\.(com|net)|taboola\.com|outbrain\.com|facebook\.com|facebook\.net|fbcdn\.net|instagram\.com|twitter\.com|x\.com|platform\.twitter\.com|linkedin\.com|tiktok\.com|youtube\.com|youtube-nocookie\.com|ytimg\.com|vimeo\.com|player\.vimeo\.com|wistia\.(com|net)|vidyard\.com|brightcove\.(com|net)|jwplayer\.com|loom\.com|spotify\.com|soundcloud\.com|recaptcha\.net|hcaptcha\.com|challenges\.cloudflare\.com|maps\.google\.com|intercom\.io|intercomcdn\.com|drift\.com|driftt\.com|zendesk\.com|zdassets\.com|zopim\.com|livechatinc\.com|tawk\.to|olark\.com|crisp\.chat|hubspot\.com|hs-scripts\.com|hsforms\.(com|net)|usemessenger\.com|qualified\.com|onetrust\.com|cookielaw\.org|cookiebot\.com|trustarc\.com|stripe\.com|paypal\.com|hotjar\.com|clarity\.ms|newrelic\.com|sentry\.io|disqus\.com|typekit\.net|gstatic\.com|googleapis\.com|addthis\.com|sharethis\.com|calendly\.com|glassdoor\.com|indeed\.com|builtin\.com)$/;
  // Google paths that are not apps (maps, ads) on www.google.com.
  const DENY_PATH = /^\/(maps|recaptcha|ads|pagead|search)\b/;

  // Words that make an unknown frame an application form.
  const FORM_WORDS = /(^|[^a-z])(apply|application|applications|applicant|candidate|careers?|jobs?|job_app|recruit\w*|requisition|talent|hiring|vacanc\w*)([^a-z]|$)/i;

  // ... unless the frame says it is something else (an unknown chat widget titled
  // "Chat with our recruiting team", a "careers video" player).
  const NOT_FORM_WORDS = /(^|[^a-z])(chat|messenger|livechat|video|player|maps?|calendar|schedul\w*|cookies?|consent|captcha|ads?|advert\w*|banner|tracking|pixel|analytics|share|social|feed|reviews?)([^a-z]|$)/i;

  const MIN_WIDTH = 250;
  const MIN_HEIGHT = 150;

  function parse(src, base) {
    try {
      return new root.URL(src, base);
    } catch (e) {
      return null;
    }
  }

  /**
   * frame = { src, base, topOrigin, id, name, title, width, height, visible }
   * -> 'fill' | 'open' | null
   */
  function classify(frame) {
    const url = parse(frame.src || '', frame.base);
    if (!url || !/^https?:$/.test(url.protocol)) return null;
    if (frame.topOrigin && url.origin === frame.topOrigin) return null;
    if (!frame.visible || frame.width < MIN_WIDTH || frame.height < MIN_HEIGHT) return null;
    const host = url.hostname.toLowerCase();
    if (DENY_HOST.test(host)) return null;
    if (/(^|\.)google\.[a-z.]+$/.test(host) && DENY_PATH.test(url.pathname)) return null;
    if (FILL_HOSTS.includes(host)) return 'fill';
    if (ATS_HOST.test(host) || frame.id === 'grnhse_iframe') return 'open';
    const evidence = [url.pathname, url.search, frame.id, frame.name, frame.title].join(' ');
    return FORM_WORDS.test(evidence) && !NOT_FORM_WORDS.test(evidence) ? 'open' : null;
  }

  function frameIdOf(el) {
    try {
      const rt = root.browser && root.browser.runtime;
      if (rt && typeof rt.getFrameId === 'function') {
        const id = rt.getFrameId(el);
        return typeof id === 'number' && id > 0 ? id : null;
      }
    } catch (e) {
      /* not a content script, or a frame that is gone */
    }
    return null;
  }

  /** Every visible iframe that holds (or wraps) an application form, biggest first. */
  function survey(doc) {
    const out = [];
    const topOrigin = doc.location && /^https?:$/.test(doc.location.protocol) ? doc.location.origin : '';
    for (const f of doc.querySelectorAll('iframe[src]')) {
      const rect = f.getBoundingClientRect();
      const style = doc.defaultView.getComputedStyle(f);
      const frame = {
        src: f.getAttribute('src'),
        base: doc.baseURI,
        topOrigin,
        id: f.id || '',
        name: f.getAttribute('name') || '',
        title: f.getAttribute('title') || '',
        // A frame sized by the page script may still report its attribute size first.
        width: Math.max(rect.width, Number(f.getAttribute('width')) || 0),
        height: Math.max(rect.height, Number(f.getAttribute('height')) || 0),
        visible: f.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0,
      };
      const kind = classify(frame);
      if (!kind) continue;
      const url = parse(frame.src, frame.base);
      if (out.some((x) => x.url === url.href)) continue;
      out.push({ url: url.href, host: url.hostname.toLowerCase(), kind, frameId: kind === 'fill' ? frameIdOf(f) : null, area: frame.width * frame.height });
    }
    return out.sort((a, b) => b.area - a.area).map(({ area, ...rest }) => rest);
  }

  /** Origin pattern for permissions.contains / request ("https://jobs.lever.co/*"). */
  function originPattern(url) {
    const u = parse(url);
    return u ? `${u.protocol}//${u.hostname}/*` : '';
  }

  AF.embed = { FILL_HOSTS, classify, survey, originPattern };

  if (typeof module === 'object' && module.exports) module.exports = AF.embed;
})(typeof globalThis !== 'undefined' ? globalThis : this);
