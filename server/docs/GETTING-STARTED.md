# Getting started with Helmian Scribe

**You are three short steps from one memory that every AI you use can read —
including the conversations you have already had.**

The fastest path, with no account: open
[https://scribemem.helmian.cloud/try](https://scribemem.helmian.cloud/try)
and press **Create my memory**. Copy the one-line install, or paste the memory
address into Claude, ChatGPT or Cursor as a custom connector. Then skip to
Step 3 if you want to import old chats (import is part of the Personal plan).

Or, from a terminal:

```bash
curl -sS -X POST https://scribemem.helmian.cloud/try -H 'Accept: application/json'
```


Scribe is a memory vault for your AIs. Claude, ChatGPT, Grok, Gemini and your
coding tools all connect to the same address, so a chat you had with one of
them can be found by any of the others. Nothing here needs a terminal, a
command line, or any technical setup on your part — if you can copy a link
and click a button, you can do all of this.

Your dashboard also carries the short version of this guide at
**`/getting-started`**, with the upload button right there.

---

## Step 1 — Your database

Your memories live in a Postgres database. There are two ways to get one:

**Hosted Scribe (the normal way): it's already done.** Your account came with
its own private slice of a database, walled off from every other customer.
Skip to Step 2.

**Self-hosting (you run your own copy of Scribe):** you bring the database.

1. Go to [neon.com](https://neon.com) and create a free account.
2. Click **New Project**, give it a name (anything — "my-scribe" is fine),
   and click **Create project**. The free tier is plenty to start.
3. Neon shows you a **connection string** — a long address that starts with
   `postgresql://`. Copy it and keep it somewhere safe; it is the key to
   your database.
4. One one-time setup step remains: the provisioning runbook in
   [PROVISIONING.md](PROVISIONING.md) turns that empty database into a
   Scribe database and starts the server. That runbook is written for
   whoever runs your server — on the hosted product it is already done
   for you.

Either way: the database is *yours*. Scribe's walls (one account can never
read another account's memories) are enforced inside it, and you can export
or delete everything at any time from your dashboard.

## Step 2 — Connect your AI

1. Sign in and open your **dashboard**. The first card shows your **memory
   address** — a link that looks like
   `https://scribemem.helmian.cloud/t/your-name/mcp`.
2. In your AI app, add a **custom connector** and paste that address:
   - **Claude:** Settings → Connectors → *Add custom connector*
   - **ChatGPT:** Settings → Connectors → *Create*
   - **Grok / Gemini:** the same custom-connector idea in their settings
3. The AI app brings you back here to **approve** the connection. Read the
   card, press **Approve** — that approval is the entire setup.
4. Try it: ask your AI *"Search my memory for what I saved about…"* and
   watch it read the same memory every other connected AI sees.

Repeat for each AI you use. Each one gets its own approval, and you can
revoke any of them from the dashboard at any time.

## Step 3 — Bring your old conversations with you

Your AIs will happily export your whole history. You download one .zip file
per AI and upload it here — Scribe files every conversation into your vault,
titled and dated, searchable like anything else in your memory.

### Export from Claude

1. Open Claude and go to **Settings → Privacy**.
2. Under data exports, click **Export data**.
3. Claude **emails you** a download link (it can take a little while).
   Click it and save the .zip file. Don't open or unzip it.

### Export from ChatGPT

1. Open ChatGPT and go to **Settings → Data controls**.
2. Next to **Export data**, click **Export**, and confirm.
3. ChatGPT **emails you** a download link (large accounts can take up to a
   day). Click it and save the .zip file. Don't open or unzip it.

### Gemini — honest status

Google Takeout can export your Gemini activity, but Scribe **cannot import
it yet** — the format is an activity log, not conversations, and we would
rather tell you that plainly than guess at your history. Your Gemini chats
stay in Gemini for now; everything Gemini writes to Scribe from today on is
shared as usual. This section will be updated the day import lands.

### Upload

1. Open your **dashboard** and find the card **"Bring your old chats with
   you"**.
2. Pick the .zip you downloaded and press **Import history**.
3. Scribe tells you exactly what happened: how many conversations were
   imported, how many were already here, and — if any — which ones could
   not be imported and why.

Good to know:

- **Uploading the same file twice is safe.** Already-imported conversations
  are recognized and skipped, never duplicated — so after an upgrade you
  can upload the same export again and only the missing pieces are added.
- **Your secrets are scrubbed first.** Imports go through the same
  redaction as every other save: API keys, passwords and card numbers are
  removed before anything is stored, and anything caught is listed under
  Flags on your dashboard.
- **Plan:** importing ChatGPT and Claude history is part of the Personal
  plan. On Free the upload is refused with a note to upgrade.
- **Limits:** one file up to **50 MB** and **2,000 conversations** per
  import. If your plan's memory or storage limit is reached mid-import, the import stops
  safely with everything so far kept — upgrade, then upload the same file
  again to finish.
- **It's private.** An import lands in *your* vault only — the file itself
  can't name an account, and no other customer can search or read it.

## Step 4 — Check it worked

Ask any connected AI about something from an old chat:

> *"Search my memory for the conversation about [something you discussed
> months ago]. What did we decide?"*

If it answers from the imported conversation — title, dates and all — you
are done. That memory now belongs to every AI you connect, not just the
one you originally talked to.

---

*Running your own server? The operator documents are
[PROVISIONING.md](PROVISIONING.md) (fresh database → booted server) and
[SAAS.md](SAAS.md) (accounts, plans and billing). Something import-shaped
failed and the error wasn't clear? That's a bug — the importer is built to
fail loudly and say why, never to guess.*
