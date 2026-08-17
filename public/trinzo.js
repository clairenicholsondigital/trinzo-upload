/* Trinzo shared UI enhancements · /static/trinzo.js
   Progressive enhancement only — pages work without it.
   1. Prepend a clickable Trinzo brand logo to the primary nav.
   2. Highlight the current page in the nav (aria-current). */
(function () {
  var pilotProjectName = 'Trinzo Project Update Tool \u2014 Internal Pilot';
  var pilotProfileUrl = '/project-update-test?stage=insights&projectName=' + encodeURIComponent(pilotProjectName);
  var clientHomeUrl = '/staged-meeting-minutes/';
  var clientNavItems = [
    { href: clientHomeUrl, label: 'Staged minutes' },
    { href: '/jobs', label: 'Library' }
  ];

  function normalisedPath(value) {
    return (String(value || '').split('?')[0].replace(/\/+$/, '') || '/');
  }

  function currentUser() {
    return fetch('/api/auth/me', { credentials: 'same-origin' })
      .then(function (response) {
        if (!response.ok) return null;
        return response.json().catch(function () { return null; });
      })
      .then(function (payload) {
        return payload && payload.success ? payload.user : null;
      })
      .catch(function () { return null; });
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

  function reduceClientNavigation(nav) {
    nav.innerHTML = '';
    addBrand(nav, clientHomeUrl);
    clientNavItems.forEach(function (item) {
      var link = document.createElement('a');
      link.href = item.href;
      link.textContent = item.label;
      nav.appendChild(link);
    });
  }

  function addProjectManagementMenu(nav) {
    if (nav.querySelector('.nav-menu-project-management')) return;

    var projectLink = Array.prototype.find.call(nav.querySelectorAll('a[href]'), function (link) {
      var href = normalisedPath(link.getAttribute('href'));
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
    if (here.indexOf('/project-update-test') === 0) {
      var projectMenu = nav.querySelector('.nav-menu-project-management');
      if (projectMenu) projectMenu.setAttribute('aria-current', 'page');
    }
  }

  async function enhance() {
    var nav = document.querySelector('nav.nav');
    if (nav) {
      var user = await currentUser();
      if (user && user.role === 'client') {
        reduceClientNavigation(nav);
        highlightCurrentPage(nav);
        return;
      }

      // Brand logo (skip if a page already provides one)
      if (!nav.querySelector('.brand')) {
        addBrand(nav, '/dashboard');
      }

      addProjectManagementMenu(nav);
      highlightCurrentPage(nav);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enhance);
  } else {
    enhance();
  }
})();
