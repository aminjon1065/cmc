# Documents, Tasks, and Communication Specification

## 1. Electronic Document Management System (EDMS / СЭД)

**Document Metadata (Card):**
- **Types:** Incoming, Outgoing, Internal.
- **Attributes:** Author, sender, recipient, date, subject, registration details, responsible department, and linked objects (incidents, cases).

**Lifecycle and Workflows:**
- **Base Workflow:** Draft → Registration/Routing → Approval → Approved → Execution → Archive.
- **Branches:** Return for revision, rejection, cancellation, re-approval, substitution, SLA breach/escalation.
- Approvals are tied to specific document versions. Modifying a document creates a new version that requires a new approval decision; old approvals do not blindly carry over to new content.
- **Electronic Signatures:** Internal application approval is distinct from legally binding cryptographic signatures. (Cryptographic signatures require a defined provider and certificate management process).

## 2. Files and Versioning
**File Manager:**
- Hierarchical folder tree with permission inheritance.
- List/detail views, upload, move, rename, version history, and restore capabilities.
- Mass operations with partial success reporting.
- Distinct upload states (pending, processing) vs. business states. Idempotent upload finalize.

**Concurrency & Integrity:**
- Prevent concurrent version conflicts via optimistic concurrency or explicit check-out/check-in (with owner/timeout/unlock rules).
- Upload keys must not allow overwriting an already published version.
- Resumable multipart uploads.
- File name, type, content, and size validation (quarantine of potentially dangerous files).

**Storage & Lifecycle:**
- Clear distinction between trash (soft delete), restoration, archive, retention, legal hold, and final physical destruction of all versions.
- Retention policies have explicit start triggers and inheritance.
- Legal hold requires specific permissions and audit tracking.
- Storage quotas and cleanup of orphaned/temporary exports without affecting approved versions.

## 3. Tasks and Assignments
**Task Management:**
- Kanban boards and list views.
- **Attributes:** Author, assignee, observers (if needed), priority, deadlines, and links (to documents/incidents/reports).
- **Lifecycle:** Assignment → Acceptance → Execution → Result Acceptance by author. Includes return for revision, cancellation, reopening, and state transition history.
- **Delegation:** Strictly checked against the organizational structure and access scope. Moving a card on a board triggers a server-side state transition with full validation.
- **Features:** Comments, attachments, reminders, overdue tracking. Substitutions (e.g., due to vacation/termination) must reassign ownership gracefully.

## 4. Chat, Realtime, and Notifications
**Chat (MVP):**
- 1:1 Direct Messages (DM) and Group Channels (open and closed).
- Differing rules for discovery, joining, and reading history based on channel type.
- Paginated history, unread counts, attachments, and object links.
- Idempotent message sending and graceful reconnect behavior.

**Realtime (WebSocket):**
- Subscriptions are strictly authorized on the server per resource. (Knowing a channel ID is not enough).
- Revoking access or removing a member immediately stops new events from being delivered.
- Accurate presence and typing indicators (secondary to core privacy and delivery).

**Notifications:**
- Cover assignments, approvals, state changes, import/report completions, and recording readiness.
- Track read/unread status, prevent duplication, and link to the relevant object.
- Notifications must not leak content if the underlying object's access is later revoked.

## 5. Audio/Video Calls and Conferences
**LiveKit Integration:**
- Support for 1:1 calls and group conferences (self-hosted).
- **1:1 States:** Invitation/calling, ringing, accepted, declined, missed, ended, error.
- **Conferences:** Organizer, participants, invitations, access control, opening/closing, moderation, and reconnection.
- Features: Screen sharing, device selection, mute controls.
- **Security:** Room entry requires explicit permission for that specific room. Tokens have strict TTLs and room-specific grants.

## 6. Recordings
**Recording Lifecycle:**
- **States:** `requested` → `starting` → `recording` → `stopping` → `processing` → `ready` → `failed`.
- Completion (`ready`) is confirmed via trusted provider webhooks/events and physical file verification, not just a UI click.
- Webhooks must handle authentication, duplicates, and out-of-order events safely.
- **Management:** Clear recording indicators, start/stop permissions, list/view/download access, retry/reconciliation after failures, retention policies, storage quotas, and full audit trails. Access to the recording is evaluated independently from access to the live room.
