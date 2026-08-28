/**
 * GuardAI — masker.js
 * ---------------------------------------------------------------------------
 * Reversible data masking ("encrypt before sending").
 *
 * The masker swaps real sensitive values for realistic, region-appropriate
 * (Australian) FAKE values before a message is sent to an AI, and swaps them
 * back when the AI responds.
 *
 * It is NOT cryptographic encryption — by design (per spec). Instead it keeps
 * a simple bidirectional lookup table:
 *
 *     real value  <-->  fake value
 *
 * The table is persisted to chrome.storage.local ONLY. It is never synced,
 * never sent anywhere. The same real value always maps to the same fake value
 * within the lifetime of the table, so conversations stay coherent.
 *
 * Exposed as window.GuardAI.Masker.
 * ---------------------------------------------------------------------------
 */
(function () {
  "use strict";

  const STORAGE_KEY = "guardai_mapping";
  // Hard cap on how many real<->fake pairs the table keeps. Without this, a
  // long-lived conversation (or many days of daily use, since the table
  // persists across reloads) grows the mapping forever: every restore pass
  // iterates the whole table (buildSwapRules, unmask's fakeToReal.keys()
  // sort), so unbounded growth means unbounded per-message latency, and
  // chrome.storage.local has a quota too. Oldest entries (by createdAt) are
  // evicted first — see _evictIfNeeded().
  const MAX_ENTRIES = 500;

  /* ------------------------------------------------------------------ *
   * Australian-flavoured fake-data pools.
   * ------------------------------------------------------------------ */
  /* Stand-in name pools, split by gender so a masked name keeps the gender of
   * the real one. A female name replaced by a male stand-in makes the AI's
   * reply subtly wrong ("name is Sophie Newman" -> "Got it, Oliver") and
   * corrupts anything drafted downstream.
   *
   * SIZED AGAINST THE MAPPING CAP, not chosen for variety. The table holds up
   * to MAX_ENTRIES (500) real<->fake pairs, and previewFake() guarantees
   * uniqueness by RE-GENERATING on collision, giving up after 100 tries and
   * returning a duplicate. The old pool was 16 first x 14 last = 224 combos —
   * already under-provisioned against a 500-entry table, and a naive gender
   * split would have halved it to 112 per gender. Past that point two
   * different people silently share one stand-in, which is the same
   * indistinguishable-fakes bug that made "[redacted-secret]" unusable.
   * Each pool below clears 1,500 combinations. */
  const FIRST_MALE = [
    "David", "Liam", "Noah", "Jack", "Lucas", "Ethan", "Oliver", "Henry",
    "Thomas", "Samuel", "Daniel", "Benjamin", "Alexander", "Nathan", "Patrick",
    "Marcus", "Julian", "Adrian", "Elliot", "Vincent", "Dominic", "Gregory",
    "Nicholas", "Simon", "Theodore", "Edward", "Malcolm", "Desmond", "Rupert",
    "Callum", "Declan", "Rohan", "Mateo", "Andre", "Bruno", "Emeka", "Hassan",
    "Kenji", "Viktor", "Stefan",
  ];
  const FIRST_FEMALE = [
    "Emma", "Olivia", "Ava", "Mia", "Chloe", "Grace", "Sophie", "Ruby",
    "Hannah", "Isla", "Freya", "Aisha", "Elena", "Nadia", "Priya", "Amara",
    "Rosa", "Lena", "Maya", "Zara", "Iris", "Nina", "Clara", "Alice",
    "Beatrice", "Camille", "Delia", "Esther", "Fiona", "Greta", "Helena",
    "Ingrid", "Juliet", "Katya", "Leila", "Miriam", "Naomi", "Paloma",
    "Rosalind", "Tamsin",
  ];
  /* Used whenever the real name's gender is unknown, contradictory across
   * origins, or genuinely unisex. A neutral stand-in cannot be WRONG, only
   * uninformative — which is the whole point: the gazetteer tags
   * conservatively, so this pool absorbs every case I was not sure about. */
  const FIRST_UNISEX = [
    "Alex", "Sam", "Jordan", "Riley", "Casey", "Jamie", "Taylor", "Morgan",
    "Avery", "Quinn", "Charlie", "Frankie", "Robin", "Rowan", "Sasha",
    "Cameron", "Devon", "Emerson", "Harper", "Kai", "Logan", "Marley",
    "Parker", "Reese", "Skyler", "Toni", "Val", "Wren", "Ari", "Blake",
    "Dakota", "Ellis", "Finley", "Hayden", "Indigo", "Jules", "Kerry",
    "Lennox", "Micah", "Noor",
  ];
  const LAST_NAMES = [
    "Clarke", "Walker", "Bennett", "Hughes", "Foster", "Reid", "Murphy",
    "Marshall", "Coleman", "Newman", "Dawson", "Fletcher", "Barker", "Wells",
    "Ashton", "Bramley", "Carver", "Delaney", "Ellery", "Fairbourne",
    "Garrick", "Halloway", "Ingram", "Jarrett", "Kendrick", "Lockhart",
    "Merrick", "Northcote", "Oakley", "Pennington", "Quillan", "Radcliffe",
    "Sinclair", "Thorne", "Underwood", "Vance", "Winslow", "Yardley",
    "Ashford", "Bellamy",
  ];
  /* Kept as the union so anything that still wants "a person's first name"
   * without caring about gender behaves exactly as before. */
  const FIRST_NAMES = [...FIRST_MALE, ...FIRST_FEMALE, ...FIRST_UNISEX];
  const STREET_NAMES = [
    "Oak", "Maple", "Cedar", "Birch", "Elm", "Willow", "Acacia", "Banksia",
    "Wattle", "Jacaranda", "Eucalypt", "Hibiscus",
  ];
  const STREET_TYPES = ["Ave", "St", "Rd", "Cres", "Pde", "Ct", "Dr"];
  const CITIES = [
    "Melbourne", "Brisbane", "Perth", "Adelaide", "Hobart", "Canberra",
    "Newcastle", "Geelong", "Cairns", "Darwin",
  ];
  const EMAIL_DOMAINS = ["placeholder.com", "example.com.au", "sample.net"];
  // Fake company STEMS only — no designator. The ORG generator re-attaches the
  // real name's own "Pty Ltd" / "Logistics" / "Group" ending so the fake keeps
  // the same shape and industry sense. (This replaces an earlier unused
  // COMPANIES pool of complete names, which couldn't preserve that.)
  const ORG_NAMES = [
    "Northwind", "Riverstone", "Harbourview", "Bluestone", "Ironbark",
    "Silverbrook", "Kestrel", "Meridian", "Copperfield", "Brightwater",
    "Stonebridge", "Wattlebank", "Redgum", "Coastline", "Pinnacle", "Lantern",
  ];
  // Fallback ending, used only when the real name had no recognisable
  // designator of its own to carry over.
  const ORG_DESCRIPTORS = ["Group", "Holdings", "Partners", "Enterprises", "Pty Ltd"];

  /* ------------------------------------------------------------------ *
   * Seeded pseudo-random helpers. The seed is random per generated value, so
   * fakes are fresh each time; the lookup table keeps a real value mapped to
   * the same fake for the life of the table so conversations stay coherent.
   * ------------------------------------------------------------------ */
  function pick(arr, seed) {
    // seed can exceed 2^31; coerce to a safe non-negative index.
    const i = ((seed >>> 0) % arr.length + arr.length) % arr.length;
    return arr[i];
  }

  function seededDigits(seed, length) {
    // Generate `length` digits deterministically from a seed.
    let s = seed || 1;
    let out = "";
    for (let i = 0; i < length; i++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      out += ((s >>> 16) % 10).toString();
    }
    return out;
  }

  /** Build a Luhn-valid fake card number from a seed. */
  function fakeCard(seed) {
    let body = "4" + seededDigits(seed, 14); // 15 digits, Visa-like prefix
    // Compute Luhn check digit for the 16th position.
    let sum = 0;
    let alt = true;
    for (let i = body.length - 1; i >= 0; i--) {
      let n = parseInt(body[i], 10);
      if (alt) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      alt = !alt;
    }
    const check = (10 - (sum % 10)) % 10;
    const full = body + check;
    return full.replace(/(\d{4})(?=\d)/g, "$1 ");
  }

  /** A fresh 32-bit random seed. Using randomness (not a hash of the real
   * value) means every masked value is a brand-new random Australian identity
   * each time — we never reproduce a fixed "Mia Murphy" for a given input.
   * Consistency within a session is provided by the lookup table, not the seed. */
  function randomSeed() {
    return (Math.random() * 0x100000000) >>> 0;
  }

  /* ------------------------------------------------------------------ *
   * Fake-value generators per finding type. Each takes the real value (only
   * used for structural hints like length) plus a RANDOM seed, and returns a
   * realistic Australian substitute.
   * ------------------------------------------------------------------ */
  const GENERATORS = {
    EMAIL(real, seed) {
      const first = pick(FIRST_NAMES, seed).toLowerCase();
      const last = pick(LAST_NAMES, seed >>> 7).toLowerCase();
      const domain = pick(EMAIL_DOMAINS, seed >>> 3);
      const num = (seed >>> 11) % 100;
      return `${first}.${last}${num}@${domain}`;
    },
    PHONE(real, seed) {
      const d = seededDigits(seed, 8);
      // Mirror a bracketed landline: "(02) 9147 3388" gets "(03) 8241 5590",
      // not a bare mobile — a stand-in should match the shape it replaces.
      const src = String(real || "");
      const area = src.match(/^\((0[2-9])\)/);
      if (area) {
        const codes = ["02", "03", "07", "08"];
        let code = codes[seed % codes.length];
        if (code === area[1]) code = codes[(seed + 1) % codes.length];
        return `(${code}) ${8 + (seed % 2)}${d.slice(0, 3)} ${d.slice(3, 7)}`;
      }
      if (/^0[2-9][\s.-]/.test(src) && !/^04/.test(src)) {
        // Unbracketed landline ("02 9147 3388"): keep the landline shape.
        const codes = ["02", "03", "07", "08"];
        let code = codes[seed % codes.length];
        if (src.startsWith(code)) code = codes[(seed + 1) % codes.length];
        return `${code} ${8 + (seed % 2)}${d.slice(0, 3)} ${d.slice(3, 7)}`;
      }
      return `04${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)}`;
    },
    CREDIT_CARD(real, seed) {
      return fakeCard(seed);
    },
    MEDICARE(real, seed) {
      const d = seededDigits(seed, 10);
      return `2${d.slice(0, 3)} ${d.slice(3, 8)} ${d.slice(8, 9)}`;
    },
    TFN(real, seed) {
      const d = seededDigits(seed, 9);
      return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 9)}`;
    },
    PASSPORT(real, seed) {
      const letter = String.fromCharCode(65 + (seed % 26));
      return `${letter}${seededDigits(seed, 7)}`;
    },
    LICENCE(real, seed) {
      // Preserve the original structure so the fake stays the same shape:
      // a state-letter prefix (NSW45612378 -> NSW + 8 fake digits) or, if there
      // is no prefix, the same number of digits as the original.
      const m = (real || "").match(/^([A-Za-z]{1,3})\s?(\d+)$/);
      if (m) return m[1].toUpperCase() + seededDigits(seed, m[2].length);
      const len = (real || "").replace(/\D/g, "").length || 8;
      return seededDigits(seed, len);
    },
    BSB(real, seed) {
      const d = seededDigits(seed, 6);
      return `${d.slice(0, 3)}-${d.slice(3, 6)}`;
    },
    BANK_ACCOUNT(real, seed) {
      // Preserve the grouping ("8827 3410" -> "1248 4940", "044-772-19" ->
      // "263-694-37"), not just the digit count. Account and order references
      // are frequently written in blocks, and collapsing them to one run makes
      // the masked message read as a different kind of value than the user
      // wrote — the same reason REF_CODE below keeps its shape.
      const digits = seededDigits(seed, real.replace(/\D/g, "").length || 8);
      let i = 0;
      let outStr = "";
      for (const ch of real) outStr += /\d/.test(ch) ? digits[i++] : ch;
      return i ? outStr : digits;
    },
    REF_CODE(real, seed) {
      // Keep the SHAPE (same letter count, same digit count) so the AI still
      // reads it as one reference code, but replace the letters too rather
      // than preserving them: a prefix like "BW-" is usually the client's own
      // initials, so carrying it through would leak the very organisation
      // name being masked two lines above it.
      const m = (real || "").match(/^([A-Za-z]{2,4})-(\d{4,6})$/);
      const letterCount = m ? m[1].length : 3;
      const digitCount = m ? m[2].length : 5;
      let letters = "";
      for (let i = 0; i < letterCount; i++) {
        letters += String.fromCharCode(65 + ((seed >>> (i * 5)) % 26));
      }
      return `${letters}-${seededDigits(seed >>> 3, digitCount)}`;
    },
    ABN(real, seed) {
      const d = seededDigits(seed, 11);
      return `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8, 11)}`;
    },
    ACN(real, seed) {
      const d = seededDigits(seed, 9);
      return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 9)}`;
    },
    DOB(real, seed) {
      const day = (seed % 28) + 1;
      const month = ((seed >>> 5) % 12) + 1;
      const year = 1960 + ((seed >>> 9) % 45); // 1960-2004
      const pad = (n) => String(n).padStart(2, "0");
      // Mirror the REAL value's format. Documents write dates in prose, and a
      // stand-in that flips "14 March 1991" to "22/08/1987" mid-sentence is
      // conspicuous in exactly the place a stand-in should be invisible.
      const src = String(real || "");
      const FULL = ["January", "February", "March", "April", "May", "June", "July",
                    "August", "September", "October", "November", "December"];
      const monthWord = (abbrev) => (abbrev ? FULL[month - 1].slice(0, 3) : FULL[month - 1]);
      const ord = (n) => {
        if (n % 100 >= 11 && n % 100 <= 13) return n + "th";
        return n + (["th", "st", "nd", "rd"][n % 10] || "th");
      };
      const monthRe = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)([a-z]*)\b/i;
      const mw = src.match(monthRe);
      if (mw) {
        const abbrev = !mw[2]; // "Mar" vs "March"
        const hasOrd = /\d(?:st|nd|rd|th)\b/i.test(src);
        const hasOf = /\bof\b/i.test(src);
        const dayTxt = hasOrd ? ord(day) : String(day);
        const comma = src.includes(",") ? "," : "";
        // Month-first ("March 14, 1991") vs day-first ("14 March 1991").
        const dayPos = src.search(/\d/);
        if (dayPos > src.toLowerCase().indexOf(mw[1].toLowerCase())) {
          return `${monthWord(abbrev)} ${dayTxt}${comma} ${year}`;
        }
        return `${dayTxt}${hasOf ? " of" : ""} ${monthWord(abbrev)}${comma} ${year}`;
      }
      if (/^(?:19|20)\d\d-/.test(src)) return `${year}-${pad(month)}-${pad(day)}`;
      const sep = (src.match(/[\/.-]/) || ["/"])[0];
      return `${pad(day)}${sep}${pad(month)}${sep}${year}`;
    },
    GPS(real, seed) {
      const lat = -(33 + ((seed % 400) / 100)).toFixed(4); // ~-33 to -37
      const lng = (144 + (((seed >>> 7) % 700) / 100)).toFixed(4); // ~144 to 151
      return `${lat}, ${lng}`;
    },
    MONEY(real, seed) {
      const lc = (real || "").toLowerCase();
      // Parse the base number (strip $ and commas).
      const rawNum = parseFloat((real || "").replace(/[^0-9.]/g, "")) || 10000;
      // Scale up if the original used a verbal multiplier.
      const hasBillion = lc.includes("billion");
      const hasMillion = lc.includes("million");
      let magnitude = rawNum;
      if (hasBillion) magnitude *= 1e9;
      else if (hasMillion) magnitude *= 1e6;
      // Generate a fake ±20 % of the real value so it stays in the same range.
      const pct = 0.8 + ((seed % 400) / 1000); // 0.80 – 1.20
      const fakeVal = Math.max(1000, Math.round(magnitude * pct));
      // Format to match the original style.
      if (hasBillion) return "$" + (fakeVal / 1e9).toFixed(1).replace(/\.0$/, "") + " billion";
      if (hasMillion) return "$" + (fakeVal / 1e6).toFixed(1).replace(/\.0$/, "") + " million";
      return "$" + fakeVal.toLocaleString("en-AU");
    },
    ADDRESS(real, seed) {
      const num = (seed % 200) + 1;
      const street = pick(STREET_NAMES, seed >>> 2);
      const type = pick(STREET_TYPES, seed >>> 4);
      const city = pick(CITIES, seed >>> 6);
      return `${num} ${street} ${type} ${city}`;
    },
    USERNAME(real, seed) {
      // Keep it obviously a handle (lowercase word + digits) without echoing
      // any part of the real one — a username is frequently the person's
      // actual surname or initials, which is exactly what masking is for.
      const first = pick(FIRST_NAMES, seed).toLowerCase();
      const last = pick(LAST_NAMES, seed >>> 5).toLowerCase();
      return `${first[0]}${last}${seededDigits(seed >>> 9, 2)}`;
    },
    PASSWORD(real, seed) {
      // A realistic random secret, NOT a fixed "[redacted-secret]" token.
      //
      // The constant was not merely cosmetic: every password in a message
      // mapped to the same string, so two different secrets became
      // indistinguishable. previewFake()'s collision guard is built to stop
      // exactly that, but it retries by re-generating, and a constant
      // generator returns the same value on all 100 retries — so it silently
      // gave up and handed out the duplicate. Unmasking then had no way to
      // tell which secret a "[redacted-secret]" belonged to.
      //
      // Nothing of the real value is preserved (not even its length), so this
      // still leaks no structure — it just makes each fake unique and
      // plausible enough that the AI reads it as a credential.
      const lower = "abcdefghijkmnpqrstuvwxyz"; // no l/o — ambiguous glyphs
      const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
      const digits = "23456789";
      const symbols = "!@#$%&*?";
      let s = (seed || 1) >>> 0;
      const next = (n) => {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        return (s >>> 16) % n;
      };
      // Guarantee one of each class, then fill to a random 9-12 chars.
      const chars = [
        upper[next(upper.length)],
        lower[next(lower.length)],
        digits[next(digits.length)],
        symbols[next(symbols.length)],
      ];
      const pool = lower + upper + digits;
      const target = 9 + next(4);
      while (chars.length < target) chars.push(pool[next(pool.length)]);
      // Fisher-Yates so the guaranteed characters aren't always in positions 0-3.
      for (let i = chars.length - 1; i > 0; i--) {
        const j = next(i + 1);
        const t = chars[i];
        chars[i] = chars[j];
        chars[j] = t;
      }
      return chars.join("");
    },
    NAME_PII(real, seed) {
      // Keep the stand-in's gender matching the real name's, so the AI's reply
      // and anything drafted from it stay correct. Without this, "name is
      // Sophie Newman" could come back as "Got it, Oliver".
      //
      // `real` was already passed to every generator and simply ignored here,
      // so this needs no plumbing — only the FIRST token is used, which also
      // means previewFake()'s collision retry (which appends ":<n>" to `real`)
      // still resolves to the same gender.
      const firstToken = String(real || "").trim().split(/[\s'’-]+/)[0] || "";
      const gaz = (typeof window !== "undefined" && window.GuardAI &&
                   window.GuardAI.NAME_GAZETTEER) || null;
      const g = gaz ? gaz.genderOf(firstToken) : null;
      // "u" (known unisex) and null (not in the list) are treated the same:
      // a NEUTRAL stand-in. A neutral name cannot be wrong, only
      // uninformative, and the gazetteer tags conservatively on purpose so
      // every uncertain case lands here rather than being guessed. That
      // matters most for non-Anglo names, where confidence is lowest and a
      // confidently wrong stand-in would be the worst outcome.
      const pool = g === "m" ? FIRST_MALE : g === "f" ? FIRST_FEMALE : FIRST_UNISEX;
      return `${pick(pool, seed)} ${pick(LAST_NAMES, seed >>> 3)}`;
    },
    ORG(real, seed) {
      // Keep the real name's own designator/descriptor ("Pty Ltd",
      // "Logistics", "Group") and swap only the distinctive part, the same way
      // LICENCE preserves its state prefix. The AI then still sees "a
      // logistics company" / "a Pty Ltd entity" and reasons about the message
      // correctly, while the identifying word — the part that actually names
      // the business — is gone.
      const m = (real || "").trim().match(
        /^(.*?)[\s]+((?:Pty\.?\s+)?Ltd\.?|(?:Pty\.?\s+)?Limited|Pty\.?|Incorporated|Inc\.?|L\.L\.C\.?|LLC|LLP|PLC|P\/L|Corporation|Corp\.?|GmbH|Group|Holdings|Partners|Partnership|Enterprises|Industries|Solutions|Services|Systems|Technologies|Consulting|Consultancy|Consultants|Logistics|Trading|Ventures|Associates|Agency|Studios|Studio|Laboratories|Labs|Foundation|Institute|Company|Contractors|Constructions|Developments|Investments|Removals|Freight|Transport|Supplies|Distribution|Manufacturing|Engineering|Motors)$/i
      );
      const stem = pick(ORG_NAMES, seed);
      return m ? `${stem} ${m[2]}` : `${stem} ${pick(ORG_DESCRIPTORS, seed >>> 5)}`;
    },
  };

  /**
   * Masking policy — which findings are auto-swapped for fakes.
   *
   * MASK: anything that IDENTIFIES someone or something — people, companies,
   * contact details, locations, and government/account/reference numbers.
   *
   * DON'T auto-mask: dollar figures (MONEY), dates including dates of birth
   * (DOB), and quantities. Two reasons. First, replacing them corrupts the
   * very thing people ask an AI to do with them — totals stop adding up,
   * date arithmetic and ages come out wrong, and the answer that comes back
   * is quietly useless. Second, they aren't identifying on their own: once
   * the name, company, phone, email, address and account numbers around a
   * figure are all fake, "$40,000 owing since 03/2024" no longer points at
   * anybody. Note this is a deliberate trade-off, not an oversight — a bare
   * DOB IS an identifier in combination with data from elsewhere, so a user
   * who wants one hidden can highlight it and mask it by hand (the manual
   * flow doesn't consult this set, and the DOB/MONEY fake generators are
   * kept for exactly that path).
   *
   * Keyword/contextual findings (CONFIDENTIAL, HEALTH, LEGAL, IMMIGRATION,
   * BUSINESS_CONFIDENTIAL) stay warning-only for a different reason —
   * replacing free-text phrases would mangle the message.
   *
   * Everything not in this set is still DETECTED and still listed on the
   * warning card; it just isn't swapped automatically.
   *
   * ONE EXCEPTION: "Send as safe text" (content.js buildReviewModel with
   * docPolicy) masks DOB despite this set. Every leg of the reasoning above assumes the chat
   * flow — an interrupting card that lists the DOB, and a manual-mask step
   * one click away. The document flow has neither for non-blocking types, so
   * a real date of birth sailed through it verbatim (found 2026-08-28 on a
   * real offer letter). MONEY stays unmasked there too, deliberately: a
   * salary is the thing the user is asking the AI about, and it is not
   * identity data.
   */
  const MASKABLE = new Set([
    // people and organisations
    "NAME_PII", "ORG",
    // contact details and location
    "PHONE", "EMAIL", "ADDRESS", "GPS",
    // government / identity documents
    "PASSPORT", "LICENCE", "MEDICARE", "TFN",
    // account, banking and business reference numbers
    "CREDIT_CARD", "BSB", "BANK_ACCOUNT", "REF_CODE", "ABN", "ACN",
    // credentials
    "PASSWORD", "USERNAME",
  ]);
  // Exposed so detector.js's overlap resolution (which runs after all four
  // scripts have loaded) can prefer a maskable finding over a warning-only one
  // when their spans clash — see resolveOverlaps() in detector.js.
  window.GuardAI = window.GuardAI || {};
  window.GuardAI.MASKABLE_TYPES = MASKABLE;

  /**
   * Does this stand-in reuse one of the real name's own words?
   *
   * Found 2026-08-22 by the name-matching suite, which failed roughly 1 run in
   * 60: "Aisha Al-Rashid" was masked to "Aisha Halloway". The surname was
   * replaced and the GIVEN NAME WAS SENT VERBATIM to the AI. The existing
   * guard only rejected a fake equal to the whole real value, so a
   * part-for-part collision walked straight through it — and with 40 names per
   * pool it lands about 1 time in 40 whenever the real given name is one the
   * pool also contains.
   *
   * Scoped to NAME_PII deliberately. ORG stand-ins are SUPPOSED to share a
   * word: "Bellweather Logistics" -> "Coastline Logistics" keeps the sentence
   * readable, and "Logistics" is a designator, not an identity. Names have no
   * equivalent — every word in one is identifying.
   */
  function sharesNameToken(type, real, fake) {
    if (type !== "NAME_PII") return false;
    const words = (v) =>
      String(v || "")
        .toLowerCase()
        .split(/[^\p{L}\p{M}]+/u)
        .filter((t) => t.length > 1);
    const realWords = new Set(words(real));
    return words(fake).some((w) => realWords.has(w));
  }

  function generateFake(type, real) {
    const gen = GENERATORS[type] || (() => "[redacted]");
    return gen(real, randomSeed());
  }

  /* ------------------------------------------------------------------ *
   * Masker class
   * ------------------------------------------------------------------ */
  class Masker {
    constructor() {
      // In-memory mirrors of the persisted table for fast sync lookups.
      this.realToFake = new Map();
      this.fakeToReal = new Map();
      this._loaded = false;
    }

    /**
     * Load the persisted mapping table from chrome.storage.local. Never
     * throws: masking must keep working in-memory for the current page even
     * if persistence is broken (quota issues, "Extension context
     * invalidated" after a reload, storage genuinely unavailable, etc.), and
     * a corrupted/unexpected stored shape must be skipped rather than crash
     * the caller (every mask/unmask path awaits this).
     */
    async load() {
      if (this._loaded) return;
      try {
        const data = await chrome.storage.local.get(STORAGE_KEY);
        const entries = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
        for (const e of entries) {
          if (!e || typeof e.real !== "string" || typeof e.fake !== "string" || typeof e.type !== "string") {
            console.warn("[GuardAI] skipping malformed mapping entry:", e);
            continue;
          }
          this.realToFake.set(e.real, e);
          this.fakeToReal.set(e.fake, e);
        }
      } catch (err) {
        console.warn("[GuardAI] could not load mapping table, starting empty:", err);
      } finally {
        // Always mark loaded, even on failure — otherwise every future call
        // would retry load() and could throw again instead of just proceeding
        // with an empty (or partially recovered) in-memory table.
        this._loaded = true;
      }
    }

    /**
     * Persist the in-memory table back to chrome.storage.local. Never
     * throws — masking has already happened in memory by the time this is
     * called, so a save failure should only mean the mapping won't survive a
     * reload, not that the current mask/unmask operation fails.
     */
    async save() {
      try {
        const entries = Array.from(this.realToFake.values());
        await chrome.storage.local.set({ [STORAGE_KEY]: entries });
      } catch (err) {
        console.warn("[GuardAI] could not persist mapping table (masking still works this session):", err);
      }
    }

    /**
     * Evict the oldest entries (by createdAt) once the table exceeds
     * MAX_ENTRIES, so a long-lived conversation's mapping table — and the
     * per-message cost of iterating it on every restore pass — never grows
     * unbounded. Called before adding a new entry.
     */
    _evictIfNeeded() {
      const overflow = this.realToFake.size - MAX_ENTRIES + 1;
      if (overflow <= 0) return;
      const oldest = Array.from(this.realToFake.values())
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .slice(0, overflow);
      for (const entry of oldest) {
        this.realToFake.delete(entry.real);
        this.fakeToReal.delete(entry.fake);
      }
    }

    /** Get an existing fake for a real value, or create + remember one. */
    _getOrCreate(type, real) {
      const existing = this.realToFake.get(real);
      if (existing) return existing.fake;

      let fake = generateFake(type, real);
      // Guarantee uniqueness of the fake value so unmasking is unambiguous,
      // that it never lands on the real value itself (e.g. MONEY scales the
      // real amount by a random 80-120%, so roughly 1 in 400 draws rounds
      // right back to the original figure), AND that it never lands on a
      // DIFFERENT entry's real value. Restore rules match a fake string
      // literally anywhere in the response — if person B's randomly
      // generated fake happened to equal person A's real name, an unrelated
      // AI mention of that name (or A's own correctly-displayed real text
      // elsewhere in the conversation) would get wrongly rewritten into B's
      // real data the next time an unmask pass runs.
      let guard = 0;
      while (
        (this.fakeToReal.has(fake) ||
          fake === real ||
          this.realToFake.has(fake) ||
          sharesNameToken(type, real, fake)) &&
        guard < 50
      ) {
        fake = generateFake(type, real + ":" + guard);
        guard++;
      }
      this._evictIfNeeded();
      const entry = { real, fake, type, createdAt: Date.now() };
      this.realToFake.set(real, entry);
      this.fakeToReal.set(fake, entry);
      return fake;
    }

    /** Is this finding type one we swap for a fake (vs warning-only)? */
    isMaskable(type) {
      return MASKABLE.has(type);
    }

    /**
     * Compute a candidate fake for a value WITHOUT registering it. Used by the
     * pre-send preview so we can show the proposed replacement before the user
     * commits. Reuses an existing mapping if one is already known, and avoids
     * collisions with fakes that are already in the table.
     */
    previewFake(type, real, avoid) {
      const existing = this.realToFake.get(real);
      if (existing) return existing.fake;
      // Treat a fake as taken if it's in the persisted table, in the caller's
      // `avoid` set (fakes already handed out to OTHER values in this same
      // batch, which aren't registered yet), IS the real value itself (e.g.
      // MONEY's random 80-120% scaling can round back to the original
      // figure), or equals a DIFFERENT entry's real value (see the matching
      // comment in _getOrCreate for why that's also unsafe). This is what
      // stops two different real values colliding on the same fake when many
      // are masked in one pass, and stops a fake silently being identical to
      // ANY real data anywhere in the table.
      const taken = (f) =>
        this.fakeToReal.has(f) ||
        f === real ||
        this.realToFake.has(f) ||
        sharesNameToken(type, real, f) ||
        (avoid && avoid.has(f));
      let fake = generateFake(type, real);
      let guard = 0;
      while (taken(fake) && guard < 100) {
        fake = generateFake(type, real + ":" + guard);
        guard++;
      }
      return fake;
    }

    /**
     * Register a real->fake pair the user committed in the preview (either an
     * auto-generated or a custom replacement). Reuses an existing mapping for
     * the same real value. Caller is responsible for calling save().
     */
    registerManual(real, fake, type) {
      const existing = this.realToFake.get(real);
      if (existing) return existing.fake;
      this._evictIfNeeded();
      const entry = { real, fake, type: type || "CUSTOM", createdAt: Date.now() };
      this.realToFake.set(real, entry);
      this.fakeToReal.set(fake, entry);
      return fake;
    }

    /**
     * Forget a real<->fake pair. Used when the user un-masks an item in the
     * MESSAGE tab before sending, so the real value is restored in the input and
     * auto-restore won't swap it. Caller is responsible for calling save().
     */
    unregister(real) {
      const entry = this.realToFake.get(real);
      if (!entry) return;
      this.realToFake.delete(real);
      this.fakeToReal.delete(entry.fake);
    }

    /**
     * Mask text given pre-computed findings from the detector.
     * Returns { masked, replacements } where replacements lists what changed.
     * Replacements are applied from the end of the string backwards so that
     * earlier indices stay valid as the string length changes.
     */
    async mask(text, findings) {
      await this.load();
      if (!findings || !findings.length) return { masked: text, replacements: [] };

      // Only swap maskable (structured) findings; leave warning-only ones intact.
      const maskable = findings.filter((f) => MASKABLE.has(f.type));
      if (!maskable.length) return { masked: text, replacements: [] };

      // Sort by index descending to keep offsets valid during splicing.
      const ordered = [...maskable].sort((a, b) => b.index - a.index);
      let masked = text;
      const replacements = [];

      for (const f of ordered) {
        const fake = this._getOrCreate(f.type, f.value);
        const start = f.index;
        const end = start + f.value.length;
        // Defensive: only splice if the slice still matches the finding value.
        if (masked.slice(start, end) === f.value) {
          masked = masked.slice(0, start) + fake + masked.slice(end);
        } else {
          // Fallback to a global replace if offsets drifted (rich editors).
          masked = masked.split(f.value).join(fake);
        }
        replacements.push({ type: f.type, real: f.value, fake });
      }

      await this.save();
      return { masked, replacements };
    }

    /**
     * Reverse the masking: swap every known fake value back to its real value.
     * Used on AI responses (and the user's own sent bubbles) so the user only
     * ever reads real data. Longest fakes first to avoid partial overlaps.
     */
    async unmask(text) {
      await this.load();
      if (!text || this.fakeToReal.size === 0) return text;

      const fakes = Array.from(this.fakeToReal.keys()).sort(
        (a, b) => b.length - a.length
      );
      let result = text;
      for (const fake of fakes) {
        if (result.includes(fake)) {
          const entry = this.fakeToReal.get(fake);
          result = result.split(fake).join(entry.real);
        }
      }
      return result;
    }

    /** Does the given text contain any known fake placeholder? */
    async containsFake(text) {
      await this.load();
      for (const fake of this.fakeToReal.keys()) {
        if (text.includes(fake)) return true;
      }
      return false;
    }

    /** Wipe the entire mapping table (memory + storage). */
    async clear() {
      // In-memory state is cleared first and unconditionally, so the current
      // page's masking/restore is correctly reset even if the storage call
      // below fails.
      this.realToFake.clear();
      this.fakeToReal.clear();
      try {
        await chrome.storage.local.remove(STORAGE_KEY);
      } catch (err) {
        console.warn("[GuardAI] could not clear persisted mapping table:", err);
      }
    }

    /**
     * Drop the in-memory table WITHOUT touching storage — for when this page
     * learns (via chrome.storage.onChanged) that some OTHER context, like the
     * popup's "Clear" button, already deleted storage. That popup click can't
     * reach into this page's masker instance directly (`_loaded` means load()
     * never re-reads storage after the first time), so without this the
     * page's own in-memory table just kept working — masking and restoring
     * with the very data the user just asked to delete, invisible to them.
     */
    forgetInMemory() {
      this.realToFake.clear();
      this.fakeToReal.clear();
    }

    /** Number of stored mappings. */
    get size() {
      return this.realToFake.size;
    }
  }

  window.GuardAI = window.GuardAI || {};
  window.GuardAI.Masker = Masker;
})();
