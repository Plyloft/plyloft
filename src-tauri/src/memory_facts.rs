//! H1 (1.173.0): the system's memory at one moment, for the watchdog's lines
//! (`watchdog.rs`) — free/available memory, swap used, the compressor and
//! this process's own memory.
//!
//! Read cheaply and without spawning anything: on macOS `host_statistics64`
//! (`HOST_VM_INFO64`), `sysctlbyname("vm.swapusage" / "hw.memsize" /
//! "vm.pagesize")` and `proc_pid_rusage` (the phys footprint Activity
//! Monitor's Memory column shows); on Windows `GlobalMemoryStatusEx` and
//! `K32GetProcessMemoryInfo`. A few microseconds, no allocation beyond the
//! struct, so the watchdog can read them while the system is thrashing.
//!
//! The OS reads only gather raw numbers; [`from_mac`] and [`from_windows`]
//! turn them into [`MemoryFacts`] and are what the tests pin.

use serde::{Deserialize, Serialize};

/// What the log line and the Diagnostics row say about memory. Every field is
/// in bytes; `None` where the system has no such number (Windows has no
/// compressor figure here) or the read failed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFacts {
    #[serde(default)]
    pub total_bytes: u64,
    /// Memory the system could hand out now without paging: free, inactive
    /// and speculative pages on macOS; `ullAvailPhys` on Windows.
    #[serde(default)]
    pub available_bytes: u64,
    #[serde(default)]
    pub swap_used_bytes: u64,
    #[serde(default)]
    pub compressed_bytes: Option<u64>,
    /// Plyloft's app process only (macOS phys footprint, Windows working
    /// set) — not the WebKit or WebView2 processes that draw the window.
    #[serde(default)]
    pub process_bytes: Option<u64>,
    /// `swap_used_bytes` is Windows' page file in use, estimated from the
    /// commit charge rather than read.
    #[serde(default)]
    pub swap_estimated: bool,
    /// [`is_low`] at the moment they were read.
    #[serde(default)]
    pub low: bool,
}

/// The raw `vm_statistics64` counts the macOS figures come from (pages).
#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct MacVmCounts {
    pub page_size: u64,
    pub free: u64,
    pub inactive: u64,
    pub speculative: u64,
    pub compressor: u64,
}

/// The macOS numbers: `hw.memsize`, the VM page counts, `vm.swapusage`'s
/// `xsu_used` and the process's phys footprint.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn from_mac(total: u64, vm: MacVmCounts, swap_used: u64, footprint: Option<u64>) -> MemoryFacts {
    let page = vm.page_size;
    let mut facts = MemoryFacts {
        total_bytes: total,
        available_bytes: (vm.free + vm.inactive + vm.speculative).saturating_mul(page),
        swap_used_bytes: swap_used,
        compressed_bytes: Some(vm.compressor.saturating_mul(page)),
        process_bytes: footprint,
        swap_estimated: false,
        low: false,
    };
    facts.low = is_low(&facts);
    facts
}

/// The Windows numbers, from `MEMORYSTATUSEX` and the process's working set.
/// Windows reports a commit charge, not swap: the page file in use is the
/// commit beyond physical memory in use, never below zero.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn from_windows(
    total_phys: u64,
    avail_phys: u64,
    total_page_file: u64,
    avail_page_file: u64,
    working_set: Option<u64>,
) -> MemoryFacts {
    let committed = total_page_file.saturating_sub(avail_page_file);
    let phys_used = total_phys.saturating_sub(avail_phys);
    let mut facts = MemoryFacts {
        total_bytes: total_phys,
        available_bytes: avail_phys,
        swap_used_bytes: committed.saturating_sub(phys_used),
        compressed_bytes: None,
        process_bytes: working_set,
        swap_estimated: true,
        low: false,
    };
    facts.low = is_low(&facts);
    facts
}

/// "Memory was low": less than an eighth of memory available, or the
/// compressor holding more than a third of it. Swap alone isn't low memory:
/// a Mac keeps gigabytes of it after a busy day and runs fine.
pub fn is_low(facts: &MemoryFacts) -> bool {
    if facts.total_bytes == 0 {
        return false;
    }
    facts.available_bytes.saturating_mul(8) < facts.total_bytes
        || facts.compressed_bytes.is_some_and(|c| c.saturating_mul(3) > facts.total_bytes)
}

/// One gigabyte-ish figure for a log line: `1.1 GB`, `812 MB`.
pub fn size(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    const GB: f64 = MB * 1024.0;
    let b = bytes as f64;
    if b >= GB {
        format!("{:.1} GB", b / GB)
    } else {
        format!("{:.0} MB", b / MB)
    }
}

