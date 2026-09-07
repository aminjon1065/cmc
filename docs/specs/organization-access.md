# Organization and Access Specification

## 1. Organizational Structure
The platform models a single organization (КЧС) with deep regional and departmental hierarchies.

**Entities:**
- **Account (User):** The authentication identity.
- **Employee (Profile):** Human details.
- **Department/Subdivision:** The organizational unit.
- **Position/Appointment:** The job title and structural placement.
- **Role:** The RBAC bundle of permissions.

**Features:**
- Strict hierarchy preventing circular reporting lines.
- Employee lifecycle: Creation, transfer, deactivation, task/document handover.
- **Substitution:** Temporary delegation of authority (e.g., during vacation) with strict time boundaries.
- System administrators do not automatically possess business-level approval authorities unless explicitly granted by a business rule.

## 2. Authentication (AuthN)
**Flows:**
- Complete web flow: Login, MFA challenge, refresh, logout.
- MFA: TOTP and single-use backup codes.
- Session Management: List active sessions, remote revocation.
- Password reset and MFA recovery procedures.

**Policies:**
- MFA can be strictly enforced for privileged roles. Modifying factors or sensitive settings requires re-authentication.
- Server-side validation of session revocation and user status changes. Client-side cookies alone do not prove current access rights.

## 3. Authorization (AuthZ)
**Unified Access Matrix:**
Access is evaluated as: **`Resource × Action × Role × Scope × Relation to Object`**.

**Coverage:**
- Documents/Versions/Folders
- Datasets/Rows/Reports
- GIS Layers/Features
- Tasks, Channels/Messages, AV Rooms/Recordings
- Audit logs and administrative operations.

**Actions:**
- Read, Create, Update, Delete/Restore, Export, Publish, Approve, Delegate, Manage Access, Administer.

**Enforcement:**
- Rules apply universally across API, BFF, FTS Search, Previews, WebSocket subscriptions, Background Workers, Scheduled Jobs, OGC Services (WMS/WFS), and Caches.
- Default to DENY for any unmapped permission combination.

**Resolution Rules:**
- Deny takes precedence over Allow.
- Folder permissions inherit downwards unless explicitly broken.
- Region Scope: Users act within their assigned region unless granted global (`region:all`) or specific cross-regional rights. Moving a document or deleting a folder must not silently expand access.
- **Revocation:** Revoking rights immediately invalidates related caches and WebSocket subscriptions. Signed URLs have strict TTLs, and immediate revocation requires gateway-level validation.
