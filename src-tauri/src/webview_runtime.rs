//! Native startup recovery for the shared Evergreen WebView2 runtime.
//!
//! Keep this independent of Tauri windows: a missing runtime prevents even an
//! HTML error dialog from opening. The NSIS installer normally provisions the
//! runtime; standalone EXE and Store launches also need this check.

use std::ptr::{null, null_mut};
use windows_sys::{
    core::w,
    Win32::{
        System::Com::{
            CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
        },
        UI::{
            Shell::{ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW},
            WindowsAndMessaging::{
                MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONERROR, MB_ICONINFORMATION, MB_OK,
                MB_SETFOREGROUND, MB_YESNO, SW_SHOWNORMAL,
            },
        },
    },
};

const DOWNLOAD_URL: &str =
    "https://developer.microsoft.com/microsoft-edge/webview2/#download-section";

/// Return false after recovery guidance so main exits without starting the app.
pub fn ensure_available() -> bool {
    // Use the same loader query as Tauri/Wry, including its runtime discovery
    // rules, instead of guessing availability from a browser or registry key.
    match tauri::webview_version() {
        Ok(version) if !version.trim().is_empty() => return true,
        Ok(_) => eprintln!("WebView2 runtime query returned an empty version"),
        Err(error) => eprintln!("WebView2 runtime query failed: {error}"),
    }

    // SAFETY: All strings are NUL-terminated and remain alive for each call.
    // A null owner is appropriate because no application windows exist yet.
    let answer = unsafe {
        MessageBoxW(
            null_mut(),
            w!("ContextKey could not find a usable Microsoft Edge WebView2 Runtime.\n\nInstall the Evergreen Runtime from Microsoft's website, then reopen ContextKey. An internet connection is needed to download it.\n\nOpen Microsoft's download page? ContextKey will close after this message."),
            w!("ContextKey - WebView2 required"),
            MB_YESNO | MB_ICONINFORMATION | MB_DEFBUTTON2 | MB_SETFOREGROUND,
        )
    };
    if answer == IDYES {
        open_download_page();
    }
    false
}

fn open_download_page() {
    let url: Vec<u16> = DOWNLOAD_URL.encode_utf16().chain(Some(0)).collect();
    // SAFETY: Initialize COM for shell extensions on this startup thread. Only
    // balance successful initialization (including S_FALSE) with CoUninitialize.
    // The fixed HTTPS URL is passed directly to the shell, never to a command
    // interpreter. No installer is downloaded or executed by ContextKey.
    let opened = unsafe {
        let initialized = CoInitializeEx(
            null(),
            (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
        );
        if initialized < 0 {
            false
        } else {
            let mut info = SHELLEXECUTEINFOW {
                cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
                // There is no app event loop and this process exits next.
                fMask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
                lpVerb: w!("open"),
                lpFile: url.as_ptr(),
                nShow: SW_SHOWNORMAL,
                ..Default::default()
            };
            let result = ShellExecuteExW(&mut info);
            CoUninitialize();
            result != 0
        }
    };
    if !opened {
        let message: Vec<u16> = format!(
            "Could not open your browser.\n\nVisit {DOWNLOAD_URL}\n\nInstall the Evergreen WebView2 Runtime, then reopen ContextKey. If this device is managed, ask your administrator to install it."
        )
        .encode_utf16()
        .chain(Some(0))
        .collect();
        // SAFETY: The buffer remains alive and is NUL-terminated.
        unsafe {
            MessageBoxW(
                null_mut(),
                message.as_ptr(),
                w!("ContextKey - WebView2 required"),
                MB_OK | MB_ICONERROR | MB_SETFOREGROUND,
            );
        }
    }
}
