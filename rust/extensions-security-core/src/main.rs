use extensions_manager_rust_security_core::run;

fn main() {
    match run() {
        Ok(security) => {
            print!("{}", serde_json::to_string(&security).expect("failed to encode response"));
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
