use crate::connect::ConnectTarget;
use crate::policy::SupervisorPolicy;
use crate::{SupervisorResult, invalid_input};
use std::ffi::OsString;
use std::fs::File;
use std::io::{Read, Take};
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;

const MAX_POLICY_BYTES: u64 = 1024 * 1024;

/// What one run of the binary was asked to do.
pub(crate) enum Mode {
    /// Establish the sandbox described by a policy and execute a command inside it.
    Supervise(Box<Invocation>),
    /// Relay one TCP connection from the caller's own network; see `connect.rs`.
    Connect(ConnectTarget),
}

impl Mode {
    pub(crate) fn parse() -> SupervisorResult<Self> {
        let arguments: Vec<OsString> = std::env::args_os().skip(1).collect();
        if arguments
            .first()
            .is_some_and(|argument| argument == "--connect")
        {
            return parse_connect(&arguments[1..]).map(Mode::Connect);
        }
        Invocation::parse(arguments).map(|invocation| Mode::Supervise(Box::new(invocation)))
    }
}

/// `--connect <host> <port>` stands alone: it takes no policy and no command, so nothing about a
/// sandbox can be mistaken for applying to it.
fn parse_connect(arguments: &[OsString]) -> SupervisorResult<ConnectTarget> {
    let [host, port] = arguments else {
        return Err(invalid_input("--connect takes exactly a host and a port").into());
    };
    let host = host
        .to_str()
        .ok_or_else(|| invalid_input("--connect hosts must be valid UTF-8"))?;
    let port = port
        .to_str()
        .ok_or_else(|| invalid_input("--connect ports must be valid UTF-8"))?;
    ConnectTarget::parse(host, port).map_err(|message| invalid_input(message).into())
}

pub(crate) struct Invocation {
    pub(crate) policy: SupervisorPolicy,
    pub(crate) command: Vec<OsString>,
}

enum PolicySource {
    Argument(OsString),
    File(PathBuf),
}

impl Invocation {
    fn parse(arguments: Vec<OsString>) -> SupervisorResult<Self> {
        let mut arguments = arguments.into_iter();
        let mut policy_source = None;
        let mut command = Vec::new();

        while let Some(argument) = arguments.next() {
            if argument == "--" {
                command.extend(arguments);
                break;
            }
            if argument == "--policy" {
                let policy = arguments
                    .next()
                    .ok_or_else(|| invalid_input("--policy requires policy JSON"))?;
                set_policy_source(&mut policy_source, PolicySource::Argument(policy))?;
                continue;
            }
            if argument == "--policy-file" {
                let path = arguments
                    .next()
                    .ok_or_else(|| invalid_input("--policy-file requires a path"))?;
                set_policy_source(&mut policy_source, PolicySource::File(PathBuf::from(path)))?;
                continue;
            }
            return Err(invalid_input(format!(
                "unknown supervisor argument before --: {}",
                argument.to_string_lossy()
            ))
            .into());
        }

        if command.is_empty() {
            return Err(invalid_input("a target command is required after --").into());
        }
        let source = policy_source
            .ok_or_else(|| invalid_input("exactly one of --policy or --policy-file is required"))?;
        let policy = read_policy(source)?;
        Ok(Self { policy, command })
    }
}

fn set_policy_source(
    current: &mut Option<PolicySource>,
    source: PolicySource,
) -> SupervisorResult<()> {
    if current.is_some() {
        return Err(invalid_input("policy transport may be specified only once").into());
    }
    *current = Some(source);
    Ok(())
}

fn read_policy(source: PolicySource) -> SupervisorResult<SupervisorPolicy> {
    match source {
        PolicySource::Argument(argument) => {
            let json = argument
                .into_string()
                .map_err(|_| invalid_input("policy JSON must be valid UTF-8"))?;
            if json.len() as u64 > MAX_POLICY_BYTES {
                return Err(invalid_input("policy JSON exceeds the 1 MiB limit").into());
            }
            let policy: SupervisorPolicy = serde_json::from_str(&json)?;
            if policy.service.is_some() {
                return Err(invalid_input("service bridge credentials require a private --policy-file, not process arguments").into());
            }
            Ok(policy)
        }
        PolicySource::File(path) => {
            let file = File::open(path)?;
            let metadata = file.metadata()?;
            let mut bytes = Vec::new();
            let mut limited: Take<File> = file.take(MAX_POLICY_BYTES + 1);
            limited.read_to_end(&mut bytes)?;
            if bytes.len() as u64 > MAX_POLICY_BYTES {
                return Err(invalid_input("policy JSON exceeds the 1 MiB limit").into());
            }
            let policy: SupervisorPolicy = serde_json::from_slice(&bytes)?;
            if policy.service.is_some()
                && (!metadata.is_file()
                    || metadata.mode() & 0o077 != 0
                    || metadata.uid() != unsafe { libc::geteuid() })
            {
                return Err(invalid_input(
                    "service policy files must be private and owned by the controller user",
                )
                .into());
            }
            Ok(policy)
        }
    }
}
