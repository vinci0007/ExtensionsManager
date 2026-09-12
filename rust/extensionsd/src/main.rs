use extensions_kernel::KernelDaemon;
use std::io::{self, BufRead, Write};
use std::sync::{Arc, Mutex};
use std::thread;

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();

    // Response sink: async dispatch workers deliver their envelopes through
    // this channel; a dedicated writer thread serializes them onto stdout.
    let (sink_tx, sink_rx) = std::sync::mpsc::channel::<String>();
    {
        let stdout = io::stdout();
        thread::spawn(move || {
            for envelope in sink_rx {
                let mut handle = stdout.lock();
                if writeln!(handle, "{envelope}").is_err() {
                    eprintln!("failed to write kernel output");
                    std::process::exit(1);
                }
                if handle.flush().is_err() {
                    eprintln!("failed to flush kernel output");
                    std::process::exit(1);
                }
            }
        });
    }

    let mut daemon = KernelDaemon::new();
    daemon.set_response_sink(Arc::new(Mutex::new(sink_tx)));

    for line in stdin.lock().lines() {
        match line {
            Ok(line) => match daemon.handle_request_line(&line) {
                Ok(outputs) => {
                    let mut handle = stdout.lock();
                    for output in outputs {
                        if writeln!(handle, "{output}").is_err() {
                            eprintln!("failed to write kernel output");
                            std::process::exit(1);
                        }
                    }
                    if handle.flush().is_err() {
                        eprintln!("failed to flush kernel output");
                        std::process::exit(1);
                    }
                }
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            },
            Err(error) => {
                eprintln!("failed to read kernel input: {error}");
                std::process::exit(1);
            }
        }
    }
}
