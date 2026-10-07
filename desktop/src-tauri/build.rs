fn main() {
    // 图标会被 Tauri 编译进原生目标；没有这条依赖声明时，单独替换
    // src-tauri/icons/ 下的资源不会触发 tauri dev 重新编译 Debug binary。
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