/// The facts as the watchdog's log lines carry them:
/// `memory: available 1.1 GB of 16.0 GB, swap used 1.9 GB, compressed 3.2 GB, Plyloft's app process 812 MB (low)`
/// on macOS; `…, page file 1.9 GB (estimated), …` on Windows.
pub fn log_text(facts: &MemoryFacts) -> String {
    let swap = if facts.swap_estimated {
        format!("page file {} (estimated)", size(facts.swap_used_bytes))
    } else {
        format!("swap used {}", size(facts.swap_used_bytes))
    };
    let mut out = format!(
        "memory: available {} of {}, {swap}",
        size(facts.available_bytes),
        size(facts.total_bytes),
    );
    if let Some(c) = facts.compressed_bytes {
        out.push_str(&format!(", compressed {}", size(c)));
    }
    if let Some(p) = facts.process_bytes {
        out.push_str(&format!(", Plyloft's app process {}", size(p)));
    }
    if facts.low {
        out.push_str(" (low)");
    }
    out
}

/// The system's memory now; `None` when the OS would not answer.
pub fn read() -> Option<MemoryFacts> {
    os::read()
}

#[cfg(target_os = "macos")]
mod os {
    use super::{from_mac, MacVmCounts, MemoryFacts};
    use std::ffi::CStr;
    use std::mem::{size_of, MaybeUninit};

    fn sysctl<T: Copy>(name: &CStr) -> Option<T> {
        let mut value = MaybeUninit::<T>::uninit();
        let mut len = size_of::<T>();
        // SAFETY: `value` has room for `len` bytes; sysctl writes at most that
        // and reports how much it wrote.
        let rc = unsafe {
            libc::sysctlbyname(name.as_ptr(), value.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0)
        };
        (rc == 0 && len == size_of::<T>()).then(|| unsafe { value.assume_init() })
    }

    pub fn read() -> Option<MemoryFacts> {
        let total: u64 = sysctl(c"hw.memsize")?;
        let page_size: u64 = sysctl::<u32>(c"vm.pagesize").map(u64::from)
            .or_else(|| sysctl::<u64>(c"vm.pagesize"))?;
        let swap: Option<libc::xsw_usage> = sysctl(c"vm.swapusage");
        let mut stats = MaybeUninit::<libc::vm_statistics64>::zeroed();
        let mut count = libc::HOST_VM_INFO64_COUNT;
        // SAFETY: `stats` is a vm_statistics64 and `count` its size in
        // integer_t, as HOST_VM_INFO64 expects. libc's mach bindings are
        // deprecated in favour of the mach2 crate, which isn't in the tree.
        #[allow(deprecated)]
        let rc = unsafe {
            libc::host_statistics64(
                libc::mach_host_self(),
                libc::HOST_VM_INFO64,
                stats.as_mut_ptr().cast(),
                &mut count,
            )
        };
        if rc != libc::KERN_SUCCESS {
            return None;
        }
        // SAFETY: the call succeeded and filled it.
        let stats = unsafe { stats.assume_init() };
        let mut usage = MaybeUninit::<libc::rusage_info_v2>::zeroed();
        // SAFETY: RUSAGE_INFO_V2 fills a rusage_info_v2.
        let footprint = unsafe {
            let rc = libc::proc_pid_rusage(
                libc::getpid(),
                libc::RUSAGE_INFO_V2,
                usage.as_mut_ptr().cast(),
            );
            (rc == 0).then(|| usage.assume_init().ri_phys_footprint)
        };
        Some(from_mac(
            total,
            MacVmCounts {
                page_size,
                free: u64::from(stats.free_count),
                inactive: u64::from(stats.inactive_count),
                speculative: u64::from(stats.speculative_count),
                compressor: u64::from(stats.compressor_page_count),
            },
            swap.map_or(0, |s| s.xsu_used),
            footprint,
        ))
    }
}

