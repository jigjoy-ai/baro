//! Headless stdin transport.
//!
//! A single reader owns stdin and routes correlated pre-run conversation
//! replies, mode confirmation, and run-local Dialogue commands to separate
//! lanes. Keeping the ownership here avoids competing `stdin().lock()` readers
//! starving each other for the lifetime of the process.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};

pub(crate) struct StdinHub {
    confirm_gate: StdMutex<Option<oneshot::Sender<Option<String>>>>,
    conversation_gate: StdMutex<Option<ConversationInputGate>>,
    conversation_backlog: StdMutex<VecDeque<HeadlessConversationInput>>,
    orch_tx: StdMutex<Option<mpsc::Sender<String>>>,
    reader_started: AtomicBool,
    reader_closed: AtomicBool,
}

struct ConversationInputGate {
    session_id: String,
    after_request_id: String,
    sender: oneshot::Sender<Option<String>>,
}

struct HeadlessConversationInput {
    session_id: String,
    after_request_id: String,
    text: String,
}

impl StdinHub {
    fn new() -> Self {
        Self {
            confirm_gate: StdMutex::new(None),
            conversation_gate: StdMutex::new(None),
            conversation_backlog: StdMutex::new(VecDeque::new()),
            orch_tx: StdMutex::new(None),
            reader_started: AtomicBool::new(false),
            reader_closed: AtomicBool::new(false),
        }
    }

    pub(crate) fn global() -> &'static StdinHub {
        static HUB: OnceLock<StdinHub> = OnceLock::new();
        HUB.get_or_init(StdinHub::new)
    }

    /// Spawn the single stdin reader thread (idempotent). A plain std thread —
    /// like the keyboard reader — so a forever-blocked read never stalls the
    /// runtime; each parsed line routes to whichever lane wants it.
    fn ensure_reader(&'static self) {
        if self.reader_closed.load(Ordering::SeqCst)
            || self.reader_started.swap(true, Ordering::SeqCst)
        {
            return;
        }
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                self.route_line(&line);
            }
            self.close_input();
        });
    }

    /// Route one complete stdin line. Pre-run clarification and run-local
    /// Dialogue deliberately use different command types so an early runtime
    /// message can never satisfy an intake gate.
    fn route_line(&self, line: &str) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return;
        }
        // confirm_mode lines resolve the intake gate; if no gate is open
        // (already confirmed / not waiting) they're dropped.
        if let Some(mode) = parse_confirm_mode(trimmed) {
            if let Some(tx) = self.confirm_gate.lock().unwrap().take() {
                let _ = tx.send(Some(mode));
            }
            return;
        }
        if let Some(input) = parse_headless_conversation_message(trimmed) {
            let mut gate = self.conversation_gate.lock().unwrap();
            let matches_gate = gate.as_ref().is_some_and(|pending| {
                input.session_id == pending.session_id
                    && input.after_request_id == pending.after_request_id
            });
            if matches_gate {
                if let Some(pending) = gate.take() {
                    let _ = pending.sender.send(Some(input.text));
                }
                return;
            }
            if gate.is_some() {
                // A stale request or another session must never resolve the
                // currently visible clarification.
                return;
            }
            drop(gate);
            let mut backlog = self.conversation_backlog.lock().unwrap();
            if backlog.len() == 8 {
                backlog.pop_front();
            }
            backlog.push_back(input);
            return;
        }
        if let Some(cmd) =
            parse_headless_dialogue_message(trimmed).or_else(|| stdin_command_line(trimmed))
        {
            // Runtime commands are never retained as clarification input. The
            // runner waits for the orchestrator lane before sending them.
            if let Some(tx) = self.orch_tx.lock().unwrap().clone() {
                let _ = tx.blocking_send(cmd);
            }
        }
    }

    /// Mark stdin permanently closed and wake every current/future waiter.
    fn close_input(&self) {
        self.reader_closed.store(true, Ordering::SeqCst);
        if let Some(gate) = self.confirm_gate.lock().unwrap().take() {
            let _ = gate.send(None);
        }
        if let Some(gate) = self.conversation_gate.lock().unwrap().take() {
            let _ = gate.sender.send(None);
        }
    }

    /// Register the execution-phase command sender and start the reader.
    pub(crate) fn set_orchestrator(&'static self, tx: mpsc::Sender<String>) {
        *self.orch_tx.lock().unwrap() = Some(tx);
        // Anything left here targeted a pre-run request that is no longer
        // active. It must not be reinterpreted as runtime Dialogue input.
        self.conversation_backlog.lock().unwrap().clear();
        self.ensure_reader();
    }

    /// Block for a `confirm_mode` line, up to `timeout`. `None` on timeout so
    /// the caller can auto-proceed — a run must never hang on confirmation.
    pub(crate) async fn await_confirm(&'static self, timeout: Duration) -> Option<String> {
        if self.reader_closed.load(Ordering::SeqCst) {
            return None;
        }
        let (tx, rx) = oneshot::channel();
        {
            let mut gate = self.confirm_gate.lock().unwrap();
            if self.reader_closed.load(Ordering::SeqCst) {
                return None;
            }
            *gate = Some(tx);
        }
        self.ensure_reader();
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Some(mode))) => Some(mode),
            // Timed out (or the sender was dropped): close the gate so a late
            // line is discarded rather than resolving a stale wait.
            _ => {
                *self.confirm_gate.lock().unwrap() = None;
                None
            }
        }
    }

    /// Wait for a correlated pre-run conversation message. Unlike the mode
    /// proposal this must never auto-accept an assumption: EOF closes the gate,
    /// otherwise the durable session remains alive until the user answers.
    pub(crate) async fn await_conversation_message(
        &'static self,
        session_id: &str,
        after_request_id: &str,
    ) -> Option<String> {
        let mut gate = self.conversation_gate.lock().unwrap();
        let mut backlog = self.conversation_backlog.lock().unwrap();
        if let Some(index) = backlog.iter().position(|input| {
            input.session_id == session_id && input.after_request_id == after_request_id
        }) {
            return backlog.remove(index).map(|input| input.text);
        }
        if self.reader_closed.load(Ordering::SeqCst) {
            return None;
        }
        let (tx, rx) = oneshot::channel();
        *gate = Some(ConversationInputGate {
            session_id: session_id.to_string(),
            after_request_id: after_request_id.to_string(),
            sender: tx,
        });
        drop(backlog);
        drop(gate);
        self.ensure_reader();
        match rx.await {
            Ok(Some(text)) if !text.trim().is_empty() => Some(text),
            _ => None,
        }
    }
}

