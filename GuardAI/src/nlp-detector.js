/**
 * GuardAI — nlp-detector.js
 * ---------------------------------------------------------------------------
 * OPTIONAL context-aware detection layer using Transformers.js (local NER).
 *
 * WHY THIS IS OPTIONAL & SELF-HOSTED
 * ----------------------------------
 * GuardAI guarantees that *nothing leaves your device*. A Transformers.js
 * model is several megabytes, so to honour that promise the model files must
 * be BUNDLED INSIDE THE EXTENSION and served locally — never fetched from a
 * CDN at runtime (that would be an external network call).
 *
 * Because those model weights are large, they are NOT shipped in this repo by
 * default. The pattern engine in detector.js works on its own. This file is a
 * fully-wired drop-in upgrade: if you add the library + model locally it will
 * automatically enhance detection with contextual Named Entity Recognition
 * (people, organisations, locations) that pure regex can't catch. If the files
 * are absent, it silently disables itself and GuardAI keeps working on
 * patterns alone.
 *
 * TO ENABLE (see README for full steps):
 *   1. Download Transformers.js (transformers.min.js) into  GuardAI/lib/
 *   2. Download a small ONNX NER model (e.g. Xenova/bert-base-NER quantized)
 *      into  GuardAI/models/bert-base-NER/
 *   3. Set ENABLE_NLP below to true.
 *
 * Everything still runs 100% locally — the env config below explicitly
 * disables remote model fetching so it can NEVER phone home.
 * ---------------------------------------------------------------------------
 */
(function () {
  "use strict";

  // Flip to true only after you have bundled the library + model locally.
  const ENABLE_NLP = false;

  // Local paths (resolved inside the packed extension).
  const LIB_PATH = "lib/transformers.min.js";
  const MODEL_NAME = "bert-base-NER";

  /**
   * Maps NER entity groups to GuardAI finding types.
   * PER = person, ORG = organisation, LOC = location/address.
   */
  const ENTITY_MAP = {
    PER: { type: "NAME_PII", label: "Person name (NLP)", severity: "medium" },
    ORG: { type: "BUSINESS_CONFIDENTIAL", label: "Organisation (NLP)", severity: "low" },
    LOC: { type: "ADDRESS", label: "Location (NLP)", severity: "medium" },
  };

  class NlpDetector {
    constructor() {
      this.ready = false;
      this.available = false;
      this._pipeline = null;
      this._initPromise = null;
    }

    /** Is the optional NLP layer actually usable in this install? */
    isAvailable() {
      return ENABLE_NLP === true;
    }

    /**
     * Lazily load Transformers.js + the local model. Safe to call repeatedly.
     * Returns true when ready, false if NLP is disabled or files are missing.
     */
    async init() {
      if (!ENABLE_NLP) return false;
      if (this.ready) return true;
      if (this._initPromise) return this._initPromise;

      this._initPromise = (async () => {
        try {
          const libURL = chrome.runtime.getURL(LIB_PATH);
          // Dynamic import of the locally-bundled ES module.
          const transformers = await import(libURL);
          const { pipeline, env } = transformers;

          // HARD LOCK to local-only: forbid any remote model fetching.
          env.allowRemoteModels = false;
          env.allowLocalModels = true;
          env.localModelPath = chrome.runtime.getURL("models/");
          if (env.backends?.onnx?.wasm) {
            env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("lib/");
          }

          this._pipeline = await pipeline("token-classification", MODEL_NAME, {
            quantized: true,
          });

          this.ready = true;
          this.available = true;
          return true;
        } catch (err) {
          // Library/model not present — degrade silently to patterns only.
          console.info("[GuardAI] NLP layer unavailable, using pattern engine.", err?.message);
          this.available = false;
          return false;
        }
      })();

      return this._initPromise;
    }

    /**
     * Run NER over text and return GuardAI-shaped findings.
     * Returns [] if NLP is disabled/unavailable so callers can always await it.
     */
    async scan(text) {
      if (!ENABLE_NLP || !text) return [];
      const ok = await this.init();
      if (!ok || !this._pipeline) return [];

      let entities;
      try {
        entities = await this._pipeline(text, { aggregation_strategy: "simple" });
      } catch (err) {
        console.info("[GuardAI] NLP inference failed, skipping.", err?.message);
        return [];
      }

      const out = [];
      for (const e of entities || []) {
        const group = (e.entity_group || e.entity || "").replace(/^[BI]-/, "");
        const map = ENTITY_MAP[group];
        if (!map) continue;
        // Confidence gate to keep noise down.
        if (typeof e.score === "number" && e.score < 0.6) continue;

        out.push({
          type: map.type,
          label: map.label,
          value: (e.word || "").replace(/^##/, "").trim(),
          index: typeof e.start === "number" ? e.start : text.indexOf(e.word),
          severity: map.severity,
          reason: (window.GuardAI && window.GuardAI.REASONS[map.type]) || "",
          source: "nlp",
        });
      }
      return out;
    }
  }

  window.GuardAI = window.GuardAI || {};
  window.GuardAI.NlpDetector = NlpDetector;
})();
