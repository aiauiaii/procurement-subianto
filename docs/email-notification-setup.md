# Email Notification Setup

The app can send email notifications when these events happen:

- A requester submits a Level 1 for admin review.
- An admin rejects one or more Level 3 documents.
- An admin approves all required Level 3 documents in a Level 1.

If SMTP is not configured, notifications are written to:

```text
data/email-outbox.log
```

This lets you test the notification flow locally without sending real email.

## Gmail SMTP Setup

Gmail does not allow normal account passwords for SMTP in this kind of app. Use a Google App Password:

1. Turn on 2-Step Verification for the Gmail account.
2. Go to Google Account security settings.
3. Create an App Password for Mail.
4. Use that generated 16-character password as `SMTP_PASS`.

Create a local `.env` file in the project root:

```text
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=yourgmail@gmail.com
SMTP_PASS=your_google_app_password
SMTP_FROM=yourgmail@gmail.com
APP_URL=http://localhost:3000
```

Then restart the server:

```powershell
npm.cmd start
```

The `.env` file is ignored by git so the app password stays local.

## SMTP Environment Variables

Set these before starting the server:

```powershell
$env:SMTP_HOST="smtp.example.com"
$env:SMTP_PORT="587"
$env:SMTP_USER="your-smtp-user"
$env:SMTP_PASS="your-smtp-password"
$env:SMTP_FROM="procurement@example.com"
$env:APP_URL="https://your-ngrok-or-domain-url"
npm.cmd start
```

For SMTPS on port 465:

```powershell
$env:SMTP_SECURE="true"
$env:SMTP_PORT="465"
```

## Account Settings

Each account has:

- Account email, used for login.
- Notification email, used as the email recipient.
- Email notifications on/off.
- Last login timestamp for admin visibility.

Admins can edit these from the `Accounts` page.
