'use strict';

// The starting values for the Settings page. These were hardcoded across the
// agent before the page existed; they seed the database the first time it is
// used, and they are what the agent falls back to when no database is
// configured (local runs and tests), so behaviour without a database matches
// what the page starts with.

const glossaryMeanings = require('../config/meeting_minutes_glossary.json');

const DEFAULT_PEOPLE = Object.freeze([
  // Internal (the Trinzo side of a meeting).
  { name: 'Colm O’Rourke', side: 'internal', spellings: [] },
  { name: 'Jacqui Fox', side: 'internal', spellings: [] },
  { name: 'David Didsbury', side: 'internal', spellings: [] },
  { name: 'Conor Flynn', side: 'internal', spellings: [] },
  { name: 'Claire Nicholson', side: 'internal', spellings: [] },
  { name: 'Mark Kelleher', side: 'internal', spellings: [] },
  { name: 'John-Paul Hughes', side: 'internal', spellings: [] },
  { name: 'Jenny Gough', side: 'internal', spellings: [] },
  { name: 'Stuart Smith', side: 'internal', spellings: ['Smith, Stuart M', 'Smith Stuart M'] },
  { name: 'Orla Skally', side: 'internal', spellings: [] },
  {
    name: 'Advait Dharmadhikari',
    side: 'internal',
    spellings: [
      'Advaith Dharmadhikary', 'Adwait Dharmadikari', 'Adwaith Darmadhikari',
      'Advaitt Dharmadhikaari', 'Advayt Dharmadhikari', 'Adveit Dharmadhikari'
    ]
  },
  { name: 'Saki Arimoto', side: 'internal', spellings: ['Sakki Arimotto', 'Sakie Arrimoto', 'Saaki Arimotoh'] },
  // Previously only known to the older Python minutes path.
  { name: 'Ciara Griffin', side: 'internal', spellings: [] },
  { name: 'Jack Cunningham', side: 'internal', spellings: [] },
  // Client (the other side of a meeting).
  { name: 'Grace McGroogan', side: 'client', spellings: [] },
  { name: 'Rebecca Gill', side: 'client', spellings: ['Rebecca Cuckoo'] },
  { name: 'Patrick Stewart', side: 'client', spellings: [] },
  { name: 'Jonny Dobbin', side: 'client', spellings: [] },
  { name: 'Adil Kauim', side: 'client', spellings: [] },
  { name: 'Kevin Beattie', side: 'client', spellings: [] },
  { name: 'Andrew Kane', side: 'client', spellings: [] },
  { name: 'Christina Cargan', side: 'client', spellings: [] },
  { name: 'Ciaran Ryan', side: 'client', spellings: [] },
  { name: 'Claire Doherty', side: 'client', spellings: [] },
  { name: 'Luke Speers', side: 'client', spellings: [] },
  { name: 'Janine Thomas', side: 'client', spellings: [] },
  { name: 'Abby Lennon', side: 'client', spellings: [] }
].map((person) => Object.freeze({ ...person, spellings: Object.freeze([...person.spellings]) })));

// Spellings Teams gets wrong, corrected in the minutes. Merged with the glossary
// meanings below by term.
const DEFAULT_HEARD_AS = Object.freeze({
  EUDAMED: ['Udimed', 'Udemed'],
  MDSAP: ['Medsap', 'Meds app'],
  CAPA: ['Kappa'],
  SBOM: ['S-BOM'],
  DITA: ['Deta Inc', 'DD Inc', 'T Inc'],
  Cognidocs: ['call me docs', 'call me doc'],
  labelling: ['labeling'],
  labelled: ['labeled']
});

const DEFAULT_MEANINGS = Object.freeze({
  SBOM: 'Software Bill of Materials',
  DITA: 'Client organisation',
  Cognidocs: 'Document-control system',
  labelling: 'British spelling',
  labelled: 'British spelling'
});

const DEFAULT_TERMS = Object.freeze((() => {
  const byKey = new Map();
  const add = (term, meaning, heardAs = []) => {
    const k = term.toLowerCase();
    const current = byKey.get(k) || { term, meaning: '', heardAs: [] };
    if (meaning && !current.meaning) current.meaning = meaning;
    current.heardAs = [...new Set([...current.heardAs, ...heardAs])];
    byKey.set(k, current);
  };
  for (const [term, meaning] of Object.entries(glossaryMeanings)) {
    if (typeof term === 'string' && typeof meaning === 'string') add(term, meaning);
  }
  for (const [term, heardAs] of Object.entries(DEFAULT_HEARD_AS)) add(term, DEFAULT_MEANINGS[term] || '', heardAs);
  return [...byKey.values()].map((item) => Object.freeze({ ...item, heardAs: Object.freeze(item.heardAs) }));
})());

module.exports = { DEFAULT_PEOPLE, DEFAULT_TERMS };
