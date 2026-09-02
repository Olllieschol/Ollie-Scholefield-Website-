/**
 * Guard4AI — settings.js
 * ---------------------------------------------------------------------------
 * "What Guard4AI masks": per-category detection toggles.
 *
 * The category list below is a MANUAL mirror of every finding type detector.js
 * actually produces (grep `finding("` in src/detector.js — 24 distinct types
 * as of this writing) and of which of those masker.js's MASKABLE set actually
 * swaps for a fake vs only flags on the warning card. There's no build step
 * in this extension to generate it automatically; if a new detector/type is
 * ever added to detector.js, add its row here too, or it will keep running
 * (safe default — nothing silently stops being protected) but won't appear
 * in this list to be turned off.
 *
 * Persisted as chrome.storage.local["guardai_disabled_categories"]: an array
 * of TYPE strings that are OFF. Absent from the array = on. This means an
 * empty/missing array is "everything on", so a category added to this file
 * later defaults to enabled for existing users with no migration needed.
 * ---------------------------------------------------------------------------
 */
(function () {
  "use strict";

  const STORAGE_KEY = "guardai_disabled_categories";
  const THEME_KEY = "guardai_theme";
  const POLICY_KEY = "guardai_policy";

  /**
   * Attachment scanning. Two switches rather than one, because OCR on a
   * screenshot is a different cost to the user than reading a PDF's text
   * layer, and people reasonably want one without the other.
   *
   * Both DEFAULT ON, which is why they are not in MODES below — that list is
   * an opt-in list and renders an "off by default" badge that would be a lie
   * here. `lock` names the entry in the company policy that can pin this
   * switch; see src/policy.js.
   */
  const SWITCHES = [
    {
      key: "guardai_file_scanning",
      lock: "files",
      title: "Check documents I attach",
      desc: "On by default. Guard4AI reads PDFs, Word documents and text files before " +
            "they're attached, and stops the ones carrying sensitive details. Reading " +
            "happens on your own device; the file never leaves it.",
      note: "Turning this off means attachments go straight to the AI tool unchecked. " +
            "What you type is still checked.",
    },
    {
      key: "guardai_image_scanning",
      lock: "images",
      title: "Read text in images I attach",
      desc: "On by default. Guard4AI runs text recognition over screenshots and photos " +
            "before they're attached. This is slower than reading a document, and it " +
            "can't read everything in an image.",
      note: "Turning this off means screenshots are attached without being looked at. " +
            "A screenshot is the most common way a password reaches a chatbot.",
    },
  ];

  /** Mirrors isLocked() in src/policy.js — see the note on the copy in
   *  src/content.js. Held to it by test/policy.cjs. */
  function lockedBy(pol, name) {
    if (!pol || typeof pol !== "object") return false;
    if (pol.mode !== "enforced") return false;
    if (!pol.locks || typeof pol.locks !== "object") return false;
    return pol.locks[name] === true;
  }

  /** Mirrors setByLine() in src/policy.js. Not the company name: the badge is
   *  uppercased and a company name is not written to be. */
  function setByLine() {
    return "Locked by admin";
  }

  /* The policy last read from storage. Cached rather than re-read inside
     render(), which is synchronous and called from three places. Refreshed by
     loadPolicy() before every render and by the storage listener. */
  let policy = null;
  async function loadPolicy() {
    try {
      const d = await chrome.storage.local.get([POLICY_KEY]);
      policy = d[POLICY_KEY] || null;
    } catch (_) { /* leave the last known value */ }
    return policy;
  }

  /** The category lock name, matching catLock() in src/policy.js. */
  const catLock = (type) => "cat:" + type;
  // MODE toggles are not categories. They have their own storage keys because
  // the category list is an OFF-list (absence = enabled), which structurally
  // cannot express a DEFAULT-OFF setting. Rendered in their own section, and
  // excluded from the settings<->finding-type cross-check in
  // test/category-toggles.cjs, since a mode is not a finding type.
  const MODES = [
    {
      key: "guardai_aggressive_names",
      title: "Aggressive name detection",
      desc: "Off by default. Normally Guard4AI only masks a full name when other personal " +
            "information sits beside it. Turn this on to also catch names standing on their " +
            "own. It will flag more false positives, because words like Sydney, April and " +
            "Grace are both names and ordinary words.",
      note: "With Automatic protection on, an uncertain match still shows the warning card instead " +
            "of being swapped silently, so a false positive can't quietly rewrite your message.",
    },
    {
      key: "guardai_image_hard_stop",
      title: "Always stop on images",
      desc: "No longer changes anything — every upload now waits for you, so this is " +
            "already how images behave whether it is on or off.",
      note: "Kept so that turning it on in the past does not break anything. Uploads " +
            "became a decision in every case because a file cannot be partly masked: " +
            "the only choice available for one is whether it goes at all.",
      dead: true,
    },
  ];

  /**
   * type   — the exact finding().type string detector.js produces.
   * title  — short label, matches content.js's MARK_STYLE where one exists.
   * desc   — one line explaining what it catches, in plain language.
   * masked — true if masker.js's MASKABLE set swaps this for a fake; false
   *          means it's warning-only (flagged on the card, never auto-sent
   *          disguised) regardless of this toggle.
   */
  const GROUPS = [
    {
      title: "People & organisations",
      categories: [
        { type: "NAME_PII", title: "Full names", desc: "A person's first + last name, when other personal detail is nearby.", masked: true },
        { type: "ORG", title: "Company / organisation names", desc: "A registered business name — “Pty Ltd”, “Logistics”, “Group” and similar.", masked: true },
      ],
    },
    {
      title: "Contact & location",
      categories: [
        { type: "PHONE", title: "Phone numbers", desc: "Australian mobile and landline numbers.", masked: true },
        { type: "EMAIL", title: "Email addresses", desc: "Any address in the form name@domain.", masked: true },
        { type: "ADDRESS", title: "Physical addresses", desc: "A street number, name and suburb/city.", masked: true },
        { type: "GPS", title: "GPS coordinates", desc: "Precise latitude/longitude pairs.", masked: true },
      ],
    },
    {
      title: "Government & identity documents",
      categories: [
        { type: "PASSPORT", title: "Passport numbers", desc: "Australian passport document numbers.", masked: true },
        { type: "LICENCE", title: "Driver licence numbers", desc: "State-prefixed or bare licence numbers.", masked: true },
        { type: "MEDICARE", title: "Medicare numbers", desc: "10–11 digit Medicare card numbers.", masked: true },
        { type: "TFN", title: "Tax File Numbers", desc: "8–9 digit Australian TFNs.", masked: true },
        { type: "DOB", title: "Dates of birth", desc: "A birth date, written or numeric.", masked: false },
      ],
    },
    {
      title: "Financial & account numbers",
      categories: [
        { type: "CREDIT_CARD", title: "Credit / debit card numbers", desc: "13–19 digit card numbers.", masked: true },
        { type: "BSB", title: "Bank BSBs", desc: "6-digit branch identifier, e.g. 062-000.", masked: true },
        { type: "BANK_ACCOUNT", title: "Bank account numbers", desc: "A digit run near banking context.", masked: true },
        { type: "REF_CODE", title: "Account / reference codes", desc: "Letters-then-digits codes like BW-44192, ACC-2291.", masked: true },
        { type: "ABN", title: "Australian Business Numbers (ABN)", desc: "11-digit ABNs.", masked: true },
        { type: "ACN", title: "Australian Company Numbers (ACN)", desc: "9-digit ACNs.", masked: true },
        { type: "MONEY", title: "Financial amounts", desc: "Specific dollar figures with business/personal context.", masked: false },
      ],
    },
    {
      title: "Credentials",
      categories: [
        { type: "USERNAME", title: "Usernames / login IDs", desc: "Detected by phrasing: “username is X”, “user: X”, “the login for … is X”.", masked: true },
        { type: "PASSWORD", title: "Passwords / login credentials", desc: "Detected by phrasing: “password is X”, “pwd: X”. Also API keys, connection strings and seed phrases.", masked: true },
      ],
    },
    {
      title: "Confidential & sensitive content",
      categories: [
        { type: "CONFIDENTIAL", title: "Confidential / restricted markers", desc: "Text explicitly marked confidential, NDA, internal-only.", masked: false },
        { type: "BUSINESS_CONFIDENTIAL", title: "Confidential business data", desc: "Revenue, client lists, valuations and similar figures.", masked: false },
        { type: "HEALTH", title: "Health / medical information", desc: "Diagnoses, medications, medical history.", masked: false },
        { type: "LEGAL", title: "Legal / court information", desc: "Case details, privileged or court-related content.", masked: false },
        { type: "IMMIGRATION", title: "Immigration / visa details", desc: "Visa status and immigration case information.", masked: false },
      ],
    },
  ];

  function applyTheme(light) {
    document.body.classList.toggle("gd-light", light);
  }
  applyTheme(localStorage.getItem(THEME_KEY) === "light");

  const groupsEl = document.getElementById("groups");

  /**
   * The two attachment switches, and whether the user's employer has pinned
   * them.
   *
   * A pinned switch stays visible and stays in its true position. It is not
   * hidden, because a control that vanishes reads as a bug and the person is
   * entitled to know a policy applies to them rather than discovering it by
   * being confused. It is not shown as off either — it is on, and saying
   * otherwise would misreport what the extension is actually doing.
   */
  async function renderSwitches() {
    const host = document.getElementById("attachments");
    if (!host) return;
    let data = {};
    try {
      data = await chrome.storage.local.get(SWITCHES.map((s) => s.key).concat([POLICY_KEY]));
    } catch (_) {}
    const policy = data[POLICY_KEY] || null;

    host.innerHTML = "";
    const section = document.createElement("section");
    section.className = "group";
    const heading = document.createElement("div");
    heading.className = "group__title";
    heading.textContent = "Files and images";
    section.appendChild(heading);

    const list = document.createElement("div");
    list.className = "group__list";
    for (const sw of SWITCHES) {
      const locked = lockedBy(policy, sw.lock);
      // Locked always reads ON. Never write this back to storage: when an
      // admin returns the company to Flexible, the user's own choice has to
      // still be there, exactly as they left it.
      const on = locked ? true : data[sw.key] !== false;
      const row = document.createElement("div");
      row.className = "cat-row";
      row.innerHTML =
        `<div class="cat-row__text">` +
        `<span class="cat-row__title">${escapeHtml(sw.title)}</span>` +
        `<span class="cat-row__desc">${escapeHtml(sw.desc)}</span>` +
        `<span class="cat-row__desc cat-row__warn">${escapeHtml(sw.note)}</span>` +
        (locked
          ? `<span class="cat-row__badge cat-row__badge--set">${escapeHtml(setByLine())}</span>`
          : "") +
        `</div>` +
        `<label class="gd-switch">` +
        `<input type="checkbox" data-switch="${sw.key}" ${on ? "checked" : ""}` +
        `${locked ? ` disabled aria-describedby="lockmsg-${sw.key}"` : ""} />` +
        `<span class="gd-slider"></span>` +
        `</label>`;
      if (locked) {
        const sr = document.createElement("span");
        sr.id = "lockmsg-" + sw.key;
        sr.className = "sr-only";
        sr.textContent = "Locked by your administrator. You cannot change this.";
        row.appendChild(sr);
      }
      list.appendChild(row);
    }
    section.appendChild(list);
    host.appendChild(section);

    host.querySelectorAll("input[data-switch]").forEach((box) => {
      box.addEventListener("change", async () => {
        if (box.disabled) return;
        await chrome.storage.local.set({ [box.getAttribute("data-switch")]: box.checked });
      });
    });
  }

  async function renderModes() {
    const host = document.getElementById("modes");
    if (!host) return;
    let data = {};
    try { data = await chrome.storage.local.get(MODES.map((m) => m.key)); } catch (_) {}
    host.innerHTML = "";
    const section = document.createElement("section");
    section.className = "group";
    const heading = document.createElement("div");
    heading.className = "group__title";
    // "Modes", not "Detection mode": the second entry changes what Guard4AI
    // DOES with a result rather than what it detects, and a heading that says
    // "detection" over it would misdescribe the only setting in this section
    // that can change whether a file waits for you.
    heading.textContent = "Modes";
    section.appendChild(heading);
    const list = document.createElement("div");
    list.className = "group__list";
    for (const mode of MODES) {
      const on = data[mode.key] === true; // default OFF
      const row = document.createElement("div");
      row.className = "cat-row";
      row.innerHTML =
        `<div class="cat-row__text">` +
        `<span class="cat-row__title">${escapeHtml(mode.title)}</span>` +
        `<span class="cat-row__desc">${escapeHtml(mode.desc)}</span>` +
        `<span class="cat-row__desc cat-row__warn">${escapeHtml(mode.note)}</span>` +
        `<span class="cat-row__badge">Off by default</span>` +
        `</div>` +
        `<label class="gd-switch">` +
        `<input type="checkbox" data-mode="${mode.key}" ${on ? "checked" : ""} />` +
        `<span class="gd-slider"></span>` +
        `</label>`;
      list.appendChild(row);
    }
    section.appendChild(list);
    host.appendChild(section);
    host.querySelectorAll("input[data-mode]").forEach((box) => {
      box.addEventListener("change", async () => {
        await chrome.storage.local.set({ [box.getAttribute("data-mode")]: box.checked });
      });
    });
  }

  function render(disabledSet) {
    groupsEl.innerHTML = "";
    for (const group of GROUPS) {
      const section = document.createElement("section");
      section.className = "group";

      const heading = document.createElement("div");
      heading.className = "group__title";
      heading.textContent = group.title;
      section.appendChild(heading);

      const list = document.createElement("div");
      list.className = "group__list";

      for (const cat of group.categories) {
        const locked = lockedBy(policy, catLock(cat.type));
        // A locked category reads ON whatever the stored off-list says. The
        // off-list itself is never rewritten — see effectiveDisabled() in
        // src/policy.js for why a lock removes an entry rather than adding one.
        const on = locked ? true : !disabledSet.has(cat.type);
        const row = document.createElement("div");
        row.className = "cat-row";
        row.innerHTML =
          `<div class="cat-row__text">` +
          `<span class="cat-row__title">${escapeHtml(cat.title)}</span>` +
          `<span class="cat-row__desc">${escapeHtml(cat.desc)}</span>` +
          `<span class="cat-row__badge">${cat.masked ? "Auto-masked" : "Flagged only"}</span>` +
          (locked
            ? `<span class="cat-row__badge cat-row__badge--set">${escapeHtml(setByLine())}</span>`
            : "") +
          `</div>` +
          `<label class="gd-switch" title="${locked ? "Turned on by your organisation" : (cat.masked ? "Detect and auto-mask" : "Detect and flag") + " " + escapeHtml(cat.title.toLowerCase())}">` +
          `<input type="checkbox" data-type="${cat.type}" ${on ? "checked" : ""}${locked ? " disabled" : ""} />` +
          `<span class="gd-slider"></span>` +
          `</label>`;
        list.appendChild(row);
      }

      section.appendChild(list);
      groupsEl.appendChild(section);
    }

    groupsEl.querySelectorAll('input[type="checkbox"]').forEach((box) => {
      box.addEventListener("change", persistFromCheckboxes);
    });
  }

  /** Read every checkbox's current state and write the OFF list to storage.
   *  A pinned category is skipped outright: it is rendered disabled and
   *  checked, so it could not reach this list anyway, but saying so here means
   *  the one function that writes the off-list cannot put a locked category
   *  into it however it is called. */
  async function persistFromCheckboxes() {
    const disabled = [];
    groupsEl.querySelectorAll('input[type="checkbox"]').forEach((box) => {
      const type = box.getAttribute("data-type");
      if (lockedBy(policy, catLock(type))) return;
      if (!box.checked) disabled.push(type);
    });
    await chrome.storage.local.set({ [STORAGE_KEY]: disabled });
  }

  function allTypes() {
    return GROUPS.flatMap((g) => g.categories.map((c) => c.type));
  }

  document.getElementById("enable-all").addEventListener("click", async () => {
    await chrome.storage.local.set({ [STORAGE_KEY]: [] });
    render(new Set());
  });
  document.getElementById("disable-all").addEventListener("click", async () => {
    // Everything the user is actually allowed to switch off. A pinned category
    // is left out, so "Disable all" turns off what it can and leaves the rest
    // visibly on rather than appearing to fail.
    const off = allTypes().filter((t) => !lockedBy(policy, catLock(t)));
    await chrome.storage.local.set({ [STORAGE_KEY]: off });
    render(new Set(off));
  });

  document.getElementById("back-link").addEventListener("click", (e) => {
    e.preventDefault();
    window.close();
  });

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ------------------------------------------------------------------ *
   * Activate Guard4AI.
   *
   * One field, two kinds of key. The extension works out which from the
   * prefix (GA- workplace, GK- personal) rather than making somebody decide
   * which sort of customer they are before they can type anything.
   *
   * All of the network work lives in the background worker; this only asks it
   * questions and renders the answers.
   * ------------------------------------------------------------------ */
  const companyEl = document.getElementById("company");
  const DAY_MS = 86400000;
  // The canonical policy lives on the site. The Web Store will not accept a
  // chrome-extension:// URL as a privacy policy, and a second copy shipped in
  // the extension would drift from it. popup.js holds the same constant.
  const PRIVACY_URL = "https://guard4ai.com/privacy";

  function setCompanyMsg(text, bad) {
    const el = document.getElementById("company-msg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "company__msg" + (text ? " is-on" : "") + (bad ? " is-bad" : "");
  }

  function askWorker(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(res);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  /**
   * Paint one of the four states. "active" and "grace" are the same picture on
   * purpose: grace means we have not managed to re-check recently, which is
   * our problem and not something to make the user anxious about.
   */
  function paintActivation(state, rec, conn) {
    if (!companyEl) return;
    const running = state === "active" || state === "grace" || state === "warned";
    // Three layouts, not two. Warned needs the status line AND the form —
    // being told your licence is running out is useless without somewhere to
    // type the new one.
    companyEl.classList.toggle("is-connected", running && state !== "warned");
    companyEl.classList.toggle("is-warned", state === "warned");

    // Above the early return below, deliberately. Every state has to resolve
    // the seat block, including the ones that bail out before the detail line
    // is written; otherwise deactivating leaves the previous holder's id on
    // screen, which on a shared machine is a real if small leak.
    paintSeat(running && rec && rec.kind === "company" ? conn : null);

    const heading = document.getElementById("activate-heading");
    const intro = document.getElementById("activate-intro");
    if (!running && heading && intro) {
      heading.textContent = "Activate Guard4AI";
      intro.textContent =
        "Guard4AI needs a key before it will mask anything. Enter your personal " +
        "licence key, or the invite code your workplace gave you \u2014 one field " +
        "takes either, and there is no account and no password to set up.";
    }
    if (!running) return;

    const kind = rec && rec.kind;
    const left = rec && typeof rec.hardStopAt === "number"
      ? Math.max(0, Math.ceil((rec.hardStopAt - Date.now()) / DAY_MS))
      : null;
    const stateEl = document.getElementById("activate-state");
    const detailEl = document.getElementById("activate-detail");
    if (!stateEl || !detailEl) return;

    if (kind === "company") {
      stateEl.textContent = "Connected to " + ((conn && conn.companyName) || "your company");
      detailEl.textContent =
        "Your masking activity is visible to your admin: counts and categories " +
        "only, never the values or your messages.";
    } else if (kind === "review") {
      stateEl.textContent = "Guard4AI is active (review build)";
      detailEl.textContent = "This key does not expire and reports nothing.";
    } else if (kind === "legacy") {
      stateEl.textContent = "Guard4AI now needs a licence";
      detailEl.textContent =
        `Still protecting you for ${left} more ${left === 1 ? "day" : "days"}. ` +
        "Enter a licence key or an invite code above to keep it on.";
    } else if (state === "warned") {
      stateEl.textContent = "Your licence has lapsed";
      detailEl.textContent =
        `Still protecting you for ${left} more ${left === 1 ? "day" : "days"}, ` +
        "so nothing stops mid-conversation. Renew or enter a new key above.";
    } else {
      stateEl.textContent = "Guard4AI is active";
      detailEl.textContent = "Personal licence. Nothing about your usage is reported to anyone.";
    }
  }

  /**
   * Show the seat id, or clear it. Called on every paint rather than only when
   * connecting, so deactivating takes the id off the screen instead of leaving
   * the last one sitting there.
   *
   * A personal licence has no seat id to show: recordEvents() only fires when
   * a company invite code has been redeemed, so an individual has nothing
   * filed against them and nothing to ask us about.
   */
  function paintSeat(conn) {
    const wrap = document.getElementById("company-seat");
    const idEl = document.getElementById("seat-id");
    if (!wrap || !idEl) return;

    const id = conn && typeof conn.employeeId === "string" ? conn.employeeId : "";
    idEl.textContent = id;
    wrap.classList.toggle("is-on", Boolean(id));
  }

  async function refreshActivation() {
    if (!companyEl) return;
    const res = await askWorker({ type: "GUARDAI_ENTITLEMENT_STATUS" });

    // Nothing to offer if this build has no backend configured: hide the whole
    // section rather than show a control that cannot work.
    if (!res || !res.available) {
      companyEl.style.display = "none";
      return;
    }
    const conn = await askWorker({ type: "GUARDAI_COMPANY_STATUS" });
    paintActivation(res.state, res.record, conn && conn.connection);
  }

  /**
   * Copy button and policy link for the seat id. Wired once at startup, not on
   * every paint, so repainting cannot stack duplicate listeners.
   */
  function wireSeatControls() {
    const copyBtn = document.getElementById("seat-copy");
    const idEl = document.getElementById("seat-id");
    if (copyBtn && idEl) {
      copyBtn.addEventListener("click", async () => {
        const id = idEl.textContent.trim();
        if (!id) return;
        try {
          await navigator.clipboard.writeText(id);
        } catch (_) {
          // Clipboard blocked: select the id instead so it can still be copied
          // by hand, rather than claiming a success that did not happen.
          const range = document.createRange();
          range.selectNodeContents(idEl);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          copyBtn.textContent = "Press \u2318C";
          setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
          return;
        }
        copyBtn.textContent = "Copied";
        copyBtn.classList.add("is-done");
        setTimeout(() => {
          copyBtn.textContent = "Copy";
          copyBtn.classList.remove("is-done");
        }, 1600);
      });
    }

    const policyLink = document.getElementById("seat-privacy");
    if (policyLink) {
      policyLink.addEventListener("click", (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: PRIVACY_URL });
      });
    }
  }

  async function initCompany() {
    if (!companyEl) return;
    await refreshActivation();

    wireSeatControls();

    const input = document.getElementById("company-code");
    const connectBtn = document.getElementById("company-connect");
    if (!input || !connectBtn) return;

    connectBtn.addEventListener("click", async () => {
      const code = input.value.trim();
      if (!code) return setCompanyMsg("Enter your licence key or invite code.", true);

      connectBtn.disabled = true;
      connectBtn.textContent = "Activating\u2026";
      setCompanyMsg("");

      const out = await askWorker({ type: "GUARDAI_ACTIVATE", code });
      connectBtn.disabled = false;
      connectBtn.textContent = "Activate";

      if (!out || !out.ok) {
        setCompanyMsg((out && out.error) || "Could not activate. Try again.", true);
        return;
      }
      input.value = "";
      setCompanyMsg("");
      await refreshActivation();
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") connectBtn.click();
    });

    document.getElementById("company-leave").addEventListener("click", async () => {
      await askWorker({ type: "GUARDAI_DEACTIVATE" });
      setCompanyMsg("");
      await refreshActivation();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.guardai_entitlement) refreshActivation();
    });
  }

  initCompany();

  (async function init() {
    let disabled = [];
    try {
      const data = await chrome.storage.local.get([STORAGE_KEY]);
      disabled = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
    } catch (_) {
      /* storage unavailable — render with everything on, the safe default */
    }
    await loadPolicy();
    render(new Set(disabled));
    await renderSwitches();
    await renderModes();
  })();

  // Live-refresh if the setting changes from elsewhere (e.g. this page open
  // in two tabs, or the array being reset some other way).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    // An admin switching the company between Flexible and Enforced, arriving
    // while this page is open. Re-rendering is the whole update: the switch
    // greys out or comes back, with no reload and nothing for the user to do.
    if (changes[POLICY_KEY]) {
      policy = changes[POLICY_KEY].newValue || null;
      renderSwitches();
      // One policy change can move many category switches at once, so the
      // whole list is repainted from what is currently stored.
      chrome.storage.local.get([STORAGE_KEY]).then((d) => {
        render(new Set(Array.isArray(d[STORAGE_KEY]) ? d[STORAGE_KEY] : []));
      }).catch(() => {});
    }
    if (!changes[STORAGE_KEY]) return;
    const newVal = changes[STORAGE_KEY].newValue;
    render(new Set(Array.isArray(newVal) ? newVal : []));
  });
})();
