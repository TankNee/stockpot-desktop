// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("cli") {
        // Headless agents must not create windows or a menu-bar app.
        std::process::exit(stockpot_lib::cli::run(&args[1..]));
    }
    stockpot_lib::run()
}
