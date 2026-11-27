// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    // A card chat's PDF text extraction runs in this binary as a child
    // (`chat_extract`): before anything of the app starts.
    if let Some(code) = atelier_lib::chat_extract_dispatch(&args) {
        std::process::exit(code);
    }
    if let Some(result) = atelier_lib::inbox_eligibility_dispatch(&args) {
        match result {
            Ok(json) => println!("{json}"),
            Err(_) => {
                eprintln!("condition=inbox_eligibility_proof_failed");
                std::process::exit(1);
            }
        }
        return;
    }
    atelier_lib::run()
}
