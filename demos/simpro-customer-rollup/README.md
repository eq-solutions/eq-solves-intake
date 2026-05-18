# SimPRO Customer Rollup

Takes three flat SimPRO exports and combines them into a single CSV with
one row per customer — sites and contacts concatenated into pipe-separated
cells. Designed to paste directly into a SharePoint list for a quoting
project.

No Microsoft Graph API. No SharePoint connection. No friction. Just run
the script, open the output, paste.

## What it solves

SimPRO doesn't export "everything about a customer" as one record. You get
three flat tables:

- `customer_export_*.csv` — one row per customer
- `customer_contacts_export_*.csv` — one row per contact (FK: simPRO Customer ID)
- `site_export_*.csv` — one row per site (FK: simPRO Customer ID)

For a SharePoint quoting project, you want **one row per customer** with
their sites and contacts visible. That's the shape this script produces.

## Usage

```bash
node rollup.mjs
```

By default the script auto-discovers SimPRO exports in
`C:\Projects\eq-intake\simpro\` (looking for `customer_export_*.csv`,
`customer_contacts_export_*.csv`, `site_export_*.csv`) and writes the
result to `customer-rollup.csv` beside this README.

To use other paths:

```bash
node rollup.mjs \
  --customers /path/to/customer_export.csv \
  --contacts  /path/to/customer_contacts_export.csv \
  --sites     /path/to/site_export.csv \
  --out       /path/to/customer-rollup.csv
```

## Output shape

One row per customer, with these columns:

| Column                | Meaning                                            |
|-----------------------|----------------------------------------------------|
| simPRO Customer ID    | Native SimPRO ID                                   |
| Company Name          | Trading name                                       |
| Customer Type         | Customer / Prospect / Lead                         |
| ABN                   | Australian Business Number                         |
| Street Address        | Customer-level address                             |
| Suburb / State / Postcode | Address components                             |
| Primary Phone / Mobile Phone / Email | Main contact details for the company    |
| Website / Customer Group / Account Manager | Categorisation               |
| Default Quote Method  | Print / Email / etc.                               |
| Notes                 | Free-text notes                                    |
| Create Date           | When the customer record was first added           |
| Site Count            | How many sites this customer has                   |
| Sites                 | Pipe-separated list of `Site Name — Address`       |
| Contact Count         | How many contacts this customer has                |
| Contacts              | Pipe-separated list of `Name (Position) · email · phone` |

Drop columns you don't want by editing `OUTPUT_COLUMNS` near the bottom of
`rollup.mjs`.

## Console output

The script reports:

- Counts loaded from each input file
- How many customers have at least one site / contact
- **Orphan warnings** — sites or contacts whose `simPRO Customer ID` doesn't
  match any customer in the customers export. Common cause: the customer
  export is filtered (e.g. active only) but the site export isn't, so some
  sites belong to inactive customers.

## Multi-customer sites

SimPRO models a site as belonging to one **or more** customers — the
`simPRO Customer ID` cell on a site row may contain a comma-separated list
like `"176, 31, 208"` (typical of data-centre tenants where multiple legal
entities co-own a site). The script handles this:

- In `customer-rollup.csv` (one row per customer): the same site appears
  under **every** co-owning customer's row, so each customer sees their
  full site list.
- In `eq-quotes-by-site.csv` (one row per site): the first listed ID is
  treated as the primary customer; the remaining IDs and their company
  names land in the `Linked Customer IDs` and `Linked Customer Names`
  columns.

## No silent drops

If a site references a customer ID that isn't in the customers export, it
isn't dropped:

- `customer-rollup.csv` appends a single synthetic `(orphan)` /
  `(Unassigned)` customer row at the end with every orphan site bundled
  into its `Sites` cell, each prefixed with the unresolvable ID.
- `eq-quotes-by-site.csv` emits each orphan as its own row with the
  Customer Name flagged `(orphan — references unknown customer ID …)` and
  the rest of the customer fields left blank.

Total site rows in == total site instances out (plus duplicates for
multi-customer sites). Every input row is visible somewhere.

## What's not built (and is fine for now)

- A column picker UI (for one-off exports, edit the CSV in Excel)
- Configurable separator (it's `|` — change `SEP` in the script)
- A SharePoint API connector (use the manual paste flow first; build the
  integration only when this becomes a weekly+ workflow)
- Per-row commit to anything durable — the script just writes a CSV

## Files

- `rollup.mjs` — the script
- `customer-rollup.csv` — output (gitignored if added later)
- `README.md` — this file
