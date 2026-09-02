/**
 * Guard4AI — popup.js
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

  /** The stored values the segmented control may hold. */
  const BADGE_MODES = ["always", "masking", "off"];

  const els = {
    enabled: $("toggle-enabled"),
    masking: $("toggle-masking"),
    autopanel: $("toggle-autopanel"),
    badgeBtns: Array.from(document.querySelectorAll(".gd-seg__btn")),
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

  /** Mirrors isLocked() in src/policy.js — see the note on the copy in
   *  src/content.js. Held to it by test/policy.cjs. */
  function lockedBy(pol, name) {
    if (!pol || typeof pol !== "object") return false;
    if (pol.mode !== "enforced") return false;
    if (!pol.locks || typeof pol.locks !== "object") return false;
    return pol.locks[name] === true;
  }

  /**
   * Show or clear the pinned-master-switch state.
   *
   * The switch is disabled, not hidden, and it stays checked because it is
   * genuinely on. The banner names the company where we know it, because
   * someone subject to a rule is entitled to know whose rule it is.
   */
  function paintPolicyLock(lockedOn, lockedMasking, policy) {
    const sw = els.enabled;
    if (sw) {
      sw.disabled = lockedOn;
      const label = sw.closest(".gd-switch");
      if (label) {
        label.title = lockedOn
          ? "Turned on by your organisation"
          : "Enable or disable Guard4AI";
      }
    }
    if (els.masking) {
      els.masking.disabled = lockedMasking;
      const row = els.masking.closest(".gd-row") || els.masking.closest("label");
      if (row) row.title = lockedMasking ? "Turned on by your organisation" : "";
    }
    const banner = $("policy-banner");
    if (!banner) return;
    // The banner appears for any lock, not only the two switches on this
    // screen: someone whose categories are pinned in Settings deserves the
    // same explanation as someone whose on/off switch is.
    //
    // The wording names no specific setting on purpose. It used to promise
    // that Guard4AI "can't be switched off" and that "files and images are
    // always checked", which was true when Enforced meant a fixed trio and is
    // now simply wrong: an admin can pin any one setting on its own.
    const any = lockedOn || lockedMasking ||
      Boolean(policy && policy.mode === "enforced" && policy.locks &&
              Object.keys(policy.locks).length);
    showOnce(banner, "policy", any, lockFingerprint(policy));
  }

  /* ------------------------------------------------------------------ *
   * Banners that say their piece once.
   *
   * Both of these state a standing fact — your admin can see counts; some
   * settings are pinned — and neither is an alert. Repeating them on every
   * popup open turns the top of the screen into furniture the user learns to
   * look past, which is a cost paid by the messages that DO need reading.
   * Settings keeps both facts permanently: the activation card names the
   * company, and every pinned control carries its own "Locked by admin" row.
   *
   * "Once" is keyed to WHAT WAS SAID, not to a boolean. If the admin later
   * pins another setting, or the seat is moved to a different company, that
   * is a new fact and it gets one more showing. A plain "dismissed forever"
   * flag would mean someone is never told about a restriction that did not
   * exist when they last looked — which is the one outcome this banner
   * exists to prevent.
   * ------------------------------------------------------------------ */

  const SEEN_KEY = "guardai_notices_seen";

  /** Identify a policy by the locks it names, order-independent. */
  function lockFingerprint(policy) {
    if (!policy || policy.mode !== "enforced" || !policy.locks) return "none";
    const on = Object.keys(policy.locks).filter((k) => policy.locks[k] === true).sort();
    return on.length ? "enforced:" + on.join(",") : "none";
  }

  /**
   * Show `banner` only if this exact `fingerprint` has not been shown before,
   * then remember it. Storage failures fail OPEN — the banner shows — because
   * showing a standing notice twice is a smaller harm than never showing it.
   */
  /**
   * Serialised, because both banners record into the SAME storage key and
   * they are painted from two different places (the policy one during
   * render(), the company one when the worker answers). Run concurrently,
   * each reads the record before the other writes, and the second write
   * drops the first one's entry — so whichever banner lost the race would
   * reappear on every open forever. Caught by test/popup-notice-once.cjs §1,
   * which is the only section where both banners are live at once.
   */
  let seenChain = Promise.resolve();

  function showOnce(banner, name, shouldShow, fingerprint) {
    if (!banner) return seenChain;
    if (!shouldShow) { banner.classList.remove("is-on"); return seenChain; }
    seenChain = seenChain.then(async () => {
      try {
        const data = await chrome.storage.local.get([SEEN_KEY]);
        const seen = (data && data[SEEN_KEY]) || {};
        if (seen[name] === fingerprint) return;      // already said, unchanged
        banner.classList.add("is-on");
        await chrome.storage.local.set({
          [SEEN_KEY]: Object.assign({}, seen, { [name]: fingerprint }),
        });
      } catch (_) {
        // Could not read or record it — show it. Twice is a smaller harm
        // than never.
        banner.classList.add("is-on");
      }
    });
    return seenChain;
  }

  /* ---- Load everything from storage and paint the UI ---- */
  async function render() {
    let data;
    try {
      data = await chrome.storage.local.get([
        "guardai_enabled",
        "guardai_masking_enabled",
        "guardai_autopanel_enabled",
        "guardai_badge_mode",
        "guardai_stats",
        "guardai_mapping",
        "guardai_policy",
      ]);
    } catch (err) {
      // Storage genuinely unavailable (rare, but the popup must still look
      // intentional rather than blank). Show an on-brand banner and stop.
      showStorageError();
      return;
    }
    clearStorageError();

    // The master switch, through the company policy. This is the one an
    // enforced user would reach for first: pinning file and image scanning
    // while leaving this free would be a control with a one-click bypass
    // sitting next to it.
    const policy = data.guardai_policy || null;
    const lockedOn = lockedBy(policy, "enabled");
    const lockedMasking = lockedBy(policy, "masking");
    const enabled = lockedOn ? true : data.guardai_enabled !== false;
    const masking = lockedMasking ? true : data.guardai_masking_enabled !== false; // default ON
    const autopanel = data.guardai_autopanel_enabled === true; // default OFF
    // Three-state, so a missing or unrecognised value falls back to the
    // default rather than to one of the extremes. An unknown string must not
    // read as "off" — that would silently hide the badge on a storage
    // glitch, and a control that disappears is worse than one that stays.
    const badgeMode = BADGE_MODES.includes(data.guardai_badge_mode)
      ? data.guardai_badge_mode : "masking";
    paintPolicyLock(lockedOn, lockedMasking, policy);
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
    for (const b of els.badgeBtns) {
      b.setAttribute("aria-checked", String(b.dataset.badge === badgeMode));
    }
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
      "<strong>Storage unavailable.</strong> Guard4AI can't read its saved data " +
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
    // Belt to the disabled attribute's braces. A disabled input does not fire
    // change, so this is unreachable through the UI — it is here so that the
    // ONE line that could write false to the master switch is guarded, rather
    // than relying on a DOM attribute somewhere else having been set.
    if (els.enabled.disabled) { els.enabled.checked = true; return; }
    await chrome.storage.local.set({ guardai_enabled: els.enabled.checked });
    document.body.classList.toggle("gd-disabled", !els.enabled.checked);
  });

  els.masking.addEventListener("change", async () => {
    // Same guard as the master switch: the one line that could write false to
    // a pinned setting refuses, rather than relying on a DOM attribute set
    // somewhere else.
    if (els.masking.disabled) { els.masking.checked = true; return; }
    await chrome.storage.local.set({ guardai_masking_enabled: els.masking.checked });
  });

  els.autopanel.addEventListener("change", async () => {
    await chrome.storage.local.set({ guardai_autopanel_enabled: els.autopanel.checked });
  });

  // Segmented control. aria-checked is repainted from STORAGE by render()
  // rather than optimistically here, so what the control shows is always what
  // was actually stored — a failed write leaves the old selection visible
  // instead of a lie.
  for (const btn of els.badgeBtns) {
    btn.addEventListener("click", async () => {
      const mode = btn.dataset.badge;
      if (!BADGE_MODES.includes(mode)) return;
      try {
        await chrome.storage.local.set({ guardai_badge_mode: mode });
      } catch (_) { return; }
      await render();
    });
  }

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
   * The whole point of this card is that a locked Guard4AI is never a dead
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
      $("lock-title").textContent = "Guard4AI is not active";
      $("lock-body").textContent =
        "Nothing is being masked. Enter your licence key, or the invite code from your workplace.";
    } else if (rec && rec.kind === "legacy") {
      $("lock-title").textContent = "Guard4AI now needs a licence";
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
              return setLockMsg("Could not reach Guard4AI. Check your connection and try again.", "bad");
            }
            if (!res.ok) return setLockMsg(res.error || "Could not activate. Try again.", "bad");
            input.value = "";
            setLockMsg("Guard4AI is on. Open tabs are protected straight away.", "good");
            paintLicence(res.state, res.record);
            render();
            renderCompanyBanner();
          });
        } catch (_) {
          btn.disabled = false;
          btn.textContent = "Activate";
          setLockMsg("Could not reach Guard4AI. Try again.", "bad");
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
        // Name it before deciding to show it: the fingerprint is the company,
        // so being moved to a different company says its piece again.
        if (conn) $("company-name").textContent = conn.companyName;
        showOnce(banner, "company", Boolean(conn), conn ? String(conn.companyName || "?") : "none");
      });
    } catch (_) {
      /* worker asleep — the banner simply stays hidden this time */
    }
  }

  render();
  renderCompanyBanner();
  renderLicence();
})();
