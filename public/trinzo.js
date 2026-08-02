/* Trinzo shared UI enhancements · /static/trinzo.js
   Progressive enhancement only — pages work without it.
   1. Prepend a clickable Trinzo brand logo to the primary nav.
   2. Highlight the current page in the nav (aria-current). */
(function () {
  var pilotProjectName = 'Trinzo Project Update Tool \u2014 Internal Pilot';
  var pilotProfileUrl = '/project-update-test?stage=insights&projectName=' + encodeURIComponent(pilotProjectName);

  function addProjectManagementMenu(nav) {
    if (nav.querySelector('.nav-menu-project-management')) return;

    var projectLink = Array.prototype.find.call(nav.querySelectorAll('a[href]'), function (link) {
      var href = (link.getAttribute('href') || '').split('?')[0].replace(/\/+$/, '');
      return href === '/project-update-test';
    });
    if (!projectLink) return;

    var details = document.createElement('details');
    details.className = 'nav-menu nav-menu-project-management';
    var summary = document.createElement('summary');
    summary.textContent = 'Project Updates';
    details.appendChild(summary);

    var menu = document.createElement('div');
    menu.className = 'nav-menu-items';
    [
      { href: '/project-update-test?choose=project', label: 'Choose project' },
      { href: pilotProfileUrl, label: 'Continue latest project' }
    ].forEach(function (item) {
      var link = document.createElement('a');
      link.href = item.href;
      link.textContent = item.label;
      menu.appendChild(link);
    });
    details.appendChild(menu);

    projectLink.parentNode.insertBefore(details, projectLink);
    projectLink.remove();
  }

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

      addProjectManagementMenu(nav);

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
      if (here.indexOf('/project-update-test') === 0) {
        var projectMenu = nav.querySelector('.nav-menu-project-management');
        if (projectMenu) projectMenu.setAttribute('aria-current', 'page');
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enhance);
  } else {
    enhance();
  }
})();
