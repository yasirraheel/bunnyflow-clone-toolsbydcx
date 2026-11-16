<?php
declare(strict_types=1);

// Keep the compiled SPA pixel-identical while supporting direct links on PHP's local server.
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$file = __DIR__ . $path;
if ($path !== '/' && is_file($file)) {
    return false;
}
readfile(__DIR__ . '/index.html');
