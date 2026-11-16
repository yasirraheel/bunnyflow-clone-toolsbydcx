# Tools By DCX — exact supplied-template clone

This folder serves the supplied compiled SPA and original styling/assets as-is, with the visible brand metadata changed to Tools By DCX. `router.php` provides SPA fallback so every client-side route loads directly on a PHP server.

Run:

```powershell
php -S 127.0.0.1:8081 -t . router.php
```

The original app expects its backend APIs. Captured API-response folders are not included here; connect the API base to your authorized backend before production use.
