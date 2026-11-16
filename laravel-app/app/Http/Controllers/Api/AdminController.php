<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Platform;
use App\Models\SharedAccount;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Crypt;

class AdminController extends Controller
{
    public function stats(): JsonResponse
    {
        return response()->json(['stats' => [
            'totalUsers' => User::count(),
            'users' => User::where('role', 'user')->count(),
            'admins' => User::where('role', 'admin')->count(),
            'activeUsers' => User::where('status', 'active')->count(),
        ]]);
    }

    public function users(Request $request): JsonResponse
    {
        $query = User::query();
        if ($search = trim((string) $request->query('search'))) {
            $query->where(fn ($q) => $q->where('email', 'like', "%{$search}%")->orWhere('username', 'like', "%{$search}%"));
        }
        $page = max(1, (int) $request->query('page', 1));
        $limit = min(100, max(1, (int) $request->query('limit', 50)));
        $result = $query->orderByDesc('id')->paginate($limit, ['id','username','email','role','plan','email_verified','status','credits','created_at'], 'page', $page);
        return response()->json(['users' => collect($result->items())->map(fn ($u) => $this->user($u),), 'total' => $result->total(), 'page' => $page, 'limit' => $limit]);
    }

    public function updateUser(Request $request, int $id): JsonResponse
    {
        $user = User::findOrFail($id);
        $data = $request->validate([
            'email' => ['sometimes', 'email', 'max:190', 'unique:users,email,' . $id],
            'username' => ['sometimes', 'alpha_dash', 'min:3', 'max:32', 'unique:users,username,' . $id],
            'role' => ['sometimes', 'in:user,admin'],
            'plan' => ['sometimes', 'string', 'max:32'],
            'status' => ['sometimes', 'in:active,suspended'],
            'credits' => ['sometimes', 'integer', 'min:0'],
        ]);
        $user->fill($data)->save();
        return response()->json(['user' => $this->user($user->fresh())]);
    }

    public function showUser(int $id): JsonResponse
    {
        return response()->json(['user' => $this->user(User::findOrFail($id))]);
    }

    public function deleteUser(Request $request, int $id): JsonResponse
    {
        abort_if($request->user()->id === $id, 422, 'You cannot delete your own admin account.');
        User::findOrFail($id)->delete();
        return response()->json(['ok' => true]);
    }

    public function plans(): JsonResponse
    {
        return response()->json(['plans' => DB::table('plans')->orderByRaw("FIELD(plan, 'basic', 'pro', 'ultra')")->get()]);
    }

    public function updatePlan(Request $request, string $plan): JsonResponse
    {
        $data = $request->validate(['price' => ['required', 'numeric', 'min:0'], 'cutPrice' => ['nullable', 'numeric', 'min:0'], 'visible' => ['required', 'boolean'], 'durationDays' => ['required', 'integer', 'min:0']]);
        DB::table('plans')->where('plan', $plan)->update(['price' => $data['price'], 'cut_price' => $data['cutPrice'] ?? null, 'visible' => $data['visible'], 'duration_days' => $data['durationDays'], 'updated_at' => now()]);
        return response()->json(['ok' => true]);
    }

    public function settings(): JsonResponse
    {
        $settings = [];
        foreach (DB::table('plans')->orderBy('plan')->get() as $plan) {
            $prefix = 'plan_' . $plan->plan;
            $settings[] = ['key' => $prefix . '_price', 'value' => (float) $plan->price];
            $settings[] = ['key' => $prefix . '_cut_price', 'value' => $plan->cut_price === null ? '' : (float) $plan->cut_price];
            $settings[] = ['key' => $prefix . '_duration_days', 'value' => (int) $plan->duration_days];
            $settings[] = ['key' => $prefix . '_visible', 'value' => (bool) $plan->visible];
        }
        return response()->json(['settings' => $settings]);
    }

