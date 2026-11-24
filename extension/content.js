/* global chrome */
(() => {
  "use strict";
  if (!globalThis.chrome?.runtime?.id) return;
  if (globalThis.__parallelReadInstalled) return;
  globalThis.__parallelReadInstalled = true;

  const OWN = "[data-parallel-read-translation]";
  // Reloading the extension invalidates the old content-script context while
  // its DOM additions may survive. Start clean so those translations cannot
  // become duplicated or impossible to restore in the new session.
  document.querySelectorAll(OWN).forEach(element => element.remove());

  // Containers whose text is never translated (their whole subtree is skipped).
  const SKIP = [
    OWN, "script", "style", "noscript", "template", "pre", "textarea", "input", "select", "option",
    "svg", "math", "canvas", "iframe", "object", "video", "audio", "nav",
    '[role="navigation"]', '[role="menu"]', '[role="menubar"]', '[role="toolbar"]', '[role="textbox"]',
    '[role="combobox"]', '[role="listbox"]', '[contenteditable]:not([contenteditable="false"])', "[inert]",
    "[data-parallel-read-ignore]"
  ].join(",");
  // Inline elements whose text is left out WITHOUT cutting the sentence apart.
  const DROP = ["button", '[role="button"]', '[aria-hidden="true"]', "[hidden]", "rt", "rp"].join(",");
  // Inline code and names marked "do not translate": kept verbatim via placeholders.
  const LITERAL = ["code", "kbd", "samp", "var", "tt", '[translate="no"]', ".notranslate"].join(",");
  // Rendered formulas (MathML, KaTeX, MathJax 2–4, Wikipedia) are read as one unit.
  const MATH = ["math", "mjx-container", ".katex", ".MathJax", ".MathJax_CHTML", ".MathJax_SVG", ".MathJax_PHTML", ".MathJax_MathML", ".mwe-math-element"].join(",");
  // Phrasing elements stay part of the sentence even when floated, positioned or display:contents.
  const PHRASING = new Set(["A", "ABBR", "B", "BDI", "BDO", "CITE", "CODE", "DATA", "DEL", "DFN", "EM", "FONT", "I", "INS", "KBD", "LABEL", "MARK", "Q", "S", "SAMP", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TIME", "TT", "U", "VAR"]);
  const INLINE = new Set(["inline", "inline-block", "inline-flex", "inline-grid", "ruby", "ruby-base", "ruby-text"]);
  // Short labels (one word) are translated only in these blocks.
  const LABEL_BLOCKS = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "TH", "DT", "CAPTION", "FIGCAPTION", "SUMMARY", "LEGEND"]);
  const PLACEHOLDER = /\[\[\s*\d{1,2}\s*\]\]/;
  const MAX_LITERALS = 40;
  const SPLIT_AT = 2000;
  let session = null;
  let starting = null;
  let generation = 0;

  function status() {
    if (!session?.active) return { active: false, total: 0, translated: 0, failed: 0, pending: 0, running: false, error: "" };
    const all = [...session.records.values()];
    const translated = all.filter(record => record.state === "done").length;
    const failed = all.filter(record => record.state === "error").length;
    return {
      active: true, total: all.length, translated, failed,
      pending: all.length - translated - failed,
      running: session.busy > 0 || session.queue.length > 0,
      error: session.error, engineLabel: session.engineLabel
    };
  }

  // --- Paragraph extraction --------------------------------------------------

  function englishEnough(prose, plain, block) {
    const latin = (prose.match(/[A-Za-z]/g) || []).length;
    const letters = (prose.match(/\p{L}/gu) || []).length;
    if (latin < 3 || latin / Math.max(letters, 1) <= .65 || !/[A-Za-z]{2}/.test(prose)) return false;
    // Single tokens (menu labels, URLs, tags) are skipped unless the block is a heading or label.
    return plain.split(/\s+/).filter(Boolean).length >= 2 || LABEL_BLOCKS.has(block.tagName);
  }

  function nonEnglishLanguage(block) {
    const marked = block.closest("[lang]");
    if (!marked || marked === document.documentElement) return false;
    const lang = marked.getAttribute("lang") || "";
    return Boolean(lang) && !/^en(-|$)/i.test(lang);
  }

  // --- Formulas -------------------------------------------------------------
  // Math libraries draw "90" with CSS glyphs, SVG paths or aria-hidden boxes, so
  // the visible text is empty or garbled (x² reads as "x2"). Each formula is read
  // from its MathML, or its TeX source, and turned into short linear text.
  const SUPERSCRIPT = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", "+": "⁺", "-": "⁻", "−": "⁻" };
  const ACCENTS = { "¯": "̄", "ˉ": "̄", "‾": "̅", "^": "̂", "ˆ": "̂", "~": "̃", "˜": "̃", "→": "⃗", "˙": "̇", "¨": "̈" };
  const RELATION = /^[=<>≤≥≠≈≡∼≃≅∝∈∉⊂⊆⊃⊇→←↔⇒⇐⇔↦]$/;
  const BINARY = /^[+\-−±∓×÷·⋅∗∘∪∩]$/;
  const LARGE = /^[∑∏∐∫∬∭∮⋃⋂⋁⋀]/;
  const SCRIPTED = new Set(["msub", "msup", "msubsup", "munder", "mover", "munderover", "mmultiscripts"]);
  const TEX_SYMBOLS = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", kappa: "κ",
    lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ",
    omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
    times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓", le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈",
    sim: "∼", equiv: "≡", propto: "∝", infty: "∞", partial: "∂", in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", cup: "∪",
    cap: "∩", to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", iff: "⇔", ldots: "…", cdots: "⋯", dots: "…", circ: "∘",
    sum: " ∑", prod: " ∏", int: " ∫", lim: " lim", log: " log", ln: " ln", sin: " sin", cos: " cos", tan: " tan", exp: " exp"
  };
  const TEX_ACCENTS = { bar: "¯", overline: "‾", hat: "^", widehat: "^", tilde: "~", widetilde: "~", vec: "→", dot: "˙", ddot: "¨" };

  const grouped = text => /^[\p{L}\p{N}\p{M}.√_⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]*$/u.test(text) || /^\([^()]*\)$/.test(text) ? text : "(" + text + ")";
  const superscript = text => [...text].every(ch => SUPERSCRIPT[ch]) ? [...text].map(ch => SUPERSCRIPT[ch]).join("") : "^" + grouped(text);
  const accented = (base, mark) => [...base].map(ch => /[\p{L}\p{N}]/u.test(ch) ? ch + ACCENTS[mark] : ch).join("");
  const tidyMath = text => text.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();

  function linearMath(node, depth = 0) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
    if (node.nodeType !== Node.ELEMENT_NODE || depth > 60) return "";
    const kids = [...node.children];
    const part = index => kids[index] ? tidyMath(linearMath(kids[index], depth + 1)) : "";
    switch (node.localName) {
      case "annotation": case "annotation-xml": case "mphantom": case "none": case "mprescripts": return "";
      case "semantics": return part(0);
      case "mi": case "mn": case "mtext": case "ms": return node.textContent;
      case "mspace": return " ";
      case "mo": {
        const op = node.textContent.trim();
        if (op === "⁡") return " "; // function application, as in "sin x"
        if (/^[⁢-⁤]$/.test(op)) return "";
        if (RELATION.test(op) || (BINARY.test(op) && node.previousElementSibling)) return " " + op + " ";
        return op === "," ? ", " : op;
      }
      case "mfrac": return grouped(part(0)) + "/" + grouped(part(1));
      case "msqrt": return "√" + grouped(tidyMath(mathRow(kids, depth)));
      case "mroot": return superscript(part(1)) + "√" + grouped(part(0));
      case "msup": return part(0) + superscript(part(1));
      case "msub": case "munder": return part(0) + "_" + grouped(part(1));
      case "msubsup": case "munderover": return part(0) + "_" + grouped(part(1)) + superscript(part(2));
      case "mover": return ACCENTS[part(1)] ? accented(part(0), part(1)) : part(0) + superscript(part(1));
      case "mtable": return kids.map((child, index) => part(index)).join("; ");
      case "mtr": case "mlabeledtr": return kids.map((child, index) => part(index)).join(", ");
      default: return mathRow(kids, depth);
    }
  }

  function mathRow(kids, depth) {
    let text = "", previous = null;
    for (const kid of kids) {
      const piece = linearMath(kid, depth + 1);
      // "∑_(i = 1)^n x_i", not "∑_(i = 1)^nx_i".
      const glued = previous && SCRIPTED.has(previous.localName) && /[_^]\S*$/.test(text) && /^[\p{L}\p{N}]/u.test(piece);
      if (text && !/\s$/.test(text) && (glued || LARGE.test(piece))) text += " ";
      text += piece;
      previous = kid;
    }
    return text;
  }

  // Short TeX to text, for renderers that keep no MathML (MathJax 4).
  function texToText(tex) {
    let text = String(tex || "").slice(0, 2000)
      .replace(/\\(?:displaystyle|textstyle|scriptstyle|left|right|[bB]igg?[lr]?|limits|nolimits)(?![a-zA-Z])/g, "")
      .replace(/\\(?:quad|qquad|[,;:!> ])/g, " ")
      .replace(/\{,\}/g, ",").replace(/\\\{/g, "").replace(/\\\}/g, "").replace(/\\([%$&#_])/g, "$1")
      .replace(/\\([a-zA-Z]+)(?![a-zA-Z])/g, (match, name) => TEX_SYMBOLS[name] ?? match);
    const inner = /\{([^{}]*)\}/.source;
    for (let pass = 0; pass < 12; pass += 1) {
      const before = text;
      text = text
        .replace(new RegExp(String.raw`\\(?:text|textrm|textbf|textit|mathrm|mathbf|mathit|mathsf|mathtt|mathbb|mathcal|operatorname|mbox)\s*` + inner, "g"), "$1")
        .replace(new RegExp(String.raw`\\[dtc]?frac\s*` + inner + String.raw`\s*` + inner, "g"), (m, a, b) => grouped(tidyMath(a)) + "/" + grouped(tidyMath(b)))
        .replace(new RegExp(String.raw`\\sqrt\s*(?:\[([^\]]*)\])?\s*` + inner, "g"), (m, n, a) => (n ? superscript(n.trim()) : "") + "√" + grouped(tidyMath(a)))
        .replace(new RegExp(String.raw`\\(bar|overline|hat|widehat|tilde|widetilde|vec|dot|ddot)\s*` + inner, "g"), (m, name, a) => accented(tidyMath(a), TEX_ACCENTS[name]))
        .replace(new RegExp(String.raw`\^\s*` + inner, "g"), (m, a) => superscript(tidyMath(a)))
        .replace(new RegExp(String.raw`_\s*` + inner, "g"), (m, a) => "_" + grouped(tidyMath(a)))
        // Plain groups only: arguments of a command, ^ or _ are left for the rules above.
        .replace(new RegExp(String.raw`(?<!(?:\\[a-zA-Z]+|[\^_}\]])\s*)` + inner, "g"), "$1");
      if (text === before) break;
    }
    text = text.replace(/[{}]/g, "")
      .replace(/\\(bar|overline|hat|tilde|vec|dot|ddot)\s*([\p{L}\p{N}])/gu, (m, name, a) => accented(a, TEX_ACCENTS[name]))
      .replace(/\\([a-zA-Z]+)/g, "$1")
      .replace(/\^\s*([^\s{}(])/g, (m, a) => superscript(a))
      .replace(/-/g, "−")
      .replace(/\s*([=<>≤≥≠≈≡∼∝∈∉⊂⊆→←⇒⇔])\s*/g, " $1 ")
      .replace(/([^\s(\[^_=<>≤≥≠≈+−±∓×÷·,])\s*([+−±∓×÷·])\s*/g, "$1 $2 ")
      .replace(//g, "{").replace(//g, "}");
    return tidyMath(text);
  }

  function readMath(root) {
    let math = root.matches("math") ? root : root.querySelector("math");
    if (!math && root.dataset.mathml) { // MathJax 2 without its assistive copy
      const parsed = new DOMParser().parseFromString(root.dataset.mathml, "application/xml").documentElement;
      if (parsed?.localName === "math") math = parsed;
    }
    let text = math ? tidyMath(linearMath(math)) : "";
    if (!text) {
      const frame = root.id?.endsWith("-Frame") && document.getElementById(root.id.slice(0, -6));
      const tex = root.getAttribute("data-latex") || root.querySelector("[data-latex]")?.getAttribute("data-latex")
        || (frame?.matches('script[type^="math/tex"]') ? frame.textContent : "");
      text = texToText(tex);
    }
    return text || tidyMath(root.textContent);
  }

  function createReader() {
    const styles = new Map();
    const style = element => {
      let value = styles.get(element);
      if (!value) { value = getComputedStyle(element); styles.set(element, value); }
      return value;
    };
    function visuallyHidden(element, computed) {
      if (computed.position !== "absolute" && computed.position !== "fixed") return false;
      const rect = element.getBoundingClientRect();
      return rect.width <= 1 || rect.height <= 1 || computed.clipPath === "inset(50%)" || /^rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)$/.test(computed.clip);
    }
    function boxVisible(element) {
      const computed = style(element);
      return computed.display !== "none" && computed.visibility !== "hidden" && computed.visibility !== "collapse" && element.getClientRects().length > 0;
    }
    // Finds the paragraph-like block of a text node, and whether the text is
    // ordinary prose, a literal (code) or left out.
    function classify(node) {
      let element = node.parentElement;
      let literal = null;
      let drop = false;
      while (element && element !== document.body) {
        const computed = style(element);
        const phrasing = PHRASING.has(element.tagName);
        const inline = INLINE.has(computed.display) || (phrasing && (computed.display === "contents" || computed.display === "none"
          || computed.float !== "none" || computed.position === "absolute" || computed.position === "fixed"));
        if (!inline) break;
        if (computed.display === "none" || computed.opacity === "0" || element.matches(DROP) || visuallyHidden(element, computed)) drop = true;
        if (element.matches(LITERAL)) literal = element;
        element = element.parentElement;
      }
      const block = element || document.body;
      if (block !== document.body && (block.matches(LITERAL) || block.matches(DROP))) return null;
      return { block, literal, drop: drop || style(node.parentElement).visibility === "hidden" };
    }
    return { classify, boxVisible, style };
  }

  function finishGroup(group) {
    const literals = [];
    let plain = "", source = "", prose = "";
    for (const part of group.parts) {
      if (part.type === "break") { plain += "\n"; source += "\n"; continue; }
      const value = part.value.replace(/\s+/g, " ");
      plain += value;
      if (part.type === "literal" && value.trim()) {
        const leading = value.match(/^ */)[0], trailing = value.match(/ *$/)[0];
        source += leading + "[[" + literals.length + "]]" + trailing;
        literals.push(value.trim());
      } else {
        source += value;
        prose += value;
      }
    }
    const tidy = text => text.replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").replace(/ {2,}/g, " ").trim();
    plain = tidy(plain);
    source = tidy(source);
    // Placeholders are only used when they cannot be confused with page text
    // and the service will accept them (at most 40, each up to 400 characters).
    const useLiterals = literals.length && literals.length <= MAX_LITERALS && literals.every(item => item.length <= 400) && !PLACEHOLDER.test(plain);
    return { ...group, text: plain, source: useLiterals ? source : plain, literals: useLiterals ? literals : [], prose };
  }

  function collect() {
    const reader = createReader();
    const groups = [];
    let group = null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.nodeType !== Node.ELEMENT_NODE) return NodeFilter.FILTER_ACCEPT;
        if (node.matches(MATH)) return NodeFilter.FILTER_ACCEPT;
        if (node.matches(SKIP)) return NodeFilter.FILTER_REJECT;
        return node.tagName === "BR" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.ELEMENT_NODE && node.matches(MATH)) {
        // One formula is one unit: skip everything inside it.
        let last = node;
        while (last.lastChild) last = last.lastChild;
        walker.currentNode = last;
        const info = reader.classify(node);
        if (!info || info.drop || !reader.boxVisible(node)) continue;
        const value = readMath(node);
        if (!value) continue;
        // A displayed formula inside a paragraph stays part of that sentence.
        const block = group && group.block !== info.block && group.block.contains(node) ? group.block : info.block;
        if (!group || group.block !== block) {
          group = { key: node, block, nodes: [], parts: [] };
          groups.push(group);
        }
        group.nodes.push(node);
        const lastPart = group.parts[group.parts.length - 1];
        // Numbers ("90", "1.5", "50%") and single-letter variables ("n") stay in the
        // sentence: Google places them correctly, but misplaces a placeholder such
        // as "[[0]] trees". Anything longer is kept verbatim with a placeholder,
        // because as plain text Google rewrites "x²" to "x2" and drops "n =".
        if ((!/\p{L}/u.test(value) && value.length <= 40) || /^\p{L}$/u.test(value)) {
          if (lastPart?.type === "text") lastPart.value += value;
          else group.parts.push({ type: "text", value });
        } else {
          group.parts.push({ type: "literal", root: node, value });
        }
        continue;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (group && group.block.contains(node)) group.parts.push({ type: "break" });
        continue;
      }
      const info = node.parentElement ? reader.classify(node) : null;
      if (!info) continue;
      const { block } = info;
      if (!group || group.block !== block) {
        if (!node.nodeValue.trim() || info.drop) continue;
        group = { key: node, block, nodes: [], parts: [] };
        groups.push(group);
      }
      if (info.drop) continue;
      group.nodes.push(node);
      const last = group.parts[group.parts.length - 1];
      if (info.literal) {
        if (last?.type === "literal" && last.root === info.literal) last.value += node.nodeValue;
        else group.parts.push({ type: "literal", root: info.literal, value: node.nodeValue });
      } else if (last?.type === "text") last.value += node.nodeValue;
      else group.parts.push({ type: "text", value: node.nodeValue });
    }
    let section = "";
    const result = [];
    for (const raw of groups) {
      const item = finishGroup(raw);
      const display = reader.style(item.block).display;
      if (/^(flex|grid)$/.test(display)) continue; // bare text in a flex/grid box is an anonymous item
      if (!item.text || !englishEnough(item.prose, item.text, item.block) || nonEnglishLanguage(item.block) || !reader.boxVisible(item.block)) continue;
      if (/^H[1-3]$/.test(item.block.tagName)) section = item.text;
      item.section = section;
      delete item.parts;
      result.push(item);
    }
    return result;
  }

  // Splits only very long paragraphs, at sentence or word boundaries, and
  // renumbers placeholders so that each piece is self-contained.
  function chunkSegments(record) {
    const pieces = [];
    let rest = record.source;
    while (rest.length > SPLIT_AT) {
      let boundary = Math.max(rest.lastIndexOf(". ", SPLIT_AT), rest.lastIndexOf("! ", SPLIT_AT), rest.lastIndexOf("? ", SPLIT_AT), rest.lastIndexOf("\n", SPLIT_AT));
      if (boundary > SPLIT_AT / 2) boundary += 1;
      else boundary = rest.lastIndexOf(" ", SPLIT_AT);
      if (boundary < SPLIT_AT / 3) boundary = SPLIT_AT;
      if (/[\uD800-\uDBFF]/.test(rest[boundary - 1])) boundary -= 1;
      pieces.push(rest.slice(0, boundary).trim());
      rest = rest.slice(boundary).trim();
    }
    if (rest) pieces.push(rest);
    return pieces.map(piece => {
      const literals = [];
      const text = piece.replace(/\[\[(\d{1,2})\]\]/g, (match, digits) => {
        literals.push(record.literals[Number(digits)]);
        return "[[" + (literals.length - 1) + "]]";
      });
      return { text, literals };
    });
  }

  // --- Display --------------------------------------------------------------

  function valid(s, record) {
    return s.active && session === s && s.records.get(record.key) === record && record.key.isConnected;
  }

  function mount(record, text, state, title = "") {
    if (!record.element?.isConnected) {
      let anchor = record.nodes[record.nodes.length - 1];
      if (!anchor?.isConnected) return;
      while (anchor.parentNode && anchor.parentNode !== record.block) anchor = anchor.parentNode;
      if (anchor.parentNode !== record.block) return;
      const element = document.createElement("span");
      element.setAttribute("data-parallel-read-translation", "");
      element.setAttribute("translate", "no");
      element.lang = "zh-Hant-TW";
      element.dir = "ltr";
      record.element = element;
      anchor.after(element);
    }
    record.element.dataset.state = state;
    // Service output is untrusted text. Never interpret it as HTML.
    record.element.textContent = text;
    if (title) record.element.title = title; else record.element.removeAttribute("title");
  }

  function nearViewport(record) {
    if (!record.block.isConnected) return false;
    const rect = record.block.getBoundingClientRect();
    return rect.bottom >= -250 && rect.top <= innerHeight + 650 && (rect.width > 0 || rect.height > 0);
  }

  function queueVisible(s) {
    if (!s.active || s.paused) return;
    for (const record of s.records.values()) {
      if (record.state === "waiting" && nearViewport(record)) {
        record.state = "queued";
        s.queue.push(record);
      }
    }
    pump(s);
  }

  function pause(s, message) {
    s.error = message;
    s.paused = true;
    for (const queued of s.queue) if (queued.state === "queued") queued.state = "waiting";
    s.queue = [];
  }

  async function translateBatch(s, batch) {
    const segments = [];
    const owners = [];
    for (const record of batch) {
      record.state = "loading";
      mount(record, "翻譯中…", "loading");
      for (const segment of record.chunks || chunkSegments(record)) { segments.push(segment); owners.push(record); }
    }
    const ordered = s.ordered;
    const previous = ordered[batch[0].order - 1];
    const next = ordered[batch[batch.length - 1].order + 1];
    const context = {
      title: (document.title || "").slice(0, 160),
      section: batch[0].section || "",
      previous: previous ? { source: previous.text.slice(-600), translation: (previous.translation || "").slice(-600) } : undefined,
      next: next ? next.text.slice(0, 400) : ""
    };
    let reply;
    try {
      reply = await chrome.runtime.sendMessage({ type: "PR_TRANSLATE", revision: s.revision, segments, context });
    } catch {
      reply = { ok: false, code: "EXTENSION_UNAVAILABLE", error: "擴充功能已更新或停用，請重新整理網頁後再試。" };
    }
    // Stopped, restored or restarted meanwhile: a late reply must not insert anything.
    if (!s.active || session !== s) return;
    if (!reply?.ok || !Array.isArray(reply.results) || reply.results.length !== segments.length) {
      const message = reply?.error || "翻譯失敗，請稍後再試。";
      for (const record of batch) {
        if (!valid(s, record)) continue;
        record.state = "error";
        mount(record, "此段翻譯暫時無法使用", "error", message);
      }
      // Pause instead of sending the rest of the page to a failing or limited service.
      pause(s, message);
      return;
    }
    for (const record of batch) {
      if (!valid(s, record)) continue;
      const results = reply.results.filter((result, index) => owners[index] === record);
      const problem = results.find(result => !result?.ok || typeof result.text !== "string");
      if (problem) {
        record.state = "error";
        mount(record, "此段翻譯暫時無法使用", "error", problem?.error || "翻譯失敗，請稍後再試。");
        continue;
      }
      record.translation = results.map(result => result.text).join("");
      record.state = "done";
      mount(record, record.translation, "done");
    }
  }

  function pump(s) {
    if (!s.active || s.paused || s.busy > 0 || !s.queue.length) return;
    s.queue = s.queue.filter(record => valid(s, record) && record.state === "queued");
    s.queue.sort((a, b) => a.order - b.order);
    const batch = [];
    let segments = 0, characters = 0;
    while (s.queue.length) {
      const record = s.queue[0];
      record.chunks ||= chunkSegments(record);
      const pieces = record.chunks.length;
      if (pieces > 12) {
        s.queue.shift();
        record.state = "error";
        mount(record, "此段翻譯暫時無法使用", "error", "這個段落太長（超過約 24,000 字元），沒有送出翻譯。");
        continue;
      }
      if (batch.length && (segments + pieces > s.limits.maxSegments || characters + record.source.length > s.limits.maxChars)) break;
      batch.push(s.queue.shift());
      segments += pieces;
      characters += record.source.length;
    }
    if (!batch.length) return;
    s.busy += 1;
    translateBatch(s, batch).catch(() => {
      if (s.active && session === s) pause(s, "翻譯時發生錯誤，請重新整理網頁後再試。");
    }).finally(() => {
      s.busy -= 1;
      for (const record of batch) {
        if (valid(s, record) && record.state === "loading") { record.state = "waiting"; record.element?.remove(); record.element = null; }
      }
      if (s.active) { pump(s); if (!s.queue.length) queueVisible(s); }
    });
  }

  function scan(s) {
    if (!s.active || !document.body) return;
    const seen = new Set();
    const groups = collect();
    const ordered = [];
    for (const group of groups) {
      seen.add(group.key);
      let record = s.records.get(group.key);
      if (record && record.text === group.text && record.block === group.block) {
        record.nodes = group.nodes;
        record.section = group.section;
      } else {
        record?.element?.remove();
        record = { ...group, state: "waiting", element: null, translation: "" };
        s.records.set(group.key, record);
      }
      record.order = ordered.length;
      ordered.push(record);
    }
    for (const [key, record] of s.records) {
      if (!seen.has(key)) { record.element?.remove(); s.records.delete(key); }
    }
    s.ordered = ordered;
    s.queue = s.queue.filter(record => s.records.get(record.key) === record);
    s.intersection.disconnect();
    for (const block of new Set(ordered.map(record => record.block))) s.intersection.observe(block);
    queueVisible(s);
  }

  function stop() {
    generation += 1;
    starting = null;
    if (!session) return status();
    const s = session;
    s.active = false;
    s.mutation.disconnect();
    s.intersection.disconnect();
    clearTimeout(s.scanTimer);
    clearTimeout(s.scrollTimer);
    removeEventListener("scroll", s.onScroll, true);
    removeEventListener("resize", s.onScroll);
    for (const record of s.records.values()) record.element?.remove();
    document.querySelectorAll(OWN).forEach(element => element.remove());
    s.records.clear();
    s.queue = [];
    session = null;
    return status();
  }

  function begin(config) {
    const s = {
      active: true, records: new Map(), ordered: [], queue: [], busy: 0, error: "", paused: false,
      revision: config.revision || "", engineLabel: config.engineLabel || "",
      limits: {
        maxSegments: Math.max(1, Math.min(Number(config.batch?.maxSegments) || 8, 12)),
        maxChars: Math.max(500, Math.min(Number(config.batch?.maxChars) || 4000, 6000))
      }
    };
    session = s;
    s.intersection = new IntersectionObserver(() => queueVisible(s), { rootMargin: "650px 0px 250px 0px" });
    s.mutation = new MutationObserver(mutations => {
      const changed = mutations.some(mutation => {
        const target = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
        if (target?.closest(OWN)) return false;
        if (mutation.type !== "childList") return true;
        return [...mutation.addedNodes, ...mutation.removedNodes].some(node => !(node.nodeType === Node.ELEMENT_NODE && node.matches(OWN)));
      });
      if (!changed) return;
      clearTimeout(s.scanTimer);
      s.scanTimer = setTimeout(() => scan(s), 220);
    });
    s.onScroll = () => {
      clearTimeout(s.scrollTimer);
      s.scrollTimer = setTimeout(() => queueVisible(s), 80);
    };
    s.mutation.observe(document.body, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden", "contenteditable", "translate", "lang"]
    });
    addEventListener("scroll", s.onScroll, { passive: true, capture: true });
    addEventListener("resize", s.onScroll, { passive: true });
    scan(s);
  }

  async function start() {
    const startedAt = generation;
    let config;
    try { config = await chrome.runtime.sendMessage({ type: "PR_GET_PUBLIC_CONFIG" }); }
    catch { return { ...status(), error: "擴充功能已更新或停用，請重新整理網頁後再試。" }; }
    // "Restore" was pressed while the settings were being read: do not start.
    if (startedAt !== generation) return status();
    if (!config?.ok || !config.ready) return { ...status(), error: config?.reason || config?.error || "請先完成翻譯服務設定。", needsSettings: true };
    if (session?.active) {
      if (session.revision !== (config.revision || "")) {
        // The service, model or key changed: remove old translations and start over,
        // so one page never mixes results from different settings.
        stop();
      } else {
        session.error = "";
        session.paused = false;
        for (const record of session.records.values()) {
          if (record.state === "error") { record.element?.remove(); record.element = null; record.state = "waiting"; }
        }
        scan(session);
        return status();
      }
    }
    begin(config);
    return status();
  }

  function startOnce() {
    if (!starting) starting = start().finally(() => { starting = null; });
    return starting;
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === "PR_STATUS") respond(status());
    else if (message?.type === "PR_START") { startOnce().then(respond, () => respond(status())); return true; }
    else if (message?.type === "PR_STOP") respond(stop());
    return false;
  });

  // The bundled demo uses the very same reader and background translation engine.
  if (location.protocol === "chrome-extension:" && location.pathname.endsWith("/demo.html")) {
    const translateButton = document.getElementById("demo-translate");
    const restoreButton = document.getElementById("demo-restore");
    const feedback = document.getElementById("demo-status");
    let notice = "";
    translateButton?.addEventListener("click", async () => {
      try {
        const result = await startOnce();
        notice = result?.error || "";
        if (result?.needsSettings) await chrome.runtime.openOptionsPage();
      } catch {
        notice = "請重新載入擴充功能與試讀頁後再試。";
      }
    });
    restoreButton?.addEventListener("click", () => { notice = ""; stop(); });
    setInterval(() => {
      const state = status();
      if (feedback) feedback.textContent = state.error || notice || (state.active ? `已翻譯 ${state.translated} / ${state.total} 段${state.pending ? " · 往下捲動，繼續閱讀" : ""}${state.engineLabel ? " · " + state.engineLabel : ""}` : "英文在上，繁體中文在下。");
      if (translateButton) translateButton.textContent = state.error || state.failed ? "重新嘗試" : state.active ? "繼續翻譯" : "開始雙語閱讀";
      if (restoreButton) restoreButton.disabled = !state.active;
    }, 600);
  }
})();
