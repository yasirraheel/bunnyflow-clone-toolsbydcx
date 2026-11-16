<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Platform;
use App\Models\SharedAccount;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Crypt;

/**
 * Session endpoints for the Tools By DCX browser extension.
 *
 * The extension mirrors the Bunny Flow extension's protocol: the website
 * login token (flow_token) authenticates these calls (flow.auth), the
 * extension asks for the shared Google account's cookies, writes them into
 * the user's browser, and opens Google Flow already logged in.
 *
 * Cookie values are never logged. Only cookie names/counts are ever inspected.
 */
class ExtensionSessionController extends Controller
{
    private const ALLOWED_DOMAINS = ['google.com', 'labs.google', 'googleapis.com'];

    private const BLOCKED_ROTATION_COOKIES = [
        '__Secure-1PSIDRTS',
        '__Secure-3PSIDRTS',
        'SIDRTS',
        '__Secure-STRP',
        'LSID',
        '__Host-1PLSID',
        '__Host-3PLSID',
        '__Host-GAPS',
        'ACCOUNT_CHOOSER',
        'SMSV',
        'OTZ',
    ];

    /**
     * Exchange the website login token for an extension session.
     * Returns the same bearer token back (flow.auth already validated it),
     * plus the user's plan info, in the shape the extension expects.
     */
    public function webSso(Request $request): JsonResponse
    {
        $user = $request->user();

        $daysLeft = null;
        if ($user->plan_expires_at) {
            $daysLeft = max(0, (int) ceil(now()->diffInSeconds($user->plan_expires_at, false) / 86400));
        }

        return response()->json([
            'success' => true,
            'token' => trim((string) $request->bearerToken()),
            'user' => [
                'email' => $user->email,
                'username' => $user->username,
                'plan' => $user->plan,
                'daysLeft' => $daysLeft ?? 0,
                'expiresAt' => $user->plan_expires_at?->toISOString(),
            ],
        ]);
    }

    /**
     * Return the shared account's cookies for the requested mode.
     * GET /api/extension/session?mode=video|image
     * GET /api/extension/session/{id} (slot detail refresh, same payload)
     */
    public function session(Request $request, ?string $id = null): JsonResponse
    {
        $user = $request->user();
        $mode = strtolower((string) $request->query('mode', 'video')) === 'image' ? 'image' : 'video';

        // No active plan (and not admin): empty session, never an error that
        // would log the extension out. The extension shows "empty" state.
        if (!$this->hasActivePlan($user)) {
            return response()->json([
                'success' => true,
                'sessions' => [],
                'data' => [],
                'cookieSig' => null,
                'cookiesUnchanged' => false,
                'maintenance' => false,
                'limitReached' => true,
                'noAccount' => false,
                'noValidCookies' => false,
                'pool' => ['serverNumber' => 1, 'totalServers' => 1],
            ]);
        }

        $account = $this->accountForMode($user, $mode);
        if (!$account) {
            return response()->json([
                'success' => true,
                'sessions' => [],
                'data' => [],
                'cookieSig' => null,
                'cookiesUnchanged' => false,
                'maintenance' => false,
                'limitReached' => false,
                'noAccount' => true,
                'noValidCookies' => false,
                'pool' => ['serverNumber' => 1, 'totalServers' => 1],
            ]);
        }

        $cookies = $this->validatedCookies($account);
        $sig = substr(hash('sha256', $account->getRawOriginal('cookie_payload')), 0, 16);
        $slotId = $mode === 'image' ? 'session_image_2' : 'session1';
        $slotNum = $mode === 'image' ? 2 : 1;

        $session = [
            'id' => $slotId,
            'name' => $account->account_title,
            'mode' => $mode,
            'slot' => $slotNum,
            'cookie_count' => count($cookies),
            'cookieSig' => $sig,
            'updated_at' => $account->updated_at?->toIso8601String(),
            'actual_uploaded_at' => $account->updated_at?->toIso8601String(),
            'serverNumber' => 1,
            'totalServers' => 1,
        ];

        return response()->json([
            'success' => true,
            'sessions' => [$session],
            'data' => $cookies,
            'cookieSig' => $sig,
            'cookiesUnchanged' => false,
            'maintenance' => false,
            'limitReached' => false,
            'noAccount' => false,
            'noValidCookies' => count($cookies) === 0,
            'pool' => ['serverNumber' => 1, 'totalServers' => 1],
        ]);
    }

