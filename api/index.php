<?php
declare(strict_types=1);

/* Small same-origin auth API for the Tools By DCX SPA. */

const JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$configFile = __DIR__ . '/config.local.php';
if (!is_file($configFile)) {
    respond(['error' => 'Server authentication is not configured yet.'], 503);
}
$config = require $configFile;

try {
    $pdo = new PDO(
        $config['db']['dsn'],
        $config['db']['user'],
        $config['db']['password'],
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]
    );
} catch (Throwable $e) {
    error_log('Tools By DCX auth DB connection failed: ' . $e->getMessage());
    respond(['error' => 'Authentication service is temporarily unavailable.'], 503);
}

$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$route = preg_replace('#^/api/?#', '', $path);
$body = json_decode((string) file_get_contents('php://input'), true);
$body = is_array($body) ? $body : [];

try {
    if ($route === 'brand-config' && $method === 'GET') {
        brandConfig($pdo);
    }
    if (str_starts_with($route, 'admin/')) {
        adminRoute($pdo, $config, $method, substr($route, 6), $body);
    }
    switch ($method . ' ' . $route) {
        case 'POST auth/register':
            registerUser($pdo, $config, $body);
            break;
        case 'POST auth/login':
            loginUser($pdo, $config, $body);
            break;
        case 'GET auth/me':
            respond(['user' => userFromToken($pdo, bearerToken())]);
            break;
        case 'POST auth/logout':
            revokeToken($pdo, bearerToken());
            respond(['ok' => true]);
            break;
        case 'POST auth/forgot-password':
            forgotPassword($pdo, $config, $body);
            break;
        case 'POST auth/reset-password':
            resetPassword($pdo, $config, $body);
            break;
        case 'PATCH auth/update-profile':
            updateProfile($pdo, bearerToken(), $body);
            break;
        case 'DELETE auth/delete-account':
            deleteAccount($pdo, bearerToken(), $body);
            break;
        default:
            respond(['error' => 'Not found'], 404);
    }
} catch (DomainException $e) {
    respond(['error' => $e->getMessage()], 400);
} catch (UnauthorizedException $e) {
    respond(['error' => $e->getMessage()], 401);
} catch (Throwable $e) {
    error_log('Tools By DCX auth API error: ' . $e->getMessage());
    respond(['error' => 'Unexpected server error.'], 500);
}

function brandConfig(PDO $pdo): never
{
    $plans = [];
    try {
        $rows = $pdo->query('SELECT plan, price, cut_price, visible, duration_days FROM plans ORDER BY FIELD(plan, "basic", "pro", "ultra")')->fetchAll();
        foreach ($rows as $row) {
            $plans[$row['plan']] = [
                'price' => (float) $row['price'],
                'cutPrice' => $row['cut_price'] === null ? null : (float) $row['cut_price'],
                'visible' => (bool) $row['visible'],
                'durationDays' => (int) $row['duration_days'],
            ];
        }
    } catch (Throwable $e) {
        error_log('Tools By DCX plan config read failed: ' . $e->getMessage());
    }
    respond(['brand' => [
        'tenantId' => null,
        'brandName' => 'Tools By DCX',
        'logoUrl' => '/bunny-logo.png',
        'primaryColor' => '#7c3aed',
        'supportEmail' => 'support@toolsbydcx.com',
        'pricing' => [
            'vibe' => $plans['basic'] ?? ['price' => 999, 'cutPrice' => 1999, 'visible' => true],
            'plus' => $plans['pro'] ?? ['price' => 1710, 'cutPrice' => 2999, 'visible' => true],
            'max' => $plans['ultra'] ?? ['price' => 2499, 'cutPrice' => 4999, 'visible' => true],
            'extra' => [
                'basic' => ['visible' => $plans['basic']['visible'] ?? true],
                'pro' => ['visible' => $plans['pro']['visible'] ?? true],
                'ultra' => ['visible' => $plans['ultra']['visible'] ?? true],
            ],
        ],
    ]]);
}

