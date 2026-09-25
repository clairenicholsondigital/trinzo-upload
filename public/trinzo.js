/* Trinzo shared UI enhancements · /static/trinzo.js
   Progressive enhancement only — pages work without it.
   1. Prepend a clickable Trinzo brand logo to the primary nav.
   2. Highlight the current page in the nav (aria-current). */
(function () {
  var primaryHomeUrl = '/meeting-minutes-agent';
  var primaryNavItems = [
    { href: primaryHomeUrl, label: 'Meeting Minutes Agent' },
    { href: '/jobs', label: 'Library' }
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
    var nav = document.querySelector('nav.nav');
    if (nav) {
      reducePrimaryNavigation(nav);
      highlightCurrentPage(nav);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enhance);
  } else {
    enhance();
  }
})();
