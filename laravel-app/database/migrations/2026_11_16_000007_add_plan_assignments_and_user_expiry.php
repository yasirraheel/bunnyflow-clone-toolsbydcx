<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (!Schema::hasColumn('users', 'plan_expires_at')) {
            Schema::table('users', function (Blueprint $table) {
                $table->dateTime('plan_expires_at')->nullable()->after('plan');
            });
        }

        if (!Schema::hasTable('plan_shared_accounts')) {
            Schema::create('plan_shared_accounts', function (Blueprint $table) {
                $table->id();
                $table->string('plan', 20);
                $table->foreignId('shared_account_id')->constrained('shared_accounts')->cascadeOnDelete();
                $table->timestamps();
                $table->unique(['plan', 'shared_account_id']);
                $table->index('plan');
            });
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('plan_shared_accounts');
        if (Schema::hasColumn('users', 'plan_expires_at')) {
            Schema::table('users', fn (Blueprint $table) => $table->dropColumn('plan_expires_at'));
        }
    }
};