function adminRoute(PDO $pdo, array $config, string $method, string $route, array $input): never
{
    if ($method === 'POST' && $route === 'login') {
        $identity = strtolower(trim((string) ($input['email'] ?? '')));
        $password = (string) ($input['password'] ?? '');
        $stmt = $pdo->prepare('SELECT * FROM users WHERE email = :email LIMIT 1');
        $stmt->execute(['email' => $identity]);
        $user = $stmt->fetch();
        if (!$user || ($user['role'] ?? 'user') !== 'admin' || !password_verify($password, (string) $user['password_hash'])) {
            throw new UnauthorizedException('Invalid admin credentials.');
        }
        respond(['token' => createToken($pdo, $config, (int) $user['id'], $input), 'user' => publicUser($user)]);
    }

    $admin = adminUser($pdo);
    if ($method === 'GET' && $route === 'stats') {
        $stats = $pdo->query("SELECT COUNT(*) AS total, SUM(role = 'admin') AS admins, SUM(role = 'user') AS users, SUM(status = 'active') AS active FROM users")->fetch();
        respond(['stats' => [
            'totalUsers' => (int) ($stats['total'] ?? 0),
            'admins' => (int) ($stats['admins'] ?? 0),
            'users' => (int) ($stats['users'] ?? 0),
            'activeUsers' => (int) ($stats['active'] ?? 0),
        ]]);
    }
    if ($method === 'GET' && $route === 'plans') {
        $rows = $pdo->query('SELECT plan, price, cut_price AS cutPrice, visible, duration_days AS durationDays FROM plans ORDER BY FIELD(plan, "basic", "pro", "ultra")')->fetchAll();
        respond(['plans' => $rows]);
    }
    if ($method === 'PATCH' && preg_match('#^plans/([a-z0-9_-]+)$#', $route, $match)) {
        $plan = $match[1];
        $stmt = $pdo->prepare('UPDATE plans SET price = :price, cut_price = :cut_price, visible = :visible, duration_days = :duration_days WHERE plan = :plan');
        $stmt->execute([
            'price' => max(0, (float) ($input['price'] ?? 0)),
            'cut_price' => isset($input['cutPrice']) && $input['cutPrice'] !== '' ? max(0, (float) $input['cutPrice']) : null,
            'visible' => !empty($input['visible']) ? 1 : 0,
            'duration_days' => max(0, (int) ($input['durationDays'] ?? 0)),
            'plan' => $plan,
        ]);
        respond(['ok' => true]);
    }
    if ($method === 'GET' && $route === 'users') {
        $page = max(1, (int) ($_GET['page'] ?? 1));
        $limit = min(100, max(1, (int) ($_GET['limit'] ?? 50)));
        $search = trim((string) ($_GET['search'] ?? ''));
        $where = '';
        $params = [];
        if ($search !== '') {
            $where = 'WHERE email LIKE :search OR username LIKE :search';
            $params['search'] = '%' . $search . '%';
        }
        $count = $pdo->prepare("SELECT COUNT(*) FROM users {$where}");
        $count->execute($params);
        $query = $pdo->prepare("SELECT id, username, email, role, plan, email_verified AS emailVerified, status, credits, created_at AS createdAt FROM users {$where} ORDER BY id DESC LIMIT :limit OFFSET :offset");
        foreach ($params as $key => $value) $query->bindValue(':' . $key, $value, PDO::PARAM_STR);
        $query->bindValue(':limit', $limit, PDO::PARAM_INT);
        $query->bindValue(':offset', ($page - 1) * $limit, PDO::PARAM_INT);
        $query->execute();
        respond(['users' => $query->fetchAll(), 'total' => (int) $count->fetchColumn(), 'page' => $page, 'limit' => $limit]);
    }
    if (preg_match('#^users/(\d+)$#', $route, $match)) {
        $id = (int) $match[1];
        if ($method === 'GET') respond(['user' => adminUserDetails($pdo, $id)]);
        if ($method === 'PATCH') {
            $allowed = ['email', 'username', 'role', 'plan', 'status', 'credits'];
            $sets = [];
            $params = ['id' => $id];
            foreach ($allowed as $field) {
                if (array_key_exists($field, $input)) {
                    $sets[] = "{$field} = :{$field}";
                    $params[$field] = $input[$field];
                }
            }
            if (!$sets) throw new DomainException('No user changes supplied.');
            $pdo->prepare('UPDATE users SET ' . implode(', ', $sets) . ', updated_at = NOW() WHERE id = :id')->execute($params);
            respond(['user' => adminUserDetails($pdo, $id)]);
        }
        if ($method === 'DELETE') {
            if ($id === (int) $admin['id']) throw new DomainException('You cannot delete your own admin account.');
            $pdo->prepare('DELETE FROM users WHERE id = :id')->execute(['id' => $id]);
            respond(['ok' => true]);
        }
    }
    if ($method === 'GET' && $route === 'settings') {
        $rows = $pdo->query('SELECT plan, price, cut_price, visible, duration_days FROM plans ORDER BY FIELD(plan, "basic", "pro", "ultra")')->fetchAll();
        $settings = [];
        foreach ($rows as $row) {
            $prefix = 'plan_' . $row['plan'];
            $settings[] = ['key' => $prefix . '_price', 'value' => (float) $row['price']];
            $settings[] = ['key' => $prefix . '_cut_price', 'value' => $row['cut_price'] === null ? '' : (float) $row['cut_price']];
            $settings[] = ['key' => $prefix . '_duration_days', 'value' => (int) $row['duration_days']];
            $settings[] = ['key' => $prefix . '_visible', 'value' => (bool) $row['visible']];
        }
        respond(['settings' => $settings]);
    }
    if ($method === 'PATCH' && $route === 'settings') {
        foreach ($input as $key => $value) {
            if (preg_match('/^plan_(basic|pro|ultra)_(price|cut_price|duration_days|visible)$/', (string) $key, $match)) {
                $field = $match[2];
                $column = $field === 'cut_price' ? 'cut_price' : $field;
                $parsed = $field === 'visible' ? (!empty($value) ? 1 : 0) : ($value === '' && $field === 'cut_price' ? null : max(0, (float) $value));
                if ($field === 'duration_days') $parsed = max(0, (int) $value);
                $stmt = $pdo->prepare("UPDATE plans SET {$column} = :value WHERE plan = :plan");
                $stmt->execute(['value' => $parsed, 'plan' => $match[1]]);
            }
        }
        respond(['ok' => true]);
    }
    if ($method === 'GET' && $route === 'analytics') respond(['overview' => [], 'analytics' => []]);
    if ($method === 'GET' && $route === 'extension-meta') respond(['version' => null]);
    if (in_array($method, ['GET', 'POST'], true)) respond(['users' => [], 'sessions' => [], 'orders' => [], 'requests' => []]);
    respond(['ok' => true]);
}

