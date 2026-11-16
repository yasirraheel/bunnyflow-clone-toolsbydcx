<?php

namespace App\Http\Middleware;

use App\Models\User;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Laravel\Sanctum\PersonalAccessToken;
use Symfony\Component\HttpFoundation\Response;

class FlowTokenAuth
{
    public function handle(Request $request, Closure $next): Response
    {
        $raw = trim((string) $request->bearerToken());
        $user = null;

        if ($raw !== '') {
            $accessToken = PersonalAccessToken::findToken($raw);
            if ($accessToken && (!$accessToken->expires_at || $accessToken->expires_at->isFuture())) {
                $user = $accessToken->tokenable;
                $accessToken->forceFill(['last_used_at' => now()])->saveQuietly();
            }

            // Compatibility for tokens created by the previous PHP API.
            if (!$user) {
                $legacy = DB::table('auth_tokens')->where('token_hash', hash('sha256', $raw))
                    ->whereNull('revoked_at')->where('expires_at', '>', now())->first();
                $user = $legacy ? User::find($legacy->user_id) : null;
            }
        }

        if (!$user || $user->status !== 'active') {
            return response()->json(['error' => 'Authentication required.'], 401);
        }

        Auth::setUser($user);
        $request->setUserResolver(fn () => $user);
        return $next($request);
    }
}
