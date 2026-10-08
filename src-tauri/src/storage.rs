//! Import saved data from the former app name without modifying the legacy file.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

/// Prefer the ContextKey file, even when its contents are malformed. Only a
/// missing file permits importing its legacy sibling. Copy the original text
/// verbatim so credentials, unknown fields, and malformed data are preserved;
/// callers retain their existing parsing and validation rules.
pub fn read_with_legacy(path: &Path, legacy_name: &str) -> io::Result<String> {
    match fs::read_to_string(path) {
        Ok(text) => return Ok(text),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }

    let text = fs::read_to_string(path.with_file_name(legacy_name))?;
    // Never replace a ContextKey file created since the initial read. If the
    // import cannot be saved, still use the legacy data for this session.
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    // Config files contain API credentials; do not expose them to other users
    // when importing a file whose permissions may have been tightened.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(mut file) => {
            if let Err(error) = file.write_all(text.as_bytes()) {
                drop(file);
                let _ = fs::remove_file(path);
                eprintln!("could not import saved data to {}: {error}", path.display());
            }
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return fs::read_to_string(path);
        }
        Err(error) => {
            eprintln!("could not import saved data to {}: {error}", path.display());
        }
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            static NEXT_ID: AtomicU64 = AtomicU64::new(0);
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "contextkey-storage-{}-{stamp}-{}",
                std::process::id(),
                NEXT_ID.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn file(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn imports_legacy_text_verbatim_and_keeps_an_independent_original() {
        let dir = TestDir::new();
        let path = dir.file("current.json");
        let legacy = dir.file("legacy.json");
        let text = "{\n  \"api_key\": \"test-key\", \"target_language\": \"Tiếng Việt\", \"unknown\": 42\n}\n";
        fs::write(&legacy, text).unwrap();

        assert_eq!(read_with_legacy(&path, "legacy.json").unwrap(), text);
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
        fs::write(&path, "updated settings").unwrap();
        assert_eq!(fs::read_to_string(&legacy).unwrap(), text);
    }

    #[test]
    fn existing_contextkey_data_takes_precedence() {
        let dir = TestDir::new();
        let path = dir.file("current.json");
        fs::write(&path, "current settings").unwrap();
        fs::write(dir.file("legacy.json"), "old settings").unwrap();

        assert_eq!(
            read_with_legacy(&path, "legacy.json").unwrap(),
            "current settings"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "current settings");
    }

    #[test]
    fn malformed_current_data_is_not_replaced_with_legacy_data() {
        let dir = TestDir::new();
        let path = dir.file("current.json");
        fs::write(&path, "{broken").unwrap();
        fs::write(dir.file("legacy.json"), "{}").unwrap();

        assert_eq!(read_with_legacy(&path, "legacy.json").unwrap(), "{broken");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{broken");
    }

    #[test]
    fn malformed_legacy_data_is_preserved_for_recovery() {
        let dir = TestDir::new();
        let path = dir.file("current.json");
        fs::write(dir.file("legacy.json"), "{broken").unwrap();

        assert_eq!(read_with_legacy(&path, "legacy.json").unwrap(), "{broken");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{broken");
        assert_eq!(
            fs::read_to_string(dir.file("legacy.json")).unwrap(),
            "{broken"
        );
    }

    #[test]
    fn missing_files_are_reported_without_creating_a_file() {
        let dir = TestDir::new();
        let path = dir.file("current.json");

        let error = read_with_legacy(&path, "legacy.json").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert!(!path.exists());
    }

    #[test]
    fn current_read_errors_do_not_trigger_a_legacy_import() {
        let dir = TestDir::new();
        let path = dir.file("current.json");
        fs::create_dir(&path).unwrap();
        fs::write(dir.file("legacy.json"), "{}").unwrap();

        assert!(read_with_legacy(&path, "legacy.json").is_err());
        assert!(path.is_dir());
    }

    #[test]
    fn unreadable_legacy_text_does_not_create_a_current_file() {
        let dir = TestDir::new();
        let path = dir.file("current.json");
        fs::write(dir.file("legacy.json"), [0xff, 0xfe]).unwrap();

        let error = read_with_legacy(&path, "legacy.json").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn imported_credentials_are_private_to_the_current_user() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TestDir::new();
        let path = dir.file("current.json");
        fs::write(dir.file("legacy.json"), "{}").unwrap();

        read_with_legacy(&path, "legacy.json").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0);
    }
}
