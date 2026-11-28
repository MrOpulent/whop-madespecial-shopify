/* MadeSpecial home + collection (ms-*): finder tabs, customer videos, sticky CTA, reveal. No libraries. */
(function () {
  'use strict';
  var root = document.querySelector('.ms-page');
  if (!root) return;

  // Gift finder tabs (ARIA tabs, arrow keys)
  document.querySelectorAll('.ms [data-finder]').forEach(function (f) {
    var tabs = [].slice.call(f.querySelectorAll('[role="tab"]'));
    function pick(t, focus) {
      tabs.forEach(function (x) {
        var on = x === t;
        x.setAttribute('aria-selected', on ? 'true' : 'false');
        x.tabIndex = on ? 0 : -1;
        var p = document.getElementById(x.getAttribute('aria-controls'));
        if (p) { p.classList.toggle('on', on); p.hidden = !on; }
      });
      if (focus) t.focus();
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { pick(t); });
      t.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          var n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
          pick(n, true);
        }
      });
    });
  });

  // Customer videos: tap to play with sound, one at a time
  var current = null;
  document.querySelectorAll('.ms .vc .pb').forEach(function (b) {
    b.addEventListener('click', function () {
      var fig = b.closest('.vc');
      var v = fig.querySelector('video');
      if (!v) {
        v = document.createElement('video');
        v.src = b.getAttribute('data-src');
        v.playsInline = true; v.setAttribute('playsinline', ''); v.controls = true; v.preload = 'auto';
        fig.appendChild(v);
        v.addEventListener('ended', function () { fig.classList.remove('playing'); });
        v.addEventListener('pause', function () { if (v.ended || v.paused) fig.classList.remove('playing'); });
      }
      if (current && current !== v) { try { current.pause(); } catch (e) {} }
      current = v;
      fig.classList.add('playing');
      var p = v.play(); if (p && p.catch) p.catch(function () {});
    });
  });

  // Scroll links (data-scroll="id")
  document.querySelectorAll('.ms [data-scroll]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var t = document.getElementById(a.getAttribute('data-scroll'));
      if (!t) return;
      e.preventDefault();
      t.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // Lazy autoplay for muted loop videos (only when on screen)
  var rm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (rm) document.querySelectorAll('.ms video.kitv__v').forEach(function (v) { v.removeAttribute('autoplay'); });
  if ('IntersectionObserver' in window) {
    var vio = new IntersectionObserver(function (es) {
      es.forEach(function (en) {
        var v = en.target;
        if (en.isIntersecting) {
          if (rm && v.classList.contains('kitv__v')) return;
          if (!v.src && v.dataset.src) v.src = v.dataset.src;
          var p = v.play(); if (p && p.catch) p.catch(function () {});
        } else if (!v.paused) { v.pause(); }
      });
    }, { rootMargin: '200px 0px' });
    document.querySelectorAll('.ms video[data-auto]').forEach(function (v) { vio.observe(v); });

    // Reveal on scroll
    var rio = new IntersectionObserver(function (es) {
      es.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('in'); rio.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -8% 0px' });
    document.querySelectorAll('.ms [data-rv]').forEach(function (el) { rio.observe(el); });

    // Sticky CTA (mobile): show after the first product grid leaves the screen, hide over the final CTA / footer
    var sticky = document.querySelector('.ms .msticky');
    var anchor = document.querySelector('.ms [data-sticky-after]');
    var stop = document.querySelectorAll('.ms .final, footer.footer');
    if (sticky && anchor) {
      var past = false, blocked = 0;
      function upd() { sticky.classList.toggle('on', past && blocked === 0); sticky.setAttribute('aria-hidden', past && blocked === 0 ? 'false' : 'true'); }
      var tk = false;
      function chk() { tk = false; var r = anchor.getBoundingClientRect(); past = r.top < -320 || r.bottom < 0; upd(); }
      window.addEventListener('scroll', function () { if (!tk) { tk = true; requestAnimationFrame(chk); } }, { passive: true });
      chk();
      var sio = new IntersectionObserver(function (es) {
        es.forEach(function (en) { en.target._msIn = en.isIntersecting; });
        blocked = [].filter.call(stop, function (s) { return s._msIn; }).length; upd();
      });
      [].forEach.call(stop, function (s) { sio.observe(s); });
    }
  } else {
    document.querySelectorAll('.ms [data-rv]').forEach(function (el) { el.classList.add('in'); });
    document.querySelectorAll('.ms video[data-auto]').forEach(function (v) { if (v.dataset.src) v.src = v.dataset.src; });
  }
})();

// t161u: review carousels open with genuine customer photos. Store/product images that Judge.me shows on a review
// (files hosted in this shop's own Shopify Files, e.g. rain-drum-on-moss.png) are not customer photos, so they are
// removed and the review shows as a text card. Originals are stable-sorted photo-first and the loop clones
// are rebuilt to mirror them, so the carousel loop stays seamless.
(function () {
  var STORE_IMG = /cdn\.shopify\.com\/s\/files\/|\/cdn\/shop\/(files|products)\//;
  function genuine(c) { var i = c.querySelector('img'); return !!(i && !STORE_IMG.test(i.getAttribute('src') || '')); }
  function fix(track) {
    var items = [].filter.call(track.children, function (c) { return c.classList && c.classList.contains('jdgm-carousel-item'); });
    if (!items.length) return;
    items.forEach(function (c) {
      var i = c.querySelector('img');
      if (i && STORE_IMG.test(i.getAttribute('src') || '')) { i.remove(); c.classList.add('jdgm-text-card', 'ms-noimg'); }
    });
    var groups = { b: [], o: [], a: [] };
    items.forEach(function (c) { (c.classList.contains('jdgm-clone-before') ? groups.b : c.classList.contains('jdgm-clone-after') ? groups.a : groups.o).push(c); });
    var o = groups.o.map(function (c, n) { return { c: c, n: n, p: genuine(c) ? 0 : 1 }; });
    o.sort(function (x, y) { return x.p - y.p || x.n - y.n; });
    var orig = o.map(function (x) { return x.c; });
    var id = function (c) { return c.getAttribute('data-review-id') || ''; };
    // Loop clones must mirror the sorted originals: "before" = last k, "after" = first k
    var want = orig.slice(orig.length - groups.b.length).map(id).concat(orig.map(id), orig.slice(0, groups.a.length).map(id));
    var have = items.map(id);
    if (want.join() === have.join()) return;
    function mk(src, cls) { var k = src.cloneNode(true); k.classList.remove('active'); k.classList.add(cls); return k; }
    var bNew = orig.slice(orig.length - groups.b.length).map(function (c) { return mk(c, 'jdgm-clone-before'); });
    var aNew = orig.slice(0, groups.a.length).map(function (c) { return mk(c, 'jdgm-clone-after'); });
    var anchor = items[items.length - 1].nextSibling;
    groups.b.concat(groups.a).forEach(function (c) { c.remove(); });
    bNew.concat(orig, aNew).forEach(function (c) { track.insertBefore(c, anchor); });
  }
  var busy = false;
  function run() {
    if (busy) return; busy = true;
    var tracks = [];
    document.querySelectorAll('.jdgm-carousel-item').forEach(function (c) { if (tracks.indexOf(c.parentElement) < 0) tracks.push(c.parentElement); });
    tracks.forEach(fix);
    busy = false;
  }
  var t; var mo = new MutationObserver(function () { if (busy) return; clearTimeout(t); t = setTimeout(run, 120); });
  mo.observe(document.body, { childList: true, subtree: true });
  run();
  setTimeout(function () { mo.disconnect(); }, 20000);
})();
