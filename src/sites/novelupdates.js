// NovelUpdates: not a chapter source but the release index we post to (see
// src/nu.js). Not in the adapter list, so it never claims a chapter/TOC URL
// or shows up in /supported_sites; nu jobs always run on Patchright.
//
// URL shapes:
//   /group/<slug>/                  group page; "Series (N)" row lists every series
//   /series/<slug>/                 series page: associated names, release table
//   /series-finder/?sf=1&sh=<name>  search; matches associated names too.
//                                   (Don't use /?s=: Cloudflare's WAF blocks it.)
//   /login/, /add-release/, /add-series/

export const name = 'novelupdates';
export const hosts = ['novelupdates.com'];
export const defaults = { delayMs: 3000 };
export const match = (u) => /(^|\.)novelupdates\.com$/i.test(u.hostname);
export const bookId = () => null;

export const BASE = 'https://www.novelupdates.com';
export const slugOf = (url) => {
  try { return (new URL(url, BASE).pathname.match(/^\/series\/([^/]+)\/?$/) || [])[1] || null; }
  catch { return null; }
};

// In-page half (serialized into the bundle; must be self-contained).
export function makeSite(common) {
  const { textOf } = common;
  const seriesLink = (a) => ({ title: textOf(a), url: a.href });

  return {
    // Guests get Register/Login links in the header.
    loggedIn() { return !document.querySelector('.menu_right_icons.notloggedin'); },

    // Fill the WordPress login form and submit it. The click is deferred so
    // this call returns before the page navigates away.
    submitLogin({ user, pass }) {
      const form = document.getElementById('loginform');
      if (!form) return false;
      document.getElementById('user_login').value = user;
      document.getElementById('user_pass').value = pass;
      const remember = document.getElementById('rememberme');
      if (remember) remember.checked = true;
      setTimeout(() => document.getElementById('wp-submit').click(), 50);
      return true;
    },
    loginError() { return textOf(document.querySelector('#login_error, .tml-error, .tml-errors')); },

    // Group page: the "Series (N)" row of the info table links every series.
    groupSeries() {
      for (const tr of document.querySelectorAll('table.groupinfo tr')) {
        const cells = tr.querySelectorAll('td');
        if (cells.length < 2 || !/^Series\b/.test(textOf(cells[0]))) continue;
        return [...cells[1].querySelectorAll('a[href*="/series/"]')].map(seriesLink);
      }
      return null; // not a group page (layout changed?)
    },

    groupInfo() {
      const id = document.getElementById('mypostid');
      return { name: textOf(document.querySelector('h3.mypage')), id: id ? id.value : null };
    },

    // --- /add-release/ and /add-series/ forms ------------------------------
    // The page's message area, minus the form itself (whose labels say
    // "required"): after a submit, what NU replied.
    pageText() {
      const main = document.querySelector('.w-blog-content, .l-content');
      if (!main) return '';
      const clone = main.cloneNode(true);
      clone.querySelectorAll('form, script, style').forEach((el) => el.remove());
      return textOf(clone).replace(/\s+/g, ' ').slice(0, 2000);
    },
    hasForm(field) { return !!document.querySelector(`#form1 [name="${field}"]`); },

    // The Series/Group boxes on /add-release/ are type-to-search: keyup runs
    // the page's showResult(), whose hits call changeitem(box, id, kind, el)
    // to copy the id into the hidden field. We type, list the hits with
    // their ids, then click the one the caller picked.
    startPick({ kind, text }) {
      const box = document.getElementById(kind === 'group' ? 'group_change_100' : 'title_change_100');
      if (!box) return false;
      box.value = text;
      box.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: text.slice(-1) }));
      return true;
    },
    pickResults({ kind }) {
      const list = document.querySelector(kind === 'group' ? '.livesearchgroup[class~="100"]' : '.livesearch[class~="100"]');
      if (!list || /Loading/.test(list.textContent)) return null; // not back yet
      return [...list.querySelectorAll('[onclick*="changeitem"]')].map((el, i) => ({
        i,
        text: textOf(el),
        id: ((el.getAttribute('onclick') || '').match(/changeitem\(\s*'[^']*'\s*,\s*'?(\d+)/) || [])[1] || null,
      }));
    },
    choosePick({ kind, i }) {
      const list = document.querySelector(kind === 'group' ? '.livesearchgroup[class~="100"]' : '.livesearch[class~="100"]');
      const el = list && list.querySelectorAll('[onclick*="changeitem"]')[i];
      if (!el) return null;
      el.click();
      return document.getElementById(kind === 'group' ? 'group100' : 'title100').value;
    },
    // The ids the Series and Group boxes hold now. NU's reply to a submit
    // keeps them, so a batch can post the next release on the same form.
    pickedIds() {
      return {
        series: document.getElementById('title100')?.value || null,
        group: document.getElementById('group100')?.value || null,
      };
    },
    // Drop the last submit's thank-you line (outside the form), so the next
    // reply's line is the only one.
    clearNotice() {
      const main = document.querySelector('.w-blog-content, .l-content');
      if (!main) return 0;
      const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
      let n = 0;
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        if (t.parentElement.closest('form') || !/Thank you!/i.test(t.nodeValue)) continue;
        t.nodeValue = t.nodeValue.replace(/Thank you![^.]*\./gi, '');
        n++;
      }
      return n;
    },

    // Plain fields by name: {name: value}. Selects take the option's value.
    fill(fields) {
      const missing = [];
      for (const [name, value] of Object.entries(fields)) {
        const el = document.querySelector(`#form1 [name="${name}"]`);
        if (!el) { missing.push(name); continue; }
        el.value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return missing;
    },
    // Option values for a select's labels (case-insensitive); unknown labels
    // come back in `missing`.
    optionValues({ name, labels }) {
      const sel = document.querySelector(`#form1 select[name="${name}"]`);
      const opts = sel ? [...sel.options] : [];
      const values = [], missing = [];
      for (const l of labels) {
        const o = opts.find((x) => x.textContent.trim().toLowerCase() === String(l).trim().toLowerCase());
        if (o) values.push(o.value); else missing.push(l);
      }
      return { values, missing };
    },
    // Genres are toggle links; the submit button's chkvaluesnew() gathers
    // the ones marked chkme="include".
    setGenres(names) {
      const want = new Set(names.map((n) => n.trim().toLowerCase()));
      const found = new Set();
      for (const a of document.querySelectorAll('a.genreme')) {
        const n = textOf(a).toLowerCase();
        const on = a.getAttribute('chkme') === 'include';
        if (want.has(n) !== on) a.click();
        if (want.has(n)) found.add(n);
      }
      return names.filter((n) => !found.has(n.trim().toLowerCase()));
    },
    setTags(names) {
      const sel = document.getElementById('tags_include');
      if (!sel) return names;
      const want = new Map(names.map((n) => [n.trim().toLowerCase(), n]));
      for (const o of sel.options) {
        const k = o.textContent.trim().toLowerCase();
        o.selected = want.has(k);
        want.delete(k);
      }
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return [...want.values()];
    },
    // --- Series page in-place edits (seriesedit.js) --------------------------
    // Edit runs editme(), which swaps <div id=field> for a <textarea id=field>
    // (one entry per line) and the link for Save. Save runs saveedit(): an
    // ajax post, after which the div comes back holding what NU stored.
    startEdit(field) {
      const btn = [...document.querySelectorAll('span.editme')]
        .find((s) => (s.getAttribute('onclick') || '').includes(`editme(this,'${field}')`) && textOf(s) === 'Edit');
      if (!btn) return false;
      btn.click();
      return document.getElementById(field)?.tagName === 'TEXTAREA';
    },
    setEditValue({ field, value }) {
      const ta = document.getElementById(field);
      if (!ta || ta.tagName !== 'TEXTAREA') return false;
      ta.value = value;
      return true;
    },
    saveEdit(field) {
      const btn = [...document.querySelectorAll('span.editme')]
        .find((s) => (s.getAttribute('onclick') || '').includes(`saveedit(this,'${field}')`));
      if (!btn) return false;
      btn.click();
      return true;
    },
    // null while the textarea is still up (saving); then the lines shown.
    editResult(field) {
      const el = document.getElementById(field);
      if (!el || el.tagName === 'TEXTAREA') return null;
      return (el.innerText || el.textContent || '').split('\n').map((s) => s.trim()).filter(Boolean);
    },

    // Everything /add-series/ offers to pick from: all on the page (the tag
    // box is select2 over a plain <select>, no ajax).
    vocabulary() {
      const options = (name) => {
        const sel = document.querySelector(`#form1 select[name="${name}"]`);
        return sel ? [...sel.options].filter((o) => o.value !== '0')
          .map((o) => ({ id: o.value, name: o.textContent.trim() })) : null;
      };
      return {
        genres: [...document.querySelectorAll('a.genreme')].map((a) => ({ id: a.getAttribute('genreid'), name: textOf(a) })),
        tags: options('tagsinclude[]'),
        types: options('type'),
        languages: options('language'),
      };
    },
    formValues() {
      const out = {};
      for (const el of document.querySelectorAll('#form1 [name]')) {
        if (el.type === 'file' || el.type === 'submit') continue;
        out[el.name] = el.multiple ? [...el.selectedOptions].map((o) => o.textContent.trim()) : el.value;
      }
      out.genres = [...document.querySelectorAll('a.genreme[chkme="include"]')].map(textOf);
      return out;
    },
    // Deferred so this call returns before the page navigates away.
    submitForm() {
      const btn = document.querySelector('#form1 #submit');
      if (!btn) return false;
      setTimeout(() => btn.click(), 50);
      return true;
    },

    searchResults() {
      return [...document.querySelectorAll('.search_title a[href*="/series/"]')].map(seriesLink);
    },

    seriesInfo() {
      const assoc = document.getElementById('editassociated');
      const id = document.getElementById('mypostid');
      return {
        title: textOf(document.querySelector('.seriestitlenu')),
        id: id ? id.value : null,
        // One name per line (<br>-separated).
        associatedNames: assoc
          ? (assoc.innerText || assoc.textContent || '').split('\n').map((s) => s.trim()).filter(Boolean)
          : [],
        releases: [...document.querySelectorAll('#myTable tbody tr')].map((tr) => {
          const td = tr.querySelectorAll('td');
          return {
            date: textOf(td[0]),
            group: textOf(td[1]),
            groupUrl: td[1]?.querySelector('a')?.href || null,
            release: textOf(td[2]),
          };
        }),
      };
    },
  };
}
