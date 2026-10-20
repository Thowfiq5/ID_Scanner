/* nav.js — tiny hash router: #home (two buttons), #eid, #labour */
(function () {
  'use strict';
  const views = ['home', 'eid', 'labour'];
  function show() {
    const name = views.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home';
    views.forEach(v => { document.getElementById('view-' + v).hidden = v !== name; });
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', show);
  show();
})();
