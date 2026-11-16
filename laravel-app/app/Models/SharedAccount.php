<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class SharedAccount extends Model
{
    use HasFactory;

    protected $fillable = ['account_title', 'platform_id', 'cookie_payload', 'enabled'];

    protected $hidden = ['cookie_payload'];

    protected $casts = ['enabled' => 'boolean'];

    public function platform()
    {
        return $this->belongsTo(Platform::class);
    }
}
