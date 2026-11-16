<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class Platform extends Model
{
    use HasFactory;

    protected $fillable = ['name', 'url', 'enabled'];

    protected $casts = ['enabled' => 'boolean'];

    public function accounts()
    {
        return $this->hasMany(SharedAccount::class);
    }
}