function adminUser(PDO $pdo): array
{
    $key = trim((string) ($_SERVER['HTTP_X_ADMIN_KEY'] ?? ''));
    if ($key === '') $key = bearerToken();
    $user = userFromToken($pdo, $key);
    if (($user['role'] ?? 'user') !== 'admin') throw new UnauthorizedException('Admin access required.');
    return $user;
}

function adminUserDetails(PDO $pdo, int $id): array
{
    return publicUser(getUser($pdo, $id)) + ['status' => getUser($pdo, $id)['status'] ?? 'active'];
}

function respond(array $payload, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_FLAGS);
    exit;
}

function registerUser(PDO $pdo, array $config, array $input): never
{
    $username = trim((string) ($input['username'] ?? ''));
    $email = strtolower(trim((string) ($input['email'] ?? '')));
    $password = (string) ($input['password'] ?? '');
    validateCredentials($username, $email, $password);

    $check = $pdo->prepare('SELECT id FROM users WHERE email = :email OR username = :username LIMIT 1');
    $check->execute(['email' => $email, 'username' => $username]);
    if ($check->fetch()) {
        throw new DomainException('Email or username is already in use.');
    }

    $stmt = $pdo->prepare(
        'INSERT INTO users (username, email, password_hash, role, plan, email_verified, onboarding_completed, credits)
         VALUES (:username, :email, :password_hash, "user", "free", 1, 0, 0)'
    );
    $stmt->execute([
        'username' => $username,
        'email' => $email,
        'password_hash' => password_hash($password, PASSWORD_DEFAULT),
    ]);
    $userId = (int) $pdo->lastInsertId();
    $user = getUser($pdo, $userId);
    $token = createToken($pdo, $config, $userId, $input);
    respond(['token' => $token, 'user' => publicUser($user)], 201);
}

