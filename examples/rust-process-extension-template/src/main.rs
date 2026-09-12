use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = line.expect("failed to read stdin");
        let request: Value = serde_json::from_str(&line).expect("invalid json");
        let method = request["method"].as_str().unwrap_or("");
        let id = request["id"].clone();

        let response = match method {
            "extension/activate" => json!({ "jsonrpc": "2.0", "id": id, "result": true }),
            "extension/deactivate" => {
                let response = json!({ "jsonrpc": "2.0", "id": id, "result": true });
                writeln!(stdout, "{}", response).unwrap();
                stdout.flush().unwrap();
                break;
            }
            "extension/invoke" => {
                let capability = request["params"]["capability"].as_str().unwrap_or("");
                if capability == "demo.hello" {
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": { "message": "hello from rust process extension" }
                    })
                } else {
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32601, "message": format!("Unknown capability: {}", capability) }
                    })
                }
            }
            _ => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("Unknown method: {}", method) }
            }),
        };

        writeln!(stdout, "{}", response).unwrap();
        stdout.flush().unwrap();
    }
}
