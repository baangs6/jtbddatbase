# Contact Review

A separate application for importing contact lists, confirming company matches, checking duplicates, and moving reviewed contacts into the existing newcrm-backend MongoDB schema. No files in that CRM repository are required or modified.

## Preview without databases

Install Node.js 20 or newer, then run:

```powershell
npm install
npm run demo
```

Open http://127.0.0.1:5100. The banner explicitly identifies the demo. All sample data, imports, and transfers in demo mode are in memory and disappear on restart. No external services are called. The included sample CSV uses fictitious contacts and reserved example domains.

## Configure your databases

Copy `.env.example` to `.env`. Keep this local file private. Set:

- `CONTACT_REVIEW_MONGO_URI`: your separate staging MongoDB database, including its database name.
- `REVIEW_ADMIN_EMAIL`: the app administrator email. For transfers, it must match an **active Admin** in the CRM's `users` collection.
- `REVIEW_ADMIN_PASSWORD`: a separate app password, at least 12 characters.
- `REVIEW_JWT_SECRET`: a random secret of at least 32 characters.
- `CRM_MONGO_URI`: optional initially; the running CRM MongoDB database, including its database name. Read access enables searches; write access and Atlas / a replica set are required for transfers.

Then run `npm start`. The staging database can be a standalone MongoDB server. Staging and CRM must be distinct databases; use separate credentials with appropriate database-scoped permissions. The default host is localhost. For deployment, use HTTPS behind a reverse proxy and set HOST=0.0.0.0 if needed. Serve the `public` directory on a second website/domain if desired, with same-origin `/api` requests proxied to this application's server; no changes to the existing CRM server are needed.

CRM credentials are never sent to the browser. Do not put production credentials in demo mode or commit `.env`. Startup does not send emails, run CRM schedulers, or transfer contacts.

## Workflow

1. Export the 8,000 contacts as CSV. Import up to 20 MB / 20,000 rows per file.
2. Map company name, contact name, email, phone, designation, and LinkedIn columns. Company and at least one contact identifier are required. Invalid rows are reported; exact reimports are skipped.
3. Select a company. Name similarity suggests candidates but never links automatically. Search alternate spellings if needed.
4. Choose an existing CRM company or verify a website and mark the company as new. “Find website” opens a web search; the operator must verify the website. The website is updated in CRM only when the explicit checkbox is selected and the decision is saved.
5. Review CRM and staging email/phone matches. Select contacts and confirm their transfer. Shared phone numbers require review; matching CRM contacts are blocked rather than silently overwritten.
6. Transferred records retain CRM company/contact IDs. Skipped contacts can be restored. Existing client sales stages are shown from CRM and preserved.

## Transfer guarantees and limits

Each contact transfer uses a CRM MongoDB transaction, a transactional lock shared by this application, and a deterministic contact ID. Double clicks and retries do not create another contact; if the staging status write fails after the CRM commit, a retry reconciles it. Company mappings are updated after creating a new lead, so subsequent contacts attach to that company. Duplicate checks run again at transfer time across all CRM companies.

The existing CRM does not enforce global unique contact email/phone keys. The review app serializes its own transfers, but a simultaneous write through another application can bypass that lock. It rechecks the data at transfer time; strict uniqueness across every writer would require changes to the existing CRM, which this project does not make.

Rows for the same person in the same company are consolidated when their identity matches: matching LinkedIn profiles, or matching names with the same email or designation and no conflicting profile/email. Their numbers appear as a primary phone, an alternative phone, and any further alternatives. Equivalent phone formatting is deduplicated. Conflicting identities stay separate. Original rows are archived in staging using `mergedInto`, so they remain recoverable and exact reimports do not recreate them. CRM records are unaffected by this consolidation.

Duplicate checks include every alternative phone. Other contacts with shared email/phone details show an import warning; transferring one makes the other a CRM duplicate. A name-only contact without corroborating email, role, or profile needs manual verification.

Name grouping keeps legal suffix variants separate to avoid accidentally combining different companies. Match scoring treats common legal suffixes as equivalent only for suggestions. Branches/subsidiaries with shared names require manual verification. Phone matching defaults to Indian country-code normalization while retaining other international country codes.

The first version uses one separate application administrator and loads CRM company/contact details for comparisons. It is intended for the discussed list size, not millions of records. Spreadsheet files must be exported to CSV. It does not automatically scrape or guess websites, merge conflicting contacts, or bypass your CRM approval state. Contacts added to incomplete leads remain pending approval.

## Checks

```powershell
npm test
```

Matching and CSV tests use no database. Integration tests start isolated temporary MongoDB instances and never use `.env` or production databases.

Per-contact destinations: expand Company & owner in a contact row, enter a new company name and verified website, choose an active CRM user, and save the contact destination before selecting Move. Blank company fields use the shared company decision. The selected owner is saved in assignedBy, which the CRM uses for displayed ownership and dashboards, and is included in assignedTo; existing assignedTo users are retained. The staging administrator remains the audit actor. Inactive owners block transfer. Custom destinations do not change the imported company grouping.

