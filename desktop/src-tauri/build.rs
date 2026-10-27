fn main() {
    // Notifiche del Mac (UNUserNotificationCenter) in Objective-C: delegate, categorie con i pulsanti.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=src/notify_mac.m");
        cc::Build::new().file("src/notify_mac.m").flag("-fobjc-arc").flag("-Wno-unused-parameter").flag("-mmacosx-version-min=13.0").compile("ciccio_notify");
        println!("cargo:rustc-link-lib=framework=UserNotifications");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=AppKit");
    }
    tauri_build::build()
}
