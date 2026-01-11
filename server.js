require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic();

// OAuth 2.0 setup
const TOKEN_PATH = path.join(__dirname, 'tokens.json');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `http://localhost:${port}/auth/google/callback`
);

// Load saved tokens if they exist
function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      oauth2Client.setCredentials(tokens);
      return true;
    }
  } catch (err) {
    console.error('Error loading tokens:', err);
  }
  return false;
}

// Save tokens to file
function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
}

// Refresh tokens when they expire
oauth2Client.on('tokens', (tokens) => {
  if (tokens.refresh_token) {
    saveTokens(tokens);
  } else {
    const existingTokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    saveTokens({ ...existingTokens, ...tokens });
  }
});

loadTokens();

const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

// Check if user is authenticated with Google
app.get('/auth/status', (req, res) => {
  const isAuthenticated = oauth2Client.credentials && oauth2Client.credentials.access_token;
  res.json({ authenticated: !!isAuthenticated });
});

// Start OAuth flow
app.get('/auth/google', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/spreadsheets']
  });
  res.redirect(authUrl);
});

// OAuth callback
app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    saveTokens(tokens);
    res.redirect('/?authenticated=true');
  } catch (error) {
    console.error('Error getting tokens:', error);
    res.redirect('/?error=auth_failed');
  }
});

// Disconnect Google account
app.post('/auth/disconnect', (req, res) => {
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      fs.unlinkSync(TOKEN_PATH);
    }
    oauth2Client.setCredentials({});
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/analyze', async (req, res) => {
  try {
    const { food } = req.body;

    if (!food) {
      return res.status(400).json({ error: 'Food description is required' });
    }

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: `Analyze this food and estimate its nutritional content. Be concise and give your best estimate.

Food: ${food}

Respond in this exact JSON format only, no other text:
{"calories": <number>, "protein": <number in grams>, "carbs": <number in grams>, "fat": <number in grams>}`
        }
      ]
    });

    const responseText = message.content[0].text;
    const nutrition = JSON.parse(responseText);

    const now = new Date();
    const date = now.toLocaleDateString('en-US');
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    let logged = false;

    if (process.env.GOOGLE_SHEETS_ID && oauth2Client.credentials?.access_token) {
      try {
        await sheets.spreadsheets.values.append({
          spreadsheetId: process.env.GOOGLE_SHEETS_ID,
          range: 'Sheet1!A:G',
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [[date, time, food, nutrition.calories, nutrition.protein, nutrition.carbs, nutrition.fat]]
          }
        });
        logged = true;
      } catch (sheetError) {
        console.error('Error logging to sheets:', sheetError.message);
      }
    }

    res.json({
      food,
      ...nutrition,
      logged
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Calorie tracker running at http://localhost:${port}`);
});
