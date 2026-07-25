use std::io;
use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::ptr;

use tokio::process::{Child, Command};
use windows_sys::Win32::Foundation::{ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    OpenThread, ResumeThread, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
};

/// Add the creation flag that closes the spawn-to-assignment race. The child
/// cannot execute provider code until [`WindowsJob::attach_and_resume`] has
/// placed it in a kill-on-close Job Object.
pub(super) fn configure(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    command.as_std_mut().creation_flags(CREATE_SUSPENDED);
}

/// Owns the only user-mode handle to a kill-on-close Job Object.
///
/// Closing this handle kills every process still assigned to the Job, even if
/// the direct child has already exited and its PID has been reaped.
pub(super) struct WindowsJob {
    handle: OwnedHandle,
}

impl WindowsJob {
    pub(super) fn attach_and_resume(child: &mut Child) -> io::Result<Self> {
        let result = Self::attach_and_resume_inner(child);
        if result.is_err() {
            // Before assignment the Job cannot own the suspended root. Ensure
            // every failure path is fail-closed; kill_on_drop is a second line
            // of defence at all production call sites.
            let _ = child.start_kill();
        }
        result
    }

    fn attach_and_resume_inner(child: &Child) -> io::Result<Self> {
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("suspended child has no process id"))?;
        let process_handle = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("suspended child has no process handle"))?
            as HANDLE;

        let raw_job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if raw_job.is_null() {
            return Err(last_error("CreateJobObjectW"));
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(raw_job as RawHandle) };
        let job = Self { handle };

        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job.raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(last_error(
                "SetInformationJobObject(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)",
            ));
        }

        let assigned = unsafe { AssignProcessToJobObject(job.raw_handle(), process_handle) };
        if assigned == 0 {
            return Err(last_error("AssignProcessToJobObject"));
        }

        // CREATE_SUSPENDED guarantees that this is still the only thread and
        // that it has not had a chance to create an out-of-Job descendant.
        resume_primary_thread(pid)?;
        Ok(job)
    }

    /// Force the complete Job down. This remains authoritative after the root
    /// process exits because it addresses Job membership, not a parent PID.
    pub(super) fn terminate(self) {
        let _ = unsafe { TerminateJobObject(self.raw_handle(), 1) };
        // Drop closes the final Job handle. KILL_ON_JOB_CLOSE is the fallback
        // if explicit termination raced with normal process completion.
    }

    fn raw_handle(&self) -> HANDLE {
        self.handle.as_raw_handle() as HANDLE
    }
}

fn resume_primary_thread(pid: u32) -> io::Result<()> {
    let snapshot_raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot_raw == INVALID_HANDLE_VALUE {
        return Err(last_error("CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD)"));
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot_raw as RawHandle) };

    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..THREADENTRY32::default()
    };
    if unsafe { Thread32First(raw_handle(&snapshot), &mut entry) } == 0 {
        return Err(last_error("Thread32First"));
    }

    let mut thread_id = None;
    loop {
        if entry.th32OwnerProcessID == pid {
            if thread_id.replace(entry.th32ThreadID).is_some() {
                return Err(io::Error::other(format!(
                    "suspended child {pid} unexpectedly had multiple threads before Job assignment"
                )));
            }
        }

        if unsafe { Thread32Next(raw_handle(&snapshot), &mut entry) } == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                break;
            }
            return Err(with_context("Thread32Next", error));
        }
    }

    let thread_id = thread_id.ok_or_else(|| {
        io::Error::other(format!(
            "suspended child {pid} had no discoverable primary thread"
        ))
    })?;
    let thread_raw = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id) };
    if thread_raw.is_null() {
        return Err(last_error("OpenThread(THREAD_SUSPEND_RESUME)"));
    }
    let thread = unsafe { OwnedHandle::from_raw_handle(thread_raw as RawHandle) };
    let previous_suspend_count = unsafe { ResumeThread(raw_handle(&thread)) };
    if previous_suspend_count == u32::MAX {
        return Err(last_error("ResumeThread"));
    }
    if previous_suspend_count != 1 {
        return Err(io::Error::other(format!(
            "primary thread had unexpected suspend count {previous_suspend_count}"
        )));
    }
    Ok(())
}

fn raw_handle(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle() as HANDLE
}

fn last_error(operation: &str) -> io::Error {
    with_context(operation, io::Error::last_os_error())
}

fn with_context(operation: &str, source: io::Error) -> io::Error {
    io::Error::new(source.kind(), format!("{operation} failed: {source}"))
}
