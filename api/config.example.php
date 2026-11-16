<?php
declare(strict_types=1);

return [
    'db' => [
        'dsn' => 'mysql:host=localhost;dbname=CHANGE_ME;charset=utf8mb4',
        'user' => 'CHANGE_ME',
        'password' => 'CHANGE_ME',
    ],
    'app' => [
        'base_url' => 'https://flow.toolsbydcx.com',
        'token_ttl' => 60 * 60 * 24 * 30,
        'reset_ttl' => 60 * 60,
        'mail_from' => 'no-reply@toolsbydcx.com',
    ],
    'smtp' => [
        'host' => 'smtp.hostinger.com',
        'port' => 465,
        'encryption' => 'ssl',
        'username' => 'account@toolsbydcx.com',
        'password' => 'CHANGE_ME',
    ],
];
