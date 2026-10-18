//! A framed TCP connection made from the caller's own network.
//!
//! `--connect <host> <port>` is not a sandbox. It applies no policy, creates no namespace, and
//! changes no privilege: it is an ordinary TCP client that runs wherever it was started, inside
//! whatever namespaces, Seatbelt profile, or seccomp filter its caller already had. A product that
//! needs a connection from inside a container starts it there with `docker exec`, which is why it
//! ships inside the binary that is already mounted read-only in every container Happy uses.
//!
//! Standard input and output carry frames: one type byte, a 32-bit big-endian length, and at most
//! [`MAX_FRAME_PAYLOAD`] bytes of payload. Framing lets a half-close travel in either direction
//! as a frame of its own, independently of the transport underneath. The transport ending is an
//! abort: whatever the remote end is doing, this process exits at once.

use std::fs::File;
use std::io::{ErrorKind, Read, Write};
use std::mem::ManuallyDrop;
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock, TryLockError};
use std::time::{Duration, Instant};

/// The largest payload one frame carries in either direction.
pub(crate) const MAX_FRAME_PAYLOAD: usize = 64 * 1024;
/// The payload of the first frame, written only once the TCP connection is established.
pub(crate) const READY_PAYLOAD: &[u8] = b"happy-agent-connect/1";
/// The longest host name accepted, matching DNS.
const MAX_CONNECT_HOST_BYTES: usize = 253;

/// The connection is established; its payload is [`READY_PAYLOAD`].
const FRAME_READY: u8 = b'R';
/// Bytes on the connection.
const FRAME_DATA: u8 = b'D';
/// The sender will send no more bytes: a TCP half-close.
const FRAME_FIN: u8 = b'F';
/// The connection failed; the payload is a Node-style error code, a space, and a message.
const FRAME_ERROR: u8 = b'X';

/// How long a failure report may wait for the output before the helper exits without it.
const FAILURE_REPORT_TIMEOUT: Duration = Duration::from_secs(1);
/// How often a failure report retries the output while another thread holds it.
const FAILURE_REPORT_INTERVAL: Duration = Duration::from_millis(10);
/// The largest failure report. Every POSIX pipe with room for a write takes this many bytes in one
/// piece (`PIPE_BUF` is at least 512), so the report is one write that never waits.
const MAX_REPORT_BYTES: usize = 512;

/// The connection failed or ended with an error the caller has been told about.
const STATUS_CONNECTION_FAILED: i32 = 1;
/// The caller broke the framing protocol.
const STATUS_PROTOCOL_VIOLATION: i32 = 125;

/// Where to connect, exactly as the caller named it.
pub(crate) struct ConnectTarget {
    pub(crate) host: String,
    pub(crate) port: u16,
}

impl ConnectTarget {
    pub(crate) fn parse(host: &str, port: &str) -> Result<Self, String> {
        if host.is_empty() || host.len() > MAX_CONNECT_HOST_BYTES {
            return Err(format!(
                "--connect needs a host of 1 to {MAX_CONNECT_HOST_BYTES} bytes"
            ));
        }
        if host.bytes().any(|byte| byte <= b' ' || byte == 0x7f) {
            return Err("--connect hosts cannot contain spaces or control characters".into());
        }
        // Only the canonical decimal spelling, so "+80" and "080" are refused rather than read.
        let port = match port.parse::<u16>() {
            Ok(parsed) if parsed != 0 && parsed.to_string() == port => parsed,
            _ => {
                return Err(format!(
                    "--connect needs a port from 1 to 65535, not {port}"
                ));
            }
        };
        Ok(Self {
            host: host.to_owned(),
            port,
        })
    }
}

