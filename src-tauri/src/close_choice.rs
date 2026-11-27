//! Windows (W4): what the window's close (its X, Alt+F4) does.
//!
//! On the Mac the close hides the window and ⌘Q quits (hard rule 5); nothing
//! here changes that — [`close_decision`] says `Hide` on every platform but
//! Windows, and `lib.rs` only consults it under `cfg(windows)`.
//!
//! On Windows the setting `behavior.windowsCloseAction` picks: `tray` hides to
//! the notification area as before, `quit` takes the tray's "Quit Ply" exit
//! (`AppHandle::exit`, so `ExitRequested` kills every child — hard rule 4), and
//! `ask` (the default) prevents the close and asks the page to show Ply's
//! sheet. The page can fail to answer — not loaded yet, reloading, hung — so
//! the ask is a handshake ([`CloseAsk`]): the page says it listens, acks each
//! ask by its generation, and an ask nobody acked in time falls back to
//! today's hide. A second close while a sheet is up only brings the window
//! forward; it never stacks a second sheet.

use crate::settings::WindowsCloseAction;

/// What a close of the main window does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseDecision {
    /// Hide it (to the tray on Windows; minimized there without a tray).
    Hide,
    /// Ask the page to show the close sheet.
    AskFrontend,
    /// Quit Ply through `AppHandle::exit`.
    Quit,
}

/// The setting × the platform. Only Windows reads the setting; everywhere
/// else a close hides, as it always has.
pub fn close_decision(action: WindowsCloseAction, windows: bool) -> CloseDecision {
    if !windows {
        return CloseDecision::Hide;
    }
    match action {
        WindowsCloseAction::Ask => CloseDecision::AskFrontend,
        WindowsCloseAction::Tray => CloseDecision::Hide,
        WindowsCloseAction::Quit => CloseDecision::Quit,
    }
}

/// What starting an ask found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AskStart {
    /// Emit the ask with this generation and wait for its ack.
    Emit(u64),
    /// A sheet is already up (or its ask is in flight): bring the window
    /// forward, ask nothing new.
    AlreadyAsking,
    /// No page is listening: hide, as before the choice existed.
    NotListening,
}

/// How long an ask waits for the page's ack before the close falls back to
/// a hide.
pub const ACK_TIMEOUT_MS: u64 = 1500;

/// The ask handshake's state. Pure; `lib.rs` keeps one behind a mutex.
#[derive(Debug, Default)]
pub struct CloseAsk {
    listening: bool,
    asking: bool,
    acked: bool,
    generation: u64,
}

impl CloseAsk {
    pub const fn new() -> Self {
        Self {
            listening: false,
            asking: false,
            acked: false,
            generation: 0,
        }
    }

    /// The page listens for asks. Also called on every (re)load, so a sheet
    /// lost with an old page never blocks the next close.
    pub fn ready(&mut self) {
        self.listening = true;
        self.asking = false;
        self.acked = false;
    }

    pub fn begin(&mut self) -> AskStart {
        if !self.listening {
            return AskStart::NotListening;
        }
        if self.asking {
            return AskStart::AlreadyAsking;
        }
        self.generation += 1;
        self.asking = true;
        self.acked = false;
        AskStart::Emit(self.generation)
    }

    /// The page got ask `generation`. True: show the sheet. False: the ask
    /// already fell back (or was answered) — show nothing. A late ack of the
    /// latest ask still proves the page alive, so the next close asks again
    /// (the page says it listens only when it mounts).
    pub fn ack(&mut self, generation: u64) -> bool {
        if generation != self.generation {
            return false;
        }
        if self.asking && !self.acked {
            self.acked = true;
            return true;
        }
        if !self.asking {
            self.listening = true;
        }
        false
    }

    /// The page stopped listening (its sheet unmounted): until it says it
    /// listens again, a close hides at once instead of waiting for an ack.
    pub fn gone(&mut self) {
        self.listening = false;
        self.asking = false;
        self.acked = false;
    }

    /// The ack timeout for `generation` ran out. True: nobody acked, the
    /// ask is over and the close hides. The page is presumed gone until it
    /// says it listens again.
    pub fn timed_out(&mut self, generation: u64) -> bool {
        if self.asking && !self.acked && generation == self.generation {
            self.asking = false;
            self.listening = false;
            true
        } else {
            false
        }
    }

    /// The sheet was answered (either button, or dismissed).
    pub fn answered(&mut self) {
        self.asking = false;
        self.acked = false;
    }
}

