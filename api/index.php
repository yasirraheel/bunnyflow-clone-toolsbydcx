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
        @mail($email, $subject, $message, $headers);
    }
    respond(['ok' => true, 'message' => 'If that account exists, a reset link has been sent.']);
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
