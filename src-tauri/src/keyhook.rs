//! Low-level keyboard hook — the whole Windows FFI surface for input lives here.
//!
//! One rule governs the callback: read `vkCode`, hand it on, return.
//!
//! Specifically it must never call `ToUnicodeEx`, `AttachThreadInput`,
//! `GetKeyboardState` or `GetKeyboardLayout`. Those mutate state shared with the
//! foreground app's text input — `ToUnicodeEx` rewrites the kernel-mode keyboard
//! buffer holding dead-key and composition state, and `AttachThreadInput` alters
//! key state and is documented to fragment TSF IME composition when called from a
//! hook callback. Vietnamese Telex needs 2-3 keystrokes per accented character, so
//! it crosses that window constantly. This is why `rdev` was replaced: it made all
//! four calls per keystroke to populate an `Event::name` nothing ever read.
//!
//! The callback must also stay bounded. Windows skips or silently removes a
//! low-level hook whose callback overruns `LowLevelHooksTimeout` (~300ms), which
//! would degrade typing system-wide *and* kill the hotkeys with no diagnostic. So:
//! no allocation, no blocking, no unbounded loop, and `CallNextHookEx` on every
//! path.
//!
//! No mouse hook is installed. Cursor position is sampled on demand at fire time.

/// A Windows virtual-key code, as delivered by the hook.
pub type Vk = u32;

/// What happened to a key. Key identity is the raw VK code — the hook already
/// speaks that, so translating to an enum would only add a layer to get wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyEvent {
    Press(Vk),
    Release(Vk),
}

// ── Virtual-key codes ────────────────────────────────────────────────────────
// Values from Win32 `VIRTUAL_KEY`, kept as `Vk` so the hotkey table never casts.

pub const VK_CONTROL: Vk = 0x11;
pub const VK_LCONTROL: Vk = 0xA2;
pub const VK_RCONTROL: Vk = 0xA3;
pub const VK_SHIFT: Vk = 0x10;
pub const VK_LSHIFT: Vk = 0xA0;
pub const VK_RSHIFT: Vk = 0xA1;
pub const VK_MENU: Vk = 0x12;
pub const VK_LMENU: Vk = 0xA4;
pub const VK_RMENU: Vk = 0xA5;
pub const VK_LWIN: Vk = 0x5B;
pub const VK_RWIN: Vk = 0x5C;
pub const VK_CAPITAL: Vk = 0x14;
pub const VK_SPACE: Vk = 0x20;
pub const VK_INSERT: Vk = 0x2D;
/// Letter VKs equal their uppercase ASCII value; `C` is named because the
/// default prefixes (`Ctrl+C`) use it directly.
pub const VK_C: Vk = b'C' as Vk;

/// VK for an uppercase `A`–`Z`. The letter block is contiguous from `A` = 0x41.
pub fn vk_letter(c: char) -> Option<Vk> {
    matches!(c, 'A'..='Z').then(|| c as Vk)
}

/// VK for a digit `0`–`9`. The digit block is contiguous from `0` = 0x30.
pub fn vk_digit(c: char) -> Option<Vk> {
    c.is_ascii_digit().then(|| c as Vk)
}

/// VK for a function key `F1`–`F12`. `VK_F1` = 0x70, contiguous upward.
pub fn vk_function(n: u8) -> Option<Vk> {
    (1..=12).contains(&n).then(|| 0x70 + n as Vk - 1)
}

