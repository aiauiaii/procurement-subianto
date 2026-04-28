# Procurement Workflow

A dependency-light procurement workflow website built with Node.js, SQLite, and plain HTML/CSS/JavaScript.

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
- Submitters can only submit a stage when every required document has a file, except accepted documents that were already approved.
- After a stage is submitted, the entry waits for admin approval.
- Admin approval is done per document with approve/reject decisions and reject notes.
- Approval of all required documents moves the entry to the next stage in order.
- Final approval marks the entry complete.
- Completed entries can be downloaded as a ZIP organized by stage, activity, and document.
- Admins can archive entries or permanently delete entries after typing `yes` in a confirmation modal.
- Uploaded files are stored under `data/documents/<stage>/<activity>/<document>/`.
- Workflow, entries, approval statuses, and document metadata are stored in `data/procurement.db`.

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
