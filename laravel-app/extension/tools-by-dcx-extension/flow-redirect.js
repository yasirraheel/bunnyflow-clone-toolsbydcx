(function () {
  'use strict';

  // Open Google Flow home. The content script hides existing project cards
  // locally while keeping the native New Project control available.
  const TARGET = 'https://flow.google.com/';

  if (location.origin === 'https://flow.google.com' && location.pathname !== '/') {
    location.replace(TARGET);
  }
})();
