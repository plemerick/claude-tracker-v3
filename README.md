# Calorie Tracker

A simple calorie tracking app that uses Claude AI to analyze food descriptions and logs nutritional data to Google Sheets.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Get Claude API Key

1. Go to https://console.anthropic.com/
2. Create an API key
3. Copy the key for your `.env` file

### 3. Set Up Google OAuth 2.0

#### Create OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Search for "Google Sheets API" and enable it
4. Go to **APIs & Services → OAuth consent screen**
   - Choose "External" user type
   - Fill in app name (e.g., "Calorie Tracker") and your email
   - Add your email as a test user
   - Save
5. Go to **APIs & Services → Credentials**
6. Click **Create Credentials → OAuth client ID**
7. Choose "Web application"
8. Add authorized redirect URI: `http://localhost:3000/auth/google/callback`
9. Click Create and copy the **Client ID** and **Client Secret**

#### Create Your Google Sheet

1. Go to [Google Sheets](https://sheets.google.com) and create a new spreadsheet
2. Add headers in the first row: `Date | Time | Food | Calories | Protein | Carbs | Fat`
3. Copy the spreadsheet ID from the URL:
   - URL looks like: `https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit`

### 4. Configure Environment

Copy the example env file:

```bash
cp .env.example .env
```

Edit `.env` with your values:

- `ANTHROPIC_API_KEY`: Your Claude API key
- `GOOGLE_CLIENT_ID`: OAuth client ID from step 3
- `GOOGLE_CLIENT_SECRET`: OAuth client secret from step 3
- `GOOGLE_SHEETS_ID`: Your spreadsheet ID from the URL

### 5. Run the App

```bash
npm start
```

Open http://localhost:3000 in your browser.

## Usage

1. Click "Connect Google Sheets" to authenticate with your Google account
2. Type a food description (e.g., "chicken breast 6oz" or "large pepperoni pizza slice")
3. Click Track or press Enter
4. View the nutritional breakdown
5. Data is automatically logged to your Google Sheet