/// What the sheet's answer asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAnswer {
    /// Keep running in the notification area: hide.
    Tray,
    /// Quit Ply.
    Quit,
    /// The sheet was dismissed: the window stays open.
    Stay,
}

impl CloseAnswer {
    pub fn parse(choice: &str) -> Self {
        match choice {
            "tray" => CloseAnswer::Tray,
            "quit" => CloseAnswer::Quit,
            _ => CloseAnswer::Stay,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mac_always_hides_whatever_the_setting() {
        for action in [WindowsCloseAction::Ask, WindowsCloseAction::Tray, WindowsCloseAction::Quit] {
            assert_eq!(close_decision(action, false), CloseDecision::Hide);
        }
    }

    #[test]
    fn windows_follows_the_setting() {
        assert_eq!(close_decision(WindowsCloseAction::Ask, true), CloseDecision::AskFrontend);
        assert_eq!(close_decision(WindowsCloseAction::Tray, true), CloseDecision::Hide);
        assert_eq!(close_decision(WindowsCloseAction::Quit, true), CloseDecision::Quit);
        assert_eq!(close_decision(WindowsCloseAction::default(), true), CloseDecision::AskFrontend);
    }

    #[test]
    fn no_listening_page_means_the_close_hides() {
        let mut ask = CloseAsk::new();
        assert_eq!(ask.begin(), AskStart::NotListening);
    }

    #[test]
    fn a_second_close_while_asking_stacks_nothing() {
        let mut ask = CloseAsk::new();
        ask.ready();
        assert_eq!(ask.begin(), AskStart::Emit(1));
        assert_eq!(ask.begin(), AskStart::AlreadyAsking, "before the ack");
        assert!(ask.ack(1));
        assert!(!ask.ack(1), "one ack per ask");
        assert_eq!(ask.begin(), AskStart::AlreadyAsking, "while the sheet is up");
        assert!(!ask.timed_out(1), "an acked ask never falls back");
        ask.answered();
        assert_eq!(ask.begin(), AskStart::Emit(2), "the next close asks again");
    }

    #[test]
    fn an_unacked_ask_falls_back_and_a_late_ack_shows_nothing() {
        let mut ask = CloseAsk::new();
        ask.ready();
        assert_eq!(ask.begin(), AskStart::Emit(1));
        assert!(ask.timed_out(1));
        assert!(!ask.ack(1), "too late: the window is already hidden");
        // The late ack proved the page alive: the next close asks again.
        assert_eq!(ask.begin(), AskStart::Emit(2));
        assert!(!ask.timed_out(1), "an old timer never ends a newer ask");
        assert!(!ask.ack(1), "nor does an old ack");
        assert!(ask.ack(2));
    }

    #[test]
    fn with_no_ack_at_all_the_page_is_presumed_gone() {
        let mut ask = CloseAsk::new();
        ask.ready();
        assert_eq!(ask.begin(), AskStart::Emit(1));
        assert!(ask.timed_out(1));
        assert_eq!(ask.begin(), AskStart::NotListening);
        ask.ready();
        assert_eq!(ask.begin(), AskStart::Emit(2));
    }

    #[test]
    fn a_page_that_stopped_listening_is_never_waited_for() {
        let mut ask = CloseAsk::new();
        ask.ready();
        ask.gone();
        assert_eq!(ask.begin(), AskStart::NotListening);
        ask.ready();
        assert_eq!(ask.begin(), AskStart::Emit(1));
        assert!(ask.ack(1));
        ask.gone();
        assert_eq!(ask.begin(), AskStart::NotListening, "an unmounted sheet leaves no ask behind");
    }

    #[test]
    fn a_reloaded_page_clears_a_lost_sheet() {
        let mut ask = CloseAsk::new();
        ask.ready();
        assert_eq!(ask.begin(), AskStart::Emit(1));
        assert!(ask.ack(1));
        ask.ready();
        assert_eq!(ask.begin(), AskStart::Emit(2));
    }

    #[test]
    fn answers_parse_and_anything_else_stays() {
        assert_eq!(CloseAnswer::parse("tray"), CloseAnswer::Tray);
        assert_eq!(CloseAnswer::parse("quit"), CloseAnswer::Quit);
        assert_eq!(CloseAnswer::parse("stay"), CloseAnswer::Stay);
        assert_eq!(CloseAnswer::parse("close"), CloseAnswer::Stay);
    }
}