    private function hasActivePlan($user): bool
    {
        if ($user->isAdmin()) {
            return true;
        }
        if ($user->plan === 'free') {
            return (bool) ($user->plan_expires_at && $user->plan_expires_at->isFuture());
        }
        return !$user->plan_expires_at || $user->plan_expires_at->isFuture();
    }

    /**
     * The shared account for this user's plan and mode. Plan assignments
     * (plan_shared_accounts) win; otherwise the first enabled account of
     * the matching platform is used.
     */
    private function accountForMode($user, string $mode): ?SharedAccount
    {
        $platform = $this->platformForMode($mode);

        $query = SharedAccount::where('enabled', true)
            ->when($platform, fn ($q) => $q->where('platform_id', $platform->id))
            ->orderBy('id');

        // Prefer an account assigned to the user's plan.
        $assigned = (clone $query)
            ->join('plan_shared_accounts as psa', 'psa.shared_account_id', '=', 'shared_accounts.id')
            ->where('psa.plan', $user->plan)
            ->first(['shared_accounts.*']);

        return $assigned ?? $query->first();
    }

    private function platformForMode(string $mode): ?Platform
    {
        $platforms = Platform::orderBy('id')->get();
        if ($platforms->isEmpty()) {
            return null;
        }
        $match = function (array $needles) use ($platforms) {
            foreach ($platforms as $platform) {
                $name = strtolower((string) $platform->name);
                foreach ($needles as $needle) {
                    if (str_contains($name, $needle)) {
                        return $platform;
                    }
                }
            }
            return null;
        };
        if ($mode === 'image') {
            return $match(['nano', 'banana', 'image']) ?? $platforms->get(1) ?? $platforms->first();
        }
        return $match(['flow', 'veo', 'video']) ?? $platforms->first();
    }

    /**
     * Decrypt the stored payload and keep only usable Google cookies.
     * Returns the cookie list exactly as stored (the extension re-validates
     * each cookie before writing it). Never logs cookie values.
     */
    private function validatedCookies(SharedAccount $account): array
    {
        try {
            $raw = Crypt::decryptString($account->cookie_payload);
            $decoded = json_decode($raw, true);
        } catch (\Throwable) {
            return [];
        }
        $list = is_array($decoded) ? ($decoded['cookies'] ?? $decoded) : [];
        if (!is_array($list) || count($list) > 500) {
            return [];
        }

        $now = time();
        $out = [];
        foreach ($list as $cookie) {
            if (!is_array($cookie)) {
                continue;
            }
            $name = trim((string) ($cookie['name'] ?? ''));
            if ($name === '' || in_array($name, self::BLOCKED_ROTATION_COOKIES, true)
                || str_ends_with($name, 'PSIDRTS') || str_ends_with($name, 'SIDRTS')) {
                continue;
            }
            $domain = strtolower(ltrim(trim((string) ($cookie['domain'] ?? '')), '.'));
            if ($domain === '' || !$this->allowedDomain($domain)) {
                continue;
            }
            if (isset($cookie['expirationDate']) && is_numeric($cookie['expirationDate'])
                && empty($cookie['session']) && (float) $cookie['expirationDate'] < $now) {
                continue;
            }
            $out[] = $cookie;
        }
        return array_values($out);
    }

    private function allowedDomain(string $domain): bool
    {
        if ($domain === 'accounts.google.com' || str_ends_with($domain, '.accounts.google.com')) {
            return false;
        }
        foreach (self::ALLOWED_DOMAINS as $allowed) {
            if ($domain === $allowed || str_ends_with($domain, '.' . $allowed)) {
                return true;
            }
        }
        return false;
    }
}
