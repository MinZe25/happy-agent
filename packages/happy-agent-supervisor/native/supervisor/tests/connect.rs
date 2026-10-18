use serde_json::json;
use std::io::{ErrorKind, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const SUPERVISOR: &str = env!("CARGO_BIN_EXE_happy-agent-supervisor");
const READY: &[u8] = b"happy-agent-connect/1";
const MAX_PAYLOAD: usize = 64 * 1024;

struct Helper {
    child: Child,
    input: Option<ChildStdin>,
    output: ChildStdout,
}

impl Helper {
    fn connect(host: &str, port: u16) -> Self {
        Self::spawn(&["--connect", host, &port.to_string()])
    }

    fn spawn(arguments: &[&str]) -> Self {
        let mut child = Command::new(SUPERVISOR)
            .args(arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap_or_else(|error| panic!("start the connect helper: {error}"));
        let input = child.stdin.take();
        let output = child
            .stdout
            .take()
            .unwrap_or_else(|| panic!("the helper has no standard output"));
        Self {
            child,
            input,
            output,
        }
    }

    fn send(&mut self, kind: u8, payload: &[u8]) {
        self.try_send(kind, payload)
            .unwrap_or_else(|error| panic!("send a frame: {error}"));
    }

    /// Sends a frame the helper may refuse before reading all of it.
    fn try_send(&mut self, kind: u8, payload: &[u8]) -> std::io::Result<()> {
        let input = self
            .input
            .as_mut()
            .unwrap_or_else(|| panic!("the transport is already closed"));
        let mut frame = vec![kind];
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(payload);
        input.write_all(&frame)
    }

    fn send_data(&mut self, bytes: &[u8]) {
        for chunk in bytes.chunks(MAX_PAYLOAD) {
            self.send(b'D', chunk);
        }
    }

    fn receive(&mut self) -> (u8, Vec<u8>) {
        let mut header = [0_u8; 5];
        self.output
            .read_exact(&mut header)
            .unwrap_or_else(|error| panic!("receive a frame header: {error}"));
        let length = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
        assert!(length <= MAX_PAYLOAD, "frame of {length} bytes");
        let mut payload = vec![0_u8; length];
        self.output
            .read_exact(&mut payload)
            .unwrap_or_else(|error| panic!("receive a frame payload: {error}"));
        (header[0], payload)
    }

    fn expect_ready(&mut self) {
        let (kind, payload) = self.receive();
        assert_eq!(
            (kind, payload.as_slice()),
            (b'R', READY),
            "expected READY, got {}",
            String::from_utf8_lossy(&payload)
        );
    }

    /// Reads data frames until the remote half-close.
    fn receive_until_fin(&mut self) -> Vec<u8> {
        let mut received = Vec::new();
        loop {
            match self.receive() {
                (b'D', payload) => {
                    assert!(!payload.is_empty());
                    received.extend_from_slice(&payload);
                }
                (b'F', payload) => {
                    assert!(payload.is_empty());
                    return received;
                }
                (kind, payload) => panic!(
                    "unexpected frame {} {}",
                    kind as char,
                    String::from_utf8_lossy(&payload)
                ),
            }
        }
    }

    fn close_transport(&mut self) {
        self.input = None;
    }

    fn wait(&mut self, within: Duration) -> ExitStatus {
        let deadline = Instant::now() + within;
        loop {
            if let Some(status) = self
                .child
                .try_wait()
                .unwrap_or_else(|error| panic!("wait for the helper: {error}"))
            {
                return status;
            }
            if Instant::now() > deadline {
                describe_stuck_helper(self.child.id());
                let _ = self.child.kill();
                panic!("the helper was still running after {within:?}");
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn assert_running(&mut self) {
        let status = self
            .child
            .try_wait()
            .unwrap_or_else(|error| panic!("poll the helper: {error}"));
        assert!(status.is_none(), "the helper exited early: {status:?}");
    }

    fn stderr(&mut self) -> String {
        let mut stderr = String::new();
        if let Some(mut pipe) = self.child.stderr.take() {
            let _ = pipe.read_to_string(&mut stderr);
        }
        stderr
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Prints where each thread of a helper that should have exited is waiting, and what its sockets
/// hold, so a failure on a kernel only CI runs explains itself.
#[cfg(target_os = "macos")]
fn describe_stuck_helper(pid: u32) {
    let pid = pid.to_string();
    let report = std::env::temp_dir().join(format!("happy-agent-connect-{pid}.sample.txt"));
    match Command::new("/usr/bin/sample")
        .args([pid.as_str(), "1", "-mayDie", "-file"])
        .arg(&report)
        .output()
    {
        Ok(output) => eprintln!(
            "sample: {}\n{}{}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ),
        Err(error) => eprintln!("sample could not run: {error}"),
    }
    match std::fs::read_to_string(&report) {
        Ok(stacks) => eprintln!("{stacks}"),
        Err(error) => eprintln!("no sample report: {error}"),
    }
    let _ = std::fs::remove_file(&report);
    print_command("/usr/sbin/lsof", &["-nP", "-p", &pid]);
    print_command("/usr/sbin/netstat", &["-anv", "-p", "tcp"]);
}

/// Prints the system call and kernel wait of each thread of a helper that should have exited.
#[cfg(target_os = "linux")]
fn describe_stuck_helper(pid: u32) {
    let Ok(tasks) = std::fs::read_dir(format!("/proc/{pid}/task")) else {
        return;
    };
    for task in tasks.flatten() {
        let read = |name: &str| {
            std::fs::read_to_string(task.path().join(name))
                .map(|text| text.trim().to_owned())
                .unwrap_or_else(|error| format!("({error})"))
        };
        eprintln!(
            "thread {:?}: wchan {}, syscall {}",
            task.file_name(),
            read("wchan"),
            read("syscall")
        );
    }
}

#[cfg(target_os = "macos")]
fn print_command(program: &str, arguments: &[&str]) {
    match Command::new(program).args(arguments).output() {
        Ok(output) => eprintln!(
            "{program} {}: {}\n{}{}",
            arguments.join(" "),
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ),
        Err(error) => eprintln!("{program} could not run: {error}"),
    }
}

fn listener() -> (TcpListener, u16) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .unwrap_or_else(|error| panic!("bind a loopback listener: {error}"));
    let port = listener
        .local_addr()
        .unwrap_or_else(|error| panic!("listener address: {error}"))
        .port();
    (listener, port)
}

fn binary_body(length: usize, seed: u32) -> Vec<u8> {
    let mut state = seed;
    (0..length)
        .map(|_| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (state >> 24) as u8
        })
        .collect()
}

fn read_to_end(socket: &mut TcpStream) -> Vec<u8> {
    let mut received = Vec::new();
    socket
        .read_to_end(&mut received)
        .unwrap_or_else(|error| panic!("read until the half-close: {error}"));
    received
}

#[test]
fn the_caller_half_closes_first_and_still_receives_the_whole_reply() {
    let (listener, port) = listener();
    let request = binary_body(1024 * 1024 + 17, 1);
    let reply = binary_body(3 * 1024 * 1024 + 5, 2);
    let expected_reply = reply.clone();
    let server = thread::spawn(move || {
        let (mut socket, _) = listener
            .accept()
            .unwrap_or_else(|error| panic!("accept: {error}"));
        let received = read_to_end(&mut socket);
        socket
            .write_all(&reply)
            .unwrap_or_else(|error| panic!("reply: {error}"));
        socket
            .shutdown(Shutdown::Write)
            .unwrap_or_else(|error| panic!("half-close: {error}"));
        received
    });

    let mut helper = Helper::connect("127.0.0.1", port);
    helper.expect_ready();
    helper.send_data(&request);
    helper.send(b'F', &[]);
    let received = helper.receive_until_fin();

    assert_eq!(received, expected_reply);
    assert_eq!(server.join().unwrap_or_else(|_| panic!("server")), request);
    assert_eq!(helper.wait(Duration::from_secs(5)).code(), Some(0));
}

#[test]
fn the_remote_half_closes_first_and_the_caller_keeps_sending() {
    let (listener, port) = listener();
    let request = binary_body(2 * 1024 * 1024 + 3, 3);
    let server = thread::spawn(move || {
        let (mut socket, _) = listener
            .accept()
            .unwrap_or_else(|error| panic!("accept: {error}"));
        socket
            .write_all(b"greeting")
            .unwrap_or_else(|error| panic!("greet: {error}"));
        socket
            .shutdown(Shutdown::Write)
            .unwrap_or_else(|error| panic!("half-close: {error}"));
        read_to_end(&mut socket)
    });

    let mut helper = Helper::connect("localhost", port);
    helper.expect_ready();
    assert_eq!(helper.receive_until_fin(), b"greeting");
    helper.assert_running();
    helper.send_data(&request);
    helper.send(b'F', &[]);

    assert_eq!(server.join().unwrap_or_else(|_| panic!("server")), request);
    assert_eq!(helper.wait(Duration::from_secs(5)).code(), Some(0));
}

#[test]
fn ending_the_transport_aborts_when_the_remote_ignores_the_half_close() {
    let (listener, port) = listener();
    let (accepted, held) = mpsc::channel();
    thread::spawn(move || {
        let (socket, _) = listener
            .accept()
            .unwrap_or_else(|error| panic!("accept: {error}"));
        // Hold the connection open and never read or close it.
        let _ = accepted.send(socket);
        thread::sleep(Duration::from_secs(30));
    });

    let mut helper = Helper::connect("127.0.0.1", port);
    helper.expect_ready();
    helper.send_data(b"unanswered");
    helper.send(b'F', &[]);
    let mut socket = held
        .recv_timeout(Duration::from_secs(5))
        .unwrap_or_else(|error| panic!("the server never accepted: {error}"));
    thread::sleep(Duration::from_millis(100));
    helper.assert_running();
    helper.close_transport();

    assert!(helper.wait(Duration::from_secs(5)).success());
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap_or_else(|error| panic!("read timeout: {error}"));
    // The helper's exit closes the remote's connection: it reads what was sent and then the end.
    let mut received = Vec::new();
    match socket.read_to_end(&mut received) {
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::ConnectionReset => {}
        Err(error) => panic!("the connection stayed open after the helper exited: {error}"),
    }
}

#[test]
fn ending_the_transport_aborts_while_the_remote_refuses_to_read() {
    use std::os::fd::AsRawFd;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    let (listener, port) = listener();
    let (accepted, held) = mpsc::channel();
    thread::spawn(move || {
        let (socket, _) = listener
            .accept()
            .unwrap_or_else(|error| panic!("accept: {error}"));
        // Never read, so the helper's writes eventually find no room at all.
        let _ = accepted.send(socket);
        thread::sleep(Duration::from_secs(60));
    });

    let mut helper = Helper::connect("127.0.0.1", port);
    helper.expect_ready();
    let _socket = held
        .recv_timeout(Duration::from_secs(5))
        .unwrap_or_else(|error| panic!("the server never accepted: {error}"));
    let input = helper
        .input
        .take()
        .unwrap_or_else(|| panic!("the transport is already closed"));
    let descriptor = input.as_raw_fd();
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
    assert!(flags >= 0);
    assert_eq!(
        unsafe { libc::fcntl(descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) },
        0
    );

    // Feed frames until the helper has stopped draining its input for a sustained period, which
    // it only does while it waits for room on the connection. Then close the transport.
    let stop = Arc::new(AtomicBool::new(false));
    let (stalled, stall) = mpsc::channel();
    let writer = {
        let stop = Arc::clone(&stop);
        thread::spawn(move || {
            let mut input = input;
            let mut frame = vec![b'D'];
            frame.extend_from_slice(&(MAX_PAYLOAD as u32).to_be_bytes());
            frame.extend_from_slice(&binary_body(MAX_PAYLOAD, 4));
            let mut written = 0_usize;
            let mut position = 0_usize;
            let mut blocked_since: Option<Instant> = None;
            let mut reported = false;
            while !stop.load(Ordering::SeqCst) {
                match input.write(&frame[position..]) {
                    Ok(count) => {
                        blocked_since = None;
                        written += count;
                        position = (position + count) % frame.len();
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        let since = *blocked_since.get_or_insert_with(Instant::now);
                        if !reported && since.elapsed() > Duration::from_millis(500) {
                            reported = true;
                            let _ = stalled.send(written);
                        }
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("feed the helper: {error}"),
                }
            }
            drop(input);
        })
    };
    let written = stall
        .recv_timeout(Duration::from_secs(60))
        .unwrap_or_else(|error| panic!("the helper never stopped draining its input: {error}"));
    assert!(written > MAX_PAYLOAD, "only {written} bytes were accepted");
    helper.assert_running();
    stop.store(true, Ordering::SeqCst);
    writer
        .join()
        .unwrap_or_else(|_| panic!("the feeding thread failed"));

    assert!(helper.wait(Duration::from_secs(5)).success());
}

/// A failure found by the input side while standard output is full and nobody holds it must not
/// strand the helper: its report never waits for room, and the caller's abort still ends it.
#[cfg(target_os = "linux")]
#[test]
fn a_failure_reported_into_a_full_output_still_obeys_the_abort() {
    use std::fs::File;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    let (listener, port) = listener();
    let (accepted, held) = mpsc::channel::<TcpStream>();
    let server = thread::spawn(move || {
        let (socket, _) = listener
            .accept()
            .unwrap_or_else(|error| panic!("accept: {error}"));
        socket
            .shutdown(Shutdown::Write)
            .unwrap_or_else(|error| panic!("half-close: {error}"));
        let _ = accepted.send(socket);
    });

    // Standard output is a pipe the test can also write into, so it can fill it completely.
    let mut ends = [0; 2];
    assert_eq!(
        unsafe { libc::pipe2(ends.as_mut_ptr(), libc::O_CLOEXEC) },
        0
    );
    let read_end = unsafe { OwnedFd::from_raw_fd(ends[0]) };
    let write_end = unsafe { OwnedFd::from_raw_fd(ends[1]) };
    let filler = write_end
        .try_clone()
        .unwrap_or_else(|error| panic!("duplicate the pipe: {error}"));
    let mut child = Command::new(SUPERVISOR)
        .args(["--connect", "127.0.0.1", &port.to_string()])
        .stdin(Stdio::piped())
        .stdout(Stdio::from(write_end))
        .stderr(Stdio::null())
        .spawn()
        .unwrap_or_else(|error| panic!("start the connect helper: {error}"));
    let input = child.stdin.take();
    let mut helper = Helper {
        child,
        input,
        output: ChildStdout::from(read_end),
    };

    // The remote end half-closes first, so the output side finishes and lets go of the output.
    helper.expect_ready();
    assert!(helper.receive_until_fin().is_empty());
    server
        .join()
        .unwrap_or_else(|_| panic!("the server failed"));
    let socket = held
        .recv_timeout(Duration::from_secs(5))
        .unwrap_or_else(|error| panic!("the server never accepted: {error}"));
    // Close with a reset, so the helper's next write fails on the input side.
    let linger = libc::linger {
        l_onoff: 1,
        l_linger: 0,
    };
    let set = unsafe {
        libc::setsockopt(
            socket.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_LINGER,
            (&raw const linger).cast(),
            std::mem::size_of::<libc::linger>() as libc::socklen_t,
        )
    };
    assert_eq!(set, 0, "SO_LINGER: {}", std::io::Error::last_os_error());
    drop(socket);
    thread::sleep(Duration::from_millis(100));

    let capacity = unsafe { libc::fcntl(filler.as_raw_fd(), libc::F_GETPIPE_SZ) };
    assert!(
        capacity > 0,
        "F_GETPIPE_SZ: {}",
        std::io::Error::last_os_error()
    );
    File::from(filler)
        .write_all(&vec![0_u8; capacity as usize])
        .unwrap_or_else(|error| panic!("fill the output: {error}"));

    helper.send(b'D', b"after the reset");
    thread::sleep(Duration::from_millis(200));
    helper.close_transport();

    let started = Instant::now();
    let status = helper.wait(Duration::from_secs(5));
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "the abort waited {:?} for the failure report",
        started.elapsed()
    );
    assert_eq!(status.code(), Some(1));
}

#[test]
fn a_refused_connection_is_reported_and_never_ready() {
    let (listener, port) = listener();
    drop(listener);

    let mut helper = Helper::connect("127.0.0.1", port);
    let (kind, payload) = helper.receive();
    let message = String::from_utf8_lossy(&payload).into_owned();

    assert_eq!(kind, b'X', "{message}");
    assert!(message.starts_with("ECONNREFUSED "), "{message}");
    assert_eq!(helper.wait(Duration::from_secs(5)).code(), Some(1));
}

#[test]
fn an_unknown_name_is_reported_as_not_found() {
    let mut helper = Helper::connect("happy-agent-connect-test.invalid", 80);
    let (kind, payload) = helper.receive();
    let message = String::from_utf8_lossy(&payload).into_owned();

    assert_eq!(kind, b'X', "{message}");
    assert!(message.starts_with("ENOTFOUND "), "{message}");
    assert_eq!(helper.wait(Duration::from_secs(30)).code(), Some(1));
}

#[test]
fn connect_mode_takes_no_policy_and_no_command() {
    for arguments in [
        vec!["--connect", "127.0.0.1"],
        vec!["--connect", "127.0.0.1", "80", "--", "/bin/true"],
        vec!["--connect", "127.0.0.1", "0"],
        vec!["--connect", "127.0.0.1", "080"],
        vec!["--connect", "", "80"],
        vec![
            "--policy",
            r#"{"mode":"full_access","network":{"egress":true,"localBinding":true}}"#,
            "--connect",
            "127.0.0.1",
            "80",
        ],
    ] {
        let mut helper = Helper::spawn(&arguments);
        let status = helper.wait(Duration::from_secs(5));
        let stderr = helper.stderr();
        assert_eq!(status.code(), Some(125), "{arguments:?}: {stderr}");
        assert!(stderr.starts_with("happy-agent-supervisor: "), "{stderr}");
    }
}

#[test]
fn malformed_frames_from_the_caller_end_the_connection() {
    let (listener, port) = listener();
    thread::spawn(move || {
        for socket in listener.incoming() {
            let Ok(mut socket) = socket else { continue };
            // Never half-close back, so a helper only exits here because of its caller.
            thread::spawn(move || {
                let received = read_to_end(&mut socket);
                thread::sleep(Duration::from_secs(30));
                received
            });
        }
    });

    let mut oversized = Helper::connect("127.0.0.1", port);
    oversized.expect_ready();
    let _ = oversized.try_send(b'D', &vec![0_u8; MAX_PAYLOAD + 1]);
    assert_eq!(oversized.wait(Duration::from_secs(5)).code(), Some(125));

    let mut after_fin = Helper::connect("127.0.0.1", port);
    after_fin.expect_ready();
    after_fin.send(b'F', &[]);
    let _ = after_fin.try_send(b'D', b"late");
    assert_eq!(after_fin.wait(Duration::from_secs(5)).code(), Some(125));

    let mut unknown = Helper::connect("127.0.0.1", port);
    unknown.expect_ready();
    unknown.send(b'Q', &[]);
    assert_eq!(unknown.wait(Duration::from_secs(5)).code(), Some(125));
}

/// A listener whose accept queue is already full, so a new connection waits in `connect`.
#[cfg(target_os = "linux")]
struct SaturatedListener {
    descriptor: std::os::fd::OwnedFd,
    _queued: Vec<TcpStream>,
    port: u16,
}

#[cfg(target_os = "linux")]
impl SaturatedListener {
    fn new() -> Self {
        use std::os::fd::{FromRawFd, OwnedFd};
        let raw = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
        assert!(raw >= 0, "socket: {}", std::io::Error::last_os_error());
        let descriptor = unsafe { OwnedFd::from_raw_fd(raw) };
        let mut address: libc::sockaddr_in = unsafe { std::mem::zeroed() };
        address.sin_family = libc::AF_INET as libc::sa_family_t;
        address.sin_addr.s_addr = u32::from_ne_bytes([127, 0, 0, 1]);
        let length = std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t;
        let bound =
            unsafe { libc::bind(raw, (&raw const address).cast::<libc::sockaddr>(), length) };
        assert_eq!(bound, 0, "bind: {}", std::io::Error::last_os_error());
        assert_eq!(unsafe { libc::listen(raw, 0) }, 0, "listen");
        let mut actual: libc::sockaddr_in = unsafe { std::mem::zeroed() };
        let mut actual_length = length;
        let named = unsafe {
            libc::getsockname(
                raw,
                (&raw mut actual).cast::<libc::sockaddr>(),
                &raw mut actual_length,
            )
        };
        assert_eq!(named, 0, "getsockname");
        let port = u16::from_be(actual.sin_port);
        // Linux queues one more connection than the backlog; fill it so the next SYN is dropped.
        let mut queued = Vec::new();
        for _ in 0..2 {
            if let Ok(socket) = TcpStream::connect_timeout(
                &([127, 0, 0, 1], port).into(),
                Duration::from_millis(200),
            ) {
                queued.push(socket);
            }
        }
        Self {
            descriptor,
            _queued: queued,
            port,
        }
    }
}

#[cfg(target_os = "linux")]
#[test]
fn ending_the_transport_aborts_a_connection_that_is_still_being_made() {
    let saturated = SaturatedListener::new();
    let mut helper = Helper::connect("127.0.0.1", saturated.port);
    thread::sleep(Duration::from_millis(300));
    helper.assert_running();
    helper.close_transport();

    assert!(helper.wait(Duration::from_secs(5)).success());
    drop(saturated.descriptor);
}

#[cfg(target_os = "linux")]
#[test]
fn a_frame_before_the_connection_is_ready_is_refused() {
    let saturated = SaturatedListener::new();
    let mut helper = Helper::connect("127.0.0.1", saturated.port);
    thread::sleep(Duration::from_millis(100));
    let _ = helper.try_send(b'D', b"early");

    assert_eq!(helper.wait(Duration::from_secs(5)).code(), Some(125));
}

/// The connect mode is not a way out of a sandbox: started by a restricted command, it has
/// exactly that command's network. Inside a sandbox without egress it cannot reach a listener
/// on the caller's loopback; given egress, the same invocation can.
#[test]
fn a_connection_started_inside_a_sandbox_keeps_that_sandbox() {
    let (listener, port) = listener();
    listener
        .set_nonblocking(true)
        .unwrap_or_else(|error| panic!("nonblocking listener: {error}"));
    let workspace = tempfile::tempdir().unwrap_or_else(|error| panic!("workspace: {error}"));

    let sandboxed = |egress: bool| {
        let policy = json!({
            "mode": "workspace_write",
            "network": { "egress": egress, "localBinding": false }
        })
        .to_string();
        let port = port.to_string();
        let mut child = Command::new(SUPERVISOR)
            .current_dir(workspace.path())
            .args([
                "--policy",
                &policy,
                "--",
                SUPERVISOR,
                "--connect",
                "127.0.0.1",
            ])
            .arg(&port)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap_or_else(|error| panic!("start the sandboxed helper: {error}"));
        let input = child.stdin.take();
        let output = child
            .stdout
            .take()
            .unwrap_or_else(|| panic!("the sandboxed helper has no standard output"));
        Helper {
            child,
            input,
            output,
        }
    };

    let mut isolated = sandboxed(false);
    let (kind, payload) = isolated.receive();
    let message = String::from_utf8_lossy(&payload).into_owned();
    assert_eq!(kind, b'X', "{message}");
    assert_eq!(isolated.wait(Duration::from_secs(10)).code(), Some(1));
    match listener.accept() {
        Err(error) if error.kind() == ErrorKind::WouldBlock => {}
        other => panic!("the isolated helper reached the caller's loopback: {other:?}"),
    }

    let mut connected = sandboxed(true);
    connected.expect_ready();
    connected.close_transport();
    assert!(connected.wait(Duration::from_secs(10)).success());
}
