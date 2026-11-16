<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\BinaryFileResponse;
use ZipArchive;
use RecursiveDirectoryIterator;
use RecursiveIteratorIterator;
use FilesystemIterator;

class ExtensionController extends Controller
{
    public function download(Request $request): BinaryFileResponse
    {
        $user = $request->user();
        $isAdmin = $user->isAdmin();
        $hasActivePlan = $user->plan !== 'free'
            ? (!$user->plan_expires_at || $user->plan_expires_at->isFuture())
            : ($user->plan_expires_at && $user->plan_expires_at->isFuture());

        abort_unless($isAdmin || $hasActivePlan, 403, 'An active plan is required to download the extension.');

        $source = base_path('extension/tools-by-dcx-extension');
        abort_unless(is_dir($source), 404, 'Extension package is not available.');

        $archivePath = tempnam(storage_path('app'), 'toolsbydcx-extension-');
        abort_unless($archivePath !== false, 500, 'Could not prepare the extension package.');

        $archive = new ZipArchive();
        if ($archive->open($archivePath, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
            @unlink($archivePath);
            abort(500, 'Could not create the extension package.');
        }

        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($source, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::LEAVES_ONLY
        );
        foreach ($iterator as $file) {
            if (!$file->isFile()) continue;
            $relative = ltrim(str_replace($source, '', $file->getPathname()), DIRECTORY_SEPARATOR);
            $archive->addFile($file->getPathname(), str_replace(DIRECTORY_SEPARATOR, '/', $relative));
        }
        $archive->close();

        return response()->download($archivePath, 'ToolsByDcx-Extension.zip', [
            'Content-Type' => 'application/zip',
            'Cache-Control' => 'no-store, private',
        ])->deleteFileAfterSend(true);
    }
}
