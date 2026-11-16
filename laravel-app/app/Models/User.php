<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Laravel\Sanctum\HasApiTokens;

class User extends Authenticatable
{
    use HasApiTokens, HasFactory, Notifiable;

    protected $table = 'users';

    protected $fillable = [
        'username', 'email', 'password_hash', 'role', 'plan', 'plan_expires_at',
        'email_verified', 'onboarding_completed', 'credits', 'status',
    ];

    protected $hidden = ['password_hash', 'remember_token'];

    protected $casts = [
        'email_verified' => 'boolean',
        'onboarding_completed' => 'boolean',
        'credits' => 'integer',
        'plan_expires_at' => 'datetime',
    ];

    public function getAuthPassword(): string
    {
        return (string) $this->password_hash;
    }

    public function isAdmin(): bool
    {
        return $this->role === 'admin';
    }

}
