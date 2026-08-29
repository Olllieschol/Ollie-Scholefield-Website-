/**
 * GuardAI — content.js
 * ---------------------------------------------------------------------------
 * The orchestrator injected into supported AI chat sites. It ties together:
 *   - detector.js      (find sensitive data)
 *   - nlp-detector.js  (optional contextual NER)
 *   - masker.js        (swap real <-> fake)
 *
 * Responsibilities
 *   1. Locate the chat input field (textarea or contenteditable).
 *   2. Intercept the "send" action (Enter key / send button) in capture phase.
 *   3. If masking is OFF and sensitive data is found -> show a non-blocking
 *      warning popup (Mask & Send / Mask & Edit / Manual mask / Send anyway).
 *   4. If masking is ON -> replace real data with fakes in-place, then send.
 *   5. Watch the conversation for AI responses and swap fakes back to real
 *      data so the user only ever reads their real information.
 *
 * Everything is local. No network calls are made from this script.
 * ---------------------------------------------------------------------------
 */
(function () {
  "use strict";

  const { Detector, NlpDetector, Masker } = window.GuardAI;

  // Crisp brand mark used in every GuardAI surface's header (warning card,
  // review panel, collapsed badge) in place of the old colour shield emoji.
  // This is the actual brand mark (green shield + black
  // "G", same artwork as icons/icon{16,48,128}.png) rather than a generic
  // line-art glyph, so it's an <img> on a small embedded data URI instead of
  // an inline currentColor SVG — the brand mark has fixed colours, it
  // doesn't need to inherit surrounding text colour the way the old
  // placeholder did. Still sized to 1em by the `__shield` CSS via the same
  // `guardai-shield-svg` class, so no CSS changes were needed to swap it in.
  const SHIELD_SVG =
    '<img class="guardai-shield-svg" width="1em" height="1em" alt="" ' +
    'src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAASf0lEQVR4nOVba4wk11X+7q1b1dXd0z3vnfW+vI/sJvbaMSY2jnaxoxBihSSQCAslFkIWiACRgIBIfiARRQH+GviHAMWRkEgclCgBC8eYmBATPzZ4kzjxetf79s7Ozuw8unv6WY/7QOdWVXdN7zqesWfWiNyZnpmuvnXveZ/vnFsDvJWDMYDhp3Cw13n//3qwhFuvWOCVd2w/WhwfKQ0+ewvIwQ3biQHG2D9LM6OT/NDEv0qfHxEKNXapdX/r7OLxPkXJtBtDFm7EDilDwhXw3zb9S3pn+XGpJExPdpnnlLgv4Nbjh+OzK58N6p3e8H1bTd6Wa5xGccfYDmff2N/LkvMhFcTaBEoXdoyIeDnQRmnJR1zPkabNF3oPhq/WH497ob4RgmCbv9paxgvTlXFx8+hn9HjhT5VSMG0ZGM78qV/cjeq9u7D6whKa37kEWQ8jVhIe8zhET/8QVzq/E801XojD2LzW2ptG8mYEtTxhjuPA21aZ4Tsrv6/HvD9TRkP3pDShQmnfqJj+lf0oH55EuBRB9jR0J0LzuTm0X7yqTawjVhQ+dx04gX4e8+0/ia80j0XdUA32zH6YN20dbMOMJtxed+NCpeiKmcqdmCl/WpedX1Naw/RirXtKutNFb/IXdmPsyA4w14GOFFRHI2zE4J5jrwWv1tF6fg698w0NA8mKjkfXeWgu8FrwOX21/Vhc6zaklNfhIkffBqyE4U0M13Uhqn7JGS/dijH/Y7oqflu7bEzHKtF4pLU7WfBG330TJo7ugJgsQnUljNbgwoFsK8SrMcA5jDZgBQfMGPQuNNA6Po/wYlMbSRbh+Mxz4BgG3lOPs3rvC7oePiNXe0thJ0hixRscbL0T/fGRIi+6Ve6JMV5y95uSc7cuee+Dz+9TzEBLBTJxHaiAOUwUdpRF5a5tqL5rBu5k0X5mlAHjyZaMA7KlETclkF7LDIsXHCuk8OIquQWCCw2tOnEEj3vMczh3OexXaOZ4Tz2JIH4WgTppQrmgu/FKd2m1sTkCYEnQKW4f3e7cPjMvjbLEGmasxozUMJECQh0Q3WKiIEqHxnnljmmU3j4GXnShQ2nnMc5TL2LJppwhbinIprJCyRutMaRUBu5xS2G81EX3zAp6p+uIFztSh0pCMMFcRzCX27U4TdSA4zrAiZUDndmV88OZ6HpDrEdKuijeprQEQtnU0niQmsyWc59zd6ooinurfunt4ygdGLPapk1VQD4eW+a441j1GmLexq4cYTynBkNzBvFGk9UwWNcZ3bYHo3fvQrTQEb3zNRHMNhEv97TuxtLEWhuHg7k80NDVYqVwK4Dz6+FNrGeSUSZijGmj4RX3VvziwVF40yX4N43AnS6Cl5NlTGQs08QQIyYc0ja7xtgsm/S2b/mDoLom7VvXMDCxhomNXbOws4LCnlHrcqoZ8mi548XLXQQXVxG+2gTnjMMgXA9f6xaAVRwDJ62O37sTY+/ZCdWOLaVaaRvYLE+cgTlr02Kq93SZ3JIsuWr6Jjokqn7eT+JFdjcFWOt2ZBnVAsRYEfxnBNrfv4LgbB1gbibeTRRANoieWFstE9NcJH5tfZh27Zvy4Hc+exLTViD5izR3EAOzbfqDp3PzVmFXIaORpAEJzSgW6f5eG0ltYgNzMy6SgOZQgBrsOOBpTTgb6D+dwAwJKzF5ozSgMwmYfjbIySSNCUMxok+LgSEy6D5778azulgnz2uYeu2t1kZclp9JWYM+dhlYQYDRb062TaCGgZEwImOFYi3EWn+Kgq0lkd4T7dudEu/ob5nINHO7TRZAfhAx14lrfbUNPDnHO+V/3wEKDtRKD/GPVqAvtxEvBVDSwBkrwNkxArGrCqfq2dQJMmkSkJXhtRXR4Mq1PrRWYZuRBUy2RSLjJHCl+sj8PJfZMiHQPNIURl1EZ1fR/ZeLCL47D7XYA2Kd3ECmS9+E9GbKcO/aBv99e+DsqgCUUWiBLHUOpYrkcnZ9EPq2zgJMFt0Tp8/+vB4kJ6CkHQbjMLS/cBLtL52FaYaALxJrKDpD6wJyoY34q6sInppF6YFDKH54nxUUozKIZ0IYZA7rFobKhjTtpvRtQRA0OS6TnDhITynXmTRSXzSCQyuF+uePI/iPWfCqBzZWAKOgZ6flqrlUi1T4UHxApND+hxchL66i8tBh6zpDsXVAQ5/5/psNVcx8fdPYkH9ZFtPAMxCQyb840Pjz4wi/NQs+6SfEqdSFugq6EUCthtCtKLEMqnZpDhVFDgcf99F74izC4wtgRWEtKk/OWv1kCBIbHmLdM1P7tn492HmwK3lFCoxQ9dD82xMIvnXZMk+1gK0hCMBIDe+2SRTvnAImfciuhp7vIPrBEtSlFljZtWohAZU/fgv89+yCJqBFAGsoxgz2T6zSXk8UtDVAyNi9qOwYQNw1iYD8ryQQnKih/egZ8DHPap00qrsxnG1FjH/qDvhHtkOUXFsMRWkxpFohek+cR++rZ6FWQhQfOICRh26z1tIPuEPhzfRrCrLG5JWagtl0KIzr9fJz+aZPgMPQefQsTCCB0YKt0HSgIG4qYfqvj8LdOwq1GkFGoe0HqLYm/G5TXvnBW8GnipCvNFD9rXdC91SyJvGT2XgfYudpyQJgBgjMJgMhky/Ssp1SxjMrIDoLDqKLLYTHroKXXKv97MOJT98JcXMV8UoP1O6iktqaNb0yvFAP4B/ZBXbfHiu0hPm8pQ9sINNxAobWFlcbAQJ8PZPWJU+iwXcQfn8JuhGBiQTE6I5E4a5peD+3DaoRUsnaX9HSTPGBApzWCf3UVGnFMFIl10mIOi/3ARawQswyyfUKic2MAWZNG/BavJ/MYYheqvXhqk1JSqN4dHuaxxNVJj8JvycgabinlxbBCW9p2mUdaqwkHaW1skhjUX+NjXWOxbpnphsmaw+VfSmiI7/Xc12AtJxmC7IKd38VoMrNVnJJNKW2V3BuFa1/uwin6KSlcV4AWCNE/77dcGdGYOI0XfahYN78N46FxXonZjEv3wUfxNrUj8l8Cb5mlRmZdcEBp2CYAR56Ua73HMi5FoJ/PgXH92y/MCfnQYxlDCqM4d0yBeyswERDDeB+X2HdPL8xAeRHkm6Gi9bUNIm5tO5POpzUQ0xTZDo1qycoHvCSDzYiLEJMgl5mJcnKJATuJY0WWxXmdsz80vzEknyzXQCDN7kjm3497xQcaBJCVrJSX68jrzVLupniXCBtaZz0BdLRr+9T7EF1Rb7L0ofc6ZU8OMvacZuZBYRjm3up+V4LD+x25JpFAYwXEuRHmqSmSaAg5zqAYAmczWEUOgZzJgvgEwWwiQL4eAFs3AMog9DcLMj3s2E+92VunwIh6lBnRVUsu5uLA7RpZeUwaWzYwDJzpNRHAS98Zn4QjA0QHLuK0gd29yczqm2CGIVbJjDxN++1RVXfpAE0/uIY9GwbINPPtwNyfYisFKcPCJtaK8vkE6naplqADmU9mx9TLu8zPmR62qBw5xSYIA4pfxM0dhA8PQ95ugVeEklez/IYaZoAU8kFK7pgIwUw3wUny0ldop8ZhpstOWMgF5BUUHHGOS0fyJXNFUAgG0xTG5aJaLE3MPGM97QxqnsShdsnIfaULZKzI60Dag//IGltk5vYZia5jbaAh1KbNWH6u5h1gYb6xP3kbxFQ/zr5O3WcZCMgVCmYgtRB3FhvMOQ/8dNU/Lob9ViszzCX82ihq1Vb2qicmWB/H6khxn2UPngzPfyQtMi1AR9xEb+4jOXPPAt5tZf4PDVEBLdlM+EGRmcLVEg9eQnqSgcguLwmx+ebIbl2Mwme4sxKIJlgnMXqRdWNwvUmA/H6U4A4jIzXjb/JKuKgrAUynGt55Vsm7OmP3SeFAdYKOjHKH9mH7hOXoF5t2+qQGiOs4iI8vojF3/0vjHxoL/yjMzAjBeiusgBKnm8hevoy4h8uA3QkliJmi/zIOtK6ImuY9k1CMMRzHahWpKnLxOrxN2Q8dHr8pgTAkmjGVqOv8THvD2OpdedUAyO3TSYBPTvYzDozZAUVzxY/i3/0XSBWSV1AMLbswrRjrH7xJJpULldd6yKGTozbUeJWFBPobJD4pa5SO7LNEbGtlLTH1nSTCBpzeyJkYqWdsoCpB4/l6d6kjhAglzovcA3NCtzrnKxBteLBKVAefVJEb8fwf3Yak5+9y+J3Wxq7aRoUzHaBCQTpdgzTCK3QSDhkLRmsttbUCCH2VTH2uXdD3FS2hzJDJy1QoURwrk5W4zkKXbnSfXkjYIi/7oxUimGj03U68isUycP5TtQ5VQen5mYKetbkKMGgmxHK9+/G9MNH4MwUoWsRmD0eT4Mc/aKTJS+JBYNeo7ECpHRb/OA+jH/+5yF2VpP0a9PloAFCMJu0Hy90InrQirXkF8NmN94A/1gfZEoJG9k//U51oPqibIZB8eC4v+eTt0Pbo+81OHSQopQBr7gUoND68hl0n7wEvRQkKY5SHWmalk7LYbvViAf38KRlvnDHjAVS9gQpdz5oj+dJMS7H0ldOIjhXi5xqwXNONQ50Lq3vWHxjAkiHW/CYf8/ul0OhDumO0jt/81ZRfdc2qC65Qx/NpHVB6qkUvKjbWxJQC13bL4h+vIzochu6JRMLKgo40yWI/aNwb52C2F21+1FsSISbVV9ZJtC2U9w9U8Py105J5nHuxuzZ8NjsvRsJgBsTQCrVysGZe+K9I8+rdhT4Oyr+nk/dkWQBW7tf/1arLXJfzwEviqRYkgpxI4ZsaguJrUXQ9Sh50iQrpPIHnvlqgC5c/dIJRHPNwKl4vjjTPNy+sPTyRrS/oSCYLdq7uHJMdM3T9Ehb71JTrjw1C6c01LZOR1aU2IYGBUypoVdDKAItoQJTSW1hQvJ7CUOBlSJ9VgxlfcY881RiFx20ji8gurwqWUn4bls/FszWkuC3wbqYb2g2Y1RoQJ+vf0xwh3PfkbWnZtF9pQFBETwNiLZIypjPveyPtA+YhrIcJamQ+l3na4fJ+o6zLaw+O0sHKdLhHPJs7SFJLbSNHAq+IQGYxA+78/UFZ6H3SeYLHxrBwqOnIZsx6OGl/mlNv0eXBsistTUIZbmyLl8lDgCPfeAid4dNjaFC7Ylz5CYBaV/M9x7sLa7WN2r6b0wAeVd4ZfHvRM98m5UcP1roRlf+6VTavUhx+5q+Fo3MmVPr6L8GhU5mPdY2UoH0hUBycTnq/34B0Xybnir13bb6Ru+VxUffTEuIv6G7yJ2j2MiXrn5YaNbgI4J3Xq7JhS+dtk+NWDB0HXryxU3/yyo/hyGy37mWH7VDKFPUnrqIzolFycpCCGXm4x9f/fhGo/7mCMAkmiRwpE+u3C6EELws9Or3FvTCl08nACfXBR7odSjtXEdIWSbtmz59+w4a334VrWNzmvmOFtyBebl2R9jshf1DkRsqgFw86M03LuN0/TbuOB4vC9l4bl5feeTl5Jk9OtUl9JdLZX3fyDo51twH1pE0QAg2JwGThFl74jwFPWJeOq7wzMmVQ72rq0tv1O/zg72pu+0KCRHlvVO349D4j6Skaknq4s2jYsdvvAOFHeXk0bl+0ZT6NmOI29KeDybPEeb6fBYcOYhXQ9QeP4vgfF3Cdzh3HO6cbRzuXFjecL5/TfKxGSNVamn3xH4cmjipmPZMW0ZOxfNmHjiI6t3TyVGXrQWQE4BC3JJ9AVCOp0RK9UbvXB21b56DrPUilIUnGAvMydotvcv1i9cG2DdH+uaMlCh/ujrh3Dr9HeXhNt2TAaTxR4/chOlf3gdnxE2OuumhQweI2xqylT5+m0Z5Aj7N569g9ZlL1GgNUHZ8EbFT5sTS0d5Ss7ZZms+TvXkjJc4r+8I9vO2v1Jj7B/RcL7XECttHxLaPHEDljqmk9SXpAUuDeFUlHSGq7OZaqP/nRXo4WtonxwuOEE35SHxi8feiVi/ebOY3XwB2xYRIhzvwD06/3+waeVJBUWETwMAbvXs7n/rAXhR2lBAuR5ABoAKJ5v/Mo/W9OZhAWa07jINf6f5q8Mri1+k/TbaC+a0RQLZqSqs/VR0XhyYekSPOR6nQ0R0ZiWrBm3r/HhRvm0brpTqaz80ivtqR1AqzWg/N8/p07aO9hdWrw+ttBalbN1LC7X+LHZi+3+wofV1yUzKBikykhDtV5JJ6edpEKAqrdedq7xPhmeVH7D9NbSHjeRK3duSYKI5XSuLgxF/KMfePlZJAoAN43OeegNtVj6mzjU905+up1rfG5K9H3o0ZOUGM7J0+xG6u/mNcYPc4CrN8rvPrwfnl/46j5FH7rdb6WzfY4E+vWGCVvdN7C1VqA2ef3zh9vLWDDTH608I3hsf/gX+f/184zqmkKbrmQgAAAABJRU5ErkJggg==" />';

  /* ------------------------------------------------------------------ *
   * Per-platform configuration.
   * Selectors are intentionally broad with fallbacks because these sites
   * change their DOM frequently. `editor` finds the input; `sendButton`
   * finds the submit control; `responseRoot` is the area we unmask.
   * ------------------------------------------------------------------ */
  /**
   * Generic fallback config for platforms we don't have hand-tuned selectors
   * for. Broad selectors cover the overwhelmingly common cases: a single
   * textarea or a single contenteditable, with a send button identified by its
   * label/type. `<main>` is the usual response container.
   */
  function genericConfig(name, note) {
    return {
      name,
      editor: [
        "textarea",
        "div[contenteditable='true']",
        "[role='textbox']",
      ],
      sendButton: [
        "button[type='submit']",
        "button[aria-label*='Send' i]",
        "button[aria-label*='Submit' i]",
        "button[data-testid*='send' i]",
      ],
      responseRoot: ["main", "div[role='main']", "div[role='presentation']"],
      note,
    };
  }

  const GENERIC_NOTE =
    "This AI service may store and review what you send; avoid sharing personal IDs, credentials or financial data.";

  const PLATFORMS = {
    "chatgpt.com": chatGPTConfig(),
    "chat.openai.com": chatGPTConfig(),
    "claude.ai": {
      name: "Claude",
      editor: ['div[contenteditable="true"].ProseMirror', 'div[contenteditable="true"]'],
      sendButton: ['button[aria-label="Send message"]', 'button[aria-label*="Send"]'],
      // role="feed" is the semantic conversation container and survives the
      // Tailwind class churn that broke the old "div.flex-1.flex.flex-col"
      // root (which still MATCHES on claude.ai but holds no messages at all).
      // claude.ai has no <main>, so that fallback never fires here.
      responseRoot: ['div[role="feed"]', "main", "div.flex-1.flex.flex-col"],
      // Claude renamed the assistant bubble class font-claude-message ->
      // font-claude-response; the old names are kept behind it as fallbacks.
      responseMessage: [
        "div.font-claude-response",
        "div.font-claude-message",
        '[data-testid="assistant-turn"]',
      ],
      userMessage: ['[data-testid="user-message"]', "div.font-user-message"],
      note: "Anthropic states consumer chats may be reviewed for safety; avoid sharing personal IDs.",
    },
    "gemini.google.com": {
      name: "Gemini",
      editor: ["div.ql-editor[contenteditable='true']", "rich-textarea div[contenteditable='true']"],
      sendButton: ["button[aria-label*='Send']", "button.send-button"],
      responseRoot: ["main", "chat-window"],
      responseMessage: ["message-content", ".model-response-text"],
      userMessage: ["user-query-content", ".user-query-bubble-with-background", ".query-text"],
      note: "Google may use Gemini activity to improve products; reviewers can read conversations.",
    },
    "bard.google.com": {
      name: "Gemini",
      editor: ["div.ql-editor[contenteditable='true']", "rich-textarea div[contenteditable='true']"],
      sendButton: ["button[aria-label*='Send']", "button.send-button"],
      responseRoot: ["main", "chat-window"],
      responseMessage: ["message-content", ".model-response-text"],
      userMessage: ["user-query-content", ".user-query-bubble-with-background", ".query-text"],
      note: "Google may use Gemini activity to improve products; reviewers can read conversations.",
    },
    "copilot.microsoft.com": {
      name: "Copilot",
      editor: ["textarea#userInput", "textarea", "div[contenteditable='true']"],
      sendButton: ["button[aria-label*='Submit']", "button[aria-label*='Send']"],
      responseRoot: ["main", "div[role='main']"],
      note: "Microsoft may retain Copilot interactions; do not share government IDs or credentials.",
    },
    "bing.com": genericConfig(
      "Copilot",
      "Microsoft may retain Copilot interactions; do not share government IDs or credentials."
    ),
    "perplexity.ai": genericConfig(
      "Perplexity",
      "Perplexity may log and retain your queries; avoid sharing personal IDs or credentials."
    ),
    "poe.com": genericConfig("Poe", GENERIC_NOTE),
    "character.ai": genericConfig("Character.AI", GENERIC_NOTE),
    "mistral.ai": genericConfig("Mistral", GENERIC_NOTE),
    "chat.mistral.ai": genericConfig("Le Chat", GENERIC_NOTE),
    "groq.com": genericConfig("Groq", GENERIC_NOTE),
    "huggingface.co": genericConfig("HuggingChat", GENERIC_NOTE),
    "you.com": genericConfig("You.com", GENERIC_NOTE),
    "writesonic.com": genericConfig("Writesonic", GENERIC_NOTE),
    "jasper.ai": genericConfig("Jasper", GENERIC_NOTE),
    "copy.ai": genericConfig("Copy.ai", GENERIC_NOTE),
    "rytr.me": genericConfig("Rytr", GENERIC_NOTE),
    "pi.ai": genericConfig("Pi", GENERIC_NOTE),
    "inflection.ai": genericConfig("Inflection", GENERIC_NOTE),
    "cohere.com": genericConfig("Cohere", GENERIC_NOTE),
    "phind.com": genericConfig("Phind", GENERIC_NOTE),
    "deepseek.com": genericConfig("DeepSeek", GENERIC_NOTE),
    "qwen.ai": genericConfig("Qwen", GENERIC_NOTE),
    "grok.com": genericConfig("Grok", GENERIC_NOTE),
    "meta.ai": genericConfig("Meta AI", GENERIC_NOTE),
    "use.ai": genericConfig("Use.ai", GENERIC_NOTE),
  };

  function chatGPTConfig() {
    return {
      name: "ChatGPT",
      editor: ["div#prompt-textarea", "div[contenteditable='true']", "textarea#prompt-textarea", "textarea"],
      sendButton: ["button[data-testid='send-button']", "button[aria-label*='Send']"],
      responseRoot: ["main", "div[role='presentation']"],
      responseMessage: ['[data-message-author-role="assistant"]'],
      userMessage: ['[data-message-author-role="user"]'],
      note: "OpenAI may use chats to train models unless you opt out; treat anything you send as potentially retained.",
    };
  }

  /**
   * Resolve the config for the current host. We match the exact host first,
   * then fall back to a suffix match so subdomains (e.g. www.bing.com,
   * chat.deepseek.com) resolve to the registered domain's config.
   */
  function resolveConfig(host) {
    if (PLATFORMS[host]) return PLATFORMS[host];
    for (const domain in PLATFORMS) {
      if (host === domain || host.endsWith("." + domain)) return PLATFORMS[domain];
    }
    return null;
  }

  const HOST = location.hostname.replace(/^www\./, "");
  const CONFIG = resolveConfig(HOST);
  if (!CONFIG) return; // Not a supported site.

  /* ------------------------------------------------------------------ *
   * Shared instances + runtime state.
   * ------------------------------------------------------------------ */
  const detector = new Detector();
  const nlp = new NlpDetector();
  const masker = new Masker();
  // How much text this site's composer takes AS TEXT — measured per site (see
  // src/filescan.js PASTE_LIMITS). Sent with every parser request so the
  // "Send as masked text" verdict is made against this site's real ceiling.
  const PASTE_LIMIT =
    (window.GuardAI.FileScan && window.GuardAI.FileScan.pasteLimitFor(HOST)) || 9000;

  const state = {
    enabled: true, // master on/off (synced from storage)
    maskingEnabled: false, // mask-before-send mode
    autoRestore: true, // auto-swap fakes -> real in AI responses (panel toggle)
    autoOpenPanel: false, // pop the full side panel open after a deliberate
    // Mask & Send. Default OFF — most users found the panel jumping open on
    // every single send intrusive; the collapsed badge (always shown, via
    // logActivity -> showReopen) is enough, and they can click it whenever
    // they actually want to look. Mask & Edit / Manual mask are unaffected —
    // those buttons exist specifically to open the panel for review, so
    // opening it IS the requested action there, not an unwanted side effect.
    lastMaskedText: null, // the masked text we just typed in; lets the user's
    // own manual send pass through without re-scanning/re-masking.
    entitled: true, // licence gate. TRUE is the correct default and it is not
    // an oversight: this value is only ever wrong when settings could not be
    // read at all, and a storage failure is an error, not the server saying
    // no. Defaulting to false would mean "Extension context invalidated"
    // silently stops protecting someone — the exact failure the whole
    // entitlement design exists to prevent, arriving through a side door.
    // loadSettings() overwrites this with the real verdict a few ms later.
    aggressiveNames: false, // "Aggressive name detection" — opt-in, default OFF
    disabledCategories: [], // finding TYPEs actually switched off, AFTER the
    // company policy has been applied. This is what the detector reads.
    userDisabledCategories: [], // what the user themselves chose, kept apart
    // so that lifting a lock restores their choice instead of a guess at it.
    // Empty by default — everything on.
    imageHardStop: false, // "Always stop on images" — opt-in, default OFF.
    // OFF means an image OCR read and found nothing in is attached with a
    // notice rather than a decision. It never affects the other two image
    // outcomes: found-something and could-not-read always stop.
    fileScanning: true,  // "Check documents I attach" — default ON.
    imageScanning: true, // "Read text in images I attach" — default ON.
    // Both default TRUE for the same reason `entitled` does: the only time
    // these are wrong is when storage could not be read, and a storage failure
    // must never be a route to quietly scanning less than the user asked for.
    policy: null, // the employer's scanning policy, or null for an individual
    // or unconnected install. NEVER treated as enforced when absent — see the
    // header of src/policy.js for why that asymmetry is the whole safety
    // argument. The three values above are computed through it, and the user's
    // own stored keys are never overwritten by it.
  };

  /* ------------------------------------------------------------------ *
   * The licence gate.
   *
   * The policy lives in src/entitlement.js and runs in the service worker.
   * This side does not re-derive it — it reads the verdict the worker already
   * wrote, in one comparison. That is deliberate: two copies of a state
   * machine drift, and the copy that drifts here is the one that decides
   * whether somebody is still being protected.
   *
   * LOCKED IS NOT MASTER-OFF, and they must not be collapsed into one flag:
   *
   *   master-off  the user asked for silence. Give them silence.
   *   locked      the user never asked for anything. Say so, once, and offer
   *               the way out.
   *
   * The other half of that distinction is restore. Masking is the paid
   * feature; being able to read your own already-masked conversations back is
   * not, and holding it behind a lapsed subscription would leave someone
   * staring at fake names in their own chat history with the real values
   * sitting on their disk. So a locked device stops detecting and stops
   * intercepting sends, but keeps swapping fakes back to real for as long as
   * it has a mapping table. A brand-new install has an empty one, so it is
   * inert exactly as intended.
   * ------------------------------------------------------------------ */

  /**
   * Mirror of isUnlocked() in src/entitlement.js. Keep it this short — if it
   * ever needs a second condition, the condition belongs in the worker and
   * this should keep reading one field.
   */
  function entitledFrom(rec) {
    if (!rec || typeof rec !== "object") return false;
    // Not a finite number = "never expires" (review builds) or a damaged
    // record. Both mean we cannot say it has run out, and not being able to
    // say so never removes protection. Same rule as isUnlocked().
    if (typeof rec.hardStopAt !== "number" || !isFinite(rec.hardStopAt)) return true;
    return Date.now() < rec.hardStopAt;
  }

  /**
   * Is this switch pinned by the user's employer?
   *
   * Mirrored verbatim from isLocked() in src/policy.js, for the same reason
   * entitledFrom() mirrors isUnlocked(): a content script is a classic script
   * and cannot import a module. Keep the two identical, and keep them this
   * short. test/policy.cjs runs both over the same matrix and fails if they
   * ever disagree, so this is held together by a test rather than by hope.
   *
   * Read src/policy.js for why a missing or damaged record locks NOTHING.
   */
  function lockedBy(pol, name) {
    if (!pol || typeof pol !== "object") return false;
    if (pol.mode !== "enforced") return false;
    if (!pol.locks || typeof pol.locks !== "object") return false;
    return pol.locks[name] === true;
  }

  /** The user's own choice, unless their admin pinned it on. Never written
   *  back to storage: when a policy relaxes, everyone's own setting is still
   *  exactly where they left it. */
  function effectiveFrom(userValue, pol, name) {
    return lockedBy(pol, name) ? true : userValue;
  }

  /**
   * The category off-list with any pinned category removed.
   *
   * Mirrors effectiveDisabled() in src/policy.js. Note the direction: the
   * stored list is an OFF-list, so a lock REMOVES an entry rather than adding
   * one, which is how a category lock stays inside the rule that nothing can
   * force a setting off. Returns a filtered copy; the user's array is not
   * touched, so lifting the lock restores exactly what they chose.
   */
  function effectiveDisabledFrom(userList, pol) {
    var list = Array.isArray(userList) ? userList : [];
    return list.filter(function (type) { return !lockedBy(pol, "cat:" + type); });
  }

  /** May GuardAI detect, warn and mask? */
  function isActive() {
    return state.enabled && state.entitled;
  }

  /** May GuardAI put already-masked data back? See the note above. */
  function canRestore() {
    return state.enabled && (state.entitled || masker.size > 0);
  }

  /* ------------------------------------------------------------------ *
   * Storage sync — keep local state in step with the dashboard toggles.
   * ------------------------------------------------------------------ */
  async function loadSettings() {
    // `state` already has safe hardcoded defaults (enabled/maskingEnabled/
    // autoRestore) set at its declaration. If storage is unavailable — e.g.
    // "Extension context invalidated" after a reload/update while this
    // content script is still injected on an open tab — this must degrade to
    // those defaults rather than throw, since boot() awaits this and a thrown
    // error here would otherwise skip every step after it, including
    // startObserving() (no auto-restore, no response monitoring at all).
    try {
      const data = await chrome.storage.local.get([
        "guardai_enabled",
        "guardai_masking_enabled",
        "guardai_auto_restore",
        "guardai_autopanel_enabled",
        "guardai_disabled_categories",
        "guardai_aggressive_names",
        "guardai_image_hard_stop",
        "guardai_file_scanning",
        "guardai_image_scanning",
        "guardai_theme",
        "guardai_entitlement",
        "guardai_policy",
      ]);
      // Read the policy before anything it governs, so the three effective
      // values below are computed once from a settled record rather than
      // being corrected afterwards.
      state.policy = data.guardai_policy || null;
      state.enabled = effectiveFrom(data.guardai_enabled !== false, state.policy, "enabled");
      state.fileScanning = effectiveFrom(data.guardai_file_scanning !== false, state.policy, "files");
      state.imageScanning = effectiveFrom(data.guardai_image_scanning !== false, state.policy, "images");
      state.entitled = entitledFrom(data.guardai_entitlement);
      state.maskingEnabled = effectiveFrom(
        data.guardai_masking_enabled === true, state.policy, "masking"); // default OFF
      state.autoRestore = data.guardai_auto_restore !== false; // default ON
      state.autoOpenPanel = data.guardai_autopanel_enabled === true; // default OFF
      state.userDisabledCategories = Array.isArray(data.guardai_disabled_categories)
        ? data.guardai_disabled_categories
        : [];
      state.disabledCategories = effectiveDisabledFrom(state.userDisabledCategories, state.policy);
      detector.setDisabledTypes(state.disabledCategories);
      // Default OFF: only an explicit `true` enables it, so a missing or
      // malformed value can never silently turn on the noisier mode.
      state.aggressiveNames = data.guardai_aggressive_names === true;
      detector.setAggressiveNames(state.aggressiveNames);
      // Same shape, same reason: only an explicit `true` restores the hard
      // stop, so a missing or malformed value leaves the lighter default.
      state.imageHardStop = data.guardai_image_hard_stop === true;
      applyThemeToPage(data.guardai_theme === "light");
    } catch (err) {
      console.warn("[GuardAI] could not read settings, using defaults:", err);
    }
  }

  /** Add / remove html.guardai-light on the host page to switch all GuardAI
   * elements between dark (default) and light mode without touching anything
   * that belongs to the host site. */
  function applyThemeToPage(light) {
    document.documentElement.classList.toggle("guardai-light", light);
  }

  /** Recompute everything the policy governs from what is currently stored.
   *  Called when the policy changes, because one policy change can move three
   *  switches at once and each of them has to end up at its effective value,
   *  not at whatever the user last chose. */
  async function reapplyPolicy() {
    try {
      const d = await chrome.storage.local.get([
        "guardai_enabled", "guardai_file_scanning", "guardai_image_scanning",
        "guardai_masking_enabled", "guardai_disabled_categories",
      ]);
      state.enabled = effectiveFrom(d.guardai_enabled !== false, state.policy, "enabled");
      state.fileScanning = effectiveFrom(d.guardai_file_scanning !== false, state.policy, "files");
      state.imageScanning = effectiveFrom(d.guardai_image_scanning !== false, state.policy, "images");

      const wasMasking = state.maskingEnabled;
      state.maskingEnabled = effectiveFrom(
        d.guardai_masking_enabled === true, state.policy, "masking");
      // Same follow-up the masking toggle does on its own: the per-message
      // buttons belong to one mode and not the other, so a policy that moves
      // masking has to take them away or put them back rather than leaving
      // stale ones on screen.
      if (state.maskingEnabled !== wasMasking) {
        if (state.maskingEnabled) removeMessageToggles();
        else scheduleDecorate();
      }

      state.userDisabledCategories = Array.isArray(d.guardai_disabled_categories)
        ? d.guardai_disabled_categories
        : [];
      state.disabledCategories = effectiveDisabledFrom(state.userDisabledCategories, state.policy);
      detector.setDisabledTypes(state.disabledCategories);

      applyEnabledState();
    } catch (_) {
      // Storage unreadable. Leave every value exactly as it is rather than
      // guessing: the last known state is right more often than a default.
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.guardai_policy) {
      // An admin switched the company between Flexible and Enforced. This is
      // the whole "no browser restart" guarantee: the worker writes the record
      // and every open tab arrives here, including tabs the user is typing in
      // right now.
      state.policy = changes.guardai_policy.newValue || null;
      reapplyPolicy();
    }
    if (changes.guardai_file_scanning) {
      state.fileScanning = effectiveFrom(
        changes.guardai_file_scanning.newValue !== false, state.policy, "files");
    }
    if (changes.guardai_image_scanning) {
      state.imageScanning = effectiveFrom(
        changes.guardai_image_scanning.newValue !== false, state.policy, "images");
    }
    if (changes.guardai_enabled) {
      // Through the policy, not raw. A locked switch stays on even if
      // something writes false to the key it shadows.
      state.enabled = effectiveFrom(changes.guardai_enabled.newValue !== false, state.policy, "enabled");
      applyEnabledState();
    }
    if (changes.guardai_entitlement) {
      // Activating in the popup must unlock the tabs the user already has
      // open. Waiting for a reload would make a successful activation look
      // like it had failed.
      state.entitled = entitledFrom(changes.guardai_entitlement.newValue);
      applyEnabledState();
    }
    if (changes.guardai_masking_enabled) {
      // Through the policy, not raw: a pinned masking mode stays on even if
      // something writes false to the key it shadows.
      state.maskingEnabled = effectiveFrom(
        changes.guardai_masking_enabled.newValue === true, state.policy, "masking");
      // Take the per-message toggle buttons away / put them back immediately,
      // rather than leaving stale ones on screen until the next render.
      if (state.maskingEnabled) removeMessageToggles();
      else scheduleDecorate();
    }
    if (changes.guardai_auto_restore) {
      state.autoRestore = changes.guardai_auto_restore.newValue !== false;
      syncAutoRestoreSwitch();
    }
    if (changes.guardai_autopanel_enabled) {
      state.autoOpenPanel = changes.guardai_autopanel_enabled.newValue === true;
    }
    if (changes.guardai_aggressive_names) {
      state.aggressiveNames = changes.guardai_aggressive_names.newValue === true;
      detector.setAggressiveNames(state.aggressiveNames);
    }
    if (changes.guardai_image_hard_stop) {
      // Live, like every other mode toggle: a team that switches this on
      // should not have to reload the tabs they already have open before the
      // next screenshot obeys it.
      state.imageHardStop = changes.guardai_image_hard_stop.newValue === true;
    }
    if (changes.guardai_disabled_categories) {
      state.userDisabledCategories = Array.isArray(changes.guardai_disabled_categories.newValue)
        ? changes.guardai_disabled_categories.newValue
        : [];
      // Filtered through the policy, so a category an admin pinned cannot be
      // switched off by anything that writes this key.
      state.disabledCategories = effectiveDisabledFrom(state.userDisabledCategories, state.policy);
      detector.setDisabledTypes(state.disabledCategories);
    }
    if (changes.guardai_mapping) {
      const newVal = changes.guardai_mapping.newValue;
      if (!Array.isArray(newVal) || newVal.length === 0) {
        // The mapping was cleared somewhere — most commonly the popup's
        // "Clear" button, which can only touch storage, not this page's own
        // masker instance directly. Without reacting here, this page kept
        // masking/restoring with the very data the user just deleted, and
        // the screen never visibly changed — indistinguishable from Clear
        // having silently done nothing. Safe to run even when THIS page
        // caused the change itself (clearSession already remasked + emptied
        // the table): remaskVisiblePage() no-ops once masker.size is 0, and
        // forgetInMemory() on an already-empty table is a no-op too.
        remaskVisiblePage();
        masker.forgetInMemory();
      }
    }
    if (changes.guardai_theme) {
      applyThemeToPage(changes.guardai_theme.newValue === "light");
    }
  });

  /**
   * Tell the background worker which categories were just masked, so a company
   * dashboard can count them.
   *
   * `items` deliberately does not cross this boundary. Every entry carries
   * .real and .fake, and neither may ever leave the page, so this reads one
   * field off each entry and builds a fresh array of strings. The background
   * worker then rebuilds the request body from scratch again in
   * src/company.js, which rejects anything that is not a known category.
   *
   * No-op unless the user has entered an invite code: the worker checks for a
   * connection before it sends anything.
   */
  function reportCompanyCategories(items) {
    if (!items || !items.length) return;
    const categories = [];
    for (const it of items) {
      if (it && typeof it.type === "string") categories.push(it.type);
    }
    if (!categories.length) return;
    try {
      chrome.runtime.sendMessage({
        type: "GUARDAI_COMPANY_EVENTS",
        categories: categories,
        site: HOST,
      });
    } catch (_) {
      /* service worker asleep — non-fatal, the masking already happened */
    }
  }

  /** Tell the background worker to record a stat event. */
  function reportStats(payload) {
    try {
      chrome.runtime.sendMessage({ type: "GUARDAI_STATS", platform: CONFIG.name, ...payload });
    } catch (_) {
      /* service worker asleep — non-fatal */
    }
  }

  /* ------------------------------------------------------------------ *
   * Editor read/write abstraction (textarea vs contenteditable).
   * ------------------------------------------------------------------ */
  /**
   * Is this element a composer someone could actually type in right now?
   *
   * grok.com ships a decoy: a 726x14 <textarea> at the very top of the page
   * with visibility:hidden, sitting above the real composer, which is a
   * contenteditable. genericConfig lists "textarea" before
   * "div[contenteditable='true']", so findEditor() took the decoy, the masked
   * text went into an invisible box, the send never fired, and the flow fell
   * back to opening the review panel — which is what "Mask & Send does nothing
   * but pop up a weird panel" actually was.
   *
   * Same shape as the message-selector bug: taking the first thing that
   * matches is wrong when an earlier selector can match a decoy.
   *
   * A zero-sized rect is treated as UNKNOWN rather than unusable. Elements are
   * routinely unlaid-out at document_start, and jsdom has no layout at all, so
   * rejecting on size alone would mean finding no editor anywhere. Visibility
   * is what actually settles it, and it is what settles Grok.
   */
  function isUsableEditor(el) {
    if (!el) return false;
    if (el.disabled === true || el.readOnly === true) return false;
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return false;
    // Never return one of our own panel/overlay elements as the chat editor.
    try {
      if (el.closest(".guardai-panel, .guardai-prompt")) return false;
    } catch { /* not an element we can test — fall through */ }
    let style = null;
    try {
      style = window.getComputedStyle(el);
    } catch { /* no layout engine — judge on the checks above */ }
    if (style) {
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") {
        return false;
      }
    }
    let rect = null;
    try {
      rect = el.getBoundingClientRect();
    } catch { /* ignore */ }
    // Only judge on size when there IS a size to judge.
    if (rect && (rect.width || rect.height)) {
      if (rect.width < 40 || rect.height < 16) return false;
    }
    return true;
  }

  /**
   * The composer. Selectors are tried in order, as the fallbacks they are, but
   * a selector only counts if it turns up something usable — and where one
   * selector matches several, the biggest wins, because a composer is the
   * large box on the page and a decoy generally is not.
   */
  function findEditor() {
    for (const sel of CONFIG.editor) {
      let els = [];
      try {
        els = document.querySelectorAll(sel);
      } catch {
        continue; // malformed selector — try the next fallback
      }
      let best = null;
      let bestArea = -1;
      for (const el of els) {
        if (!isUsableEditor(el)) continue;
        let area = 0;
        try {
          const r = el.getBoundingClientRect();
          area = (r.width || 0) * (r.height || 0);
        } catch { /* no layout — every candidate scores 0, first wins */ }
        if (area > bestArea) { best = el; bestArea = area; }
      }
      if (best) return best;
    }
    return null;
  }

  /** Find the editor element that contains a given event target, if any. */
  function findEditorFor(node) {
    if (!node || typeof node.closest !== "function") return null;
    try {
      return node.closest(CONFIG.editor.join(","));
    } catch {
      return null;
    }
  }

  function getEditorText(el) {
    if (!el) return "";
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value;
    return el.innerText || el.textContent || "";
  }

  /** Small async sleep helper. */
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Whitespace-insensitive compare (rich editors normalise spacing/newlines). */
  function normalize(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  /**
   * Empty the editor without fighting its internal model: select all and delete
   * via execCommand, which every rich editor (ProseMirror/Lexical/Quill) and
   * plain textarea honours as a normal edit.
   */
  function clearEditor(el) {
    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto =
        el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    try {
      document.execCommand("delete", false);
    } catch (_) {
      /* ignore */
    }
  }

  /** Collapse the caret to the very end of a contenteditable so the next
   * insertText appends rather than overwriting. Silently no-ops if the node
   * has been detached by a React/ProseMirror re-render. */
  function caretToEnd(el) {
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false); // false = collapse to end
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {
      /* node detached — caller handles re-find */
    }
  }

  /**
   * Insert a single character via the normal input pipeline.
   * For contenteditable we rely on execCommand("insertText"), which dispatches
   * the beforeinput/input pair editors expect from real typing. We do NOT
   * refocus per character — refocusing resets the selection in ProseMirror and
   * makes the insert silently no-op (the bug behind "retyped unchanged").
   */
  function insertChar(el, ch) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto =
        el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, el.value + ch);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    // Newlines in a contenteditable must be inserted as a SOFT line break.
    // On ChatGPT/Claude/Gemini a bare Enter submits, and execCommand("insertText","\n")
    // is interpreted by their editors as a submit — which would fire the message
    // mid-typing (sending only a partial multi-line message and bypassing the
    // Mask & Edit review). insertLineBreak is the Shift+Enter equivalent and
    // never submits.
    if (ch === "\n") {
      try {
        if (document.execCommand("insertLineBreak")) return true;
      } catch (_) {
        /* fall through to <br> */
      }
      try {
        return document.execCommand("insertHTML", false, "<br>");
      } catch (_) {
        return false;
      }
    }
    try {
      return document.execCommand("insertText", false, ch);
    } catch (_) {
      return false;
    }
  }

  /** Did the editor end up containing the WHOLE intended text? Whitespace is
   * normalised because rich editors collapse runs of spaces/newlines. This is
   * the single source of truth for "did the fill succeed" — every send path
   * checks it before sending so a partial/split fill can never go out. */
  function fullyLanded(el, text) {
    return normalize(getEditorText(el)).includes(normalize(text));
  }

  /**
   * Atomically place `text` into the editor as ONE block, exactly like a real
   * user paste, and return true only once the WHOLE text is present.
   *
   * WHY PASTE-FIRST (this is the architectural fix for message-splitting):
   * On ChatGPT/Claude (ProseMirror/Lexical) a real "\n" delivered through
   * execCommand("insertText") is interpreted by the editor as a SUBMIT. The old
   * char-by-char + execCommand fallback therefore fired the message mid-fill on
   * long multi-line input — sending a leading fragment as message 1 and the rest
   * as message 2 (and making Mask & Edit "auto-send"). A synthetic paste of the
   * full block goes through the editor's clipboard handler, which inserts every
   * newline as a soft break and NEVER submits — so the entire message stays
   * atomic regardless of length (10 words or 10,000).
   *
   * Fallback order is deliberately submit-safe: paste (retried) -> char-by-char
   * with insertLineBreak for newlines (slow but never submits). We NEVER fall
   * back to execCommand("insertText") on text containing a newline.
   */
  async function typeText(el, text) {
    console.log("[GuardAI] typeText — filling editor, el in DOM:", document.contains(el), "len:", text.length);
    el.focus();

    // Re-resolve if the node was detached by a React/ProseMirror remount.
    const refresh = () => {
      if (document.contains(el)) return true;
      const fresh = findEditor();
      if (!fresh) { console.error("[GuardAI] typeText — no editor found"); return false; }
      el = fresh; el.focus();
      console.log("[GuardAI] typeText — re-found editor after remount");
      return true;
    };

    // ---- TEXTAREA / INPUT: native value setter is already atomic & submit-safe.
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto =
        el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setValue = (v) => {
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      setValue("");
      setValue(text);
      return fullyLanded(el, text);
    }

    // A verification that reads a STALE node is worse than no verification:
    // a large paste makes ProseMirror REMOUNT the editor, fullyLanded(el)
    // then reads the detached old node, sees nothing, and a fill that
    // actually landed gets cleared and retried — measured live 2026-08-28,
    // where a 3,323-char document cascaded through both strategies into the
    // char-by-char crawl at ~2 chars/second (a 28-minute fill the user reads
    // mid-crawl: the "preview doesn't match the composer" bug). Every
    // verification below re-finds the live node first.
    const landedLive = () => {
      if (!refresh()) return false;
      return fullyLanded(el, text);
    };

    // ---- Document-sized text: ONE synthetic paste, verified on the live
    // node. Measured on the real composers: chatgpt takes 9,500 chars as a
    // single paste instantly, claude 250k; per-line insertText is built for
    // chat-message volumes and the char crawl is a hang at this size, not a
    // fallback. Order flips for big text; small text keeps the old order.
    const BIG = text.length > 1500;
    const tryPaste = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!refresh()) return false;
        clearEditor(el);
        await delay(20);
        if (!refresh()) return false;
        pasteInto(el, text);
        await delay(BIG ? 150 : 60);
        if (landedLive()) {
          console.log("[GuardAI] typeText — paste landed on attempt", attempt + 1);
          return true;
        }
      }
      return false;
    };
    if (BIG && (await tryPaste())) return true;

    // ---- contenteditable PRIMARY: per-line fill that YIELDS to the editor.
    // This is the robust path and does NOT depend on synthetic paste (which the
    // real ProseMirror/Lexical editors silently ignore because a paste event
    // dispatched from a content script has isTrusted=false). For each line we
    // call execCommand("insertText", line) — the line itself NEVER contains a
    // newline, so it can never be interpreted as a submit — and between lines we
    // call insertLineBreak (the Shift+Enter soft break) which also never submits.
    //
    // WHY WE AWAIT BETWEEN EVERY OP (the volume fix): ProseMirror/Lexical apply
    // edits through an ASYNC transaction/flush cycle. If we fire all ~80 ops for a
    // 15-record block synchronously, our caretToEnd() reads a DOM selection that
    // the editor has not yet reconciled, so each insert lands at a stale position
    // and the editor "corrects" it on its next flush — interleaving content
    // between rows (duplicated names, a fake name landing in the wrong column,
    // dropped records). Short input has too few ops for the drift to show; long
    // input compounds it. Awaiting a microtask-sized delay after each op lets the
    // editor flush so the NEXT caretToEnd reads the real end position.
    const fillPerLine = async () => {
      if (!refresh()) return false;
      clearEditor(el);
      await delay(10);
      if (!refresh()) return false;
      el.focus();
      caretToEnd(el);
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!refresh()) return false;
        caretToEnd(el);
        if (lines[i].length) {
          try {
            document.execCommand("insertText", false, lines[i]);
          } catch (_) {
            return false;
          }
          await delay(6); // let the editor reconcile before we move the caret
        }
        if (i < lines.length - 1) {
          if (!refresh()) return false;
          caretToEnd(el);
          // Shift+Enter equivalent — soft break, never submits.
          try {
            if (!document.execCommand("insertLineBreak")) {
              document.execCommand("insertHTML", false, "<br>");
            }
          } catch (_) {
            try { document.execCommand("insertHTML", false, "<br>"); } catch (_) { return false; }
          }
          await delay(6);
        }
      }
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return true;
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      if (!(await fillPerLine())) break;
      await delay(40);
      if (landedLive()) {
        console.log("[GuardAI] typeText — per-line fill landed on attempt", attempt + 1, "editorLen:", getEditorText(el).length, "wantLen:", text.length);
        return true;
      }
      console.warn("[GuardAI] typeText — per-line attempt", attempt + 1, "did not fully land. editorText:", JSON.stringify(getEditorText(el).slice(0, 200)));
    }

    // ---- Fallback 1: ONE synthetic paste of the whole block (already tried
    // first for document-sized text above). Works in editors that DO honour
    // synthetic paste; submit-safe (clipboard handler inserts newlines as
    // soft breaks).
    if (!BIG && (await tryPaste())) return true;

    // ---- Fallback 2: char-by-char (newlines via insertLineBreak, never
    // submits). SMALL TEXT ONLY: at ~2 chars/second on a live ProseMirror
    // this is a 28-minute hang on a 3k document, during which the composer
    // holds a slowly growing half-document — strictly worse than failing,
    // because the caller shows a clear error and clears the box.
    if (text.length > 1500) {
      console.error("[GuardAI] typeText — all strategies failed for large text; aborting rather than crawling");
      return false;
    }
    console.log("[GuardAI] typeText — per-line + paste failed, falling back to safe char-by-char");
    if (!refresh()) return false;
    clearEditor(el);
    await delay(20);
    if (!refresh()) return false;
    el.focus();
    caretToEnd(el);
    for (const ch of text) {
      if (!refresh()) return false;
      caretToEnd(el);
      insertChar(el, ch); // "\n" -> insertLineBreak / <br>, never a submitting insertText
      await delay(2);
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    return landedLive();
  }

  /** Dispatch a single synthetic paste of `text` over the full selection.
   * Replaces the whole editor contents in one atomic, submit-safe operation. */
  function pasteInto(el, text) {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      el.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
      );
    } catch (_) {
      /* DataTransfer/ClipboardEvent unavailable — caller's verify will fail and
         the char-by-char fallback takes over. */
    }
  }

  /* ------------------------------------------------------------------ *
   * Detection — combine pattern engine with the optional NLP layer.
   * ------------------------------------------------------------------ */
  async function scanText(text) {
    const findings = detector.scan(text);
    if (nlp.isAvailable()) {
      try {
        const nlpFindings = await nlp.scan(text);
        // Merge, dropping NLP hits that overlap an existing pattern finding.
        for (const nf of nlpFindings) {
          const overlaps = findings.some(
            (f) => nf.index < f.index + f.value.length && nf.index + nf.value.length > f.index
          );
          if (!overlaps) findings.push(nf);
        }
        findings.sort((a, b) => a.index - b.index);
      } catch (_) {
        /* ignore NLP errors, patterns already ran */
      }
    }
    return findings;
  }

  /* ------------------------------------------------------------------ *
   * Mask + type + review (NO auto-send).
   *
   * Philosophy: never fight the site's editor and never auto-send. On send we:
   *   1. compute the masked text from everything the detector found,
   *   2. clear the editor and type the masked text in (every editor accepts
   *      typing; a reliable whole-string fallback guarantees it fully lands),
   *   3. show a "Did we miss anything?" review in the side panel — the user
   *      reviews, optionally masks anything we missed (which re-types the input
   *      live), then presses send themselves.
   * The matching fake->real swap happens automatically in the AI response.
   * GuardAI never reads or writes the system clipboard, so a value the user
   * copied stays intact for their next paste.
   * ------------------------------------------------------------------ */
  /**
   * Seed the review model from the maskable auto-detected findings. The detector
   * has already resolved overlaps; warning-only findings can still be masked
   * manually later from the MESSAGE tab.
   */
  async function buildReviewModel(editor, original, findings, opts) {
    const docPolicy = !!(opts && opts.docPolicy);
    await masker.load();
    // DIAGNOSTIC: log exactly what text the detector scanned (what the editor
    // handed back). If this differs from what was pasted, indices/masking are
    // computed against a reformatted string — capture this from the real site.
    console.log("[GuardAI] buildReviewModel — original captured (len " + (original || "").length + "):", JSON.stringify((original || "").slice(0, 300)));
    console.log("[GuardAI] buildReviewModel — findings:", findings.map((f) => `${f.type}@${f.index}:${JSON.stringify(f.value)}`).join(" | "));
    const fakeByReal = new Map();
    // Every distinct fake we've assigned in THIS batch. Seeded as we go so the
    // next previewFake() avoids colliding with a fake already given to a
    // different real value in the same message (the masker's own table only
    // knows about committed pairs, not in-flight batch ones).
    const usedFakes = new Set();
    const items = [];
    // Document policy (the file flow): DOB masks here — the chat card's
    // interrupt-and-choose reasoning does not exist for a document (see the
    // policy note above MASKABLE in masker.js) — and organisations are linked
    // by stem so a letterhead and a signature naming the same company wear
    // ONE stand-in in each surface's own case and designators.
    const maskableHere = (t) => masker.isMaskable(t) || (docPolicy && t === "DOB");
    const orgFakeByStem = new Map();
    for (const f of findings) {
      if (!maskableHere(f.type)) continue;
      // Same real value -> same fake (same person/number stays coherent).
      let fake = fakeByReal.get(f.value);
      if (!fake && docPolicy && f.type === "ORG") {
        const { stem, tail } = orgSplit(f.value);
        const known = orgFakeByStem.get(stem);
        if (known) {
          fake = (known + (tail ? " " + tail : "")).trim();
          if (isAllCaps(f.value)) fake = fake.toUpperCase();
        } else {
          const generated = masker.previewFake(f.type, f.value, usedFakes);
          const fakeStem = titleCase(orgSplit(generated).stem);
          orgFakeByStem.set(stem, fakeStem);
          fake = (fakeStem + (tail ? " " + tail : "")).trim();
          if (isAllCaps(f.value)) fake = fake.toUpperCase();
        }
        fakeByReal.set(f.value, fake);
        usedFakes.add(fake);
      }
      if (!fake) {
        fake = masker.previewFake(f.type, f.value, usedFakes);
        fakeByReal.set(f.value, fake);
        usedFakes.add(fake);
      }
      items.push({
        start: f.index,
        end: f.index + f.value.length,
        value: f.value,
        type: f.type,
        manual: false,
        fake,
      });
    }
    // Give each person's identifiers THEIR stand-in name, so a masked
    // signature block reads as one person rather than three. See the note
    // above identifierOwner: this is not cosmetic — the name an AI infers
    // from a fake address is unrestorable unless it is a fake we know.
    {
      const nameItems = items.filter((it) => it.type === "NAME_PII" && nameParts(it.value));
      const owned = new Map(); // real identifier -> derived fake
      for (const it of items) {
        if (it.type !== "EMAIL" && it.type !== "USERNAME") continue;
        if (owned.has(it.value)) { it.fake = owned.get(it.value); continue; }
        const owner = identifierOwner(it, nameItems);
        if (!owner) continue;
        const derived = safeDerivedFake(it, owner.fake, usedFakes);
        if (!derived) continue;
        usedFakes.add(derived);
        fakeByReal.set(it.value, derived);
        owned.set(it.value, derived);
        it.fake = derived;
      }
    }

    // Safety net: explicitly verify no two DISTINCT real values share a fake.
    // Generation already avoids this via `usedFakes`, but a final pass guarantees
    // it so unmasking can never restore the wrong identity to the wrong row.
    const fakeOwner = new Map(); // fake -> first real value that claimed it
    for (const it of items) {
      const owner = fakeOwner.get(it.fake);
      if (owner === undefined) {
        fakeOwner.set(it.fake, it.value);
        continue;
      }
      if (owner === it.value) continue; // same real value legitimately reuses its fake
      // Collision between two different reals — regenerate a unique fake.
      let regenerated = masker.previewFake(it.type, it.value, usedFakes);
      let guard = 0;
      while ((usedFakes.has(regenerated) || fakeOwner.has(regenerated)) && guard < 100) {
        regenerated = masker.previewFake(it.type, it.value + ":retry" + guard, usedFakes);
        guard++;
      }
      it.fake = regenerated;
      fakeByReal.set(it.value, regenerated);
      usedFakes.add(regenerated);
      fakeOwner.set(regenerated, it.value);
    }
    items.sort((a, b) => a.start - b.start);
    review = { editor, original, items, fakeByReal };
    msgView = "ai"; // new review always opens on the "What AI sees" editable view
  }

  /** Build the masked text by applying the auto-detected items end -> start. */
  function computeMasked() {
    if (!review) return "";
    let masked = review.original;
    const ordered = review.items
      .filter((it) => it.start >= 0 && it.value)
      .sort((a, b) => a.start - b.start);

    // Never apply two items whose spans overlap: the second replacement would
    // cut into the fake written by the first and mangle both. resolveOverlaps()
    // in the detector should already guarantee this — this is the last line of
    // defence before any text is actually rewritten.
    const applied = [];
    for (const it of ordered) {
      if (applied.length && it.start < applied[applied.length - 1].end) continue;
      applied.push(it);
    }

    // End -> start, so each replacement leaves the indices of the ones before
    // it untouched.
    for (let i = applied.length - 1; i >= 0; i--) {
      const it = applied[i];
      if (masked.slice(it.start, it.end) === it.value) {
        masked = masked.slice(0, it.start) + it.fake + masked.slice(it.end);
        continue;
      }
      // The recorded index drifted (the editor reformatted the text after the
      // scan). Fall back to the SINGLE occurrence nearest that index — never a
      // global replace. `split(value).join(fake)` rewrote every occurrence
      // anywhere in the message, including matches inside longer words, which
      // is precisely the "masking changed text it was never asked to touch"
      // failure this function must never produce.
      let at = masked.indexOf(it.value, Math.max(0, it.start - 40));
      if (at === -1) at = masked.indexOf(it.value);
      if (at === -1) continue; // genuinely not present — leave the text alone
      masked = masked.slice(0, at) + it.fake + masked.slice(at + it.value.length);
    }
    return masked;
  }

  /** Register every review item as a committed real<->fake pair and persist. */
  async function registerReviewItems() {
    if (!review) return;
    for (const it of review.items) masker.registerManual(it.value, it.fake, it.type);
    await masker.save();
  }

  /**
   * Hide the chat box's CONTENTS while silent mode swaps the user's text for
   * the masked version, so the swap is never visible. The fill is a per-line
   * execCommand sequence that yields to the editor between ops (see typeText),
   * which reads as a visible re-type — exactly the "I can see it working" tell
   * that silent mode is supposed to eliminate.
   *
   * opacity, not visibility/display: a hidden element can't hold focus or a
   * selection, and the whole fill depends on both. Set with `important` so a
   * host site's own rule can't win, and restored to the element's exact prior
   * inline value (usually: none at all).
   *
   * Covers multiple nodes because typeText may re-resolve a fresh editor
   * mid-fill after a React/ProseMirror remount.
   */
  function cloakEditor() {
    const saved = new Map();
    return {
      cover(el) {
        if (!el || !el.style || saved.has(el)) return;
        saved.set(el, [
          el.style.getPropertyValue("opacity"),
          el.style.getPropertyPriority("opacity"),
        ]);
        el.style.setProperty("opacity", "0", "important");
      },
      release() {
        for (const [el, [value, priority]] of saved) {
          if (value) el.style.setProperty("opacity", value, priority);
          else el.style.removeProperty("opacity");
        }
        saved.clear();
      },
    };
  }

  /** Re-resolve a live editor (the stored node may have been detached by React). */
  function liveEditor() {
    return review && review.editor && document.contains(review.editor)
      ? review.editor
      : findEditor();
  }

  /**
   * "Mask & Send": mask everything detected, type it into the input, log it,
   * surface the MESSAGE tab, then send immediately — no editing step.
   */
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.silent] - Silent mode (the "Masking mode" toggle):
   *   mask and send with NO visible UI on the happy path — no warning card,
   *   no panel popping open, no error toast. Activity is still logged (the
   *   badge/panel update quietly) and the one-time first-mask explainer still
   *   fires, just nothing interrupts the user. On any failure we do NOT
   *   silently give up or silently show our own recovery screen — we return
   *   `false` so the caller falls back to the normal, fully-visible warning
   *   card, since staying silent through an uncertain/failed send is exactly
   *   the kind of surprise this mode must never produce.
   * @returns {Promise<boolean|undefined>} Only meaningful when opts.silent:
   *   true = sent successfully and silently; false = failed, caller should
   *   fall back to showWarning(). Non-silent callers ignore the return value
   *   (unchanged from before).
   */
  async function doMaskAndSend(editor, original, findings, opts) {
    const silent = !!(opts && opts.silent);
    const prebuilt = !!(opts && opts.prebuilt);
    console.log("[GuardAI] doMaskAndSend — building review model");
    // Guard up front: if we can't resolve a chat box at all, bail cleanly with a
    // clear message instead of operating on a null editor later.
    if (!editor && !findEditor()) {
      console.error("[GuardAI] doMaskAndSend — no chat box found at entry");
      if (silent) return false;
      showErrorToast("Couldn't find the chat box — try reloading the page, then send again.");
      return;
    }
    // A prebuilt model means the caller already showed the user EXACTLY what
    // computeMasked() will produce (the file preview). Rebuilding here would
    // draw fresh random fakes and make that preview a lie.
    if (!prebuilt || !review) await buildReviewModel(editor, original, findings, opts);
    // Capture the review model in a local ref. handleSoftNav() can null the
    // global `review` during any await below (a stray history.replaceState from
    // the host site); operating on this captured ref means a concurrent clear
    // can never null-deref. We re-attach it to the global before rendering/send.
    const model = review;
    if (!model) {
      console.error("[GuardAI] doMaskAndSend — review model missing after build");
      if (silent) return false;
      showErrorToast("Something interrupted masking — please try again.");
      return;
    }
    await registerReviewItems();
    const masked = computeMasked();
    console.log("[GuardAI] doMaskAndSend — masked text:", masked);
    let live = liveEditor();
    if (!live) {
      // One retry after a short settle — the page may still be updating.
      await delay(120);
      live = liveEditor();
    }
    if (!live) {
      console.error("[GuardAI] doMaskAndSend — no editor found");
      if (silent) return false;
      showErrorToast("Could not find the chat input — please click in the chat box and try again.");
      return;
    }
    console.log("[GuardAI] doMaskAndSend — typing into editor:", live);
    model.editor = live;
    // Suppress all sends during the fill so a long multi-line block can never be
    // submitted mid-fill (the message-splitting bug). We clear it only just before
    // the single intentional triggerSend below.
    suppressSends = true;
    // Silent mode: hide the swap itself, not just the UI around it.
    const cloak = silent ? cloakEditor() : null;
    if (cloak) cloak.cover(live);
    let ok;
    try {
      ok = await typeText(live, masked);
    } catch (err) {
      suppressSends = false;
      if (cloak) cloak.release();
      throw err;
    }
    // typeText may have re-found a fresh editor node; re-resolve so triggerSend
    // dispatches to the element that is actually in the DOM right now.
    live = liveEditor();
    if (cloak) cloak.cover(live); // in case typeText remounted onto a new node
    model.editor = live;
    // Restore the global review if a soft-nav cleared it mid-fill. Safe because
    // the fullyLanded() gate below refuses to send into a navigated-away editor.
    review = model;
    console.log("[GuardAI] doMaskAndSend — typeText ok:", ok);
    // HARD GATE: never send unless the WHOLE masked text is in the box. If the
    // fill came up short we must NOT trigger a send — doing so would dispatch a
    // partial/split message (the exact corruption we're fixing). Surface the
    // panel for review instead so the user can see/recover, and warn loudly.
    if (!ok || !live || !fullyLanded(live, masked)) {
      console.error("[GuardAI] doMaskAndSend — masked text did not fully land; aborting send");
      suppressSends = false; // abort path: re-enable normal sending for recovery
      state.lastMaskedText = null;
      // Uncover immediately: the fallback below hands the box back to the user,
      // and they must be able to see whatever is sitting in it.
      if (cloak) cloak.release();
      if (silent) {
        // Never send on an uncertain/failed fill, silent or not — but silent
        // mode must not invent its own recovery UI either. Hand back to the
        // caller so the NORMAL, fully-visible warning card takes over, same
        // as if silent mode had never been on for this message.
        return false;
      }
      showErrorToast("The masked message didn't fully load into the chat box, so it was NOT sent. Your text is in the box for review — please check it and send manually.");
      editMode = true; // keep the review panel + footer Send available for recovery
      panelClosed = false;
      ensurePanel();
      if (reopenEl) reopenEl.style.display = "none";
      renderMessageTab();
      renderPanel();
      setActiveTab("message");
      updateFooter();
      if (live) live.focus();
      return;
    }
    console.log("[GuardAI] doMaskAndSend — full text landed, triggering send");
    state.lastMaskedText = masked;
    const replacements = review.items.map((it) => ({
      type: it.type,
      real: it.value,
      fake: it.fake,
    }));
    logActivity("mask", replacements); // still logs quietly + fires the one-time first-mask explainer, even when silent
    reportStats({ masked: replacements.length });
    // Snapshot the review so the Message tab stays populated after the soft-nav
    // that follows a successful send (handleSoftNav clears `review` but not this).
    sentReview = review;
    editMode = false;
    if (!silent && state.autoOpenPanel) {
      // Opt-in only (state.autoOpenPanel, default OFF — see its declaration):
      // most users found the panel popping open on every single send
      // intrusive. Off (the default) behaves the same as silent mode here —
      // logActivity() above already updated the collapsed badge quietly.
      panelClosed = false;
      ensurePanel();
      if (reopenEl) reopenEl.style.display = "none";
      renderMessageTab();
      renderPanel();
    }
    if (!silent) {
      updateFooter();
      if (live) live.focus();
    }
    // Re-enable sending for the ONE intentional send below. triggerSend sets
    // bypassNext so it passes our own interceptors cleanly.
    suppressSends = false;
    triggerSend(live);
    if (cloak) {
      // Stay covered a beat past the send: the site clears the box a tick or
      // two after it accepts the message, and uncovering before that would
      // flash the masked text — the one thing the cloak exists to prevent.
      // Safety-netted so a send the site never consumes can't leave the box
      // permanently invisible.
      const done = () => cloak.release();
      const t = setTimeout(done, 1500);
      const emptied = () => {
        try {
          return !getEditorText(live).trim();
        } catch (_) {
          return true; // node gone / unreadable — don't hold the cover open
        }
      };
      const poll = setInterval(() => {
        if (emptied()) {
          clearTimeout(t);
          clearInterval(poll);
          done();
        }
      }, 40);
      setTimeout(() => clearInterval(poll), 1500);
    }
    if (silent) return true;
  }

  /**
   * "Mask & Edit": mask everything, type it into the input, then open the
   * MESSAGE tab with the masked message in an editable box. A footer Send
   * button appears; the user edits freely and sends when ready.
   */
  async function doMaskAndEdit(editor, original, findings, opts) {
    const prebuilt = !!(opts && opts.prebuilt);
    console.log("[GuardAI] doMaskAndEdit — building review model");
    if (!editor && !findEditor()) {
      console.error("[GuardAI] doMaskAndEdit — no chat box found at entry");
      showErrorToast("Couldn't find the chat box — try reloading the page, then try again.");
      return;
    }
    // Same contract as doMaskAndSend: a prebuilt model is the one the user
    // has already been shown, and rebuilding would redraw the fakes.
    if (!prebuilt || !review) await buildReviewModel(editor, original, findings, opts);
    // Capture the model locally (see doMaskAndSend) so a stray soft-nav that
    // nulls the global `review` mid-fill can never null-deref here.
    const model = review;
    if (!model) {
      console.error("[GuardAI] doMaskAndEdit — review model missing after build");
      showErrorToast("Something interrupted masking — please try again.");
      return;
    }
    await registerReviewItems();
    const masked = computeMasked();
    console.log("[GuardAI] doMaskAndEdit — masked text:", masked);
    let live = liveEditor();
    if (!live) {
      // One retry after a short settle — the page may still be updating.
      await delay(120);
      live = liveEditor();
    }
    if (!live) {
      console.error("[GuardAI] doMaskAndEdit — no editor found");
      showErrorToast("Could not find the chat input — please click in the chat box and try again.");
      return;
    }
    console.log("[GuardAI] doMaskAndEdit — typing into editor:", live);
    model.editor = live;
    // Mask & Edit must NEVER send. Suppress every send pathway for the whole fill;
    // clear it once the fill is done (the panel, not a send, is the next step).
    suppressSends = true;
    let ok;
    try {
      ok = await typeText(live, masked);
    } finally {
      suppressSends = false;
    }
    // Re-resolve in case typeText found a fresh editor node during re-render.
    live = liveEditor();
    model.editor = live;
    review = model; // restore global if a soft-nav cleared it mid-fill
    console.log("[GuardAI] doMaskAndEdit — typeText ok:", ok, "— opening panel for review (NO send)");
    state.lastMaskedText = masked;
    const replacements = review.items.map((it) => ({
      type: it.type,
      real: it.value,
      fake: it.fake,
    }));
    logActivity("mask", replacements);
    if (ok) reportStats({ masked: replacements.length });
    // Mask & Edit ALWAYS pauses for review — it never sends here. If the fill came
    // up short, warn so the user knows the box may not match the full masked text
    // before they edit/send. The "What AI sees" tab still shows the full masked
    // text from the review model regardless.
    if (!ok || !live || !fullyLanded(live, masked)) {
      console.warn("[GuardAI] doMaskAndEdit — masked text did not fully land in the chat box");
      showErrorToast("Heads up: the masked text may not have fully loaded into the chat box. Review it in the panel and use the panel's Send button.");
    }
    editMode = true;
    panelClosed = false;
    ensurePanel();
    if (reopenEl) reopenEl.style.display = "none";
    renderMessageTab();
    renderPanel();
    setActiveTab("message");
    updateFooter();
    if (live) live.focus();
  }

  /**
   * "Manual mask": open the MESSAGE tab showing the ORIGINAL unmasked message
   * with no auto-masking applied. The user highlights any words they want to
   * mask and chooses Auto-replace or Custom replace themselves, then clicks Send.
   * Nothing is typed into the real chat input yet — that happens on panel Send.
   */
  async function doManualMask(editor, original) {
    console.log("[GuardAI] doManualMask — setting up empty review for manual masking");
    await masker.load();
    // Build an empty review with no auto-detected items so the panel shows
    // the original text with no marks, ready for the user to highlight.
    review = { editor, original, items: [], fakeByReal: new Map() };
    msgView = "ai";
    editMode = true;
    panelClosed = false;
    ensurePanel();
    if (reopenEl) reopenEl.style.display = "none";
    renderMessageTab();
    renderPanel();
    setActiveTab("message");
    updateFooter();
    const live = liveEditor();
    if (live) live.focus();
  }

  /**
   * Trigger the platform's send action robustly: poll for an enabled send
   * button (up to ~1.5s) and click it; only fall back to a synthetic Enter if
   * no usable button appears.
   */
  function triggerSend(editor) {
    console.log("[GuardAI] triggerSend — polling for send button");
    let tries = 0;
    const MAX = 30; // ~1.5s at 50ms
    const attempt = () => {
      tries++;
      const btn = findEnabledSendButton();
      if (btn) {
        console.log("[GuardAI] triggerSend — clicking send button:", btn);
        bypassNext = true; // let our own click pass through the interceptor
        btn.click();
        return;
      }
      if (tries < MAX) {
        setTimeout(attempt, 50);
        return;
      }
      // Fallback: synthetic Enter on the editor. Prefer a freshly-resolved
      // editor over the possibly-detached captured reference.
      console.log("[GuardAI] triggerSend — no send button found after", MAX, "tries, firing synthetic Enter");
      const live = (document.contains(editor) ? editor : null) || findEditor();
      if (!live) { console.error("[GuardAI] triggerSend — no editor for Enter fallback"); return; }
      bypassNext = true;
      live.focus();
      live.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      );
    };
    attempt();
  }

  /** Find a send button that is present and not disabled. */
  function findEnabledSendButton() {
    for (const sel of CONFIG.sendButton) {
      const btn = document.querySelector(sel);
      if (
        btn &&
        !btn.disabled &&
        btn.getAttribute("aria-disabled") !== "true" &&
        btn.offsetParent !== null // visible
      ) {
        return btn;
      }
    }
    return null;
  }

  /** Passwords/secrets must never be shown back to the user in plain text. */
  function displayReal(rep) {
    return rep.type === "PASSWORD" ? "\u2022\u2022\u2022\u2022\u2022\u2022" : rep.real;
  }

  /* ------------------------------------------------------------------ *
   * Persistent activity panel (right side).
   * Logs every mask applied before sending (real -> fake) and every value
   * restored in a response (fake -> real). It stays open until the user
   * clicks X, then collapses to a small floating badge that reopens it.
   * Entries persist across reloads in chrome.storage.local so the running
   * log survives navigation within the conversation.
   * ------------------------------------------------------------------ */
  const ACTIVITY_KEY = "guardai_activity";
  const ACTIVITY_CAP = 200; // keep the log bounded
  let activityLog = []; // [{id, kind:"mask"|"unmask"|"pending", type, fake, real, revealed, at}]
  let activitySeq = 1; // monotonic id for entries (lets Reveal target one row)
  const loggedKeys = new Set(); // dedupe so re-renders don't double-log
  let panelEl = null;
  let maskedListEl = null; // MASKED tab: the activity-log list
  let reopenEl = null;
  let panelClosed = false; // user explicitly closed the panel this session
  let activeTab = "masked"; // "masked" | "message"
  let editMode = false; // a Mask & Edit is in progress -> show the panel Send button
  // MESSAGE tab elements (created with the panel).
  let msgPaneEl = null;
  let msgEditableEl = null;
  let msgLegendEl = null;
  let msgEmptyEl = null;
  let footerSendEl = null;
  let msgApplyEl = null; // "Apply changes" button in the MESSAGE tab
  let msgHintEl = null; // "Highlight any text to manually mask it" instruction
  let msgRealViewEl = null; // MESSAGE tab "What you see" read-only view
  let msgViewTabsEl = null; // the "What AI sees / What you see" sub-tab bar
  let msgView = "ai"; // "ai" = masked (editable) | "you" = original (read-only)
  let markTipEl = null; // hover tooltip on a mark (Remove mask / Change replacement)
  let markTipFor = null; // the mark element the tip currently belongs to
  let markTipHideT = null; // delayed-hide timer for the mark tooltip
  let maskPromptEl = null; // the "Mask & Send / Mask & Edit" bar above the input
  const FIRST_MASK_KEY = "guardai_first_mask_seen";
  let firstMaskExplainerEl = null;

  async function loadActivity() {
    try {
      const data = await chrome.storage.local.get([ACTIVITY_KEY]);
      activityLog = Array.isArray(data[ACTIVITY_KEY]) ? data[ACTIVITY_KEY] : [];
    } catch {
      activityLog = [];
    }
    for (const it of activityLog) {
      loggedKeys.add(it.kind + "|" + it.fake + "|" + it.real);
      if (typeof it.id === "number" && it.id >= activitySeq) activitySeq = it.id + 1;
    }
  }

  function persistActivity() {
    if (activityLog.length > ACTIVITY_CAP) activityLog = activityLog.slice(-ACTIVITY_CAP);
    try {
      // chrome.storage.local.set() can REJECT asynchronously (quota exceeded,
      // extension context invalidated, etc.) — a bare try/catch only catches a
      // SYNCHRONOUS throw, so .catch() is needed too or this becomes an
      // unhandled promise rejection. Either way, storage failing here must
      // never break anything: the in-memory log still works for this page.
      chrome.storage.local.set({ [ACTIVITY_KEY]: activityLog }).catch(() => {});
    } catch {
      /* storage may be unavailable; the in-memory log still works */
    }
  }

  /**
   * Append swaps to the running log and refresh the panel. `kind` is "mask"
   * (real -> fake, before send) or "unmask" (fake -> real, in a response).
   * Passwords are stored and shown as bullets, never in clear.
   */
  function logActivity(kind, items) {
    if (!items || !items.length) return;
    let added = 0;
    for (const it of items) {
      const real = it.type === "PASSWORD" ? "\u2022\u2022\u2022\u2022\u2022\u2022" : it.real;
      const key = kind + "|" + it.fake + "|" + real;
      if (loggedKeys.has(key)) continue; // skip duplicates / re-render echoes
      loggedKeys.add(key);
      activityLog.push({
        id: activitySeq++,
        kind,
        type: it.type,
        fake: it.fake,
        real,
        revealed: false,
        at: Date.now(),
      });
      added++;
    }
    if (!added) return;
    persistActivity();
    // Never pop the panel open on its own — only keep it live if the user
    // already has it open right now. Otherwise just update the collapsed
    // badge's count, so passive activity (e.g. auto-restore on a response
    // you didn't explicitly ask to review) never yanks the panel over the
    // page. Deliberate actions (Mask & Send / Mask & Edit) force the panel
    // open themselves right after calling this, independent of this check.
    if (panelEl && panelEl.style.display !== "none") {
      renderPanel();
    } else {
      showReopen();
    }
    // The very first time GuardAI actually masks something for a new user,
    // their own text visibly changes — explain what just happened so that
    // moment builds trust instead of alarm.
    if (kind === "mask") {
      reportCompanyCategories(items);
      maybeShowFirstMaskExplainer();
    }
  }

  /**
   * One-time, lightweight explainer shown the first time real data is masked.
   * Anchored bottom-left (out of the way of the panel bottom-right), auto-
   * dismisses, and remembers it's been seen in chrome.storage.local so it
   * never shows again. Fails open: if the flag can't be read, we simply don't
   * nag (better than showing it every time).
   */
  function maybeShowFirstMaskExplainer() {
    if (firstMaskExplainerEl) return;
    let done = false;
    const show = () => {
      if (done || firstMaskExplainerEl) return;
      done = true;
      const el = document.createElement("div");
      el.className = "guardai-firstrun";
      el.setAttribute("role", "status");
      el.innerHTML =
        `<div class="guardai-firstrun__head">` +
        `<span class="guardai-firstrun__shield">${SHIELD_SVG}</span>` +
        `<span class="guardai-firstrun__title">Your data was just masked</span>` +
        `<button class="guardai-firstrun__close" aria-label="Dismiss">&times;</button>` +
        `</div>` +
        `<p class="guardai-firstrun__body">GuardAI replaced your sensitive details with realistic ` +
        `fakes before sending, so the AI never sees the real thing. When it replies, ` +
        `GuardAI swaps your real data back in — only you ever see it. Manage everything ` +
        `from the GuardAI panel.</p>` +
        `<button class="guardai-firstrun__ok">Got it</button>`;
      document.body.appendChild(el);
      firstMaskExplainerEl = el;
      const dismiss = () => {
        if (el._t) clearTimeout(el._t);
        el.remove();
        if (firstMaskExplainerEl === el) firstMaskExplainerEl = null;
      };
      el.querySelector(".guardai-firstrun__close").onclick = dismiss;
      el.querySelector(".guardai-firstrun__ok").onclick = dismiss;
      el._t = setTimeout(dismiss, 14000);
      try {
        chrome.storage.local.set({ [FIRST_MASK_KEY]: true }).catch(() => {});
      } catch (_) { /* non-fatal */ }
    };
    try {
      chrome.storage.local.get([FIRST_MASK_KEY]).then((d) => {
        if (!d || !d[FIRST_MASK_KEY]) show();
      }).catch(() => { /* storage unreadable — don't nag */ });
    } catch (_) { /* storage unavailable — don't nag */ }
  }

  /* ------------------------------------------------------------------ *
   * Locked notice.
   *
   * The visible half of "locked is not master-off". A device that has never
   * been activated does nothing at all, and an extension that does nothing
   * and says nothing is indistinguishable from a broken one — to a new user,
   * and to whoever is reviewing the store listing. So it says so, once,
   * with the way out one click away.
   *
   * Never shown when the master toggle is off: that silence was asked for.
   * ------------------------------------------------------------------ */
  const LOCK_NOTICE_KEY = "guardai_lock_notice_seen";
  let lockedNoticeEl = null;

  function removeLockedNotice() {
    if (lockedNoticeEl) {
      lockedNoticeEl.remove();
      lockedNoticeEl = null;
    }
  }

  function updateLockedNotice() {
    // Locked AND switched on is the only combination that gets a notice.
    if (!state.enabled || state.entitled) return removeLockedNotice();
    if (lockedNoticeEl) return;

    const build = () => {
      if (lockedNoticeEl || !state.enabled || state.entitled) return;
      const el = document.createElement("div");
      el.className = "guardai-locked";
      el.setAttribute("role", "status");
      el.innerHTML =
        `<div class="guardai-locked__head">` +
        `<span class="guardai-locked__shield">${SHIELD_SVG}</span>` +
        `<span class="guardai-locked__title">GuardAI is not active</span>` +
        `<button class="guardai-locked__close" aria-label="Dismiss">&times;</button>` +
        `</div>` +
        `<p class="guardai-locked__body">Nothing is being masked on this page. ` +
        `Enter your licence key or your workplace invite code to switch it on.</p>` +
        `<button class="guardai-locked__ok">Activate GuardAI</button>`;
      document.body.appendChild(el);
      lockedNoticeEl = el;

      // Dismissal is remembered for good. The popup and the settings page both
      // show the locked state permanently, so this is a pointer to them rather
      // than the notification itself — re-showing it on every page load would
      // be nagging someone about a decision they have already made.
      const dismiss = () => {
        removeLockedNotice();
        try {
          chrome.storage.local.set({ [LOCK_NOTICE_KEY]: true }).catch(() => {});
        } catch (_) { /* non-fatal */ }
      };
      el.querySelector(".guardai-locked__close").onclick = dismiss;
      el.querySelector(".guardai-locked__ok").onclick = () => {
        try {
          chrome.runtime.sendMessage({ type: "GUARDAI_OPEN_ACTIVATION" });
        } catch (_) { /* worker asleep — the popup still works */ }
        dismiss();
      };
    };

    try {
      chrome.storage.local.get([LOCK_NOTICE_KEY]).then((d) => {
        if (!d || !d[LOCK_NOTICE_KEY]) build();
      }).catch(() => { /* storage unreadable — say nothing rather than nag */ });
    } catch (_) { /* storage unavailable */ }
  }

  function ensurePanel() {
    // Never show the panel while GuardAI is switched off, no matter which
    // code path got here (boot/soft-nav restoring a saved log, a stray
    // in-flight unmask pass finishing after the toggle, etc.) — the master
    // toggle must mean everything visibly goes away, not just new activity.
    if (!canRestore()) return;
    if (panelEl) {
      panelEl.style.display = "";
      if (reopenEl) reopenEl.style.display = "none";
      return;
    }
    panelEl = document.createElement("div");
    panelEl.className = "guardai-panel";
    panelEl.innerHTML =
      `<div class="guardai-panel__header">` +
      `<span class="guardai-panel__shield">${SHIELD_SVG}</span>` +
      `<span class="guardai-panel__title">GuardAI</span>` +
      `<button class="guardai-panel__close" title="Close" aria-label="Close">&times;</button>` +
      `</div>` +
      `<div class="guardai-panel__toggle">` +
      `<div class="guardai-panel__toggletext">` +
      `<span class="guardai-panel__togglelabel">Auto-restore</span>` +
      `<span class="guardai-panel__togglehint"></span>` +
      `</div>` +
      `<button class="guardai-panel__switch" role="switch"></button>` +
      `</div>` +
      `<div class="guardai-panel__tabs" role="tablist">` +
      `<button class="guardai-panel__tab guardai-panel__tab--active" data-tab="masked" role="tab">Masked</button>` +
      `<button class="guardai-panel__tab" data-tab="message" role="tab">Message</button>` +
      `</div>` +
      `<div class="guardai-panel__body">` +
      `<div class="guardai-panel__pane guardai-panel__pane--active" data-pane="masked">` +
      `<div class="guardai-panel__list"></div>` +
      `</div>` +
      `<div class="guardai-panel__pane" data-pane="message">` +
      `<div class="guardai-panel__msgviews" style="display:none">` +
      `<button class="guardai-panel__msgview guardai-panel__msgview--active" data-msgview="ai">What AI sees</button>` +
      `<button class="guardai-panel__msgview" data-msgview="you">What you see</button>` +
      `</div>` +
      `<div class="guardai-panel__msglegend"></div>` +
      `<p class="guardai-panel__msghint">Highlight any text to manually mask it</p>` +
      `<div class="guardai-panel__editable" contenteditable="true" spellcheck="false"></div>` +
      `<div class="guardai-panel__readview" style="display:none"></div>` +
      `<button class="guardai-panel__apply" style="display:none">Apply changes</button>` +
      `<div class="guardai-panel__msgempty">Nothing to edit yet. Choose <b>Mask &amp; Edit</b> when GuardAI detects sensitive data and your masked message appears here.</div>` +
      `</div>` +
      `</div>` +
      `<div class="guardai-panel__footer">` +
      `<button class="guardai-panel__send" style="display:none">Send</button>` +
      `<button class="guardai-panel__clear">Clear all data</button>` +
      `</div>`;
    document.body.appendChild(panelEl);
    maskedListEl = panelEl.querySelector(".guardai-panel__list");
    msgPaneEl = panelEl.querySelector('[data-pane="message"]');
    msgEditableEl = panelEl.querySelector(".guardai-panel__editable");
    msgLegendEl = panelEl.querySelector(".guardai-panel__msglegend");
    msgEmptyEl = panelEl.querySelector(".guardai-panel__msgempty");
    footerSendEl = panelEl.querySelector(".guardai-panel__send");
    msgApplyEl = panelEl.querySelector(".guardai-panel__apply");
    msgHintEl = panelEl.querySelector(".guardai-panel__msghint");
    msgRealViewEl = panelEl.querySelector(".guardai-panel__readview");
    msgViewTabsEl = panelEl.querySelector(".guardai-panel__msgviews");

    msgEditableEl.addEventListener("mouseup", msgHandleSelection);
    msgEditableEl.addEventListener("mouseover", msgMarkHover);
    // Ctrl/Cmd+Enter in the editable box triggers Apply, just like clicking the button.
    // The event is stopped in the capture phase so the global send interceptor
    // never sees it (the panel editable matches the generic contenteditable selector).
    msgEditableEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        applyMessageEdits();
      } else if (e.key === "Enter" && !e.shiftKey) {
        // Plain Enter: stop it reaching the global send interceptor — just insert
        // a newline via execCommand so free typing still works naturally.
        e.stopImmediatePropagation();
      }
    }, true);
    msgApplyEl.onclick = applyMessageEdits;
    if (msgViewTabsEl) {
      msgViewTabsEl.querySelectorAll(".guardai-panel__msgview").forEach((b) => {
        b.onclick = () => setMsgView(b.getAttribute("data-msgview"));
      });
    }
    panelEl.querySelector(".guardai-panel__close").onclick = closePanel;
    panelEl.querySelector(".guardai-panel__switch").onclick = () =>
      setAutoRestore(!state.autoRestore);
    panelEl.querySelectorAll(".guardai-panel__tab").forEach((tab) => {
      tab.onclick = () => setActiveTab(tab.getAttribute("data-tab"));
    });
    footerSendEl.onclick = panelSend;
    panelEl.querySelector(".guardai-panel__clear").onclick = () => {
      // Deliberately a plain confirm(), not our own styled dialog: this is
      // the one moment where matching the browser's own unmistakable native
      // prompt is more useful than staying on-brand — it can't be missed or
      // misread as just another GuardAI card.
      if (window.confirm("Clear all GuardAI data? This forgets every real<->fake pairing and the activity log. This can't be undone.")) {
        clearSession();
      }
    };
    // Delegate "Reveal real data" clicks for pending rows.
    maskedListEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".guardai-panel__reveal");
      if (!btn) return;
      const id = Number(btn.getAttribute("data-id"));
      const entry = activityLog.find((x) => x.id === id);
      if (entry) {
        entry.revealed = true;
        persistActivity();
        renderPanel();
      }
    });
    // Delegate per-item "forget this one" clicks — the alternative to
    // all-or-nothing Clear session.
    maskedListEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".guardai-panel__itemdel");
      if (!btn) return;
      forgetOneItem(Number(btn.getAttribute("data-id")));
    });
    syncAutoRestoreSwitch();
    setActiveTab(activeTab);
    renderMessageTab();
    updateFooter();
  }

  /** Reflect state.autoRestore on the panel switch (if the panel exists). */
  function syncAutoRestoreSwitch() {
    if (!panelEl) return;
    const sw = panelEl.querySelector(".guardai-panel__switch");
    const hint = panelEl.querySelector(".guardai-panel__togglehint");
    if (sw) {
      sw.setAttribute("aria-checked", state.autoRestore ? "true" : "false");
      sw.classList.toggle("guardai-panel__switch--on", state.autoRestore);
    }
    if (hint) {
      hint.textContent = state.autoRestore
        ? "Responses are swapped back to your real data automatically."
        : "Responses stay masked — click Reveal to see your real data here.";
    }
  }

  /** Toggle auto-restore, persist it, and re-run a pass to apply the change. */
  function setAutoRestore(on) {
    state.autoRestore = on;
    try {
      chrome.storage.local.set({ guardai_auto_restore: on }).catch(() => {});
    } catch {
      /* non-fatal */
    }
    syncAutoRestoreSwitch();
    // Move unpinned messages to the new default view, then re-run a pass so the
    // change is reflected on screen immediately.
    syncMessageViewsToDefault();
    announcedSwaps.clear();
    scheduleUnmask();
  }

  /* Deleting the user's history must have exactly one reachable trigger: the
   * "Clear session" button below. A second, unreferenced clearActivityLog()
   * used to sit here — dead code whose only effect was wiping stored activity,
   * one stray call site away from becoming a data-loss bug. Removed rather
   * than left lying around; git has it if a "clear log but keep the mapping"
   * feature is ever actually wanted. */

  /**
   * Flip every currently-restored real value on the page back to its fake
   * stand-in, using the mapping as it stands RIGHT NOW — must run BEFORE the
   * mapping that backs those values is dropped, or there's nothing left to
   * build the swap from. This is the visible proof that clearing actually
   * did something: without it, the page just kept showing whatever it was
   * already showing (usually the restored real data), so a mapping clear
   * looked like it silently did nothing, even though the storage/table really
   * was wiped underneath it.
   */
  function remaskVisiblePage() {
    if (masker.size === 0) return; // nothing currently mapped to remask
    const root = findResponseRoot();
    applyRules(root, buildSwapRules("remask"));
    // The mapping backing them is going away, so the toggle buttons (which
    // only make sense when there's a real fake<->real pair to flip between)
    // and any "always show me the real value" pins are now stale.
    removeMessageToggles();
    root.querySelectorAll("[data-guardai-lock]").forEach((el) => el.removeAttribute("data-guardai-lock"));
  }

  /** Full reset: wipe the fake<->real mapping AND the log so the user starts fresh.
   * The ONLY code path in the extension that deletes activity history. */
  function clearSession() {
    remaskVisiblePage(); // show the fake values as visible proof, before the mapping goes
    masker.clear().catch(() => {}); // drops the mapping + its storage key
    activityLog = [];
    loggedKeys.clear();
    announcedSwaps.clear();
    state.lastMaskedText = null;
    review = null;
    sentReview = null;
    try {
      chrome.storage.local.set({ [ACTIVITY_KEY]: [] }).catch(() => {});
    } catch {
      /* non-fatal */
    }
    renderPanel();
    if (reopenEl) reopenEl.querySelector(".guardai-reopen__count").textContent = "0";
  }

  /**
   * Forget exactly ONE previously-masked item — the "pick which ones to
   * delete" alternative to the all-or-nothing Clear session. Mirrors
   * clearSession()'s "remask before forgetting" order on a single value:
   * flips it back to fake anywhere it's currently shown as real, THEN drops
   * the pairing that made that swap possible, then removes every log row
   * for that pair (not just the "Masked" row clicked — its "Restored"/
   * "Revealed" echoes reference a mapping that's about to stop existing).
   */
  function forgetOneItem(id) {
    const entry = activityLog.find((x) => x.id === id && x.kind === "mask");
    if (!entry) return;
    const { real, fake } = entry;
    const mapped = masker.realToFake.get(real);
    if (mapped && mapped.fake === fake) {
      const tokens = real.split(/\s+/).filter(Boolean).map(escapeRegExp);
      const re = new RegExp("(?<![A-Za-z0-9])" + tokens.join("[\\s,]+") + "(?![A-Za-z0-9])", "g");
      applyRules(findResponseRoot(), [{ key: real, to: fake, entry: mapped, multi: tokens.length > 1, re }]);
      masker.unregister(real);
      masker.save().catch(() => {});
    }
    activityLog = activityLog.filter((x) => !(x.fake === fake && x.real === real));
    for (const kind of ["mask", "unmask", "pending"]) loggedKeys.delete(kind + "|" + fake + "|" + real);
    persistActivity();
    renderPanel();
  }

  function closePanel() {
    panelClosed = true;
    if (panelEl) panelEl.style.display = "none";
    showReopen();
  }

  function showReopen() {
    // Same invariant as ensurePanel(): the collapsed badge must never appear
    // while GuardAI is off.
    if (!canRestore()) return;
    if (!reopenEl) {
      reopenEl = document.createElement("button");
      reopenEl.className = "guardai-reopen";
      reopenEl.setAttribute("aria-label", "Open GuardAI activity");
      reopenEl.innerHTML =
        `<span class="guardai-reopen__shield">${SHIELD_SVG}</span>` +
        `<span class="guardai-reopen__count"></span>`;
      reopenEl.onclick = () => {
        panelClosed = false;
        reopenEl.style.display = "none";
        ensurePanel();
        renderMessageTab();
        renderPanel();
      };
      document.body.appendChild(reopenEl);
    }
    reopenEl.querySelector(".guardai-reopen__count").textContent = String(activityLog.length);
    reopenEl.style.display = "";
  }

  function renderPanel() {
    if (!maskedListEl) return;
    if (!activityLog.length) {
      maskedListEl.innerHTML =
        `<div class="guardai-panel__empty">No activity yet. When you mask data or ` +
        `GuardAI restores a response, it appears here.</div>`;
      return;
    }
    // Newest first, capped to the most recent 20 so the log never stacks endlessly.
    maskedListEl.innerHTML = activityLog
      .slice(-20)
      .reverse()
      .map((it) => {
        // Pending = auto-restore is off; the response still shows the fake and
        // the user reveals the real value here, on demand, per item.
        if (it.kind === "pending" && !it.revealed) {
          return (
            `<div class="guardai-panel__row guardai-panel__row--pending">` +
            `<div class="guardai-panel__rowhead">` +
            `<span class="guardai-panel__tag">In response</span>` +
            `<span class="guardai-panel__type">${escapeHtml(it.type || "")}</span>` +
            `</div>` +
            `<div class="guardai-panel__swap">` +
            `<span class="guardai-panel__from guardai-panel__from--fake">${escapeHtml(it.fake)}</span>` +
            `</div>` +
            `<button class="guardai-panel__reveal" data-id="${it.id}">Reveal real data</button>` +
            `</div>`
          );
        }

        const isMask = it.kind === "mask";
        const from = isMask ? it.real : it.fake;
        const to = isMask ? it.fake : it.real;
        const tag = isMask ? "Masked" : it.kind === "pending" ? "Revealed" : "Restored";
        const cls = isMask
          ? "guardai-panel__row--mask"
          : "guardai-panel__row--unmask";
        // "Restored" gets its own modifier class so it (and only it, not the
        // "Revealed" tag that shares the same row/kind styling) can be
        // coloured green — a quick-scan signal that a swap was successfully
        // protected and restored.
        const tagCls = tag === "Restored" ? "guardai-panel__tag guardai-panel__tag--restored" : "guardai-panel__tag";
        // Only a "Masked" row represents one independently-forgettable piece
        // of data (a live real<->fake pair); "Restored"/"Revealed" rows are
        // just log echoes of that same pair being unmasked elsewhere, not a
        // separate thing to delete. Deleting the Masked row is what actually
        // makes GuardAI forget that value — this is the answer to "let me
        // pick which ones to delete" instead of only an all-or-nothing Clear.
        const delBtn = isMask
          ? `<button class="guardai-panel__itemdel" data-id="${it.id}" title="Forget this item" aria-label="Forget this item">&times;</button>`
          : "";
        return (
          `<div class="guardai-panel__row ${cls}">` +
          `<div class="guardai-panel__rowhead">` +
          `<span class="${tagCls}">${tag}</span>` +
          `<span class="guardai-panel__type">${escapeHtml(it.type || "")}</span>` +
          delBtn +
          `</div>` +
          `<div class="guardai-panel__swap">` +
          `<span class="guardai-panel__from">${escapeHtml(from)}</span>` +
          `<span class="guardai-panel__arrow">&rarr;</span>` +
          `<span class="guardai-panel__to">${escapeHtml(to)}</span>` +
          `</div>` +
          `</div>`
        );
      })
      .join("");
    if (reopenEl) reopenEl.querySelector(".guardai-reopen__count").textContent = String(activityLog.length);
  }

  /* ------------------------------------------------------------------ *
   * Send interception.
   * We intercept BOTH the Enter key and clicks on the send button, in the
   * capture phase, so we run before the site's own handlers. If we decide to
   * block, we stopImmediatePropagation + preventDefault, then later re-trigger
   * the original send programmatically once the user has chosen.
   * ------------------------------------------------------------------ */

  let bypassNext = false; // set true to allow the very next send through untouched

  // HARD send-suppression for the mask flow. While true, NO message can leave the
  // page through ANY pathway — raw Enter, send-button click, <form> submit, OR an
  // editor that turns a beforeinput "insertParagraph" into a submit. This is the
  // definitive block for two bugs: (1) a long multi-line fill splitting into
  // several messages because the editor submits mid-fill, and (2) Mask & Edit
  // "auto-sending" because a fill operation tripped the editor's submit even
  // though doMaskAndEdit never calls triggerSend. It is set ONLY around the fill
  // and cleared the instant the fill is done (Mask & Send clears it just before
  // its single intentional send), so it can never lock the user out of sending.
  let suppressSends = false;

  function diag(...args) {
    console.log("[GuardAI][diag]", ...args);
  }

  async function handleSendAttempt(editor) {
    if (!isActive()) return true; // off or unlicensed -> never block a send

    const text = getEditorText(editor).trim();
    if (!text) return true;

    // If this is the exact masked text we just typed in, the user is sending
    // it themselves — let it through untouched (don't re-scan/re-mask). The
    // review persists so the MESSAGE tab still reflects what was sent.
    if (state.lastMaskedText && normalize(text) === normalize(state.lastMaskedText)) {
      state.lastMaskedText = null;
      return true;
    }

    const findings = await scanText(text);

    // Nothing sensitive -> let it fly.
    if (!findings.length) return true;

    reportStats({ detected: findings.length });

    // "Masking mode" (silent mode): skip the warning card entirely and mask +
    // send automatically, with no visible interruption on the happy path.
    // Any failure/uncertainty still falls back to the normal, fully-visible
    // warning card below — silent mode only ever silences a CONFIRMED-safe
    // send, never an uncertain one.
    // Aggressive name detection, MEDIUM confidence: show the card even in
    // silent mode. Not a new rule — the existing one applied consistently.
    // Silent mode "only ever silences a CONFIRMED-safe send", and a
    // medium-confidence standalone name is uncertain by construction: the
    // gazetteer did not vouch for the surname. Left silent, a false positive
    // rewrites something like "Sydney Airport" into a person's name and sends
    // it with nothing on screen to explain the degraded reply. HIGH-confidence
    // matches (both names in the gazetteer) stay silent like anything else.
    const uncertainName = findings.some((f) => f.aggressive && f.severity !== "high");
    if (state.maskingEnabled && !uncertainName) {
      const ok = await doMaskAndSend(editor, text, findings, { silent: true });
      if (ok === false) {
        showWarning(editor, text, findings, makeResender(editor));
      }
      return false;
    }

    // Educate first: show the warning popup listing each detected item, the
    // category, and WHY it's risky on this platform. From there the user picks
    // Mask & Send, Mask & Edit, Manual mask, or Send anyway (or the × to
    // dismiss without sending). We block this raw send.
    showWarning(editor, text, findings, makeResender(editor));
    return false;
  }

  /** Programmatically trigger the site's send (Enter on the editor). */
  function makeResender(editor) {
    // Route through the same robust sender used after masking, so it waits for
    // an enabled send button before clicking (with a synthetic-Enter fallback).
    return function resend() {
      triggerSend(editor);
    };
  }

  // ---- beforeinput guard (capture phase) — the key fix for split/auto-send ----
  // ProseMirror/Lexical apply our execCommand edits via beforeinput. A soft line
  // break we insert shows up as inputType "insertLineBreak" (safe). A SUBMIT —
  // whether from a real Enter mid-fill or the editor translating something into a
  // paragraph — shows up as "insertParagraph". While the mask flow is filling, we
  // block ONLY "insertParagraph": this stops the message ever being submitted
  // mid-fill (no split, no Mask & Edit auto-send) while leaving our soft line
  // breaks intact so the table formatting is preserved.
  document.addEventListener(
    "beforeinput",
    (e) => {
      if (!suppressSends) return;
      diag("beforeinput during fill — inputType:", e.inputType, "isTrusted:", e.isTrusted);
      if (e.inputType === "insertParagraph") {
        e.preventDefault();
        e.stopImmediatePropagation();
        diag("BLOCKED insertParagraph (would submit) during mask flow");
      }
    },
    true
  );

  // ---- <form> submit guard (capture phase) ----
  // Belt-and-suspenders: if the editor's composer is wrapped in a form and tries
  // to submit during the fill, stop it. The single intentional send happens only
  // after suppressSends is cleared.
  document.addEventListener(
    "submit",
    (e) => {
      if (!suppressSends) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      diag("BLOCKED form submit during mask flow");
    },
    true
  );

  // ---- Enter key interception (capture phase) ----
  document.addEventListener(
    "keydown",
    async (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      if (!isActive()) return; // off or unlicensed — never intercept the send
      // During the mask flow's fill, block EVERY Enter outright (a stray user
      // Enter mid-fill must not submit a partial message). Cleared as soon as the
      // fill is done, so this never blocks a normal send.
      if (suppressSends && !bypassNext) {
        e.preventDefault();
        e.stopImmediatePropagation();
        diag("BLOCKED Enter during mask flow");
        return;
      }
      // Never intercept keystrokes from inside GuardAI's own panel or overlays.
      if (e.target && typeof e.target.closest === "function" &&
          e.target.closest(".guardai-panel, .guardai-prompt, .guardai-msgpop, .guardai-marktip")) return;
      // Resolve the editor the user is actually typing in (not just the first
      // match on the page) so multi-editor / re-rendered layouts still intercept.
      const editor = findEditorFor(e.target) || findEditor();
      if (!editor || !isWithin(e.target, editor)) return;

      if (bypassNext) {
        bypassNext = false;
        return; // this is our own re-send, let it pass
      }

      // Hold the event while we scan asynchronously.
      e.preventDefault();
      e.stopImmediatePropagation();

      const allow = await handleSendAttempt(editor);
      if (allow) {
        bypassNext = true;
        makeResender(editor)();
      }
    },
    true
  );

  // ---- Send-button interception (capture phase) ----
  document.addEventListener(
    "click",
    async (e) => {
      const btn = e.target.closest(CONFIG.sendButton.join(","));
      if (!btn) return;
      if (!isActive()) return; // off or unlicensed — never intercept the send
      // Never intercept clicks inside GuardAI's own UI.
      if (btn.closest(".guardai-panel, .guardai-prompt")) return;
      // During the mask flow's fill, block site send-button clicks too.
      if (suppressSends && !bypassNext) {
        e.preventDefault();
        e.stopImmediatePropagation();
        diag("BLOCKED send-button click during mask flow");
        return;
      }

      if (bypassNext) {
        bypassNext = false;
        return;
      }

      const editor = findEditor();
      if (!editor) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      const allow = await handleSendAttempt(editor);
      if (allow) {
        bypassNext = true;
        makeResender(editor)();
      }
    },
    true
  );

  function isWithin(node, container) {
    return node === container || container.contains(node);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /** Show a brief error banner so the user sees failures without opening DevTools. */
  function showErrorToast(msg) {
    const t = document.createElement("div");
    t.className = "guardai-toast guardai-toast--error";
    t.textContent = "\u26A0\uFE0F GuardAI: " + msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 6000);
  }

  /* ------------------------------------------------------------------ *
   * "Did we miss anything?" review — lives in the side panel.
   * On send we auto-mask everything detected and type the masked text into the
   * input. This section then shows the user's ORIGINAL message with every
   * masked item highlighted in a per-type colour, and lets them mask anything
   * we missed by selecting it. A manual mask re-types the input field in real
   * time. The user reviews and presses send themselves. No overlay, nothing is
   * sent automatically. Detection, masking and auto-restore are reused as-is.
   * ------------------------------------------------------------------ */
  const MARK_STYLE = {
    NAME_PII: { label: "Name", color: "#6B9FFF" },
    ORG: { label: "Company", color: "#4DD0E1" },
    PHONE: { label: "Phone", color: "#FF8C42" },
    EMAIL: { label: "Email", color: "#4CAF82" },
    ADDRESS: { label: "Address", color: "#B06FFF" },
    DOB: { label: "Date of birth", color: "#FFD166" },
    PASSPORT: { label: "Passport", color: "#FF6B6B" },
    LICENCE: { label: "Licence", color: "#FF6B6B" },
    MEDICARE: { label: "Medicare", color: "#FF6B6B" },
    TFN: { label: "TFN", color: "#FF6B6B" },
    CREDIT_CARD: { label: "Card number", color: "#FF6B6B" },
    BSB: { label: "BSB", color: "#FF6B6B" },
    BANK_ACCOUNT: { label: "Bank account", color: "#FF6B6B" },
    REF_CODE: { label: "Account / reference", color: "#FF6B6B" },
    MONEY: { label: "Amount", color: "#FFD166" },
    GPS: { label: "GPS", color: "#B06FFF" },
    ABN: { label: "ABN", color: "#FF6B6B" },
    ACN: { label: "ACN", color: "#FF6B6B" },
    PASSWORD: { label: "Password", color: "#FF6B6B" },
    USERNAME: { label: "Username", color: "#FFA94D" },
  };
  const MARK_DEFAULT = { label: "Sensitive", color: "#FFD166" };
  const MARK_MANUAL = { label: "Manual", color: "#FF8FB1" };

  // Active review state: { editor, original, items[], fakeByReal }.
  // items: [{ start, end, value, type, manual, fake }]. Items added manually in
  // the MESSAGE tab use start/end of -1 (their position lives in the DOM).
  let review = null;
  // Snapshot of the last successfully sent review, kept so the Message tab
  // remains populated after sending (soft-nav clears `review` but not this).
  // Cleared only by clearSession().
  let sentReview = null;
  let msgPending = null; // { range: Range, value: string } awaiting auto/custom replace
  let msgPop = null; // the auto/custom replace popup element

  function markStyle(type, manual) {
    return MARK_STYLE[type] || (manual ? MARK_MANUAL : MARK_DEFAULT);
  }

  /* ---- Educational warning popup above the input ----
   * The first thing the user sees on detection. It lists each detected item by
   * category, explains in plain English WHY each is risky on this platform, and
   * offers four choices: Mask & Send, Mask & Edit, Manual mask, Send anyway
   * (plus the × in the header to dismiss without sending). This is the
   * teaching moment that makes GuardAI useful for non-technical users. */

  function showWarning(editor, text, findings, resend) {
    dismissMaskPrompt();

    // Group findings by type so the list shows one row per category, with a
    // count and the shared "why it's risky" reason.
    const groups = {};
    for (const f of findings) {
      const g =
        groups[f.type] ||
        (groups[f.type] = { label: f.label, reason: f.reason, items: [] });
      g.items.push(f.value);
    }

    const wrap = document.createElement("div");
    wrap.className = "guardai-prompt guardai-prompt--warn";
    wrap.setAttribute("role", "alertdialog");
    wrap.setAttribute("aria-live", "polite");

    const rows = Object.keys(groups)
      .map((key) => {
        const g = groups[key];
        return (
          `<li class="guardai-prompt__item">` +
          `<div class="guardai-prompt__itemhead">` +
          `<span class="guardai-prompt__cat">${escapeHtml(g.label)}</span>` +
          `<span class="guardai-prompt__count">${g.items.length}</span>` +
          `</div>` +
          (g.reason
            ? `<p class="guardai-prompt__why">${escapeHtml(g.reason)}</p>`
            : "") +
          `</li>`
        );
      })
      .join("");

    wrap.innerHTML =
      `<div class="guardai-prompt__grip" title="Drag to move" aria-label="Drag to move"></div>` +
      `<div class="guardai-prompt__head">` +
      `<span class="guardai-prompt__shield">${SHIELD_SVG}</span>` +
      `<span class="guardai-prompt__text">GuardAI detected sensitive data</span>` +
      `<button class="guardai-prompt__close" aria-label="Dismiss">&times;</button>` +
      `</div>` +
      `<p class="guardai-prompt__platform">Sending to ${escapeHtml(
        CONFIG.name
      )}: ${escapeHtml(CONFIG.note || "")}</p>` +
      `<ul class="guardai-prompt__list">${rows}</ul>` +
      `<div class="guardai-prompt__btns">` +
      `<button class="guardai-act guardai-act--primary guardai-prompt__btn guardai-prompt__btn--send">Mask &amp; Send</button>` +
      `<button class="guardai-act guardai-act--secondary guardai-prompt__btn guardai-prompt__btn--edit">Mask &amp; Edit</button>` +
      `</div>` +
      `<div class="guardai-prompt__btns guardai-prompt__btns--secondary">` +
      `<button class="guardai-act guardai-act--secondary guardai-prompt__btn guardai-prompt__btn--manual">Manual mask</button>` +
      `<button class="guardai-act guardai-act--danger guardai-prompt__btn guardai-prompt__btn--anyway">Send anyway</button>` +
      `</div>`;
    document.body.appendChild(wrap);
    maskPromptEl = wrap;

    wrap.querySelector(".guardai-prompt__close").onclick = () => {
      console.log("[GuardAI] ✕ Close clicked — dismissing popup");
      dismissMaskPrompt();
      const live = editor && document.contains(editor) ? editor : findEditor();
      if (live) live.focus();
    };
    wrap.querySelector(".guardai-prompt__btn--anyway").onclick = () => {
      console.log("[GuardAI] Send Anyway clicked — sending original unmasked text");
      dismissMaskPrompt();
      reportStats({ sentUnmasked: 1 });
      resend();
    };
    wrap.querySelector(".guardai-prompt__btn--send").onclick = () => {
      console.log("[GuardAI] Mask & Send clicked — starting mask flow");
      dismissMaskPrompt();
      doMaskAndSend(editor, text, findings).catch((err) => {
        console.error("[GuardAI] Mask & Send failed:", err);
        showErrorToast("Mask & Send failed — please reload the page and try again.");
      });
    };
    wrap.querySelector(".guardai-prompt__btn--edit").onclick = () => {
      console.log("[GuardAI] Mask & Edit clicked — starting mask+review flow");
      dismissMaskPrompt();
      doMaskAndEdit(editor, text, findings).catch((err) => {
        console.error("[GuardAI] Mask & Edit failed:", err);
        showErrorToast("Mask & Edit failed — please reload the page and try again.");
      });
    };
    wrap.querySelector(".guardai-prompt__btn--manual").onclick = () => {
      console.log("[GuardAI] Manual mask clicked — opening panel with unmasked message");
      dismissMaskPrompt();
      doManualMask(editor, text).catch((err) => {
        console.error("[GuardAI] Manual mask failed:", err);
        showErrorToast("Manual mask failed — please reload the page and try again.");
      });
    };

    // Centre the popup horizontally and place it slightly above the middle of
    // the viewport, so it's always fully visible no matter where the input is.
    centrePrompt(wrap);
    makePromptDraggable(wrap);

    // Keep it centred on resize — but only until the user drags it, after which
    // it stays exactly where they put it for the rest of the session.
    const reposition = () => {
      if (!wrap._dragged) centrePrompt(wrap);
    };
    window.addEventListener("resize", reposition, true);

    // Keyboard support: Escape dismisses (same as the × close button), and the safe primary
    // action (Mask & Send) is focused on open so a keyboard user can accept the
    // common case with a single Enter. Tab cycles the buttons natively.
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        dismissMaskPrompt();
        const live = editor && document.contains(editor) ? editor : findEditor();
        if (live) live.focus();
      }
    };
    wrap.addEventListener("keydown", onKey);
    // Focus the primary button after layout settles (rAF avoids the browser
    // scrolling the page to the freshly-inserted node before it's positioned).
    requestAnimationFrame(() => {
      const primary = wrap.querySelector(".guardai-prompt__btn--send");
      if (primary) primary.focus({ preventScroll: true });
    });

    wrap._cleanup = () => {
      window.removeEventListener("resize", reposition, true);
      wrap.removeEventListener("keydown", onKey);
    };
  }

  /** Centre horizontally, sit at ~1/3 from the top of the viewport, clamped. */
  function centrePrompt(el) {
    const w = el.offsetWidth || 400;
    const h = el.offsetHeight || 320;
    let left = (window.innerWidth - w) / 2;
    // Position the TOP of the popup at 1/3 of the viewport height, so the user
    // can still see their message in the input below it.
    let top = Math.round(window.innerHeight / 3) - Math.round(h / 4);
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    el.style.left = left + "px";
    el.style.top = top + "px";
  }

  /**
   * Let the user drag a popup by its grip/header; it stays where dropped.
   *
   * Takes the handle selectors rather than hardcoding them so the file card can
   * reuse this. That card re-renders its whole body between states, so it calls
   * this again after each render — hence `el._dragged` living on the element
   * rather than in here: it has to survive the handlers being rebuilt, or a
   * card the user moved would snap back to centre the moment it changed state.
   */
  function makePromptDraggable(el, opts) {
    const o = opts || {};
    const grip = o.grip || ".guardai-prompt__grip";
    const head = o.head || ".guardai-prompt__head";
    const draggingClass = o.draggingClass || "guardai-prompt--dragging";
    const handles = [el.querySelector(grip), el.querySelector(head)].filter(Boolean);
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;

    const onMove = (e) => {
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      const y = e.touches ? e.touches[0].clientY : e.clientY;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let left = baseLeft + (x - startX);
      let top = baseTop + (y - startY);
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
      el.style.left = left + "px";
      el.style.top = top + "px";
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      document.removeEventListener("touchmove", onMove, true);
      document.removeEventListener("touchend", onUp, true);
      el.classList.remove(draggingClass);
    };
    const onDown = (e) => {
      // Don't start a drag from the close button or any control.
      if (e.target.closest("button, input")) return;
      const pt = e.touches ? e.touches[0] : e;
      startX = pt.clientX;
      startY = pt.clientY;
      const rect = el.getBoundingClientRect();
      baseLeft = rect.left;
      baseTop = rect.top;
      el._dragged = true;
      el.classList.add(draggingClass);
      e.preventDefault();
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
      document.addEventListener("touchmove", onMove, { capture: true, passive: false });
      document.addEventListener("touchend", onUp, true);
    };

    for (const h of handles) {
      h.addEventListener("mousedown", onDown, true);
      h.addEventListener("touchstart", onDown, { capture: true, passive: false });
    }
  }

  function dismissMaskPrompt() {
    if (maskPromptEl) {
      if (maskPromptEl._cleanup) maskPromptEl._cleanup();
      maskPromptEl.remove();
      maskPromptEl = null;
    }
  }

  /* ---- MESSAGE tab: editable masked message + manual masking ---- */

  /**
   * Rebuild the editable MESSAGE pane from the review model: plain text from the
   * original, with each auto-masked item shown as a coloured (non-editable) mark
   * carrying its fake value. Free typing and manual selection-masks then mutate
   * this DOM directly; innerText is the source of truth on send.
   */
  function renderMessageTab() {
    if (!msgEditableEl) return;
    // Use `review` if active; fall back to `sentReview` so the tab stays
    // populated after a successful send (when soft-nav clears `review`).
    const activeReview = review || sentReview;
    const positioned = activeReview
      ? activeReview.items.filter((it) => it.start >= 0).sort((a, b) => a.start - b.start)
      : [];
    // Show empty state only when there is genuinely no content to display.
    // A review with zero items but original text (Manual mask mode) still
    // has content to show — the original message waiting for user highlights.
    const hasContent = !!(activeReview && activeReview.original);
    if (!hasContent) {
      msgEditableEl.innerHTML = "";
      msgEditableEl.style.display = "none";
      if (msgHintEl) msgHintEl.style.display = "none";
      if (msgRealViewEl) {
        msgRealViewEl.innerHTML = "";
        msgRealViewEl.style.display = "none";
      }
      if (msgViewTabsEl) msgViewTabsEl.style.display = "none";
      if (msgEmptyEl) msgEmptyEl.style.display = "";
      if (msgLegendEl) msgLegendEl.innerHTML = "";
      if (msgApplyEl) msgApplyEl.style.display = "none";
      hideMarkTip();
      return;
    }
    if (msgEmptyEl) msgEmptyEl.style.display = "none";
    // In the sent (read-only) state the editable hint is not relevant.
    if (msgHintEl) msgHintEl.style.display = review ? "" : "none";

    // "What AI sees": surrounding real text + marks showing the fake, with the
    // real value as a small grey caption underneath each mark.
    const out = [];
    let cursor = 0;
    for (const it of positioned) {
      if (it.start > cursor) out.push(escapeHtml(activeReview.original.slice(cursor, it.start)));
      out.push(markHtml(it));
      cursor = it.end;
    }
    if (cursor < activeReview.original.length) out.push(escapeHtml(activeReview.original.slice(cursor)));
    // Append any manual (start<0) items that aren't part of the original text run.
    for (const it of activeReview.items) {
      if (it.start < 0) out.push(" " + markHtml(it));
    }
    msgEditableEl.innerHTML = out.join("");

    buildReadView();
    renderMsgLegend();
    applyMsgView();
  }

  /**
   * Build the read-only "What you see" view by transforming the editable's
   * current DOM: every mark shows its REAL value with the coloured highlight,
   * and nothing underneath. Derived from the editable so it always matches the
   * live message (including free edits and in-place manual masks).
   */
  function buildReadView() {
    if (!msgRealViewEl || !msgEditableEl) return;
    const clone = msgEditableEl.cloneNode(true);
    clone.querySelectorAll(".guardai-panel__mark").forEach((m) => {
      const real = m.getAttribute("data-real") || "";
      m.textContent = real;
      // Neither view carries a caption any more (see markHtml). Kept as a
      // cheap guarantee that a stray data-sub from anywhere can never render
      // the FAKE underneath the real text in this view.
      m.removeAttribute("data-sub");
    });
    msgRealViewEl.innerHTML = clone.innerHTML;
  }

  /** Switch between the "What AI sees" (editable) and "What you see" views. */
  function setMsgView(v) {
    msgView = v === "you" ? "you" : "ai";
    applyMsgView();
  }

  /** Apply the current msgView: toggle which view is visible + the sub-tabs. */
  function applyMsgView() {
    const activeReview = review || sentReview;
    // hasContent: true when there's text to show (including zero-item Manual mask mode).
    const hasContent = !!(activeReview && activeReview.original);
    // isEditable: live review is active (user can still type / highlight-mask).
    const isEditable = !!(review);
    if (msgViewTabsEl) {
      msgViewTabsEl.style.display = hasContent ? "" : "none";
      msgViewTabsEl.querySelectorAll(".guardai-panel__msgview").forEach((b) => {
        b.classList.toggle(
          "guardai-panel__msgview--active",
          b.getAttribute("data-msgview") === msgView
        );
      });
    }
    const showYou = msgView === "you";
    if (msgEditableEl) {
      msgEditableEl.style.display = hasContent && !showYou ? "" : "none";
      // Make read-only when showing the sent snapshot (no live review to edit).
      msgEditableEl.contentEditable = isEditable ? "true" : "false";
    }
    if (msgRealViewEl) msgRealViewEl.style.display = hasContent && showYou ? "" : "none";
    // Hint and Apply only apply to the live editable "What AI sees" view.
    if (msgHintEl) msgHintEl.style.display = isEditable && !showYou ? "" : "none";
    if (msgApplyEl) msgApplyEl.style.display = isEditable && !showYou ? "" : "none";
    hideMarkTip();
  }

  /**
   * Build the HTML for a masked item in the "What AI sees" editable: the mark
   * shows the FAKE, and nothing else.
   *
   * It used to carry the real value as a small grey caption underneath. That
   * is the one view whose entire job is to show only what leaves the browser,
   * and the real value sitting under every mark both undermined that and
   * duplicated the "What you see" tab an inch to the right. buildReadView()
   * had already dropped the mirror-image caption from that tab; this brings
   * the two into line.
   *
   * data-real and data-fake are still carried so the hover tooltip (Remove
   * mask / Change replacement) can act on the item, and innerText still
   * equals the fake, so sends stay masked.
   */
  function markHtml(it) {
    const st = markStyle(it.type, it.manual);
    const secret = it.type === "PASSWORD" ? " guardai-panel__mark--secret" : "";
    return (
      `<mark class="guardai-panel__mark${secret}" contenteditable="false" ` +
      `data-type="${escapeHtml(it.type)}" data-real="${escapeHtml(it.value)}" ` +
      `data-fake="${escapeHtml(it.fake)}" style="--mk:${st.color}">` +
      escapeHtml(it.fake) +
      `</mark>`
    );
  }

  /* ---- Hover tooltip: remove a mask or change its replacement ---- */

  /** On hover over a mark in the editable, offer Remove mask / Change replacement. */
  function msgMarkHover(e) {
    if (!review && !sentReview) return;
    const mark = e.target && e.target.closest && e.target.closest(".guardai-panel__mark");
    if (!mark || !msgEditableEl.contains(mark)) return;
    showMarkTip(mark);
  }

  function showMarkTip(mark) {
    if (markTipFor === mark && markTipEl) {
      clearTimeout(markTipHideT);
      return;
    }
    hideMarkTip();
    markTipFor = mark;
    const tip = document.createElement("div");
    tip.className = "guardai-review-pop guardai-mark-tip";
    tip.innerHTML =
      `<button class="guardai-review-pop__btn" data-act="remove">Remove mask</button>` +
      `<button class="guardai-review-pop__btn" data-act="change">Change replacement</button>`;
    document.body.appendChild(tip);
    markTipEl = tip;
    tip.querySelector('[data-act="remove"]').onclick = () => removeMark(mark);
    tip.querySelector('[data-act="change"]').onclick = () => changeMarkUI(mark);
    tip.addEventListener("mouseenter", () => clearTimeout(markTipHideT));
    tip.addEventListener("mouseleave", scheduleHideMarkTip);
    mark.addEventListener("mouseleave", scheduleHideMarkTip);
    positionMarkTip(tip, mark.getBoundingClientRect());
  }

  function positionMarkTip(tip, rect) {
    const w = tip.offsetWidth || 220;
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = rect.top - (tip.offsetHeight || 40) - 8;
    if (top < 8) top = rect.bottom + 8;
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  function scheduleHideMarkTip() {
    clearTimeout(markTipHideT);
    markTipHideT = setTimeout(hideMarkTip, 220);
  }

  function hideMarkTip() {
    clearTimeout(markTipHideT);
    if (markTipEl) {
      markTipEl.remove();
      markTipEl = null;
    }
    markTipFor = null;
  }

  /** "Remove mask": restore the real value in place and forget the mapping. */
  async function removeMark(mark) {
    if (!review || !mark) return;
    const real = mark.getAttribute("data-real");
    const oldFake = mark.getAttribute("data-fake") || mark.textContent;
    hideMarkTip();
    // Restore the real text where the mark was.
    if (mark.parentNode) {
      mark.parentNode.replaceChild(document.createTextNode(real), mark);
    }
    // Drop one matching item from the model.
    const i = review.items.findIndex((it) => it.value === real);
    if (i >= 0) review.items.splice(i, 1);
    // If nothing else uses this value, forget the mapping entirely.
    if (!review.items.some((it) => it.value === real)) {
      if (review.fakeByReal) review.fakeByReal.delete(real);
      masker.unregister(real);
      await masker.save();
    }
    removeActivityByFake(oldFake);
    buildReadView();
    renderMsgLegend();
    renderPanel();
    await syncLiveInput();
  }

  /** "Change replacement": swap the tooltip for an input to type a new fake. */
  function changeMarkUI(mark) {
    if (!markTipEl) showMarkTip(mark);
    const tip = markTipEl;
    if (!tip) return;
    clearTimeout(markTipHideT);
    const current = mark.getAttribute("data-fake") || mark.textContent;
    tip.innerHTML =
      `<input class="guardai-review-pop__input" type="text" placeholder="New replacement" />` +
      `<button class="guardai-review-pop__btn guardai-review-pop__go" data-act="go">Apply</button>`;
    const input = tip.querySelector(".guardai-review-pop__input");
    input.value = current;
    const commit = () => {
      const v = input.value.trim();
      if (v) applyMarkChange(mark, v);
    };
    tip.querySelector('[data-act="go"]').onclick = commit;
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        hideMarkTip();
      }
    });
    input.focus();
    input.select();
    positionMarkTip(tip, mark.getBoundingClientRect());
  }

  /** Re-point a mark to a new fake value and refresh everything that shows it. */
  async function applyMarkChange(mark, newFake) {
    if (!review || !mark) return;
    const real = mark.getAttribute("data-real");
    const type = mark.getAttribute("data-type") || "CUSTOM";
    const oldFake = mark.getAttribute("data-fake") || mark.textContent;
    hideMarkTip();
    if (newFake === oldFake) return;
    masker.unregister(real);
    masker.registerManual(real, newFake, type);
    await masker.save();
    // Update the live mark in the editable.
    mark.textContent = newFake;
    mark.setAttribute("data-fake", newFake);
    // Update the model + the MASKED tab.
    for (const it of review.items) {
      if (it.value === real) it.fake = newFake;
    }
    if (review.fakeByReal) review.fakeByReal.set(real, newFake);
    removeActivityByFake(oldFake);
    logActivity("mask", [{ type, real, fake: newFake }]);
    buildReadView();
    renderMsgLegend();
    renderPanel();
    await syncLiveInput();
  }

  /** Remove the MASKED-tab activity entries for a fake (when un/re-masking). */
  function removeActivityByFake(fake) {
    const gone = activityLog.filter((e) => e.kind === "mask" && e.fake === fake);
    if (!gone.length) return;
    activityLog = activityLog.filter((e) => !(e.kind === "mask" && e.fake === fake));
    for (const e of gone) loggedKeys.delete(e.kind + "|" + e.fake + "|" + e.real);
    persistActivity();
  }

  function renderMsgLegend() {
    if (!msgLegendEl) return;
    const seen = new Map();
    const activeReview = review || sentReview;
    if (activeReview) {
      for (const it of activeReview.items) {
        const st = markStyle(it.type, it.manual);
        if (!seen.has(st.label)) seen.set(st.label, st.color);
      }
    }
    msgLegendEl.innerHTML = Array.from(seen.entries())
      .map(
        ([label, color]) =>
          `<span class="guardai-panel__legenditem">` +
          `<span class="guardai-panel__dot" style="background:${color}"></span>` +
          escapeHtml(label) +
          `</span>`
      )
      .join("");
  }

  /** On a selection inside the editable, offer to mask the highlighted text. */
  function msgHandleSelection() {
    if (!review || !msgEditableEl) return msgHidePopup();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return msgHidePopup();
    const range = sel.getRangeAt(0);
    if (
      !msgEditableEl.contains(range.startContainer) ||
      !msgEditableEl.contains(range.endContainer)
    )
      return msgHidePopup();
    // Reject selections that touch an already-masked item.
    const marks = msgEditableEl.querySelectorAll(".guardai-panel__mark");
    for (const m of marks) {
      if (range.intersectsNode(m)) return msgHidePopup();
    }
    const value = sel.toString();
    if (value.trim().length < 1) return msgHidePopup();
    msgPending = { range: range.cloneRange(), value };
    msgShowPopup(range.getBoundingClientRect());
  }

  function msgShowPopup(rect) {
    msgHidePopup();
    const pop = document.createElement("div");
    pop.className = "guardai-review-pop";
    pop.innerHTML =
      `<button class="guardai-review-pop__btn" data-act="auto">Auto-replace</button>` +
      `<button class="guardai-review-pop__btn" data-act="custom">Custom replace</button>`;
    document.body.appendChild(pop);
    msgPop = pop;
    pop.querySelector('[data-act="auto"]').onclick = msgAutoReplace;
    pop.querySelector('[data-act="custom"]').onclick = msgCustomReplaceUI;

    const w = pop.offsetWidth || 220;
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = rect.top - (pop.offsetHeight || 40) - 8;
    if (top < 8) top = rect.bottom + 8;
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }

  function msgHidePopup() {
    if (msgPop) {
      msgPop.remove();
      msgPop = null;
    }
  }

  function msgAutoReplace() {
    if (!msgPending) return;
    const value = msgPending.value.trim();
    const type = inferSelectionType(value);
    msgReplaceSelection(masker.previewFake(type, value), type);
  }

  /**
   * Decide the fake TYPE for a manually-highlighted selection so auto-replace
   * substitutes a value of the SAME kind (TFN->fake TFN, phone->fake phone,
   * address->fake address, etc.) instead of always defaulting to a name.
   *
   * Why the old code defaulted to a name: it ran detector.scan() on the bare
   * selection. Most detectors (TFN, Medicare, DOB, money, address) only fire when
   * a context keyword sits nearby; scanning the isolated selection strips that
   * context, so nothing matched and it fell back to NAME_PII. We fix this in
   * three layers, then a non-name generic fallback.
   */
  function inferSelectionType(value) {
    const v = value.trim();
    // 1) Already auto-detected in THIS message? Reuse that type — it was found
    //    with full surrounding context, so it's the most reliable signal.
    if (review && Array.isArray(review.items)) {
      const exact = review.items.find((it) => it.value.trim() === v);
      if (exact) return exact.type;
      const overlap = review.items.find((it) => it.value.includes(v) || v.includes(it.value));
      if (overlap) return overlap.type;
    }
    // 2) Re-scan the WHOLE original text and find the finding covering this
    //    selection, so context-dependent detectors work even if the item wasn't
    //    in the review model (e.g. user highlighted something we under-detected).
    try {
      if (review && review.original) {
        const idx = review.original.indexOf(v);
        if (idx >= 0) {
          const fs = detector.scan(review.original);
          const hit = fs.find(
            (f) => masker.isMaskable(f.type) && f.index < idx + v.length && f.index + f.value.length > idx
          );
          if (hit) return hit.type;
        }
      }
    } catch (_) { /* fall through */ }
    // 3) Context-free structural inference for data the auto-detector never
    //    caught at all (e.g. a leaked licence or address the user spotted).
    const structural = inferTypeStructural(v);
    if (structural) return structural;
    // 4) Unknown -> generic redaction. NEVER a fake name for non-name data.
    return "CUSTOM";
  }

  /** Classify a value by SHAPE alone (no surrounding context). Returns a GuardAI
   * finding type or null. Order matters: most specific shapes first. */
  function inferTypeStructural(v) {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "EMAIL";
    // AU driver licence: state code + 6-9 digits.
    if (/^(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s?\d{6,9}$/i.test(v)) return "LICENCE";
    // AU mobile / landline. The 0 / +61 prefix is REQUIRED here: without it a
    // bare 9-digit group like "234 567 891" (a TFN) would read as a landline.
    if (/^(?:\+?61[\s-]?4|04)(?:[\s-]?\d){8}$/.test(v) || /^(?:\+?61[\s-]?|0)[2-9](?:[\s-]?\d){8}$/.test(v)) return "PHONE";
    // date dd/mm/yyyy (optionally prefixed with a DOB label the user included).
    if (/(0?[1-9]|[12]\d|3[01])[\/.\-](0?[1-9]|1[0-2])[\/.\-](?:19|20)\d\d/.test(v)) return "DOB";
    // money.
    if (/\$\s?\d/.test(v)) return "MONEY";
    // account / reference code: 2-4 letters, dash, 4-6 digits (BW-44192).
    // Checked before the digit-count rules below, which would otherwise see
    // only the 5 digits and call it a TFN.
    if (/^[A-Za-z]{2,4}-\d{4,6}$/.test(v)) return "REF_CODE";
    const digits = v.replace(/\D/g, "");
    // Medicare: 10-11 digits in 4-5-1(-1) shape.
    if (/^[1-9]\d{3}\s?\d{5}\s?\d(?:\s?\d)?$/.test(v) && (digits.length === 10 || digits.length === 11)) return "MEDICARE";
    // BSB.
    if (/^\d{3}-\d{3}$/.test(v)) return "BSB";
    // credit card 13-19 digits.
    if (digits.length >= 13 && digits.length <= 19) return "CREDIT_CARD";
    // TFN 8-9 digits.
    if (digits.length === 8 || digits.length === 9) return "TFN";
    // address: number + optional words + a street type.
    if (/^\d{1,5}[A-Za-z]?(?:[-/]\d{1,4})?\s+(?:[A-Z][a-zA-Z]+\s+){0,3}(?:St|Street|Rd|Road|Ave|Avenue|Dr|Drive|Ln|Lane|Ct|Court|Pl|Place|Cres|Crescent|Blvd|Boulevard|Hwy|Highway|Pde|Parade|Tce|Terrace|Way|Cl|Close|Esplanade|Esp|Pkwy|Parkway|Cct|Circuit|Cir|Circle|Mews|Walk|Row|Grove|Grv|Quay|Cove|Glade|Gardens|Gdns|Loop|Rise|Vista|Mall)\b/i.test(v)) return "ADDRESS";
    // company name: capitalised words ending in a legal designator or an
    // industry descriptor. Must be tested BEFORE the full-name rule below,
    // which would otherwise claim "Bellweather Logistics" as a person and
    // substitute a fake HUMAN name for a business.
    if (
      /\s(?:(?:Pty\.?\s+)?Ltd\.?|(?:Pty\.?\s+)?Limited|Pty\.?|Incorporated|Inc\.?|L\.L\.C\.?|LLC|LLP|PLC|P\/L|Corporation|Corp\.?|GmbH|Group|Holdings|Partners|Partnership|Enterprises|Industries|Solutions|Services|Systems|Technologies|Consulting|Consultancy|Consultants|Logistics|Trading|Ventures|Associates|Agency|Studios|Studio|Laboratories|Labs|Foundation|Institute|Company|Contractors|Constructions|Developments|Investments|Removals|Freight|Transport|Supplies|Distribution|Manufacturing|Engineering|Motors)\.?$/i.test(v)
    ) {
      return "ORG";
    }
    // full name: 2-3 capitalised words (allows hyphen/apostrophe).
    if (/^[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?(?:\s+[A-Z][a-zA-Z'-]+){1,2}$/.test(v)) return "NAME_PII";
    return null;
  }

  // Test hook: lets the Node test suite exercise the auto-replace type
  // inference (pure logic, no UI state needed). Not used by the extension.
  window.GuardAI._selectionTypeHooks = { inferSelectionType, inferTypeStructural };
  // Test hook: exposes the restore-path internals (and the module's own
  // masker/detector instances) so tests can drive the REAL applyRules /
  // buildSwapRules against a synthetic DOM instead of reimplementing them.
  window.GuardAI._restoreHooks = { buildSwapRules, applyRules, swapAcrossNodes, matchNodeValue, masker, detector };
  // Test hook: exercises the real logActivity()/panel-visibility logic (the
  // "never auto-open, just badge, unless already visibly open" behavior)
  // without needing to drive a full mutation-observer + response cycle.
  window.GuardAI._panelHooks = {
    // markHtml is the ONLY producer of marks in the "What AI sees" editable,
    // so asserting on it asserts the view's whole contract: the fake is shown,
    // the real value is not.
    markHtml,
    logActivity,
    isPanelVisible: () => !!(panelEl && panelEl.style.display !== "none"),
    isReopenVisible: () => !!(reopenEl && reopenEl.style.display !== "none"),
    getActivityLog: () => activityLog,
  };
  // Test hook: run the real per-message decoration pass on demand, instead of
  // waiting out the scroll/mutation debounce, so tests can assert that silent
  // mode leaves no toggle buttons on the page.
  window.GuardAI._decorateHooks = {
    decorateMessages,
    findResponseRoot,
    messageElements,
    discoverMessages,
    growToBubble,
    buildSwapRules,
    // Composer resolution, so a decoy editor can be tested without driving a
    // whole send flow. See test/editor-decoy.cjs.
    findEditor,
    isUsableEditor,
  };

  /** Swap the popup for a small input so the user can type their own fake. */
  function msgCustomReplaceUI() {
    if (!msgPop) return;
    msgPop.innerHTML =
      `<input class="guardai-review-pop__input" type="text" placeholder="Your replacement" />` +
      `<button class="guardai-review-pop__btn guardai-review-pop__go" data-act="go">Apply</button>`;
    const input = msgPop.querySelector(".guardai-review-pop__input");
    const commit = () => {
      const v = input.value.trim();
      if (v) msgReplaceSelection(v, "CUSTOM");
    };
    // Confirm on click of "Apply" or by pressing Enter in the field.
    msgPop.querySelector('[data-act="go"]').onclick = commit;
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        msgHidePopup();
      }
    });
    input.focus();
  }

  /**
   * Replace the pending selection in the editable with a coloured mark carrying
   * the fake, register the real<->fake pair, log it, and re-type the live chat
   * input so the masked change is reflected in real time before the user sends.
   * The editable DOM is mutated in place so other edits are preserved.
   */
  async function msgReplaceSelection(fake, type) {
    if (!review || !msgPending) return;
    const raw = msgPending.value;
    const real = raw.trim();
    const lead = raw.slice(0, raw.indexOf(real));
    const tail = raw.slice(raw.indexOf(real) + real.length);

    masker.registerManual(real, fake, type);
    await masker.save();

    const st = markStyle(type, true);
    const mark = document.createElement("mark");
    mark.className =
      "guardai-panel__mark" + (type === "PASSWORD" ? " guardai-panel__mark--secret" : "");
    mark.setAttribute("contenteditable", "false");
    mark.setAttribute("data-type", type);
    mark.setAttribute("data-real", real);
    mark.setAttribute("data-fake", fake);
    mark.style.setProperty("--mk", st.color);
    mark.textContent = fake; // real fake stays; CSS hides passwords visually

    const frag = document.createDocumentFragment();
    if (lead) frag.appendChild(document.createTextNode(lead));
    frag.appendChild(mark);
    if (tail) frag.appendChild(document.createTextNode(tail));

    const range = msgPending.range;
    range.deleteContents();
    range.insertNode(frag);

    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    msgPending = null;
    msgHidePopup();

    review.items.push({ start: -1, end: -1, value: real, type, manual: true, fake });
    review.fakeByReal.set(real, fake);
    logActivity("mask", [{ type, real, fake }]); // shows in the MASKED tab
    buildReadView(); // keep "What you see" in sync with the new manual mask
    renderMsgLegend();
    renderPanel();
    await syncLiveInput(); // reflect the change in the chat input immediately
  }

  /**
   * Push the current MESSAGE-tab text into the live chat input. Called after a
   * manual mask so the input always matches what the user sees in the panel.
   */
  async function syncLiveInput() {
    if (!msgEditableEl) return false;
    const live = liveEditor();
    if (!live) {
      showErrorToast("Could not find the chat input — click in the chat box and try Apply again.");
      return false;
    }
    if (review) review.editor = live;
    let finalText = msgEditableEl.innerText.replace(/\u00a0/g, " ").replace(/\s+$/, "");
    const ok = await typeText(live, finalText);
    if (!ok || !fullyLanded(live, finalText)) {
      showErrorToast("The text didn't fully load into the chat box. Please try Apply again.");
      state.lastMaskedText = null;
      return false;
    }
    state.lastMaskedText = finalText;
    return true;
  }

  /**
   * "Apply changes": push whatever the user has written in the MESSAGE-tab
   * editor into the live chat input, then briefly confirm on the button.
   */
  async function applyMessageEdits() {
    if (!msgApplyEl) return;
    const ok = await syncLiveInput();
    if (!ok) return; // error toast already shown by syncLiveInput
    const orig = "Apply changes";
    msgApplyEl.textContent = "Applied \u2713";
    msgApplyEl.classList.add("guardai-panel__apply--done");
    clearTimeout(applyMessageEdits._t);
    applyMessageEdits._t = setTimeout(() => {
      if (!msgApplyEl) return;
      msgApplyEl.textContent = orig;
      msgApplyEl.classList.remove("guardai-panel__apply--done");
    }, 1400);
  }

  /* ---- Tabs, footer, send ---- */

  function setActiveTab(tab) {
    activeTab = tab === "message" ? "message" : "masked";
    if (!panelEl) return;
    panelEl.querySelectorAll(".guardai-panel__tab").forEach((t) => {
      t.classList.toggle(
        "guardai-panel__tab--active",
        t.getAttribute("data-tab") === activeTab
      );
    });
    panelEl.querySelectorAll(".guardai-panel__pane").forEach((p) => {
      p.classList.toggle(
        "guardai-panel__pane--active",
        p.getAttribute("data-pane") === activeTab
      );
    });
  }

  function updateFooter() {
    if (footerSendEl) footerSendEl.style.display = editMode ? "" : "none";
  }

  /** Send the (possibly edited) masked message from the MESSAGE tab. */
  async function panelSend() {
    const live = liveEditor();
    if (!live) {
      console.error("[GuardAI] No editor found to send from.");
      showErrorToast("Could not find the chat input — click in the chat box and try Send again.");
      return;
    }
    let finalText = msgEditableEl ? msgEditableEl.innerText : "";
    finalText = finalText.replace(/\u00a0/g, " ").replace(/\s+$/, "");
    const ok = await typeText(live, finalText);
    // HARD GATE: only send if the full text landed atomically. Refuse to dispatch
    // a partial/split message; keep the panel open so the user can retry Send.
    if (!ok || !fullyLanded(live, finalText)) {
      console.error("[GuardAI] panelSend — text did not fully land; aborting send");
      showErrorToast("The message didn't fully load into the chat box, so it was NOT sent. Please review it and press Send again.");
      state.lastMaskedText = null;
      return;
    }
    state.lastMaskedText = finalText;
    // Snapshot review so the Message tab stays populated after the soft-nav
    // that follows a successful send (handleSoftNav clears `review` but not this).
    if (review) sentReview = review;
    editMode = false;
    updateFooter();
    msgHidePopup();
    live.focus();
    triggerSend(live);
  }

  /** Tear down the active review (after the user sends, or on navigation). */
  function clearReview() {
    msgHidePopup();
    dismissMaskPrompt();
    review = null;
    editMode = false;
    suppressSends = false; // never leave the user locked out of sending
    renderMessageTab();
    updateFooter();
  }

  /* ------------------------------------------------------------------ *
   * Auto-decryption — watch responses and swap fakes back to real values.
   * We debounce mutations and only rewrite text nodes that actually contain
   * a known fake, to keep things cheap and avoid clobbering the DOM.
   * ------------------------------------------------------------------ */
  let unmaskTimer = null;
  let lastUnmaskRun = 0;
  const UNMASK_DEBOUNCE = 180; // settle time after the last mutation
  const UNMASK_MAX_WAIT = 600; // but never wait longer than this while streaming
  // Fakes we've already announced, so React re-renders (which re-fire the
  // observer) don't spam the same "restored" message repeatedly.
  const announcedSwaps = new Set();

  /**
   * Schedule an unmask pass. Debounced so we don't thrash on every keystroke of
   * a streaming response, but with a hard ceiling (UNMASK_MAX_WAIT) so that a
   * long, continuous stream still gets restored periodically rather than only
   * after it finally stops. This is what keeps auto-restore firing on every new
   * response as it arrives.
   */
  function scheduleUnmask() {
    if (!canRestore()) return; // master off — no monitoring
    if (masker.size === 0) return; // nothing to swap back
    const now = Date.now();
    clearTimeout(unmaskTimer);
    const sinceLast = now - lastUnmaskRun;
    if (sinceLast >= UNMASK_MAX_WAIT) {
      lastUnmaskRun = now;
      runUnmaskPass();
      return;
    }
    const wait = Math.min(UNMASK_DEBOUNCE, UNMASK_MAX_WAIT - sinceLast);
    unmaskTimer = setTimeout(() => {
      lastUnmaskRun = Date.now();
      runUnmaskPass();
    }, wait);
  }

  /** Escape a string for safe use inside a RegExp. */
  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Build word-boundary-safe replacement rules from the mapping, longest match
   * first. Direction "unmask" swaps fake -> real (read the response in your real
   * data); "remask" swaps real -> fake (see exactly what the AI actually has).
   * For NAME_PII we also emit per-token aliases so a first-name-only echo from
   * the AI ("Hi Liam") still maps ("Hi John"). Word boundaries (no adjacent
   * letter/digit) stop short tokens like "Liam" matching inside words.
   */
  function buildSwapRules(direction) {
    const toReal = direction === "unmask";
    const raw = [];

    // Name entries only, gathered first so we can tell which individual
    // tokens (first-name-alone, last-name-alone) are AMBIGUOUS before we
    // decide to alias them. The fake-name pool is small (16 first names x 14
    // last names), so with enough people in one conversation it's common for
    // two different real people to share a fake first OR last name — e.g.
    // "Mia Clarke" and "Mia Fletcher" both use "Mia". A per-token alias for
    // "Mia" can only point at ONE real name, so if we always create it,
    // whichever entry happened to be masked first "wins" globally and every
    // other person who also got "Mia" silently gets THAT stranger's real name
    // stitched onto their row — a wrong-person data leak, not just a missed
    // restore. We'd rather leave an ambiguous lone token unrestored (still
    // shows the fake) than guess and hand back the wrong real person's data.
    const nameEntries = [];
    for (const [, entry] of masker.fakeToReal) {
      if (entry.type === "NAME_PII" && /\s/.test(entry.fake) && /\s/.test(entry.real)) {
        nameEntries.push(entry);
      }
    }
    const tokenOwners = new Map(); // token (fake, toRealDirection-agnostic) -> Set of entries
    for (const entry of nameEntries) {
      const from = toReal ? entry.fake : entry.real;
      for (const part of from.split(/\s+/)) {
        if (part.length < 2) continue;
        if (!tokenOwners.has(part)) tokenOwners.set(part, new Set());
        tokenOwners.get(part).add(entry);
      }
    }

    for (const [, entry] of masker.fakeToReal) {
      const from = toReal ? entry.fake : entry.real;
      const to = toReal ? entry.real : entry.fake;
      raw.push({ key: from, from, to, entry });
      if (entry.type === "NAME_PII" && /\s/.test(entry.fake) && /\s/.test(entry.real)) {
        const fromParts = from.split(/\s+/);
        const toParts = to.split(/\s+/);
        if (fromParts.length === toParts.length) {
          for (let i = 0; i < fromParts.length; i++) {
            if (fromParts[i].length < 2) continue;
            const owners = tokenOwners.get(fromParts[i]);
            if (owners && owners.size > 1) continue; // ambiguous — do not alias
            raw.push({ key: fromParts[i], from: fromParts[i], to: toParts[i], entry });
          }
        }
      }
    }
    // Longest "from" first so "Liam Brown" is handled before the "Liam" alias.
    raw.sort((a, b) => b.from.length - a.from.length);
    return raw.map((r) => {
      // Join the words of a multi-word value (e.g. an address) with a flexible
      // separator so the AI's reformatting still matches: extra spaces, an
      // inserted comma ("147 Banksia Street, Melbourne"), or a line break when
      // the value is wrapped across lines all count as a gap.
      const tokens = r.from.split(/\s+/).filter(Boolean).map(escapeRegExp);
      const multi = tokens.length > 1;
      const body = tokens.join("[\\s,]+");
      return {
        key: r.key,
        to: r.to,
        entry: r.entry,
        multi,
        re: new RegExp("(?<![A-Za-z0-9])" + body + "(?![A-Za-z0-9])", "g"),
      };
    });
  }

  /** Should this text node be left alone? (our UI, the live input editor). */
  /* Tags whose text is not page content. A Next.js app embeds its whole
   * serialised payload in <script> blobs, and grok.com carries the masked
   * values in there — measured: two toggle buttons had been appended INSIDE
   * <script> elements, and the restore pass had been rewriting fake values
   * back to real ones inside that JSON. Invisible, so nobody would have
   * noticed from looking, and precisely the sort of place real data should
   * never be written. */
  const NON_CONTENT_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "OBJECT", "EMBED",
    "CANVAS", "SVG", "HEAD", "TITLE", "META", "LINK",
  ]);

  /** Is this text node inside something that is not page content? */
  function inNonContent(node) {
    let el = node && node.parentElement;
    let hops = 0;
    while (el && hops++ < 40) {
      if (NON_CONTENT_TAGS.has(el.tagName)) return true;
      el = el.parentElement;
    }
    return false;
  }

  function isProtectedNode(node, editor) {
    if (inNonContent(node)) return true;
    const p = node.parentElement;
    if (
      p &&
      p.closest(
        ".guardai-warning, .guardai-toast, .guardai-panel, .guardai-reopen, .guardai-msgtoggle, .guardai-review-pop, .guardai-prompt, .guardai-filecard, .guardai-fileprev"
      )
    ) {
      return true; // our own UI
    }
    if (editor && p && (editor === p || editor.contains(p))) return true; // input field
    return false;
  }

  /**
   * Find every rule match in ONE node's ORIGINAL text and apply them all in a
   * single simultaneous pass. Deliberately does NOT chain: every rule is
   * tested against the pristine input, never against another rule's output.
   *
   * Sequentially testing rules and re-testing against the progressively
   * mutated string (the old approach) lets one rule's REPLACEMENT text
   * accidentally become another rule's MATCH input in the same pass. E.g. if
   * fake "Emma Dawson" restores to real "Grace Tomlinson" (alias "Emma"
   * -> "Grace") while a DIFFERENT person's fake "Grace Walker" restores to
   * "Daniel Okafor" (alias "Grace" -> "Daniel"), a chained pass on a lone
   * "Emma" node first turns it into "Grace" and then, still in the same
   * pass, matches the SECOND rule against that just-inserted "Grace" and
   * turns it into "Daniel" — corrupting an already-correct restore. Matching
   * everything against the untouched original and resolving overlaps once
   * (longest match wins, so a full multi-word match beats any single-token
   * alias it overlaps) makes that impossible: a rule can only ever match text
   * that was actually there before any restoring happened.
   */
  function matchNodeValue(value, rules) {
    const candidates = [];
    for (const rule of rules) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(value))) {
        candidates.push({ start: m.index, end: m.index + m[0].length, to: rule.to, key: rule.key, entry: rule.entry });
        if (rule.re.lastIndex === m.index) rule.re.lastIndex++; // zero-length guard
      }
      rule.re.lastIndex = 0;
    }
    if (!candidates.length) return { value, used: [] };
    candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
    const kept = [];
    for (const c of candidates) {
      if (!kept.some((k) => c.start < k.end && c.end > k.start)) kept.push(c);
    }
    kept.sort((a, b) => b.start - a.start); // right-to-left so earlier offsets stay valid
    let out = value;
    const used = [];
    for (const k of kept) {
      out = out.slice(0, k.start) + k.to + out.slice(k.end);
      used.push({ key: k.key, entry: k.entry });
    }
    return { value: out, used };
  }

  /**
   * Apply a set of swap rules to the text nodes inside `rootEl`. Returns the Map
   * of key -> entry actually swapped (for logging). Used both by the per-message
   * toggle and as the core of the auto-restore pass.
   *
   * Cross-node matching runs FIRST, against untouched text, so a full value
   * split across DOM nodes (e.g. a table with the first and last name in
   * separate cells) gets resolved as one whole unit before anything else
   * touches those nodes. The per-node pass below then SKIPS any node
   * cross-node matching already wrote to — otherwise an unrelated alias can
   * match INSIDE the real value that was just correctly restored there (e.g.
   * a real surname that happens to equal a different person's fake surname).
   * The per-node pass only ever sees nodes cross-node matching had no full
   * match for: real values that were never fake, or genuinely isolated
   * tokens (partial echoes) with no partner to combine with. Running it the
   * other way around let an alias mutate one half of a split name before
   * cross-node could see the pair together, which is how two different
   * people's fake first/last names ended up stitched into one wrong "real"
   * name (see buildSwapRules for how ambiguous tokens are also excluded from
   * aliasing entirely).
   */
  function applyRules(rootEl, rules) {
    return applyRulesWithEditor(rootEl, rules, findEditor());
  }

  /**
   * The editor is passed to the walker even by callers that never used to
   * bother (Clear's remask, the per-item forget): swap machinery rewriting
   * the box the user is typing in is how masked text goes out real — or real
   * text gets silently rewritten — regardless of which feature invoked the
   * swap. Direction doesn't matter; the composer is not the machinery's to
   * edit.
   */
  function applyRulesWithEditor(rootEl, rules, editor) {
    const { swapped, touchedNodes } = swapAcrossNodes(rootEl, rules, editor);
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (isProtectedNode(node, editor)) return NodeFilter.FILTER_REJECT;
        return node.nodeValue && node.nodeValue.trim()
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    const edits = [];
    let n;
    while ((n = walker.nextNode())) {
      if (touchedNodes.has(n)) continue; // already finalized by cross-node matching
      const { value, used } = matchNodeValue(n.nodeValue, rules);
      if (used.length) {
        edits.push([n, value]);
        for (const u of used) swapped.set(u.key, u.entry);
      }
    }
    for (const [node, value] of edits) node.nodeValue = value;
    return swapped;
  }

  /**
   * Replace multi-word values that span more than one text node. We concatenate
   * the eligible text nodes (joined by a newline that the flexible "[\s,]+"
   * separators match), find any rule whose match crosses a node boundary, and
   * rewrite it in place: the full replacement goes into the first node of the
   * span and the remainder of the matched text is removed from the others.
   *
   * Returns { swapped, touchedNodes }. `touchedNodes` lists every node this
   * function wrote to (the one that received the replacement text AND any
   * node it emptied out) — the caller's per-node pass must skip all of them,
   * not just avoid re-adding the same rule. Without that, an unrelated
   * single-token alias can match INSIDE the real value that was just
   * correctly written here (common names are common: a real surname can
   * easily equal a different masked person's fake surname), quietly
   * corrupting a restore that already succeeded.
   */
  function swapAcrossNodes(rootEl, rules, editor) {
    const swapped = new Map();
    const touchedNodes = new Set();
    const multi = rules.filter((r) => r.multi);
    if (!multi.length) return { swapped, touchedNodes };

    const nodes = [];
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (isProtectedNode(node, editor)) return NodeFilter.FILTER_REJECT;
        return node.nodeValue && node.nodeValue.trim()
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    if (nodes.length < 2) return { swapped, touchedNodes }; // need a boundary to span

    let combined = "";
    const spans = []; // {node, start, end} positions within `combined`
    for (let i = 0; i < nodes.length; i++) {
      const start = combined.length;
      combined += nodes[i].nodeValue;
      spans.push({ node: nodes[i], start, end: combined.length });
      if (i < nodes.length - 1) combined += "\n"; // node boundary
    }

    const edits = []; // {start, end, to, rule}
    for (const rule of multi) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(combined))) {
        // Only handle matches that actually cross a boundary; within-node
        // matches are left to the caller's per-node pass.
        if (m[0].indexOf("\n") !== -1) {
          edits.push({ start: m.index, end: m.index + m[0].length, to: rule.to, rule });
        }
        if (rule.re.lastIndex === m.index) rule.re.lastIndex++;
      }
      rule.re.lastIndex = 0;
    }
    if (!edits.length) return { swapped, touchedNodes };

    // Drop overlapping matches, then apply from last to first so earlier
    // offsets stay valid as node values change.
    edits.sort((a, b) => a.start - b.start);
    const kept = [];
    let lastEnd = -1;
    for (const e of edits) {
      if (e.start >= lastEnd) {
        kept.push(e);
        lastEnd = e.end;
      }
    }
    for (let i = kept.length - 1; i >= 0; i--) {
      const e = kept[i];
      const written = applyCombinedReplacement(spans, e.start, e.end - e.start, e.to);
      for (const node of written) touchedNodes.add(node);
      swapped.set(e.rule.key, e.rule.entry);
    }
    return { swapped, touchedNodes };
  }

  /** Write `replacement` across the text nodes covered by [start, start+length).
   * Returns the list of nodes actually written to (placed + emptied). */
  function applyCombinedReplacement(spans, start, length, replacement) {
    const end = start + length;
    let placed = false;
    const written = [];
    for (const sp of spans) {
      if (sp.end <= start || sp.start >= end) continue; // node outside the span
      const localStart = Math.max(0, start - sp.start);
      const localEnd = Math.min(sp.node.nodeValue.length, end - sp.start);
      const before = sp.node.nodeValue.slice(0, localStart);
      const after = sp.node.nodeValue.slice(localEnd);
      sp.node.nodeValue = placed ? before + after : before + replacement + after;
      written.push(sp.node);
      placed = true;
    }
    return written;
  }

  /* ------------------------------------------------------------------ *
   * Per-message "Show what AI sees" / "Show real data" toggle.
   * Each assistant message gets a small button so the user can flip that one
   * message between the fake text the AI actually stored and their real data.
   * ------------------------------------------------------------------ */
  /**
   * The elements a configured platform names as messages.
   *
   * WITHIN EACH ROLE THE FIRST SELECTOR THAT MATCHES WINS. These lists are
   * fallbacks — "use this; if the site has renamed it, try that" — not a set
   * to union. Unioning them is how Gemini ended up with two stacked buttons on
   * one message bubble: user-query-content, .user-query-bubble-with-background
   * and .query-text are the SAME message nested three deep, so every one that
   * matched got its own button. Claude has the same shape on its assistant
   * side (font-claude-response / font-claude-message / assistant-turn).
   *
   * ChatGPT never showed the bug and that is the tell: it is the only platform
   * with exactly one selector per role, and its two roles cannot nest.
   * Measured on a live thread — 1 user match, 1 assistant match, 0 nested, 2
   * buttons, 0 duplicated owners.
   */
  function configuredMessages(root) {
    const out = [];
    for (const list of [CONFIG.responseMessage, CONFIG.userMessage]) {
      if (!Array.isArray(list) || !list.length) continue;
      for (const selector of list) {
        let els = [];
        try {
          els = Array.from(root.querySelectorAll(selector));
        } catch {
          continue; // malformed selector — try the next fallback
        }
        if (els.length) { out.push(...els); break; }
      }
    }
    return out;
  }

  /**
   * One toggle per message, and none stranded on something that is no longer
   * one. A belt-and-braces pass: even if candidate selection goes wrong after
   * a site redesign, the user must never see two buttons stacked on the same
   * bubble again.
   */
  function pruneToggles(root, msgs) {
    const owners = new Set(msgs);
    const claimed = new Set();
    let btns = [];
    try {
      btns = Array.from(root.querySelectorAll(".guardai-msgtoggle"));
    } catch {
      return;
    }
    for (const btn of btns) {
      const owner = btn.parentElement;
      if (!owner || !owners.has(owner) || claimed.has(owner)) { btn.remove(); continue; }
      claimed.add(owner);
    }
  }

  function messageSelectors() {
    // Decorate and keep in sync BOTH the AI's response bubbles and the user's
    // own sent bubbles, so each can flip between real data and the masked text
    // the AI actually saw.
    //
    // These are the HAND-TUNED selectors only, and most supported platforms
    // have none: every genericConfig() site (Copilot, Perplexity, Poe,
    // Mistral, HuggingFace and ~18 others) returns an empty list here. That
    // used to mean those sites simply never got the toggle — masking worked,
    // but "Show what AI sees" never appeared. discoverMessages() below is the
    // selector-free fallback that covers them, and it also rescues a
    // configured platform whose selectors have gone stale after a redesign.
    const sels = [];
    if (CONFIG.responseMessage) sels.push(...CONFIG.responseMessage);
    if (CONFIG.userMessage) sels.push(...CONFIG.userMessage);
    return sels;
  }

  /**
   * The subtree we scan for AI responses (auto-restore) and decorate with
   * per-message toggles.
   *
   * A configured root only counts if it actually CONTAINS messages. Sites
   * rebuild their DOM constantly, and the failure that motivated this check
   * is nastier than a selector simply going stale: on claude.ai the old
   * "div.flex-1.flex.flex-col" root kept on matching an element that no
   * longer held any part of the conversation, so we silently scanned an empty
   * subtree — auto-restore and the toggle buttons both quietly did nothing,
   * with no error anywhere. A root that matches but is empty is WORSE than no
   * match at all, because the plain `if (el) return el` above treated it as a
   * success and never tried the remaining fallbacks.
   *
   * So: prefer the first configured root that contains a known message
   * element; if a selector matches but holds no messages, keep looking. Fall
   * back to the first bare match (platforms with no message selectors
   * configured, where "contains messages" is unknowable), then document.body.
   */
  function findResponseRoot() {
    const msgSel = messageSelectors().join(",");
    let firstMatch = null;
    for (const sel of CONFIG.responseRoot) {
      let el;
      try {
        el = document.querySelector(sel);
      } catch {
        continue; // malformed selector — skip rather than break the pass
      }
      if (!el) continue;
      if (!firstMatch) firstMatch = el;
      if (!msgSel) continue; // nothing to verify against on this platform
      try {
        if (el.querySelector(msgSel)) return el;
      } catch {
        /* malformed message selector — fall through to the bare match */
      }
    }
    return firstMatch || document.body;
  }

  function setToggleLabel(btn, msgEl) {
    const showingReal = msgEl.getAttribute("data-guardai-view") !== "fake";
    // If currently real, the button reveals the fake; otherwise it restores real.
    btn.textContent = showingReal ? "Show what AI sees" : "Show real data";
    btn.setAttribute("data-state", showingReal ? "real" : "fake");
  }

  function toggleMessageView(msgEl, btn) {
    const showingReal = msgEl.getAttribute("data-guardai-view") !== "fake";
    if (showingReal) {
      applyRules(msgEl, buildSwapRules("remask")); // real -> fake
      msgEl.setAttribute("data-guardai-view", "fake");
      msgEl.setAttribute("data-guardai-lock", "fake"); // explicit user choice
    } else {
      const swapped = applyRules(msgEl, buildSwapRules("unmask")); // fake -> real
      msgEl.setAttribute("data-guardai-view", "real");
      msgEl.setAttribute("data-guardai-lock", "real");
      const entries = Array.from(swapped.values());
      if (entries.length) logActivity("unmask", entries);
    }
    setToggleLabel(btn, msgEl);
  }

  /**
   * When the global Auto-restore toggle flips, move every message that the user
   * hasn't individually pinned to the new default view (real when on, fake when
   * off) and refresh its button label.
   */
  function syncMessageViewsToDefault() {
    const root = findResponseRoot();
    const def = state.autoRestore ? "real" : "fake";
    const rules = buildSwapRules(state.autoRestore ? "unmask" : "remask");
    const msgs = messageElements(root, buildSwapRules("unmask").concat(buildSwapRules("remask")));
    msgs.forEach((el) => {
      if (el.getAttribute("data-guardai-lock")) return; // user pinned this one
      el.setAttribute("data-guardai-view", def);
      applyRules(el, rules); // bring the visible text to the new default
      const btn = el.querySelector(":scope > .guardai-msgtoggle");
      if (btn) setToggleLabel(btn, el);
    });
  }

  /** Remove every per-message toggle button we've injected. */
  function removeMessageToggles() {
    document.querySelectorAll(".guardai-msgtoggle").forEach((el) => el.remove());
  }

  /** True if `rules` matches anywhere in `text` — cheap existence probe, no
   * replacement/positions computed (unlike matchNodeValue, which builds the
   * full result). Used to decide whether a message has anything to toggle
   * at all before we bother giving it a button. */
  function anyRuleMatches(text, rules) {
    for (const rule of rules) {
      rule.re.lastIndex = 0;
      const hit = rule.re.test(text);
      rule.re.lastIndex = 0;
      if (hit) return true;
    }
    return false;
  }

  /**
   * A message only gets the "Show what AI sees"/"Show real data" button if it
   * actually contains something masked/maskable — otherwise the button is
   * noise on every ordinary reply that has nothing to do with the feature.
   * Checked against BOTH directions' rules because the message may currently
   * be displaying either the fake text (unmask rules would fire) or the real
   * text (remask rules would fire), depending on auto-restore/pin state.
   *
   * Checked per TEXT NODE, not against msgEl.textContent as one concatenated
   * string — textContent glues adjacent nodes together with no separator, so
   * a value sitting right next to other text (most commonly a table cell:
   * "PHONE" immediately followed by "0423 990 894" with no space between
   * them) loses the word-boundary regex has to see right at that seam, and
   * a real match gets missed. Each individual text node's own content still
   * has clean boundaries at its own start/end, which is exactly how the real
   * restore logic (matchNodeValue) already looks at it — this just mirrors
   * that so detection and restoration agree on what counts as a match.
   */
  function hasSwappableData(msgEl, unmaskRules, remaskRules) {
    const walker = document.createTreeWalker(msgEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (inNonContent(node)) return NodeFilter.FILTER_REJECT;
        return node.nodeValue && node.nodeValue.trim()
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      if (anyRuleMatches(n.nodeValue, unmaskRules) || anyRuleMatches(n.nodeValue, remaskRules)) {
        return true;
      }
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * Finding message bubbles WITHOUT per-platform selectors.
   *
   * Only a handful of platforms have hand-tuned responseMessage/userMessage
   * selectors. For everything else there is no "message bubble" class we can
   * know in advance, so we work backwards from the thing we DO know: the
   * masked/real values themselves. A text node that a swap rule matches is
   * sitting inside exactly one message, so the message can be found by
   * climbing out of it.
   *
   * The climb stops at two things, neither of which needs any knowledge of a
   * site's DOM: an ancestor that reaches into a DIFFERENT match (so it is the
   * conversation, not a message), and an ancestor that is much taller than
   * what we already have (same conclusion, by geometry, for the case where the
   * rest of the conversation happens to hold no matches at all).
   * ------------------------------------------------------------------ */

  /** Marks an element we identified generically, so later passes recognise the
   * same bubble again without re-deriving it (and after it has been rewritten
   * to the fake text, where the "real" rules may no longer match). */
  const MSG_ATTR = "data-guardai-msg";
  /* Text length at the moment a bubble was marked. Re-deriving every marked
   * bubble on every pass would mean a TreeWalker per message per DOM change,
   * which on a long conversation is far more work than the decoration itself.
   * A settled message has the same length it had last time and is skipped
   * outright; only a bubble whose content actually changed is re-checked —
   * which is exactly the one case that matters, a reply arriving inside
   * something we already marked. */
  const MSG_LEN = "data-guardai-msglen";

  /** Mark an element as one message bubble, recording its size at that moment. */
  function markBubble(el) {
    el.setAttribute(MSG_ATTR, "1");
    el.setAttribute(MSG_LEN, String((el.textContent || "").length));
  }

  /** Things a message bubble is definitely not, and must never be grown into:
   * GuardAI's own UI (the panel lists real AND fake values, so it matches
   * every rule), and the composer (rewriting the box the user is typing in
   * would corrupt their draft). */
  const NOT_A_MESSAGE =
    '[contenteditable="true"], textarea, input, form, .guardai-panel, .guardai-reopen, .guardai-msgtoggle';

  /** Inline elements are not messages. A value split across <b>/<span> pieces
   * inside one paragraph must resolve to that one paragraph, or the same
   * message ends up with a button per fragment. */
  function blockAncestor(el, root) {
    let cur = el;
    while (cur && cur !== root && cur.parentElement) {
      let display = "";
      try {
        display = (window.getComputedStyle(cur).display || "").toLowerCase();
      } catch {
        display = "";
      }
      if (display && display !== "inline" && display !== "inline-block" && display !== "contents") {
        return cur;
      }
      cur = cur.parentElement;
    }
    return cur || el;
  }

  /**
   * Grow a seed outwards to the element that behaves like the whole message
   * bubble. Stops below `root`, at GuardAI's own UI, at the composer, at an
   * ancestor that reaches into another match, and at a big height jump.
   *
   * Erring small is deliberate. A message split across two toggles is untidy;
   * a single toggle spanning two messages rewrites text the user never pointed
   * at, which is the failure worth avoiding.
   */
  function growToBubble(seed, root, seeds) {
    let el = seed;
    if (!el || el === root || !root.contains(el)) return null;
    let h = el.getBoundingClientRect().height;
    while (el.parentElement && el.parentElement !== root && el.parentElement !== document.body) {
      const p = el.parentElement;
      try {
        if (p.querySelector(NOT_A_MESSAGE)) break; // composer / our own UI inside
      } catch {
        break;
      }
      // Reaches into a match that is not ours: that is another message.
      if (seeds && seeds.some((o) => o !== seed && !el.contains(o) && p.contains(o))) break;
      const ph = p.getBoundingClientRect().height;
      // 1.6x + 80px of slack: padding, an avatar row and an action bar are all
      // normal parts of one bubble; a second message is not.
      if (ph > h * 1.6 + 80) break;
      el = p;
      h = ph;
    }
    return el;
  }

  /**
   * Find message bubbles on a platform we have no selectors for, by locating
   * the masked/real values and climbing out of them.
   */
  /* Block-level text tags. A container whose element children are ALL of these
   * is a rendered-text body — the markdown of one reply — not a list of
   * messages. Two different messages are never siblings inside one. */
  const TEXT_BLOCK = new Set([
    "P", "UL", "OL", "LI", "H1", "H2", "H3", "H4", "H5", "H6",
    "BLOCKQUOTE", "PRE", "TABLE", "HR", "FIGURE", "DL",
    // Table internals belong here too. Without them the climb out of a <td>
    // stops at its <tr> — TD is not a text block, so the row does not look
    // like a prose body — and a reply rendered as a table gets ONE BUTTON PER
    // CELL. Found by the structural battery, not by a site report, and it is
    // the exact shape of the Gemini reply in the screenshots: a two-column
    // contacts table with a masked value in every row.
    "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH", "CAPTION", "COLGROUP",
    // Same reasoning for the other container-y text structures.
    "DD", "DT", "FIGCAPTION", "DETAILS", "SUMMARY",
  ]);

  /**
   * Does this element look like the rendered body of one message?
   *
   * Not "every child is a text tag" — that was too strict. Markdown renderers
   * wrap tables and code blocks in layers of positioning divs, so a real reply
   * body reads P, DIV, P, UL, P. Majority is the test.
   */
  function isMarkdownBody(el) {
    if (!el || !el.children || !el.children.length) return false;
    let text = 0;
    let total = 0;
    for (const k of el.children) {
      if (k.classList && k.classList.contains("guardai-msgtoggle")) continue;
      total++;
      if (TEXT_BLOCK.has(k.tagName)) text++;
    }
    if (!total) return false;
    return text * 2 >= total;
  }

  /**
   * The OUTERMOST rendered body containing this element.
   *
   * Climbing only while each parent looks like prose was not enough. Measured
   * on a live grok.com reply, the chain out of a table cell is:
   *
   *   td -> tr -> tbody -> table
   *      -> div.table-container   [TABLE]              <- prose-looking
   *      -> div.rounded-[16px]    [DIV]                <- NOT
   *      -> div.w-fit             [DIV, DIV]           <- NOT
   *      -> div.group/table       [DIV, DIV]           <- NOT
   *      -> div.response-content-markdown [P,DIV,P,UL,P]  <- the message body
   *
   * Stopping at the first non-prose parent left the button inside
   * div.table-container, which is 398px wide — so it rendered squeezed against
   * the table with its label wrapped onto two lines, instead of sitting at the
   * bottom of the reply. Three positioning wrappers stood between the table
   * and the body, so no "unwrap a single child" rule would have reached it
   * either.
   *
   * So: climb all the way, and keep the outermost ancestor that still looks
   * like one message body. Wrapper divs in between are simply passed through.
   * The bound is the response root, and in every structure measured so far the
   * element above the body is a wrapper whose children are divs — Grok's
   * message-bubble is DIV,DIV,SECTION,DIV, Perplexity's turn is DIV,DIV — so
   * the climb has nowhere further to go and cannot swallow the question.
   */
  function markdownBodyAncestor(el, root) {
    let best = null;
    let cur = el;
    let hops = 0;
    while (cur && cur !== root && cur.parentElement && cur.parentElement !== root && hops++ < 30) {
      const parent = cur.parentElement;
      if (isMarkdownBody(parent)) best = parent;
      cur = parent;
    }
    return best;
  }

  function discoverMessages(root, rules) {
    if (!rules || !rules.length) return [];
    const seeds = [];
    let walker;
    try {
      walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (inNonContent(node)) return NodeFilter.FILTER_REJECT;
          return node.nodeValue && node.nodeValue.trim()
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      });
    } catch {
      return [];
    }
    let n;
    let scanned = 0;
    while ((n = walker.nextNode())) {
      // A long conversation can hold tens of thousands of text nodes and this
      // runs on a debounce after every DOM change. Cap the work rather than
      // janking the page.
      if (++scanned > 6000) break;
      if (!anyRuleMatches(n.nodeValue, rules)) continue;
      let el = n.parentElement;
      if (!el) continue;
      try {
        if (el.closest(NOT_A_MESSAGE)) continue;
        // Already inside a bubble found on an earlier pass. Skipping it
        // matters: NOT_A_MESSAGE includes our own button, so re-deriving a
        // decorated bubble would stop the climb below it and hang a second,
        // nested button off the same message on every later pass.
        if (el.closest("[" + MSG_ATTR + "]")) continue;
      } catch {
        continue;
      }
      el = blockAncestor(el, root);
      if (!el || el === root) continue;
      if (!seeds.includes(el)) seeds.push(el);
    }

    const found = [];
    for (const seed of seeds) {
      const bubble = growToBubble(seed, root, seeds);
      if (bubble && !found.includes(bubble)) found.push(bubble);
    }
    // Roll every candidate up into the rendered-text body that holds it, so
    // the paragraphs and bullets of ONE reply collapse to one message.
    const merged = Array.from(new Set(found.map((el) => markdownBodyAncestor(el, root) || el)));
    // A candidate that CONTAINS another candidate spans more than one message
    // (the height heuristic over-climbed, usually because the messages around
    // it are short). Keep the inner ones; one button per message is the point.
    return merged.filter((a) => !merged.some((b) => b !== a && a.contains(b)));
  }

  /**
   * Every element that should carry a toggle: the configured selectors where a
   * platform has them, bubbles we previously discovered, and — when neither
   * turns anything up — a fresh generic discovery pass.
   */
  function messageElements(root, rules) {
    const out = [];
    const configured = configuredMessages(root);
    out.push(...configured);
    try {
      out.push(...root.querySelectorAll("[" + MSG_ATTR + "]"));
    } catch {
      /* ignore */
    }
    // Gated on the CONFIGURED selectors, not on `out`: bubbles found on an
    // earlier pass are already in `out`, and gating on that would run
    // discovery exactly once and then never again — every message after the
    // first would silently lose its button. Discovery therefore runs on every
    // pass for a platform with no selectors, and as a rescue for a configured
    // platform whose selectors have stopped matching after a redesign.
    if (!configured.length) {
      for (const el of discoverMessages(root, rules)) {
        markBubble(el);
        out.push(el);
      }
    }
    // One message may not contain another. Configured selectors no longer
    // produce nested matches, previously-marked bubbles can after a redesign,
    // and discovery can when it over-climbs — keep the inner one in every
    // case, which is the message rather than the container around it.
    const uniq = Array.from(new Set(out));
    return uniq.filter((a) => !uniq.some((b) => b !== a && a.contains(b)));
  }

  /**
   * Marks are PROVISIONAL. A bubble that turns out to contain two bubbles was
   * never a bubble.
   *
   * Generic discovery runs on a debounce, so it routinely runs while a turn is
   * half-built: the question is on screen and the answer has not streamed in
   * yet. With only one match on the page there is no second seed to stop the
   * climb, and the height test compares a container against the one short
   * message inside it — which does not clear 1.6x + 80px. So it climbs past
   * the bubble, past the turn, and marks the whole conversation container.
   *
   * That mark is then permanent: discoverMessages() skips anything inside an
   * already-marked element, so when the answer arrives it never gets a button,
   * and the single button that does exist hangs off the end of the entire
   * thread. Measured on perplexity.ai — one left-aligned button under the
   * whole conversation, nothing on the user's own message. Platforms with
   * hand-tuned selectors (ChatGPT, Claude) never hit it, because discovery
   * does not run there at all; every genericConfig() site did.
   *
   * Re-deriving on each pass fixes it without any per-site knowledge, and
   * self-corrects the same way for virtualised lists and site redesigns.
   */
  function resplitMarkedBubbles(root, rules) {
    let marked;
    try {
      marked = Array.from(root.querySelectorAll("[" + MSG_ATTR + "]"));
    } catch {
      return;
    }
    for (const outer of marked) {
      // Skip anything a previous iteration already split away or re-parented.
      if (!outer.isConnected || !outer.hasAttribute(MSG_ATTR)) continue;
      // Unchanged since it was marked: it cannot have grown a second message.
      if (outer.getAttribute(MSG_LEN) === String((outer.textContent || "").length)) continue;
      // A rendered-text body is one message by definition, however many
      // paragraphs it grows. Without this the re-split would chop a streaming
      // reply back into one button per paragraph as it arrived.
      if (isMarkdownBody(outer)) { markBubble(outer); continue; }

      // Hidden from itself, so discovery scoped inside it can see past the
      // mark; put it straight back unless we actually split it.
      outer.removeAttribute(MSG_ATTR);
      let inner = [];
      try {
        inner = discoverMessages(outer, rules).filter((el) => el !== outer && outer.contains(el));
      } catch {
        inner = [];
      }
      if (inner.length < 2) {
        markBubble(outer); // still one message; re-baseline so it settles
        continue;
      }

      // It spans more than one message. Keep the parts, drop the whole.
      removeToggleFrom(outer);
      outer.removeAttribute("data-guardai-view");
      outer.removeAttribute("data-guardai-lock");
      for (const el of inner) markBubble(el);
    }
  }

  /** Take the toggle (and its wrapper, if any) off one element. */
  function removeToggleFrom(el) {
    if (!el) return;
    el.querySelectorAll(":scope > .guardai-msgtoggle").forEach((b) => b.remove());
  }

  /** Add a toggle button to any assistant message that doesn't have one yet
   * AND actually has masked/real data in it worth toggling. */
  function decorateMessages(root) {
    // Silent "Masking mode" means the extension leaves no visible trace on the
    // page — including these per-message buttons. Auto-restore is unaffected:
    // runUnmaskPass walks the DOM itself and only consults data-guardai-view
    // for messages the user pinned by hand, which can't happen without buttons.
    if (state.maskingEnabled) return;
    if (masker.size === 0) return; // nothing masked yet — nothing to toggle anywhere
    const unmaskRules = buildSwapRules("unmask");
    const remaskRules = buildSwapRules("remask");
    const allRules = unmaskRules.concat(remaskRules);
    // Before trusting any existing mark, check it is still one message.
    resplitMarkedBubbles(root, allRules);
    const msgs = messageElements(root, allRules);
    msgs.forEach((msgEl) => {
      if (msgEl.querySelector(":scope > .guardai-msgtoggle")) return; // already done
      if (!hasSwappableData(msgEl, unmaskRules, remaskRules)) return; // nothing to show here
      if (!msgEl.getAttribute("data-guardai-view")) {
        msgEl.setAttribute("data-guardai-view", state.autoRestore ? "real" : "fake");
      }
      const btn = document.createElement("button");
      btn.className = "guardai-msgtoggle";
      btn.type = "button";
      setToggleLabel(btn, msgEl);
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleMessageView(msgEl, btn);
      });
      msgEl.appendChild(btn);
    });
    pruneToggles(root, msgs);
  }

  /**
   * Decoration is decoupled from the (masker-gated, debounced) unmask pass so
   * that EVERY message gets its toggle button — including older messages that
   * mount only when the user scrolls up through a long (virtualised)
   * conversation. The observer and a capture-phase scroll listener both feed
   * this. It is independent of masker.size: a button is harmless on a message
   * with nothing to swap, and buildSwapRules reads the live mapping at click
   * time so it works the moment any data is masked.
   */
  let decorateTimer = null;
  function scheduleDecorate() {
    // canRestore(), not isActive(): the per-message show-real/show-fake
    // buttons belong to the restore path. On a fresh unlicensed install
    // masker.size is 0, so nothing is injected and the page stays untouched.
    if (!canRestore()) return;
    clearTimeout(decorateTimer);
    decorateTimer = setTimeout(async () => {
      if (!canRestore()) return;
      await masker.load();
      decorateMessages(findResponseRoot());
    }, 120);
  }

  // Whether the full panel was visibly open at the moment the master toggle
  // was switched off, so re-enabling can put the UI back exactly as the user
  // left it. Purely a VIEW flag — it never gates what is stored.
  let panelWasOpenBeforeDisable = false;

  /** Hide every piece of GuardAI UI we've injected into the page.
   *
   * Hides, never wipes: the activity log and the fake<->real mapping are the
   * user's data and must survive the master toggle untouched. Turning GuardAI
   * off means "stop doing things and get out of the way", not "forget what
   * you already found" — only Clear session / Clear may delete any of it. */
  function teardownUI() {
    document
      .querySelectorAll(
        ".guardai-msgtoggle, .guardai-warning, .guardai-toast, .guardai-review-pop, .guardai-mark-tip"
      )
      .forEach((el) => el.remove());
    dismissMaskPrompt();
    panelWasOpenBeforeDisable = !!(panelEl && panelEl.style.display !== "none");
    if (panelEl) panelEl.style.display = "none";
    if (reopenEl) reopenEl.style.display = "none";
  }

  /**
   * React to the master on/off toggle flipping at runtime. Off -> hide all
   * injected UI and stop (the send listeners and observer callbacks already
   * short-circuit on !state.enabled). On -> resume scanning AND put the
   * activity UI back.
   *
   * Restoring the UI matters as much as resuming the scan: teardownUI() hides
   * the badge, and nothing else re-shows it on re-enable, so previously
   * masked history stayed invisible until the next full page load (only
   * startObserving() had the "saved log -> showReopen()" logic). The data was
   * always still on disk, but from the user's side an off/on cycle was
   * indistinguishable from having wiped their history.
   */
  function applyEnabledState() {
    updateLockedNotice();
    if (canRestore()) {
      scheduleUnmask();
      scheduleDecorate();
      // Put the activity UI back the way the user left it. Re-opening a panel
      // they had open is restoring their own state, not auto-popping it —
      // otherwise fall back to the collapsed badge, and show nothing at all
      // when there's no history to advertise.
      if (panelWasOpenBeforeDisable) {
        panelClosed = false;
        ensurePanel();
        renderPanel();
      } else if (activityLog.length) {
        showReopen();
      }
      panelWasOpenBeforeDisable = false;
    } else {
      teardownUI();
    }
  }

  async function runUnmaskPass() {
    await masker.load();
    if (masker.size === 0) return;

    const root = findResponseRoot();

    // Make sure every assistant message has its fake/real toggle button.
    decorateMessages(root);

    // The live input editor must be skipped: it holds the masked fakes the user
    // just typed, and unmasking those back to real values would leak real data
    // straight back into the box they're about to send. Messages the user has
    // flipped to the fake view (data-guardai-view="fake") are also skipped so
    // auto-restore doesn't fight their explicit choice.
    const editor = findEditor();

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (isProtectedNode(node, editor)) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        // When auto-restoring, skip messages the user explicitly pinned to the
        // fake view so we don't undo their choice. When auto-restore is off we
        // still scan them (read-only) so pending items are detected for logging.
        if (state.autoRestore && p && p.closest('[data-guardai-lock="fake"]')) {
          return NodeFilter.FILTER_REJECT;
        }
        return node.nodeValue && node.nodeValue.trim()
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    // Build the replacement rules. Besides each full fake -> real, we add name
    // component aliases: an AI commonly replies using just the FIRST name
    // ("Hi Liam" rather than "Hi Liam Brown"), so we also map the first- and
    // last-name tokens of a fake name back to the matching real tokens. Without
    // this the partial echo never matches and the response stays masked.
    const rules = buildSwapRules("unmask");

    const swappedEntries = new Map(); // fake (or alias) -> entry (for the log)

    // Cross-node matching FIRST, before anything else touches the DOM — same
    // reasoning as applyRules() above: a full name split across nodes (e.g.
    // separate table cells) must be resolved as one unit before the per-node
    // pass below has a chance to mutate one half of it via a single-token
    // alias, or re-match an unrelated alias inside the real value it just
    // wrote. Only runs when auto-restore is on; read-only detection (off)
    // must never write to the DOM.
    let touchedNodes = new Set();
    if (state.autoRestore) {
      const crossed = swapAcrossNodes(root, rules);
      touchedNodes = crossed.touchedNodes;
      for (const [k, v] of crossed.swapped) swappedEntries.set(k, v);
    }

    const edits = [];
    let n;
    while ((n = walker.nextNode())) {
      if (touchedNodes.has(n)) continue; // already finalized by cross-node matching
      const { value, used } = matchNodeValue(n.nodeValue, rules);
      if (used.length) {
        // Only rewrite the DOM when auto-restore is on. When off we just note
        // which fakes appear so the user can reveal them in the panel.
        if (state.autoRestore) edits.push([n, value]);
        for (const u of used) swappedEntries.set(u.key, u.entry);
      }
    }
    if (state.autoRestore) {
      for (const [node, value] of edits) node.nodeValue = value;
    }

    // With auto-restore OFF, keep any message the user manually flipped to the
    // real view sticky across the AI's re-renders by re-applying the swap to it.
    if (!state.autoRestore) {
      let realMsgs;
      try {
        realMsgs = root.querySelectorAll(messageSelectors().join(","));
      } catch {
        realMsgs = [];
      }
      realMsgs.forEach((el) => {
        if (el.getAttribute("data-guardai-view") === "real") applyRules(el, rules);
      });
    }

    // Log only the swaps we haven't announced before. With auto-restore on these
    // are "Restored"; with it off they are "pending" reveals (response untouched).
    const fresh = [];
    for (const [fake, entry] of swappedEntries) {
      if (!announcedSwaps.has(fake)) {
        announcedSwaps.add(fake);
        fresh.push(entry);
      }
    }
    if (fresh.length) logActivity(state.autoRestore ? "unmask" : "pending", fresh);
  }

  const observer = new MutationObserver(() => {
    scheduleUnmask();
    scheduleDecorate();
  });

  /* ------------------------------------------------------------------ *
   * Boot.
   * The send-interception listeners (keydown/click) are registered at module
   * scope above, so they are live the instant this script is injected. With
   * run_at:document_start that is before the page's own scripts and before the
   * user can type — detection is ready from the very first keystroke on a cold
   * page load, with no need to open the popup or interact with the extension.
   * Here we only do the asynchronous setup (settings, mapping, observer), and
   * attach the response observer as soon as <body> exists.
   * ------------------------------------------------------------------ */
  function startObserving() {
    if (!document.body) {
      // document_start: <body> may not exist yet. Re-check next frame.
      requestAnimationFrame(startObserving);
      return;
    }
    // If this page already has saved history, show the collapsed badge (not
    // the full panel) — GuardAI must never pop the panel open just because
    // you opened/reloaded a chat site. Only if GuardAI is enabled: without
    // that check, a reload while disabled would bring the badge back just
    // because past activity was saved, even though everything is off.
    if (activityLog.length && state.enabled) {
      showReopen();
    }
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    // Decorate messages as the user scrolls: long conversations are virtualised,
    // so older messages only mount on scroll. Capture phase catches scrolling on
    // inner scroll containers (e.g. ChatGPT scrolls a div, not the window).
    window.addEventListener("scroll", scheduleDecorate, { capture: true, passive: true });
    // Initial pass in case a conversation with masked data is reloaded.
    scheduleUnmask();
    scheduleDecorate();
  }

  /* ------------------------------------------------------------------ *
   * SPA soft-navigation handling.
   * Sites like ChatGPT route between conversations client-side without a full
   * page load. The document-level send listeners and the body observer survive
   * that, but stale per-send state can linger and the response root may be
   * swapped out. On every soft nav we reset that transient state, make sure the
   * observer is attached to the live <body>, and re-run a restore pass.
   * ------------------------------------------------------------------ */
  // Track the CONVERSATION path, not the full href. ChatGPT/Claude fire
  // history.replaceState with changed query strings / hashes (composer state,
  // model param, scroll anchors) WITHIN the same conversation; those must not be
  // treated as navigation, or they'd wipe an in-progress review mid-send and
  // null-deref it. Only a pathname change means we actually switched chats.
  let lastPath = location.pathname;
  function handleSoftNav() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    state.lastMaskedText = null; // don't carry a bypass into a new conversation
    bypassNext = false;
    dismissMaskPrompt();
    clearReview(); // a half-finished review doesn't belong in a new conversation
    announcedSwaps.clear(); // re-announce restores in the new view
    if (document.body) {
      try {
        observer.disconnect();
      } catch {
        /* ignore */
      }
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    scheduleUnmask();
    scheduleDecorate();
  }

  (function patchHistoryForSoftNav() {
    const wrap = (orig) =>
      function () {
        const ret = orig.apply(this, arguments);
        try {
          handleSoftNav();
        } catch {
          /* ignore */
        }
        return ret;
      };
    try {
      history.pushState = wrap(history.pushState);
      history.replaceState = wrap(history.replaceState);
    } catch {
      /* some pages freeze history; the poll below still covers us */
    }
    window.addEventListener("popstate", handleSoftNav);
    // Fallback for routers that change the URL without the History API hooks
    // firing in our isolated world.
    setInterval(handleSoftNav, 1000);
  })();


  /* ------------------------------------------------------------------ *
   * File attachments.
   *
   * Every supported site uploads an attachment the moment it is CHOSEN, not
   * when the message is sent — measured on ChatGPT (POST /backend-api/files),
   * Claude (POST .../upload) and Gemini (push.clients6.google.com/upload/),
   * each firing before the composer even re-rendered. So there is no moment
   * at send time to check a file in; the only interception point is the
   * change / drop / paste event itself.
   *
   * Those events are synchronous and reading a PDF is not, which rules out
   * scan-then-decide. So the model is QUARANTINE, then decide, then release:
   *
   *   1. a capture-phase listener on window sees the event first — before the
   *      site's own React handler, which is delegated to a root container far
   *      below us — and stops it dead. Nothing uploads.
   *   2. the bytes go to the parser frame, which reads and scans them.
   *   3. on approval the file is put back through the site's own file input
   *      and a change event is dispatched, which every site accepts.
   *
   * Release always goes through the file input, never by replaying the
   * original event. Synthetic drop and paste events do NOT work: on claude.ai
   * a synthetic dragenter raises the "Drop files here" overlay but a synthetic
   * drop carrying the same file produces no upload at all, because dropzone
   * code reads dataTransfer.items[].webkitGetAsEntry(), which is null for a
   * DataTransfer we built. A synthetic change on the input is accepted
   * everywhere, so all three entry points funnel onto that one release path.
   * ------------------------------------------------------------------ */

  /**
   * Files the user has already looked at and let through, keyed by identity
   * rather than content: hashing needs to read the file, and the listener has
   * to decide synchronously or the event is gone.
   *
   * This is a convenience, not a security boundary — the user has already
   * approved this exact file in this tab. It is what makes a drop or a paste
   * recoverable on a site where we cannot find an input to release into: the
   * approval is remembered, so attaching the same file again sails through.
   */
  const approvedFiles = new Set();
  const fileKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;

  /** Set while we re-dispatch an approved file, so we don't re-quarantine it. */
  let releasingFiles = false;

  /* ---- the parser frame ---- */
  /**
   * Replaces the frame round-trip with a plain function. Null in production and
   * settable only through the test hook at the bottom of this file — the frame
   * needs a real browser (an extension-origin iframe, a MessageChannel and a
   * PDF worker), none of which exist under jsdom, and the decision logic around
   * it is worth testing on its own. The mechanism itself was verified on the
   * live sites instead; see test/file-attach.cjs.
   */
  let parserTransport = null;
  let parserFrame = null;
  let parserPort = null;
  let parserBooting = null;
  let fileSeq = 0;
  const filePending = new Map();

  /**
   * Bring up the hidden extension-origin iframe that does the reading, and
   * hand it one end of a private MessageChannel.
   *
   * The channel matters. Without it the frame and this script would talk by
   * window.postMessage, which the host page can both read and forge — a page
   * could answer "nothing found" on the parser's behalf. Over a port, the page
   * has no handle to send on at all.
   */
  function ensureParser() {
    if (parserPort && parserFrame && document.contains(parserFrame)) {
      return Promise.resolve(parserPort);
    }
    if (parserBooting) return parserBooting;

    parserPort = null;
    if (parserFrame && parserFrame.parentNode) parserFrame.remove();

    parserBooting = new Promise((resolve, reject) => {
      let settled = false;
      const url = chrome.runtime.getURL("parser.html");
      const frame = document.createElement("iframe");
      frame.src = url;
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("tabindex", "-1");
      frame.style.cssText =
        "position:absolute!important;width:0!important;height:0!important;" +
        "border:0!important;opacity:0!important;pointer-events:none!important;" +
        "left:-9999px!important;top:-9999px!important;";

      // An origin, not the page URL. postMessage would extract the origin from
      // a full URL anyway, but being explicit means the check reads as what it
      // is: only this extension may receive the port.
      const origin = new URL(url).origin;
      const startedAt = Date.now();

      const onMessage = (e) => {
        // Only this frame, and only the one message we are waiting for.
        if (e.source !== frame.contentWindow) return;
        if (!e.data || e.data.guardai !== "parser-ready") return;
        window.removeEventListener("message", onMessage, true);

        const channel = new MessageChannel();
        channel.port1.onmessage = (ev) => onParserMessage(ev.data);
        channel.port1.start();
        frame.contentWindow.postMessage({ guardai: "parser-port" }, origin, [channel.port2]);
        parserPort = channel.port1;
        settled = true;
        console.info(`[GuardAI] file reader ready in ${Date.now() - startedAt}ms`);
        resolve(channel.port1);
      };

      window.addEventListener("message", onMessage, true);
      frame.onerror = () => {
        if (!settled) fail("the frame failed to load");
      };
      (document.body || document.documentElement).appendChild(frame);
      parserFrame = frame;

      setTimeout(() => { if (!settled) fail("no handshake within 15s"); }, 15000);

      /**
       * One place to give up, and it says where to look. This is the failure a
       * first install is most likely to hit — a missing web_accessible_resources
       * entry, or a host that refuses the frame — and without the URL in the
       * message there is nothing on screen or in the console to act on. The
       * caller turns this into "could not check this file", so a broken reader
       * asks the user rather than quietly letting the file through.
       */
      function fail(why) {
        window.removeEventListener("message", onMessage, true);
        console.error(
          `[GuardAI] file reader did not start (${why}). Frame URL: ${url} — check that ` +
          `manifest.json lists parser.html under web_accessible_resources, and look for ` +
          `errors against parser.html on chrome://extensions.`
        );
        reject(new Error("The file reader could not start."));
      }
    });

    parserBooting.catch(() => {}).then(() => { parserBooting = null; });
    return parserBooting;
  }

  /** Route a reply (or a progress tick) back to whoever asked for it. */
  function onParserMessage(msg) {
    if (!msg || typeof msg.id === "undefined") return;
    const entry = filePending.get(String(msg.id));
    if (!entry) return;
    if (msg.progress) {
      if (entry.onProgress) entry.onProgress(msg.progress);
      return;
    }
    filePending.delete(String(msg.id));
    clearTimeout(entry.timer);
    entry.resolve(msg);
  }

  /**
   * Read and scan one file. Resolves with the parser's verdict; rejects only
   * if the frame itself could not be reached, which the caller renders as
   * "could not check" — never as "clean".
   */
  async function scanFile(file, onProgress) {
    if (parserTransport) return parserTransport(file, onProgress, "scan");
    const port = await ensureParser();
    const bytes = await file.arrayBuffer();
    const id = String(++fileSeq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        filePending.delete(id);
        reject(new Error("Reading this file took too long."));
      }, 120000);
      filePending.set(id, { resolve, reject, timer, onProgress });
      try {
        // The buffer is transferred, not copied — a 20MB PDF costs nothing here
        // and this script loses its reference to the bytes at the same moment.
        port.postMessage({ id, name: file.name, type: file.type, bytes, limit: PASTE_LIMIT }, [bytes]);
      } catch (err) {
        // A dead port (the frame was torn out by a soft navigation) would
        // otherwise leave this pending until the two-minute timeout, with the
        // card sitting on "Checking…" the whole time. Fail now instead.
        clearTimeout(timer);
        filePending.delete(id);
        parserPort = null;
        reject(new Error("The file reader stopped responding."));
      }
    });
  }

  /**
   * Pull a document's text out for "Send as masked text". Runs only on the
   * user's click, re-extracts from the bytes (the frame keeps nothing), and
   * the frame re-checks suitability before releasing anything — so this
   * resolves to { ok:true, text } or { ok:false, why }, never text from a
   * document the check refused.
   */
  async function extractFileText(file) {
    if (parserTransport) return parserTransport(file, null, "extract");
    const port = await ensureParser();
    const bytes = await file.arrayBuffer();
    const id = String(++fileSeq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        filePending.delete(id);
        reject(new Error("Reading this file took too long."));
      }, 120000);
      filePending.set(id, { resolve, reject, timer });
      try {
        port.postMessage(
          { id, name: file.name, type: file.type, bytes, mode: "extract", limit: PASTE_LIMIT },
          [bytes]
        );
      } catch (err) {
        clearTimeout(timer);
        filePending.delete(id);
        parserPort = null;
        reject(new Error("The file reader stopped responding."));
      }
    });
  }

  /* ---- interception ---- */

  /** Files from any of the three entry points, or null. */
  function filesFrom(e) {
    if (e.type === "change") {
      const t = e.target;
      if (!t || t.tagName !== "INPUT" || t.type !== "file") return null;
      return t.files && t.files.length ? [...t.files] : null;
    }
    const dt = e.type === "drop" ? e.dataTransfer : e.clipboardData;
    if (!dt || !dt.files || !dt.files.length) return null;
    return [...dt.files];
  }

  /**
   * The listener the whole feature rests on. Capture phase, on window, so it
   * runs before any handler the site registered — React delegates from its
   * root container, which is below us in the tree, and the content script is
   * injected at document_start so even a site listening on window registers
   * after we do.
   */
  /**
   * Is this one file in scope for scanning right now?
   *
   * Images and documents are two separate switches because they are two
   * separate costs to the user: OCR on a screenshot is slower and more
   * intrusive than reading a PDF's text layer, and people reasonably want one
   * without the other. An unknown or unsupported file counts as a document,
   * which is the conservative reading: it means "unsupported" still gets
   * reported honestly instead of being silently dropped by an image switch.
   */
  function shouldScanFile(file) {
    const FS = window.GuardAI && window.GuardAI.FileScan;
    if (!FS || typeof FS.classify !== "function") return state.fileScanning;
    let kind = "";
    try { kind = (FS.classify(file && file.name, file && file.type) || {}).kind; } catch (_) {}
    return kind === "image" ? state.imageScanning : state.fileScanning;
  }

  function onAttach(e) {
    if (releasingFiles) return;          // our own re-dispatch
    if (!isActive()) return;             // master off, or unlicensed
    // Never intercept anything happening inside GuardAI's own UI.
    if (e.target && typeof e.target.closest === "function" &&
        e.target.closest(".guardai-panel, .guardai-prompt, .guardai-filecard")) return;

    const files = filesFrom(e);
    if (!files) return;

    // Already looked at and let through by the user, in this tab.
    if (files.every((f) => approvedFiles.has(fileKey(f)))) return;

    // Attachment scanning switched off — by the user, or pinned on by their
    // admin, which effectiveFrom() has already resolved into these two values.
    // Both are checked here rather than deeper in, so a file we are not going
    // to check is never taken custody of in the first place: the site's own
    // attach behaviour runs untouched and the user sees nothing at all, rather
    // than a card telling them about a check that did not happen.
    if (!files.some(shouldScanFile)) return;

    const input = e.type === "change" ? e.target : null;

    // Take custody. A change event cannot be cancelled — the file is already
    // in input.files — so stopping propagation is only half of it; the input
    // has to be emptied too, or anything that reads it later still finds the
    // file sitting there.
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
    if (input) { try { input.files = new DataTransfer().files; } catch (_) { /* older engines */ } }
    if (e.type === "drop") endDrag(e.target);

    reviewFiles(files, input).catch((err) => {
      console.warn("[GuardAI] file review failed:", err);
      showErrorToast("Could not check that file, so it was not attached. Try again, or turn GuardAI off for this one.");
    });
  }

  window.addEventListener("change", onAttach, true);
  window.addEventListener("drop", onAttach, true);
  window.addEventListener("paste", onAttach, true);

  /**
   * Put the site's drag overlay away after we have swallowed a drop.
   *
   * Every one of these sites raises a full-screen "Drop files here" panel on
   * dragenter and takes it down in its own drop handler. Stopping the drop is
   * the whole point of this feature, so that handler never runs and the panel
   * stays up — over the top of the card asking the user what to do about the
   * file, which is how it was reported.
   *
   * The site is the only thing that knows how to undo its own state, so this
   * does not hide anything itself. It sends the two events a dropzone resets
   * on, and lets the site tear its own overlay down:
   *
   *   dragleave    what a counter-style dropzone decrements on. Measured on
   *                chatgpt.com and claude.ai: one dragleave takes the panel
   *                down, and on ChatGPT it does so even after three
   *                unmatched dragenters.
   *   drop, empty  for a dropzone that only resets in its drop handler. It
   *                carries no files, so the site finds nothing to upload —
   *                and our own listener above ignores a file-less drop, so
   *                this cannot come back round.
   *
   * Both are sent because the two reset styles are not distinguishable from
   * out here, and neither is harmful to a site using the other.
   */
  function endDrag(target) {
    const node = target && target.nodeType === 1 ? target : document.body;
    if (!node) return;
    try {
      node.dispatchEvent(new DragEvent("dragleave", {
        bubbles: true, cancelable: true, dataTransfer: new DataTransfer(),
      }));
      node.dispatchEvent(new DragEvent("drop", {
        bubbles: true, cancelable: true, dataTransfer: new DataTransfer(),
      }));
    } catch (_) {
      /* DragEvent/DataTransfer unavailable — the overlay stays up, which is
         ugly but harmless; the file is still held either way. */
    }
  }

  /* ---- release ---- */

  /**
   * Which input do we put an approved file back through?
   *
   * The one that produced the event, whenever there was one — it is by
   * definition the input the site is listening to, and no selector can be
   * wrong about it. ChatGPT has three file inputs, two of them image-only
   * decoys, and Gemini creates and discards them as you go (twelve in one
   * session, two live at once), so "the first input on the page" is the same
   * mistake in a new place.
   *
   * Only a drop or a paste leaves us without one, and then the accept list is
   * the only evidence available: prefer an input that will take this file,
   * then one that takes anything, and never one that has excluded it.
   */
  function pickReleaseInput(files, origin) {
    if (origin && document.contains(origin)) return origin;

    const inputs = [...document.querySelectorAll('input[type="file"]')]
      .filter((i) => !i.disabled && !i.closest(".guardai-panel, .guardai-filecard"));
    if (!inputs.length) return null;

    const score = (input) => {
      const accept = (input.accept || "").trim();
      if (!accept) return 1;                        // takes anything
      const ok = files.every((f) => acceptsFile(accept, f));
      return ok ? 2 : -1;                           // matches, or excludes
    };
    let best = null, bestScore = 0;
    for (const i of inputs) {
      const s = score(i);
      if (s > bestScore) { best = i; bestScore = s; }
    }
    return best;
  }

  /** Does an accept attribute admit this file? */
  function acceptsFile(accept, file) {
    const name = (file.name || "").toLowerCase();
    const mime = (file.type || "").toLowerCase();
    return accept.split(",").some((rawTerm) => {
      const term = rawTerm.trim().toLowerCase();
      if (!term) return false;
      if (term.startsWith(".")) return name.endsWith(term);
      if (term.endsWith("/*")) return mime.startsWith(term.slice(0, -1));
      return mime === term;
    });
  }

  /**
   * Put approved files back. Returns true if the site took them; false if
   * there was nowhere to put them, in which case the caller tells the user to
   * attach again — the approval is remembered, so the second attempt passes
   * straight through.
   */
  function releaseFiles(files, origin) {
    const input = pickReleaseInput(files, origin);
    for (const f of files) approvedFiles.add(fileKey(f));
    if (!input) return false;

    try {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      releasingFiles = true;
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (err) {
      console.warn("[GuardAI] could not hand the file back:", err);
      return false;
    } finally {
      // Cleared on a later task so the site's own handler — which may read
      // the input asynchronously — is still inside the release window.
      setTimeout(() => { releasingFiles = false; }, 0);
    }
  }

  /* ---- the review flow ---- */

  /** Categories MARK_STYLE has no entry for (it covers the maskable ones). */
  const FILE_CAT_LABELS = {
    CONFIDENTIAL: "Marked confidential",
    BUSINESS_CONFIDENTIAL: "Commercially sensitive",
    HEALTH: "Health / medical",
    LEGAL: "Legal matter",
    IMMIGRATION: "Immigration / visa",
  };

  function catLabel(type) {
    if (MARK_STYLE[type]) return MARK_STYLE[type].label;
    if (FILE_CAT_LABELS[type]) return FILE_CAT_LABELS[type];
    return String(type).toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  }

  /**
   * Hold the files, check them, and decide what the user sees.
   *
   * The three outcomes are deliberately not two. "We read it and nothing in it
   * blocks", "we could not read it", and "we do not read this kind of file"
   * are different facts, and a file that was never scanned must never be
   * presented the way a scanned, clean one is.
   */
  async function reviewFiles(files, origin) {
    // A batch can mix a PDF with a screenshot while only one of the two
    // switches is on. Only the in-scope files are read, named on the card, or
    // counted — but the FULL batch is what gets released, so the ones we were
    // told not to look at are attached without comment. That is what the
    // switch means, and it keeps the card's promise intact: it never describes
    // a file it did not read.
    const scanning = files.filter(shouldScanFile);
    if (!scanning.length) { releaseFiles(files, origin); return; }

    const card = showFileCard(scanning);
    const results = [];

    for (const file of scanning) {
      try {
        const res = await scanFile(file, (p) => card.progress(file, p));
        results.push({ file, res });
      } catch (err) {
        results.push({
          file,
          res: {
            kind: "unknown",
            label: "File",
            action: "unreadable",
            reason: (err && err.message) || "Could not read this file.",
          },
        });
      }
    }

    const blocked = results.filter((r) =>
      r.res.action === "block" || r.res.action === "img-found");
    // Every image outcome is in here, including "nothing found" — an OCR
    // read is a partial read by nature, so an image is NEVER auto-released
    // the way a clean document is. The user decides, every time.
    //
    // And the membership test is inverted on purpose: anything that is not
    // LITERALLY the clean-document verdict counts as unchecked. The first
    // build listed the held actions instead, which meant an action string
    // this router didn't know fell through BOTH lists and auto-released as
    // clean — observed live when a stale content script met a newer parser
    // frame: an image with findings sailed through with "Checked — nothing
    // blocked". A verdict this code does not recognise is a file it cannot
    // vouch for, and must fail CLOSED.
    //
    // "img-nothing" is the one image outcome that may release on its own, and
    // only while the hard-stop setting is off. Reason it survives the rule
    // above: OCR did read the image and the rules did run over what it read,
    // so this is a check that happened — unlike img-unreadable, where there
    // is no result to report at all. What it is NOT is a clean bill of
    // health, and cleared() has a separate wording for it that says so.
    // Making it a decision meant a click on every clean screenshot, which
    // trains people to click past the two states that DO carry news.
    const softImage = (r) => r.res.action === "img-nothing" && !state.imageHardStop;
    const unchecked = results.filter((r) =>
      r.res.action !== "pass" && r.res.action !== "block" && r.res.action !== "img-found" &&
      !softImage(r));

    reportFileStats(results);

    if (!blocked.length && !unchecked.length) {
      // Everything read, nothing worth stopping for. Hand it straight back and
      // say so briefly — the user still deserves to know a check happened.
      const ok = releaseFiles(files, origin);
      card.cleared(results, ok);
      return;
    }

    card.decide(results, {
      onAllow: () => {
        const ok = releaseFiles(files, origin);
        card.close();
        if (!ok) {
          showErrorToast(
            files.length === 1
              ? `Attach ${files[0].name} again and it will go straight through.`
              : "Attach those files again and they will go straight through."
          );
        }
      },
      onCancel: () => {
        card.close();
      },
    });
  }

  /**
   * Count what was found, never what it was.
   *
   * Same two channels as a text catch: local session stats, and — for a
   * connected company — one event per category through src/company.js, which
   * rebuilds every body from three checked primitives and drops anything it
   * cannot verify. A file cannot widen that: only category names reach it.
   */
  function reportFileStats(results) {
    let detected = 0;
    const categories = new Set();
    for (const { res } of results) {
      const s = res.summary;
      if (!s) continue;
      detected += s.blockingCount || 0;
      for (const type of s.blocking || []) categories.add(type);
    }
    reportStats({
      filesChecked: results.length,
      filesBlocked: results.filter(
        (r) => r.res.action === "block" || r.res.action === "img-found").length,
      detected,
    });
    // reportCompanyCategories reads one field off each entry and builds a
    // fresh array of strings, so it is handed shapes, not findings.
    if (categories.size) reportCompanyCategories([...categories].map((type) => ({ type })));
  }

  /* ---- "Send as masked text" ---- */

  /**
   * Mask a document's text with the SAME pipeline as a typed message:
   * scanText (detector + NLP + the user's category toggles), the masker's own
   * previewFake for stand-ins, one fake per distinct real value.
   *
   * Deliberately does NOT register the mappings — previewFake exists exactly
   * so a preview can be shown without committing anything. Registration
   * happens in insertDocText, only after the masked text has fully landed in
   * the composer: a preview the user cancels leaves no trace in the mapping
   * store, and a fill that comes up short registers nothing it cannot honour.
   */
  /**
   * Trailing company designators, for linking case/suffix variants of ONE
   * organisation. "MERIDIAN FACILITIES GROUP PTY LTD" in a letterhead and
   * "Meridian Facilities Group" in the signature are the same entity; masking
   * them independently gave the same company two unrelated stand-ins in one
   * document (worse than either treatment alone, because the reader infers
   * two companies). Stem = lowercased value minus these tail words.
   */
  const ORG_TAIL_WORDS = new Set([
    "pty", "ltd", "limited", "inc", "incorporated", "llc", "llp", "plc",
    "corp", "corporation", "p/l", "group", "holdings", "co",
  ]);
  function orgSplit(value) {
    const words = value.trim().split(/\s+/);
    let cut = words.length;
    while (cut > 1 && ORG_TAIL_WORDS.has(words[cut - 1].toLowerCase().replace(/[^a-z/]/gi, "").toLowerCase())) cut--;
    return { stem: words.slice(0, cut).join(" ").toLowerCase(), tail: words.slice(cut).join(" ") };
  }
  const isAllCaps = (v) => !/\p{Ll}/u.test(v) && /\p{Lu}/u.test(v);
  const titleCase = (v) => v.replace(/\p{L}[\p{L}'\u2019-]*/gu,
    (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

  /* ---- identifiers that belong to a person ------------------------------ *
   *
   * An email address usually CONTAINS its owner's name, so masking the two
   * independently produced a signature block naming three different people:
   *
   *     Dakota Ellery                       (real: Dana Whitcombe)
   *     declan.marshall45@placeholder.com   (real: dana.whitcombe@\u2026)
   *
   * Filed as cosmetic. It is not. On a live round trip ChatGPT read the local
   * part, inferred a person from it, and reported "the sender is Dakota
   * Ellery but the email belongs to Declan Marshall" as a defect IN THE
   * DOCUMENT \u2014 two of its fifteen findings were artefacts of our masking. And
   * "Declan Marshall" cannot be restored: the mapping table holds the whole
   * address, never the name the AI read out of it, so the fake name survived
   * into the user's own reading of the reply.
   *
   * Deriving the address from the person's own stand-in fixes both. The
   * signature reads as one person, and the name the AI infers is now a fake
   * that IS in the table, so it restores like any other.
   */

  /** Shared mailboxes belong to no one; binding them to a nearby person would
   *  invent a relationship the real document does not have. */
  const ROLE_ACCOUNTS = new Set([
    "info", "admin", "hr", "accounts", "payroll", "support", "help", "contact",
    "enquiries", "enquiry", "sales", "office", "reception", "careers", "jobs",
    "noreply", "no-reply", "donotreply", "billing", "finance", "team", "mail",
    "hello", "service", "orders", "invoices", "recruitment", "people",
  ]);

  /** First and last token of a name, lowercased and stripped to letters. */
  function nameParts(name) {
    const parts = String(name || "").trim().split(/\s+/)
      .map((p) => p.toLowerCase().replace(/[^\p{L}]/gu, ""))
      .filter(Boolean);
    if (parts.length < 2) return null;
    return { first: parts[0], last: parts[parts.length - 1] };
  }

  /**
   * Which masked person does this identifier belong to?
   *
   * Containment first \u2014 the real address naming the real person is EVIDENCE
   * from the document. Proximity second and deliberately tight, because it is
   * an inference: it can only bind a personal-looking address to the single
   * name beside it, which is the signature-block shape and little else.
   * Guessing wrong costs coherence, exactly what we have today, so a wrong
   * guess is never worse than not guessing \u2014 but a guess that INVENTS a
   * relationship the document does not assert would be, hence the narrow window.
   */
  const OWNER_WINDOW = 120;
  function identifierOwner(item, nameItems) {
    if (!nameItems.length) return null;
    const local = item.type === "EMAIL"
      ? String(item.value).split("@")[0]
      : String(item.value);
    const lower = local.toLowerCase();
    const tokens = lower.split(/[^\p{L}]+/u).filter((t) => t.length > 1);
    if (tokens.length === 1 && ROLE_ACCOUNTS.has(tokens[0])) return null;

    const scored = [];
    for (const n of nameItems) {
      const np = nameParts(n.value);
      if (!np) continue;
      let score = 0;
      // The surname is the strong signal; substring as well as token, since
      // handles run the initial straight onto it ("mellery").
      if (np.last.length > 2 && (tokens.includes(np.last) || lower.includes(np.last))) score += 3;
      if (np.first.length > 1 && (tokens.includes(np.first) || lower.includes(np.first))) score += 2;
      // "p.raghunathan91" \u2014 the initial only breaks a tie once the surname
      // already matched, so it can never bind on its own.
      if (score >= 3 && lower[0] === np.first[0]) score += 1;
      if (score > 0) scored.push({ n, score, dist: Math.abs(n.start - item.start) });
    }
    if (scored.length) {
      // Two people can share a surname \u2014 "Priya Raghunathan" and "Anand
      // Raghunathan" both match "p.raghunathan91". Highest score wins, then
      // whichever is nearest in the document.
      scored.sort((a, b) => b.score - a.score || a.dist - b.dist);
      return scored[0].n;
    }
    // Proximity: only when exactly ONE person is named in the window.
    const near = nameItems.filter((n) => Math.abs(n.start - item.start) <= OWNER_WINDOW);
    const distinct = new Set(near.map((n) => n.value));
    return distinct.size === 1 ? near[0] : null;
  }

  /**
   * Rebuild an identifier's stand-in around the owner's stand-in name, keeping
   * the domain and trailing digits the generator already chose so the shape,
   * and everything the shape reveals, is unchanged.
   */
  function deriveIdentifierFake(type, generated, ownerFake) {
    const np = nameParts(ownerFake);
    if (!np) return null;
    if (type === "EMAIL") {
      const at = String(generated).indexOf("@");
      if (at < 0) return null;
      const digits = (generated.slice(0, at).match(/\d+$/) || [""])[0];
      return `${np.first}.${np.last}${digits}${generated.slice(at)}`;
    }
    if (type === "USERNAME") {
      const digits = (String(generated).match(/\d+$/) || [""])[0];
      return `${np.first[0]}${np.last}${digits}`;
    }
    return null;
  }

  /**
   * The derived stand-in, or null to keep the random draw.
   *
   * Separate from the loop that uses it so a test can drive the REFUSALS
   * directly. They are the part that matters and the part chance will not
   * reach: a leak needs the owner's random fake name to collide with the real
   * address, about 1 draw in 40, so a test that waits for one to happen is
   * asserting on a coin it mostly never flips.
   */
  function safeDerivedFake(item, ownerFake, usedFakes) {
    const derived = deriveIdentifierFake(item.type, item.fake, ownerFake);
    if (!derived || derived === item.fake) return null;
    // The owner's stand-in name can itself collide with the REAL address — a
    // fake "Dakota Ellery" is a leak for a real "dakota.smith@…". Safety
    // outranks coherence: keep the random draw when that happens.
    if (masker.wouldLeak(item.type, item.value, derived)) return null;
    // And never take a stand-in another value already holds.
    if ((usedFakes && usedFakes.has(derived)) || masker.fakeToReal.has(derived)) return null;
    return derived;
  }

  /* ---- the preview ---- */

  let filePreviewEl = null;

  function dismissFilePreview() {
    if (filePreviewEl) { filePreviewEl.remove(); filePreviewEl = null; }
  }

  /**
   * The mandatory look-before-it-goes step. The masked text is shown in full
   * and nothing touches the composer until the user says so — they judge the
   * output, not our confidence in it. The body is set with textContent,
   * never markup, so document text cannot smuggle HTML into our own UI.
   */
  function showSafeTextPreview(file, masked, items, handlers) {
    dismissFilePreview();
    const wrap = document.createElement("div");
    wrap.className = "guardai-fileprev";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-label", "Check the text before it is sent");

    const counts = {};
    for (const it of items) counts[it.type] = (counts[it.type] || 0) + 1;
    const breakdown = Object.keys(counts)
      .sort((a, b) => counts[b] - counts[a])
      .map((t) => `${counts[t]} ${catLabel(t).toLowerCase()}`)
      .join(", ");

    wrap.innerHTML =
      `<div class="guardai-fileprev__grip" title="Drag to move" aria-label="Drag to move"></div>` +
      `<div class="guardai-fileprev__head">` +
      `<span class="guardai-fileprev__shield">${SHIELD_SVG}</span>` +
      `<span class="guardai-fileprev__title">Check what will be sent</span>` +
      `<button class="guardai-fileprev__close" aria-label="Cancel">&times;</button>` +
      `</div>` +
      `<p class="guardai-fileprev__meta">${escapeHtml(file.name)} — ` +
      escapeHtml(items.length
        ? `masked ${items.length} item${items.length === 1 ? "" : "s"}: ${breakdown}.`
        : "nothing needed masking.") +
      ` This text replaces the file; the reply unmasks as usual.</p>` +
      `` +
      `<div class="guardai-fileprev__text" tabindex="0"></div>` +
      `<div class="guardai-fileprev__btns">` +
      `<button class="guardai-act guardai-act--primary guardai-fileprev__btn guardai-fileprev__btn--masksend">Mask &amp; Send</button>` +
      `<button class="guardai-act guardai-act--secondary guardai-fileprev__btn guardai-fileprev__btn--maskedit">Mask &amp; Edit</button>` +
      `</div>` +
      `<div class="guardai-fileprev__btns guardai-fileprev__btns--secondary">` +
      `<button class="guardai-act guardai-act--secondary guardai-fileprev__btn guardai-fileprev__btn--manual">Manual mask</button>` +
      `<button class="guardai-act guardai-act--danger guardai-fileprev__btn guardai-fileprev__btn--anyway">Send anyway</button>` +
      `</div>`;
    wrap.querySelector(".guardai-fileprev__text").textContent = masked;

    document.body.appendChild(wrap);
    filePreviewEl = wrap;
    makePromptDraggable(wrap, {
      grip: ".guardai-fileprev__grip",
      head: ".guardai-fileprev__head",
      draggingClass: "guardai-fileprev--dragging",
    });
    placeFileCard(wrap);

    const done = () => dismissFilePreview();
    wrap.querySelector(".guardai-fileprev__close").onclick = () => { done(); handlers.onCancel(); };
    // The same four actions as the text card, wired to the same handlers —
    // the preview is a presentation layer over the ordinary mask flow, not a
    // second implementation of it.
    const wire = (sel, label, fn) => {
      wrap.querySelector(sel).onclick = async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = "Working…";
        try {
          done();
          await fn();
        } catch (err) {
          console.error("[GuardAI] " + label + " (file) failed:", err);
          showErrorToast(label + " failed — please reload the page and try again.");
        }
      };
    };
    wire(".guardai-fileprev__btn--masksend", "Mask & Send", handlers.onMaskSend);
    wire(".guardai-fileprev__btn--maskedit", "Mask & Edit", handlers.onMaskEdit);
    wire(".guardai-fileprev__btn--manual", "Manual mask", handlers.onManual);
    wire(".guardai-fileprev__btn--anyway", "Send anyway", handlers.onSendAnyway);
  }

  /**
   * The whole click flow: extract (the frame re-checks suitability before
   * releasing anything), mask, preview, and only on the user's confirm,
   * insert. The card stays up behind the preview so Cancel falls back to the
   * ordinary attach decision.
   */
  async function startSafeText(file, statusEl) {
    try {
      const ex = await extractFileText(file);
      if (!ex || ex.ok !== true || typeof ex.text !== "string") {
        if (statusEl) statusEl.textContent = (ex && ex.why) || "Could not read the text out of this file.";
        return;
      }
      const editor = findEditor();
      if (!editor) {
        if (statusEl) statusEl.textContent = "Could not find the chat input on this page.";
        return;
      }
      const text = ex.text;
      const findings = await scanText(text);
      // ONE model for everything the preview leads to. The preview string is
      // computeMasked() over this exact model, and the Mask & Send / Mask &
      // Edit buttons hand the SAME model on via {prebuilt:true} — so the
      // masked text the user reads is, by construction, the masked text that
      // can be sent. Two separate fake draws is how a preview lies.
      await buildReviewModel(editor, text, findings, { docPolicy: true });
      if (!review) {
        if (statusEl) statusEl.textContent = "Something interrupted masking — please try again.";
        return;
      }
      const masked = computeMasked();
      const docOpts = { docPolicy: true, prebuilt: true };
      // A soft-nav can null the global `review` while the preview sits open;
      // prebuilt would then rebuild with FRESH fakes and the preview would
      // lie. Capture the model and put it back before any action runs.
      const model = review;
      const restoreModel = () => { if (!review) review = model; };
      showSafeTextPreview(file, masked, review.items, {
        onMaskSend: async () => {
          dismissFileCard();
          restoreModel();
          await doMaskAndSend(editor, text, findings, docOpts);
        },
        onMaskEdit: async () => {
          dismissFileCard();
          restoreModel();
          await doMaskAndEdit(editor, text, findings, docOpts);
        },
        onManual: async () => {
          dismissFileCard();
          review = null; // manual builds its own state from the original text
          await doManualMask(editor, text);
        },
        onSendAnyway: async () => {
          // The same deliberate step the text card offers: the ORIGINAL text,
          // unmasked, sent as the user's own choice. Fill, verify, send.
          dismissFileCard();
          review = null;
          suppressSends = true;
          let ok;
          try {
            ok = await typeText(editor, text);
          } finally {
            suppressSends = false;
          }
          const live = liveEditor() || editor;
          if (!ok || normalize(getEditorText(live)) !== normalize(text)) {
            try { clearEditor(live); } catch (_) { /* nothing to recover */ }
            showErrorToast("The text couldn't be placed into the chat box, so nothing was sent.");
            return;
          }
          state.lastMaskedText = text; // their own send passes without a re-scan
          reportStats({ sentUnmasked: findings.length });
          bypassNext = true;
          makeResender(live)();
        },
        onCancel: () => { review = null; },
      });
    } catch (err) {
      console.warn("[GuardAI] send-as-text failed:", err);
      if (statusEl) statusEl.textContent = "Could not read the text out of this file.";
    }
  }

  /* ---- the card ---- */

  let fileCardEl = null;

  /**
   * Put the card in the middle of what the user is actually looking at.
   *
   * Not the middle of the window. Every one of these sites has a sidebar, so
   * the viewport centre sits well to the left of the column the conversation is
   * in — centred by the numbers, visibly off-centre to a person. The composer
   * is the best available proxy for that column: it is centred in it on every
   * platform, and findEditor() already knows how to locate it past the decoys.
   * Where there is no usable composer, the viewport centre is the fallback.
   *
   * Vertically it is the viewport, which needs no proxy.
   *
   * Does nothing once the user has dragged the card. The whole point of being
   * able to move it is that it stays where it was put, and this runs again
   * after every re-render — checking, then the category list, then the result —
   * so without that check it would haul the card back to centre three times.
   */
  function placeFileCard(el) {
    const w = el.offsetWidth || 400;
    const h = el.offsetHeight || 320;

    if (el._dragged) {
      // Still keep it on screen: the states differ in height, and one that
      // grew after being dragged to the bottom edge would hang off it.
      const left = Math.max(8, Math.min(parseFloat(el.style.left) || 0, window.innerWidth - w - 8));
      const top = Math.max(8, Math.min(parseFloat(el.style.top) || 0, window.innerHeight - h - 8));
      el.style.left = left + "px";
      el.style.top = top + "px";
      return;
    }

    let centreX = window.innerWidth / 2;
    try {
      const editor = findEditor();
      if (editor) {
        const r = editor.getBoundingClientRect();
        // A zero-width rect means unlaid-out or hidden, not "at the left edge".
        if (r && r.width > 0) centreX = r.left + r.width / 2;
      }
    } catch (_) {
      /* no composer on this page — the viewport centre is fine */
    }

    let left = Math.round(centreX - w / 2);
    let top = Math.round((window.innerHeight - h) / 2);
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    el.style.left = left + "px";
    el.style.top = top + "px";
  }

  function dismissFileCard() {
    if (fileCardEl) { fileCardEl.remove(); fileCardEl = null; }
  }

  // A card is fixed to the viewport, so a resize can leave it half off-screen —
  // and it can be open for a while on a long PDF.
  window.addEventListener("resize", () => {
    if (fileCardEl) placeFileCard(fileCardEl);
  }, true);

  function fileSizeText(bytes) {
    if (!bytes) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  /**
   * One card, three states: checking, cleared, decide. It is created the
   * instant a file is taken and never left in the first state without a
   * timeout behind it, because a card stuck on "Checking…" is indistinguishable
   * from an extension that has silently eaten someone's attachment.
   */
  function showFileCard(files) {
    dismissFileCard();
    const wrap = document.createElement("div");
    wrap.className = "guardai-filecard";
    wrap.setAttribute("role", "alertdialog");
    wrap.setAttribute("aria-live", "polite");
    document.body.appendChild(wrap);
    fileCardEl = wrap;

    const names = files.map((f) => f.name);
    const head = (title) =>
      `<div class="guardai-filecard__head">` +
      `<span class="guardai-filecard__shield">${SHIELD_SVG}</span>` +
      `<span class="guardai-filecard__title">${escapeHtml(title)}</span>` +
      `<button class="guardai-filecard__close" aria-label="Dismiss">&times;</button>` +
      `</div>`;

    const render = (html) => {
      wrap.innerHTML =
        `<div class="guardai-filecard__grip" title="Drag to move" aria-label="Drag to move"></div>` +
        html;
      const close = wrap.querySelector(".guardai-filecard__close");
      if (close) close.onclick = () => dismissFileCard();
      // innerHTML threw the old handles away, so both have to be re-attached.
      // _dragged lives on the element, so a card the user moved stays moved.
      makePromptDraggable(wrap, {
        grip: ".guardai-filecard__grip",
        head: ".guardai-filecard__head",
        draggingClass: "guardai-filecard--dragging",
      });
      placeFileCard(wrap);
    };

    render(
      head(files.length === 1 ? "Checking this file…" : `Checking ${files.length} files…`) +
        `<ul class="guardai-filecard__files">` +
        files
          .map(
            (f) =>
              `<li class="guardai-filecard__file" data-name="${escapeHtml(f.name)}">` +
              `<span class="guardai-filecard__fname">${escapeHtml(f.name)}</span>` +
              `<span class="guardai-filecard__fmeta">${escapeHtml(fileSizeText(f.size))}</span>` +
              `</li>`
          )
          .join("") +
        `</ul>` +
        `<p class="guardai-filecard__note">Reading it on this device. Nothing has been uploaded.</p>`
    );

    return {
      /**
       * Live progress from the parser: per-page for long PDFs, and for
       * images a stage line then a percentage. OCR on a text-dense retina
       * screenshot measured 14 seconds — a card that sits silent that long
       * reads as an extension that ate the attachment, so the percentage
       * ticks with tesseract's own recognition progress rather than
       * animating a guess.
       */
      progress(file, p) {
        if (fileCardEl !== wrap) return;
        const row = wrap.querySelector(
          `.guardai-filecard__file[data-name="${CSS.escape(file.name)}"] .guardai-filecard__fmeta`
        );
        if (!row || !p) return;
        // A scanned page takes about a second to read, against a few
        // milliseconds to pull text out of a normal one — so it says which
        // thing is happening, not just a number that appears to have stalled.
        if (p.stage === "ocr" && p.total) row.textContent = `reading page ${p.page} of ${p.total}…`;
        else if (p.total) row.textContent = `page ${p.page} of ${p.total}`;
        else if (p.stage === "loading") row.textContent = "starting the reader…";
        else if (typeof p.pct === "number") row.textContent = `reading the image… ${p.pct}%`;
      },

      /**
       * Read, nothing blocking. Brief, then gone — a notice, not a decision.
       *
       * TWO wordings, and which one is used is decided by whether an IMAGE is
       * present, not by what was found. A document extractor reads every
       * character, so "checked" is a claim it can make. OCR reads what it can
       * see, so for an image that claim would be false — the notice says we
       * looked, says what we found, and says plainly that we cannot read
       * everything in an image. It attaches either way; the difference is
       * only in what it promises.
       */
      cleared(results, released) {
        if (fileCardEl !== wrap) return;
        const counted = results.reduce((n, r) => n + ((r.res.summary && r.res.summary.total) || 0), 0);
        const anyImage = results.some((r) => r.res.action === "img-nothing" || r.res.kind === "image");
        const one = names.length === 1;
        const it = one ? "this image" : "these images";

        const body = anyImage
          ? (results.every((r) => r.res.action === "img-nothing" || r.res.kind === "image")
              ? `GuardAI read what it could see in ${it} and found nothing sensitive. ` +
                `It can't read everything in an image, so this isn't a clean bill of health — ` +
                `if ${one ? "it shows" : "they show"} something private, that's still your call.`
              : `GuardAI read these files and found nothing sensitive. It can't read everything ` +
                `in an image, so the screenshot among them isn't a clean bill of health — ` +
                `if it shows something private, that's still your call.`)
          : (counted
              ? `GuardAI read ${one ? "this file" : "these files"} and found ` +
                `${counted} item${counted === 1 ? "" : "s"} of ordinary personal information — ` +
                `names, addresses and the like — but nothing it would stop you sending.`
              : `GuardAI read ${one ? "this file" : "these files"} and found nothing sensitive.`);

        render(
          head(anyImage ? "Attached — nothing found, but have a look" : "Checked — nothing blocked") +
            `<p class="guardai-filecard__note">${escapeHtml(body)}</p>` +
            (released ? "" :
              `<p class="guardai-filecard__note guardai-filecard__note--warn">Attach it again to send it.</p>`)
        );
        // An image notice sits a little longer than a document one: it is
        // asking the reader to do something (look at their own screenshot)
        // rather than just reporting that a check ran.
        setTimeout(() => { if (fileCardEl === wrap) dismissFileCard(); },
          released ? (anyImage ? 6500 : 4000) : 9000);
      },

      /** Something blocks, or something could not be read. The user decides. */
      decide(results, handlers) {
        if (fileCardEl !== wrap) return;
        const anyBlocked = results.some(
          (r) => r.res.action === "block" || r.res.action === "img-found");
        // Only image results, none of which found anything: the header must
        // not claim a check failed OR that the file is clean — "nothing in
        // what it could read" is the whole truth available.
        const onlyImgNothing = results.every((r) => r.res.action === "img-nothing");

        /* "Send as masked text": extract the text, mask it with the same rules,
           send it as a message instead of attaching the file. Offered ONLY
           when the parser's suitability check says the extraction genuinely
           reads — a jumbled paste is worse than a block, because the user
           sends it without noticing and gets a confidently wrong answer.
           One file at a time: concatenating several documents into one
           message has no honest preview. When the option is withheld on a
           readable-looking file, the reason appears in one plain line —
           silence is worse than a reason. The same line doubles as the
           status row if extraction later fails. */
        const single = results.length === 1;
        const suit = single ? results[0].res.suit : null;
        const safeTextRow =
          single && suit && suit.offer
            ? `<div class="guardai-filecard__btns guardai-filecard__btns--safetext">` +
              `<button class="guardai-act guardai-act--primary guardai-filecard__btn--safetext">Send as masked text</button>` +
              `</div><p class="guardai-filecard__textwhy"></p>`
            : single && suit && !suit.offer
              ? `<p class="guardai-filecard__textwhy">${escapeHtml('"Send as masked text" is not available: ' + suit.why)}</p>`
              : "";

        const body = results
          .map(({ file, res }) => {
            const title =
              `<div class="guardai-filecard__fhead">` +
              `<span class="guardai-filecard__fname">${escapeHtml(file.name)}</span>` +
              `<span class="guardai-filecard__fmeta">${escapeHtml(res.label || "")}` +
              (res.pages ? `, ${res.pages} page${res.pages === 1 ? "" : "s"}` : "") +
              `</span></div>`;

            if (res.action === "unsupported") {
              return (
                `<li class="guardai-filecard__file guardai-filecard__file--unchecked">${title}` +
                `<p class="guardai-filecard__why">GuardAI cannot read ${escapeHtml(
                  (res.label || "this kind of file").toLowerCase()
                )}s yet, so this one has <strong>not been checked</strong>.</p></li>`
              );
            }
            if (res.action === "too-large") {
              return (
                `<li class="guardai-filecard__file guardai-filecard__file--unchecked">${title}` +
                `<p class="guardai-filecard__why">Too large to check (over ${escapeHtml(
                  String(res.limitMB || 30)
                )} MB), so it has <strong>not been checked</strong>.</p></li>`
              );
            }
            if (res.action === "unreadable") {
              return (
                `<li class="guardai-filecard__file guardai-filecard__file--unchecked">${title}` +
                `<p class="guardai-filecard__why">${escapeHtml(
                  res.reason || "GuardAI could not read this file."
                )} It has <strong>not been checked</strong>.</p></li>`
              );
            }

            /* The three image states. None of them borrow the document
               wording, because a document extractor reads every character
               and OCR reads what it can see — "checked" and "clean" are
               promises OCR cannot make. */
            if (res.action === "img-unreadable") {
              return (
                `<li class="guardai-filecard__file guardai-filecard__file--unchecked">${title}` +
                `<p class="guardai-filecard__why"><strong>GuardAI could not read this image properly.</strong> ` +
                `${escapeHtml(res.reason || "")} Treat it as unchecked — attach it only if you know what it shows.</p></li>`
              );
            }
            if (res.action === "img-nothing") {
              return (
                `<li class="guardai-filecard__file guardai-filecard__file--unchecked">${title}` +
                `<p class="guardai-filecard__why">GuardAI read what it could see in this image and ` +
                `nothing it read looks sensitive. It cannot read everything a person can — small print, ` +
                `stylised text, a photo of a screen — so look it over yourself before attaching.</p></li>`
              );
            }
            /* A scan where only the first pages were read. This NEVER takes
               the auto-attach path: "nothing in the 5 pages we read of 40"
               is not "nothing in this file", and delivered the way a clean
               file is delivered it would read as exactly that. The unread
               pages are stated first, in numbers, before any reassurance. */
            if (res.action === "pdf-partial") {
              const read = Number(res.pagesRead) || 0;
              const all = Number(res.pagesTotal) || 0;
              const rest = Math.max(0, all - read);
              return (
                `<li class="guardai-filecard__file guardai-filecard__file--unchecked">${title}` +
                `<p class="guardai-filecard__why">This is a scan, so GuardAI read it as pictures. ` +
                `<strong>It read the first ${read} page${read === 1 ? "" : "s"} of ${all} and ` +
                `did not read the other ${rest}.</strong> Nothing sensitive turned up in the pages it ` +
                `did read — but that says nothing about the rest, so treat this as ` +
                `<strong>not fully checked</strong>.</p></li>`
              );
            }

            // Only the two found-something verdicts render category rows.
            // Anything else that reaches this point is a verdict this build
            // does not recognise — render it as unchecked, mirroring the
            // fail-closed routing in reviewFiles.
            if (res.action !== "block" && res.action !== "img-found") {
              return (
                `<li class="guardai-filecard__file guardai-filecard__file--unchecked">${title}` +
                `<p class="guardai-filecard__why">GuardAI got a check result it does not recognise ` +
                `for this file, so treat it as <strong>not checked</strong>.</p></li>`
              );
            }

            const s = res.summary || { blocking: [], other: [], counts: {}, pageHits: {} };
            const rows = (s.blocking || [])
              .map((type) => {
                const pages = (s.pageHits && s.pageHits[type]) || [];
                const where = pages.length
                  ? ` <span class="guardai-filecard__where">page${pages.length === 1 ? "" : "s"} ${pages
                      .slice(0, 6)
                      .join(", ")}${pages.length > 6 ? "…" : ""}</span>`
                  : "";
                return (
                  `<li class="guardai-filecard__cat">` +
                  `<span class="guardai-filecard__catname">${escapeHtml(catLabel(type))}</span>` +
                  `<span class="guardai-filecard__catcount">${s.counts[type]}</span>` +
                  where +
                  `</li>`
                );
              })
              .join("");

            const otherTotal = (s.other || []).reduce((n, t) => n + s.counts[t], 0);
            const other = otherTotal
              ? `<p class="guardai-filecard__why">Also present, but not blocked: ${escapeHtml(
                  (s.other || [])
                    .slice(0, 5)
                    .map((t) => `${s.counts[t]} ${catLabel(t).toLowerCase()}`)
                    .join(", ")
                )}${(s.other || []).length > 5 ? ", and more" : ""}.</p>`
              : "";

            // "img-found" reaches here too: same category rows, same counts,
            // same vocabulary as a document — plus one line owning that an
            // OCR read is a partial read even when it found something.
            // A scan that DID turn something up still has to say how much of
            // it was read: findings on pages 1-5 of 40 are news, and the
            // other 35 pages are a separate fact the user needs alongside.
            const partial = res.action === "img-found"
              ? (res.partial
                  ? `<p class="guardai-filecard__why">Read from the scan itself — GuardAI read the ` +
                    `first ${Number(res.pagesRead) || 0} page` + ((Number(res.pagesRead) || 0) === 1 ? "" : "s") +
                    ` of ${Number(res.pagesTotal) || 0} and did not read the rest.</p>`
                  : `<p class="guardai-filecard__why">Read from the image itself — GuardAI may not have read all of it.</p>`)
              : "";

            return (
              `<li class="guardai-filecard__file guardai-filecard__file--blocked">${title}` +
              `<ul class="guardai-filecard__cats">${rows}</ul>${other}${partial}</li>`
            );
          })
          .join("");

        render(
          head(anyBlocked
            ? "Not attached — check this first"
            : onlyImgNothing
              ? "Not attached — nothing found, your call"
              : "Not attached — GuardAI could not check it") +
            `<p class="guardai-filecard__platform">${escapeHtml(
              `Going to ${CONFIG.name}. ${CONFIG.note || ""}`
            )}</p>` +
            `<ul class="guardai-filecard__files">${body}</ul>` +
            safeTextRow +
            `<div class="guardai-filecard__btns">` +
            `<button class="guardai-act guardai-act--secondary guardai-filecard__btn--cancel">Don't attach</button>` +
            `<button class="guardai-act guardai-act--danger guardai-filecard__btn--allow">Attach anyway</button>` +
            `</div>`
        );

        wrap.querySelector(".guardai-filecard__btn--cancel").onclick = handlers.onCancel;
        wrap.querySelector(".guardai-filecard__btn--allow").onclick = handlers.onAllow;
        const safeBtn = wrap.querySelector(".guardai-filecard__btn--safetext");
        if (safeBtn) {
          safeBtn.onclick = async () => {
            safeBtn.disabled = true;
            safeBtn.textContent = "Reading the document…";
            const statusEl = wrap.querySelector(".guardai-filecard__textwhy");
            await startSafeText(results[0].file, statusEl);
            if (fileCardEl === wrap) {
              safeBtn.disabled = false;
              safeBtn.textContent = "Send as masked text";
            }
          };
        }
      },

      close() { if (fileCardEl === wrap) dismissFileCard(); },
    };
  }

  // Test hook: drives the real attachment interception — which input an
  // approved file is handed back through, what an accept list admits, and the
  // approval memory — with the parser frame swapped for a plain function.
  window.GuardAI._fileHooks = {
    filesFrom,
    endDrag,
    placeFileCard,
    acceptsFile,
    pickReleaseInput,
    releaseFiles,
    reviewFiles,
    fileKey,
    approvedFiles,
    catLabel,
    setParser: (fn) => { parserTransport = fn; },
    startSafeText,
    // The person-to-identifier rule, exposed so its REFUSALS can be driven
    // directly rather than waited for — see safeDerivedFake.
    identifierOwner,
    deriveIdentifierFake,
    safeDerivedFake,
    // Builds the SAME model + masked string the preview and all four actions
    // share, then clears the global so tests can assert on it in isolation.
    buildDocPreview: async (text) => {
      const findings = await scanText(text);
      await buildReviewModel(findEditor(), text, findings, { docPolicy: true });
      const masked = computeMasked();
      const items = review ? review.items : [];
      review = null;
      return { masked, items };
    },
    previewEl: () => filePreviewEl,
    getLastMaskedText: () => state.lastMaskedText,
    isReleasing: () => releasingFiles,
    cardEl: () => fileCardEl,
  };

  async function boot() {
    // Load persisted state immediately so enabled/masking/auto-restore are
    // correct as early as possible. These need no DOM, so don't wait for it.
    // Each step is independently fault-isolated (loadSettings/masker.load/
    // loadActivity all catch their own errors and fall back to safe
    // defaults) but this catch is a second line of defense: startObserving()
    // — which wires up the response observer that drives auto-restore — must
    // run regardless of what happens above it. Before this, an unhandled
    // rejection from any one step (e.g. "Extension context invalidated"
    // after a reload) would silently skip everything after it, leaving the
    // extension looking loaded but never actually monitoring the page.
    try {
      await loadSettings();
      await masker.load();
      await loadActivity();
    } catch (err) {
      console.warn("[GuardAI] boot step failed, continuing with defaults:", err);
    }
    // Warm up the optional NLP layer in the background (no-op if disabled).
    nlp.init().catch(() => {});

    // Ask the worker to re-read the company policy. Fire and forget: this page
    // is already usable with whatever was last stored, and the answer arrives
    // through storage.onChanged like every other setting. What it buys is the
    // guarantee that matters — however long the worker has been asleep, you
    // cannot begin composing a message under a policy older than this page
    // load. The worker throttles it, so a tab storm costs one request.
    try { chrome.runtime.sendMessage({ type: "GUARDAI_POLICY_SYNC" }); } catch (_) {}

    startObserving();
    updateLockedNotice();
    console.info(`[GuardAI] active on ${CONFIG.name}. All processing is local. [build: 2026-07-09-upgrade-s1-s5]`);
  }

  // Initialise immediately on injection — never gated behind DOMContentLoaded or
  // any user interaction, so the extension is always active from page load.
  boot();
})();
