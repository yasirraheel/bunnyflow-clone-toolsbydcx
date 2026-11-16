<?php

use App\Http\Controllers\Api\AdminController;
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\BrandConfigController;
use Illuminate\Support\Facades\Route;

Route::get('/brand-config', BrandConfigController::class);

Route::prefix('auth')->middleware('throttle:30,1')->group(function () {
    Route::post('/register', [AuthController::class, 'register']);
    Route::post('/login', [AuthController::class, 'login'])->middleware('throttle:10,1');
    Route::post('/forgot-password', [AuthController::class, 'forgotPassword'])->middleware('throttle:5,1');
    Route::post('/reset-password', [AuthController::class, 'resetPassword'])->middleware('throttle:10,1');
    Route::post('/admin-login', [AuthController::class, 'adminLogin'])->middleware('throttle:10,1');
    Route::middleware('flow.auth')->group(function () {
        Route::get('/me', [AuthController::class, 'me']);
        Route::post('/logout', [AuthController::class, 'logout']);
        Route::patch('/update-profile', [AuthController::class, 'updateProfile']);
        Route::delete('/delete-account', [AuthController::class, 'deleteAccount']);
    });
});

// Backward-compatible endpoint used by the existing admin UI login form.
Route::post('/admin/login', [AuthController::class, 'adminLogin'])->middleware('throttle:10,1');

Route::prefix('admin')->middleware(['flow.auth', 'role:admin'])->group(function () {
    Route::get('/stats', [AdminController::class, 'stats']);
    Route::get('/users', [AdminController::class, 'users']);
    Route::get('/users/{id}', [AdminController::class, 'showUser']);
    Route::patch('/users/{id}', [AdminController::class, 'updateUser']);
    Route::delete('/users/{id}', [AdminController::class, 'deleteUser']);
    Route::get('/plans', [AdminController::class, 'plans']);
    Route::patch('/plans/{plan}', [AdminController::class, 'updatePlan']);
    Route::get('/settings', [AdminController::class, 'settings']);
    Route::patch('/settings', [AdminController::class, 'updateSettings']);
});