/// Parse a `{"kind":"confirm_mode","mode":"…"}` command line into its mode
/// string. `None` for anything else (agent_message, non-JSON, missing fields).
fn parse_confirm_mode(line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("kind")?.as_str()? != "confirm_mode" {
        return None;
    }
    Some(value.get("mode")?.as_str()?.to_string())
}

/// Parse a pre-run clarification reply. Both correlation fields are required;
/// a run-local `dialogue_message` is a separate lane and never reaches here.
fn parse_headless_conversation_message(line: &str) -> Option<HeadlessConversationInput> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("type")?.as_str()? != "conversation_message" {
        return None;
    }
    let session_id = value.get("session_id")?.as_str()?.trim();
    let after_request_id = value.get("after_request_id")?.as_str()?.trim();
    if session_id.is_empty() || after_request_id.is_empty() {
        return None;
    }
    let text = value.get("text")?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    Some(HeadlessConversationInput {
        session_id: session_id.to_string(),
        after_request_id: after_request_id.to_string(),
        text: text.to_string(),
    })
}

/// Normalize a run-local Dialogue command for the orchestrator stdin lane.
fn parse_headless_dialogue_message(line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("type")?.as_str()? != "dialogue_message" {
        return None;
    }
    let text = value.get("text")?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    let message_id = value
        .get("message_id")
        .and_then(|candidate| candidate.as_str());
    Some(if let Some(message_id) = message_id {
        serde_json::json!({
            "type": "dialogue_message",
            "message_id": message_id,
            "text": text,
        })
        .to_string()
    } else {
        serde_json::json!({
            "type": "dialogue_message",
            "text": text,
        })
        .to_string()
    })
}