function loginUser(PDO $pdo, array $config, array $input): never
{
    $identity = strtolower(trim((string) ($input['email'] ?? $input['username'] ?? '')));
    $password = (string) ($input['password'] ?? '');
    if ($identity === '' || $password === '') {
        throw new DomainException('Email and password are required.');
    }
    $stmt = $pdo->prepare('SELECT * FROM users WHERE email = :email OR username = :username LIMIT 1');
    $stmt->execute(['email' => $identity, 'username' => $identity]);
    $user = $stmt->fetch();
    if (!$user || !password_verify($password, (string) $user['password_hash'])) {
        throw new UnauthorizedException('Invalid email or password.');
    }
    if (($user['status'] ?? 'active') !== 'active') {
        throw new UnauthorizedException('This account is not active.');
    }
    $token = createToken($pdo, $config, (int) $user['id'], $input);
    respond(['token' => $token, 'user' => publicUser($user)]);
}

function forgotPassword(PDO $pdo, array $config, array $input): never
{
    $email = strtolower(trim((string) ($input['email'] ?? '')));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        throw new DomainException('Please enter a valid email address.');
    }
    $stmt = $pdo->prepare('SELECT id FROM users WHERE email = :email AND status = "active" LIMIT 1');
    $stmt->execute(['email' => $email]);
    $user = $stmt->fetch();
    if ($user) {
        $raw = bin2hex(random_bytes(32));
        $insert = $pdo->prepare(
            'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
             VALUES (:user_id, :token_hash, DATE_ADD(NOW(), INTERVAL 1 HOUR))'
        );
        $insert->execute(['user_id' => $user['id'], 'token_hash' => hash('sha256', $raw)]);
        $link = rtrim($config['app']['base_url'], '/') . '/reset-password?token=' . urlencode($raw);
        $subject = 'Reset your Tools By DCX password';
        $message = "Open this link within 60 minutes to reset your password:\n\n{$link}\n";
        $headers = 'From: ' . $config['app']['mail_from'] . "\r\n" . 'Content-Type: text/plain; charset=UTF-8';
        sendMail($config, $email, $subject, $message, $config['app']['mail_from']);
    }
    respond(['ok' => true, 'message' => 'If that account exists, a reset link has been sent.']);
}

function sendMail(array $config, string $to, string $subject, string $body, string $from): bool
{
    $smtp = $config['smtp'] ?? null;
    if (is_array($smtp) && !empty($smtp['host']) && !empty($smtp['username']) && !empty($smtp['password'])) {
        try {
            $transport = ((int) ($smtp['port'] ?? 465) === 465 ? 'ssl://' : '') . $smtp['host'];
            $errno = 0;
            $errstr = '';
            $socket = @fsockopen($transport, (int) ($smtp['port'] ?? 465), $errno, $errstr, 15);
            if (!$socket) throw new RuntimeException('SMTP connect failed: ' . $errstr);
            stream_set_timeout($socket, 15);
            smtpExpect($socket, '220');
            smtpCommand($socket, 'EHLO flow.toolsbydcx.com', '250');
            smtpCommand($socket, 'AUTH LOGIN', '334');
            smtpCommand($socket, base64_encode((string) $smtp['username']), '334');
            smtpCommand($socket, base64_encode((string) $smtp['password']), '235');
            smtpCommand($socket, 'MAIL FROM:<' . $from . '>', '250');
            smtpCommand($socket, 'RCPT TO:<' . $to . '>', '250');
            smtpCommand($socket, 'DATA', '354');
            $headers = 'From: Tools By DCX <' . $from . ">\r\n" .
                'To: <' . $to . ">\r\n" .
                'Subject: ' . $subject . "\r\n" .
                'MIME-Version: 1.0' . "\r\n" .
                'Content-Type: text/plain; charset=UTF-8' . "\r\n\r\n";
            $payload = preg_replace('/(^|\r\n)\./', '$1..', $headers . $body);
            fwrite($socket, $payload . "\r\n.\r\n");
            smtpExpect($socket, '250');
            fwrite($socket, "QUIT\r\n");
            fclose($socket);
            return true;
        } catch (Throwable $e) {
            error_log('Tools By DCX SMTP send failed: ' . $e->getMessage());
        }
    }
    return @mail($to, $subject, $body, 'From: ' . $from . "\r\n" . 'Content-Type: text/plain; charset=UTF-8');
}

