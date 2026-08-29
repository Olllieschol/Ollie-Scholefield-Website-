/**
 * GuardAI — the one language feature the PDF reader needs and older Chrome
 * does not have.
 *
 * pdf.js 6.2 calls Uint8Array.prototype.toHex(), a 2025 addition that Chrome
 * shipped in 140. Without it getDocument() fails with "n.toHex is not a
 * function" and every PDF looks unreadable — which is a safe failure, but a
 * useless one, and it would be invisible until somebody attached a PDF.
 *
 * A four-line polyfill is a better answer than a minimum_chrome_version that
 * refuses to install for everybody else, so this loads as a classic script in
 * parser.html BEFORE the module that imports pdf.js. Module scripts are
 * deferred, so putting it there is what makes it run first; putting it inside
 * src/parser.js would not, because imports are evaluated before the body.
 *
 * Native implementations are left alone.
 */
(function () {
  "use strict";
  /**
   * Map upsert — Chrome 145, January 2026.
   *
   * pdf.js 6.2 calls Map.prototype.getOrInsertComputed on its RENDER path,
   * which the text path never touches. It only started mattering when
   * scanned PDFs began being rasterised for OCR, and it bites HARDER than
   * toHex below: that one needs Chrome 140, this one needs 145, so a browser
   * new enough to read a PDF's text can still be too old to rasterise one.
   * Without this, a scanned PDF on Chrome 140-144 throws inside render() and
   * the user gets "could not read" on a file GuardAI can in fact read.
   */
  if (typeof Map.prototype.getOrInsertComputed !== "function") {
    Object.defineProperty(Map.prototype, "getOrInsertComputed", {
      configurable: true,
      writable: true,
      value: function getOrInsertComputed(key, callback) {
        if (!this.has(key)) this.set(key, callback(key));
        return this.get(key);
      },
    });
  }
  if (typeof Map.prototype.getOrInsert !== "function") {
    Object.defineProperty(Map.prototype, "getOrInsert", {
      configurable: true,
      writable: true,
      value: function getOrInsert(key, value) {
        if (!this.has(key)) this.set(key, value);
        return this.get(key);
      },
    });
  }

  const HEX = "0123456789abcdef";

  if (typeof Uint8Array.prototype.toHex !== "function") {
    Object.defineProperty(Uint8Array.prototype, "toHex", {
      configurable: true,
      writable: true,
      value: function toHex() {
        let out = "";
        for (let i = 0; i < this.length; i++) {
          out += HEX[this[i] >> 4] + HEX[this[i] & 15];
        }
        return out;
      },
    });
  }

  if (typeof Uint8Array.fromHex !== "function") {
    Object.defineProperty(Uint8Array, "fromHex", {
      configurable: true,
      writable: true,
      value: function fromHex(str) {
        if (typeof str !== "string" || str.length % 2) throw new SyntaxError("invalid hex");
        const out = new Uint8Array(str.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(str.substr(i * 2, 2), 16);
        return out;
      },
    });
  }
})();
