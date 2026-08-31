use anyhow::{Context, Result};
use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings2;
use windows_core::{Interface, HSTRING, PWSTR};

pub(super) fn append_user_agent(window: &WebviewWindow) {
    if let Err(error) = window.with_webview(|platform| {
        if let Err(error) = configure_user_agent(platform) {
            eprintln!("window: could not append the SPAWN D WebView2 user-agent token: {error:#}");
        }
    }) {
        eprintln!("window: could not access WebView2 for user-agent setup: {error}");
    }
}

fn configure_user_agent(platform: tauri::webview::PlatformWebview) -> Result<()> {
    // WebView2 owns the returned string and allocates it with CoTaskMemAlloc;
    // `take_pwstr` copies and frees it. Read the live Edge UA first so SPAWN D
    // never bakes in a browser version or an obsolete browser identity.
    let controller = platform.controller();
    let webview = unsafe { controller.CoreWebView2() }.context("reading the WebView2 instance")?;
    let settings = unsafe { webview.Settings() }.context("reading the WebView2 settings")?;
    let settings: ICoreWebView2Settings2 = settings
        .cast()
        .context("WebView2 does not expose ICoreWebView2Settings2")?;
    let mut raw = PWSTR::null();
    unsafe { settings.UserAgent(&mut raw) }.context("reading the default WebView2 user agent")?;
    let default = webview2_com::take_pwstr(raw);
    let value = append_product_token(&default, env!("CARGO_PKG_VERSION"));
    unsafe { settings.SetUserAgent(&HSTRING::from(value)) }
        .context("setting the SPAWN D WebView2 user agent")?;
    Ok(())
}

fn append_product_token(default: &str, version: &str) -> String {
    let without_previous = default
        .split_whitespace()
        .filter(|part| !part.starts_with("SpawnDesktop/"))
        .collect::<Vec<_>>()
        .join(" ");
    format!("{without_previous} SpawnDesktop/{version}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_token_is_appended_exactly_once() {
        let edge = "Mozilla/5.0 AppleWebKit/537.36 Chrome/143.0 Safari/537.36 Edg/143.0";
        let expected = format!("{edge} SpawnDesktop/0.1.2");
        assert_eq!(append_product_token(edge, "0.1.2"), expected);
        assert_eq!(
            append_product_token(&expected, "0.1.3"),
            format!("{edge} SpawnDesktop/0.1.3")
        );
    }
}
