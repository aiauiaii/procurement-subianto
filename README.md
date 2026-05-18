# Procurement Workflow

A dependency-light procurement workflow website built with Node.js, SQLite, and plain HTML/CSS/JavaScript.

## System Overview

This application manages procurement submissions from requesters and document-level approvals by procurement admins.

Core concepts:

- **Stage**: major procurement phase, such as planning, tender execution, evaluation, approval, or contract management.
- **Activity**: work area inside a stage.
- **Document**: required upload slot inside an activity.
- **Entry**: one procurement submission from one requester/vendor.

The requester can save draft documents, submit a stage for approval, revise rejected documents, and download all final documents as a ZIP after completion. Procurement admins can review each uploaded document, approve or reject it with notes, manage requester/admin accounts, archive entries, permanently delete entries, and configure workflow stages/activities/documents.

## Architecture

- **Runtime**: Node.js HTTP server.
- **Frontend**: Plain HTML, CSS, and JavaScript served from `public/`.
- **Database**: SQLite database at `data/procurement.db`.
- **File storage**: Uploaded documents are stored on disk under `data/documents/`.
- **Email**: SMTP notification support, commonly configured with Gmail SMTP and a Google App Password.
- **Demo access**: Ngrok can expose the local server for temporary external demos.

This project is currently designed as a lightweight internal prototype or small-team workflow system. For production enterprise deployment, see the security and deployment notes below.

## Prerequisites

- Node.js `24` or newer.
- npm.
- A modern browser.
- Optional: ngrok for public demo links.
- Optional: Gmail account with Google App Password for real email notifications.

## Setup

Install dependencies if needed:

```powershell
npm install
```

Create a local environment file from the example:

```powershell
copy .env.example .env
```

The `.env` file is used for machine-specific and sensitive settings, such as SMTP credentials. Do not commit `.env` to GitHub. This repository includes `.env.example` so other developers know which variables are needed without exposing real passwords or tokens.

## Environment Variables

Example:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=yourgmail@gmail.com
SMTP_PASS=your_google_app_password
SMTP_FROM=yourgmail@gmail.com
APP_URL=http://localhost:3000
```

Variable notes:

- `SMTP_HOST`: SMTP server hostname. For Gmail, use `smtp.gmail.com`.
- `SMTP_PORT`: SMTP port. For Gmail STARTTLS, use `587`.
- `SMTP_SECURE`: Use `false` for Gmail port `587`.
- `SMTP_USER`: Gmail account used to send notification emails.
- `SMTP_PASS`: Google App Password for that Gmail account, not the normal Gmail password.
- `SMTP_FROM`: Sender email shown to users. Usually the same as `SMTP_USER`.
- `APP_URL`: Base URL included in email links. Use `http://localhost:3000` locally, or your public/ngrok URL for demos.

If SMTP is not configured, the app writes email messages to `data/email-outbox.log` instead of sending real emails.

## Gmail App Password

Gmail does not allow normal account passwords for SMTP in most cases. Use a Google App Password:

1. Open your Google Account.
2. Go to `Security`.
3. Enable `2-Step Verification` if it is not enabled yet.
4. Search for `App passwords` in the Google Account security page.
5. Create a new app password for this project, for example named `Procurement Workflow`.
6. Copy the generated 16-character password.
7. Paste it into `.env` as `SMTP_PASS`.

Example:

```env
SMTP_USER=yourgmail@gmail.com
SMTP_PASS=abcd efgh ijkl mnop
SMTP_FROM=yourgmail@gmail.com
```

Keep this password private. If it is leaked, delete it from your Google Account and create a new one.

## Run

```powershell
npm.cmd start
```

Then open:

```text
http://localhost:3000
```

## Deployment Notes

For a real server deployment, IT should plan these items:

- Run the Node.js server behind HTTPS, usually through a reverse proxy such as Nginx, IIS reverse proxy, or another approved gateway.
- Use a process manager or service wrapper so the app restarts automatically after reboot or crash.
- Store `.env` only on the server, never in GitHub.
- Back up both `data/procurement.db` and `data/documents/`.
- Set `APP_URL` to the real public URL so email links point to the correct website.
- Restrict network access if the system is only intended for internal users.

Ngrok is only recommended for temporary demos. It should not be treated as the production hosting server.

## Ngrok Demo Link

Ngrok is a public tunnel to your local app. It is not the app server itself, so the local Node server must stay running while ngrok is running.

Start the app from the project folder:

```powershell
cd C:\path\to\procurement
npm.cmd start
```

If you see an error like `Could not read package.json`, PowerShell is probably in the wrong folder. Make sure the prompt is inside the project folder that contains `package.json`.

In a second PowerShell window, start ngrok:

```powershell
ngrok http 3000
```

If `ngrok` is not recognized but you downloaded ngrok inside this project, run:

