use ply_mcp::{parse_launch_args, serve, PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION};
use std::io::{self, BufReader};

const USAGE: &str = "\
Usage: ply-mcp --config-dir <absolute-path> \
[--workspace-id <id>] [--project-cwd <absolute-path>]";

struct StderrLogger;

impl log::Log for StderrLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Warn
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            eprintln!("ply-mcp: {}", record.args());
        }
    }

    fn flush(&self) {}
}

static STDERR_LOGGER: StderrLogger = StderrLogger;

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments == ["--version"] || arguments == ["-V"] {
        println!("{SERVER_NAME} {SERVER_VERSION} protocol {PROTOCOL_VERSION}");
        return;
    }
    if arguments.iter().any(|argument| argument == "--help") {
        println!("{USAGE}");
        return;
    }
    let config = match parse_launch_args(arguments) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("ply-mcp: {error}\n{USAGE}");
            std::process::exit(2);
        }
    };
    let context = match config.server_context() {
        Ok(context) => context,
        Err(error) => {
            eprintln!("ply-mcp: {error}");
            std::process::exit(2);
        }
    };

    let _ = log::set_logger(&STDERR_LOGGER).map(|()| log::set_max_level(log::LevelFilter::Warn));
    let stdin = io::stdin();
    let stdout = io::stdout();
    if let Err(error) = serve(BufReader::new(stdin.lock()), stdout.lock(), &context) {
        eprintln!("ply-mcp: {error}");
        std::process::exit(1);
    }
}
