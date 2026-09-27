  // Download → coffee modal with a 10s countdown, then start the download
  (function () {
    const scrim = document.getElementById('dlModal');
    if (!scrim) return;
    const secsEl = document.getElementById('dlSecs');
    const osEl = document.getElementById('dlOs');
    const nowLink = document.getElementById('dlNow');
    const closeBtn = document.getElementById('dlClose');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let timer = null, url = null;

    function start(u, label) {
      url = u;
      nowLink.href = u;
      osEl.textContent = label || 'your download';
      let n = 10;
      secsEl.textContent = n;
      scrim.hidden = false;
      requestAnimationFrame(() => scrim.classList.add('show'));
      clearInterval(timer);
      timer = setInterval(() => {
        n -= 1;
        secsEl.textContent = Math.max(n, 0);
        if (n <= 0) { clearInterval(timer); go(); }
      }, 1000);
    }
    function go() { if (url) window.location.assign(url); }
    function close() {
      clearInterval(timer);
      scrim.classList.remove('show');
      setTimeout(() => { scrim.hidden = true; }, reduce ? 0 : 250);
    }

    document.querySelectorAll('#download .dl-card a.btn-primary').forEach((a) => {
      a.addEventListener('click', (e) => {
        // Let the browser handle modifier / non-left clicks (new tab, download, etc.)
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        start(a.getAttribute('href'), a.dataset.os);
      });
    });
    // "Download now" is a real anchor - just stop the timer and let it navigate.
    nowLink.addEventListener('click', () => clearInterval(timer));
    closeBtn.addEventListener('click', close);
    scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !scrim.hidden) close(); });
  })();

  // Theme toggle (light / dark) - persisted, defaults to system preference.
  // Which icon shows is handled entirely in CSS via [data-theme].
  (function () {
    const root = document.documentElement;
    const btn = document.getElementById('themeBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const next = root.dataset.theme === 'light' ? 'dark' : 'light';
      root.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch (e) {}
    });
  })();

  // Mobile menu
  const menuBtn = document.getElementById('menuBtn');
  const navLinks = document.getElementById('navLinks');
  menuBtn?.addEventListener('click', () => navLinks.classList.toggle('open'));
  navLinks?.querySelectorAll('a').forEach(a => a.addEventListener('click', () => navLinks.classList.remove('open')));

  // Copy buttons
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const el = document.getElementById(btn.dataset.copy);
      const text = el.innerText.replace(/\s*#.*$/gm, '').trim();
      try {
        await navigator.clipboard.writeText(text);
        const orig = btn.innerHTML;
        btn.classList.add('ok');
        btn.textContent = '✓ Copied';
        setTimeout(() => { btn.classList.remove('ok'); btn.innerHTML = orig; }, 1600);
      } catch (e) {}
    });
  });

  // Scroll reveal
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));

  // Old single-page anchors (#assistant, #security …) now live on their own pages.
  (function () {
    var moved = { assistant: 'ai.html', cloud: 'cloud.html', argocd: 'argocd.html', security: 'security.html', costs: 'costs.html' };
    var h = location.hash.slice(1);
    if (moved[h] && /(^|\/)(index\.html)?$/.test(location.pathname)) location.replace(moved[h]);
  })();

  // YouTube videos. Fill in each video's ID (the part after "watch?v=") and its card appears.
  // Cards without an ID are removed, and a videos section with no cards is hidden.
  // The player only loads from youtube-nocookie.com after the visitor presses play.
  (function () {
    var VIDEOS = {
      walkthrough: 'YriOfOG8GhU', // k8sight: UI for Kubernetes (full walkthrough)
      overview: 'FNgIiivOPGw',    // Meet k8sight: a native desktop UI for Kubernetes
      costs: 'IZ3Ppecs_EQ',       // The Costs view
      security: 'Rq2Q7vYSqsA'     // The Security Center
    };
    var CHANNEL = 'https://www.youtube.com/@k8sight';

    document.querySelectorAll('[data-video]').forEach(function (card) {
      var id = VIDEOS[card.dataset.video];
      if (!id) { card.remove(); return; }
      var btn = card.querySelector('.vthumb');
      btn.addEventListener('click', function () {
        var box = document.createElement('div');
        box.className = 'vframe';
        var f = document.createElement('iframe');
        f.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) + '?autoplay=1&rel=0&modestbranding=1';
        f.title = card.querySelector('figcaption b').textContent;
        f.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
        f.allowFullscreen = true;
        f.referrerPolicy = 'strict-origin-when-cross-origin';
        box.appendChild(f);
        btn.replaceWith(box);
      });
    });
    document.querySelectorAll('[data-videos]').forEach(function (sec) {
      if (!sec.querySelector('[data-video]')) sec.hidden = true;
    });
    document.querySelectorAll('[data-yt-channel]').forEach(function (a) {
      if (CHANNEL) a.href = CHANNEL; else a.parentElement.remove();
    });
  })();
