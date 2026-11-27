//! Phase 3: bounded in-process queue for unattended writer intents.
//!
//! Queue entries are deliberately not persisted and are not SessionRecords.
//! A record starts only when the queued closure acquires coordination
//! admission and reaches the managed PTY boundary.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Listener, Manager};
use uuid::Uuid;

const WRITER_QUEUE_CAP: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriterAttempt {
    Started,
    Busy,
    Discarded,
    Failed(String),
}

type WriterJob = Arc<dyn Fn(&AppHandle) -> WriterAttempt + Send + Sync + 'static>;

#[derive(Clone)]
struct QueuedWriter {
    id: String,
    key: String,
    workspace_id: String,
    label: String,
    job: WriterJob,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriterQueueReceipt {
    pub id: String,
    pub position: usize,
    pub duplicate: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WriterQueueEvent {
    id: String,
    workspace_id: String,
    label: String,
    status: String,
    error: Option<String>,
}

struct WriterQueueInner {
    queue: Mutex<VecDeque<QueuedWriter>>,
    pumping: AtomicBool,
    wake_requested: AtomicBool,
}

#[derive(Clone)]
pub struct WriterQueue {
    inner: Arc<WriterQueueInner>,
}

impl Default for WriterQueue {
    fn default() -> Self {
        Self {
            inner: Arc::new(WriterQueueInner {
                queue: Mutex::new(VecDeque::new()),
                pumping: AtomicBool::new(false),
                wake_requested: AtomicBool::new(false),
            }),
        }
    }
}

impl WriterQueue {
    pub fn enqueue(
        &self,
        app: &AppHandle,
        key: String,
        workspace_id: String,
        label: String,
        job: impl Fn(&AppHandle) -> WriterAttempt + Send + Sync + 'static,
    ) -> Result<WriterQueueReceipt, String> {
        let receipt = self.push_item(key, workspace_id, label, Arc::new(job))?;
        self.request_pump(app.clone());
        Ok(receipt)
    }

    fn push_item(
        &self,
        key: String,
        workspace_id: String,
        label: String,
        job: WriterJob,
    ) -> Result<WriterQueueReceipt, String> {
        let receipt = {
            let mut queue = self.inner.queue.lock();
            if let Some((index, existing)) =
                queue.iter().enumerate().find(|(_, item)| item.key == key)
            {
                WriterQueueReceipt {
                    id: existing.id.clone(),
                    position: index + 1,
                    duplicate: true,
                }
            } else {
                if queue.len() >= WRITER_QUEUE_CAP {
                    return Err(format!(
                        "unattended writer queue is full ({WRITER_QUEUE_CAP} items)"
                    ));
                }
                let id = Uuid::new_v4().to_string();
                queue.push_back(QueuedWriter {
                    id: id.clone(),
                    key,
                    workspace_id,
                    label,
                    job,
                });
                WriterQueueReceipt {
                    id,
                    position: queue.len(),
                    duplicate: false,
                }
            }
        };
        Ok(receipt)
    }

    pub fn len(&self) -> usize {
        self.inner.queue.lock().len()
    }

    pub fn clear(&self) -> usize {
        let mut queue = self.inner.queue.lock();
        let count = queue.len();
        queue.clear();
        count
    }

    pub fn cancel_prefix(&self, prefix: &str) -> usize {
        let mut queue = self.inner.queue.lock();
        let before = queue.len();
        queue.retain(|item| !item.key.starts_with(prefix));
        before - queue.len()
    }

    pub fn request_pump(&self, app: AppHandle) {
        if self
            .inner
            .pumping
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            self.inner.wake_requested.store(true, Ordering::Release);
            return;
        }
        let queue = self.clone();
        std::thread::spawn(move || queue.pump(app));
    }

    fn pump(&self, app: AppHandle) {
        for (item, status, error) in self.run_pass_with(|item| (item.job)(&app)) {
            emit(&app, &item, status, error);
        }
        self.inner.pumping.store(false, Ordering::Release);
        // Close the enqueue/event-vs-pump-finish race. Busy-only queues wait
        // for the next coordination transition unless a wake arrived during
        // this pass.
        if self.inner.wake_requested.swap(false, Ordering::AcqRel) {
            self.request_pump(app);
        }
    }

    fn run_pass_with(
        &self,
        mut attempt: impl FnMut(&QueuedWriter) -> WriterAttempt,
    ) -> Vec<(QueuedWriter, &'static str, Option<String>)> {
        let pass_len = self.inner.queue.lock().len();
        let mut busy_keys = HashSet::new();
        let mut events = Vec::new();
        for _ in 0..pass_len {
            let Some(item) = self.inner.queue.lock().pop_front() else {
                break;
            };
            if busy_keys.contains(&item.key) {
                self.inner.queue.lock().push_back(item);
                continue;
            }
            match attempt(&item) {
                WriterAttempt::Started => {
                    events.push((item, "started", None));
                }
                WriterAttempt::Busy => {
                    busy_keys.insert(item.key.clone());
                    self.inner.queue.lock().push_back(item);
                }
                WriterAttempt::Discarded => {}
                WriterAttempt::Failed(error) => {
                    events.push((item, "failed", Some(error)));
                }
            }
        }
        events
    }
}

fn emit(app: &AppHandle, item: &QueuedWriter, status: &str, error: Option<String>) {
    let _ = app.emit(
        "writer-queue://changed",
        WriterQueueEvent {
            id: item.id.clone(),
            workspace_id: item.workspace_id.clone(),
            label: item.label.clone(),
            status: status.to_string(),
            error,
        },
    );
}

pub fn start_listener(app: AppHandle) {
    let pump_app = app.clone();
    app.listen("coordination://changed", move |_| {
        if let Some(queue) = pump_app.try_state::<WriterQueue>() {
            queue.request_pump(pump_app.clone());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_queue_is_empty_and_clear_is_bounded() {
        let queue = WriterQueue::default();
        assert_eq!(queue.len(), 0);
        assert_eq!(queue.clear(), 0);
    }

    #[test]
    fn attempt_result_preserves_failure_detail() {
        assert_eq!(
            WriterAttempt::Failed("missing agent".into()),
            WriterAttempt::Failed("missing agent".into())
        );
    }

    fn no_op_job() -> WriterJob {
        Arc::new(|_| WriterAttempt::Discarded)
    }

    #[test]
    fn duplicate_key_reuses_receipt_without_growing_queue() {
        let queue = WriterQueue::default();
        let first = queue
            .push_item("same".into(), "ws".into(), "one".into(), no_op_job())
            .unwrap();
        let duplicate = queue
            .push_item("same".into(), "ws".into(), "two".into(), no_op_job())
            .unwrap();

        assert!(!first.duplicate);
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.id, first.id);
        assert_eq!(duplicate.position, 1);
        assert_eq!(queue.len(), 1);
    }

    #[test]
    fn queue_is_bounded_and_clear_cancels_pending_intent() {
        let queue = WriterQueue::default();
        for index in 0..WRITER_QUEUE_CAP {
            queue
                .push_item(
                    format!("key-{index}"),
                    "ws".into(),
                    "job".into(),
                    no_op_job(),
                )
                .unwrap();
        }
        assert!(queue
            .push_item("overflow".into(), "ws".into(), "job".into(), no_op_job())
            .unwrap_err()
            .contains("queue is full"));
        assert_eq!(queue.clear(), WRITER_QUEUE_CAP);
        assert_eq!(queue.len(), 0);
    }

    #[test]
    fn cancellation_is_scoped_to_matching_keys() {
        let queue = WriterQueue::default();
        for key in ["swarm:a:one", "swarm:a:two", "swarm:b:one"] {
            queue
                .push_item(key.into(), "ws".into(), "job".into(), no_op_job())
                .unwrap();
        }
        assert_eq!(queue.cancel_prefix("swarm:a:"), 2);
        assert_eq!(queue.len(), 1);
    }

    #[test]
    fn busy_item_stays_queued_until_a_later_pass_starts_it() {
        let queue = WriterQueue::default();
        let attempts = std::sync::atomic::AtomicUsize::new(0);
        queue
            .push_item(
                "same-worktree".into(),
                "ws".into(),
                "queued writer".into(),
                no_op_job(),
            )
            .unwrap();

        assert!(queue
            .run_pass_with(|_| {
                if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    WriterAttempt::Busy
                } else {
                    WriterAttempt::Started
                }
            })
            .is_empty());
        assert_eq!(queue.len(), 1);

        let events = queue.run_pass_with(|_| {
            if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                WriterAttempt::Busy
            } else {
                WriterAttempt::Started
            }
        });
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].1, "started");
        assert_eq!(queue.len(), 0);
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn busy_key_does_not_block_an_independent_worktree() {
        let queue = WriterQueue::default();
        queue
            .push_item(
                "busy-worktree".into(),
                "ws".into(),
                "busy".into(),
                no_op_job(),
            )
            .unwrap();
        queue
            .push_item(
                "free-worktree".into(),
                "ws".into(),
                "free".into(),
                no_op_job(),
            )
            .unwrap();

        let events = queue.run_pass_with(|item| {
            if item.key == "busy-worktree" {
                WriterAttempt::Busy
            } else {
                WriterAttempt::Started
            }
        });
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0.key, "free-worktree");
        assert_eq!(events[0].1, "started");
        assert_eq!(queue.len(), 1);
        assert_eq!(queue.inner.queue.lock()[0].key, "busy-worktree");
    }

    #[test]
    fn failed_item_is_removed_and_reports_the_bounded_failure() {
        let queue = WriterQueue::default();
        queue
            .push_item(
                "invalid".into(),
                "ws".into(),
                "invalid writer".into(),
                no_op_job(),
            )
            .unwrap();

        let events =
            queue.run_pass_with(|_| WriterAttempt::Failed("agent disappeared".into()));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].1, "failed");
        assert_eq!(events[0].2.as_deref(), Some("agent disappeared"));
        assert_eq!(queue.len(), 0);
    }
}
