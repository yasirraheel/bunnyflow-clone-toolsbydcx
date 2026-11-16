<?php

use Illuminate\Support\Facades\Route;

Route::view('/', 'app');
Route::get('/admin/{path?}', fn () => view('app'))->where('path', '.*');
Route::get('/user/{path?}', fn () => view('app'))->where('path', '.*');
Route::get('/{path?}', fn () => view('app'))->where('path', '^(?!api(?:/|$)).*');
