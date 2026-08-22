/**
 * GuardAI — popup.js
 * ---------------------------------------------------------------------------
 * Privacy dashboard logic. Reads/writes chrome.storage.local only.
 * Shows session stats, computes a privacy score, and exposes the master
 * enable toggle, the masking toggle, and the "clear mapping table" action.
 * ---------------------------------------------------------------------------
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // The canonical policy lives on the site. The Web Store will not accept a
  // chrome-extension:// URL as a privacy policy, and a second copy shipped in
  // the extension would drift from it. settings.js holds the same constant.
  const PRIVACY_URL = "https://guard4ai.com/privacy";

  /* ---- Light / dark mode ---- */
  const THEME_KEY = "guardai_theme";
  function applyTheme(light) {
    document.body.classList.toggle("gd-light", light);
    const btn = $("theme-toggle");
    if (btn) btn.textContent = light ? "\u263D" : "\u2600"; // moon when light : sun when dark
  }
  // Load preference instantly to avoid flash.
  const savedTheme = localStorage.getItem(THEME_KEY);
  applyTheme(savedTheme === "light");

  const els = {
    enabled: $("toggle-enabled"),
    masking: $("toggle-masking"),
    autopanel: $("toggle-autopanel"),
    scoreValue: $("score-value"),
    scoreRing: $("score-ring"),
    scoreHint: $("score-hint"),
    detected: $("stat-detected"),
    masked: $("stat-masked"),
    sent: $("stat-sent"),
    platformList: $("platform-list"),
    swapList: $("swap-list"),
    mapCount: $("map-count"),
    clearMap: $("clear-map"),
    privacyLink: $("privacy-link"),
  };

  /* ---- Load everything from storage and paint the UI ---- */
  async function render() {
    let data;
    try {
      data = await chrome.storage.local.get([
        "guardai_enabled",
        "guardai_masking_enabled",
        "guardai_autopanel_enabled",
        "guardai_stats",
        "guardai_mapping",
      ]);
    } catch (err) {
      // Storage genuinely unavailable (rare, but the popup must still look
      // intentional rather than blank). Show an on-brand banner and stop.
      showStorageError();
      return;
    }
    clearStorageError();

    const enabled = data.guardai_enabled !== false;
    const masking = data.guardai_masking_enabled === true;
    const autopanel = data.guardai_autopanel_enabled === true; // default OFF
    const stats = data.guardai_stats || {
      detected: 0,
      masked: 0,
      sentUnmasked: 0,
      platforms: {},
    };
    const mapping = data.guardai_mapping || [];

    els.enabled.checked = enabled;
    els.masking.checked = masking;
    els.autopanel.checked = autopanel;
    document.body.classList.toggle("gd-disabled", !enabled);

    animateCount(els.detected, stats.detected || 0);
    animateCount(els.masked, stats.masked || 0);
    animateCount(els.sent, stats.sentUnmasked || 0);
    els.mapCount.textContent = mapping.length;

    renderPlatforms(stats.platforms || {});
    renderSwaps(mapping);
    renderScore(stats);
  }

  /** Set a stat's number, briefly pulsing the ring/highlight if it changed so
   *  the user feels the update land instead of it silently ticking over. */
  function animateCount(el, value) {
    if (!el) return;
    const prev = parseInt(el.textContent, 10);
    el.textContent = value;
    if (!Number.isNaN(prev) && prev !== value) {
      el.classList.remove("gd-bump");
      void el.offsetWidth; // restart the animation
      el.classList.add("gd-bump");
    }
  }

  let _storageErrorEl = null;
  function showStorageError() {
    if (_storageErrorEl) return;
    _storageErrorEl = document.createElement("div");
    _storageErrorEl.className = "gd-error-banner";
    _storageErrorEl.setAttribute("role", "alert");
    _storageErrorEl.innerHTML =
      "<strong>Storage unavailable.</strong> GuardAI can't read its saved data " +
      "right now. Your protection still works on the page — try reopening this " +
      "panel, or reload the extension if it persists.";
    document.body.insertBefore(_storageErrorEl, document.body.firstChild);
  }
  function clearStorageError() {
    if (_storageErrorEl) { _storageErrorEl.remove(); _storageErrorEl = null; }
  }

  /**
   * Show the most recent real -> fake swaps, newest first, derived straight
   * from the local mapping table. Passwords/secrets are never shown in clear.
   */
  function renderSwaps(mapping) {
    if (!mapping.length) {
      els.swapList.innerHTML = '<span class="gd-empty">No data masked yet.</span>';
      return;
    }
    const recent = [...mapping]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 12);

    els.swapList.innerHTML = recent
      .map((e) => {
        const real = e.type === "PASSWORD" ? "\u2022\u2022\u2022\u2022\u2022\u2022" : e.real;
        const type = (e.type || "").replace(/_/g, " ").toLowerCase();
        return (
          `<div class="gd-swap">` +
          `<span class="gd-swap__real" title="${escapeHtml(real)}">${escapeHtml(real)}</span>` +
          `<span class="gd-swap__arrow">&rarr;</span>` +
          `<span class="gd-swap__fake" title="${escapeHtml(e.fake)}">${escapeHtml(e.fake)}</span>` +
          `<span class="gd-swap__type">${escapeHtml(type)}</span>` +
          `</div>`
        );
      })
      .join("");
  }

  function renderPlatforms(platforms) {
    const names = Object.keys(platforms);
    if (!names.length) {
      els.platformList.innerHTML = '<span class="gd-empty">No AI platforms used yet.</span>';
      return;
    }
    els.platformList.innerHTML = names
      .map(
        (n) =>
          `<span class="gd-chip">${escapeHtml(n)}<span class="gd-chip__count">${platforms[n]}</span></span>`
      )
      .join("");
  }

  /**
   * Privacy score (0-100). Start at 100. Detecting data is fine; the risk is
   * sending it UNMASKED. Masking earns back protection.
   *   - each unmasked send: -12
   *   - masking ratio bonus: up to +0 (keeps you at 100 when you always mask)
   */
  function renderScore(stats) {
    const detected = stats.detected || 0;
    const masked = stats.masked || 0;
    const sent = stats.sentUnmasked || 0;

    let score = 100 - sent * 12;
    // If sensitive data was detected but little was masked, nudge down.
    if (detected > 0) {
      const maskRatio = masked / detected;
      if (maskRatio < 0.5) score -= Math.round((1 - maskRatio) * 10);
    }
    score = Math.max(0, Math.min(100, score));

    const prevScore = parseInt(els.scoreValue.textContent, 10);
    els.scoreValue.textContent = score;
    els.scoreRing.style.setProperty("--pct", score + "%");

    // Green when healthy, amber/red as exposure rises — the score is the
    // first thing a user should read, so it gets colour instead of staying
    // monochrome like the rest of the popup.
    let color = "var(--good)";
    let hint = "You're protected. Keep masking sensitive data.";
    if (score < 50) {
      color = "var(--danger)";
      hint = "High exposure — you've sent sensitive data unmasked. Turn on masking mode.";
    } else if (score < 80) {
      hint = "Some data was sent unmasked. Consider enabling masking mode.";
    } else if (detected === 0) {
      hint = "You're protected. Nothing risky sent yet.";
    }
    els.scoreRing.style.background = `radial-gradient(closest-side, var(--bg-card) 79%, transparent 80%), conic-gradient(${color} ${score}%, var(--track) 0)`;
    els.scoreHint.textContent = hint;

    // Pulse the ring when the score actually changes so protection feels live.
    if (!Number.isNaN(prevScore) && prevScore !== score) {
      els.scoreRing.classList.remove("gd-pulse");
      void els.scoreRing.offsetWidth;
      els.scoreRing.classList.add("gd-pulse");
    }
  }

  /* ---- Wire up controls ---- */
  $("theme-toggle").addEventListener("click", () => {
    const light = !document.body.classList.contains("gd-light");
    applyTheme(light);
    localStorage.setItem(THEME_KEY, light ? "light" : "dark");
    // Persist to chrome.storage.local so the content script can pick it up.
    try {
      chrome.storage.local.set({ [THEME_KEY]: light ? "light" : "dark" });
    } catch (_) { /* non-fatal if popup context lost */ }
  });

  els.enabled.addEventListener("change", async () => {
    await chrome.storage.local.set({ guardai_enabled: els.enabled.checked });
    document.body.classList.toggle("gd-disabled", !els.enabled.checked);
  });

  els.masking.addEventListener("change", async () => {
    await chrome.storage.local.set({ guardai_masking_enabled: els.masking.checked });
  });

  els.autopanel.addEventListener("change", async () => {
    await chrome.storage.local.set({ guardai_autopanel_enabled: els.autopanel.checked });
  });

  // Click-to-arm, click-again-to-confirm — NOT window.confirm(): Chrome
  // closes an extension's action popup the instant a native alert/confirm/
  // prompt would open inside it (there's nowhere for a blocking modal to
  // live in a transient bubble), so a real confirm() here would silently
  // eat the click instead of asking anything. This stays entirely inside
  // the popup's own UI instead.
  let clearArmed = false;
  let clearArmTimer = null;
  els.clearMap.addEventListener("click", async () => {
    if (!clearArmed) {
      clearArmed = true;
      els.clearMap.textContent = "Click again to confirm";
      els.clearMap.classList.add("gd-btn--armed");
      clearTimeout(clearArmTimer);
      clearArmTimer = setTimeout(() => {
        clearArmed = false;
        els.clearMap.textContent = "Clear all data";
        els.clearMap.classList.remove("gd-btn--armed");
      }, 4000);
      return;
    }
    clearTimeout(clearArmTimer);
    clearArmed = false;
    els.clearMap.classList.remove("gd-btn--armed");
    els.clearMap.textContent = "Clear all data"; // so flash()'s revert lands on the right label
    await chrome.storage.local.remove("guardai_mapping");
    await render();
    flash(els.clearMap, "Cleared");
  });

  els.privacyLink.addEventListener("click", (e) => {
    e.preventDefault();
    // The Web Store requires a publicly reachable policy URL; a
    // chrome-extension:// page does not qualify. The canonical copy lives on
    // the site and this links out to it rather than shipping a second one
    // that can drift.
    chrome.tabs.create({ url: PRIVACY_URL });
  });

  $("settings-btn").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
  });

  // Live-refresh if storage changes while the popup is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    render();
    if (changes.guardai_entitlement) renderLicence();
  });

  function flash(btn, text) {
    const original = btn.textContent;
    btn.textContent = text;
    setTimeout(() => (btn.textContent = original), 1200);
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ------------------------------------------------------------------ *
   * Licence card.
   *
   * The whole point of this card is that a locked GuardAI is never a dead
   * popup. Somebody who installs the extension, opens this, and finds a
   * disabled dashboard with no explanation has been given a broken product;
   * the code field is right here, so activation is one click from the place
   * they already are rather than a link to somewhere else.
   *
   * The same card handles "running out", because a second card with a second
   * code field would mean two places to type the same thing.
   * ------------------------------------------------------------------ */
  const DAY_MS = 86400000;

  function daysLeft(rec) {
    if (!rec || typeof rec.hardStopAt !== "number") return null;
    return Math.max(0, Math.ceil((rec.hardStopAt - Date.now()) / DAY_MS));
  }

  function setLockMsg(text, kind) {
    const el = $("lock-msg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "gd-lock__msg" + (text ? " is-on" : "") + (kind ? " is-" + kind : "");
  }

  /** Paint the card for one of the four states the worker reports. */
  function paintLicence(state, rec) {
    const card = $("lock-card");
    const score = $("score-card");
    if (!card) return;

    const showCard = state === "locked" || state === "warned";
    card.classList.toggle("is-on", showCard);
    card.classList.toggle("is-warning", state === "warned");
    // A privacy score is meaningless when nothing is being scanned, so the
    // locked card takes its place rather than sitting above a ring reading
    // 100 out of 100.
    if (score) score.style.display = state === "locked" ? "none" : "";
    if (!showCard) return;

    const left = daysLeft(rec);
    const plural = left === 1 ? "day" : "days";
    if (state === "locked") {
      $("lock-title").textContent = "GuardAI is not active";
      $("lock-body").textContent =
        "Nothing is being masked. Enter your licence key, or the invite code from your workplace.";
    } else if (rec && rec.kind === "legacy") {
      $("lock-title").textContent = "GuardAI now needs a licence";
      $("lock-body").textContent =
        `Still protecting you for ${left} more ${plural}. Enter a licence key or an invite code to keep it on.`;
    } else {
      $("lock-title").textContent = "Your licence has lapsed";
      $("lock-body").textContent =
        `Still protecting you for ${left} more ${plural}, so nothing stops mid-conversation. Renew or enter a new key.`;
    }
  }

  /**
   * Fallback for when the worker cannot be reached at all.
   *
   * Without this, a dead worker leaves a locked install showing a normal
   * dashboard with a privacy score on it — the dead popup this card exists to
   * prevent, arriving by a different route. It deliberately does NOT
   * re-implement the state machine: the ABSENCE of a record is the one thing
   * that can be read straight off storage and cannot be misinterpreted. If a
   * record exists but we cannot ask what it means, say nothing.
   */
  function renderLicenceFromStorage() {
    chrome.storage.local.get(["guardai_entitlement"]).then((d) => {
      if (!d || !d.guardai_entitlement) paintLicence("locked", null);
    }).catch(() => { /* storage gone too — nothing sensible left to say */ });
  }

  function renderLicence() {
    try {
      chrome.runtime.sendMessage({ type: "GUARDAI_ENTITLEMENT_STATUS" }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) return renderLicenceFromStorage();
        paintLicence(res.state, res.record);
      });
    } catch (_) {
      renderLicenceFromStorage();
    }
  }

  {
    const btn = $("lock-activate");
    const input = $("lock-code");
    if (btn && input) {
      const activate = () => {
        const code = input.value.trim();
        if (!code) return setLockMsg("Enter your licence key or invite code.", "bad");
        btn.disabled = true;
        btn.textContent = "\u2026";
        setLockMsg("");
        try {
          chrome.runtime.sendMessage({ type: "GUARDAI_ACTIVATE", code }, (res) => {
            btn.disabled = false;
            btn.textContent = "Activate";
            if (chrome.runtime.lastError || !res) {
              return setLockMsg("Could not reach GuardAI. Check your connection and try again.", "bad");
            }
            if (!res.ok) return setLockMsg(res.error || "Could not activate. Try again.", "bad");
            input.value = "";
            setLockMsg("GuardAI is on. Open tabs are protected straight away.", "good");
            paintLicence(res.state, res.record);
            render();
            renderCompanyBanner();
          });
        } catch (_) {
          btn.disabled = false;
          btn.textContent = "Activate";
          setLockMsg("Could not reach GuardAI. Try again.", "bad");
        }
      };
      btn.addEventListener("click", activate);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") activate(); });
    }
  }

  /* Company connection banner. Asks the worker rather than reading storage
     directly, so "connected" means one thing in one place. */
  function renderCompanyBanner() {
    const banner = $("company-banner");
    if (!banner) return;
    try {
      chrome.runtime.sendMessage({ type: "GUARDAI_COMPANY_STATUS" }, (res) => {
        if (chrome.runtime.lastError) return;
        const conn = res && res.connection;
        banner.classList.toggle("is-on", Boolean(conn));
        if (conn) $("company-name").textContent = conn.companyName;
      });
    } catch (_) {
      /* worker asleep — the banner simply stays hidden this time */
    }
  }

  render();
  renderCompanyBanner();
  renderLicence();
})();
