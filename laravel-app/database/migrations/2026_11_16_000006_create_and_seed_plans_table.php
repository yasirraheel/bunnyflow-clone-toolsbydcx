<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (!Schema::hasTable('plans')) {
            Schema::create('plans', function (Blueprint $table) {
                $table->string('plan', 20)->primary();
                $table->decimal('price', 10, 2)->default(0);
                $table->decimal('cut_price', 10, 2)->nullable();
                $table->boolean('visible')->default(true);
                $table->unsignedInteger('duration_days')->default(0);
                $table->timestamp('updated_at')->useCurrent()->useCurrentOnUpdate();
            });
        }

        $now = now();
        foreach ([
            ['plan' => 'free', 'price' => 0, 'cut_price' => null, 'visible' => true, 'duration_days' => 3],
            ['plan' => 'basic', 'price' => 999, 'cut_price' => 1999, 'visible' => true, 'duration_days' => 10],
            ['plan' => 'pro', 'price' => 1710, 'cut_price' => 2999, 'visible' => true, 'duration_days' => 20],
            ['plan' => 'ultra', 'price' => 2499, 'cut_price' => 4999, 'visible' => true, 'duration_days' => 30],
        ] as $default) {
            DB::table('plans')->updateOrInsert(
                ['plan' => $default['plan']],
                [...$default, 'updated_at' => $now]
            );
        }
    }

    public function down(): void
    {
        // Plans may already be used by the live application; keep them on rollback.
    }
};
