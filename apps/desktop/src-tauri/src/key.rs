//! The app's key. The office inside the app answers only requests that carry
//! it, so no other program on the computer can read the office or act in the
//! owner's name (`apps/office/src/lib/server/app-key.ts`).
//!
//! The shell makes a fresh one every time it starts Node, from the system's
//! random source, and keeps it in memory (`renew`, `current`). Node gets it as
//! the first line on its stdin, a pipe only the two hold. It is never in a
//! file, the Keychain, the environment, a command line, a URL or a log line:
//! any program running as the owner can read another's environment and
//! command line (`ps -E`). A key that leaks after its Node is gone opens
//! nothing, since no running office holds it.
//!
//! It goes back to the office three ways: the window's HttpOnly cookie, set
//! before the window asks for anything (`cookie`); the shell's own requests,
//! in a header (`server::call`); and for the owner's browser, which has none,
//! a link the office makes that works once for one path (`main.rs`).
//!
//! Before the shell trusts a server on the port, the server proves it holds
//! the key (`proves`): the shell sends a fresh nonce, the office answers
//! HMAC-SHA256(key, "oddboro-proof:" + nonce). A program that grabbed the
//! port cannot, so the window never sends it the cookie.
//!
//! `Key` has no `Debug` or `Display`, so it cannot be printed by mistake.

use std::sync::{Arc, Mutex};

use ring::hmac;
use tauri::webview::cookie::{Cookie, SameSite};
use tauri::Url;

/// The start of the line Node reads the key from. A line on Node's stdout
/// that holds it never reaches the log (`server::route`).
pub const LINE: &str = "oddboro:key ";
/// The cookie the window carries.
pub const COOKIE: &str = "oddboro-key";
/// The header the shell's own requests carry.
pub const HEADER: &str = "X-Oddboro-Key";
/// The query the office's one-time links for the owner's browser carry.
pub const LINK_QUERY: &str = "oddboro-link";
/// What the proof signs before the nonce, so the answer is good for nothing else.
const PROOF_LABEL: &str = "oddboro-proof:";

/// The key of the Node that runs now, or the last one started.
static CURRENT: Mutex<Option<Arc<Key>>> = Mutex::new(None);

pub struct Key(String);

/// 32 bytes from the system's random source, as 64 hex digits. None when the
/// system has no randomness to give.
fn random_hex() -> Option<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// A fresh key for the Node about to start, which is from now on the
/// current one. None when the system has no randomness to give.
pub fn renew() -> Option<Arc<Key>> {
    let key = Arc::new(fresh()?);
    *CURRENT.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::clone(&key));
    Some(key)
}

/// A fresh key that is not the current one.
pub(crate) fn fresh() -> Option<Key> {
    Some(Key(random_hex()?))
}

/// The key of the Node that runs now, or the last one started. None before
/// the first start.
pub fn current() -> Option<Arc<Key>> {
    CURRENT.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// A fresh nonce for one proof: 32 random bytes as 64 hex digits.
pub fn nonce() -> Option<String> {
    random_hex()
}

impl Key {
    /// The line Node reads first on its stdin, without its line break.
    pub fn line(&self) -> String {
        format!("{LINE}{}", self.0)
    }

    /// The header line for a request of the shell's own, without its line break.
    pub fn header(&self) -> String {
        format!("{HEADER}: {}", self.0)
    }

    /// The window's cookie for the office at `office`: HttpOnly, so no page
    /// script reads it; SameSite=Strict, so no other site's request carries
    /// it; and with no expiry, so it lives only while the app runs and the
    /// webview never writes it to disk. It never says Secure, not even
    /// false: macOS takes any value there as Secure, and then never sends it
    /// to the office over http (measured).
    pub fn cookie(&self, office: &Url) -> Cookie<'static> {
        Cookie::build((COOKIE, self.0.clone()))
            .domain(office.host_str().unwrap_or("127.0.0.1").to_string())
            .path("/")
            .http_only(true)
            .same_site(SameSite::Strict)
            .build()
    }

    /// True when `answer` is HMAC-SHA256 under this key of the label and
    /// `nonce`, as 64 hex digits, compared in constant time. Anything else,
    /// a missing or malformed answer included, is false.
    pub fn proves(&self, nonce: &str, answer: &str) -> bool {
        let Some(tag) = unhex(answer.trim()) else {
            return false;
        };
        let key = hmac::Key::new(hmac::HMAC_SHA256, self.0.as_bytes());
        hmac::verify(&key, format!("{PROOF_LABEL}{nonce}").as_bytes(), &tag).is_ok()
    }
}

/// 64 hex digits as 32 bytes, or None.
fn unhex(text: &str) -> Option<Vec<u8>> {
    if text.len() != 64 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}

#[cfg(test)]
pub mod tests {
    use super::*;

    fn hex(key: &Key) -> &str {
        &key.0
    }

    /// What the office answers, made the way `app-key.ts` makes it.
    pub fn answer(key: &Key, nonce: &str) -> String {
        let k = hmac::Key::new(hmac::HMAC_SHA256, key.0.as_bytes());
        let tag = hmac::sign(&k, format!("oddboro-proof:{nonce}").as_bytes());
        tag.as_ref().iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn every_node_start_gets_a_fresh_key_of_32_random_bytes() {
        let a = renew().unwrap();
        assert!(Arc::ptr_eq(&a, &current().unwrap()));
        let b = renew().unwrap();
        assert!(Arc::ptr_eq(&b, &current().unwrap()));
        for key in [&a, &b] {
            assert_eq!(hex(key).len(), 64);
            assert!(hex(key)
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
        }
        assert_ne!(hex(&a), hex(&b));
    }

    #[test]
    fn the_pipe_line_is_one_line_the_office_reads() {
        let key = fresh().unwrap();
        let line = key.line();
        assert_eq!(line, format!("oddboro:key {}", hex(&key)));
        assert!(!line.contains('\n') && !line.contains('\r'));
        assert_eq!(key.header(), format!("X-Oddboro-Key: {}", hex(&key)));
    }

    #[test]
    fn the_cookie_is_http_only_strict_and_ends_with_the_app() {
        let key = fresh().unwrap();
        let office = Url::parse("http://127.0.0.1:4500").unwrap();
        let cookie = key.cookie(&office);
        assert_eq!(cookie.name(), "oddboro-key");
        assert_eq!(cookie.value(), hex(&key));
        assert_eq!(cookie.domain(), Some("127.0.0.1"));
        assert_eq!(cookie.path(), Some("/"));
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(cookie.same_site(), Some(SameSite::Strict));
        assert_eq!(cookie.secure(), None);
        assert_eq!(cookie.max_age(), None);
        assert_eq!(cookie.expires(), None);
    }

    #[test]
    fn only_the_right_key_proves_itself_for_this_nonce() {
        let key = fresh().unwrap();
        let other = fresh().unwrap();
        let n = nonce().unwrap();
        assert_eq!(n.len(), 64);
        let right = answer(&key, &n);
        assert!(key.proves(&n, &right));
        assert!(key.proves(&n, &format!("{right}\n")));
        assert!(!key.proves(&n, &answer(&other, &n)));
        assert!(!key.proves(&nonce().unwrap(), &right));
        // The key itself, or anything not 64 hex digits, proves nothing.
        for bad in [
            "",
            "ok",
            hex(&key),
            &right[..63],
            &format!("{right}0"),
            &right.replace(|c: char| c.is_ascii_digit(), "g"),
        ] {
            assert!(!key.proves(&n, bad), "{bad}");
        }
    }
}