/// Relays one TCP connection over standard input and output, and never returns.
pub(crate) fn run(target: ConnectTarget) -> ! {
    let output = Arc::new(FrameWriter::new());
    let socket_slot: Arc<OnceLock<TcpStream>> = Arc::new(OnceLock::new());
    let (local_fin_sender, local_fin) = mpsc::channel::<()>();

    // Standard input is watched before anything can block. Resolving a name or connecting can
    // take as long as the network decides, and the transport ending is how the caller cancels.
    {
        let output = Arc::clone(&output);
        let socket_slot = Arc::clone(&socket_slot);
        std::thread::spawn(move || relay_input(&output, &socket_slot, local_fin_sender));
    }

    let socket = match connect(&target) {
        Ok(socket) => socket,
        Err(failure) => output.fail(&failure),
    };
    let _ = socket.set_nodelay(true);
    // No write may wait on the remote end; see `send_watching_input`. `MSG_DONTWAIT` cannot
    // promise that: macOS honours it only while taking the send lock, then sleeps for room anyway.
    // A non-blocking socket is non-blocking on every system, and its clone shares the mode.
    if let Err(error) = socket.set_nonblocking(true) {
        output.fail(&ConnectFailure::from_io(&error));
    }
    let reader = match socket.try_clone() {
        Ok(reader) => reader,
        Err(error) => output.fail(&ConnectFailure::from_io(&error)),
    };
    // The socket is published before the caller can know it exists, so its first frame always
    // finds somewhere to go.
    let _ = socket_slot.set(socket);
    output.frame(FRAME_READY, READY_PAYLOAD);
    relay_output(&output, reader);

    // The remote end has finished sending. The caller may still be sending; wait for its own
    // half-close, or for the transport to end, which exits from the input thread.
    let _ = local_fin.recv();
    exit_now(0)
}

/// Copies the remote end's bytes to standard output until it half-closes.
///
/// The socket is non-blocking, so when nothing has arrived this waits for the remote end. Each
/// frame is written before the next read, so a caller that stops reading stops this reading too.
fn relay_output(output: &FrameWriter, mut reader: TcpStream) {
    let mut buffer = vec![0_u8; MAX_FRAME_PAYLOAD];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => {
                output.frame(FRAME_FIN, &[]);
                return;
            }
            Ok(count) => output.frame(FRAME_DATA, &buffer[..count]),
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                if let Err(error) = wait_readable(&reader) {
                    output.fail(&ConnectFailure::from_io(&error));
                }
            }
            Err(error) => output.fail(&ConnectFailure::from_io(&error)),
        }
    }
}

/// Waits until `socket` has bytes, its end, or an error to read.
fn wait_readable(socket: &TcpStream) -> std::io::Result<()> {
    let mut descriptor = libc::pollfd {
        fd: socket.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    if unsafe { libc::poll(&raw mut descriptor, 1, -1) } < 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() != ErrorKind::Interrupted {
            return Err(error);
        }
    }
    Ok(())
}

/// Reads the caller's frames and applies them to the connection.
///
/// Every way the transport can end — a clean end of input, a short frame, a read error — is an
/// abort and exits the process immediately, so a remote end that ignores a half-close can never
/// keep this process alive after its caller has gone.
fn relay_input(
    output: &FrameWriter,
    socket_slot: &OnceLock<TcpStream>,
    local_fin: mpsc::Sender<()>,
) {
    let mut input = ManuallyDrop::new(unsafe { File::from_raw_fd(0) });
    let mut header = [0_u8; 5];
    let mut payload = vec![0_u8; MAX_FRAME_PAYLOAD];
    let mut finished = false;
    loop {
        if input.read_exact(&mut header).is_err() {
            exit_now(0);
        }
        let kind = header[0];
        let length = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
        let Some(socket) = socket_slot.get() else {
            violation("the caller sent a frame before the connection was ready");
        };
        if finished {
            violation("the caller sent a frame after its half-close");
        }
        match kind {
            FRAME_DATA if (1..=MAX_FRAME_PAYLOAD).contains(&length) => {
                if input.read_exact(&mut payload[..length]).is_err() {
                    exit_now(0);
                }
                if let Err(error) = send_watching_input(socket, &payload[..length]) {
                    output.fail(&ConnectFailure::from_io(&error));
                }
            }
            FRAME_FIN if length == 0 => {
                if let Err(error) = socket.shutdown(Shutdown::Write)
                    && error.kind() != ErrorKind::NotConnected
                {
                    output.fail(&ConnectFailure::from_io(&error));
                }
                finished = true;
                let _ = local_fin.send(());
            }
            _ => violation("the caller sent a malformed frame"),
        }
    }
}

