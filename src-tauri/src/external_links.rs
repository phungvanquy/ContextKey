//! Open rendered links in the system browser, never in a privileged webview.

fn validate_url(value: &str) -> Result<String, String> {
    if value
        .chars()
        .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err("Invalid link address".into());
    }
    let url = reqwest::Url::parse(value).map_err(|_| "Invalid link address")?;
    let allowed = match url.scheme() {
        "http" | "https" => url.has_host() && url.username().is_empty() && url.password().is_none(),
        "mailto" => !url.path().is_empty(),
        _ => false,
    };
    if !allowed {
        return Err("Only HTTP, HTTPS, and email links can be opened".into());
    }
    Ok(url.into())
}

pub fn open(value: &str) -> Result<(), String> {
    let url = validate_url(value)?;
    #[cfg(windows)]
    {
        use std::ptr::null;
        use windows_sys::{
            core::w,
            Win32::{
                System::Com::{
                    CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
                    COINIT_DISABLE_OLE1DDE,
                },
                UI::{
                    Shell::{
                        ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW,
                    },
                    WindowsAndMessaging::SW_SHOWNORMAL,
                },
            },
        };
        let wide: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
        // SAFETY: A validated URL goes directly to the OS protocol handler,
        // never through a command interpreter. Buffers outlive the native call.
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
                    fMask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
                    lpVerb: w!("open"),
                    lpFile: wide.as_ptr(),
                    nShow: SW_SHOWNORMAL,
                    ..Default::default()
                };
                let result = ShellExecuteExW(&mut info);
                CoUninitialize();
                result != 0
            }
        };
        if opened {
            Ok(())
        } else {
            Err("Could not open the system browser".into())
        }
    }
    #[cfg(not(windows))]
    {
        let _ = url;
        Err("Opening external links is supported on Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::validate_url;

    #[test]
    fn permits_web_and_email_links() {
        for value in [
            "https://example.com/path?q=a%20b&x=1",
            "http://localhost:8080/",
            "mailto:hello@example.com",
        ] {
            assert!(validate_url(value).is_ok(), "{value}");
        }
    }

    #[test]
    fn rejects_executable_local_relative_and_obfuscated_links() {
        for value in [
            "javascript:alert(1)",
            "data:text/html,<script>x</script>",
            "file:///C:/Windows/system32/cmd.exe",
            "ms-settings:about",
            "tauri://localhost",
            "/relative",
            "\\\\server\\share",
            "https://user:password@example.com",
            "https://example.com\0.exe",
            "https://example.com\n",
            "mailto:",
            "https://",
        ] {
            assert!(validate_url(value).is_err(), "{value:?}");
        }
    }
}
