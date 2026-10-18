mod cli;
mod connect;
mod exec;
mod hardening;
mod platform;
mod policy;
mod proxy;
mod service_policy;

pub type SupervisorError = Box<dyn std::error::Error + Send + Sync>;
pub type SupervisorResult<T> = Result<T, SupervisorError>;

pub(crate) fn invalid_input(message: impl Into<String>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, message.into())
}

pub fn run() {
    let result = cli::Mode::parse().and_then(|mode| match mode {
        cli::Mode::Supervise(invocation) => {
            invocation.policy.validate()?;
            platform::run(invocation.policy, invocation.command)
        }
        cli::Mode::Connect(target) => connect::run(target),
    });
    if let Err(error) = result {
        eprintln!("happy-agent-supervisor: {error}");
        std::process::exit(125);
    }
}
