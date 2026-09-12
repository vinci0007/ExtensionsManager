mod canonicalize;
mod models;
mod policy;
mod revocation;
mod security_core;
mod signature;
mod trust;

use std::io::{self, Read};

pub use models::{
    CommandSecurityCoreRequest, ExtensionSecurityInfo, RevocationList, TrustBundle,
};
pub use security_core::evaluate_manifest;

pub fn run() -> Result<ExtensionSecurityInfo, String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("failed to read stdin: {error}"))?;

    run_with_input(&input)
}

pub fn run_with_input(input: &str) -> Result<ExtensionSecurityInfo, String> {
    let request = parse_request_json(input)?;
    evaluate_manifest(&request)
}

pub fn parse_request_json(input: &str) -> Result<CommandSecurityCoreRequest, String> {
    serde_json::from_str(input).map_err(|error| format!("invalid request JSON: {error}"))
}

pub fn evaluate_request_json(input: &str) -> Result<ExtensionSecurityInfo, String> {
    run_with_input(input)
}