#[cfg(windows)]
mod os {
    use super::{from_windows, MemoryFacts};
    use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    pub fn read() -> Option<MemoryFacts> {
        // SAFETY: plain-data structs, sized as the calls require.
        unsafe {
            let mut status: MEMORYSTATUSEX = std::mem::zeroed();
            status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
            if GlobalMemoryStatusEx(&mut status) == 0 {
                return None;
            }
            let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
            counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            let working_set = (K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) != 0)
                .then_some(counters.WorkingSetSize as u64);
            Some(from_windows(
                status.ullTotalPhys,
                status.ullAvailPhys,
                status.ullTotalPageFile,
                status.ullAvailPageFile,
                working_set,
            ))
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod os {
    pub fn read() -> Option<super::MemoryFacts> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GB: u64 = 1024 * 1024 * 1024;
    const MB: u64 = 1024 * 1024;

    #[test]
    fn mac_counts_become_bytes_by_the_page_size() {
        // 16 GB Apple silicon, 16 KB pages: 40 000 free + 25 000 inactive +
        // 5 000 speculative pages ≈ 1.07 GB available; 200 000 pages in the
        // compressor ≈ 3.05 GB.
        let facts = from_mac(
            16 * GB,
            MacVmCounts { page_size: 16384, free: 40_000, inactive: 25_000, speculative: 5_000, compressor: 200_000 },
            1900 * MB,
            Some(812 * MB),
        );
        assert_eq!(facts.available_bytes, 70_000 * 16384);
        assert_eq!(facts.compressed_bytes, Some(200_000 * 16384));
        assert_eq!(facts.swap_used_bytes, 1900 * MB);
        assert_eq!(facts.process_bytes, Some(812 * MB));
        assert!(facts.low, "1.07 GB of 16 GB available is low");
        assert_eq!(
            log_text(&facts),
            "memory: available 1.1 GB of 16.0 GB, swap used 1.9 GB, compressed 3.1 GB, Plyloft's app process 812 MB (low)"
        );
    }

    #[test]
    fn a_roomy_mac_is_not_low_even_with_swap() {
        let facts = from_mac(
            16 * GB,
            MacVmCounts { page_size: 16384, free: 200_000, inactive: 150_000, speculative: 10_000, compressor: 20_000 },
            4 * GB,
            None,
        );
        assert!(!facts.low);
        assert!(!log_text(&facts).contains("Plyloft"), "no process figure, no words for it");
    }

    #[test]
    fn a_full_compressor_is_low() {
        let facts = MemoryFacts {
            total_bytes: 16 * GB,
            available_bytes: 4 * GB,
            compressed_bytes: Some(6 * GB),
            ..Default::default()
        };
        assert!(is_low(&facts));
    }

    #[test]
    fn windows_page_file_in_use_is_commit_beyond_physical_use() {
        // 16 GB physical, 1 GB available (15 used); commit limit 24 GB with
        // 7 GB left (17 committed): 2 GB is in the page file.
        let facts = from_windows(16 * GB, GB, 24 * GB, 7 * GB, Some(500 * MB));
        assert_eq!(facts.total_bytes, 16 * GB);
        assert_eq!(facts.available_bytes, GB);
        assert_eq!(facts.swap_used_bytes, 2 * GB);
        assert_eq!(facts.compressed_bytes, None);
        assert_eq!(facts.process_bytes, Some(500 * MB));
        assert!(facts.low, "1 GB of 16 GB available is low");
        assert!(!is_low(&from_windows(16 * GB, 2 * GB, 24 * GB, 8 * GB, None)), "an eighth is not below an eighth");
        assert!(!log_text(&facts).contains("compressed"));
        assert!(facts.swap_estimated);
        assert_eq!(
            log_text(&facts),
            "memory: available 1.0 GB of 16.0 GB, page file 2.0 GB (estimated), Plyloft's app process 500 MB (low)"
        );
    }

    #[test]
    fn windows_commit_below_physical_use_is_no_swap() {
        let facts = from_windows(16 * GB, 10 * GB, 24 * GB, 20 * GB, None);
        assert_eq!(facts.swap_used_bytes, 0);
        assert!(!facts.low);
    }

    #[test]
    fn no_total_is_never_low() {
        assert!(!is_low(&MemoryFacts::default()));
    }

    #[test]
    fn facts_from_an_older_marker_without_new_fields_load() {
        let facts: MemoryFacts = serde_json::from_str(r#"{"totalBytes": 17179869184}"#).unwrap();
        assert_eq!(facts.total_bytes, 16 * GB);
        assert_eq!(facts.compressed_bytes, None);
        assert!(!facts.low);
        assert!(!facts.swap_estimated, "a marker from before 1.173.0's round 1 says swap");
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn this_machine_answers() {
        let facts = read().expect("the OS answers");
        assert!(facts.total_bytes > 0);
        assert!(facts.available_bytes <= facts.total_bytes);
        assert!(facts.process_bytes.is_some_and(|p| p > 0));
    }
}
