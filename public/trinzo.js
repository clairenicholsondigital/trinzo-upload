/* Trinzo shared UI enhancements · /static/trinzo.js
   Progressive enhancement only — pages work without it.
   1. Prepend a clickable Trinzo brand logo to the primary nav.
   2. Highlight the current page in the nav (aria-current).
   3. Open the calendar when a date field is clicked anywhere, not just on the icon. */
(function () {
  var primaryHomeUrl = '/meeting-minutes-agent';
  var aiTeamProjectUrl = '/project-update-test?stage=process&projectId=19';
  var primaryNavItems = [
    { href: primaryHomeUrl, label: 'Meeting Minutes Agent' },
    { href: '/jobs', label: 'Library' },
    { href: '/insights', label: 'Insights' },
    { href: aiTeamProjectUrl, label: 'AI team project' }
  ];

  function normalisedPath(value) {
    return (String(value || '').split('?')[0].replace(/\/+$/, '') || '/');
  }

  function addBrand(nav, href) {
    var brand = document.createElement('a');
    brand.className = 'brand';
    brand.href = href || '/dashboard';
    brand.setAttribute('aria-label', 'Trinzo home');
    var img = document.createElement('img');
    img.src = '/static/trinzo-logo-dark.svg';
    img.alt = 'Trinzo';
    brand.appendChild(img);
    nav.insertBefore(brand, nav.firstChild);
    return brand;
  }

  function reducePrimaryNavigation(nav) {
    nav.innerHTML = '';
    addBrand(nav, primaryHomeUrl);
    primaryNavItems.forEach(function (item) {
      var link = document.createElement('a');
      link.href = item.href;
      link.textContent = item.label;
      nav.appendChild(link);
    });
  }

  function highlightCurrentPage(nav) {
    var here = normalisedPath(location.pathname || '/');
    var links = nav.querySelectorAll('a[href]');
    var best = null, bestLen = -1;
    links.forEach(function (a) {
      if (a.classList.contains('brand')) return;
      var href = normalisedPath(a.getAttribute('href'));
      if (here === href || (href !== '/' && here.indexOf(href) === 0)) {
        if (href.length > bestLen) { best = a; bestLen = href.length; }
      }
    });
    if (best) best.setAttribute('aria-current', 'page');
  }

  async function enhance() {
    markAllDates();
    var nav = document.querySelector('nav.nav');
    if (nav) {
      reducePrimaryNavigation(nav);
      highlightCurrentPage(nav);
    }
  }

  document.addEventListener('click', function (event) {
    var input = event.target;
    if (!input || input.tagName !== 'INPUT' || input.type !== 'date') return;
    if (input.disabled || input.readOnly || typeof input.showPicker !== 'function') return;
    try { input.showPicker(); } catch (error) { /* not allowed here; native behaviour still works */ }
  });

  // Grey out the dd/mm/yyyy placeholder of an empty date field.
  function markEmptyDate(input) { input.classList.toggle('is-empty', !input.value); }
  ['input', 'change'].forEach(function (name) {
    document.addEventListener(name, function (event) {
      if (event.target && event.target.type === 'date') markEmptyDate(event.target);
    });
  });
  function markAllDates() { document.querySelectorAll('input[type=date]').forEach(markEmptyDate); }
  if (window.MutationObserver) {
    var pending = false;
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; markAllDates(); });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enhance);
  } else {
    enhance();
  }
})();
