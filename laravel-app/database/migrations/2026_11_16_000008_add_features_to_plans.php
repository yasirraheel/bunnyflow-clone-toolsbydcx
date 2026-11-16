<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (!Schema::hasColumn('plans', 'features_json')) {
            Schema::table('plans', function (Blueprint $table) {
                $table->text('features_json')->nullable()->after('duration_days');
            });
        }

        $defaults = [
            'free' => ['3-Day Free Trial Access', 'Google Veo 3.1 Lite Lower Model', 'Text-to-Video & Image-to-Video', 'Nano Banana AI Image Access'],
            'basic' => ['Full Google Flow Access', '5,000 Google Flow Credits', 'Text-to-Video & Image-to-Video', 'Nano Banana AI Image Access', 'Voice Cloning & Prompt Library'],
            'pro' => ['25,000 Google Flow Credits Included', 'Veo 3.1 Lite / Fast / Quality', '2x Concurrent Video Generations', 'Voice Cloning & Prompt Library', 'Nano Banana Pro & Imagen Pro'],
            'ultra' => ['Everything in Plus', '45,000 Google Flow Credits Included', 'Omni Flash Access', '3x Concurrent Video Generations', 'ChatGPT & Meta AI Access'],
        ];

        foreach ($defaults as $plan => $features) {
            $current = DB::table('plans')->where('plan', $plan)->value('features_json');
            if (!$current) {
                DB::table('plans')->where('plan', $plan)->update([
                    'features_json' => json_encode($features, JSON_UNESCAPED_UNICODE),
                    'updated_at' => now(),
                ]);
            }
        }
    }

    public function down(): void
    {
        if (Schema::hasColumn('plans', 'features_json')) {
            Schema::table('plans', fn (Blueprint $table) => $table->dropColumn('features_json'));
        }
    }
};
