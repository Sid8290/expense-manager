# Expense Manager

A simple, browser-based expense manager built with plain HTML, CSS and JavaScript. It runs entirely in the browser and keeps all data in `localStorage`, so there is no backend, database or build step.

## Features

- **Transactions**: add income and expense transactions with description, type, category, account, amount, date and an optional note. View them in a table, delete them, and filter by search text, type, category and account. Amounts are validated and must be greater than zero.
- **Accounts**: add cash, bank and online accounts with an initial balance. Their balances update automatically with transactions. You can also track assets, money to receive and money to give, and see a financial position summary.
- **Categories**: add and delete income and expense categories. The transaction form uses the categories you have created. Categories and accounts that are used by transactions cannot be deleted.
- **Dashboard**: total income, total expense, total balance, an income vs expense bar chart for the last 6 months, the 5 most recent transactions, upcoming expenses and a to-do list.
- **Analytics**: this month vs last month, balance, expense and income statistics, category breakdown charts, category cards and top expenses / top income sources tables. Charts are drawn with HTML, CSS and JavaScript only.
- **Settings**: theme (light, dark, system), default currency, date format, default transaction type, notification preferences, name and email display, and a reset button that clears all stored data.
- **Notifications**: a bell menu that shows bill reminders and a monthly summary, plus a short message after adding or deleting a transaction. Each can be turned on or off in Settings.
- **Navigation search**: the search box in the header opens the Transactions page filtered by your search text.
- **Mobile**: the sidebar becomes a slide-in menu opened with a menu button.
- **Persistence**: everything is saved in `localStorage` and remains after a page refresh.

Changing the currency only changes the symbol and number format; amounts are not converted. The name, email and password fields in Settings are display only: there is no login or authentication.

## Technologies

- HTML5
- CSS3
- Vanilla JavaScript
- Browser `localStorage`
- Font Awesome (loaded from a CDN)

## Project Structure