require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic();

// OAuth 2.0 setup
const TOKEN_PATH = path.join(__dirname, 'tokens.json');

// Dynamic callback URL for deployed environments
const getCallbackUrl = () => {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/auth/google/callback`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}/auth/google/callback`;
  }
  return `http://localhost:${port}/auth/google/callback`;
};

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  getCallbackUrl()
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
    const { food, date: selectedDate, image, timezone } = req.body;

    if (!food && !image) {
      return res.status(400).json({ error: 'Food description or image is required' });
    }

    // Use client timezone or fall back to UTC
    const tz = timezone || 'UTC';

    let messageContent;

    if (image) {
      // Image analysis with vision
      const imageData = image.replace(/^data:image\/\w+;base64,/, '');
      const mediaType = image.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';

      messageContent = [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: imageData
          }
        },
        {
          type: 'text',
          text: `Analyze this food image or nutrition label and estimate the nutritional content. If it's a nutrition label, extract the values. If it's food, estimate based on what you see.${food ? ` Additional context: ${food}` : ''}

Respond in this exact JSON format only, no other text:
{"food": "<brief description of the food>", "calories": <number>, "protein": <number in grams>, "carbs": <number in grams>, "fat": <number in grams>}`
        }
      ];
    } else {
      messageContent = `Analyze this food and estimate its nutritional content. Be concise and give your best estimate.

Food: ${food}

Respond in this exact JSON format only, no other text:
{"calories": <number>, "protein": <number in grams>, "carbs": <number in grams>, "fat": <number in grams>}`;
    }

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: messageContent
        }
      ]
    });

    const responseText = message.content[0].text;
    const nutrition = JSON.parse(responseText);

    const now = new Date();
    const date = selectedDate || now.toLocaleDateString('en-US', { timeZone: tz });
    const time = now.toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit' });

    // Use food name from image analysis or from request
    const foodName = nutrition.food || food;

    res.json({
      food: foodName,
      calories: nutrition.calories,
      protein: nutrition.protein,
      carbs: nutrition.carbs,
      fat: nutrition.fat,
      date,
      time,
      logged: false // Don't log until confirmed
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Confirm and save an entry to Google Sheets
app.post('/confirm', async (req, res) => {
  try {
    const { food, calories, protein, carbs, fat, date, time } = req.body;

    if (!food) {
      return res.status(400).json({ error: 'Food description is required' });
    }

    let logged = false;
    let rowIndex = null;

    if (process.env.GOOGLE_SHEETS_ID && oauth2Client.credentials?.access_token) {
      try {
        await sheets.spreadsheets.values.append({
          spreadsheetId: process.env.GOOGLE_SHEETS_ID,
          range: 'Sheet1!A:G',
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [[date, time, food, calories, protein, carbs, fat]]
          }
        });
        logged = true;

        // Get the row index of the newly added entry
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: process.env.GOOGLE_SHEETS_ID,
          range: 'Sheet1!A:A',
        });
        rowIndex = (response.data.values?.length || 1) - 2; // -1 for 0-based, -1 for header
      } catch (sheetError) {
        console.error('Error logging to sheets:', sheetError.message);
      }
    }

    res.json({
      food,
      calories,
      protein,
      carbs,
      fat,
      date,
      time,
      logged,
      rowIndex
    });

  } catch (error) {
    console.error('Error confirming entry:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get summary for a time period
app.get('/summary', async (req, res) => {
  try {
    const { period, timezone } = req.query; // daily, weekly, monthly
    const tz = timezone || 'UTC';

    if (!process.env.GOOGLE_SHEETS_ID || !oauth2Client.credentials?.access_token) {
      return res.json({ error: 'Not authenticated', authenticated: false });
    }

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Sheet1!A:G',
    });

    const rows = response.data.values || [];

    // Get current time in client's timezone
    const now = new Date();
    const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: tz }));

    // Calculate date range based on period (using client timezone)
    let startDate;
    if (period === 'daily') {
      startDate = new Date(nowInTz.getFullYear(), nowInTz.getMonth(), nowInTz.getDate());
    } else if (period === 'weekly') {
      startDate = new Date(nowInTz.getFullYear(), nowInTz.getMonth(), nowInTz.getDate() - 7);
    } else if (period === 'monthly') {
      startDate = new Date(nowInTz.getFullYear(), nowInTz.getMonth() - 1, nowInTz.getDate());
    } else {
      startDate = new Date(nowInTz.getFullYear(), nowInTz.getMonth(), nowInTz.getDate());
    }

    // Filter and sum entries
    let totalCalories = 0, totalProtein = 0, totalCarbs = 0, totalFat = 0;
    let entryCount = 0;
    const dailyTotals = {};

    rows.forEach((row, index) => {
      // Skip header row
      if (index === 0 && row[0]?.toLowerCase() === 'date') return;

      // Parse date from row (format: M/D/YYYY)
      const rowDate = new Date(row[0]);
      if (isNaN(rowDate.getTime())) return;

      if (rowDate >= startDate && rowDate <= nowInTz) {
        const calories = parseInt(row[3]) || 0;
        const protein = parseInt(row[4]) || 0;
        const carbs = parseInt(row[5]) || 0;
        const fat = parseInt(row[6]) || 0;

        totalCalories += calories;
        totalProtein += protein;
        totalCarbs += carbs;
        totalFat += fat;
        entryCount++;

        // Track daily totals for averages
        const dateKey = row[0];
        if (!dailyTotals[dateKey]) {
          dailyTotals[dateKey] = { calories: 0, protein: 0, carbs: 0, fat: 0 };
        }
        dailyTotals[dateKey].calories += calories;
        dailyTotals[dateKey].protein += protein;
        dailyTotals[dateKey].carbs += carbs;
        dailyTotals[dateKey].fat += fat;
      }
    });

    const daysCount = Object.keys(dailyTotals).length || 1;

    res.json({
      period,
      totalCalories,
      totalProtein,
      totalCarbs,
      totalFat,
      entryCount,
      daysCount,
      avgCalories: Math.round(totalCalories / daysCount),
      avgProtein: Math.round(totalProtein / daysCount),
      avgCarbs: Math.round(totalCarbs / daysCount),
      avgFat: Math.round(totalFat / daysCount),
      authenticated: true
    });

  } catch (error) {
    console.error('Error fetching summary:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get entries for a specific date
app.get('/entries', async (req, res) => {
  try {
    const { date } = req.query;

    if (!process.env.GOOGLE_SHEETS_ID || !oauth2Client.credentials?.access_token) {
      return res.json({ entries: [], authenticated: false });
    }

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Sheet1!A:G',
    });

    const rows = response.data.values || [];

    // Filter rows by date (skip header row if present)
    const hasHeader = rows[0]?.[0]?.toLowerCase() === 'date';
    const entries = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row, index }) => {
        // Skip header row
        if (index === 0 && hasHeader) return false;
        // Match date
        return row[0] === date;
      })
      .map(({ row, index }) => ({
        rowIndex: hasHeader ? index - 1 : index, // Adjust for header
        date: row[0],
        time: row[1],
        food: row[2],
        calories: parseInt(row[3]) || 0,
        protein: parseInt(row[4]) || 0,
        carbs: parseInt(row[5]) || 0,
        fat: parseInt(row[6]) || 0,
        logged: true
      }));

    res.json({ entries, authenticated: true });

  } catch (error) {
    console.error('Error fetching entries:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete an entry by row index
app.delete('/entries/:rowIndex', async (req, res) => {
  try {
    const { rowIndex } = req.params;

    if (!process.env.GOOGLE_SHEETS_ID || !oauth2Client.credentials?.access_token) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Delete the row (rowIndex is 0-based from data, add 1 for sheet, add 1 more if header exists)
    const sheetRowIndex = parseInt(rowIndex) + 2; // +1 for 1-based, +1 for header row

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: 0,
              dimension: 'ROWS',
              startIndex: sheetRowIndex - 1,
              endIndex: sheetRowIndex
            }
          }
        }]
      }
    });

    res.json({ success: true });

  } catch (error) {
    console.error('Error deleting entry:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update an entry
app.put('/entries/:rowIndex', async (req, res) => {
  try {
    const { rowIndex } = req.params;
    const { calories, protein, carbs, fat } = req.body;

    if (!process.env.GOOGLE_SHEETS_ID || !oauth2Client.credentials?.access_token) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const sheetRowIndex = parseInt(rowIndex) + 2; // +1 for 1-based, +1 for header row

    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `Sheet1!D${sheetRowIndex}:G${sheetRowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[calories, protein, carbs, fat]]
      }
    });

    res.json({ success: true });

  } catch (error) {
    console.error('Error updating entry:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get targets from Google Sheets
app.get('/settings/targets', async (req, res) => {
  try {
    if (!process.env.GOOGLE_SHEETS_ID || !oauth2Client.credentials?.access_token) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

    // Try to read from Settings sheet
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        range: 'Settings!A2:D2'
      });

      if (response.data.values && response.data.values[0]) {
        const [calories, protein, carbs, fat] = response.data.values[0];
        res.json({
          calories: parseInt(calories) || 1800,
          protein: parseInt(protein) || 180,
          carbs: parseInt(carbs) || 115,
          fat: parseInt(fat) || 65
        });
      } else {
        // Return defaults if no data
        res.json({ calories: 1800, protein: 180, carbs: 115, fat: 65 });
      }
    } catch (err) {
      // Settings sheet might not exist, return defaults
      res.json({ calories: 1800, protein: 180, carbs: 115, fat: 65 });
    }

  } catch (error) {
    console.error('Error getting targets:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save targets to Google Sheets
app.put('/settings/targets', async (req, res) => {
  try {
    const { calories, protein, carbs, fat } = req.body;

    if (!process.env.GOOGLE_SHEETS_ID || !oauth2Client.credentials?.access_token) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

    // Check if Settings sheet exists, create if not
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID
    });

    const settingsSheet = spreadsheet.data.sheets.find(
      sheet => sheet.properties.title === 'Settings'
    );

    if (!settingsSheet) {
      // Create Settings sheet
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        requestBody: {
          requests: [{
            addSheet: {
              properties: { title: 'Settings' }
            }
          }]
        }
      });

      // Add header row
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        range: 'Settings!A1:D1',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [['Calories', 'Protein', 'Carbs', 'Fat']]
        }
      });
    }

    // Save targets
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Settings!A2:D2',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[calories, protein, carbs, fat]]
      }
    });

    res.json({ success: true });

  } catch (error) {
    console.error('Error saving targets:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Calorie tracker running at http://localhost:${port}`);
});
