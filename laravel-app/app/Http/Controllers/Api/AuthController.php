<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Laravel\Sanctum\PersonalAccessToken;

class AuthController extends Controller
{
    public function register(Request $request): JsonResponse
    {
        $data = $request->validate([
            'username' => ['required', 'string', 'alpha_dash', 'min:3', 'max:32', 'unique:users,username'],
            'email' => ['required', 'email:rfc,dns', 'max:190', 'unique:users,email'],
            'password' => ['required', 'string', 'min:8', 'confirmed'],
        ]);

        $user = User::create([
            'username' => $data['username'],
            'email' => strtolower($data['email']),
            'password_hash' => Hash::make($data['password']),
            'role' => 'user',
            'plan' => 'free',
            'email_verified' => true,
            'onboarding_completed' => false,
            'credits' => 0,
            'status' => 'active',
        ]);

        return response()->json($this->authPayload($user), 201);
    }

    public function login(Request $request): JsonResponse
    {
        $data = $request->validate([
            'email' => ['required', 'string', 'max:190'],
            'password' => ['required', 'string'],
        ]);
        $user = User::where('email', strtolower($data['email']))
            ->orWhere('username', strtolower($data['email']))->first();

        if (!$user || !Hash::check($data['password'], $user->password_hash)) {
            return response()->json(['error' => 'Invalid email or password.'], 401);
        }
        if ($user->status !== 'active') {
            return response()->json(['error' => 'This account is not active.'], 403);
        }

        return response()->json($this->authPayload($user));
    }

    public function adminLogin(Request $request): JsonResponse
    {
        $data = $request->validate([
            'email' => ['required', 'string', 'max:190'],
            'password' => ['required', 'string'],
        ]);
        $user = User::where('email', strtolower($data['email']))->first();
        if (!$user || !$user->isAdmin() || !Hash::check($data['password'], $user->password_hash) || $user->status !== 'active') {
            return response()->json(['error' => 'Invalid admin credentials.'], 401);
        }
        return response()->json($this->authPayload($user));
    }

    public function me(Request $request): JsonResponse
    {
        // Keep both shapes: the current SPA reads the user at the top level,
        // while the admin bridge still reads the legacy nested `user` key.
        $user = $this->publicUser($request->user());
        return response()->json($user + ['user' => $user]);
    }

    public function logout(Request $request): JsonResponse
    {
        $raw = trim((string) $request->bearerToken());
        if ($raw !== '') {
            if ($token = PersonalAccessToken::findToken($raw)) {
                $token->delete();
            } else {
                DB::table('auth_tokens')->where('token_hash', hash('sha256', $raw))->update(['revoked_at' => now()]);
            }
        }
        return response()->json(['ok' => true]);
    }

    public function forgotPassword(Request $request): JsonResponse
    {
        $data = $request->validate(['email' => ['required', 'email', 'max:190']]);
        $user = User::where('email', strtolower($data['email']))->where('status', 'active')->first();

        if ($user) {
            $raw = Str::random(64);
            DB::table('password_reset_tokens')->where('user_id', $user->id)->delete();
            DB::table('password_reset_tokens')->insert([
                'user_id' => $user->id,
                'token_hash' => hash('sha256', $raw),
                'expires_at' => now()->addHour(),
                'created_at' => now(),
            ]);
            $link = rtrim(config('app.url'), '/') . '/reset-password?token=' . urlencode($raw);
            try {
                Mail::raw("Open this link within 60 minutes to reset your password:\n\n{$link}\n", function ($mail) use ($user) {
                    $mail->to($user->email)->subject('Reset your ToolsByDcx password');
                });
            } catch (\Throwable $e) {
                Log::error('Password reset email failed', ['exception' => $e]);
            }
        }

        return response()->json(['ok' => true, 'message' => 'If that account exists, a reset link has been sent.']);
    }

    public function resetPassword(Request $request): JsonResponse
    {
        $data = $request->validate([
            'token' => ['required', 'string', 'min:32'],
            'newPassword' => ['required', 'string', 'min:8'],
        ]);
        $reset = DB::table('password_reset_tokens')->where('token_hash', hash('sha256', $data['token']))
            ->whereNull('used_at')->where('expires_at', '>', now())->first();
        if (!$reset) return response()->json(['error' => 'This reset link is invalid or expired.'], 401);

        DB::transaction(function () use ($reset, $data) {
            User::whereKey($reset->user_id)->update(['password_hash' => Hash::make($data['newPassword']), 'updated_at' => now()]);
            DB::table('password_reset_tokens')->where('id', $reset->id)->update(['used_at' => now()]);
            PersonalAccessToken::where('tokenable_type', User::class)->where('tokenable_id', $reset->user_id)->delete();
            DB::table('auth_tokens')->where('user_id', $reset->user_id)->update(['revoked_at' => now()]);
        });

        return response()->json($this->authPayload(User::findOrFail($reset->user_id)));
    }

    public function updateProfile(Request $request): JsonResponse
    {
        $user = $request->user();
        $data = $request->validate([
            'email' => ['sometimes', 'email', 'max:190', 'unique:users,email,' . $user->id],
            'currentPassword' => ['sometimes', 'string'],
            'newPassword' => ['sometimes', 'string', 'min:8'],
        ]);
        if (isset($data['newPassword'])) {
            if (!isset($data['currentPassword']) || !Hash::check($data['currentPassword'], $user->password_hash)) {
                return response()->json(['error' => 'Current password is incorrect.'], 401);
            }
            $user->password_hash = Hash::make($data['newPassword']);
        }
        if (isset($data['email'])) $user->email = strtolower($data['email']);
        $user->save();
        return response()->json(['user' => $this->publicUser($user->fresh())]);
    }

    public function deleteAccount(Request $request): JsonResponse
    {
        $request->validate(['password' => ['required', 'string']]);
        if (!Hash::check($request->string('password')->toString(), $request->user()->password_hash)) {
            return response()->json(['error' => 'Password is incorrect.'], 401);
        }
        $request->user()->delete();
        return response()->json(['ok' => true]);
    }

    private function authPayload(User $user): array
    {
        return [
            'token' => $user->createToken('flow-web', ['*'], now()->addDays(30))->plainTextToken,
            'user' => $this->publicUser($user),
        ];
    }

    public function publicUser(User $user): array
    {
        return [
            'id' => $user->id,
            'email' => $user->email,
            'username' => $user->username,
            'role' => $user->role,
            'plan' => $user->plan,
            'planActive' => $user->plan !== 'free',
            'emailVerified' => (bool) $user->email_verified,
            'onboardingCompleted' => (bool) $user->onboarding_completed,
            'onboardingAccepted' => (bool) $user->onboarding_completed,
            'credits' => (int) $user->credits,
            'daysRemaining' => 0,
        ];
    }
}
