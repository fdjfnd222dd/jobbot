'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { cityFilter, cityMatch } = require('../lib/discover');

test('--city nyc matches the city, not upstate places in New York state (2026-10-09)', () => {
  const c = cityFilter('nyc');
  for (const loc of ['New York, NY', 'New York', 'NYC - 1211 Ave of the Americas', 'USA - New York NY', 'New York, New York, United States', 'Brooklyn, NY'])
    assert.ok(cityMatch(c, { location: loc, title: '' }), loc);
  for (const loc of ['Rochester, New York, United States', 'United States of America Rochester New York', 'Buffalo, New York'])
    assert.ok(!cityMatch(c, { location: loc, title: '' }), loc);
});

// 2026-10-12 search experiment: raw dump vs --city. RTP / Boston had no metro, DC missed APL (Laurel) and the far
// suburbs, and Colombia / Brno / Dublin IE passed as US.
test('--city raleigh / boston / dc / remote metros cover the suburbs', () => {
  const c = cityFilter('raleigh,boston,dc,nyc,remote');
  for (const loc of ['Cary, NC', 'Garner, NC', 'Apex, NC', 'Wake County, NC', 'Research Triangle Park, NC', 'Waltham, MA', 'Bedford, MA', 'Burlington-Massachusetts-United States of America', 'US, MA - Framingham', 'Laurel, MD', 'Annapolis Junction, MD', 'Leesburg, VA', 'Long Island City, Queens, NY', 'US - Remote', 'Remote in USA'])
    assert.ok(cityMatch(c, { location: loc, title: '' }), loc);
  for (const loc of ['USA - New York - Malta', 'Scary, OH', 'Burlington, VT', 'Lexington, KY'])
    assert.ok(!cityMatch(c, { location: loc, title: '' }), loc);
  assert.ok(cityMatch(cityFilter('rtp'), { location: 'Morrisville, NC', title: '' }));
});

test('non-US places are not US; US towns named after them still are', () => {
  const { isUsLocation, PLACES } = require('../lib/discover');
  for (const loc of ['Colombia, Remote', 'Brno', 'Dublin, IE', 'Tel Aviv', 'PRC, Shanghai', 'Bangalore']) assert.ok(!isUsLocation(loc), loc);
  for (const loc of ['Peru, IL', 'Dublin, OH', 'Remote in USA']) assert.ok(isUsLocation(loc), loc);
  const orca = PLACES.find(([n]) => n === 'OR/CA')[1];
  assert.ok(orca.test('Portland, OR') && orca.test('San Jose, CA') && !orca.test('Remote or hybrid'));
});