    public function updateSettings(Request $request): JsonResponse
    {
        foreach ($request->all() as $key => $value) {
            if (preg_match('/^plan_(basic|pro|ultra)_(price|cut_price|duration_days|visible)$/', (string) $key, $match)) {
                $column = $match[2];
                $value = $column === 'visible' ? (int) (bool) $value : ($value === '' && $column === 'cut_price' ? null : $value);
                DB::table('plans')->where('plan', $match[1])->update([$column => $value, 'updated_at' => now()]);
            }
        }
        return response()->json(['ok' => true]);
    }

    public function platforms(): JsonResponse
    {
        return response()->json(['platforms' => Platform::query()->orderBy('name')->get(['id', 'name', 'url', 'enabled', 'created_at'])]);
    }

    public function storePlatform(Request $request): JsonResponse
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:120', 'unique:platforms,name'],
            'url' => ['required', 'url', 'max:2048'],
        ]);
        $platform = Platform::create($data);
        return response()->json(['platform' => $platform], 201);
    }

    public function updatePlatform(Request $request, int $id): JsonResponse
    {
        $platform = Platform::findOrFail($id);
        $data = $request->validate([
            'name' => ['sometimes', 'string', 'max:120', 'unique:platforms,name,' . $id],
            'url' => ['sometimes', 'url', 'max:2048'],
            'enabled' => ['sometimes', 'boolean'],
        ]);
        $platform->update($data);
        return response()->json(['platform' => $platform->fresh()]);
    }

    public function deletePlatform(int $id): JsonResponse
    {
        Platform::findOrFail($id)->delete();
        return response()->json(['ok' => true]);
    }

    public function accounts(): JsonResponse
    {
        $accounts = SharedAccount::with('platform')->latest()->get()->map(fn (SharedAccount $account) => $this->account($account));
        return response()->json(['accounts' => $accounts]);
    }

    public function storeAccount(Request $request): JsonResponse
    {
        $data = $request->validate([
            'accountTitle' => ['required', 'string', 'max:160'],
            'platformId' => ['required', 'integer', 'exists:platforms,id'],
            'cookie' => ['required', 'json'],
        ]);
        $account = SharedAccount::create([
            'account_title' => $data['accountTitle'],
            'platform_id' => $data['platformId'],
            'cookie_payload' => Crypt::encryptString($data['cookie']),
            'enabled' => true,
        ]);
        return response()->json(['account' => $this->account($account->load('platform'))], 201);
    }

    public function updateAccount(Request $request, int $id): JsonResponse
    {
        $account = SharedAccount::findOrFail($id);
        $data = $request->validate([
            'accountTitle' => ['sometimes', 'string', 'max:160'],
            'platformId' => ['sometimes', 'integer', 'exists:platforms,id'],
            'cookie' => ['sometimes', 'json'],
            'enabled' => ['sometimes', 'boolean'],
        ]);
        $account->fill([
            'account_title' => $data['accountTitle'] ?? $account->account_title,
            'platform_id' => $data['platformId'] ?? $account->platform_id,
            'enabled' => $data['enabled'] ?? $account->enabled,
        ]);
        if (array_key_exists('cookie', $data)) {
            $account->cookie_payload = Crypt::encryptString($data['cookie']);
        }
        $account->save();
        return response()->json(['account' => $this->account($account->fresh('platform'))]);
    }

    public function deleteAccount(int $id): JsonResponse
    {
        SharedAccount::findOrFail($id)->delete();
        return response()->json(['ok' => true]);
    }

    private function user(User $user): array
    {
        return [
            'id' => $user->id, 'username' => $user->username, 'email' => $user->email,
            'role' => $user->role, 'plan' => $user->plan, 'emailVerified' => (bool) $user->email_verified,
            'status' => $user->status, 'credits' => (int) $user->credits, 'createdAt' => $user->created_at,
        ];
    }

    private function account(SharedAccount $account): array
    {
        return [
            'id' => $account->id,
            'accountTitle' => $account->account_title,
            'platformId' => $account->platform_id,
            'platform' => $account->platform ? [
                'id' => $account->platform->id,
                'name' => $account->platform->name,
                'url' => $account->platform->url,
            ] : null,
            'enabled' => (bool) $account->enabled,
            'cookieSaved' => filled($account->cookie_payload),
            'createdAt' => $account->created_at,
            'updatedAt' => $account->updated_at,
        ];
    }
}
