<?php

use Illuminate\Support\Facades\Route;

Route::view('/', 'app');
Route::get('/settings/{path?}', fn () => view('pages.settings'))->where('path', '.*');
Route::view('/admin/dashboard', 'app')->name('admin.dashboard');
Route::view('/admin/users', 'app')->name('admin.users');
Route::view('/admin/users/{id}/edit', 'app')->whereNumber('id')->name('admin.users.edit');
Route::view('/admin/orders', 'app')->name('admin.orders');
Route::view('/admin/accounts', 'app')->name('admin.accounts');
Route::view('/admin/platforms', 'app')->name('admin.platforms');
Route::view('/admin/settings', 'app')->name('admin.settings');
Route::view('/admin/plans', 'app')->name('admin.plans');
Route::view('/admin/plans/{plan}/edit', 'app')->whereIn('plan', ['free', 'basic', 'pro', 'ultra'])->name('admin.plans.edit');
Route::get('/admin/{path?}', fn () => view('app'))->where('path', '.*');
Route::get('/user/{path?}', fn () => view('app'))->where('path', '.*');
Route::get('/{path?}', fn () => view('app'))->where('path', '^(?!api(?:/|$)).*');