```powershell
.\ngrok\ngrok.exe http 3000
```

Copy the HTTPS `Forwarding` URL from ngrok, for example:

```text
https://example-name.ngrok-free.app
```

For demo email links, update `.env` so `APP_URL` uses that ngrok URL:

```env
APP_URL=https://example-name.ngrok-free.app
```

After changing `.env`, stop and restart the local server with `npm.cmd start`.

Ngrok notes:

- Free ngrok URLs usually change every time ngrok is restarted.
- Keep both terminals open: one for `npm.cmd start`, one for `ngrok http 3000`.
- If ngrok says the authtoken is invalid, add the real token from the ngrok dashboard:

```powershell
ngrok config add-authtoken YOUR_REAL_NGROK_TOKEN
```

- If Chrome shows a Fortinet certificate warning, the network or computer security proxy may be blocking the tunnel certificate. Ask IT to check the Fortinet certificate setup or try a different network.

## Demo Logins

Requester:

```text
requester@procurement.local
requester123
```

Procurement Admin:

```text
admin@procurement.local
admin123
```

## What It Does

- Starts at a login screen with requester and procurement admin roles.
- Admins can create, edit, delete, and reorder stages.
- Each stage can contain any number of activities.
- Each activity can contain any number of required documents.
- Requesters can save draft uploads even when the stage is not complete yet.
- A single required document can contain multiple uploaded files.
- Submitters can only submit a stage for approval when every required document slot has at least one active file, except accepted documents that were already approved.
- After a stage is submitted, the entry waits for admin approval.
- Admin approval is done per document with approve/reject decisions and reject notes.
- Approval of all required documents moves the entry to the next stage in order.
- If a previous stage document is rejected after the entry has already progressed, the entry returns to that stage for correction without deleting later-stage progress history.
- Final approval marks the entry complete.
- Completed entries can be downloaded as a ZIP organized by stage, activity, and document.
- Admins can archive entries or permanently delete entries after typing `yes` in a confirmation modal.
- Uploaded files are stored under `data/documents/<stage>/<activity>/<document>/`.
- Workflow, entries, approval statuses, and document metadata are stored in `data/procurement.db`.

## Data Model Overview

Important stored data:

- `users`: requester/admin accounts, notification email, active status, password hash, and role.
- `entries`: procurement submissions, requester, current stage, archive status, and overall status.
- `level1s`: stages.
- `level2s`: activities.
- `level3s`: required document definitions.
- `documents`: uploaded files, document slot references, review status, review notes, and file paths.
- `entry_level_statuses`: per-entry status for each stage.
- `notification_logs`: email notification attempts.
- `sessions`: login sessions.

## Data Location

The default data folder is:

```text
data/
```

For testing or separate environments, set:

```powershell
$env:PROCUREMENT_DATA_DIR = "C:\path\to\data"
npm.cmd start
```

## Backup And Restore

Back up the full `data/` folder:

```text
data/
  procurement.db
  documents/
  email-outbox.log
```

To restore, stop the server, replace the `data/` folder with the backup, then start the server again.

## Security Notes

- Passwords are stored as salted hashes, not plain text.
- SMTP passwords and app secrets belong in `.env`, not in GitHub.
- Uploaded files are stored locally and should be covered by server backup policy.
- This prototype does not include antivirus scanning for uploaded files.
- This prototype does not include SSO, Active Directory, LDAP, or fine-grained permission groups.
- Ngrok creates a public URL to the local app and should only be used intentionally for demos.
- For production, use HTTPS, server firewall rules, secret management, and regular backups.

## Troubleshooting

Wrong folder:

```text
Could not read package.json
```

Run from the project folder:

```powershell
cd C:\path\to\procurement
npm.cmd start
```

Port already used:

```text
Error: listen EADDRINUSE: address already in use :::3000
```

Another process is already using port `3000`. Stop the existing Node process or use a different port:

```powershell
$env:PORT = "3001"
npm.cmd start
```

Email not sent:

- Check `.env` exists.
- Check `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`.
- Make sure `SMTP_PASS` is a Google App Password, not the normal Gmail password.
- Check `data/email-outbox.log` and `notification_logs` if SMTP is not configured or fails.

Ngrok not recognized:

```powershell
.\ngrok\ngrok.exe http 3000
```

Ngrok URL changes:

- Free ngrok URLs usually change after restart.
- Update `APP_URL` in `.env` and restart the local server if email links should use the new ngrok URL.

## Known Limitations

- SQLite is simple and portable, but a larger production deployment may require PostgreSQL, SQL Server, or another managed database.
- Uploaded files are stored on local disk, so multi-server deployment needs shared storage or object storage.
- Email uses SMTP only.
- The current app is role-based with requester/admin roles, not granular department-level permissions.
- The workflow builder is powerful, but changes to workflow definitions should be managed carefully if many entries are already in progress.