/// Writes to the connection without ever losing sight of standard input.
///
/// A remote end that stops reading fills the socket's buffer, and a blocking write would then wait
/// for as long as the remote decides — while the end of standard input, the caller's abort, went
/// unread behind it. The socket is therefore non-blocking, and waiting for room also waits for
/// standard input to hang up, which aborts at once.
fn send_watching_input(mut socket: &TcpStream, mut bytes: &[u8]) -> std::io::Result<()> {
    while !bytes.is_empty() {
        match socket.write(bytes) {
            Ok(0) => return Err(ErrorKind::WriteZero.into()),
            Ok(sent) => bytes = &bytes[sent..],
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                if let Waited::InputHungUp =
                    wait_for_room_or_hangup(Some(socket.as_raw_fd()), None)?
                {
                    exit_now(0);
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// What waiting for room to write saw first.
enum Waited {
    /// The descriptor has room, or has failed in a way the next write reports.
    Room,
    /// Standard input hung up: the caller has gone.
    InputHungUp,
    /// Neither, within the time allowed.
    Nothing,
}

/// Waits for room to write on `descriptor`, when one is given, for standard input to hang up, or
/// for `timeout` to pass.
///
/// Frames already waiting on standard input do not end the wait. They are the input side's to read,
/// and the input side may be the one waiting here, so waking for them would only spin. Their being
/// there must not hide the hang-up either: the caller's abort usually arrives right behind them.
#[cfg(target_os = "linux")]
fn wait_for_room_or_hangup(
    descriptor: Option<RawFd>,
    timeout: Option<Duration>,
) -> std::io::Result<Waited> {
    // Hang-up and errors are always reported, whatever was asked for, and `POLLRDHUP` adds a
    // socket peer's half-close. Readable input is not asked for.
    let mut descriptors = [
        libc::pollfd {
            fd: descriptor.unwrap_or(-1),
            events: libc::POLLOUT,
            revents: 0,
        },
        libc::pollfd {
            fd: 0,
            events: libc::POLLRDHUP,
            revents: 0,
        },
    ];
    let timeout = timeout.map_or(-1, |timeout| {
        libc::c_int::try_from(timeout.as_millis()).unwrap_or(libc::c_int::MAX)
    });
    if unsafe { libc::poll(descriptors.as_mut_ptr(), 2, timeout) } < 0 {
        let error = std::io::Error::last_os_error();
        return match error.kind() {
            ErrorKind::Interrupted => Ok(Waited::Nothing),
            _ => Err(error),
        };
    }
    let hangup = libc::POLLHUP | libc::POLLERR | libc::POLLNVAL | libc::POLLRDHUP;
    Ok(if descriptors[1].revents & hangup != 0 {
        Waited::InputHungUp
    } else if descriptors[0].revents & libc::POLLOUT != 0 {
        Waited::Room
    } else {
        Waited::Nothing
    })
}

/// Waits for room to write on `descriptor`, when one is given, for standard input to hang up, or
/// for `timeout` to pass.
///
/// Frames already waiting on standard input do not end the wait. They are the input side's to read,
/// and the input side may be the one waiting here, so waking for them would only spin. Their being
/// there must not hide the hang-up either: the caller's abort usually arrives right behind them.
///
/// macOS `poll` reports hang-up only on a descriptor it was asked to watch for input, and then
/// wakes for every byte waiting too. A kqueue read filter that clears once delivered wakes for new
/// input at most once per arrival, and reports the writer's close as `EV_EOF` whether or not
/// frames are still waiting unread, for pipes and sockets alike.
#[cfg(target_os = "macos")]
fn wait_for_room_or_hangup(
    descriptor: Option<RawFd>,
    timeout: Option<Duration>,
) -> std::io::Result<Waited> {
    use std::os::fd::OwnedFd;

    let queue = unsafe { libc::kqueue() };
    if queue < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let queue = unsafe { OwnedFd::from_raw_fd(queue) };
    let filter = |descriptor: RawFd, filter: i16, flags: u16| libc::kevent {
        ident: descriptor as libc::uintptr_t,
        filter,
        flags,
        fflags: 0,
        data: 0,
        udata: std::ptr::null_mut(),
    };
    let mut changes = vec![filter(0, libc::EVFILT_READ, libc::EV_ADD | libc::EV_CLEAR)];
    if let Some(descriptor) = descriptor {
        changes.push(filter(descriptor, libc::EVFILT_WRITE, libc::EV_ADD));
    }
    let deadline = timeout.map(|timeout| Instant::now() + timeout);
    loop {
        let remaining = deadline.map(|deadline| {
            let remaining = deadline.saturating_duration_since(Instant::now());
            libc::timespec {
                tv_sec: remaining.as_secs() as libc::time_t,
                tv_nsec: remaining.subsec_nanos() as libc::c_long,
            }
        });
        let mut events = [filter(0, 0, 0); 2];
        let count = unsafe {
            libc::kevent(
                queue.as_raw_fd(),
                changes.as_ptr(),
                changes.len() as libc::c_int,
                events.as_mut_ptr(),
                events.len() as libc::c_int,
                remaining
                    .as_ref()
                    .map_or(std::ptr::null(), std::ptr::from_ref),
            )
        };
        if count < 0 {
            let error = std::io::Error::last_os_error();
            return match error.kind() {
                ErrorKind::Interrupted => Ok(Waited::Nothing),
                _ => Err(error),
            };
        }
        if count == 0 {
            return Ok(Waited::Nothing);
        }
        changes.clear();
        let events = &events[..count as usize];
        // A filter that could not be added at all is reported as `EV_ERROR`; on standard input
        // that is as final as `POLLNVAL`, and on the output the next write reports it.
        if events.iter().any(|event| {
            event.filter == libc::EVFILT_READ && event.flags & (libc::EV_EOF | libc::EV_ERROR) != 0
        }) {
            return Ok(Waited::InputHungUp);
        }
        if events
            .iter()
            .any(|event| event.filter == libc::EVFILT_WRITE)
        {
            return Ok(Waited::Room);
        }
        // Only new frames arrived on standard input. They wait for the input side.
    }
}

fn connect(target: &ConnectTarget) -> Result<TcpStream, ConnectFailure> {
    let addresses = (target.host.as_str(), target.port)
        .to_socket_addrs()
        .map_err(|error| ConnectFailure {
            code: "ENOTFOUND",
            message: format!("could not resolve {}: {error}", target.host),
        })?;
    let mut last = None;
    for address in addresses {
        match TcpStream::connect(address) {
            Ok(socket) => return Ok(socket),
            Err(error) => last = Some(error),
        }
    }
    Err(match last {
        Some(error) => ConnectFailure::from_io(&error),
        None => ConnectFailure {
            code: "ENOTFOUND",
            message: format!("{} has no addresses", target.host),
        },
    })
}

/// Why a connection failed, as a Node-style code and a readable message.
struct ConnectFailure {
    code: &'static str,
    message: String,
}

impl ConnectFailure {
    fn from_io(error: &std::io::Error) -> Self {
        Self {
            code: error.raw_os_error().map_or("EIO", errno_code),
            message: error.to_string(),
        }
    }
}

fn errno_code(errno: i32) -> &'static str {
    match errno {
        libc::ECONNREFUSED => "ECONNREFUSED",
        libc::ECONNRESET => "ECONNRESET",
        libc::ECONNABORTED => "ECONNABORTED",
        libc::ETIMEDOUT => "ETIMEDOUT",
        libc::EHOSTUNREACH => "EHOSTUNREACH",
        libc::ENETUNREACH => "ENETUNREACH",
        libc::ENETDOWN => "ENETDOWN",
        libc::EADDRNOTAVAIL => "EADDRNOTAVAIL",
        libc::EAFNOSUPPORT => "EAFNOSUPPORT",
        libc::EACCES => "EACCES",
        libc::EPERM => "EPERM",
        libc::EPIPE => "EPIPE",
        _ => "EIO",
    }
}

/// Standard output, shared by both directions so frames never interleave.
struct FrameWriter {
    output: Mutex<ManuallyDrop<File>>,
}

impl FrameWriter {
    fn new() -> Self {
        Self {
            output: Mutex::new(ManuallyDrop::new(unsafe { File::from_raw_fd(1) })),
        }
    }

    /// Writes one frame, or exits when the caller can no longer read: nobody is left to tell.
    fn frame(&self, kind: u8, payload: &[u8]) {
        let mut output = match self.output.lock() {
            Ok(output) => output,
            Err(poisoned) => poisoned.into_inner(),
        };
        if write_frame(&mut **output, kind, payload).is_err() {
            exit_now(0);
        }
    }

    /// Reports a failure and exits, holding the output so nothing follows the error frame.
    ///
    /// Nothing here waits without bound. The other direction may hold the output while it is stuck
    /// writing to a caller that stopped reading, the output may be full with nobody holding it, and
    /// the thread failing may be the one that watches for the caller's abort. So the lock is only
    /// tried, the report is one small write made only when there is room for it, and every wait
    /// also watches standard input. A caller that sees the stream end without a half-close or a
    /// report treats that as a failure too.
    fn fail(&self, failure: &ConnectFailure) -> ! {
        let deadline = Instant::now() + FAILURE_REPORT_TIMEOUT;
        let _output = loop {
            match self.output.try_lock() {
                Ok(output) => break output,
                Err(TryLockError::Poisoned(poisoned)) => break poisoned.into_inner(),
                Err(TryLockError::WouldBlock) => {
                    if Instant::now() >= deadline {
                        exit_now(STATUS_CONNECTION_FAILED);
                    }
                    wait_for_room(None, FAILURE_REPORT_INTERVAL, STATUS_CONNECTION_FAILED);
                }
            }
        };
        let mut report = format!("{} {}", failure.code, failure.message);
        truncate_text(&mut report, MAX_REPORT_BYTES - 5);
        let mut frame = Vec::with_capacity(MAX_REPORT_BYTES);
        let _ = write_frame(&mut frame, FRAME_ERROR, report.as_bytes());
        report_and_exit(1, &frame, deadline, STATUS_CONNECTION_FAILED)
    }
}

pub(crate) fn write_frame(
    output: &mut impl Write,
    kind: u8,
    payload: &[u8],
) -> std::io::Result<()> {
    let length = u32::try_from(payload.len())
        .map_err(|_| std::io::Error::new(ErrorKind::InvalidInput, "frame too large"))?;
    let mut frame = Vec::with_capacity(5 + payload.len());
    frame.push(kind);
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(payload);
    output.write_all(&frame)
}

fn violation(message: &str) -> ! {
    let mut report = format!("happy-agent-supervisor: {message}\n");
    truncate_text(&mut report, MAX_REPORT_BYTES);
    report_and_exit(
        2,
        report.as_bytes(),
        Instant::now() + FAILURE_REPORT_TIMEOUT,
        STATUS_PROTOCOL_VIOLATION,
    )
}

/// Writes one small report when `descriptor` has room before `deadline`, then exits either way.
fn report_and_exit(descriptor: RawFd, report: &[u8], deadline: Instant, status: i32) -> ! {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if wait_for_room(Some(descriptor), remaining, status) {
        unsafe {
            libc::write(descriptor, report.as_ptr().cast(), report.len());
        }
    }
    exit_now(status)
}

/// Waits up to `timeout` for room to write on `descriptor`, when one is given. The end of standard
/// input exits at once with `status`: an abort needs no report.
fn wait_for_room(descriptor: Option<RawFd>, timeout: Duration, status: i32) -> bool {
    match wait_for_room_or_hangup(descriptor, Some(timeout)) {
        Ok(Waited::Room) => true,
        Ok(Waited::InputHungUp) => exit_now(status),
        Ok(Waited::Nothing) | Err(_) => false,
    }
}

fn truncate_text(text: &mut String, limit: usize) {
    if text.len() <= limit {
        return;
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
}

/// Exits without running anything else: another thread may be blocked holding standard output,
/// and flushing it on the way out could wait forever.
fn exit_now(status: i32) -> ! {
    unsafe { libc::_exit(status) }
}

#[cfg(test)]
mod tests {
    use super::{ConnectTarget, write_frame};

    #[test]
    fn targets_are_taken_as_written() {
        let target = ConnectTarget::parse("::1", "8080").unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(target.host, "::1");
        assert_eq!(target.port, 8080);
        let alias = ConnectTarget::parse("web.internal", "443").unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(alias.host, "web.internal");
    }

    #[test]
    fn malformed_targets_are_refused() {
        for (host, port) in [
            ("", "80"),
            ("example.com", "0"),
            ("example.com", "65536"),
            ("example.com", "+80"),
            ("example.com", "080"),
            ("example.com", " 80"),
            ("bad host", "80"),
            ("bad\nhost", "80"),
        ] {
            assert!(
                ConnectTarget::parse(host, port).is_err(),
                "{host:?}:{port:?}"
            );
        }
        assert!(ConnectTarget::parse(&"a".repeat(254), "80").is_err());
    }

    #[test]
    fn frames_carry_a_type_and_a_big_endian_length() {
        let mut written = Vec::new();
        write_frame(&mut written, b'D', b"abc").unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(written, [b'D', 0, 0, 0, 3, b'a', b'b', b'c']);
    }
}
