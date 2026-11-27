//! ply-test-winhelper — see lib.rs. Usage (in the VM):
//!
//!   ply-test-winhelper serve [--root DIR]         line JSON on stdin/stdout
//!   ply-test-winhelper profile seed <dir> [name]  add a project to the test profile
//!   ply-test-winhelper profile reset              wipe the test profile
//!   ply-test-winhelper profile status             paths, running test apps
//!   ply-test-winhelper --version

use ply_test_winhelper::paths::Paths;
use ply_test_winhelper::serve::{self, Service};
use serde_json::json;
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match run(&args) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("ply-test-winhelper: {error}");
            2
        }
    };
    std::process::exit(code);
}

fn root_arg(args: &[String]) -> Option<PathBuf> {
    args.iter().position(|a| a == "--root").and_then(|i| args.get(i + 1)).map(PathBuf::from)
}

fn run(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("--version") | Some("-V") => {
            println!("ply-test-winhelper {}", ply_test_winhelper::VERSION);
            Ok(())
        }
        Some("serve") => serve_main(Paths::from_env(root_arg(args))?),
        Some("profile") => {
            let paths = Paths::from_env(None)?;
            let mut service = Service::new(paths);
            let (method, params) = match args.get(1).map(String::as_str) {
                Some("seed") => {
                    let dir = args.get(2).ok_or("usage: profile seed <dir> [name]")?;
                    ("profile.seed", json!({"dir": dir, "name": args.get(3)}))
                }
                Some("reset") => ("profile.reset", json!({})),
                Some("status") => ("status", json!({})),
                _ => return Err("usage: profile seed <dir> [name] | reset | status".into()),
            };
            let result = service.handle(method, &params)?;
            println!("{}", serde_json::to_string_pretty(&result).unwrap_or_default());
            Ok(())
        }
        _ => Err("usage: serve [--root DIR] | profile seed <dir> [name] | profile reset | profile status | --version".into()),
    }
}

#[cfg(windows)]
fn serve_main(paths: Paths) -> Result<(), String> {
    use std::sync::{Arc, Mutex};
    use std::time::Instant;
    use ply_test_winhelper::win;

    win::prepare_process();
    let run_dir = paths.run();
    win::replace_previous(&run_dir);
    let mut service = Service::new(paths);
    win::arm_emergency_chord(service.paths.stop_file(), service.hotkey_armed.clone());
    // Let the chord arm before the first request (its thread registers it).
    for _ in 0..20 {
        if service.hotkey_armed.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }

    let touch = Arc::new(Mutex::new(Instant::now()));
    {
        let touch = touch.clone();
        let run_dir = run_dir.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(10));
            if touch.lock().map(|t| t.elapsed() > serve::IDLE_LIMIT).unwrap_or(true) {
                win::forget_pid(&run_dir);
                std::process::exit(0);
            }
        });
    }
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let result = serve::serve_lines(&mut service, stdin.lock(), stdout.lock(), &touch);
    win::forget_pid(&run_dir);
    result.map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn serve_main(_paths: Paths) -> Result<(), String> {
    Err("serve runs only in the Windows VM".into())
}
