import type { Rule } from './types.js';

/**
 * Built-in entity rules: people, places and organisations (customers, companies, vendors).
 *
 * Deterministic text patterns, no model and no name list, so they work for anyone's data. They are
 * HEURISTICS: they look at how a capitalised name is used ("Brendan at Banyan called", "in Twin Falls",
 * "Giltner Trucking"), not at who the name really is. Anything they get wrong is fixed by teaching:
 *   add_rule "Banyan is a customer"   |   "Jerome is a place"   |   or move_memory (learns a word).
 * Taught rules are custom/learned rules and always outrank these.
 *
 * They sit BELOW every business/project, personal, finance, code and general-business rule (so nothing that
 * files today moves), except the organisation-name rule, which sits just above the day-job rule so that
 * "Giltner trucking" is a company and not "hauling talk".
 */
/** Case-insensitive literal word for patterns that must stay case-SENSITIVE elsewhere (names): "call" -> "[cC][aA][lL][lL]". */
const ci = (w: string) => w.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
const ciAlt = (words: string[]) => `(?:${words.map(ci).join('|')})`;
const CAP = String.raw`[A-Z][a-z]{2,}(?:['’-][A-Za-z]+)?`;
/** Capitalised words that start sentences or are not names. */
const NOT_NAMES = String.raw`(?:The|This|That|These|Those|There|Here|It|He|She|We|They|You|Who|What|When|Where|Why|How|My|Our|Your|Their|His|Her|Its|Some|Any|No|Yes|Not|And|But|Or|So|If|Then|Okay|Hey|Sounds|Today|Tomorrow|Yesterday|Meeting|Call|Calls|Dinner|Lunch|Breakfast|Coffee|Stay|Staying|Stayed|Park|Parked|Work|Working|Worked|Live|Lives|Living|Meet|Meets|Stop|Stopped|Fuel|Fueled|Arrive|Arrived|Deliver|Delivered|Load|Loaded|Unload|Unloaded|Pickup|Drop|Dropped|Sold|Bought|Buy|Eat|Ate|Left|Leave|Going|Gone|Home|Back|Running|Built|Update|Updated|Stuck|Waiting|Wait|Check|Checked|Heading|Headed|Driving|Drive|Drove|Hauling|Hauled|Haul|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December)`;
const NAME = String.raw`(?!${NOT_NAMES}\b)${CAP}`;
const NAME2 = String.raw`${NAME}(?: ${CAP})?`;

const STATES = String.raw`(?:Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Wisconsin|Wyoming|AL|AK|AZ|AR|CA|CO|CT|DE|FL|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|WI|WY)`;
const ORG_SUFFIX = String.raw`(?:[Tt]rucking|[Tt]ransport(?:ation)?|[Ll]ogistics|[Ff]reight|[Hh]auling|[Cc]arriers?|[Ff]arms?|[Cc]reamery|[Cc]o-op|Inc\.?|LLC|L\.L\.C\.|Corp\.?|Corporation|Co\.|Company|Ltd\.?|Bank|Insurance|Holdings|Partners|Group|Supply|Services|Dairy)`;

const CUE_VERBS = String.raw`(?:${ciAlt(['call','called','calling','text','texted','texting','email','emailed','emailing','message','messaged','messaging','phone','phoned','met with','meeting with','spoke to','spoke with','talk to','talk with','talked to','talked with','talking to','talking with','pick up','picked up','picking up','ask','asked','remind','introduce','introduced'])})`;

/** The words an entity rule must not fire on (AI tools, code talk) are added by the preset as `noneWords`. */
export const ENTITY_RULES = (guard: string[]): Rule[] => [
  {
    id: 'content.org-named', layer: 'content', category: 'organizations', priority: 565, addTags: ['organization'],
    when: { patterns: [String.raw`\b(?!${NOT_NAMES}\b)${CAP}(?: ${CAP})* ${ORG_SUFFIX}\b`], noneWords: guard },
    description: 'A company name (a capitalised name followed by Trucking, Transport, Farms, Inc, LLC, Co-op, ...). Files above everyday day-job talk, below any business of yours that is named.',
  },
  {
    id: 'content.person-at-org', layer: 'content', category: 'people', priority: 176, addTags: ['person', 'organization'],
    when: { patterns: [String.raw`\b${NAME} ${ciAlt(['at','from','with'])} ${NAME}\b`], noneWords: guard },
    description: 'A person at a company ("Brendan at Banyan"): filed under the person, tagged with the company.',
  },
  {
    id: 'content.person-cue', layer: 'content', category: 'people', priority: 174, addTags: ['person'],
    when: {
      patterns: [
        String.raw`\b(?:Mr|Mrs|Ms|Miss|Dr)\.? ${NAME}\b`,
        String.raw`\b${CUE_VERBS} (?:${ciAlt(['with','to'])} )?${NAME2}\b`,
        String.raw`(?:^|[.!?]\s+)${NAME} ${ciAlt(['called','texted','emailed','messaged','phoned','said','asked','wants','wanted','is coming','arrived','stopped by','dropped by'])}\b`,
      ],
      noneWords: guard,
    },
    description: 'A person is mentioned (a capitalised name after call / text / meet / pick up, or "Mr/Dr Name", or a name that called or said something).',
  },
  {
    id: 'content.place-cue', layer: 'content', category: 'places', priority: 172, addTags: ['place'],
    when: {
      patterns: [
        String.raw`\b${CAP}(?: ${CAP})?,? ${STATES}\b`,
        String.raw`\b${ciAlt(['in','near','outside','around','to','from','into','toward','visiting','moved to','driving to','headed to'])} ${NAME2}\b(?!['’]s)`,
      ],
      noneWords: guard,
    },
    description: 'A place is named (a city and state, or a capitalised name after in / near / to / from).',
  },
  {
    id: 'content.place-words', layer: 'content', category: 'places', priority: 171, addTags: ['place'],
    when: { anyWords: ['airport', 'county', 'warehouse', 'truck stop', 'rest area', 'city hall', 'downtown'], noneWords: guard },
    description: 'A kind of place is named (airport, county, warehouse, truck stop, ...).',
  },
];

/** The shelves that exist only because of the entity rules. */
export const ENTITY_SHELVES = ['people', 'places', 'organizations'] as const;
/** Ids of the entity rules above, so a plan without entity shelves can drop exactly those and nothing else. */
export const ENTITY_RULE_IDS: ReadonlySet<string> = new Set(
  ENTITY_RULES([]).map((r) => r.id),
);

/**
 * The same rulebook without the people / places / organizations shelves and the rules that feed them.
 * Everything else (finance, projects, code, mailbox tags) is untouched, so a tenant without entity shelves files
 * exactly as preset D does, minus those three shelves.
 */
export function withoutEntityShelves<T extends { rules: Rule[]; categories: { slug: string }[] }>(book: T): T {
  return {
    ...book,
    rules: book.rules.filter((r) => !ENTITY_RULE_IDS.has(r.id)),
    categories: book.categories.filter((c) => !(ENTITY_SHELVES as readonly string[]).includes(c.slug)),
  };
}
