<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('shared_accounts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('platform_id')->constrained('platforms')->cascadeOnDelete();
            $table->string('account_title', 160);
            $table->longText('cookie_payload');
            $table->boolean('enabled')->default(true);
            $table->timestamps();
            $table->index(['platform_id', 'enabled']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('shared_accounts');
    }
};
