use ply_test_mcp::server::{Config, Server};
use ply_test_mcp::{serve, SERVER_NAME, SERVER_VERSION};
use std::io::{self, BufReader};

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.iter().any(|a| a == "--version" || a == "-V") {
        println!("{SERVER_NAME} {SERVER_VERSION}");
        return;
    }
    if !cfg!(target_os = "macos") {
        eprintln!("{SERVER_NAME}: macOS only");
        std::process::exit(2);
    }
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{SERVER_NAME}: {error}");
            std::process::exit(2);
        }
    };
    let mut server = Server::new(config);
    let stdin = io::stdin();
    let stdout = io::stdout();
    if let Err(error) = serve(BufReader::new(stdin.lock()), stdout.lock(), &mut server) {
        eprintln!("{SERVER_NAME}: {error}");
        std::process::exit(1);
    }
}
