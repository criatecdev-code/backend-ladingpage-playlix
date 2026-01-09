import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
// In Vercel, process.cwd() might not be what we expect for file writing,
// but we only write tokens in local dev mode.
const TOKEN_PATH = path.join(process.cwd(), 'tokens.json');

// Middleware
app.use(cors());
app.use(express.json());

// Google OAuth2 Client Configuration
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`
);

// Scopes for Calendar
const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

/**
 * Load tokens.
 * Priority:
 * 1. Environment Variable (GOOGLE_REFRESH_TOKEN) - For Vercel/Production
 * 2. Local File (tokens.json) - For Local Dev
 */
async function loadTokens() {
    // 1. Try Environment Variable (Best for Vercel)
    if (process.env.GOOGLE_REFRESH_TOKEN) {
        console.log("✅ Using GOOGLE_REFRESH_TOKEN from environment.");
        oauth2Client.setCredentials({
            refresh_token: process.env.GOOGLE_REFRESH_TOKEN
        });
        return true;
    }

    // 2. Try Local File
    try {
        const content = await fs.readFile(TOKEN_PATH);
        const tokens = JSON.parse(content);
        oauth2Client.setCredentials(tokens);
        console.log("✅ Loaded tokens from disk.");
        return true;
    } catch (err) {
        console.log("⚠️ No tokens found in partial check. Authentication might be needed.");
        return false;
    }
}

/**
 * Save tokens to disk (Local dev only).
 */
async function saveTokens(tokens) {
    try {
        await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens));
        console.log("✅ Tokens saved to disk.");
    } catch (error) {
        console.error("❌ Could not save tokens to disk (expected in Vercel/Read-only fs):", error.message);
    }
}

// Check tokens on startup
loadTokens();

// --- Routes ---

app.get('/', (req, res) => {
    res.send('Playlix Calendar API is running.');
});

// 1. Auth Endpoint - Start the login flow (Manual step for Admin)
app.get('/auth', (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline', // Crucial: Helper to get Refresh Token
        scope: SCOPES,
        prompt: 'consent' // Force consent to ensure refresh token is returned
    });
    res.redirect(authUrl);
});

// 2. Auth Callback - Exchange code for tokens
app.get('/auth/callback', async (req, res) => {
    const { code } = req.query;
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        // Save locally for dev
        await saveTokens(tokens);

        // If in production/Vercel, we can't easily save to disk.
        // We allow the user to see the Refresh Token so they can add it to Env Vars.
        const refreshTokenMsg = tokens.refresh_token
            ? `<p><strong>Refresh Token (Add to Vercel Env Vars):</strong><br><code>${tokens.refresh_token}</code></p>`
            : '<p>No refresh token returned. (Did you already authorize?)</p>';

        res.send(`
            <h1>Authentication successful!</h1>
            <p>You can close this window. Backend is ready to schedule events.</p>
            ${refreshTokenMsg}
        `);
    } catch (error) {
        console.error('Error getting tokens:', error);
        res.status(500).send(`
            <h1>Authentication failed</h1>
            <p>Error details:</p>
            <pre>${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}</pre>
        `);
    }
});

// 2.5 Availability Endpoint - List busy slots for a given day
app.get('/api/availability', async (req, res) => {
    const { date } = req.query; // '2025-12-25' or ISO string

    if (!date) {
        return res.status(400).json({ success: false, message: "Missing required query parameter: date" });
    }

    try {
        if (!oauth2Client.credentials) {
            // Try loading again just in case
            await loadTokens();
            if (!oauth2Client.credentials) {
                return res.status(401).json({ success: false, message: "Backend not authenticated. Please visit /auth" });
            }
        }

        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

        // Hardcoded timezone for reliability in this demo
        const TIMEZONE = 'America/Sao_Paulo';

        const dayStart = new Date(date);
        dayStart.setHours(0, 0, 0, 0);
        const timeMin = dayStart.toISOString();

        const dayEnd = new Date(date);
        dayEnd.setHours(23, 59, 59, 999);
        const timeMax = dayEnd.toISOString();

        console.log(`🔍 Checking availability for ${date} (${timeMin} - ${timeMax})`);

        const response = await calendar.events.list({
            calendarId: 'primary',
            timeMin: timeMin,
            timeMax: timeMax,
            timeZone: TIMEZONE, // Force response to be in this timezone
            singleEvents: true,
            orderBy: 'startTime',
        });

        const events = response.data.items || [];
        // console.log(`📅 Found ${events.length} busy events.`);

        const busySlots = events.map(event => {
            return {
                start: event.start.dateTime || event.start.date,
                end: event.end.dateTime || event.end.date,
                summary: "Ocupado"
            };
        });

        res.json({
            success: true,
            slots: busySlots
        });

    } catch (error) {
        console.error("Availability API Error:", error);
        res.status(500).json({ success: false, message: "Error checking availability: " + error.message });
    }
});

// 3. Schedule Endpoint - Used by Zek/Frontend
app.post('/api/schedule', async (req, res) => {
    let { name, email, date } = req.body; // ISO Date String

    if (!name || !email || !date) {
        return res.status(400).json({ success: false, message: "Missing required fields: name, email, date" });
    }

    // Fix: If date string is naive (e.g. "2026-01-10T14:00:00"), force Sao Paulo timezone (-03:00)
    // to prevent server from assuming UDP/Local(UTC) and shifting the time.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(date)) {
        console.log(`⚠️ Detected naive date string: ${date}. Forcing -03:00 (Sao Paulo).`);
        date += '-03:00';
    }

    try {
        if (!oauth2Client.credentials) {
            await loadTokens();
            if (!oauth2Client.credentials) {
                return res.status(401).json({ success: false, message: "Backend not authenticated. Please visit /auth" });
            }
        }

        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
        const startDateTime = new Date(date);
        const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000); // 1 hour

        // --- SAFETY CHECK: Prevent Double Booking ---
        const conflictCheck = await calendar.events.list({
            calendarId: 'primary',
            timeMin: startDateTime.toISOString(),
            timeMax: endDateTime.toISOString(),
            timeZone: 'America/Sao_Paulo',
            singleEvents: true
        });

        if (conflictCheck.data.items && conflictCheck.data.items.length > 0) {
            console.log("⚠️ Double booking prevented for:", startDateTime.toISOString());
            return res.status(409).json({ success: false, message: "Horário indisponível! Alguém acabou de agendar." });
        }
        // ---------------------------------------------

        const event = {
            summary: `🚀 Demo Playlix: ${name}`,
            description: `Interesse em demonstração da plataforma.\n\nCliente: ${name}\nEmail: ${email}\nAgendado via IA Zek.`,
            start: {
                dateTime: startDateTime.toISOString(),
                timeZone: 'America/Sao_Paulo', // Adjust as needed
            },
            end: {
                dateTime: endDateTime.toISOString(),
                timeZone: 'America/Sao_Paulo',
            },
            attendees: [
                { email: email },
            ],
            reminders: {
                useDefault: false,
                overrides: [
                    { method: 'email', minutes: 24 * 60 },
                    { method: 'popup', minutes: 10 },
                ],
            },
            conferenceData: {
                createRequest: {
                    requestId: `meet-${Date.now()}`,
                    conferenceSolutionKey: { type: 'hangoutsMeet' },
                },
            },
        };

        const response = await calendar.events.insert({
            calendarId: 'primary',
            resource: event,
            conferenceDataVersion: 1, // Required to generate the link
            sendUpdates: 'all',
        });

        res.json({
            success: true,
            message: "Evento agendado com sucesso!",
            link: response.data.htmlLink
        });

    } catch (error) {
        console.error("Calendar API Error:", error);
        if (error.code === 401 || error.message.includes('invalid_grant')) {
            res.status(401).json({ success: false, message: "Authentication expired. Admin needs to visit /auth again." });
        } else {
            res.status(500).json({ success: false, message: "Error contacting Google Calendar: " + error.message });
        }
    }
});

// Export app for Vercel
export default app;

// Start server locally (Vercel handles this automatically)
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`🚀 Backend server running on http://localhost:${PORT}`);
        console.log(`👉 To authenticate, visit: http://localhost:${PORT}/auth`);
    });
}