function smtpCommand($socket, string $command, string $expected): void
{
    fwrite($socket, $command . "\r\n");
    smtpExpect($socket, $expected);
}

function smtpExpect($socket, string $expected): void
{
    $response = '';
    while (($line = fgets($socket, 2048)) !== false) {
        $response .= $line;
        if (strlen($line) < 4 || $line[3] === ' ') break;
    }
    if (substr($response, 0, 3) !== $expected) {
        throw new RuntimeException('SMTP response ' . substr($response, 0, 120));
    }
}

function resetPassword(PDO $pdo, array $config, array $input): never
{
    $raw = trim((string) ($input['token'] ?? ''));
    $password = (string) ($input['newPassword'] ?? '');
    if (strlen($raw) < 32 || strlen($password) < 8) {
        throw new DomainException('Reset token or password is invalid.');
    }
    $stmt = $pdo->prepare(
        'SELECT pr.id, pr.user_id FROM password_reset_tokens pr
         WHERE pr.token_hash = :token_hash AND pr.used_at IS NULL AND pr.expires_at > NOW() LIMIT 1'
    );
    $stmt->execute(['token_hash' => hash('sha256', $raw)]);
    $reset = $stmt->fetch();
    if (!$reset) {
        throw new UnauthorizedException('This reset link is invalid or expired.');
    }
    $pdo->beginTransaction();
    $update = $pdo->prepare('UPDATE users SET password_hash = :password_hash, updated_at = NOW() WHERE id = :id');
    $update->execute(['password_hash' => password_hash($password, PASSWORD_DEFAULT), 'id' => $reset['user_id']]);
    $mark = $pdo->prepare('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = :id');
    $mark->execute(['id' => $reset['id']]);
    $revoke = $pdo->prepare('UPDATE auth_tokens SET revoked_at = NOW() WHERE user_id = :id AND revoked_at IS NULL');
    $revoke->execute(['id' => $reset['user_id']]);
    $pdo->commit();
    $user = getUser($pdo, (int) $reset['user_id']);
    respond(['token' => createToken($pdo, $config, (int) $reset['user_id'], $input), 'user' => publicUser($user)]);
}

function updateProfile(PDO $pdo, string $token, array $input): never
{
    $user = userFromToken($pdo, $token);
    if (isset($input['currentPassword'], $input['newPassword'])) {
        if (!password_verify((string) $input['currentPassword'], (string) $user['password_hash'])) {
            throw new UnauthorizedException('Current password is incorrect.');
        }
        if (strlen((string) $input['newPassword']) < 8) {
            throw new DomainException('New password must be at least 8 characters.');
        }
        $stmt = $pdo->prepare('UPDATE users SET password_hash = :hash, updated_at = NOW() WHERE id = :id');
        $stmt->execute(['hash' => password_hash((string) $input['newPassword'], PASSWORD_DEFAULT), 'id' => $user['id']]);
    }
    if (isset($input['email'])) {
        $email = strtolower(trim((string) $input['email']));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new DomainException('Please enter a valid email address.');
        }
        $stmt = $pdo->prepare('UPDATE users SET email = :email, updated_at = NOW() WHERE id = :id');
        $stmt->execute(['email' => $email, 'id' => $user['id']]);
    }
    respond(['user' => publicUser(getUser($pdo, (int) $user['id']))]);
}

function deleteAccount(PDO $pdo, string $token, array $input): never
{
    $user = userFromToken($pdo, $token);
    if (!password_verify((string) ($input['password'] ?? ''), (string) $user['password_hash'])) {
        throw new UnauthorizedException('Password is incorrect.');
    }
    $stmt = $pdo->prepare('DELETE FROM users WHERE id = :id');
    $stmt->execute(['id' => $user['id']]);
    respond(['ok' => true]);
}

