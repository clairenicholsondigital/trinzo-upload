/* Trinzo shared UI enhancements · /static/trinzo.js
   Progressive enhancement only — pages work without it.
   1. Prepend a clickable Trinzo brand logo to the primary nav.
   2. Highlight the current page in the nav (aria-current). */
(function () {
  function enhance() {
    var nav = document.querySelector('nav.nav');
    if (nav) {
      // Brand logo (skip if a page already provides one)
      if (!nav.querySelector('.brand')) {
        var brand = document.createElement('a');
        brand.className = 'brand';
        brand.href = '/dashboard';
        brand.setAttribute('aria-label', 'Trinzo home');
        var img = document.createElement('img');
        img.src = '/static/trinzo-logo-dark.svg';
        img.alt = 'Trinzo';
        brand.appendChild(img);
        nav.insertBefore(brand, nav.firstChild);
      }

      // Active-page highlight
      var here = (location.pathname || '/').replace(/\/+$/, '') || '/';
      var links = nav.querySelectorAll('a[href]');
      var best = null, bestLen = -1;
      links.forEach(function (a) {
        if (a.classList.contains('brand')) return;
        var href = (a.getAttribute('href') || '').split('?')[0].replace(/\/+$/, '') || '/';
        if (here === href || (href !== '/' && here.indexOf(href) === 0)) {
          if (href.length > bestLen) { best = a; bestLen = href.length; }
        }
      });
      if (best) best.setAttribute('aria-current', 'page');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enhance);
  } else {
    enhance();
  }
})();
