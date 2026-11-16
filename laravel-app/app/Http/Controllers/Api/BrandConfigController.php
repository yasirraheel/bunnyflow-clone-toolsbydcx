<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;

class BrandConfigController extends Controller
{
    public function __invoke(): JsonResponse
    {
        $plans = DB::table('plans')->get()->keyBy('plan');
        $plan = fn (string $id, float $price, float $cut) => [
            'price' => (float) ($plans[$id]->price ?? $price),
            'cutPrice' => isset($plans[$id]) ? ($plans[$id]->cut_price === null ? null : (float) $plans[$id]->cut_price) : $cut,
            'visible' => (bool) ($plans[$id]->visible ?? true),
        ];
        return response()->json(['brand' => [
            'tenantId' => null,
            'brandName' => 'Tools By DCX',
            'logoUrl' => '/bunny-logo.png',
            'primaryColor' => '#7c3aed',
            'supportEmail' => 'support@toolsbydcx.com',
            'pricing' => [
                'vibe' => $plan('basic', 999, 1999),
                'plus' => $plan('pro', 1710, 2999),
                'max' => $plan('ultra', 2499, 4999),
                'extra' => ['basic' => ['visible' => $plan('basic', 999, 1999)['visible']], 'pro' => ['visible' => $plan('pro', 1710, 2999)['visible']], 'ultra' => ['visible' => $plan('ultra', 2499, 4999)['visible']]],
            ],
        ]]);
    }
}
