//! iOS：关掉 WKWebView 内层 scrollView 的自动安全区内缩。
//!
//! 现象：底部（TabBar 之下、Home 指示条之上）固定露一条白带，改 CSS 无效。
//!
//! 原因：iOS 11+ 的 `UIScrollView.contentInsetAdjustmentBehavior` 默认 `.automatic`，
//! WKWebView 内层 scrollView 会按安全区自动加 inset，把文档往上推；而 CSS 仍按整屏
//! 布局，画布实际只有「屏幕 − 安全区」高，漏出的那条显示 window 背景色。
//! `position: fixed; inset: 0` 也只能在缩小的画布内铺满，出不了这个框。
//!
//! 做法：`contentInsetAdjustmentBehavior = .never`，让 CSS `env(safe-area-inset-*)`
//! 成为安全区的唯一来源（前端已用 `--sat` / `--sab` 自行让位）。
//!
//! `objc2-web-kit` 0.3.2 没有暴露 `WKWebView.scrollView`，所以这里用
//! `msg_send!` 动态发送，不额外引依赖（objc2 / objc2-ui-kit 已是 tao/wry 的间接依赖）。

#[cfg(target_os = "ios")]
pub fn disable_auto_inset(window: &tauri::WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_ui_kit::{UIScrollView, UIScrollViewContentInsetAdjustmentBehavior, UIEdgeInsets};

    // WebviewWindow 实现了 AsRef<Webview>，拿到底层 Webview 才能调 with_webview。
    let webview: &tauri::Webview = window.as_ref();
    webview.with_webview(|platform| {
        let raw = platform.inner();
        if raw.is_null() {
            return;
        }
        // SAFETY: `inner()` 返回 Tauri 持有的 WKWebView 指针，闭包在 main thread 执行。
        unsafe {
            let wk = raw.cast::<AnyObject>();
            // WKWebView.scrollView 是只读属性，返回其内部的 UIScrollView。
            let scroll: *mut AnyObject = msg_send![wk, scrollView];
            if scroll.is_null() {
                return;
            }
            let scroll: &UIScrollView = &*scroll.cast::<UIScrollView>();
            // .never = 不让 UIKit 按安全区自动加 inset
            scroll.setContentInsetAdjustmentBehavior(
                UIScrollViewContentInsetAdjustmentBehavior::Never,
            );
            // 双保险：清掉此前布局可能残留的 inset，否则内容仍会被顶高。
            scroll.setContentInset(UIEdgeInsets {
                top: 0.0,
                left: 0.0,
                bottom: 0.0,
                right: 0.0,
            });
        }
    });
}