// ── Windows implementation ───────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod imp {
    use super::{KeyEvent, Vk};
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::atomic::{AtomicPtr, Ordering};
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetCursorPos, GetMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
        HC_ACTION, HHOOK, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, WH_KEYBOARD_LL, WM_KEYDOWN,
        WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    type Handler = Box<dyn Fn(KeyEvent) + Send + Sync>;

    static HANDLER: OnceLock<Handler> = OnceLock::new();
    static HOOK: AtomicPtr<core::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());

    /// Classify a hook event, or `None` if it is not a physical key transition.
    ///
    /// # Safety
    /// `lparam` must be the `KBDLLHOOKSTRUCT` pointer Windows passed to the hook.
    unsafe fn classify(wparam: WPARAM, lparam: LPARAM) -> Option<KeyEvent> {
        let info = unsafe { *(lparam as *const KBDLLHOOKSTRUCT) };

        // Injected keystrokes are software-generated. A hotkey is a physical
        // gesture, and IMEs synthesise input while composing (Telex-style helpers
        // send a Backspace plus the composed character per accent), which would
        // otherwise drive the state machine on every accented character.
        if info.flags & LLKHF_INJECTED != 0 {
            return None;
        }

        match wparam as u32 {
            WM_KEYDOWN | WM_SYSKEYDOWN => Some(KeyEvent::Press(info.vkCode as Vk)),
            WM_KEYUP | WM_SYSKEYUP => Some(KeyEvent::Release(info.vkCode as Vk)),
            _ => None,
        }
    }

    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            if let Some(event) = unsafe { classify(wparam, lparam) } {
                if let Some(handler) = HANDLER.get() {
                    // A panic unwinding out of an `extern "system"` fn is UB, and
                    // this one runs for every keystroke on the machine. The body
                    // is integer compares over a poison-recovering lock, so the
                    // guard should never fire — it is here because the cost of
                    // being wrong is the whole OS input path.
                    let _ = catch_unwind(AssertUnwindSafe(|| handler(event)));
                }
            }
        }
        // Reached on every path, including a skipped event or a caught panic:
        // swallowing an event here would drop a keystroke system-wide.
        unsafe { CallNextHookEx(HOOK.load(Ordering::Relaxed), code, wparam, lparam) }
    }

    /// Install the hook and pump messages until the process exits.
    ///
    /// Blocks. A low-level hook is dispatched to the message queue of the thread
    /// that installed it, so without a pump on *this* thread the callback never
    /// runs — the hook would install successfully and observe nothing.
    pub fn install<F>(on_event: F)
    where
        F: Fn(KeyEvent) + Send + Sync + 'static,
    {
        if HANDLER.set(Box::new(on_event)).is_err() {
            return; // already installed; a second hook would double-fire
        }

        let hook = unsafe {
            SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), std::ptr::null_mut(), 0)
        };
        if hook.is_null() {
            return;
        }
        HOOK.store(hook, Ordering::Relaxed);

        let mut msg = MSG::default();
        // No windows on this thread, so nothing to translate or dispatch: the
        // pump exists purely to let the hook callback run while we block here.
        while unsafe { GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) } > 0 {}
    }

    /// Release the hook. Safe to call when nothing is installed.
    pub fn uninstall() {
        let hook: HHOOK = HOOK.swap(std::ptr::null_mut(), Ordering::Relaxed);
        if !hook.is_null() {
            unsafe { UnhookWindowsHookEx(hook) };
        }
    }

    /// Current cursor position in physical screen pixels.
    pub fn cursor_pos() -> (f64, f64) {
        let mut p = POINT { x: 100, y: 100 };
        unsafe { GetCursorPos(&mut p) };
        (p.x as f64, p.y as f64)
    }

    /// Whether either Ctrl is physically down right now.
    ///
    /// Queried live rather than tracked, so a missed KeyRelease cannot leave a
    /// cached flag stuck. Note `VK_CONTROL` also reads down for AltGr, which
    /// synthesises LCtrl+RAlt — pre-existing behavior, and AltGr is unused by the
    /// prefix whitelist.
    pub fn ctrl_is_down() -> bool {
        (unsafe { GetAsyncKeyState(super::VK_CONTROL as i32) } as u16 & 0x8000) != 0
    }
}

// ── Non-Windows stubs ────────────────────────────────────────────────────────
// The app is Windows-only in practice (xcap, SAPI TTS, app.manifest, CI is
// windows-latest). These exist so `cargo check` runs in a Linux dev environment,
// not as a portability claim.

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::KeyEvent;

    pub fn install<F>(_on_event: F)
    where
        F: Fn(KeyEvent) + Send + Sync + 'static,
    {
        loop {
            std::thread::park();
        }
    }

    pub fn uninstall() {}

    pub fn cursor_pos() -> (f64, f64) {
        (100.0, 100.0)
    }

    pub fn ctrl_is_down() -> bool {
        false
    }
}

pub use imp::{ctrl_is_down, cursor_pos, install, uninstall};
