fn main() {
    // Tauri embeds icons at compile time; ensure icon regen invalidates the build.
    for icon in [
        "icons/icon.icns",
        "icons/icon.png",
        "icons/32x32.png",
        "icons/app-icon-source.png",
        "icons/app-icon-source.svg",
    ] {
        println!("cargo:rerun-if-changed={icon}");
    }
    tauri_build::build()
}