function validateCredentials(string $username, string $email, string $password): void
{
    if (!preg_match('/^[A-Za-z0-9_.-]{3,32}$/', $username)) {
        throw new DomainException('Username must be 3-32 characters and use only letters, numbers, dots, dashes, or underscores.');
    }
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        throw new DomainException('Please enter a valid email address.');
    }
    if (strlen($password) < 8) {
        throw new DomainException('Password must be at least 8 characters.');
    }
}

function createToken(PDO $pdo, array $config, int $userId, array $input): string
{
    $raw = bin2hex(random_bytes(32));
    $stmt = $pdo->prepare(
        'INSERT INTO auth_tokens (user_id, token_hash, device_id, fingerprint, ip_address, user_agent, expires_at)
         VALUES (:user_id, :token_hash, :device_id, :fingerprint, :ip_address, :user_agent, DATE_ADD(NOW(), INTERVAL 30 DAY))'
    );
    $stmt->execute([
        'user_id' => $userId,
        'token_hash' => hash('sha256', $raw),
        'device_id' => substr((string) ($input['deviceId'] ?? ''), 0, 128) ?: null,
        'fingerprint' => substr((string) ($input['fingerprint'] ?? ''), 0, 255) ?: null,
        'ip_address' => $_SERVER['REMOTE_ADDR'] ?? null,
        'user_agent' => substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 512) ?: null,
    ]);
    return $raw;
}

function bearerToken(): string
{
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (preg_match('/^Bearer\s+(.+)$/i', $header, $match)) {
        return trim($match[1]);
    }
    return '';
}

function userFromToken(PDO $pdo, string $raw): array
{
    if ($raw === '') {
        throw new UnauthorizedException('Authentication required.');
    }
    $stmt = $pdo->prepare(
        'SELECT u.*, at.token_hash FROM auth_tokens at JOIN users u ON u.id = at.user_id
         WHERE at.token_hash = :token_hash AND at.revoked_at IS NULL AND at.expires_at > NOW() LIMIT 1'
    );
    $stmt->execute(['token_hash' => hash('sha256', $raw)]);
    $user = $stmt->fetch();

    // Laravel Sanctum tokens are formatted as "id|plain-token" and store
    // only the SHA-256 hash of the plain part. Accept them here so legacy
    // feature endpoints remain compatible with the new Laravel login flow.
    if (!$user && str_contains($raw, '|')) {
        [, $plain] = explode('|', $raw, 2);
        $sanctum = $pdo->prepare(
            'SELECT u.* FROM personal_access_tokens pat JOIN users u ON u.id = pat.tokenable_id
             WHERE pat.tokenable_type = :type AND pat.token = :token
             AND (pat.expires_at IS NULL OR pat.expires_at > NOW()) LIMIT 1'
        );
        $sanctum->execute([
            'type' => 'App\\Models\\User',
            'token' => hash('sha256', $plain),
        ]);
        $user = $sanctum->fetch();
    }

    if (!$user || ($user['status'] ?? 'active') !== 'active') {
        throw new UnauthorizedException('Session expired. Please log in again.');
    }
    return $user;
}

function revokeToken(PDO $pdo, string $raw): void
{
    if ($raw === '') return;
    $stmt = $pdo->prepare('UPDATE auth_tokens SET revoked_at = NOW() WHERE token_hash = :token_hash');
    $stmt->execute(['token_hash' => hash('sha256', $raw)]);
}

function getUser(PDO $pdo, int $id): array
{
    $stmt = $pdo->prepare('SELECT * FROM users WHERE id = :id LIMIT 1');
    $stmt->execute(['id' => $id]);
    $user = $stmt->fetch();
    if (!$user) throw new UnauthorizedException('User not found.');
    return $user;
}

function publicUser(array $user): array
{
    $plan = (string) ($user['plan'] ?? 'free');
    return [
        'id' => (int) $user['id'],
        'email' => $user['email'],
        'username' => $user['username'],
        'role' => $user['role'] ?? 'user',
        'plan' => $plan,
        'planActive' => $plan !== 'free',
        'emailVerified' => (bool) ($user['email_verified'] ?? false),
        'onboardingCompleted' => (bool) ($user['onboarding_completed'] ?? false),
        'credits' => (int) ($user['credits'] ?? 0),
        'daysRemaining' => 0,
    ];
}

final class UnauthorizedException extends RuntimeException {}
