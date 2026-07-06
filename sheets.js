const { google } = require('googleapis');

const SHEET_ID  = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = 'Customers';

// Column positions (0-based), matching the MOT reminder sheet
const COL = {
  FIRST_NAME:  0,
  LAST_NAME:   1,
  PHONE:       2,
  REGISTRATION: 3,
  MAKE:        4,
  MODEL:       5,
  MOT_EXPIRY:  6,
};

async function lookupCustomer(phone) {
  try {
    const auth   = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A2:G`,
    }, { timeout: 8_000 });

    const rows       = res.data.values || [];
    const normalised = normalisePhone(phone);
    const matches    = rows.filter(row => normalisePhone(String(row[COL.PHONE] || '')) === normalised);

    if (!matches.length) return null;

    const first    = matches[0];
    const vehicles = matches.map(row => ({
      registration: String(row[COL.REGISTRATION] || '').trim(),
      make:         String(row[COL.MAKE]         || '').trim(),
      model:        String(row[COL.MODEL]        || '').trim(),
      motExpiry:    String(row[COL.MOT_EXPIRY]   || '').trim() || null,
    }));

    return {
      firstName: String(first[COL.FIRST_NAME] || '').trim(),
      lastName:  String(first[COL.LAST_NAME]  || '').trim(),
      vehicles,
    };
  } catch (err) {
    console.error('Sheets lookup error:', err.message);
    return null;
  }
}

function normalisePhone(raw) {
  let phone = String(raw || '').trim().replace(/\s+/g, '');
  if (phone.startsWith('07')) phone = '+44' + phone.slice(1);
  return phone;
}

module.exports = { lookupCustomer };