/// Keep a stdin line only if it's a JSON object with a `type` field. Reserved
/// conversation commands are handled by their dedicated lanes.
fn stdin_command_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    let command_type = value.get("type")?.as_str()?;
    if matches!(command_type, "conversation_message" | "dialogue_message") {
        return None;
    }
    Some(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        parse_confirm_mode, parse_headless_conversation_message, parse_headless_dialogue_message,
        stdin_command_line, ConversationInputGate, StdinHub,
    };

    #[test]
    fn stdin_command_line_cases() {
        let msg = r#"{"type":"agent_message","id":"S2","text":"hi"}"#;
        assert_eq!(stdin_command_line(msg).as_deref(), Some(msg));
        assert_eq!(
            stdin_command_line(&format!("  {msg}  ")).as_deref(),
            Some(msg)
        );
        assert_eq!(stdin_command_line(""), None);
        assert_eq!(stdin_command_line("   "), None);
        assert_eq!(stdin_command_line("not json"), None);
        assert_eq!(stdin_command_line(r#"{"id":"S2"}"#), None);
        assert_eq!(stdin_command_line(r#"["type"]"#), None);
        assert_eq!(
            stdin_command_line(r#"{"type":"conversation_message","text":"not runtime"}"#),
            None,
        );
        assert_eq!(
            stdin_command_line(r#"{"type":"dialogue_message","text":"normalized elsewhere"}"#),
            None,
        );
    }

    #[test]
    fn headless_conversation_and_dialogue_parsers_are_separate() {
        let parsed = parse_headless_conversation_message(
            r#"{"type":"conversation_message","session_id":"session-7","after_request_id":"request-3","message_id":"client-2","text":"  Keep Windows compatibility.  "}"#,
        )
        .unwrap();
        assert_eq!(parsed.session_id, "session-7");
        assert_eq!(parsed.after_request_id, "request-3");
        assert_eq!(parsed.text, "Keep Windows compatibility.");
        assert!(parse_headless_conversation_message(
            r#"{"type":"agent_message","id":"S1","text":"not intake"}"#
        )
        .is_none());
        assert!(parse_headless_conversation_message(
            r#"{"type":"conversation_message","session_id":"session-7","text":"missing request"}"#
        )
        .is_none());
        assert!(parse_headless_conversation_message(
            r#"{"type":"conversation_message","after_request_id":"request-3","text":"missing session"}"#
        )
        .is_none());
        assert!(
            parse_headless_conversation_message(r#"{"type":"dialogue_message","text":"   "}"#)
                .is_none()
        );
        assert_eq!(
            parse_headless_dialogue_message(
                r#"{"type":"dialogue_message","message_id":"client-2","text":"  Status?  "}"#,
            )
            .as_deref(),
            Some(r#"{"message_id":"client-2","text":"Status?","type":"dialogue_message"}"#),
        );
        assert!(parse_headless_dialogue_message(
            r#"{"type":"conversation_message","session_id":"session-7","after_request_id":"request-3","text":"not runtime"}"#,
        )
        .is_none());
    }

    #[test]
    fn stdin_hub_requires_exact_front_door_correlation_and_routes_dialogue_runtime_only() {
        let hub = StdinHub::new();
        let (reply_tx, mut reply_rx) = tokio::sync::oneshot::channel();
        *hub.conversation_gate.lock().unwrap() = Some(ConversationInputGate {
            session_id: "session-7".to_string(),
            after_request_id: "request-3".to_string(),
            sender: reply_tx,
        });
        let (orch_tx, mut orch_rx) = tokio::sync::mpsc::channel(4);
        *hub.orch_tx.lock().unwrap() = Some(orch_tx);

        hub.route_line(
            r#"{"type":"conversation_message","session_id":"other-session","after_request_id":"request-3","text":"wrong session"}"#,
        );
        assert!(reply_rx.try_recv().is_err());
        assert!(hub.conversation_gate.lock().unwrap().is_some());

        hub.route_line(
            r#"{"type":"conversation_message","session_id":"session-7","after_request_id":"old-request","text":"stale turn"}"#,
        );
        assert!(reply_rx.try_recv().is_err());
        assert!(hub.conversation_gate.lock().unwrap().is_some());

        hub.route_line(
            r#"{"type":"dialogue_message","message_id":"runtime-1","text":"runtime status"}"#,
        );
        assert!(reply_rx.try_recv().is_err());
        assert_eq!(
            orch_rx.blocking_recv().as_deref(),
            Some(r#"{"message_id":"runtime-1","text":"runtime status","type":"dialogue_message"}"#),
        );
        assert!(hub.conversation_gate.lock().unwrap().is_some());

        hub.route_line(
            r#"{"type":"conversation_message","session_id":"session-7","after_request_id":"request-3","text":"the exact reply"}"#,
        );
        assert_eq!(
            reply_rx.blocking_recv().unwrap().as_deref(),
            Some("the exact reply")
        );
        assert!(hub.conversation_gate.lock().unwrap().is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stdin_hub_eof_closes_current_and_future_gates() {
        let hub: &'static StdinHub = Box::leak(Box::new(StdinHub::new()));
        let (confirm_tx, confirm_rx) = tokio::sync::oneshot::channel();
        *hub.confirm_gate.lock().unwrap() = Some(confirm_tx);
        let (conversation_tx, conversation_rx) = tokio::sync::oneshot::channel();
        *hub.conversation_gate.lock().unwrap() = Some(ConversationInputGate {
            session_id: "session-7".to_string(),
            after_request_id: "request-3".to_string(),
            sender: conversation_tx,
        });

        hub.close_input();
        assert_eq!(confirm_rx.await.unwrap(), None);
        assert_eq!(conversation_rx.await.unwrap(), None);

        let confirm = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            hub.await_confirm(std::time::Duration::from_secs(60)),
        )
        .await
        .expect("closed confirm input must return immediately");
        assert_eq!(confirm, None);
        let conversation = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            hub.await_conversation_message("session-7", "request-4"),
        )
        .await
        .expect("closed conversation input must return immediately");
        assert_eq!(conversation, None);
    }

    #[test]
    fn parse_confirm_mode_cases() {
        assert_eq!(
            parse_confirm_mode(r#"{"kind":"confirm_mode","mode":"parallel"}"#).as_deref(),
            Some("parallel"),
        );
        assert_eq!(
            parse_confirm_mode(r#"  {"kind":"confirm_mode","mode":"accept"}  "#).as_deref(),
            Some("accept"),
        );
        assert_eq!(
            parse_confirm_mode(r#"{"type":"agent_message","id":"S2","text":"hi"}"#),
            None
        );
        assert_eq!(
            parse_confirm_mode(r#"{"kind":"other","mode":"parallel"}"#),
            None
        );
        assert_eq!(parse_confirm_mode(r#"{"kind":"confirm_mode"}"#), None);
        assert_eq!(parse_confirm_mode("not json"), None);
    }
}
