<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;

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

    private function user(User $user): array
    {
        return [
            'id' => $user->id, 'username' => $user->username, 'email' => $user->email,
            'role' => $user->role, 'plan' => $user->plan, 'emailVerified' => (bool) $user->email_verified,
            'status' => $user->status, 'credits' => (int) $user->credits, 'createdAt' => $user->created_at,
        ];
    }
}
