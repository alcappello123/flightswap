/**
 * FlightSwap Backend Server
 * Node.js + Express
 * Real-time Matching Engine, User Management, Payments, Push Notifications
 * 
 * Deploy to: Render.com (free tier)
 * Database: PlanetScale (free tier)
 */

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');
const { Pool } = require('pg');

dotenv.config();

// ============================================
// INITIALIZE
// ============================================

const app = express();
app.use(cors());
app.use(express.json());

// Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Firebase Admin Setup
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_CREDENTIALS || '{}')),
});

const db = admin.firestore();

// ============================================
// MIDDLEWARE
// ============================================

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ============================================
// API ENDPOINTS
// ============================================

// 1. HEALTH CHECK
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'production'
  });
});

// 2. USER REGISTRATION / LOGIN
app.post('/auth/register', async (req, res) => {
  try {
    const { email, name, device_token } = req.body;
    
    if (!email || !name) {
      return res.status(400).json({ error: 'Email and name required' });
    }

    const userId = 'user_' + Math.random().toString(36).substr(2, 9);
    
    const query = `
      INSERT INTO users (id, email, name, device_token, created_at)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING *
    `;
    
    const result = await pool.query(query, [userId, email, name, device_token]);
    
    res.json({
      success: true,
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// 3. CREATE BOOKING (Flight + Desired Seat)
app.post('/bookings/create', async (req, res) => {
  try {
    const { user_id, flight_number, desired_seat, seat_type } = req.body;
    
    if (!user_id || !flight_number || !desired_seat) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const bookingId = 'booking_' + Math.random().toString(36).substr(2, 9);
    
    const query = `
      INSERT INTO bookings (id, user_id, flight_number, desired_seat, seat_type, status, created_at)
      VALUES ($1, $2, $3, $4, $5, 'active', NOW())
      RETURNING *
    `;
    
    const result = await pool.query(query, [bookingId, user_id, flight_number, desired_seat, seat_type]);
    
    // Trigger matching
    await triggerMatching(flight_number);
    
    res.json({
      success: true,
      booking: result.rows[0]
    });
  } catch (error) {
    console.error('Booking error:', error);
    res.status(500).json({ error: 'Booking creation failed' });
  }
});

// 4. REAL-TIME MATCHING ENGINE
const triggerMatching = async (flight_number) => {
  try {
    // Get all active bookings for this flight
    const query = `
      SELECT 
        b1.id as booking_a_id,
        b1.user_id as user_a_id,
        b1.desired_seat as seat_a,
        b1.seat_type as seat_type_a,
        u1.device_token as device_token_a,
        u1.name as name_a,
        b2.id as booking_b_id,
        b2.user_id as user_b_id,
        b2.desired_seat as seat_b,
        b2.seat_type as seat_type_b,
        u2.device_token as device_token_b,
        u2.name as name_b
      FROM bookings b1
      JOIN users u1 ON b1.user_id = u1.id
      JOIN bookings b2 ON b1.flight_number = b2.flight_number
      JOIN users u2 ON b2.user_id = u2.id
      WHERE b1.flight_number = $1
        AND b1.status = 'active'
        AND b2.status = 'active'
        AND b1.user_id < b2.user_id
        AND b1.seat_type != b2.seat_type
      LIMIT 1
    `;
    
    const result = await pool.query(query, [flight_number]);
    
    if (result.rows.length > 0) {
      const match = result.rows[0];
      
      // Create match record
      const matchId = 'match_' + Math.random().toString(36).substr(2, 9);
      const matchQuery = `
        INSERT INTO matches (id, booking_a_id, booking_b_id, status, created_at)
        VALUES ($1, $2, $3, 'pending', NOW())
        RETURNING *
      `;
      await pool.query(matchQuery, [matchId, match.booking_a_id, match.booking_b_id]);
      
      // Send push notifications to both users
      await sendPushNotification(
        match.device_token_a,
        `Match Found! ${match.name_b} wants your seat!`,
        `They have ${match.seat_b} (${match.seat_type_b})`
      );
      
      await sendPushNotification(
        match.device_token_b,
        `Match Found! ${match.name_a} wants your seat!`,
        `They have ${match.seat_a} (${match.seat_type_a})`
      );
    }
  } catch (error) {
    console.error('Matching error:', error);
  }
};

// 5. PUSH NOTIFICATIONS
const sendPushNotification = async (device_token, title, body) => {
  try {
    if (!device_token) return;
    
    // Firebase Cloud Messaging
    await admin.messaging().send({
      token: device_token,
      notification: {
        title,
        body,
      },
      android: {
        priority: 'high',
      },
      apns: {
        headers: {
          'apns-priority': '10',
        },
      },
    });
    
    console.log('Push notification sent:', title);
  } catch (error) {
    console.error('Push notification error:', error);
  }
};

// 6. STRIPE PREMIUM SUBSCRIPTION
app.post('/stripe/checkout', async (req, res) => {
  try {
    const { user_id, email } = req.body;
    
    if (!user_id || !email) {
      return res.status(400).json({ error: 'User ID and email required' });
    }

    // Create or get Stripe customer
    const customers = await stripe.customers.list({ email, limit: 1 });
    let customerId;
    
    if (customers.data.length > 0) {
      customerId = customers.data[0].id;
    } else {
      const customer = await stripe.customers.create({
        email,
        metadata: { user_id }
      });
      customerId = customer.id;
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      line_items: [
        {
          price: process.env.STRIPE_PREMIUM_PRICE_ID,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${process.env.APP_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}/cancel`,
      billing_address_collection: 'auto',
    });

    res.json({
      sessionId: session.id,
      url: session.url
    });
  } catch (error) {
    console.error('Stripe checkout error:', error);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

// 7. STRIPE WEBHOOK
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  
  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      
      // Get customer
      const customer = await stripe.customers.retrieve(customerId);
      const userId = customer.metadata?.user_id;
      
      if (userId) {
        // Update user as premium
        const query = `UPDATE users SET is_premium = true, stripe_customer_id = $1 WHERE id = $2`;
        await pool.query(query, [customerId, userId]);
        console.log('User upgraded to premium:', userId);
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(400).send('Webhook error');
  }
});

// 8. GET USER PROFILE
app.get('/users/:user_id', async (req, res) => {
  try {
    const query = 'SELECT * FROM users WHERE id = $1';
    const result = await pool.query(query, [req.params.user_id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// 9. GET ACTIVE BOOKINGS
app.get('/bookings/:user_id', async (req, res) => {
  try {
    const query = `
      SELECT * FROM bookings 
      WHERE user_id = $1 
      ORDER BY created_at DESC 
      LIMIT 10
    `;
    const result = await pool.query(query, [req.params.user_id]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Get bookings error:', error);
    res.status(500).json({ error: 'Failed to get bookings' });
  }
});

// 10. ACCEPT MATCH
app.post('/matches/:match_id/accept', async (req, res) => {
  try {
    const matchId = req.params.match_id;
    
    const query = `UPDATE matches SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1 RETURNING *`;
    const result = await pool.query(query, [matchId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Match not found' });
    }
    
    res.json({
      success: true,
      match: result.rows[0]
    });
  } catch (error) {
    console.error('Accept match error:', error);
    res.status(500).json({ error: 'Failed to accept match' });
  }
});

// 11. ANALYTICS / STATS
app.get('/stats/daily', async (req, res) => {
  try {
    const query = `
      SELECT 
        COUNT(*) as total_matches,
        COUNT(CASE WHEN status = 'confirmed' THEN 1 END) as successful_swaps,
        COUNT(DISTINCT booking_a_id) as users_matched
      FROM matches 
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `;
    const result = await pool.query(query);
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// 12. ADMIN: GET ALL USERS (for testing)
app.get('/admin/users', async (req, res) => {
  try {
    const query = 'SELECT id, email, name, is_premium, created_at FROM users LIMIT 50';
    const result = await pool.query(query);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Admin users error:', error);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

// ============================================
// ERROR HANDLING
// ============================================

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 FlightSwap Backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
