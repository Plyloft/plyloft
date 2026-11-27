// In-page automated checks. Evaluated in the page (`page.evaluate(auditSrc)`),
// defines window.__audit.{run, tabWalk}. Pure DOM + computed styles.
/* eslint-disable */
(function () {
  if (window.__audit) return;
  const VW = () => window.innerWidth, VH = () => window.innerHeight;

  function cssPath(el) {
    if (!(el instanceof Element)) return "";
    const parts = [];
    let cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && depth < 5) {
      let s = cur.tagName.toLowerCase();
      if (cur.id && !/^[:\d]|radix|headlessui/.test(cur.id) && cur.id.length < 40) { parts.unshift(s + "#" + cur.id); break; }
      const cls = [...cur.classList].filter((c) => c.length < 40 && !/[:[\]/]/.test(c)).slice(0, 2);
      if (cls.length) s += "." + cls.join(".");
      const label = cur.getAttribute("aria-label");
      if (label && depth === 0) s += `[aria-label="${label.slice(0, 40)}"]`;
      parts.unshift(s);
      cur = cur.parentElement; depth++;
    }
    return parts.join(" > ");
  }
  function visible(el) {
    if (!el || !el.getClientRects().length) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > VH() || r.left > VW()) return false;
    // pointer-events:none + visibility hidden hosts (inactive workspaces)
    return true;
  }
  const textOf = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();

  // ---------------- colour
  function parseColor(s) {
    if (!s) return null;
    let m = s.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/);
    if (m) {
      let a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return [+m[1], +m[2], +m[3], a];
    }
    m = s.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\)/);
    if (m) {
      let a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return [m[1] * 255, m[2] * 255, m[3] * 255, a];
    }
    return resolveViaCanvas(s);
  }
  let ctx2d = null;
  function resolveViaCanvas(s) {
    // oklch / color-mix / lab etc: let the canvas convert to sRGB
    try {
      if (!ctx2d) { const c = document.createElement("canvas"); c.width = c.height = 1; ctx2d = c.getContext("2d", { willReadFrequently: true }); }
      ctx2d.clearRect(0, 0, 1, 1);
      ctx2d.fillStyle = "rgba(0,0,0,0)";
      ctx2d.fillStyle = s;
      ctx2d.fillRect(0, 0, 1, 1);
      const d = ctx2d.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    } catch { return null; }
  }
  const over = (fg, bg) => { const a = fg[3]; return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1]; };
  function lum(c) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const hex = (c) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

  function effectiveBackground(el) {
    // Walk up collecting backgrounds; composite top-down over the page colour.
    const layers = [];
    let uncertain = null;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const cs = getComputedStyle(cur);
      if (cs.backgroundImage && cs.backgroundImage !== "none" && !uncertain) uncertain = "background-image";
      const c = parseColor(cs.backgroundColor);
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 0.999) break; }
      cur = cur.parentElement;
    }
    let bg = [255, 255, 255, 1];
    if (!layers.length || layers[layers.length - 1][3] < 0.999) {
      const b = parseColor(getComputedStyle(document.body).backgroundColor);
      const h = parseColor(getComputedStyle(document.documentElement).backgroundColor);
      if (h && h[3] > 0) bg = over(h, bg);
      if (b && b[3] > 0) bg = over(b, bg);
    }
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    return { bg, uncertain };
  }
  function opacityChain(el) {
    let o = 1, cur = el;
    while (cur && cur.nodeType === 1) { o *= parseFloat(getComputedStyle(cur).opacity || "1"); cur = cur.parentElement; }
    return o;
  }

  function zoneOf(el) {
    if (el.closest(".xterm")) return "terminal";
    if (el.closest(".cm-editor")) return "editor";
    return "ui";
  }

  // ---------------- checks
  const GLYPH = /[×←-⇿⌀-⏿①-⓿■-◿☀-➿⋯⬀-⯿✀-➿]|[\u{1F300}-\u{1FAFF}]/u;

  function run(opts = {}) {
    const out = { contrast: [], overflow: [], edge: [], smallFonts: [], uppercase: [], glyphs: [], stats: {} };
    const root = document.documentElement;
    out.stats.horizontalScroll = root.scrollWidth > VW() + 1 || document.body.scrollWidth > VW() + 1;
    out.stats.verticalPageScroll = root.scrollHeight > VH() + 1;
    out.stats.theme = root.getAttribute("data-theme");
    out.stats.accent = root.getAttribute("data-accent");

    // text-bearing elements = parents of non-empty text nodes
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const els = new Set();
    let n;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue || !n.nodeValue.trim()) continue;
      const p = n.parentElement;
      if (!p || p.closest("script,style,noscript,[aria-hidden='true'] svg")) continue;
      els.add(p);
    }
    out.stats.textElements = els.size;
    const seenC = new Set(), seenF = new Set(), seenU = new Set();
    for (const el of els) {
      if (!visible(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden") continue;
      const zone = zoneOf(el);
      const own = [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join(" ").replace(/\s+/g, " ").trim();
      if (!own) continue;
      const size = parseFloat(cs.fontSize);
      const weight = parseInt(cs.fontWeight, 10) || 400;
      // contrast
      if (zone !== "terminal") {
        const fg0 = parseColor(cs.color);
        if (fg0) {
          const { bg, uncertain } = effectiveBackground(el);
          const op = opacityChain(el);
          const fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * op], bg);
          const r = ratio(fg, bg);
          const large = size >= 24 || (size >= 18.66 && weight >= 700);
          const need = large ? 3 : 4.5;
          if (r < need) {
            const key = cssPath(el) + "|" + own.slice(0, 40);
            if (!seenC.has(key)) {
              seenC.add(key);
              const disabled = !!el.closest("[disabled],[aria-disabled='true']");
              out.contrast.push({ selector: cssPath(el), text: own.slice(0, 80), fg: hex(fg), bg: hex(bg), ratio: +r.toFixed(2), need, fontSize: size, fontWeight: weight, zone, disabled, uncertain, placeholder: false });
            }
          }
        }
      }
      if (size < 12 && zone === "ui") {
        const key = cssPath(el) + "|" + size;
        if (!seenF.has(key)) { seenF.add(key); out.smallFonts.push({ selector: cssPath(el), text: own.slice(0, 60), fontSize: size }); }
      }
      if (cs.textTransform === "uppercase") {
        const key = cssPath(el);
        if (!seenU.has(key)) { seenU.add(key); out.uppercase.push({ selector: key, text: own.slice(0, 60) }); }
      }
    }
    // placeholders
    for (const inp of document.querySelectorAll("input[placeholder],textarea[placeholder]")) {
      if (!visible(inp) || inp.value) continue;
      const ps = getComputedStyle(inp, "::placeholder");
      const fg0 = parseColor(ps.color); if (!fg0) continue;
      const { bg } = effectiveBackground(inp);
      const fg = over(fg0, bg); const r = ratio(fg, bg);
      if (r < 4.5) out.contrast.push({ selector: cssPath(inp), text: "placeholder: " + inp.placeholder.slice(0, 60), fg: hex(fg), bg: hex(bg), ratio: +r.toFixed(2), need: 4.5, fontSize: parseFloat(getComputedStyle(inp).fontSize), zone: "ui", disabled: inp.disabled, placeholder: true });
    }

    // overflow / clipping
    const seenO = new Set();
    for (const el of document.body.querySelectorAll("*")) {
      if (el.closest(".xterm, .cm-editor, svg")) continue;
      if (!el.firstChild) continue;
      const cs = getComputedStyle(el);
      const ellipsis = cs.textOverflow === "ellipsis";
      const hidX = cs.overflowX === "hidden" || cs.overflowX === "clip";
      const hidY = cs.overflowY === "hidden" || cs.overflowY === "clip";
      const clamp = cs.webkitLineClamp && cs.webkitLineClamp !== "none";
      if (!ellipsis && !hidX && !hidY && !clamp) continue;
      if (!visible(el)) continue;
      if (el.clientWidth <= 2 || el.clientHeight <= 2 || el.classList.contains("sr-only") || el.classList.contains("visually-hidden")) continue;
      const t = textOf(el);
      if (!t) continue;
      const cutX = (ellipsis || hidX) && el.scrollWidth > el.clientWidth + 1;
      const cutY = (hidY || clamp) && el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0 && el.clientHeight < 400;
      if (!cutX && !cutY) continue;
      // only leaf-ish text containers (not big layout panes)
      if (el.querySelectorAll("*").length > 12 && !ellipsis && !clamp) continue;
      const key = cssPath(el);
      if (seenO.has(key)) continue; seenO.add(key);
      out.overflow.push({ selector: key, text: t.slice(0, 100), kind: ellipsis ? "ellipsis" : clamp ? "line-clamp" : cutX ? "clipped-x" : "clipped-y", scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, title: el.getAttribute("title") || (el.closest("[title]") ? el.closest("[title]").getAttribute("title") : null) });
      if (out.overflow.length > 150) break;
    }

    // viewport edge: interactive / text elements poking past the window and not clipped away
    const seenE = new Set();
    const cands = document.body.querySelectorAll("button, a, input, select, textarea, [role=button], [role=menuitem], [role=dialog], [role=menu], h1, h2, h3, p, label, span");
    for (const el of cands) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right <= VW() + 1 && r.left >= -1 && r.bottom <= VH() + 1) continue;
      if (r.bottom > VH() + 1 && r.right <= VW() + 1 && r.left >= -1) continue; // below the fold is scrolling, not an edge bug
      // clipped by a scroll/overflow ancestor inside the viewport?
      let clipped = false, cur = el.parentElement;
      while (cur && cur !== document.body) {
        const cs = getComputedStyle(cur);
        if (cs.overflowX !== "visible") { const cr = cur.getBoundingClientRect(); if (cr.right <= VW() + 1 && cr.left >= -1) { clipped = true; break; } }
        cur = cur.parentElement;
      }
      if (clipped) continue;
      const key = cssPath(el);
      if (seenE.has(key)) continue; seenE.add(key);
      out.edge.push({ selector: key, text: textOf(el).slice(0, 60), left: Math.round(r.left), right: Math.round(r.right), viewport: VW() });
      if (out.edge.length > 40) break;
    }

    // glyph icons in controls
    const seenG = new Set();
    for (const el of document.querySelectorAll("button, [role=button], [role=menuitem], [role=tab], a, summary")) {
      if (!visible(el)) continue;
      const t = textOf(el);
      if (!t || !GLYPH.test(t)) continue;
      const chars = [...new Set([...t].filter((ch) => GLYPH.test(ch) && !el.querySelector("kbd")?.textContent.includes(ch)))];
      if (!chars.length) continue;
      const key = cssPath(el) + chars.join("");
      if (seenG.has(key)) continue; seenG.add(key);
      out.glyphs.push({ selector: cssPath(el), text: t.slice(0, 60), chars: chars.join(" "), codepoints: chars.map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")).join(" ") });
    }
    return out;
  }

  function accName(el) {
    if (!el) return "";
    const al = el.getAttribute("aria-label"); if (al) return al;
    const lb = el.getAttribute("aria-labelledby");
    if (lb) return lb.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || "").join(" ").trim();
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return textOf(l); }
    const wrap = el.closest("label"); if (wrap && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA")) return textOf(wrap);
    const t = textOf(el); if (t) return t.slice(0, 80);
    return el.getAttribute("title") || el.getAttribute("placeholder") || "";
  }
  function focusStyle(el) {
    const cs = getComputedStyle(el);
    return { outlineStyle: cs.outlineStyle, outlineWidth: parseFloat(cs.outlineWidth) || 0, outlineColor: cs.outlineColor, boxShadow: cs.boxShadow, borderColor: cs.borderColor, background: cs.backgroundColor };
  }
  window.__audit = { run, accName, focusStyle, cssPath, visible };
})();
