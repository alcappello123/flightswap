const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// ============================================
// DATABASE CONNECTION (PlanetScale)
// ============================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

// ============================================
// FIREBASE INITIALIZATION (OPTIONAL - für MVP)
// ============================================
let admin;
try {
  const firebase = require('firebase-admin');
  
  // Parse Firebase Service Account JSON
  let serviceAccount;
  
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      // Try to parse JSON string from environment variable
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (e) {
      console.warn('Could not parse FIREBASE_SERVICE_ACCOUNT_JSON:', e.message);
      serviceAccount = null;
    }
  }
  
  if (serviceAccount && serviceAccount.project_id) {
    firebase.initializeApp({
      credential: firebase.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id
    });
    admin = firebase;
    console.log('✅ Firebase initialized successfully');
  } else {
    console.warn('⚠️ Firebase Service Account not configured - Push notifications disabled');
    admin = null;
  }
} catch (err) {
  console.warn('Firebase initialization skipped:', err.message);
  admin = null;
}

// ============================================
// ROUTES
// ============================================

// Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    firebase: admin ? 'connected' : 'disabled',
    database: 'checking...'
  });
});

// Test Database Connection
app.get('/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      status: 'Database connected',
      timestamp: result.rows[0].now
    });
  } catch (err) {
    res.status(500).json({
      status: 'Database connection failed',
      error: err.message
    });
  }
});

// Get all bookings (test endpoint)
app.get('/bookings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bookings LIMIT 10');
    res.json({
      count: result.rows.length,
      bookings: result.rows
    });
  } catch (err) {
    res.status(500).json({
      error: 'Failed to fetch bookings',
      details: err.message
    });
  }
});

// Create a booking
app.post('/bookings', async (req, res) => {
  const { user_id, flight_id, seat_from, seat_to, status } = req.body;
  
  if (!user_id || !flight_id || !seat_from || !seat_to) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO bookings (user_id, flight_id, seat_from, seat_to, status, created_at) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *',
      [user_id, flight_id, seat_from, seat_to, status || 'pending']
    );
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({
      error: 'Failed to create booking',
      details: err.message
    });
  }
});

// Stripe Webhook (simplified)
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  
  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET || 'test_secret'
    );

    if (event.type === 'charge.succeeded') {
      console.log('✅ Payment successful:', event.data.object.id);
    }
    
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// Get user profile
app.get('/users/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, name, created_at FROM users WHERE id = $1',
      [req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ERROR HANDLING
// ============================================
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Unknown error'
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ============================================
// SERVER START
// ============================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 FlightSwap Backend running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🗄️  Database: ${process.env.DATABASE_URL ? 'configured' : 'NOT configured'}`);
  console.log(`💳 Stripe: ${process.env.STRIPE_SECRET_KEY ? 'configured' : 'NOT configured'}`);
  console.log(`🔥 Firebase: ${admin ? 'connected' : 'disabled (optional for MVP)'}`);
});

// Graceful Shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await pool.end();
  process.exit(0);
});
