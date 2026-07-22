# Prolific Assist

A userscript that adds a panel to [Prolific](https://www.prolific.com/): it watches for new
studies, filters them by your rules (hourly rate, total pay, keywords, hardware requirements),
and alerts you when one matches. It also tracks earnings (today / week / month / tax-year totals,
£/hr for time actually worked, CSV export) and converts USD studies to GBP using HMRC, ECB, or
PayPal yearly rates.

It's read-only — it never reserves studies or acts on your account.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or another userscript manager).
2. [Install Prolific Assist](https://raw.githubusercontent.com/fraserreilly/prolific-assist/main/assist.user.js).

Open Prolific and the panel appears. All settings live in the panel and persist in your browser -
there's nothing to edit in code.

## Development

`npm test` runs the Node test suite covering the pure logic (filtering, normalisation, earnings
and currency math).

## License

GPL-3.0
